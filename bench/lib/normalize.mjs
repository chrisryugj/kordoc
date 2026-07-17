// 정규화 — 채점 전 양쪽(참조/출력)에 동일 적용. 비대칭 정규화 금지 (pitfall #9).
//
// normText: 사람이 읽을 수 있는 형태 유지 (공백 1칸으로 붕괴) — 셀 내용 NED·스니펫용
// normKey : normText에서 공백 전부 제거 — 정렬(align) 매칭 키.
//           공백 제거 이유: 파서의 균등배분 결합("현 장" → "현장"), lineBreak 무공백 연결,
//           탭/전각공백 변환 차이를 전부 흡수. 양쪽 동일 적용이라 가짜 일치 위험은
//           유닛 경계에 한정되며 무시 가능 수준.

/** 마크다운 이스케이프 역변환 (\| \* \~ \[ 등) */
export function unescapeMd(s) {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
}

// ─── 한컴 PUA → 표준 유니코드 매핑 (파서 정책 미러 — whitelist: pua-map) ───
// 파서는 src/shared/pua.ts(mapPuaText, rhwp 시각 검증 테이블)로 PUA 글머리표를 매핑해
// 출력한다. 참조 텍스트에도 동일 매핑을 적용해야 정규화가 대칭이 된다 (pitfall #9).
// 데이터 출처: rhwp paragraph_layout.rs map_pua_bullet_char (MIT) — 코드 공유가 아닌
// 동일한 외부 검증 데이터의 미러. 매핑 없는 BMP PUA는 원본 유지(한양PUA 옛한글 가능성).
const PUA_BMP = {
  0x6c: "●", 0x6d: "●", 0x6e: "■", 0x6f: "□", 0x70: "□", 0x71: "□", 0x72: "□",
  0x73: "⬧", 0x74: "⧫", 0x75: "◆", 0x76: "❖", 0x77: "⬥",
  0x9e: "·", 0x9f: "•", 0xa0: "·", 0xa1: "⚪", 0xa2: "○", 0xa3: "○", 0xa4: "◉",
  0xa5: "◎", 0xa7: "▪", 0xa8: "◻", 0xaa: "✦", 0xab: "★", 0xac: "✶", 0xad: "✴", 0xae: "✹",
  0x45: "☜", 0x46: "☞", 0x47: "☝", 0x48: "☟",
  0xfb: "✗", 0xfc: "✔", 0xfd: "☒", 0xfe: "☑",
  0xe8: "➔", 0xef: "⇦", 0xf0: "⇨", 0xf1: "⇧", 0xf2: "⇩",
  0x22: "✂", 0x36: "⌛", 0x4a: "☺", 0x4e: "☠", 0x52: "☼", 0x54: "❄", 0x58: "✠", 0x59: "✡",
}
const PUA_SUPP = {
  0xf003b: "↓", 0xf02ef: "·", 0xf0854: "《", 0xf0855: "》",
  0xf00da: "▸", 0xf080f: "━", 0xf0827: "■",
}

function mapPua(s) {
  if (!/[\uF020-\uF0FF\u{F0000}-\u{F09FF}]/u.test(s)) return s
  let out = ""
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (code >= 0xf020 && code <= 0xf0ff) out += PUA_BMP[code - 0xf000] ?? ch
    else if (code >= 0xf0000 && code <= 0xf09ff) out += PUA_SUPP[code] ?? ch
    else out += ch
  }
  return out
}

const ZERO_WIDTH_RE = /[\u200B-\u200F\u2028\u2029\u2060\uFEFF\u00AD\x00-\x08\x0B\x0C\x0E-\x1F]/g
const SPACE_RE = /[\s\u00A0\u3000]+/g

export function normText(s) {
  if (!s) return ""
  return mapPua(s)
    .normalize("NFC")
    // 매핑 안 된 Supplementary PUA — 파서가 의도 제거 (builder sanitizeText와 대칭)
    .replace(/[\u{F0000}-\u{FFFFD}]/gu, "")
    // zero-width, BOM, soft hyphen, 제어문자(\x1F 리더탭 마커 포함; \n \t는 아래 공백 처리)
    .replace(ZERO_WIDTH_RE, "")
    // 모든 공백류(전각공백 U+3000, NBSP 포함) → 단일 공백
    .replace(SPACE_RE, " ")
    .trim()
}

export function normKey(s) {
  return normText(s).replace(/ /g, "")
}

/**
 * kordoc 마크다운 → 본문 평문.
 * 마크다운 문법 토큰과 "의도적 아티팩트"(중첩표 마커, 이미지 참조)를 제거하고
 * 수식 $...$ 블록은 개수만 센 뒤 제거(presence 채점 분리 — pitfall #5).
 */
