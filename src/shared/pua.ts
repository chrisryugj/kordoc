/**
 * 한컴 PUA(Private Use Area) 문자 → 유니코드 표준 문자 매핑.
 *
 * 한글(HWP)은 글머리표·문자표 기호를 Symbol/Wingdings 계열 PUA 코드포인트
 * (U+F020~U+F0FF)와 한컴 자체 Supplementary PUA-A 영역(U+F0000대)에 저장한다.
 * 매핑 없이 마크다운에 내보내면 빈 네모로 깨진다.
 *
 * 매핑 출처: rhwp (MIT, https://github.com/edwardkim/rhwp)
 * paragraph_layout.rs map_pua_bullet_char — 한컴 PDF 정답지 시각 검증 테이블.
 */

/** BMP Symbol 영역 (U+F020~U+F0FF) 매핑 — 키는 (code - 0xF000) */
const BMP_SYMBOL_MAP: Record<number, string> = {
  // 도형/기호
  0x6c: "●", // ●
  0x6d: "●", // ● (그림자 원 근사)
  0x6e: "■", // ■
  0x6f: "□", // □
  0x70: "□", // □ (굵은 흰 사각 근사)
  0x71: "□", // □ (그림자 근사)
  0x72: "□", // □ (그림자 근사)
  0x73: "⬧", // ⬧
  0x74: "⧫", // ⧫
  0x75: "◆", // ◆
  0x76: "❖", // ❖
  0x77: "⬥", // ⬥
  // 체크/별/점
  0x9e: "·", // ·
  0x9f: "•", // •
  0xa0: "·", // · (한컴 PDF 정답지 정합 — ▪ 아님)
  0xa1: "⚪", // ⚪
  0xa2: "○", // ○
  0xa3: "○", // ○
  0xa4: "◉", // ◉
  0xa5: "◎", // ◎
  0xa7: "▪", // ▪
  0xa8: "◻", // ◻
  0xaa: "✦", // ✦
  0xab: "★", // ★
  0xac: "✶", // ✶
  0xad: "✴", // ✴
  0xae: "✹", // ✹
  // 손 모양
  0x45: "☜", // ☜
  0x46: "☞", // ☞
  0x47: "☝", // ☝
  0x48: "☟", // ☟
  // 체크마크
  0xfb: "✗", // ✗
  0xfc: "✔", // ✔
  0xfd: "☒", // ☒
  0xfe: "☑", // ☑
  // 화살표
  0xe8: "➔", // ➔ (heavy wide-headed — 한컴 PDF 정답지 정합)
  0xef: "⇦", // ⇦
  0xf0: "⇨", // ⇨
  0xf1: "⇧", // ⇧
  0xf2: "⇩", // ⇩
  // 기타
  0x22: "✂", // ✂
  0x36: "⌛", // ⌛
  0x4a: "☺", // ☺
  0x4e: "☠", // ☠
  0x52: "☼", // ☼
  0x54: "❄", // ❄
  0x58: "✠", // ✠
  0x59: "✡", // ✡
}

/** Supplementary PUA-A (U+F0000대) — 한컴 자체 영역 매핑.
 *  매핑 없는 코드는 호출부가 **삭제**하므로(sanitizeText) 누락은 곧 글자 증발이다.
 *  범위 추정으로 채우지 말 것 — PUA는 글꼴별 사적 영역이라 한컴 PDF 대조로 확인된 것만 넣는다. */
