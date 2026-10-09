/**
 * PDF 줄 꺾임 이음 — 오른끝까지 찬 줄이 다음 줄로 넘어간 자리(자동 꺾임)를 원문 띄어쓰기대로 잇는다.
 *
 * 한컴은 한글 줄나눔 기준이 "글자"인 문단(HWPX breakNonLatinWord=KEEP_WORD — 본문의 80% 넘게 이 설정인 문서가 hwpx↔pdf
 * 424쌍 중 162쌍)을 어절 중간에서도 꺾는다("재⏎일학도의용군인", "공상공무⏎원", "또⏎는"). 텍스트층은 줄 끝 공백 글자를 싣지 않고
 * 양쪽 정렬은 꺾인 자리와 무관하게 줄을 오른끝까지 채우므로 끝 x 로는 못 가른다. 양쪽 정렬이 어절 간격에 나눠 준 여유(slack)도
 * 재 보았으나 글자 모드 문서에서조차 여유 0~1.25em 구간마다 붙음 비율이 0.38~0.55 로 섞여 신호가 못 된다(좌표 정수 반올림·문단별 자간).
 * 가르는 신호는 글 자체에 있다 — hwpx↔pdf 417쌍 꺾임 후보 22,911곳을 HWPX 원문 띄어쓰기로 채점한 실측(2026-09-24):
 *  1. 다음 줄 첫 어절이 조사·어미뿐("는", "을", "에서", "다.") → 앞 어절에 붙는다 (조사 어절 1,580곳 중 잘못 9곳)
 *  2. 앞 줄 끝 어절이 받침에 맞는 조사·어미로 끝난 온전한 어절("…을", "…는", "…히", 받침 뒤 "…이") → 띄운다
 *     (줄 끝 "을" 876곳 중 3·"를" 552곳 중 0·"는" 851곳 중 14 만 어절 중간)
 *  3. 문서 어휘 증거 — 꺾인 자리를 가로지르는 앞뒤 두 글자(없으면 한 글자)가 같은 문서의 줄 안에서 한 어절 안에만 나오면
 *     붙이고(재일학도·공상공무원), 어절 경계를 사이에 두고만 나오면 띄운다 (두 글자 증거 정밀도: 붙음 98.3%·띄움 99.3%).
 *     글자 쌍 증거가 갈리면 이어 붙인 꼴이 줄 안 한 어절로 나왔는지 본다(띄어 쓴 이웃 어절로도 나왔으면 아님, v4.15)
 * 근거가 없으면 띄운다 — 규칙이 모두 비껴간 자리(두 음절+ 조각)는 원문 붙음이 18%(804/4,455)뿐이다. 대부분 명사+명사
 * ("기후⏎위기" 원문 붙음 / "비만⏎치료" 원문 띄움)라 글로도 가를 수 없다. 잘못 붙임과 못 붙임의 어절 F1 비용은 거의 같다
 * (F1=2I/(Na+Nb): 잘못 붙임 −3.05/N, 못 붙임 −2.95/N).
 */

import type { BoundingBox, IRBlock } from "../types.js"

/** 줄 글에서 판정에 방해되는 마크업 — 밑줄·취소선 표시 (page-blocks 가 아이템 글에 감싼 것) */
const MARKUP = /<\/?u>|~~/g
/** 줄마다 감싼 링크 표기 `[글](주소)` (links.ts applyLinkAnnotations) — 판정용 글에선 글만 남긴다 */
const LINK_MARKUP = /(?<!!)\[([^\]\n]*)\]\([^)\s]+\)/g
const bump = <K>(m: Map<K, number>, k: K): void => { m.set(k, (m.get(k) ?? 0) + 1) }
/** 두 글자(UTF-16 단위) → 수 키 — 문자열 키를 만들지 않아 쪽마다 모든 글을 훑는 비용을 줄인다 */
const pairKey = (a: number, b: number): number => a * 0x10000 + b
const bump2 = (m: Map<number, Map<number, number>>, k1: number, k2: number): void => {
  let inner = m.get(k1)
  if (!inner) m.set(k1, (inner = new Map()))
  bump(inner, k2)
}

/**
 * 문서 어휘 증거 — 줄 안 어절에서 모은 이웃 글자 쌍(한 어절 안 = 붙음)과 어절 경계를 사이에 둔 글자 쌍(띄움).
 * 한 글자+한 글자, 두 글자+두 글자 두 벌. 쪽을 처리하기 전에 그 쪽 줄을 더해(addLine) 앞 쪽들과 현재 쪽이 증거가 된다
 * (문서 전체를 먼저 모으는 것 대비 이득의 99% — 순이득 6,998 대 7,083 — 쪽 단위만은 6,567).
 * 줄 끝 어절도 넣는다: 꺾인 조각이어도 그 안의 이웃 글자는 참이고, 꺾인 자리 자체는 한 줄 안에 없다.
 */
export class WrapLexicon {
  private readonly joined1 = new Map<number, number>()
  private readonly joined2 = new Map<number, Map<number, number>>()
  private readonly spaced1 = new Map<number, number>()
  private readonly spaced2 = new Map<number, Map<number, number>>()
  /** 줄 안(줄 첫·끝 어절 제외 — 꺾인 조각일 수 있다) 홀로 선 어절 수 — 한 음절 조각이 낱말("등"·"및"·"그")인지 가른다 */
  private readonly words = new Map<string, number>()
  /** 줄 안에서 이웃한 두 어절("개인정보 처리") — 이어 붙인 꼴 증거(joinedWord)의 거부권 */
  private readonly pairs = new Set<string>()
  /** 줄 안 어절 첫머리 한글(두~여섯 음절) — 꺾인 두 조각이 어절 머리로 이어지나(startsWord) */
  private readonly heads = new Set<string>()
  /** 줄 안 이웃 어절의 앞 어절 한글 꼬리 + 뒤 어절 첫 음절("지식재산 보") — 어절 머리 증거의 거부권 */
  private readonly spacedHeads = new Set<string>()

