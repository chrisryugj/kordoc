/** 디렉토리 감시 모드 — 새 문서 자동 변환 + Webhook 알림 */

import { watch, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, realpathSync } from "fs"
import { lookup } from "dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { basename, dirname, resolve, extname, sep } from "path"
import { parse, detectFormat } from "./index.js"
import { toArrayBuffer } from "./utils.js"
import { assertNetworkAllowed } from "./shared/offline.js"
import type { WatchOptions, ParseOptions } from "./types.js"

export const SUPPORTED_EXTENSIONS = new Set([".hwp", ".hwpx", ".hml", ".pdf", ".xls", ".xlsx", ".docx", ".pptx"])
const DEBOUNCE_MS = 1000
/** 파일 쓰기 완료 판정: 연속 2회 동일 크기 확인 간격 */
const STABLE_CHECK_MS = 300
const MAX_FILE_SIZE = 500 * 1024 * 1024

/**
 * Linux fs.watch recursive는 Node 19.1+ 전용 — 미지원 조합이면 크립틱
 * ERR_FEATURE_UNAVAILABLE 대신 명확한 안내로 즉시 실패시킨다.
 */
export function assertRecursiveWatchSupport(
  platform: NodeJS.Platform = process.platform,
  nodeVersion: string = process.versions.node,
): void {
  if (platform !== "linux") return
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number)
  if (major >= 20 || (major === 19 && minor >= 1)) return
  throw new Error(
    `Linux에서 디렉토리 감시(fs.watch recursive)는 Node 19.1 이상이 필요합니다 (현재 ${nodeVersion}) — Node 20+ 업그레이드를 권장합니다`,
  )
}

/**
 * 동시 처리 상한 게이트 — 상한 초과분은 버리지 않고 대기 큐에 넣어 처리 완료 시
 * 순서대로 drain (기존: 상한 초과 return으로 새 파일이 무음 유실되던 것 방지).
 * 처리 중인 키가 다시 들어오면 겹쳐 돌리지 않고, 끝난 뒤 대기 큐 맨 뒤에서 한 번만 다시 처리한다.
 */
export function createTaskQueue(maxConcurrent: number, run: (key: string) => Promise<void>): (key: string) => void {
  let active = 0
  const inProgress = new Set<string>()
  const waiting: string[] = []
  const rerun = new Set<string>()
  const enqueue = (key: string): void => {
    if (inProgress.has(key)) {
      rerun.add(key) // 동일 파일 동시 처리 방지 — 변경은 기억했다가 완료 후 반영
      return
    }
    if (active >= maxConcurrent) {
      if (!waiting.includes(key)) waiting.push(key)
      return
    }
    inProgress.add(key)
    active++
    void run(key).finally(() => {
      inProgress.delete(key)
      active--
      if (rerun.delete(key)) waiting.push(key)
      const next = waiting.shift()
      if (next) enqueue(next)
    })
  }
  return enqueue
}

/**
 * 디렉토리를 감시하여 새 문서 파일을 자동 변환.
 *
 * @example
 * ```bash
 * kordoc watch ./incoming -d ./output --webhook https://api.example.com/docs
 * ```
 */
