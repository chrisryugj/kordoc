/** 디렉토리 감시 모드 — 새 문서 자동 변환 + Webhook 알림 */

import { watch, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "fs"
import { basename, resolve, extname } from "path"
import { parse, detectFormat } from "./index.js"
import { toArrayBuffer } from "./utils.js"
import type { WatchOptions } from "./types.js"

const SUPPORTED_EXTENSIONS = new Set([".hwp", ".hwpx", ".pdf"])
const DEBOUNCE_MS = 1000
/** 파일 쓰기 완료 판정: 연속 2회 동일 크기 확인 간격 */
const STABLE_CHECK_MS = 300
const MAX_FILE_SIZE = 500 * 1024 * 1024

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

  // 디바운스 맵
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

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
      const absPath = resolve(dir, filePath)
      if (!existsSync(absPath)) return

      const fileSize = await waitForStableSize(absPath)
      if (fileSize > MAX_FILE_SIZE || fileSize === 0) return

      log(`[kordoc watch] 변환 중: ${fileName}`)

      const buffer = readFileSync(absPath)
      const arrayBuffer = toArrayBuffer(buffer)
      const parseOptions = pages ? { pages } : undefined
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

  // fs.watch recursive (Node 18+ Windows/macOS, Node 19+ Linux)
  watch(dir, { recursive: true }, (event, filename) => {
    if (!filename) return
    const filePath = filename.toString()

    // 디바운스
    const existing = pending.get(filePath)
    if (existing) clearTimeout(existing)
    pending.set(filePath, setTimeout(() => {
      pending.delete(filePath)
      processFile(filePath).catch((err) => {
        process.stderr.write(`[kordoc watch] 처리 실패: ${filePath} — ${err instanceof Error ? err.message : String(err)}\n`)
      })
    }, DEBOUNCE_MS))
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
    hostname.endsWith(".local")
  ) {
    throw new Error(`내부 네트워크 대상 webhook은 허용되지 않습니다: ${hostname}`)
  }
}

async function sendWebhook(url: string | undefined, payload: Record<string, unknown>): Promise<void> {
  if (!url) return
  try {
    validateWebhookUrl(url)
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
    })
  } catch (err) {
    process.stderr.write(`[kordoc watch] webhook 전송 실패: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}