  /** 줄 글 한 줄을 증거로 더한다 — 탭(큰 갭)으로 나뉜 조각은 다른 칸·단이라 조각 사이는 어절 경계 증거로 쓰지 않는다 */
  addLine(text: string): void {
    for (const seg of text.replace(MARKUP, "").split("\t")) {
      const toks = seg.split(" ").filter(t => t && !t.includes("]("))
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i], n = t.length
        if (i > 0 && i < toks.length - 1) {
          bump(this.words, t)
          const run = t.match(/^[가-힣]+/)?.[0] ?? ""
          for (let j = 2; j <= Math.min(run.length, 6); j++) this.heads.add(run.slice(0, j))
        }
        if (i + 1 < toks.length) {
          this.pairs.add(t + " " + toks[i + 1])
          const tail = t.match(/[가-힣]+$/)?.[0]
          if (tail) this.spacedHeads.add(tail + " " + toks[i + 1].charAt(0))
        }
        for (let a = 0; a + 1 < n; a++) {
          const c1 = t.charCodeAt(a), c2 = t.charCodeAt(a + 1)
          bump(this.joined1, pairKey(c1, c2))
          if (a >= 1 && a + 2 < n) bump2(this.joined2, pairKey(t.charCodeAt(a - 1), c1), pairKey(c2, t.charCodeAt(a + 2)))
        }
        if (i + 1 < toks.length) {
          const u = toks[i + 1]
          bump(this.spaced1, pairKey(t.charCodeAt(n - 1), u.charCodeAt(0)))
          if (n >= 2 && u.length >= 2) bump2(this.spaced2, pairKey(t.charCodeAt(n - 2), t.charCodeAt(n - 1)), pairKey(u.charCodeAt(0), u.charCodeAt(1)))
        }
      }
    }
  }

  /** 문서 줄 안에서 홀로 선 어절로 나온 적 있나 */
  isWord(word: string): boolean {
    return (this.words.get(word) ?? 0) > 0
  }

  /** 꺾인 두 조각을 이어 붙인 꼴이 줄 안 한 어절로 나왔고, 두 조각이 줄 안에서 띄어 쓴 이웃 어절로는 나온 적 없나 */
  joinedWord(left: string, right: string): boolean {
    return this.isWord(left + right) && !this.pairs.has(left + " " + right)
  }

  /** 줄 안 어절이 이 한글로 시작한 적 있나 */
  startsWord(head: string): boolean {
    return this.heads.has(head)
  }

  /** 줄 안에서 이 한글 꼬리로 끝난 어절 뒤에 이 음절로 시작하는 어절을 띄어 쓴 적 있나 */
  spacedHead(tail: string, syllable: string): boolean {
    return this.spacedHeads.has(tail + " " + syllable)
  }

  /** 두 글자+두 글자 증거만 — 한 글자 쌍으로 물러서지 않는다 (표 칸 조각처럼 줄 꺾임이 아닌 자리에 쓸 때) */
  evidence2(left: string, right: string): "" | " " | null {
    const n = left.length
    if (n < 2 || right.length < 2) return null
    const k1 = pairKey(left.charCodeAt(n - 2), left.charCodeAt(n - 1)), k2 = pairKey(right.charCodeAt(0), right.charCodeAt(1))
    return decideCounts(this.joined2.get(k1)?.get(k2) ?? 0, this.spaced2.get(k1)?.get(k2) ?? 0)
  }

  /** 꺾인 자리 증거: "" 붙음 · " " 띄움 · null 모름 (두 글자 증거가 갈리거나 없으면 한 글자) */
  evidence(left: string, right: string): "" | " " | null {
    const n = left.length
    if (n >= 2 && right.length >= 2) {
      const k1 = pairKey(left.charCodeAt(n - 2), left.charCodeAt(n - 1)), k2 = pairKey(right.charCodeAt(0), right.charCodeAt(1))
      const v = decideCounts(this.joined2.get(k1)?.get(k2) ?? 0, this.spaced2.get(k1)?.get(k2) ?? 0)
      if (v !== null) return v
    }
    if (n && right.length) {
      const k = pairKey(left.charCodeAt(n - 1), right.charCodeAt(0))
      return decideCounts(this.joined1.get(k) ?? 0, this.spaced1.get(k) ?? 0)
    }
    return null
  }
}
const decideCounts = (joined: number, spaced: number): "" | " " | null => (joined && !spaced ? "" : spaced && !joined ? " " : null)

const hasBatchim = (c: string): boolean => { const k = c.charCodeAt(0) - 0xac00; return k >= 0 && k < 11172 && k % 28 !== 0 }
/** 한자·가나·CJK 문장부호·전각 꼴 */
const CJK = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/
/** 중·일문 글자 사이 꺾임은 공백 없는 경계다. 한글이 섞인 국한문 어절은 제외한다. */
const unspacedCjkBoundary = (prev: string, next: string): boolean =>
  CJK.test(prev.trimEnd().slice(-1)) && CJK.test(next.trimStart().charAt(0)) && !/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(prev + next)
const CLOSE_TAIL = /[’”」』)\]〉》>]+$/
const TAIL = "[.,)」』’”]*"
/** 어절 첫머리에 오지 않는 조사·어미 — 다음 줄 첫 어절이 이것뿐이면 앞 어절의 꼬리다 ("다." 는 줄을 넘어온 문장 끝).
 *  겹조사("수준⏎에서도", "신고자⏎에게는", "자문단원들⏎께서", "가입⏎보다도")와 계사 "이다·이며·이나…"(모음 뒤 "구조⏎이나", "자료⏎이다.")도
 *  홀로 서는 낱말이 없다 — 보도자료 100쌍 출력 판정에서 기본 띄움이 틀린 135곳 중 15곳, 원문 띄움 0곳 */
const PARTICLE = new RegExp(`^(?:다\\.|의|에|에서|에는|에게|에도|에서는|까지|부터|처럼|마다|만|도|들|들이|들의|들은|들을|들에게|서는|서도|라고|라며|은|는|을|를|으로|로|으로서|로서|으로써|로써` +
  `|에서도|에서의|에서만|에서부터|에만|에의|에게는|에게도|께서|께서는|께서도|으로는|로는|으로도|로도|으로부터|로부터|부터는|까지는|까지도|보다도|라도|이라도` +
  `|들과|들과의|들로|들도|들에|들에서|들만|이다|이며|이나|이라는|이라고|이라며|인데|이므로|이지만|이면서)${TAIL}$`)
