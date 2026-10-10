/**
 * parse-worker protocol 2 — Java·Python SDK 용 상주 워커 계약 (docs/parse-worker-protocol.md).
 * protocol 1 과 같은 parseWorkerFile 로 파싱하고, 요청 검증·옵션 허용 목록·이미지 파일 전송·입출력 상한만 더한다.
 */

import { createHash } from "crypto"
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "fs"
import { basename, isAbsolute, join } from "path"
import { z } from "zod"
import type { IRBlock, ParseOptions, ParseResult } from "../types.js"
import { VERSION, sanitizeError } from "../utils.js"
import { parseWorkerFile } from "./worker-parse.js"

export const PARSE_WORKER_PROTOCOL_V2 = 2
export const CAPABILITIES = ["parse", "options", "transport.images.inline", "transport.images.files"] as const
/** 요청 한 줄 기본 상한 — 요청은 경로·옵션뿐이라 작다 */
export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
/** 응답 한 줄 기본 상한 — V8 문자열 한계(약 512MB) 아래. 넘으면 transport.images "files" 로 */
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024

export type WorkerErrorCode =
  | "INVALID_JSON" | "INVALID_REQUEST" | "INVALID_OPTIONS" | "UNSUPPORTED_COMMAND" | "DUPLICATE_ID"
  | "REQUEST_TOO_LARGE" | "RESPONSE_TOO_LARGE" | "ASSET_WRITE_FAILED"

/** 파싱 실패(result.success:false)가 아닌 요청·전송 오류 — 응답 {id?, error:{code, message}} */
export class WorkerProtocolError extends Error {
  constructor(readonly code: WorkerErrorCode, message: string) {
    super(message)
    this.name = "WorkerProtocolError"
  }
}

/** wire 로 받는 ParseOptions 허용 목록. 함수 값(ocr 프로바이더·onProgress)과 filePath 는 받지 않는다 */
const optionsSchema = z.object({
  tableFormat: z.literal("gfm"),
  htmlTables: z.boolean(),
  layoutTables: z.enum(["visual", "keep"]),
  classifyTables: z.boolean(),
  tables: z.boolean(),
  plain: z.boolean(),
  scriptTags: z.boolean(),
  removeHeaderFooter: z.boolean(),
  dedupeRunningHeaders: z.boolean(),
  keepTrailingEmptyCols: z.boolean(),
  keepEmptyParagraphs: z.boolean(),
  includeFieldPlaceholders: z.boolean(),
  pages: z.union([z.string(), z.array(z.number().int().positive())]),
  images: z.boolean(),
  inlineImages: z.boolean(),
  ocr: z.union([z.boolean(), z.literal("force")]),
  formulaOcr: z.boolean(),
  password: z.string(),
}).partial().strict()

const transportSchema = z.object({
  images: z.enum(["inline", "files"]).optional(),
  assetsDir: z.string().optional(),
}).strict()

const parseRequestSchema = z.object({
  id: z.number(),
  cmd: z.literal("parse"),
  file: z.string().min(1),
  options: z.unknown().optional(),
  transport: transportSchema.optional(),
}).strict()

const issueText = (e: z.ZodError, prefix: string): string =>
  e.issues.map(i => `${[prefix, ...i.path].filter(Boolean).join(".")}: ${i.message}`).join("; ")