export async function watchDirectory(options: WatchOptions): Promise<void> {
  const { dir, outDir, webhook, format = "markdown", pages, silent } = options

  if (!existsSync(dir)) throw new Error(`디렉토리를 찾을 수 없습니다: ${dir}`)
  if (webhook) validateWebhookUrl(webhook)
  if (outDir) mkdirSync(outDir, { recursive: true })

  const log = silent ? () => {} : (msg: string) => process.stderr.write(msg + "\n")
  log(`[kordoc watch] 감시 시작: ${resolve(dir)}`)
  if (outDir) log(`[kordoc watch] 출력: ${resolve(outDir)}`)
  if (webhook) log(`[kordoc watch] 웹훅: ${webhook}`)

  // 설정 로그 뒤·감시 시작 전에 검사 — 무엇을 하려다 막혔는지 보이고,
  // 옵션 파싱 계약 테스트(plugin-5)도 Linux+Node<19.1 에서 로그를 관측할 수 있다
  assertRecursiveWatchSupport()

  // 디바운스 맵
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  // 동시 처리 제한 — 메모리 폭주 방지 (초과분은 대기 큐로, createTaskQueue)
  const MAX_CONCURRENT = 3

  /** 파일 크기가 안정화될 때까지 대기 (쓰기 완료 감지) */
  const waitForStableSize = async (absPath: string): Promise<number> => {
    let prevSize = statSync(absPath).size
    await new Promise(r => setTimeout(r, STABLE_CHECK_MS))
    if (!existsSync(absPath)) return 0
    const currSize = statSync(absPath).size
    if (currSize !== prevSize) {
      // 크기가 변했으면 한 번 더 대기
      await new Promise(r => setTimeout(r, STABLE_CHECK_MS))
      if (!existsSync(absPath)) return 0
      return statSync(absPath).size
    }
    return currSize
  }

  const processFile = async (filePath: string) => {
    const ext = extname(filePath).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) return

    const fileName = basename(filePath)
    try {
      const rawPath = resolve(dir, filePath)
      if (!existsSync(rawPath)) return
      // 심볼릭 링크 해석 후 감시 디렉토리 외부 파일 차단
      let absPath: string
      try { absPath = realpathSync(rawPath) } catch { return }
      const realDir = realpathSync(resolve(dir))
      if (!absPath.startsWith(realDir + sep) && absPath !== realDir) return

      const fileSize = await waitForStableSize(absPath)
      if (fileSize > MAX_FILE_SIZE || fileSize === 0) return

      log(`[kordoc watch] 변환 중: ${fileName}`)

      const buffer = readFileSync(absPath)
      const arrayBuffer = toArrayBuffer(buffer)
      // filePath 전달 — 배포용 HWP의 COM fallback에 필요 (CLI와 동일)
      const parseOptions: ParseOptions = { filePath: absPath }
      if (pages) parseOptions.pages = pages
      const result = await parse(arrayBuffer, parseOptions)

      if (!result.success) {
        log(`[kordoc watch] 실패: ${fileName} — ${result.error}`)
        await sendWebhook(webhook, { file: fileName, format: detectFormat(arrayBuffer), success: false, error: result.error })
        return
      }

      // 그림 바이트는 base64 로 (CLI --format json 과 같은 직렬화) — 그대로 두면 Uint8Array 가 {"0":137,…} 색인 객체가 된다
      const output = format === "json"
        ? JSON.stringify(result, (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value, 2)
        : result.markdown

      if (outDir) {
        const outExt = format === "json" ? ".json" : ".md"
        const outPath = resolve(outDir, dirname(filePath), fileName.replace(/\.[^.]+$/, outExt))
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, output, "utf-8")
        log(`[kordoc watch] 완료: ${fileName} → ${basename(outPath)}`)
      } else {
        process.stdout.write(output + "\n")
      }

      await sendWebhook(webhook, {
        file: fileName,
        format: result.fileType,
        success: true,
        markdown: format === "markdown" ? output.substring(0, 1000) : undefined,
      })
    } catch (err) {
      log(`[kordoc watch] 에러: ${fileName} — ${err instanceof Error ? err.message : err}`)
    }
  }

  const enqueue = createTaskQueue(MAX_CONCURRENT, async (filePath) => {
    // 디바운스가 남아 있으면 아직 저장이 이어지는 중 — 건너뛰고 타이머가 다시 넣게 한다
    if (pending.has(filePath)) return
    await processFile(filePath).catch((err) => {
      process.stderr.write(`[kordoc watch] 처리 실패: ${filePath} — ${err instanceof Error ? err.message : String(err)}\n`)
    })
  })

  // fs.watch recursive (Node 18+ Windows/macOS, Node 19.1+ Linux — 위에서 사전 검증)
  const watcher = watch(dir, { recursive: true }, (event, filename) => {
    if (!filename) return
    const filePath = filename.toString()

    // 디바운스
    const existing = pending.get(filePath)
    if (existing) clearTimeout(existing)
    pending.set(filePath, setTimeout(() => {
      pending.delete(filePath)
      enqueue(filePath)
    }, DEBOUNCE_MS))
  })
  // 감시 자체의 런타임 에러(EMFILE 등)로 데몬이 죽지 않게 — 로그만 남기고 유지
  watcher.on("error", (err) => {
    process.stderr.write(`[kordoc watch] 감시 오류: ${err instanceof Error ? err.message : String(err)}\n`)
  })

  // 프로세스 종료 방지 (Ctrl+C로 종료)
  return new Promise(() => {})
}

/** Webhook URL 검증 — SSRF 방지: http/https만 허용, localhost/private IP 차단 */
function validateWebhookUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`유효하지 않은 webhook URL: ${url}`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`허용되지 않는 webhook 프로토콜: ${parsed.protocol}`)
  }
  const hostname = parsed.hostname.toLowerCase()
  if (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("169.254.") ||
    hostname.endsWith(".local") ||
    // IPv6 사설 대역
    hostname.startsWith("[fc") ||
    hostname.startsWith("[fd") ||
    hostname.startsWith("[fe80:") ||
    hostname === "[::0]" ||
    hostname === "[::]" ||
    // 클라우드 메타데이터 엔드포인트
    hostname === "metadata.google.internal" ||
    hostname === "metadata.google" ||
    // 16진수/8진수/10진수 정수 IP 인코딩 우회 방지
    /^0x[0-9a-f]+$/i.test(hostname) ||
    /^0[0-7]+$/.test(hostname) ||
    /^\d+$/.test(hostname) ||
    // IPv6 리터럴은 묶음으로 풀어 판정 — URL 이 [::ffff:127.0.0.1] 을 [::ffff:7f00:1] 로 바꿔 위 문자열 검사를 비켜 갔다
    (hostname.startsWith("[") && isPrivateIp(hostname.slice(1, -1)))
  ) {
    throw new Error(`내부 네트워크 대상 webhook은 허용되지 않습니다: ${hostname}`)
  }
}

