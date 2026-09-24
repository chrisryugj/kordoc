/**
 * PDF 페이지별 텍스트 품질 신호 수집.
 *
 * pdfjs가 텍스트층을 추출했더라도, 폰트의 ToUnicode/CMap이 불완전하면
 * 한글이 PUA(Private Use Area) 글리프 코드로 그대로 떨어진다. 또 일부 PDF는
 * NUL/제어문자가 본문에 섞여 있다. 본 모듈은 그런 신호를 페이지 단위로 수집해
 * "OCR 검토 필요" 판정에 사용한다.
 *
 * 더 까다로운 케이스: ToUnicode가 "잘못" 매핑되면 글리프가 PUA/FFFD가 아니라
 * 정상 한글 음절 영역(0xAC00-0xD7A3)의 엉뚱한 글자로 떨어진다("GPU쭒컫 많핂슪").
 * 이건 PUA/제어/대체문자 신호로 못 잡는다. 대신 자소를 분해해 종성(받침) 분포를
 * 본다 — CID 스크램블은 받침을 균등하게 흩뿌리므로, 자연 한국어(받침없음 다수 +
 * 겹받침 희소)와 통계적으로 갈린다. 이것이 garbled_hangul 신호다.
 *
 * 텍스트층 밖 신호 하나: 글자를 채운 곡선 경로로 그린 쪽(vector-glyphs.ts 가 연산자 목록 기하로 센 글자 수를
 * 받는다). 텍스트층에는 ASCII 몇 자만 남아 위 신호로는 멀쩡해 보인다. 이것이 vector_text 신호다.
 */

export interface PageQuality {
  /** 1-based 페이지 번호 */
  page: number
  /** 공백 제외 문자 수 */
  textChars: number
  /** 한글 음절(0xAC00-0xD7A3) 비율 (0~1) */
  hangulRatio: number
  /** C0/C1 제어문자 비율 (tab/newline/CR 제외) */
  controlCharRatio: number
  /** U+FFFD replacement character 비율 */
  replacementCharRatio: number
  /** PUA 비율 — 글꼴 매핑 실패의 핵심 신호 */
  puaRatio: number
  /** 한글 음절 중 받침 없는 음절 비율 (자연 한국어 ~0.5, mojibake ~0.04) */
  hangulNoBatchimRatio: number
  /** 한글 음절 중 겹받침/희귀 받침 비율 (자연 한국어 <0.06, mojibake ~0.5) */
  hangulRareBatchimRatio: number
  /** OCR 검토 권장 여부 (pdfjs 텍스트층 기준 원신호 — OCR 적용 후에도 보존) */
  needsOcr: boolean
  /** needsOcr=true일 때 사유 (단일 신호로 충분, 가장 강한 신호 선택) */
  ocrReason?: "vector_text" | "low_text" | "high_pua" | "high_control" | "high_replacement" | "garbled_hangul"
  /** 이 페이지에 OCR 이 실제 적용되어 본문이 OCR 결과로 대체됨 */
  ocrApplied?: boolean
}

/**
 * 희귀 종성(받침) 인덱스 집합. 종성 인덱스 = (code - 0xAC00) % 28,
 * 0 = 받침 없음. 겹받침(ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄ) + 거의 안 쓰는 홑받침(ㅋㅌㅍ).
 * 자연 한국어에서 이들의 합산 비율은 매우 낮다(<6%).
 */
const RARE_JONG = new Set<number>([3, 5, 6, 9, 10, 11, 12, 13, 14, 15, 18, 24, 25, 26])

/** garbled_hangul 판정 최소 한글 음절 수 — 통계적 유의성 확보 */
const MOJIBAKE_MIN_HANGUL = 30
/** 받침 없는 음절 비율이 이 값 미만이면 비정상 (자연 한국어는 훨씬 높음) */
const MOJIBAKE_MAX_NOBATCHIM = 0.15
/** 희귀 받침 비율이 이 값 이상이면 비정상 (자연 한국어는 훨씬 낮음) */
const MOJIBAKE_MIN_RAREBATCHIM = 0.25