export function mdToPlain(md) {
  let eqCount = 0
  let footnoteCount = 0
  let s = md ?? ""

  // 이미지 참조 ![image](file) — GFM 표 셀/본문 인라인 (whitelist: img-inline)
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
  // HTML 표 셀 내 인라인 이미지 <img src="..." alt="image"> — v3.0 (whitelist: img-inline)
  s = s.replace(/<img\b[^>]*>/gi, " ")
  // 의도적 아티팩트: 중첩 테이블 마커, 누락 이미지 플레이스홀더
  s = s.replace(/\[중첩 테이블[^\]\n]*\]/g, " ")
  s = s.replace(/\[이미지:[^\]\n]*\]/g, " ")

  // 수식: $$...$$ → $...$ 순서로 카운트 후 제거
  s = s.replace(/\$\$[^$]+\$\$/g, () => { eqCount++; return " " })
  s = s.replace(/(^|[^\\$])\$(?!\s)((?:\\.|[^$\n])+?)\$/g, (_m, pre) => { eqCount++; return pre + " " })

  // 각주 인라인 "(주: ...)" — 개수만 셈 (텍스트는 본문에 남겨 recall 매칭 가능하게)
  footnoteCount = (s.match(/\(주: /g) ?? []).length
  s = s.replace(/\(주: /g, " (")

  // 굵게/기울임 bare 별표 제거 (v4.0.5 외래 볼드 일반화 대응) — GFM 본문·셀은
  // escapeGfm이 리터럴 별표를 전부 \*로 이스케이프하므로, 이스케이프 안 된 별표는
  // 파서가 방출한 강조 마커뿐이다. 마커가 단어 중간에 오면 normKey에 별표가 끼어
  // GT 부분 문자열 매칭이 조각나므로(거짓 recall 감점) 제거가 대칭이다. 단 HTML
  // 병합표 셀 라인(<td>/<th>)은 이스케이프 없이 원문을 방출하고 span 마커도 없는
  // 경로라, 그 라인의 bare 별표는 전부 리터럴 마스킹('******' 결재문서) — 제외한다.
  // 중첩표 셀은 </table> 뒤 같은 라인에 후행 문단이 이어지므로 표 태그 계열 전부가
  // 지문이다. 반드시 HTML 태그 제거보다 먼저 (라인의 태그 지문이 판별 근거).
  s = s.split("\n").map((line) =>
    /<\/?(?:table|thead|tbody|tr|td|th)\b/i.test(line)
      ? line
      : line.replace(/\\\*/g, "\x02").replace(/\*/g, "").replace(/\x02/g, "\\*"),
  ).join("\n")

  // HTML 테이블 태그(병합표 출력) + <br>
  s = s.replace(/<\/?(?:table|thead|tbody|tr|td|th)\b[^>]*>/gi, " ")
  s = s.replace(/<br\s*\/?>/gi, "\n")

  // 표 구분행 | --- | --- |
  s = s.replace(/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, " ")
  // 링크 [text](url) → text — kordoc이 생성하는 스킴(sanitizeHref)만.
  // 본문 평문에 우연히 [라벨](식별자) 꼴이 있으면 (예: "[국민신문고](SPP-...)")
  // 링크가 아니므로 보존해야 한다. anchor에서 '['도 제외 — 리터럴 대괄호 안 링크
  // ("…한다[참고 문헌 [67](#ref) 참조]")에서 바깥 '['를 링크 시작으로 오인하면
  // 괄호 위치가 뒤틀려 GT와 1자 어긋난다.
  s = s.replace(/\[([^\[\]]*)\]\((?:https?:|mailto:|tel:|#)[^)\s]*\)/gi, "$1")
  // 파이프 (이스케이프 \| 보호)
  s = s.replace(/\\\|/g, "\x01").replace(/\|/g, " ").replace(/\x01/g, "|")
  // 헤딩 prefix, 수평선
  s = s.replace(/^#{1,6}\s+/gm, "")
  s = s.replace(/^\s*---\s*$/gm, " ")
  // 마크다운 이스케이프 역변환
  s = unescapeMd(s)

  return { text: s, eqCount, footnoteCount }
}

/** PDF 추출 텍스트 공통 정규화 — 리거처 분해 + 하이픈 줄바꿈 결합 + normKey + 리더 도트 붕괴 */
export function normPdf(s) {
  if (!s) return ""
  return normKey(
    s
      .replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/ﬀ/g, "ff")
      .replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl")
      .replace(/(\S)-[ \t]*\n[ \t]*(?=[a-z가-힣])/g, "$1")
  )
    // 목차 리더 점선(····· / .....)은 시각 필러 — 추출기마다 도트 개수가 달라
    // 커버리지를 왜곡하므로 런을 '·' 1개로 붕괴. 참조/출력 동일 경로라 대칭 (pitfall #9).
    // ASCII '.'은 3개+만 (소수점 보호), 가운뎃점/말줄임 계열은 2개+.
    .replace(/[.．·‧‥…⋯]{3,}/g, "·")
    .replace(/[·‧‥…⋯]{2,}/g, "·")
    // 파이프 — mdToPlain이 GFM 표 문법 때문에 |를 공백화하므로(본문 수식 "=1|f" 등)
    // 참조 쪽도 제거해야 대칭 (양쪽 동일 경로)
    .replace(/\|/g, "")
}
