/** kordoc CLI 명령: 상주 파싱 워커 (parse-worker) */

import { readFileSync, statSync } from "fs"
import { resolve } from "path"
import { parse } from "../index.js"
import type { ParseOptions, ParseResult } from "../types.js"
import { VERSION, toArrayBuffer, sanitizeError, classifyError, routeConsoleToStderr } from "../utils.js"
import type { Command } from "commander"

/** 요청·응답 필드가 바뀌면 올린다. 호스트가 ready 줄로 호환을 판단한다 */
export const PARSE_WORKER_PROTOCOL = 1

/** CLI 와 같은 입력 상한 */
const MAX_FILE_BYTES = 500 * 1024 * 1024

interface ParseWorkerRequest {
  id?: number
  cmd?: string
  file?: string
  /** false 면 이미지 바이트를 싣지 않는다 (ParseOptions.images) */
  images?: boolean
  /** "off"(기본) | "auto"(OCR 필요 페이지만) | "force"(전 페이지) */
  ocr?: "off" | "auto" | "force"
  formulaOcr?: boolean
  password?: string | null
}

/** 이미지 바이트는 --format json 과 같게 base64 로 */
const bytesToBase64 = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value

async function parseOne(req: ParseWorkerRequest & { file: string }): Promise<ParseResult> {
  const absPath = resolve(req.file)
  try {
    const size = statSync(absPath).size
    if (size > MAX_FILE_BYTES) {
      return { success: false, fileType: "unknown", error: `파일이 너무 큽니다 (${(size / 1024 / 1024).toFixed(1)}MB)`, code: "PARSE_ERROR" }
    }
    const options: ParseOptions = { filePath: absPath }
    if (req.images === false) options.images = false
    if (req.ocr === "force") options.ocr = "force"
    else if (req.ocr === "auto") options.ocr = true
    if (req.formulaOcr) options.formulaOcr = true
    if (req.password) options.password = req.password
    return await parse(toArrayBuffer(readFileSync(absPath)), options)
  } catch (err) {
    return { success: false, fileType: "unknown", error: sanitizeError(err), code: classifyError(err) }
  }
}

export function registerWorkerCommands(program: Command): void {
  program
    .command("parse-worker")
    .description("상주 파싱 워커: stdin NDJSON 요청 → 한 줄 JSON 응답 (프로세스 유지, 파일마다 node 를 새로 띄우는 비용 제거)")
    .action(async () => {
      // 프로토콜(NDJSON, 한 줄 = 한 메시지):
      //  시작 {"ready":true,"version":"4.14.3","protocol":1}
      //  요청 {"id":1,"file":"a.hwpx","images":false,"ocr":"off","formulaOcr":false,"password":null}
      //  응답 {"id":1,"rss":123456789,"result":{…}}: result 는 --format json 과 같은 ParseResult (실패도 success:false 로)
      //       {"id":1,"error":"…"}: 요청 자체가 잘못됐을 때
      //  {"cmd":"quit"} 또는 stdin 닫힘으로 종료. rss 는 호스트가 워커 교체 시점을 정하는 데 쓴다.
      // pdfjs 등이 console 로 찍는 경고가 stdout 프로토콜 줄을 깨지 않게 stderr 로 돌린다
      routeConsoleToStderr()
      const { createInterface } = await import("node:readline")
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
      const write = (o: unknown): void => void process.stdout.write(JSON.stringify(o, bytesToBase64) + "\n")
      write({ ready: true, version: VERSION, protocol: PARSE_WORKER_PROTOCOL })
      for await (const line of rl) {
        const t = line.trim()
        if (!t) continue
        let req: ParseWorkerRequest
        // 비JSON 라인도 응답은 낸다. 무음 삼킴이면 id 를 기다리는 호스트가 영구 대기
        try { req = JSON.parse(t) } catch { write({ error: "잘못된 JSON 라인" }); continue }
        if (req === null || typeof req !== "object") { write({ error: "JSON 객체가 아닙니다" }); continue }
        if (req.cmd === "quit") break
        const id = req.id
        if (typeof req.file !== "string" || !req.file) { write({ id, error: "file 필수" }); continue }
        const result = await parseOne({ ...req, file: req.file })
        try {
          write({ id, rss: process.memoryUsage.rss(), result })
        } catch (err) {
          // 직렬화 한계(이미지 수백 장 base64 등, #65)는 실패 JSON 계약으로
          write({ id, rss: process.memoryUsage.rss(), result: { success: false, fileType: result.fileType, error: sanitizeError(err), code: classifyError(err) } })
        }
      }
      rl.close()
      // 파이프 stdout 은 맥·윈도에서 비동기라 바로 exit 하면 마지막 응답이 잘린다. 다 비운 뒤 끝낸다.
      // pdfjs 등이 남긴 핸들이 있어도 워커는 끝낸다 (호스트가 죽어 stdin 이 닫힌 경우의 고아 방지)
      await new Promise<void>((done) => process.stdout.write("", () => done()))
      process.exit(0)
    })
}