/** wire options → ParseOptions. 미지정은 키를 두지 않아(엔진 기본값) false 와 구분한다. filePath 는 실제 입력 경로 */
export function toParseOptions(wire: unknown, absPath: string): ParseOptions {
  const parsed = optionsSchema.safeParse(wire ?? {})
  if (!parsed.success) throw new WorkerProtocolError("INVALID_OPTIONS", issueText(parsed.error, "options"))
  const o = parsed.data
  // parse() 는 실패 결과로 막지만, 요청 자체의 잘못이라 프로토콜 오류로 돌려준다
  if (o.htmlTables && o.tableFormat) throw new WorkerProtocolError("INVALID_OPTIONS", "options: htmlTables 와 tableFormat 은 함께 쓸 수 없습니다")
  const out: ParseOptions = { filePath: absPath }
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

interface ImageHolder { data?: unknown; filename?: string; dataRef?: { path: string; byteLength: number } }

/** 결과 안의 이미지 바이트(result.images[]·블록 imageData — children·셀 blocks·captionBlocks 까지)를 모은다 */
function collectImageHolders(result: ParseResult): ImageHolder[] {
  if (!result.success) return []
  const holders: ImageHolder[] = [...(result.images ?? [])]
  const walk = (blocks: IRBlock[] | undefined, depth: number): void => {
    if (!blocks || depth > 64) return
    for (const b of blocks) {
      if (b.imageData) holders.push(b.imageData)
      walk(b.children, depth + 1)
      if (b.table) {
        for (const row of b.table.cells) for (const cell of row) walk(cell.blocks, depth + 1)
        walk(b.table.captionBlocks, depth + 1)
      }
    }
  }
  walk(result.blocks, 0)
  return holders
}

/** 파일 이름으로 쓸 수 있는 글자만 — 경로 구분자·상위 경로·제어 문자를 막는다 */
function safeFileName(name: string | undefined, fallback: string): string {
  const base = basename((name ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "")
  return base && base !== "." && base !== ".." ? base.slice(0, 120) : fallback
}

/**
 * transport.images "files" — 이미지 바이트를 assetsDir 아래 요청별 새 디렉터리에 쓰고 data 를 dataRef {path, byteLength} 로 바꾼다.
 * path 는 그 디렉터리 기준 파일 이름. 같은 바이트는 한 파일을 함께 가리키고, 이름이 같아도 바이트가 다르면 다른 파일로 쓴다.
 * 파일은 배타 생성(wx)이라 기존 파일·링크를 덮어쓰지 않는다. 실패하면 이 요청이 만든 디렉터리만 지운다.
 * 이미지가 없으면 디렉터리를 만들지 않고 undefined
 */
export async function externalizeImages(result: ParseResult, assetsRoot: string, id: number): Promise<string | undefined> {
  const holders = collectImageHolders(result).filter(h => h.data !== undefined)
  if (!holders.length) return undefined
  const root = realpathSync(assetsRoot)
  const dir = mkdtempSync(join(root, `kordoc-${id}-`))
  try {
    const byHash = new Map<string, string>()
    const used = new Set<string>()
    let n = 0
    for (const h of holders) {
      if (!(h.data instanceof Uint8Array)) throw new WorkerProtocolError("ASSET_WRITE_FAILED", "이미지 바이트가 Uint8Array 가 아닙니다")
      const bytes = h.data
      const hash = createHash("sha256").update(bytes).digest("hex")
      let path = byHash.get(hash)
      if (!path) {
        const name = safeFileName(h.filename, `image_${String(++n).padStart(3, "0")}.bin`)
        path = name
        for (let k = 2; used.has(path); k++) path = name.replace(/(\.[^.]*)?$/, ext => `-${k}${ext}`)
        writeFileSync(join(dir, path), bytes, { flag: "wx" })
        used.add(path)
        byHash.set(hash, path)
      }
      delete h.data
      h.dataRef = { path, byteLength: bytes.byteLength }
    }
    return dir
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    if (err instanceof WorkerProtocolError) throw err
    throw new WorkerProtocolError("ASSET_WRITE_FAILED", sanitizeError(err))
  }
}

/** stdin 을 바이트 단위로 줄로 자른다 — 멀티바이트 글자가 read 경계에 걸려도 줄 단위로 해독. 상한을 넘은 줄은 tooLarge */
async function* readLines(input: NodeJS.ReadableStream, maxBytes: number): AsyncGenerator<{ line?: string; tooLarge?: true }> {
  let pending: Buffer[] = []
  let pendingBytes = 0
  let discarding = false
  for await (const chunk of input as AsyncIterable<Buffer>) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a)) {
      const head = buf.subarray(0, nl)
      buf = buf.subarray(nl + 1)
      if (discarding) { discarding = false; continue }
      if (pendingBytes + head.length > maxBytes) { pending = []; pendingBytes = 0; yield { tooLarge: true }; continue }
      const line = Buffer.concat([...pending, head]).toString("utf8").replace(/\r$/, "")
      pending = []
      pendingBytes = 0
      yield { line }
    }
    if (discarding) continue
    if (pendingBytes + buf.length > maxBytes) { pending = []; pendingBytes = 0; discarding = true; yield { tooLarge: true }; continue }
    if (buf.length) { pending.push(buf); pendingBytes += buf.length }
  }
  if (!discarding && pendingBytes) yield { line: Buffer.concat(pending).toString("utf8").replace(/\r$/, "") }
}

const bytesToBase64 = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value

const validId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0

export interface ParseWorkerV2Options {
  maxRequestBytes?: number
  maxResponseBytes?: number
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

/** protocol 2 워커 루프 — ready 를 쓰고 요청을 하나씩 처리한다. quit 또는 stdin EOF 에서 마지막 응답을 비우고 돌아온다 */
export async function runParseWorkerV2(opts: ParseWorkerV2Options = {}): Promise<void> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const maxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const seen = new Set<number>()
  let broken = false
  // 쓰기 오류는 write 콜백이 다룬다 — 리스너가 없으면 뒤따르는 'error' 가 uncaught 로 exit 1 을 낸다
  output.on("error", () => {})