/** 받침 뒤에서만 조사 — "이"(관형사)·"과"(부서명)는 홀로 설 수 있어 앞 음절 받침으로 가린다 */
const PARTICLE_AFTER_CONS = new RegExp(`^(?:이|과|과의|이고|인|인지|임|임을|임에도|이어야)${TAIL}$`)
const PARTICLE_AFTER_VOWEL = new RegExp(`^(?:가|와|와의|라는)${TAIL}$`)
const ENDING = new RegExp(`^(?:어야|아야|여야|므로|으므로|지만|면서|으면서|으며|거나|더라도|든지|었다|았다|였다|었으며|았으며|였으며|었고|았고|였고|였던|겠다|겠고|겠으며|습니다|니다|니까)${TAIL}$`)
const ADNOMINAL_HAN = new RegExp(`^한${TAIL}$`)
const SUFFIX_JEOK = new RegExp(`^적(?:인|으로|이다|이며|이고|임|인데|이라|이지만|으로서)${TAIL}$`)
/** 줄 머리로 넘어온 접미사 — -화 하다·되다 활용("구체⏎화할"), 홀로 서지 않는 -량·-률(율)·-성 + 조사("수확⏎량을", "정확⏎성을";
 *  "성과"는 낱말이라 -성 뒤 "과"는 뺀다) */
const SUFFIX_NOUN = new RegExp(`^(?:화(?:하|한|할|함|했|해|된|되|됨|돼|됐)[가-힣]*|[량률율](?:을|이|은|의|에|도|과|으로|이다)|성(?:을|이|은|의|에|도|으로|이다))${TAIL}$`)
/** 줄 끝 한 음절 + 다음 줄 머리로 갈린 조사 (에|서, 이|나) */
const SPLIT_PARTICLE: [string, RegExp][] = [["에", new RegExp(`^서(?:는|도|의|부터|만)?${TAIL}$`)], ["이", new RegExp(`^나${TAIL}$`)]]
/** 하다·되다 활용 — 명사 뒤면 접미사(달성⏎하였으며). -야·-도록·-으로·-게 따위 뒤는 보조 용언이라 띄어 쓴다
 *  (다음 줄 "하고" 101곳 중 23·"하며" 28곳 중 20 이 원문 띄움 — "해야⏎하며", "원칙으로⏎하고"). "하나·한국·해외"처럼
 *  하/한/해로 시작하는 낱말이 있어 활용 꼴을 낱낱이 든다 */
const VERB_FORM = new RegExp(`^(?:하는|하여|하고|하며|하였다|하였으며|하였고|하였다고|했다|했으며|했고|했다고|했다며|한다|한다고|한다며|한다는|할|함|하겠다|하겠다고|하겠습니다|하기로|하면|하면서|하도록|해야|되는|되어|된|된다|된다고|된다는|되었다|되었으며|되었고|됐다|됐으며|되며|되고|되면|됨|돼|하기|하게|하지|하거나|해서|하는데|함으로써|함에|함을|함이|하기에|하기도|되지|되기|되도록|되거나|되면서)${TAIL}$`)
/** 인용 "(이하 …)이라⏎한다" 의 -라 뒤 하다도 보조 용언 (잘못 붙임 3곳↓). -려("하려⏎하거나")·까지("’28.6월까지⏎할") 뒤도 보조 용언.
 *  "지" 는 뺐다 — 명사 끝(유지·방지·금지⏎하기)이 대부분이라 붙여야 맞다(hwpx↔pdf 꺾임 모의 순이득 +3).
 *  록·자·고 는 어미 꼴(-도록·-토록, -고자, 인용 -다고·-라고…)로만 — 명사 끝 "기록⏎하고", "투자⏎하며" 는 붙는다. 인용 따옴표는
 *  걷고 본다("도출하겠다”고⏎하였다"). "도" 는 그대로 — 조사 "나도⏎할" 과 명사 끝 "주도⏎하였다" 를 글로 못 가른다 */