/**
 * IP 리터럴의 사설/내부 대역 여부 — DNS 해석 결과 재검증용. IPv6 는 16비트 8묶음으로 풀어 IPv4 를 품은 형태
 * (mapped ::ffff:a.b.c.d, 변환형 ::ffff:0:a.b.c.d, 호환형 ::a.b.c.d, NAT64 64:ff9b::a.b.c.d)의 IPv4 를 다시 본다.
 * 종전엔 점표기 mapped 만 봐서, Node URL 이 [::ffff:127.0.0.1] 을 16진 [::ffff:7f00:1] 로 정규화하면 루프백·
 * 메타데이터(::ffff:a9fe:a9fe)로 POST 가 나갔다 (v4.14.4 리뷰 재현)
 */
export function isPrivateIp(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/%.*$/, "") // link-local 영역 표기(fe80::1%lo0) 제거
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return isPrivateV4(addr.split(".").map(Number))
  const g = ipv6Groups(addr)
  if (!g) return false
  const zero = (from: number, to: number) => g.slice(from, to).every(x => x === 0)
  const embedsV4 =
    (zero(0, 5) && g[5] === 0xffff) ||
    (zero(0, 4) && g[4] === 0xffff && g[5] === 0) ||
    (zero(0, 6) && (g[6] !== 0 || g[7] > 1)) || // :: 과 ::1 은 IPv6 그대로
    (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6))
  if (embedsV4) return isPrivateV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff])
  // IPv6 — loopback/미지정, ULA fc00::/7, link-local fe80::/10
  return (zero(0, 7) && g[7] <= 1) || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00 // ff00::/8 멀티캐스트
}

function isPrivateV4([a, b]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||               // 192.0.0/24 IETF·192.0.2/24 문서용 (b === 0 이 둘을 덮는다)
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 벤치마크
    a >= 224                                 // 224/4 멀티캐스트·240/4 예약·브로드캐스트
  )
}

/** IPv6 리터럴 → 16비트 8묶음 (:: 전개, 끝 점표기 IPv4 포함). 형식이 아니면 null */
function ipv6Groups(addr: string): number[] | null {
  let s = addr
  const v4 = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s)
  if (v4) {
    const o = v4.slice(2).map(Number)
    if (o.some(n => n > 255)) return null
    s = v4[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16)
  }
  const halves = s.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || head.length + fill + tail.length !== 8) return null
  const parts = [...head, ...Array<string>(fill).fill("0"), ...tail]
  return parts.every(p => /^[0-9a-f]{1,4}$/.test(p)) ? parts.map(p => parseInt(p, 16)) : null
}

async function sendWebhook(url: string | undefined, payload: Record<string, unknown>): Promise<void> {
  if (!url) return
  try {
    assertNetworkAllowed("webhook 전송", "폐쇄망에서 알림이 필요하면 --output 결과 파일을 감시하는 내부 작업으로 대체하세요")
    validateWebhookUrl(url)
    // DNS 해석 후 사설 IP 재검증 — 문자열 검사만으로는 내부망 도메인을 못 거른다
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "")
    const addrs = await lookup(hostname, { all: true, verbatim: true })
    const bad = addrs.find((a) => isPrivateIp(a.address))
    if (bad) throw new Error(`webhook 대상이 내부 네트워크로 해석됩니다: ${hostname} → ${bad.address}`)
    // Use the vetted address for the connection; fetch(url) would resolve the hostname a second time.
    const address = addrs[0]
    if (!address) throw new Error(`webhook DNS 결과가 없습니다: ${hostname}`)
    const body = JSON.stringify({ ...payload, timestamp: new Date().toISOString() })
    await postWebhookToAddress(parsed, address, body)
  } catch (err) {
    process.stderr.write(`[kordoc watch] webhook 전송 실패: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/** @internal Connect to the already vetted DNS address while retaining the URL's Host header and TLS name. */
export async function postWebhookToAddress(parsed: URL, address: { address: string; family: number }, body: string): Promise<void> {
  const request = parsed.protocol === "https:" ? httpsRequest : httpRequest
  await new Promise<void>((resolve, reject) => {
    const req = request(parsed, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [address])
        else callback(null, address.address, address.family)
      },
    }, (res) => {
      res.resume()
      res.on("end", resolve)
      res.on("error", reject)
    })
    req.setTimeout(10_000, () => req.destroy(new Error("webhook 연결 시간 초과")))
    req.on("error", reject)
    req.end(body)
  })
}
