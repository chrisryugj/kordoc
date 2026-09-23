/**
 * 문서 파일 단위 PII 마스킹 — 본문 마크다운만이 아니라 파일 안 모든 글자 저장소를 가린다.
 *
 * 흐름: parse → 마크다운 탐지(표 머리글 문맥 포함, 리포트·리터럴용) → 컨테이너 직접 수술
 *   - HWPX: 모든 XML 의 <hp:p> 문단(본문·표·중첩표·글상자·머리말/꼬리말·각주/미주·캡션·메모),
 *     그 밖의 텍스트 노드·속성값(필드 명령·개체 설명·content.hpf 메타데이터), Preview/PrvText.txt,
 *     미리보기 이미지(빈 이미지로 교체)            → redact-hwpx.ts
 *   - HWP5: BodyText 전 레코드(PARA_TEXT 문단 + 필드·개체 설명 문자열), DocInfo, PrvText,
 *     \x05HwpSummaryInformation(제목=첫 줄·작성자), Scripts·기타 스트림, PrvImage   → redact-hwp5.ts
 *   - 그 외 포맷(PDF·DOCX·XLSX·HWP3·이미지…): 원본 파일은 건드리지 않고 마스킹된 마크다운만
 *
 * 왜 patchHwpx/patchHwp(마크다운 편집 역반영)를 쓰지 않나: 그 경로는 마크다운에 없는 곳(머리말·각주·
 * 미리보기·메타데이터)을 못 가리고, 매핑 실패 문단(강제 줄바꿈·표 개수 불일치·탭 포함 HWP5 문단)은
 * 원문을 남긴 채 skip 한다. 여기서는 같은 길이 글자 치환만 하므로 문단 구조·run·글자모양이 그대로다.
 *
 * 마스킹 뒤 결과를 두 갈래로 다시 검사해 남은 PII(residual)를 보고한다 — 0 이 아니면 호출자가 실패로
 * 다뤄야 한다. (1) 결과 파일을 같은 컨테이너 검사기로 훑기(가리지 못한 OLE 개체·압축 메타데이터 포함),
 * (2) 결과 파일을 파서로 다시 읽은 본문에 탐지 룰·본문에서 찾은 값이 남았는지 — 컨테이너 검사기와
 * 독립된 경로라 문단 조립·마스킹 splice 의 결함도 드러난다. 리포트에는 원본 PII 를 담지 않는다(masked 만).
 */

import { parse } from "./index.js"
import { detectFormat, detectZipFormat, detectOle2Format } from "./detect.js"
import { redactMarkdown, normalizeForDetect, DEFAULT_REDACT_RULES, type RedactHit, type RedactOptions } from "./redact.js"
import { literalsFromMarkdown, findLiterals, type ScrubCtx, type RedactFileHit } from "./redact-scrub.js"
import { scrubHwpx } from "./redact-hwpx.js"
import { scrubHwp5 } from "./redact-hwp5.js"

export type { RedactFileHit, RedactWhere } from "./redact-scrub.js"

export interface RedactDocumentOptions extends RedactOptions {
  /** 파일 경로 (파서 힌트 — 확장자·OCR 캐시) */
  filePath?: string
  /** 탐지만 하고 결과 파일 바이트를 만들지 않는다 */
  dryRun?: boolean
}

export interface RedactDocumentResult {
  /** 세분화 포맷 (hwpx·hwp·pdf·docx·xlsx …) */
  format: string
  /** 마스킹된 원본 형식 파일 — HWPX/HWP 만. 그 외 포맷·dryRun 은 undefined */
  data?: Uint8Array
  /** HWPX/HWP 결과 파일이 원본과 다른가 (가림·미할당 영역 비움 포함) — 다를 때만 저장할 가치가 있다 */
  changed: boolean
  /** 마스킹된 본문 마크다운 (모든 포맷) */
  markdown: string
  /** 본문 마크다운 기준 탐지 (index 는 마크다운 오프셋) */
  markdownHits: RedactHit[]
  /** 파일 안에서 실제로 가린 곳 (HWPX/HWP) — 같은 값이 본문·미리보기·메타데이터에 있으면 각각 1건 */
  fileHits: RedactFileHit[]
  /** 마스킹 결과를 다시 훑어 남은 PII (결과 파일 컨테이너 + 재파싱 본문) — 비어 있어야 정상 */
  residual: RedactFileHit[]
  /** 글자가 있을 자리인데 검사하지 못한 파트·결과 재파싱 실패 — 비어 있어야 정상 (잔존과 같은 실패) */
  unscanned: string[]
  /** 검사하지 못한 부분·주의 사항 (이미지 속 글자 등) */
  warnings: string[]
}

