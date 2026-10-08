/**
 * 생성형 AI 채팅창에서 붙여 넣은 원고의 흔적 정리 — 보이지 않는 글자·인용 표시·이스케이프된 굵게가 HWPX 본문까지
 * 그대로 들어갔다(제목 끝 \u200b, "【4:0†source】", "\*\*강조\*\*" 가 글자 "**" 로 남음).
 * 정상 원고를 망치지 않게 흔적임이 분명한 꼴만 지운다: 인용 표시는 † 가 든 것만(【붙임】 같은 괄호는 남김), 굵게는 양쪽이
 * 다 이스케이프된 짝만(일부러 쓴 "\*" 는 남김). 숫자 각주 "[1]" 은 지우지 않는다 — kordoc 이 파싱한 실문서 마크다운
 * 3,865건 가운데 454줄에 정상 내용으로 있어, 파싱 → 편집 → generate 흐름에서 본문을 지운다. 코드 펜스 안은 건드리지 않는다.
 * 착안: hwp-auto-docfit pasted_text.py (MIT, THIRD_PARTY/hwp-auto-docfit.LICENSE)
 */

/** 폭 없는 공백·단어 결합 방지·BOM — 결합 이모지를 잇는 ZWJ(\u200d)는 남긴다 */
const INVISIBLE = /[\u200b\u200c\u2060\ufeff]/g
/** 앞 구간은 † 를 먹지 않는다 — 두 구간이 모두 † 를 먹으면 닫는 】 없는 줄에서 다항 폭주(5만 자 40초) */
const CITATION_TAG = /[ \t]?【[^【】†\n]*†[^【】\n]*】/g
/** 별표 런의 일부가 아니고(앞뒤에 별표가 이어지지 않음) 안쪽에 백슬래시·태그가 없는 짝만 — 개인정보 마스킹 별표 런
 *  ("\*\*\*\*\*\*", 칸 안 줄바꿈이 낀 "\*\*\*<br>\*\*")은 굵게가 아니다(kordoc 파싱 결과가 별표를 이렇게 이스케이프해 낸다) */
const ESCAPED_BOLD = /(?<![\\*])\\\*\\\*(?=[^\s\\*<])([^\\\n<]+?)(?<=[^\s\\*>])\\\*\\\*(?!\\\*)/g

/** 정리한 원고와 지운 흔적 수 */
export function cleanPastedMarkdown(md: string): { md: string; removed: number } {
  let removed = 0
  let fence: string | null = null
  const count = (re: RegExp, s: string, to: string | ((...a: string[]) => string)): string =>
    s.replace(re, (...a: string[]) => { removed++; return typeof to === "string" ? to : to(...a) })
  const lines = md.split("\n").map(line => {
    const f = line.match(/^\s*(```+|~~~+)/)
    if (f) { fence = fence === null ? f[1][0] : fence === f[1][0] ? null : fence; return line }
    if (fence !== null) return line
    // NBSP(\u00a0)는 그대로 — 묶음 빈칸으로 일부러 쓴 글자다(gongmun-typo bindSpaces 가 내는 것과 같다)
    let out = count(INVISIBLE, line, "")
    out = count(CITATION_TAG, out, "")
    return count(ESCAPED_BOLD, out, (_m, inner) => `**${inner}**`)
  })
  return { md: lines.join("\n"), removed }
}