  /** 한 줄 쓰기 — 상한을 넘거나 직렬화가 터지면 잘린 성공 대신 RESPONSE_TOO_LARGE(false 반환). stdout 이 닫혀 못 보냈어도 false */
  const write = async (o: Record<string, unknown>): Promise<boolean> => {
    let text: string
    let sent = true
    try {
      text = JSON.stringify(o, bytesToBase64)
      if (Buffer.byteLength(text) > maxResponseBytes) throw new RangeError("limit")
    } catch {
      sent = false
      text = JSON.stringify({ ...(validId(o.id) ? { id: o.id } : {}), error: { code: "RESPONSE_TOO_LARGE", message: `응답이 상한(${maxResponseBytes}바이트)을 넘습니다 — transport.images "files" 로 이미지를 파일로 받으세요` } })
    }
    // 쓰기 콜백까지 기다린다 — drain 대기를 겸한다
    const delivered = await new Promise<boolean>((done, reject) => output.write(text + "\n", err => {
      if (!err) return done(true)
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED") return reject(err)
      // 답할 곳이 없으니 stdin 도 끊어 다음 줄이나 EOF 를 기다리지 않는다
      broken = true
      ;(input as { destroy?: () => void }).destroy?.()
      done(false)
    }))
    return sent && delivered
  }
  const fail = (id: unknown, code: WorkerErrorCode, message: string) =>
    write({ ...(validId(id) ? { id } : {}), error: { code, message } })

  await write({ ready: true, version: VERSION, protocol: PARSE_WORKER_PROTOCOL_V2, capabilities: [...CAPABILITIES] })

  /** stdout 이 닫혀 stdin 을 끊어 생긴 premature close 는 입력의 끝으로 본다 */
  async function* requests(): AsyncGenerator<{ line?: string; tooLarge?: true }> {
    try { yield* readLines(input, maxRequestBytes) } catch (err) {
      if (!broken || (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") throw err
    }
  }

  for await (const { line, tooLarge } of requests()) {
    // stdout 이 닫혔으면 남은 요청은 답할 곳이 없다 — 파싱하지 않고 끝낸다
    if (broken) break
    if (tooLarge) { await fail(undefined, "REQUEST_TOO_LARGE", `요청이 상한(${maxRequestBytes}바이트)을 넘습니다`); continue }
    const t = line!.trim()
    if (!t) continue
    let raw: unknown
    try { raw = JSON.parse(t) } catch { await fail(undefined, "INVALID_JSON", "잘못된 JSON 라인"); continue }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) { await fail(undefined, "INVALID_REQUEST", "JSON 객체가 아닙니다"); continue }
    const msg = raw as Record<string, unknown>
    if (msg.cmd === "quit") break
    const id = msg.id
    if (!validId(id)) { await fail(undefined, "INVALID_REQUEST", "id 는 양의 안전한 정수여야 합니다"); continue }
    if (msg.cmd !== undefined && msg.cmd !== "parse") { await fail(id, "UNSUPPORTED_COMMAND", `지원하지 않는 cmd: ${String(msg.cmd).slice(0, 40)}`); continue }
    if (seen.has(id)) { await fail(id, "DUPLICATE_ID", `이미 쓴 id: ${id}`); continue }
    seen.add(id)
    const req = parseRequestSchema.safeParse(msg)
    if (!req.success) { await fail(id, "INVALID_REQUEST", issueText(req.error, "")); continue }
    const { file, transport } = req.data
    if (!isAbsolute(file)) { await fail(id, "INVALID_REQUEST", "file 은 절대 경로여야 합니다"); continue }
    const files = transport?.images === "files"
    if (files) {
      const dir = transport?.assetsDir
      let isDir = false
      try { isDir = !!dir && isAbsolute(dir) && statSync(dir).isDirectory() } catch { /* 없는 경로 */ }
      if (!isDir) { await fail(id, "INVALID_REQUEST", "transport.images \"files\" 는 있는 디렉터리의 절대 경로 assetsDir 가 필요합니다"); continue }
    }
    let options: ParseOptions
    try { options = toParseOptions(req.data.options, file) } catch (err) {
      await fail(id, (err as WorkerProtocolError).code, (err as Error).message)
      continue
    }
    const result = await parseWorkerFile(file, options)
    let assetsDir: string | undefined
    if (files) {
      try { assetsDir = await externalizeImages(result, transport!.assetsDir!, id) } catch (err) {
        await fail(id, "ASSET_WRITE_FAILED", (err as Error).message)
        continue
      }
    }
    const sent = await write({ id, rss: process.memoryUsage.rss(), ...(assetsDir ? { assetsDir } : {}), result })
    // 응답을 못 보냈으면(상한 초과·stdout 닫힘) 그 요청의 자산은 아무도 가리키지 않는다 — 미완료 자산으로 지운다
    if (!sent && assetsDir) rmSync(assetsDir, { recursive: true, force: true })
  }
  // 파이프 stdout 은 맥·윈도에서 비동기라 다 비운 뒤 돌아간다
  await new Promise<void>(done => output.write("", () => done()))
}
