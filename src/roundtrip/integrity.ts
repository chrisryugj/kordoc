/**
 * HWPX 패치 결과 무결성 검사 — 재파싱 검증(patcher 7단계)은 같은 파서로 양쪽을 읽어 파서가 못 보는 손상(관대한
 * XML 복구, 건드리지 말아야 할 엔트리의 바이트 변화)을 놓친다. 패처가 약속하는 것을 바이트·구조로 직접 확인한다.
 *  1. 엔트리 목록이 같고, 교체하지 않은 엔트리는 압축 바이트까지 원본 그대로
 *  2. 교체한 XML 은 엄격 파싱에서 오류가 없다 (원본부터 오류가 있던 엔트리는 제외 — 관대한 파서 전제의 실문서)
 *  3. 태그를 건드리지 않은 글 편집만 있는 섹션은 줄 레이아웃 캐시(linesegarray)를 뺀 태그 순서·속성이 원본 그대로
 * 착안: hwp-auto-docfit fidelity/verify.py 다층 검증 (MIT, THIRD_PARTY/hwp-auto-docfit.LICENSE)
 */

import { DOMParser } from "@xmldom/xmldom"
import { inflateRawSync } from "zlib"
import { readZipEntries } from "./zip-patch.js"
import type { SpliceEdit } from "./source-map.js"

/** 줄 레이아웃 캐시 — 글이 바뀐 섹션은 패처가 통째로 비운다 */
const LINESEG_RE = /<(\w+:)?linesegarray\b[^>]*?(?:\/>|>[\s\S]*?<\/\1linesegarray>)/g
const TAG_RE = /<[^>]+>/g

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) === 0

/** 엄격 XML 파싱 — 경고 말고 오류·치명 오류가 하나라도 있으면 그 메시지 (치명 오류는 xmldom 이 알린 뒤 던진다) */
function xmlError(xml: string): string | null {
  let error: string | null = null
  try {
    new DOMParser({ onError: (level, msg) => { if (level !== "warning" && !error) error = String(msg) } }).parseFromString(xml, "text/xml")
  } catch (e) {
    error ??= e instanceof Error ? e.message : String(e)
  }
  return error
}

/** 태그를 건드리지 않은 splice — 바꾸는 원문 구간과 넣는 글 모두 '<' 가 없다 (hp:t 안 글만 고침) */
const textOnly = (xml: string, s: SpliceEdit): boolean => !s.replacement.includes("<") && !xml.slice(s.start, s.end).includes("<")

/**
 * @param sections 교체한 섹션 — 원본 XML 과 그 섹션에 건 편집 splice (linesegarray 제거 splice 는 빼고)
 * @returns 발견한 문제 (없으면 빈 배열)
 */
export function checkPatchIntegrity(
  original: Uint8Array,
  patched: Uint8Array,
  replacements: Map<string, Uint8Array>,
  sections: Array<{ name: string; xml: string; splices: SpliceEdit[] }>,
): string[] {
  const issues: string[] = []
  const a = readZipEntries(original), b = readZipEntries(patched)
  const names = (m: Map<string, unknown>): string => [...m.keys()].join("\n")
  if (names(a) !== names(b)) issues.push("ZIP 엔트리 목록·순서가 원본과 다름")
  for (const [name, entry] of a) {
    if (replacements.has(name)) continue
    const out = b.get(name)
    if (!out || out.method !== entry.method || !sameBytes(out.compData, entry.compData)) issues.push(`교체하지 않은 엔트리의 바이트가 바뀜: ${name}`)
  }
  const decoder = new TextDecoder()
  const originalText = (name: string): string | null => {
    const e = a.get(name)
    if (!e) return null
    try { return decoder.decode(e.method === 8 ? inflateRawSync(e.compData) : e.compData) } catch { return null }
  }
  for (const [name, data] of replacements) {
    if (!/\.xml$/i.test(name)) continue
    const err = xmlError(decoder.decode(data))
    const before = originalText(name)
    if (err && before !== null && !xmlError(before)) issues.push(`교체한 XML 이 올바르지 않음: ${name} — ${err.split("\n")[0]}`)
  }
  for (const { name, xml, splices } of sections) {
    if (!splices.every(s => textOnly(xml, s))) continue
    const data = replacements.get(name)
    if (!data) continue
    const tags = (x: string): string => (x.replace(LINESEG_RE, "").match(TAG_RE) ?? []).join("")
    if (tags(xml) !== tags(decoder.decode(data))) issues.push(`글만 고친 섹션의 태그·속성이 바뀜: ${name}`)
  }
  return issues
}