const SUPPLEMENTARY_MAP: Record<number, string> = {
  0xf003b: "↓", // ↓
  0xf02ef: "·", // ·
  0xf0854: "《", // 《
  0xf0855: "》", // 》
  0xf00da: "▸", // ▸
  0xf080f: "━", // ━
  0xf0827: "■", // ■
  0xf03c5: "□", // □ 글머리 — HWP3→HWP5 한컴 변환본 보존 코드, 한컴오피스 표시값 (rhwp #1105)
  // 아래 5종 — rhwp 44cabad9 verified_hancom_pua 표 (한컴 PDF 대조 확정)
  0xf012b: "(인)", // 결재·서명란
  0xf02fc: "►", // 2025 행정업무운영 편람 callout 글머리
  0xf031c: "■", // 2025 행정업무운영 편람 목차 글머리
  0xf03a0: "↵", // 하이퍼텍스트 안내문의 Enter 키 픽토그램
  // 머리말 회사명 6자 (HWP3 johab 0x37C0~0x37C5의 HWP5/HWPX 변환본 대응 코드)
  0xf03ef: "한",
  0xf03f0: "글",
  0xf03f1: "과",
  0xf03f2: "컴",
  0xf03f3: "퓨",
  0xf03f4: "터",
  // 아래는 rhwp VERIFIED_HANCOM_PUA_DISPLAY(한컴 PDF 대조 확정표)에서 kordoc 에만
  // 빠져 있던 항목. 매핑이 없으면 sanitizeText 가 지워 글자가 사라진다 —
  // hwp3-sample11 한 문서에서만 괘선 조각·원문자 57자가 그렇게 증발했다.
  0xf0090: "✺", // 물방울 asterisk 글머리
  0xf0288: "⓪", // 별도 글리프 원숫자 — ③(F028B)는 근거 문서가 리터럴을 써 rhwp 표에도 없다
  0xf0289: "①",
  0xf028a: "②",
  0xf028c: "④",
  0xf028d: "⑤",
  0xf028e: "⑥",
  0xf028f: "⑦",
  0xf0290: "⑧",
  0xf0291: "⑨",
  0xf02ec: "◇", // 작은 빈 마름모 글머리
  0xf02fb: "▸", // 중첩 표 글머리
  0xf03a7: "⊟", // 둥근 네모 안 −
  0xf03a8: "⊞", // 둥근 네모 안 +
  0xf03da: "□", // 둥근 모서리 빈 네모 글머리
  0xf03ff: "□", // 표 셀 제목 빈 네모 글머리
  0xf0806: "┌", // 텍스트 다이어그램 괘선 조각
  0xf0807: "┬",
  0xf0808: "┐",
  0xf080c: "└",
  0xf080e: "┘",
  0xf0810: "│",
  0xf081c: "┈", // 점선 괘선 조각
  0xf0832: "═", // 이중 가로 괘선 조각
  0xf0848: "━", // 굵은 가로 막대 글머리
}

/** 사각 안 숫자 ①~⑳ (U+F02B1~F02C4) — 한컴 전용 글리프.
 *  렌더는 사각 글리프를 위해 원문 유지가 맞지만, 마크다운은 폰트 없는 소비자(RAG·grep)가
 *  읽으므로 둘러싸인 숫자로 옮긴다 (rhwp b74b5098 / #3385 — 실문서에서 5건 유출 확인). */
const BOXED_NUMBER_START = 0xf02b1
const BOXED_NUMBER_END = 0xf02c4

/** 단일 코드포인트 매핑 — 매핑 없으면 원본 유지 */
function mapPuaChar(code: number): string | undefined {
  if (code >= 0xf020 && code <= 0xf0ff) {
    return BMP_SYMBOL_MAP[code - 0xf000]
  }
  if (code >= BOXED_NUMBER_START && code <= BOXED_NUMBER_END) {
    return String.fromCodePoint(0x2460 + (code - BOXED_NUMBER_START))
  }
  if (code >= 0xf0000 && code <= 0xf09ff) {
    return SUPPLEMENTARY_MAP[code]
  }
  return undefined
}

/**
 * 문자열 내 한컴 PUA 문자를 표준 유니코드로 치환.
 * 매핑 없는 BMP PUA는 원본 유지(옛한글 한양PUA 가능성 — 제거하면 안 됨),
 * 매핑 없는 Supplementary PUA-A는 호출부의 기존 제거 로직에 위임한다.
 */
export function mapPuaText(text: string): string {
  let out = ""
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    out += mapPuaChar(code) ?? ch
  }
  return out
}