// ─── 진입점 ──────────────────────────────────────────

/** 세분화 포맷 판정 — ZIP·OLE 내부 구조까지 (PPTX·XLS 를 hwpx·hwp 로 오인하지 않게) */
async function preciseFormat(buffer: ArrayBuffer): Promise<string> {
  let format: string = detectFormat(buffer)
  if (format === "hwpx") { const z = await detectZipFormat(buffer); if (z !== "unknown") format = z }
  else if (format === "hwp") { const o = detectOle2Format(buffer); if (o !== "unknown") format = o }
  return format
}

/**
 * 문서 한 건을 마스킹한다. HWPX/HWP 는 원본 서식 그대로 같은 길이 글자 치환한 파일 바이트를,
 * 그 외 포맷은 마스킹된 마크다운만 돌려준다 (원본 파일은 수정하지 않음 — warnings 에 명시).
 */
export async function redactDocument(input: ArrayBuffer | Uint8Array, options?: RedactDocumentOptions): Promise<RedactDocumentResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const rules = options?.rules ?? DEFAULT_REDACT_RULES
  const maskChar = options?.maskChar ?? "●"
  const format = await preciseFormat(buffer)

  const parsed = await parse(buffer, options?.filePath ? { filePath: options.filePath } : undefined)
  if (!parsed.success) throw new Error(`파싱 실패: ${parsed.error}`)
  const md = redactMarkdown(parsed.markdown, { rules, maskChar })
  const ctx: ScrubCtx = { rules, maskChar, literals: literalsFromMarkdown(parsed.markdown, md.hits) }
  const base = { format, markdown: md.text, markdownHits: md.hits }

  if (format === "hwpx" || format === "hwp") {
    const scrub = format === "hwpx" ? scrubHwpx : scrubHwp5
    const r = await scrub(bytes, ctx, "mask")
    // 마스킹 결과를 같은 탐지기로 다시 훑는다 — 손대지 못한 파트가 있으면 여기서 드러난다
    const check = await scrub(r.data, ctx, "check")
    const residual = [...check.hits]
    const unscanned = [...r.unscanned]
    // 파서 경로 교차 검증 — 결과 파일을 다시 읽은 본문. 바뀐 게 없으면 원본 본문 그대로라 다시 읽지
    // 않는다 (본문에서 찾은 PII 를 파일에서 하나도 못 가렸다면 여기서 전부 잔존으로 드러난다)
    if (r.data === bytes) residual.push(...markdownLeftovers(parsed.markdown, ctx))
    else {
      const re = await parse(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer)
      if (re.success) residual.push(...markdownLeftovers(re.markdown, ctx))
      else unscanned.push(`결과 파일 재파싱 실패 (${re.error}) — 결과 본문을 검증하지 못했습니다`)
    }
    return {
      ...base,
      data: options?.dryRun ? undefined : r.data,
      changed: r.data !== bytes,
      fileHits: r.hits,
      residual,
      unscanned,
      warnings: r.warnings,
    }
  }

  const warnings = [
    `${format} 원본 파일은 수정하지 않습니다 — 마스킹된 마크다운만 만듭니다. 원본의 텍스트 레이어·이미지·메타데이터에는 PII 가 그대로 남습니다.`,
  ]
  if (format === "pdf") warnings.push("PDF 를 공개하려면 PDF 편집기의 가림(redaction) 기능으로 텍스트를 실제로 지우거나, 마스킹된 마크다운으로 새 문서를 만드세요.")
  return { ...base, changed: false, fileHits: [], residual: markdownLeftovers(md.text, ctx), unscanned: [], warnings }
}

/** 마스킹 결과 본문에 남은 PII — 탐지 룰 + 원본 본문에서 찾은 값(리터럴) 그대로 */
function markdownLeftovers(markdown: string, ctx: ScrubCtx): RedactFileHit[] {
  const out: RedactFileHit[] = redactMarkdown(markdown, { rules: ctx.rules, maskChar: ctx.maskChar }).hits
    .map((h) => ({ rule: h.rule, masked: h.masked, part: "(결과 본문 재파싱)", where: "body" as const }))
  for (const { lit } of findLiterals(normalizeForDetect(markdown), ctx.literals)) {
    if (!out.some((h) => h.masked === lit.masked)) out.push({ rule: lit.rule, masked: lit.masked, part: "(결과 본문 재파싱)", where: "body" })
  }
  return out
}
