/**
 * HWPX 구조 검증 — 한컴오피스/한컴독스가 열기를 거부하는 컨테이너 결함을 사전에 잡는다.
 *
 * 검사 항목 (claw-hwp validate.py의 실측 검사셋 이식 — MIT © DoHyun468/claw-hwp):
 * - 유효한 ZIP인지, mimetype이 첫 엔트리이고 내용이 application/hwp+zip인지
 * - 필수 파일 존재 (META-INF/container.xml, content.hpf, header.xml, section0.xml)
 * - XML/HPF/RDF 엔트리 웰폼드
 * - header.xml secCnt == 실제 Contents/sectionN.xml 수
 *   (한컴독스는 실제 파일 목록이 아니라 secCnt를 신뢰하고, 불일치 시 열기를 거부한다)
 * - content.hpf manifest의 <opf:item href>가 전부 실존하는지
 */

import JSZip from "jszip"
import { DOMParser } from "@xmldom/xmldom"

/** 검증에서 발견된 문제 하나 */
export interface ValidateIssue {
  /** 문제가 발견된 zip 내부 경로 (컨테이너 전역 문제면 생략) */
  path?: string
  message: string
}

/** validateHwpx 결과 */
export interface ValidateResult {
  ok: boolean
  issues: ValidateIssue[]
  /** 검사한 zip 엔트리 수 (디렉토리 제외) */
  entryCount: number
}

const REQUIRED_FILES = [
  "mimetype",
  "META-INF/container.xml",
  "Contents/content.hpf",
  "Contents/header.xml",
  "Contents/section0.xml",
]
const EXPECTED_MIMETYPE = "application/hwp+zip"
const XML_SUFFIXES = [".xml", ".hpf", ".rdf"]
const SECTION_FILE_RE = /^Contents\/section\d+\.xml$/
const SECCNT_RE = /<(?:\w+:)?head\b[^>]*?\bsecCnt="(\d+)"/
const OPF_HREF_RE = /<opf:item\b[^>]*?\bhref="([^"]*)"/g

/** HWPX 버퍼의 컨테이너 구조를 검증한다. 문제가 없으면 ok=true. */
export async function validateHwpx(buffer: ArrayBuffer | Uint8Array): Promise<ValidateResult> {
  const issues: ValidateIssue[] = []

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (err) {
    return {
      ok: false,
      issues: [{ message: `유효한 ZIP이 아님: ${err instanceof Error ? err.message : String(err)}` }],
      entryCount: 0,
    }
  }

  // 중앙 디렉토리 순서 그대로 (첫 엔트리 검사에 필요), 파일 목록은 디렉토리 엔트리 제외
  const rawNames = Object.keys(zip.files)
  const names = rawNames.filter(n => !zip.files[n].dir)
  if (names.length === 0) return { ok: false, issues: [{ message: "빈 ZIP" }], entryCount: 0 }

  if (rawNames[0] !== "mimetype") {
    issues.push({ message: `첫 zip 엔트리가 '${rawNames[0]}' — 'mimetype'이어야 함` })
  }

  const nameset = new Set(names)
  if (nameset.has("mimetype")) {
    const mt = (await zip.files["mimetype"].async("string")).trim()
    if (mt !== EXPECTED_MIMETYPE) {
      issues.push({ path: "mimetype", message: `내용이 '${mt}' — '${EXPECTED_MIMETYPE}'이어야 함` })
    }
  }

  for (const req of REQUIRED_FILES) {
    if (!nameset.has(req)) issues.push({ message: `필수 파일 누락: ${req}` })
  }

  // XML 웰폼드 — warn 수준은 무시, error/fatalError만 문제로 취급
  for (const name of names) {
    if (!XML_SUFFIXES.some(s => name.endsWith(s))) continue
    const text = await zip.files[name].async("string")
    let firstError: string | null = null
    try {
      new DOMParser({
        onError(level, msg) {
          // xmldom ErrorHandlerFunction의 level은 "warning" | "error" | "fatalError"
          if (level !== "warning" && firstError === null) firstError = String(msg)
        },
      }).parseFromString(text, "text/xml")
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err)
    }
    if (firstError !== null) {
      issues.push({ path: name, message: `XML 웰폼드 위반: ${(firstError as string).split("\n")[0]}` })
    }
  }

  // secCnt ↔ 실제 섹션 파일 수
  if (nameset.has("Contents/header.xml")) {
    const header = await zip.files["Contents/header.xml"].async("string")
    const m = SECCNT_RE.exec(header)
    if (m) {
      const declared = Number(m[1])
      const actual = names.filter(n => SECTION_FILE_RE.test(n)).length
      if (declared !== actual) {
        issues.push({
          path: "Contents/header.xml",
          message: `secCnt=${declared}인데 실제 sectionN.xml은 ${actual}개 — 한컴독스가 열기를 거부함`,
        })
      }
    }
  }

  // manifest href 실존 — content.hpf는 Contents/ 안에 있어 href는 그 위치 기준 상대경로("section0.xml")가
  // 표준(OCF)이지만, kordoc 생성기는 루트 기준 full path("Contents/section0.xml")로 쓴다. 두 관례 모두 유효로
  // 인정한다(한컴 원본은 상대경로 — 안 그러면 정상 파일에 오탐).
  if (nameset.has("Contents/content.hpf")) {
    const hpf = await zip.files["Contents/content.hpf"].async("string")
    for (const m of hpf.matchAll(OPF_HREF_RE)) {
      const href = m[1]
      if (!nameset.has(href) && !nameset.has(`Contents/${href}`)) {
        issues.push({ path: "Contents/content.hpf", message: `manifest가 없는 파일을 참조: ${href}` })
      }
    }
  }

  return { ok: issues.length === 0, issues, entryCount: names.length }
}
