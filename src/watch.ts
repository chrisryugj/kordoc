/** 디렉토리 감시 모드 — 새 문서 자동 변환 + Webhook 알림 */

import { watch, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, realpathSync } from "fs"
import { lookup } from "dns/promises"
import { basename, resolve, extname, sep } from "path"
import { parse, detectFormat } from "./index.js"
import { toArrayBuffer } from "./utils.js"
import type { WatchOptions, ParseOptions } from "./types.js"

export const SUPPORTED_EXTENSIONS = new Set([".hwp", ".hwpx", ".hml", ".pdf", ".xls", ".xlsx", ".docx"])
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
 */
export function createTaskQueue(maxConcurrent: number, run: (key: string) => Promise<void>): (key: string) => void {
  let active = 0
  const inProgress = new Set<string>()
  const waiting: string[] = []
  const enqueue = (key: string): void => {
    if (inProgress.has(key)) return // 동일 파일 동시 처리 방지
    if (active >= maxConcurrent) {
      if (!waiting.includes(key)) waiting.push(key)
      return
    }
    inProgress.add(key)
    active++
    void run(key).finally(() => {
      inProgress.delete(key)
      active--
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
  assertRecursiveWatchSupport()
  if (webhook) validateWebhookUrl(webhook)
  if (outDir) mkdirSync(outDir, { recursive: true })

  const log = silent ? () => {} : (msg: string) => process.stderr.write(msg + "\n")
  log(`[kordoc watch] 감시 시작: ${resolve(dir)}`)
  if (outDir) log(`[kordoc watch] 출력: ${resolve(outDir)}`)
  if (webhook) log(`[kordoc watch] 웹훅: ${webhook}`)

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

      const output = format === "json" ? JSON.stringify(result, null, 2) : result.markdown

      if (outDir) {
        const outExt = format === "json" ? ".json" : ".md"
        const outPath = resolve(outDir, fileName.replace(/\.[^.]+$/, outExt))
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

  const enqueue = createTaskQueue(MAX_CONCURRENT, (filePath) =>
    processFile(filePath).catch((err) => {
      process.stderr.write(`[kordoc watch] 처리 실패: ${filePath} — ${err instanceof Error ? err.message : String(err)}\n`)
    }),
  )

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
    /^\d+$/.test(hostname)
  ) {
    throw new Error(`내부 네트워크 대상 webhook은 허용되지 않습니다: ${hostname}`)
  }
}

/** IP 리터럴의 사설/내부 대역 여부 — DNS 해석 결과 재검증용 (IPv4-mapped IPv6 포함) */
export function isPrivateIp(ip: string): boolean {
  let addr = ip.toLowerCase()
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) → 내장 IPv4로 재검사
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (mapped) addr = mapped[1]
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const [a, b] = addr.split(".").map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  // IPv6 — loopback/미지정, ULA fc00::/7, link-local fe80::/10
  return addr === "::" || addr === "::1" || /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr)
}

async function sendWebhook(url: string | undefined, payload: Record<string, unknown>): Promise<void> {
  if (!url) return
  try {
    validateWebhookUrl(url)
    // DNS 해석 후 사설 IP 재검증 — 문자열 검사만으로는 내부망 도메인을 못 거른다
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "")
    const addrs = await lookup(hostname, { all: true, verbatim: true })
    const bad = addrs.find((a) => isPrivateIp(a.address))
    if (bad) throw new Error(`webhook 대상이 내부 네트워크로 해석됩니다: ${hostname} → ${bad.address}`)
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
      redirect: "error",
    })
  } catch (err) {
    process.stderr.write(`[kordoc watch] webhook 전송 실패: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}
