/** parse-worker 공통 파싱 — protocol 1·2 가 같은 경로로 parse() 를 부른다 */

import { readFile, stat } from "fs/promises"
import { parse } from "../index.js"
import type { ParseOptions, ParseResult } from "../types.js"
import { toArrayBuffer, sanitizeError, classifyError } from "../utils.js"

/** CLI 와 같은 입력 상한 */
const MAX_FILE_BYTES = 500 * 1024 * 1024

/** 파일 하나를 파싱한다. 실패는 던지지 않고 success:false 결과로 (CLI --format json 과 같은 계약) */
export async function parseWorkerFile(absPath: string, options: ParseOptions): Promise<ParseResult> {
  try {
    // 상주 워커는 이벤트 루프가 하나뿐이다. 동기로 읽으면 큰 파일을 읽는 동안 신호 처리·stdout 비우기가 멈춘다(#224)
    const size = (await stat(absPath)).size
    if (size > MAX_FILE_BYTES) {
      return { success: false, fileType: "unknown", error: `파일이 너무 큽니다 (${(size / 1024 / 1024).toFixed(1)}MB)`, code: "PARSE_ERROR" }
    }
    return await parse(toArrayBuffer(await readFile(absPath)), options)
  } catch (err) {
    return { success: false, fileType: "unknown", error: sanitizeError(err), code: classifyError(err) }
  }
}
