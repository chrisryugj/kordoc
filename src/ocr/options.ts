/**
 * 내장 OCR 엔진 옵션(ocrLines·ocrDet·ocrDetLongSide·ocrRec·ocrRecDict) 값 검증 — parse()·parse-worker 가 함께 쓴다.
 * 모델·다운로드 모듈을 끌어오지 않게 따로 둔다(OCR 을 안 쓰는 파싱도 이 검증은 지난다).
 */

import { isAbsolute } from "path"
import type { ParseOptions } from "../types.js"

/** OCR 엔진 옵션 검증 — 잘못이면 사유 문자열(parse() 실패 결과·워커 INVALID_OPTIONS 가 그대로 쓴다), 맞으면 null */
export function validateOcrOptions(o: Pick<ParseOptions, "ocrLines" | "ocrDet" | "ocrDetLongSide" | "ocrRec" | "ocrRecDict"> | undefined): string | null {
  if (!o) return null
  if (o.ocrLines !== undefined && typeof o.ocrLines !== "boolean" && o.ocrLines !== "all") return `ocrLines 는 true·false·"all" 입니다 (받은 값: ${JSON.stringify(o.ocrLines)})`
  const det = o.ocrDet
  if (det !== undefined && det !== "mobile" && det !== "server" && det !== "medium") {
    if (typeof det === "string" || !det || typeof det !== "object") return `ocrDet 은 "mobile"·"server"·"medium" 또는 {path, sha256} 입니다 (받은 값: ${JSON.stringify(det)})`
    const bad = modelFileError("ocrDet", det)
    if (bad) return bad
  }
  const side = o.ocrDetLongSide
  if (side !== undefined && (typeof side !== "number" || !Number.isInteger(side) || side < 32 || side > 4096)) {
    return `ocrDetLongSide 는 32~4096 정수입니다 (받은 값: ${JSON.stringify(side)})`
  }
  const rec = o.ocrRec
  if (rec !== undefined && rec !== "handwriting" && rec !== "auto") {
    if (typeof rec === "string") return `ocrRec 은 "handwriting"·"auto" 또는 {path, sha256} 입니다 (받은 값: ${JSON.stringify(rec)})`
    const bad = modelFileError("ocrRec", rec)
    if (bad) return bad
  }
  if (o.ocrRecDict !== undefined) {
    const bad = modelFileError("ocrRecDict", o.ocrRecDict)
    if (bad) return bad
  }
  return null
}

function modelFileError(key: string, f: unknown): string | null {
  if (!f || typeof f !== "object" || Array.isArray(f)) return `${key} 는 {path, sha256} 객체입니다`
  const { path, sha256, ...rest } = f as Record<string, unknown>
  const extra = Object.keys(rest)
  if (extra.length) return `${key}: 모르는 키 ${extra.join(", ")}`
  if (typeof path !== "string" || !isAbsolute(path)) return `${key}.path 는 절대 경로입니다 (받은 값: ${JSON.stringify(path)})`
  if (typeof sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha256)) return `${key}.sha256 은 16진 64자입니다`
  return null
}