/**
 * vector_text 하한: 텍스트층 밖 곡선 글자(vector-glyphs.ts 글줄다운 조각의 글자 수). 코퍼스 비-cairo 표지 로고 곡선
 * 글자는 34개 이하(국가교통통계 표지 로고 3개 34·기록물관리 지침 표지 30)라 못 넘고, 글줄 몇 개면 넘는다
 */
const VECTOR_TEXT_MIN_GLYPHS = 40
/**
 * 곡선 글자가 쪽 글자(곡선 + 텍스트층)에서 차지할 최소 비율 — 텍스트층 글이 대부분인 쪽(차트 라벨만 곡선인 보도자료
 * 안내서 62/434 = 0.14)을 OCR 로 갈아엎지 않는다. 대가: 텍스트층 ASCII 가 대부분인 cairo 숫자 칸 표 쪽(632 + 곡선 65 =
 * 0.09)과, 한글 대부분이 텍스트층에 있고 일부만 곡선인 cairo 쪽(0.10~0.24)은 OCR 대상이 아니다
 */
const VECTOR_TEXT_MIN_SHARE = 0.25

/** 페이지 텍스트에서 품질 메트릭을 계산한다. vectorGlyphs 는 텍스트층 밖 곡선 글자 수 (vector-glyphs.ts) */
export function computePageQuality(page: number, text: string, vectorGlyphs = 0): PageQuality {
  let total = 0
  let hangul = 0
  let hangulNoBatchim = 0
  let hangulRareBatchim = 0
  let control = 0
  let replacement = 0
  let pua = 0

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // 공백류는 분모에서 제외
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue
    total++

    // C0 제어문자 (0x00-0x1F 중 tab/lf/cr 제외) + DEL(0x7F) + C1(0x80-0x9F)
    if ((code < 0x20) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      control++
      continue
    }
    if (code === 0xfffd) {
      replacement++
      continue
    }
    // 한글 음절 — 종성(받침) 분포로 mojibake 판정
    if (code >= 0xac00 && code <= 0xd7a3) {
      hangul++
      const jong = (code - 0xac00) % 28
      if (jong === 0) hangulNoBatchim++
      else if (RARE_JONG.has(jong)) hangulRareBatchim++
      continue
    }
    // PUA: BMP(E000-F8FF) + SPUA-A(F0000-FFFFD) + SPUA-B(100000-10FFFD)
    // 서로게이트 페어는 high만 검사해도 충분 (Plane 15/16 high surrogate 범위 DB80-DBFF)
    if ((code >= 0xe000 && code <= 0xf8ff) || (code >= 0xdb80 && code <= 0xdbff)) {
      pua++
      continue
    }
  }

  const denom = total || 1
  const puaRatio = pua / denom
  const controlCharRatio = control / denom
  const replacementCharRatio = replacement / denom
  const hangulNoBatchimRatio = hangul > 0 ? hangulNoBatchim / hangul : 0
  const hangulRareBatchimRatio = hangul > 0 ? hangulRareBatchim / hangul : 0

  // 받침 분포 이상 = ToUnicode 오매핑 mojibake. 받침없음 희소 + 희귀받침 과다를
  // 둘 다(AND) 만족해야 발화 — 자연 한국어(받침없음 다수)에서 오탐 방지.
  const garbledHangul =
    hangul >= MOJIBAKE_MIN_HANGUL &&
    hangulNoBatchimRatio < MOJIBAKE_MAX_NOBATCHIM &&
    hangulRareBatchimRatio >= MOJIBAKE_MIN_RAREBATCHIM

  let needsOcr = false
  let ocrReason: PageQuality["ocrReason"] | undefined
  // 우선순위: vector_text > low_text > high_pua > high_control > high_replacement > garbled_hangul.
  // vector_text 가 low_text 보다 앞선다 — 텍스트층이 비어도 빈 쪽(표지·간지)이 아니라 글이 곡선으로 가득한 쪽이다
  if (vectorGlyphs >= VECTOR_TEXT_MIN_GLYPHS && vectorGlyphs >= (vectorGlyphs + total) * VECTOR_TEXT_MIN_SHARE) {
    needsOcr = true; ocrReason = "vector_text"
  }
  else if (total < LOW_TEXT_THRESHOLD) { needsOcr = true; ocrReason = "low_text" }
  else if (puaRatio >= HIGH_PUA_THRESHOLD) { needsOcr = true; ocrReason = "high_pua" }
  else if (controlCharRatio >= HIGH_CONTROL_THRESHOLD) { needsOcr = true; ocrReason = "high_control" }
  else if (replacementCharRatio >= HIGH_REPLACEMENT_THRESHOLD) { needsOcr = true; ocrReason = "high_replacement" }
  else if (garbledHangul) { needsOcr = true; ocrReason = "garbled_hangul" }

  return {
    page,
    textChars: total,
    hangulRatio: hangul / denom,
    controlCharRatio,
    replacementCharRatio,
    puaRatio,
    hangulNoBatchimRatio,
    hangulRareBatchimRatio,
    needsOcr,
    ocrReason,
  }
}

