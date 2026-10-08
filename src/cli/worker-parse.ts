/** parse-worker 공통 파싱 — protocol 1·2 가 같은 경로로 parse() 를 부른다 */

import { readFileSync, statSync } from "fs"
import { parse } from "../index.js"
import type { ParseOptions, ParseResult } from "../types.js"
import { toArrayBuffer, sanitizeError, classifyError } from "../utils.js"

/** CLI 와 같은 입력 상한 */
const MAX_FILE_BYTES = 500 * 1024 * 1024

/** 파일 하나를 파싱한다. 실패는 던지지 않고 success:false 결과로 (CLI --format json 과 같은 계약) */
export async function parseWorkerFile(absPath: string, options: ParseOptions): Promise<ParseResult> {
  try {
    const size = statSync(absPath).size
    if (size > MAX_FILE_BYTES) {
      return { success: false, fileType: "unknown", error: `파일이 너무 큽니다 (${(size / 1024 / 1024).toFixed(1)}MB)`, code: "PARSE_ERROR" }
    }
    return await parse(toArrayBuffer(readFileSync(absPath)), options)
  } catch (err) {
    return { success: false, fileType: "unknown", error: sanitizeError(err), code: classifyError(err) }
  }
}
