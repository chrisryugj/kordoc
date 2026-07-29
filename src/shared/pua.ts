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

/** Supplementary PUA-A (U+F0000대) — 한컴 자체 영역 매핑 */
const SUPPLEMENTARY_MAP: Record<number, string> = {
  0xf003b: "↓", // ↓
  0xf02ef: "·", // ·
  0xf0854: "《", // 《
  0xf0855: "》", // 》
  0xf00da: "▸", // ▸
  0xf080f: "━", // ━
  0xf0827: "■", // ■
  0xf03c5: "□", // □ 글머리 — HWP3→HWP5 한컴 변환본 보존 코드, 한컴오피스 표시값 (rhwp #1105)
}

/** 단일 코드포인트 매핑 — 매핑 없으면 원본 유지 */
function mapPuaChar(code: number): string | undefined {
  if (code >= 0xf020 && code <= 0xf0ff) {
    return BMP_SYMBOL_MAP[code - 0xf000]
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