/** 페이지별 품질에서 문서 단위 요약을 계산한다. */
export interface DocumentQualitySummary {
  totalPages: number
  totalTextChars: number
  avgHangulRatio: number
  avgControlCharRatio: number
  avgReplacementCharRatio: number
  avgPuaRatio: number
  /** textChars 매우 적은 페이지 수 (이미지/빈 페이지 후보) */
  lowTextPageCount: number
  /** PUA 비율 임계 초과 페이지 수 (글꼴 매핑 깨짐 후보) */
  highPuaPageCount: number
  /** 문서 전체에 OCR 검토가 권장되는지 — needsOcr 페이지 비율 또는 평균 신호 기반 */
  needsOcr: boolean
  /** needsOcr=true인 페이지 번호 목록 */
  ocrCandidatePages: number[]
}

const LOW_TEXT_THRESHOLD = 20
const HIGH_PUA_THRESHOLD = 0.2
const HIGH_CONTROL_THRESHOLD = 0.05
const HIGH_REPLACEMENT_THRESHOLD = 0.05
/** 페이지 중 needsOcr 비율이 이 값 이상이면 문서 전체에 OCR 권장 */
const DOC_NEEDS_OCR_PAGE_RATIO = 0.3

/**
 * 비표시 제어문자를 제거한다. C0(NUL 등, tab/lf/cr 제외) + DEL + C1.
 * PUA는 사용자가 글꼴 매핑 실패를 시각적으로 확인할 수 있도록 보존.
 */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, "")
}

export function summarizeDocumentQuality(pages: PageQuality[]): DocumentQualitySummary {
  if (pages.length === 0) {
    return {
      totalPages: 0,
      totalTextChars: 0,
      avgHangulRatio: 0,
      avgControlCharRatio: 0,
      avgReplacementCharRatio: 0,
      avgPuaRatio: 0,
      lowTextPageCount: 0,
      highPuaPageCount: 0,
      needsOcr: false,
      ocrCandidatePages: [],
    }
  }

  let textChars = 0
  let hangul = 0
  let control = 0
  let replacement = 0
  let pua = 0
  let lowText = 0
  let highPua = 0
  const ocrCandidatePages: number[] = []

  for (const p of pages) {
    textChars += p.textChars
    hangul += p.hangulRatio
    control += p.controlCharRatio
    replacement += p.replacementCharRatio
    pua += p.puaRatio
    if (p.textChars < LOW_TEXT_THRESHOLD) lowText++
    if (p.puaRatio >= HIGH_PUA_THRESHOLD) highPua++
    // OCR 이 이미 적용된 페이지는 후보에서 제외 — "OCR 했는데 또 하라" 자기모순 방지
    if (p.needsOcr && !p.ocrApplied) ocrCandidatePages.push(p.page)
  }

  const n = pages.length
  return {
    totalPages: n,
    totalTextChars: textChars,
    avgHangulRatio: hangul / n,
    avgControlCharRatio: control / n,
    avgReplacementCharRatio: replacement / n,
    avgPuaRatio: pua / n,
    lowTextPageCount: lowText,
    highPuaPageCount: highPua,
    needsOcr: ocrCandidatePages.length / n >= DOC_NEEDS_OCR_PAGE_RATIO,
    ocrCandidatePages,
  }
}