const AUX_BEFORE = /(?:야|도록|토록|로|게|도|히|고자|를|을|면|서|라고|다고|려고|자고|냐고|며|라|려|까지)$/
const auxBefore = (h: string): boolean => AUX_BEFORE.test(h.replace(/[”’"」』“‘]/g, ""))
/** 되다 활용 앞 "…이" 는 주격 조사 — "승인이⏎되며", "3개월이⏎되어" (잘못 붙임 8곳↓·맞는 붙임 손실 0). "…가" 는 "평가⏎되어"(피동
 *  한 낱말)와 겹치고, 하다 활용 앞 "이" 는 "용이⏎하도록" 이 한 낱말이라 넣지 않는다 */
const BECOME = /^[되된됐됨돼]/
/** 홀로 쓰는 한 음절 낱말(기능어·관형사·의존명사 — 닫힌 부류) — 앞 쪽들에 아직 홀로 나온 적 없어도 꺾인 조각으로 보지 않는다
 *  (첫 쪽의 "보전⏎및" 이 "보전및" 로 붙던 것; 이 목록으로 잘못 붙임 85곳↓·맞는 붙임 25곳↓. 시·할·데·뒤·된 — "신청 시⏎제출한",
 *  "…할⏎수 있다", "…하는 데⏎기여", "원인이 된⏎사실" — 를 더해 잘못 붙임 21곳↓·맞는 붙임 1곳↓. "바"는 서식의 "주시기 바⏎랍니다"를
 *  끊어 넣지 않는다) */
const STANDALONE_SYLLABLE = /^(?:및|등|수|것|그|이|저|더|또|각|약|총|중|간|때|뿐|듯|채|전|후|내|외|한|두|세|네|몇|새|첫|온|본|곧|꼭|잘|못|안|좀|늘|다|왜|뭐|시|할|데|뒤|된)$/
/** 날짜로 끝난 줄 — 서식 서명란 "년 월 일⏎신고인 (서명 또는 인)" 의 "일" 은 조각이 아니다(작은 서식 문서는 "일" 이 줄 안에 홀로 선
 *  적이 없어 한 음절 조각으로 붙던 것). 다음 줄이 괄호면 "7월 28일⏎(목)부터" 처럼 붙는 글이라 뺀다 (hwpx↔pdf 판정 변화 0) */
const DATE_DAY_END = /(?:^|\s)\d*월\s+\d*일$/
/** 수 뒤 단위 — "위원 2⏎명을", "월의 1⏎일부터" */
const COUNTER = /^(?:명|일|월|년|개|원|건|회|차|호|조|항|층|톤|대|곳|시|분|초|배|위|점|주|종|억|만|천|%|퍼센트)/

/** 조사·어미로 끝난 온전한 어절 (두 음절 이상) — 줄 끝이 이러면 꺾인 자리는 어절 경계다 */
function endsAsWord(word: string): boolean {
  const h = word.replace(CLOSE_TAIL, "")
  if (!/^[가-힣]{2,}$/.test(h)) return false
  if (/(?:을|를|는|은|히|른|할|야|게|의)$/.test(h)) return true
  const prev = h[h.length - 2]
  if (/(?:이|과)$/.test(h)) return hasBatchim(prev)
  if (/(?:가|와)$/.test(h)) return !hasBatchim(prev)
  return false
}

/** 다음 줄 첫 어절이 앞 어절에 붙는 조사·어미인가 — 숫자·영문 뒤도 조사는 붙는다(제7조의9⏎에), 받침으로 가리는 조사만 한글 뒤 */
function particleContinues(left: string, rightWord: string): boolean {
  // 닫는 따옴표 뒤는 인용 조사("…하겠다”라고")라 그 앞까지만 본다
  const right = rightWord.replace(/[”’"」』].+$/, "")
  const h = left.replace(CLOSE_TAIL, "")
  const last = h[h.length - 1]
  if (!last || !/[가-힣A-Za-z0-9]/.test(last)) return false
  if (PARTICLE.test(right)) return true
  if (!/[가-힣]/.test(last)) return false
  // 접미사 -적 이 줄 머리로 넘어온 것 — "자체⏎적으로", "근본⏎적인" ("적은·적게"(적다)는 제외)
  if (SUFFIX_JEOK.test(right) || (h.length >= 2 && SUFFIX_NOUN.test(right))) return true
  // 어절 머리에 못 오는 어미 — "갖추⏎어야", "가지⏎므로"
  if (ENDING.test(right)) return true
  // 줄을 넘어온 문장 끝 — "…만족해야 한⏎다;<개정 2008. 9. 8>" (문장 부호 뒤에 붙은 개정 표기까지 한 어절)
  if (/^다[.;:!?]/.test(right)) return true
  // 두 음절 조사가 줄에서 갈린 것 — "국외에⏎서 처리", "서면이⏎나 전자수단"
  if (SPLIT_PARTICLE.some(([a, b]) => last === a && b.test(right))) return true
  if (PARTICLE_AFTER_CONS.test(right)) return hasBatchim(last)
  if (PARTICLE_AFTER_VOWEL.test(right)) return !hasBatchim(last)
  // "필요⏎한", "다양⏎한" — 하다 관형형은 두 음절+ 명사 뒤만 ("그 중⏎한 명"의 수 관형사와 겹친다)
  if (ADNOMINAL_HAN.test(right)) return h.length >= 2 && !auxBefore(h) && !/(?:는|은|한|다|어|년)$/.test(h)
  return VERB_FORM.test(right) && !auxBefore(h) && !((last === "이" || (last === "가" && h.length >= 3)) && BECOME.test(right))
}

/** 줄 머리가 새 항목(글머리표·번호·조항)인가 — 번호 뒤 숫자(9.8%)·"-" 뒤 글자(생산-가공)는 이어진 글.
 *  앞 줄이 한글로 끝나면 "다." 는 줄을 넘어온 문장 끝이다(…하였⏎다. 본문 꺾임 136곳 전부) */
const ITEM_HEAD = /^(?:[□■◆◇○●◎◦▪▫•※▶▷►❍❏❑✓✔➢➤☞]|[①-⑳]|[-–·∙ㆍ*](?=\s)|\(?\d{1,2}[.)](?!\d)|\(?[가-하][.)]|\([가-하\d]{1,2}\)|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|제\d+[조항호장절])/
export function startsNewItem(prevText: string, nextText: string): boolean {
  const t = nextText.replace(MARKUP, "").trimStart()
  return ITEM_HEAD.test(t) && !(/^다\./.test(t) && /[가-힣]$/.test(prevText.replace(MARKUP, "").trimEnd()))
}

/**
 * 꺾인 자리의 이음 — "" (어절 중간, 붙임) | " " (어절 경계). prevText 는 꺾인 줄, nextText 는 이어지는 줄.
 * 판정 순서와 근거는 머리 주석. 어휘 사전이 없으면(단독 호출) 형태 규칙만 쓴다.
 */
export function wrapJoiner(prevText: string, nextText: string, lex?: WrapLexicon, heads = true): "" | " " {
  const prev = prevText.replace(MARKUP, "").trimEnd(), next = nextText.replace(MARKUP, "").trimStart()
  const a = prev[prev.length - 1], b = next[0]
  if (!a || !b || /[,;:!?]/.test(a) || (DATE_DAY_END.test(prev) && b !== "(")) return " "
  // 중·일문은 띄어쓰기가 없다 — 한글 없는 두 줄의 한자·가나·전각 문장부호끼리 꺾임은 붙인다(kpipa 계약서 중문 "代⏎理中介商")
  if (unspacedCjkBoundary(prev, next)) return ""
  // 앞 줄 끝 어절 — 뒤에서 공백까지 거꾸로 (칸에서 이어 붙인 긴 글에 /\S+$/ 를 돌리면 어절 길이 제곱이 든다)
  let s = prev.length
  while (s > 0 && !/\s/.test(prev[s - 1])) s--
  const left = prev.slice(s), right = next.match(/^\S+/)![0]
  if (particleContinues(left, right)) return ""
  if (endsAsWord(left)) return " "
  // Latin line-end hyphens can be typesetting breaks. Preserve the token boundary
  // unless an intact hyphenated compound is attested within this document.
  // Korean prose wraps Latin terms at their real hyphens; retain that policy.
  if (/[A-Za-z]-$/.test(left) && /^[A-Za-z]/.test(right) && !/[가-힣]/.test(prev + next)) {
    return lex?.joinedWord(left, right.replace(/[.,;:!?)]*$/, "")) ? "" : " "
  }
  // 가운뎃점·붙임표로 끝난 줄은 이어진 낱말 (소방·⏎가스, 생산-가공⏎-유통 — 줄 끝 "·" 105/109 붙음). 가운뎃점을 겹쳐 쓴 말줄임("주의···⏎관세청")은 뺀다
  if (/[·ㆍ‧-]/.test(a) && !/[·ㆍ‧…]{2}$/.test(prev) && /[가-힣A-Za-z0-9]/.test(b)) return ""
  // 영어 낱말은 한컴 영문 줄나눔 기본(단어)이라 줄에서 잘리지 않는다 — 한 글자 증거(data 의 "a|t")가 속이지 않게 먼저.
  // 숫자끼리도 한 글자 증거는 숫자 안 이웃(2026 의 "0|2")이라 믿지 않는다(11:00⏎2026. 9. 2)
  if ((/[A-Za-z]/.test(a) && /[A-Za-z]/.test(b)) || (/\d/.test(a) && /\d/.test(b))) return " "
  const ev = lex?.evidence(left, right)
  if (ev != null) return ev
  // 이어 붙인 꼴이 문서 줄 안에 한 어절로 나왔고 두 조각을 띄어 쓴 이웃 어절로는 나온 적 없으면 붙인다 — 글자 쌍 증거가 갈리는(한 문서에
  // "개인정보 처리"·"개인정보처리자" 가 섞인) 명사+명사 꺾임을 어절 통째로 가른다("개인정보⏎처리자가" → 문서 안 "개인정보처리자가").
  // hwpx↔pdf 752쌍 꺾임 자리(문서 전체 어휘로 모의, 판정 없던 자리만): 맞게 붙임 +208·잘못 붙임 +21. 띄어 쓴 이웃 어절 거부권이 없으면
  // +246·+78 이다(한 문서 안에서 "배달 종사자"·"배달종사자" 를 섞어 쓴 곳)
  if (lex && /[가-힣A-Za-z0-9]$/.test(left) && /^[가-힣A-Za-z0-9]/.test(right) && lex.joinedWord(left, right.replace(/[.,)」』’”;:]+$/, ""))) return ""
  if (/\d$/.test(left) && COUNTER.test(right)) return ""
  // 한 음절 조각 — 문서 줄 안에서 홀로 선 어절로 나온 적 없으면 꺾인 조각이다 ("살⏎펴보고", "공상공무⏎원";
  // 앞 조각 한 음절 붙음 0.53 → 이 검사로 "등·및·한·그" 를 거른다). 둘 다 한 음절이면 붙인다(79/91)
  if (lex && /^[가-힣]$/.test(left) && /^[가-힣]/.test(right) && !STANDALONE_SYLLABLE.test(left)
    && ([...right].length === 1 || !lex.isWord(left))) return ""
  const r1 = right.replace(/[.,)」』’”]+$/, "")
  if (lex && /[가-힣]$/.test(left) && /^[가-힣]$/.test(r1) && !STANDALONE_SYLLABLE.test(r1) && !lex.isWord(r1) && !lex.isWord(right)) return ""
  // 앞 조각 한글 꼬리 + 뒤 조각 첫 두 음절이 문서 줄 안 어절의 머리로 나오고("개⏎최하고" ← "개최하여"), 그 꼬리 뒤에 뒤 조각 첫 음절로
  // 시작하는 어절을 줄 안에서 띄어 쓴 적이 없으면 붙인다. 증거 없는 꺾임을 띄우던 기본값이 보도자료 99쌍에서 22% 틀렸다(낱말 가운데 꺾임).
  // 첫 음절만 보면 다른 복합어가 증거가 됐다("처리⏎방안" ← "처리방법"). 칸 글은 빼고(heads=false) — 세로 이름표 "학⏎위⏎기⏎준" 은 원문도 한 자씩이다
  if (lex && heads) {
    const tail = left.match(/[가-힣]+$/)?.[0], run = right.match(/^[가-힣]+/)?.[0]
    if (tail && run && !STANDALONE_SYLLABLE.test(tail) && lex.startsWord(tail + run.slice(0, 2)) && !lex.spacedHead(tail, run[0])) return ""
  }
  return " "
}

/** 문단 블록의 끝줄 기하 — 쪽 넘김 꺾임 판정용 (page-blocks 가 본문 줄을 문단으로 묶을 때 남긴다, 공개 IR 에 안 나감).
 *  키는 블록의 bbox 객체 — 목록 감지(detectListBlocks)가 블록을 {...block} 으로 새로 만들어도 bbox 는 그대로 넘어간다 */
export const PARA_LAST_LINE = new WeakMap<BoundingBox, { right: number; width: number; fontSize: number }>()
/** 문단 블록의 첫 줄 왼끝 — 쪽 넘김 잇기가 다음 쪽 첫 줄 들여쓰기를 볼 때 (키는 PARA_LAST_LINE 과 같다) */
export const PARA_FIRST_LEFT = new WeakMap<BoundingBox, number>()

/** 쪽 번호로 끝나는 목차·슬라이드 바닥 줄 — "2.3. 회의록의 구성 \t 7"·"…………… 53"·"·· 167"·"\t13/39" */
const PAGE_REF_TAIL = /(?:\t|…|·{2}|\.{3})\s*\d{1,4}(?:\s*\/\s*\d{1,4})?\s*$/
/** 쪽 머리에서 새 항목·제목을 여는 기호 — ITEM_HEAD 밖: 사용자 정의 영역 글머리(U+F000 등, 글꼴 기호), 자모 "ㅇ ", 꺾쇠·대괄호 제목
 *  "< … >"·"[1]"·"[그림 Ⅱ-78]"·"〔서식 4-1〕", 사각·딩뱃 기호 "▮"·"▣"·"❐", 제어 문자. 쪽 넘김 잇기에만 쓴다 — 같은 쪽 줄 잇기는
 *  줄 간격 근거가 따로 있다. PDF 코퍼스(98문서) 쪽 넘김 잇기 138곳 가운데 이 기호로 여는 30곳이 모두 새 항목·제목이었다 */
const PAGE_HEAD_MARK = /^(?:[\u0000-\u001f\ue000-\uf8ff\u25a0-\u25ff\u2750-\u275f<〈《〔\[]|ㅇ\s)/
/** 쪽 머리의 새 항목 — ITEM_HEAD 밖: 짧은 머리 + 탭인 용어·설명 행("N\t- 앞쪽에서 …"), 점으로 여는 조항 번호(".13 사용되는 …") */
const PAGE_ITEM_HEAD = /^(?:\S{1,4}\t|\.\d{1,3}\s)/
/** 문장 끝 — 마침표·물음표·느낌표 뒤 닫는 따옴표·괄호까지 ("격려했다." "전했다.”") */
const SENTENCE_END = /[.?!。][”"’」』)]?$/
/** 짧은 제목꼴 — 한 줄 40자 이하, 문장 끝이 아님 ("세부 행사 일정"·"위치도"·"행정정보 데이터세트 폐기") */
const titleLike = (text: string): boolean => {
  const t = text.replace(MARKUP, "").trim()
  return !t.includes("\n") && [...t].length <= 40 && !SENTENCE_END.test(t)
}
/** 쪽 넘김 잇기로 이은 문단의 쪽 경계 (#136) — 키는 이은 블록의 bbox(PARA_LAST_LINE 과 같은 이유). head 는 뒤 쪽 몫 앞까지의 글,
 *  gap 은 그 사이 이음자 길이, tail 은 뒤 쪽 블록(쪽 번호·기하·모양만 쓴다). 세 쪽 넘게 이으면 앞에서부터 차례로 쌓인다 */
const PAGE_BREAK_JOINS = new WeakMap<BoundingBox, { head: string; gap: number; tail: IRBlock }[]>()

/**
 * 쪽 넘김 꺾임 잇기 — 쪽 끝 문단의 끝줄이 그 쪽 본문 오른끝까지 차 있고 다음 쪽 첫 블록이 같은 글자 크기의 이어지는 문단이면
 * 한 문단으로 (…보여준다. 아이 ⏎ [다음 쪽] 들은 인공지능…). 머리말·꼬리말을 지운 뒤라 두 블록이 배열에서 이웃하면 쪽 끝과 쪽 머리다.
 * 쪽 본문 오른끝은 그 쪽 문단 블록 오른끝의 최댓값. 이은 문단은 앞 쪽 소속으로 남는다 (제자리 수정) —
 * 쪽별 마크다운은 splitPageBreakWraps 로 다시 갈라 뒤 쪽 몫을 뒤 쪽에 둔다
 */
export function joinPageBreakWraps(blocks: IRBlock[], lex?: WrapLexicon): void {
  const pageRight = new Map<number, number>()
  for (const b of blocks) {
    if (b.type !== "paragraph" || !b.bbox || !b.pageNumber) continue
    pageRight.set(b.pageNumber, Math.max(pageRight.get(b.pageNumber) ?? -Infinity, b.bbox.x + b.bbox.width))
  }
  const pageLeft = new Map<number, number>()
  for (const b of blocks) {
    if (b.type !== "paragraph" || !b.bbox || !b.pageNumber) continue
    pageLeft.set(b.pageNumber, Math.min(pageLeft.get(b.pageNumber) ?? Infinity, b.bbox.x))
  }
  for (let i = blocks.length - 1; i > 0; i--) {
    const a = blocks[i - 1], b = blocks[i]
    if (!a.pageNumber || b.pageNumber !== a.pageNumber + 1 || !a.text || !b.text) continue
    if ((a.type !== "paragraph" && a.type !== "list") || b.type !== "paragraph") continue
    const last = a.bbox && PARA_LAST_LINE.get(a.bbox), fs = last ? last.fontSize : 0
    if (!last || fs <= 0 || (pageRight.get(a.pageNumber) ?? Infinity) - last.right >= BODY_FULL_TOL * fs) continue
    if (last.width < BODY_MIN_WIDTH_EM * fs || Math.abs((b.style?.fontSize ?? 0) - fs) > 0.15 * fs) continue
    // 쪽 사이에는 줄 간격 근거가 없다 — HWPX 쌍 대조(한컴 PDF 쌍의 잇기 후보 325곳, 원문 문단 경계와 비교)로 정한 가드:
    // · 목차 줄·항목 기호·용어 행·조항 번호로 여는 블록은 새 줄. 단 앞 문단 안에 같은 사각 기호가 이미 있으면 문장 속 나열이 이어진 것
    //   ("…주요 내용은 ▲ 가계조사 … 구축 ⏎ ▲빈곤선 설정 …")
    // · 앞 쪽 문단이 문장으로 끝나고 다음 쪽 첫 줄이 들여 시작하면 새 문단: 문장 끝 26곳 중 들여쓴 20곳은 원문 경계 19, 왼끝에서
    //   시작한 4곳은 같은 문단 3
    // · 글자 크기(정수 반올림)가 다른 짧은 제목꼴 블록은 제목·캡션. 크기만 다른 블록 34곳 중 같은 문단 24(긴 본문 — 쪽마다 반올림
    //   크기가 13·12 로 흔들리는 문서)라 크기만으로는 가르지 않는다
    const bt = b.text.replace(MARKUP, "")
    if (startsNewItem(a.text, b.text) || PAGE_REF_TAIL.test(a.text) || PAGE_ITEM_HEAD.test(bt)) continue
    if (PAGE_HEAD_MARK.test(bt) && !(/^[\u25a0-\u25ff]/.test(bt) && a.text.includes(bt[0]))) continue
    const firstLeft = b.bbox && PARA_FIRST_LEFT.get(b.bbox)
    const indented = firstLeft === undefined || firstLeft - (pageLeft.get(b.pageNumber!) ?? firstLeft) >= 0.3 * fs
    if (indented && SENTENCE_END.test(a.text.replace(MARKUP, "").trimEnd())) continue
    if (Math.round(b.style?.fontSize ?? 0) !== Math.round(fs) && titleLike(b.text)) continue
    // 탭으로 칸을 나눈 행("‘상록수’의 별도 정의\t일 년 내내 …") 다음 쪽 첫 줄이 짧은 제목꼴이면 표 같은 목록이 끝나고 새 제목이 선 것이다
    // (lo-pairs DOCX 쌍 3곳). 문장 속 탭 뒤로 문장이 이어지는 옛 문서("…crash로 인해서\tclinet에 … option은 ⏎ 무엇인가?")와 줄 앞 조항
    // 번호 뒤 탭(".2.3\t손상을 입은 후 … 고 ⏎ 가정한다;")은 칸 구분이 아니다
    if (/\t/.test(a.text.slice(a.text.lastIndexOf("\n") + 1).replace(/^\S{1,8}\t/, "")) && titleLike(bt.trim().split("\n")[0])) continue
    const head = a.text, joiner = wrapJoiner(a.text, b.text, lex)
    a.text += joiner + b.text
    // b 가 이미 다음 쪽과 이어졌으면 그 경계는 a 글 안에서 head + 이음자만큼 뒤로 밀린다
    const later = (b.bbox && PAGE_BREAK_JOINS.get(b.bbox)) || []
    PAGE_BREAK_JOINS.set(a.bbox!, [{ head, gap: joiner.length, tail: b }, ...later.map(c => ({ ...c, head: head + joiner + c.head }))])
    const bl = b.bbox && PARA_LAST_LINE.get(b.bbox)
    if (bl) PARA_LAST_LINE.set(a.bbox!, bl)
    else PARA_LAST_LINE.delete(a.bbox!)
    blocks.splice(i, 1)
  }
}

/**
 * 쪽별 사영용 블록 — 쪽 넘김 잇기로 이은 문단을 이음 자리에서 다시 쪽마다 가른다 (#136). 쪽 본문이 통째로 한 문단 블록이면 잇기가 뒤 쪽
 * 글 전체를 앞 쪽으로 가져가 그 쪽 항목이 비거나 빠졌다. 문서 블록·마크다운은 이은 그대로 두고 새 배열만 낸다. 이음 뒤 단계(각주 넣기 등)가
 * 앞 글을 바꿔 경계를 못 찾으면 거기서부터는 가르지 않는다
 */
export function splitPageBreakWraps(blocks: IRBlock[]): IRBlock[] {
  return blocks.flatMap(b => {
    const cuts = b.bbox && PAGE_BREAK_JOINS.get(b.bbox)
    const text = b.text
    if (!cuts || !text) return [b]
    const out: IRBlock[] = []
    let from = 0, cur = b
    for (const c of cuts) {
      if (c.head.length < from || !text.startsWith(c.head)) break
      out.push({ ...cur, text: text.slice(from, c.head.length) })
      from = c.head.length + c.gap
      cur = c.tail
    }
    if (!out.length) return [b]
    out.push({ ...cur, text: text.slice(from) })
    return out
  })
}

/** 본문 줄 기하 — 꺾임 판정 입력 (y 는 기준선, PDF 좌표라 아래 줄이 작다) */
export interface WrapLine { text: string; left: number; right: number; y: number; fontSize: number }

/** 여백 밖에 매달리는 줄 끝 전각 구두점 */
const HANGING = /[，。、：；！？）」』】〕》〉．]\s*$/
/** 다단계 번호 머리 — "5.1 채취용기", "7.1.1.2 장기 가동중단" (공백까지 있어야 "1.5L"·"3.5kg" 과 갈린다) */
const MULTI_LEVEL_NUMBER = /^\d{1,2}(?:\.\d{1,3})+\.?\s/
/** 찬 줄: 묶음 오른끝에 글자 크기 0.25배 안 — 양쪽 정렬 본문은 꺾인 줄이 오른끝까지 찬다 */
const BODY_FULL_TOL = 0.25
/** 꺾인 줄 최소 폭(글자 크기 배) — 좁은 줄(가운데 정렬 제목·서명란)은 묶음에서 가장 넓어 오른끝에 닿아도 꺾임이 아니다
 *  (폭 150pt 미만 찬 줄의 86~100% 가 문단 경계) */
const BODY_MIN_WIDTH_EM = 12
/** 이어지는 줄 기준선 간격 상한(글자 크기 배) — 줄 간격 160% 본문이 1.6, 문단 사이 띄움은 2 이상 (2 이상의 23~100% 가 문단 경계) */
const BODY_MAX_PITCH_EM = 2
/** 줄 간격 200% 이상인 본문(보도자료 흔함)은 줄 간격 자체가 2em 을 넘는다 — 같은 묶음 다른 줄쌍의 가장 좁은 간격의 이 배 안이면
 *  한 문단의 줄 간격이다(hwpx↔pdf 752쌍: 2em 이상이면서 이 안인 찬 줄 263곳 중 원문 문단 경계 12곳, 붙음 104·띄움 147).
 *  상한은 글자 크기 3.5배 — 그보다 넓은 간격이 이어진 묶음은 표제·서명란 나열이다 */
const BODY_PITCH_REL = 1.05
const BODY_MAX_PITCH_ABS_EM = 3.5

/**
 * 본문 줄 묶음(한 XY-Cut 그룹, 위→아래)에서 이웃한 두 줄 사이 이음자 — 반환 [i] 는 lines[i] 와 lines[i+1] 사이:
 * "\n" 잇지 않음 · "" 어절 중간 꺾임 · " " 어절 경계 꺾임. 꺾임은 앞 줄이 묶음 오른끝까지 차고, 넓고, 다음 줄이 한 줄 간격 안·같은
 * 글자 크기·새 항목 머리가 아닐 때 (hwpx↔pdf 417쌍 본문: 이 조건의 이웃 줄 15,653곳 중 원문 문단 경계 297곳 = 1.9%)
 */
export function bodyLineJoins(lines: WrapLine[], lex?: WrapLexicon): string[] {
  // 표시 태그는 글자 폭·줄 끝 구두점·번호 판정의 글자가 아니다. 원래 줄은 보존하고 판정용 글만 한 번 정리한다.
  // 링크 표기 `[글](주소)` 도 — 주소 글자가 다음 줄 글자 폭 어림을 줄여 왼쪽 정렬 줄의 꺾임을 문단 끝으로 봤다(ODL 094 번호 목록)
  lines = lines.map(l => {
    const text = l.text.replace(MARKUP, "").replace(LINK_MARKUP, "$1")
    return text === l.text ? l : { ...l, text }
  })
  let right = -Infinity
  for (const l of lines) if (l.right > right) right = l.right
  // 여백 밖에 매단 줄 끝 구두점(LibreOffice 동아시아 조판 "，" "。")은 오른끝을 한 글자 남짓 끌어올린다 — 매단 줄을 뺀 오른끝도
  // 찬 줄 기준으로 인정한다(글자 크기 1.2배 안에서만). kpipa 계약서 중문 각주: 찬 줄 522, "，" 줄만 533
  let inner = -Infinity
  for (const l of lines) if (!HANGING.test(l.text) && l.right > inner) inner = l.right
  const full = (l: WrapLine) => right - l.right < BODY_FULL_TOL * l.fontSize ||
    (right - inner <= 1.2 * l.fontSize && inner - l.right < BODY_FULL_TOL * l.fontSize)
  // 왼쪽 정렬(Word 등)은 어절 단위로 넘겨 꺾인 줄 끝이 들쭉날쭉하다 — 다음 줄 첫 어절이 이 줄 끝 남은 자리에 못 들어갔으면 꺾임.
  // 글자 폭은 다음 줄 평균으로 어림한다
  const nextWordNoRoom = (a: WrapLine, b: WrapLine) => {
    const w = b.text.trim().match(/^\S+/)?.[0]
    const n = [...b.text.trim()].length
    if (!w || n === 0) return false
    const em = (b.right - b.left) / n
    // 중·일문은 단어 사이 공백이 없고 글자 사이에서도 꺾인다 — 다음 줄 전체를 한 어절로 재면 짧은 문단도 잇게 된다
    const advance = unspacedCjkBoundary(a.text, b.text) ? 1 : [...w].length + 1
    return right - a.right < advance * em
  }
  // 찬 줄 또는 실제 꺾임 후보에서 찬 줄이 절반 이상이면 양쪽 정렬이다. 덜 찬 마지막 줄과 다음 어절이 넉넉히
  // 들어가는 짧은 끝줄은 정렬 근거가 아니다 — 이를 분모에 넣으면 두 줄 문단 + 한 줄 문단만으로도 왼쪽 정렬로 뒤집힌다
  const candidates = lines.filter((l, i) => full(l) || (i + 1 < lines.length && nextWordNoRoom(l, lines[i + 1])))
  const ragged = candidates.filter(full).length * 2 < candidates.length
  const pitch = (k: number) => lines[k].y - lines[k + 1].y
  const sameSize = (k: number) => Math.abs(lines[k + 1].fontSize - lines[k].fontSize) <= 0.15 * lines[k].fontSize
  // 줄쌍 간격 가운데 가장 좁은 둘 — i 번째 쌍 자신을 뺀 최솟값을 O(1) 로 (같은 글자 크기 쌍만)
  let p1 = Infinity, p2 = Infinity, i1 = -1
  for (let k = 0; k + 1 < lines.length; k++) {
    const p = pitch(k)
    // 폭 3em 미만 줄(쪽 번호 "1")이 낀 쌍은 줄 간격 근거가 아니다 — 본문 끝줄 바로 아래 쪽 번호가 가장 좁은 간격으로 잡혀
    // 두 줄 간격 본문의 상대 상한을 끌어내렸다(kpipa 계약서 중문 각주 22pt 간격 줄들이 쪽 번호 14pt 간격에 막힘)
    if (p <= 0 || !sameSize(k) || Math.min(lines[k].right - lines[k].left, lines[k + 1].right - lines[k + 1].left) < 3 * lines[k].fontSize) continue
    if (p < p1) { p2 = p1; p1 = p; i1 = k } else if (p < p2) p2 = p
  }
  const out: string[] = []
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i], b = lines[i + 1]
    const fs = a.fontSize
    const others = i === i1 ? p2 : p1 // 다른 쌍이 없으면 Infinity — 상대 기준 없이 2em
    const maxPitch = Number.isFinite(others) ? Math.min(BODY_MAX_PITCH_ABS_EM * fs, Math.max(BODY_MAX_PITCH_EM * fs, others * BODY_PITCH_REL)) : BODY_MAX_PITCH_EM * fs
    // 다단계 번호("5.1 ", "7.1.2 ")로 여는 줄은 새 조항이다 — ITEM_HEAD 는 한 단계 번호만 본다
    const wordWrap = ragged && !full(a) && nextWordNoRoom(a, b) && !MULTI_LEVEL_NUMBER.test(b.text.trimStart())
    const wraps = fs > 0
      && (full(a) || wordWrap)
      && a.right - a.left >= BODY_MIN_WIDTH_EM * fs
      && a.y - b.y > 0 && a.y - b.y < maxPitch
      && Math.abs(b.fontSize - fs) <= 0.15 * fs
      && !startsNewItem(a.text, b.text)
    // 어절 단위 줄넘김은 띄우되 중·일문의 글자 단위 꺾임에는 공백을 넣지 않는다
    out.push(!wraps ? "\n" : wordWrap ? (unspacedCjkBoundary(a.text, b.text) ? "" : " ") : wrapJoiner(a.text, b.text, lex))
  }
  return out
}

/** 칸 안쪽 오른 여백 상한(pt) — 왼 여백(가장 왼쪽 줄 시작 − 칸 왼끝)과 같다고 보되, 가운데 정렬 칸에서 부풀지 않게 한컴 기본
 *  1.8mm(5.1pt) 남짓으로 묶는다. 상한이 없으면 가운데 정렬 칸의 가장 넓은 줄이 찬 줄로 보여 원문 문단 경계를 공백 없이 붙이는
 *  오결합이 95곳(상한 6pt 는 55) — 대신 맞는 붙임 121곳을 덜 한다(어절 F1 약 0.0002). 새 오결합을 덜 만드는 쪽을 택했다 */
const CELL_PAD_MAX = 6

/**
 * 칸 안 줄이 꺾여 다음 줄로 넘어갔나 — 다음 줄 첫 글자가 앞 줄 오른끝 뒤에 칸 안쪽으로 반 글자 넘게 못 들어가는가.
 * 칸 글은 가운데·왼쪽 정렬이 섞여 오른끝 도달만으로는 못 가르므로 "다음 글자가 들어갈 자리가 있었나"로 본다
 * (table-parts 쪽 넘김 쪼개진 행의 continuesAcross 와 같은 기하)
 */
export function cellLineWraps(box: { x1: number; x2: number }, contentLeft: number, prevRight: number, fontSize: number, nextFirstCharW: number): boolean {
  const pad = Math.min(CELL_PAD_MAX, Math.max(0, contentLeft - box.x1))
  return fontSize > 0 && prevRight + nextFirstCharW - (box.x2 - pad) > 0.5 * fontSize
}

/**
 * 칸 안 줄이 칸 글의 오른끝까지 찼나 — 세 줄 이상인 칸에서 줄이 그 칸 줄들의 가장 오른끝에 글자 크기 0.25배 안으로 닿고 칸 안쪽 폭의
 * 80% 이상이면 양쪽 정렬로 꺾인 줄이다. 오른 안 여백이 왼 여백보다 넓은 칸은 cellLineWraps 의 "다음 글자가 못 들어감" 기하가 반 글자
 * 모자라 꺾임을 놓쳤다(규제영향분석서 칸 "국⏎외에서"·"해⏎당하는" — 칸 오른 안쪽 끝에서 0.54em 앞에서 줄마다 끝남).
 * hwpx↔pdf 752쌍: 이 조건으로 새로 꺾임이 된 칸 줄 가운데 맞게 붙임 151·잘못 붙임 23(다음 줄이 "(" 로 시작하는 새 항목은 뺌)
 */
export function cellLineFills(box: { x1: number; x2: number }, contentLeft: number, cellRight: number, lineRight: number, fontSize: number): boolean {
  const pad = Math.min(CELL_PAD_MAX, Math.max(0, contentLeft - box.x1))
  return fontSize > 0 && cellRight - lineRight < BODY_FULL_TOL * fontSize && lineRight - contentLeft >= 0.8 * (box.x2 - box.x1 - 2 * pad)
}
