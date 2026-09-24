/**
 * redact 룰 정의 — 룰별 정규식 변형·검증기(생년월일 세기·Luhn·사업자/법인 체크섬·전화 국번)·라벨 사전.
 * 엔진(정규화·겹침 처리·마스킹·마크다운 표 문맥)은 redact.ts. 룰별 근거·오탐 실측은 bench/redact-bench.mjs.
 */

import type { RedactRule } from "./redact.js"
import { ADDRESS_VARIANTS, NAME_VARIANTS } from "./redact-name-address.js"

/**
 * 룰 우선순위 (앞이 높음). crn 을 rrn 앞에 — 법인 라벨이 붙은 6-7 번호는 법인번호로.
 * email 을 번호 룰들 앞에(로컬파트 숫자 오탐 방지), card·brn 을 phone·account 앞에,
 * driver 를 account 앞에(면허번호 12자리 4그룹이 계좌 패턴에 포섭됨).
 * 주소·인명(opt-in)은 번호 뒤 — 번호가 먼저 자리를 잡고, 도로명이 사람 이름("세종대로")과 겹치면 주소가 이긴다.
 */
export const RULE_PRIORITY: readonly RedactRule[] = [
  "crn", "rrn", "email", "card", "brn", "phone", "driver", "passport", "account", "ip", "address", "name",
]

// ─── 검증기 ───────────────────────────────────────────

/** Luhn 체크섬 (카드번호) */
function luhnValid(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * 주민·외국인등록번호 앞 6자리 생년월일 검증 — 성별 자리로 세기를 정한다
 * (1·2·5·6 → 1900년대, 3·4·7·8 → 2000년대). 2000년대생은 올해를 넘지 못한다.
 */
function birthdateValid(front6: string, genderDigit: string): boolean {
  const yy = Number(front6.slice(0, 2))
  const mm = Number(front6.slice(2, 4))
  const dd = Number(front6.slice(4, 6))
  if (mm < 1 || mm > 12 || dd < 1) return false
  const g = Number(genderDigit)
  const year = (g === 3 || g === 4 || g === 7 || g === 8 ? 2000 : 1900) + yy
  if (year > new Date().getFullYear()) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const max = mm === 2 ? (leap ? 29 : 28) : DAYS_IN_MONTH[mm - 1]
  return dd <= max
}

/** 사업자등록번호 체크섬 (국세청 공개 가중치 1,3,7,1,3,7,1,3,5) */
function brnChecksumValid(d: string): boolean {
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5]
  let sum = 0
  for (let i = 0; i < 9; i++) sum += w[i] * (d.charCodeAt(i) - 48)
  sum += Math.floor(((d.charCodeAt(8) - 48) * 5) / 10)
  return (10 - (sum % 10)) % 10 === d.charCodeAt(9) - 48
}

/** 법인등록번호 체크섬 (가중치 1,2 반복, 모듈러 10) */
function crnChecksumValid(d: string): boolean {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 2) * (d.charCodeAt(i) - 48)
  return (10 - (sum % 10)) % 10 === d.charCodeAt(12) - 48
}

const digitsOf = (s: string): string => s.replace(/\D/g, "")
/** 같은 숫자 반복(0000…, 1111…) — 서식 예시·자리표시자 */
const allSameDigit = (d: string): boolean => d.length > 0 && /^(\d)\1*$/.test(d)

// ─── 라벨 문맥 ────────────────────────────────────────

export type Ctx = "rrn" | "crn" | "brn" | "account" | "card" | "phone" | "passport" | "driver" | "ip" | "other"

/**
 * 라벨 사전. 값 앞 창(현재 셀 + 왼쪽 셀, 태그 제거 후 40자, 앞선 값 뒤부터)에 있는 라벨 유형 **집합**이
 * 문맥이다. "주민등록번호(법인등록번호)"처럼 한 칸에 두 라벨이 붙은 서식은 둘 다 문맥이 된다 — 모호하면
 * 가리는 쪽(주민번호)으로 판정한다. "other" 는 PII 가 아닌 식별번호 라벨(출원번호·과제번호·ISBN·예산과목…).
 */
const LABELS: ReadonlyArray<readonly [Ctx, RegExp]> = [
  ["crn", /법\s*인\s*(?:등\s*록\s*)?번\s*호/g],
  ["rrn", /주\s*민\s*(?:등\s*록\s*)?번\s*호|주\s*민\s*등\s*록|외\s*국\s*인\s*(?:등\s*록\s*)?번\s*호|거\s*소\s*신\s*고\s*번\s*호|생\s*년\s*월\s*일|resident\s*registration|\bRRN\b/gi],
  ["brn", /사\s*업\s*자\s*(?:등\s*록\s*)?번\s*호|고\s*유\s*번\s*호|business\s*registration/gi],
  ["account", /계\s*좌|예\s*금\s*주|입\s*금|은\s*행|뱅\s*크|농\s*협|신\s*협|수\s*협|우\s*체\s*국|금\s*고|bank\s*account|account\s*(?:no|number)/gi],
  ["card", /카\s*드|credit\s*card|card\s*(?:no|number)/gi],
  ["phone", /전\s*화|연\s*락\s*처|휴\s*대|핸\s*드\s*폰|팩\s*스|☎|☏|콜\s*센\s*터|고\s*객\s*센\s*터|대\s*표\s*번\s*호|상\s*담|문\s*의|\b(?:tel|fax|mobile|phone|h\.?p|ARS)\b/gi],
  ["passport", /여\s*권|passport/gi],
  ["driver", /운\s*전\s*면\s*허|면\s*허\s*번\s*호|driver'?s?\s*licen[cs]e/gi],
  ["ip", /\bIP\b|아\s*이\s*피/g],
  ["other", /출\s*원\s*번\s*호|과\s*제\s*번\s*호|사\s*업\s*번\s*호|접\s*수\s*번\s*호|민\s*원\s*번\s*호|신\s*청\s*번\s*호|문\s*서\s*번\s*호|관\s*리\s*번\s*호|주\s*문\s*번\s*호|일\s*련\s*번\s*호|발\s*간\s*등\s*록|등\s*록\s*번\s*호\s*\(\s*기\s*록|ISBN|ISSN|예\s*산|과\s*목|코\s*드|모\s*델|제\s*품|부\s*품|시\s*리\s*얼|serial|model|\bS\/N\b|바\s*코\s*드|기\s*록\s*물|사\s*건\s*번\s*호/gi],
]

/** 셀 경계 — GFM 파이프(이스케이프 제외)와 HTML 셀 닫는 태그 */
const CELL_SEP_RE = /(?<!\\)\||<\/t[dh]>/gi
/** 앞선 값 — 창 안에서 이 뒤부터만 본다 (앞 값의 라벨이 뒤 값으로 번지지 않게) */
const PREV_VALUE_RE = /\d[\d\-.\s]{4,}\d/g

/** 텍스트 안 라벨 유형 집합 */
export function labelsIn(s: string): Set<Ctx> {
  const out = new Set<Ctx>()
  for (const [ctx, re] of LABELS) {
    re.lastIndex = 0
    if (re.test(s)) out.add(ctx)
  }
  return out
}

/** 매치 앞 문맥 라벨 집합 — 현재 셀 + 바로 왼쪽 셀, 태그 제거 후 40자, 앞선 값 뒤부터 */
export function labelsBefore(norm: string, start: number): Set<Ctx> {
  let win = norm.slice(Math.max(0, start - 120), start)
  const seps = [...win.matchAll(CELL_SEP_RE)]
  if (seps.length >= 2) {
    const s = seps[seps.length - 2]
    win = win.slice((s.index as number) + s[0].length)
  }
  win = win.replace(/<[^>]*>/g, " ").slice(-40)
  const prev = [...win.matchAll(PREV_VALUE_RE)].pop()
  if (prev) win = win.slice((prev.index as number) + prev[0].length)
  return labelsIn(win)
}

/** 값 바로 뒤 비개인 식별번호 명사 — "11-24-123456-01 (접수)", "S123A4567 부품" */
const OTHER_AFTER_RE = /^\s{0,2}[(\[]?\s{0,2}(?:접\s*수|신\s*청|주\s*문|사\s*건|과\s*제|문\s*서|관\s*리|부\s*품|제\s*품|모\s*델|코\s*드|시\s*리\s*얼|serial|model)/i

// ─── 룰 정의 ──────────────────────────────────────────

export interface Match {
  /** 정규화 텍스트 매치 (d 플래그 — 그룹 인덱스 포함) */
  m: RegExpMatchArray
  /** 라벨 문맥 집합 (인라인, 비었으면 표 머리글 — 지연 계산) */
  ctx: () => ReadonlySet<Ctx>
  /** 이 자리가 표 칸이면 그 열 머리글 원문 — 인명 룰의 "성명" 열 */
  header: () => string | undefined
  /** 이 매치 앞에서 가장 가까이 끝난 탐지 — 인명 나열("A, B, C 등") 잇기 */
  prev: () => { rule: RedactRule; start: number; end: number } | undefined
}

export interface Variant {
  re: RegExp
  /** 이 유형 라벨이 문맥에 있을 때만 인정 (모호한 모양) */
  needs?: Ctx
  /** 추가 검증 — false면 스킵 */
  ok?: (x: Match) => boolean
  /** 마스킹할 이름 그룹 — 그 범위의 글자·숫자를 maskChar 로 (구분자·공백·기존 가림표는 유지) */
  mask: readonly string[]
  /** 그룹 안 글자를 구분자까지 전부 가린다 (이메일 로컬파트 — 이름 마디 길이도 숨김) */
  maskAll?: boolean
  /** 탐지 스팬이 되는 이름 그룹 — 문맥어("피고인 ")를 매치에 넣고 값만 스팬으로 (없으면 매치 전체) */
  span?: string
}

const g = (x: Match, name: string): string => x.m.groups?.[name] ?? ""
const has = (x: Match, c: Ctx): boolean => x.ctx().has(c)
/** 법인 라벨만 있고 주민 라벨은 없다 — 이때만 6-7 번호를 주민번호에서 뺀다 (모호하면 가린다) */
const crnOnly = (x: Match): boolean => has(x, "crn") && !has(x, "rrn")
/** 매치 뒤 원문 (정규화 텍스트) */
const after = (x: Match, n = 16): string => {
  const end = (x.m.index as number) + x.m[0].length
  return x.m.input!.slice(end, end + n)
}
const before = (x: Match, n = 2): string => {
  const start = x.m.index as number
  return x.m.input!.slice(Math.max(0, start - n), start)
}
/** 비개인 식별번호 라벨이 앞에 있거나(해당 PII 라벨 없이) 뒤에 "(접수)"류 명사가 붙은 값 */
const otherCtx = (x: Match, own: Ctx): boolean => (has(x, "other") && !has(x, own)) || OTHER_AFTER_RE.test(after(x))
/**
 * 값 바로 앞이 일련번호 라벨("S/N 0507-9978-0522", "바코드: 1588-…") — 전화 모양이어도 기기·상품 번호.
 * 전화는 "예산"·"과목" 같은 넓은 other 라벨로는 막지 않는다(예산담당관 044-… 실번호) — 바로 앞 좁은 라벨만
 */
const SERIAL_BEFORE_RE = /(?:\bS\/N|\bserial(?:\s*(?:no|number))?|시\s*리\s*얼(?:\s*번\s*호)?|일\s*련\s*번\s*호|바\s*코\s*드)\s*[:.]?\s*$/i
const serialBefore = (x: Match): boolean => SERIAL_BEFORE_RE.test(before(x, 20)) && !has(x, "phone")

// 공통 경계 — 숫자·영문·@·하이픈에 붙은 번호(더 긴 코드의 일부)는 제외
const PHONE_PREFIX = "0(?:1[016789]|2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70|80|60|50[2-8])"
const PHONE_AREA = "0(?:1[016789]|2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70|80|50[2-8])"
/**
 * 전화번호 구분자 한 자리 — 하이픈(앞뒤 공백 0~2칸: "02- 3668-1330", "031- 405 -8255"), 공백 1~2칸, 온점.
 * 두 자리는 따로 고르되 온점은 온점끼리만(phoneSepsOk) — "010.1234-5678" 혼합은 미탐 계약 유지
 */
const PHONE_SEP = "(?: {0,2}- {0,2}| {1,2}|\\.)"
/** 전화번호 끝 경계 — 영숫자·@·하이픈이 붙으면 더 긴 코드(예산과목 064-1100-1131-301-210) */
const PHONE_END = "(?![\\w@-])"

/** 두 구분자 조합 — 둘 다 없거나 둘 다 있고, 온점은 온점끼리. 온점 구분이면 뒤 ".숫자"(더 긴 점 코드) 거부 */
function phoneSepsOk(x: Match, s1: string, s2: string): boolean {
  if ((s1 === "") !== (s2 === "")) return false
  if ((s1 === ".") !== (s2 === ".")) return false
  return s1 !== "." || !/^\.\d/.test(after(x, 2))
}

/**
 * 전화번호 숫자 검증 — 가입자 번호 전부 0(010-0000-0000 자리표시자) 제외. 구분자 없는 지역번호는
 * 국번이 0으로 시작하면 코드로 본다(0202030201 NCS 능력단위 류) — 구분자가 있으면 형식을 믿는다
 * (실결재 결문 팩스 02-02xx-xxxx 실측). 02-123-4567·010-1234-5678 같은 관용 예시는 실번호처럼 가린다.
 */
function phoneDigitsOk(pre: string, mid: string, last: string, bare: boolean): boolean {
  if (/^0+$/.test(mid + last)) return false
  return !bare || !/^0(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4])$/.test(pre) || mid[0] !== "0"
}

/** 이메일 시작 경계 — 로컬파트 한가운데(gd.hong 의 hong)·이미 가린 로컬파트 꼬리(j*********5@…)에서는 시작하지
 *  않는다. 글머리·강조 가림표 뒤(*hong@…, ●hong@…)와 문장 부호 뒤(.hong@…)는 허용 */
const EMAIL_START = "(?<![\\w%+])(?<!\\w[.\\-])(?<![A-Za-z0-9][*●○◯×#]+)"
const EMAIL_DOMAIN = "(?<domain>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\\.(?<tld>[A-Za-z]{2,24}))(?![\\w-])"
const FILE_EXT_TLD = /^(?:png|jpe?g|gif|bmp|svg|webp|tiff?|hwpx?|hwp|pdf|docx?|xlsx?|pptx?|txt|zip|csv|json|xml|html?|js|css|mp[34]|wav|avi|exe)$/i

export const RULES: Record<RedactRule, readonly Variant[]> = {
  // 주민·외국인등록번호 — 앞 6자리(생년월일) 유지, 뒤 7자리 마스크
  rrn: [
    { // 하이픈형 (앞뒤 공백 0~2칸, 유니코드 대시는 정규화로 흡수). 뒤에 "-글자"는 허용, "-숫자"는 더 긴 코드.
      // 법인 라벨만 있으면 제외
      re: /(?<![\w-])(?<front>\d{6})(?<sep> {0,2}- {0,2})(?<back>[1-8]\d{6})(?![\w])(?!-\d)/dg,
      ok: (x) => birthdateValid(g(x, "front"), g(x, "back")[0]) && !crnOnly(x),
      mask: ["back"],
    },
    { // 뒷자리 일부만 가린 형태 (900101-1******, 900101-1694***) — 남은 숫자를 가린다
      re: /(?<![\w-])(?<front>\d{6})(?<sep> {0,2}- {0,2})(?<back>[1-8][0-9*●○◯×xX#]{6})(?![\w*●○◯×#])(?!-\d)/dg,
      ok: (x) => /[*●○◯×xX#]/.test(g(x, "back")) && birthdateValid(g(x, "front"), g(x, "back")[0]) && !crnOnly(x),
      mask: ["back"],
    },
    { // 구분자 없음·공백/온점/가운뎃점/빗금/물결 구분 — 주민/외국인등록번호(생년월일) 라벨이 있을 때만
      re: /(?<![\w@.-])(?<front>\d{6})(?<sep>[ .·/~]?)(?<back>[1-8]\d{6})(?![\w@-])/dg,
      needs: "rrn",
      ok: (x) => birthdateValid(g(x, "front"), g(x, "back")[0]),
      mask: ["back"],
    },
  ],
  // 법인등록번호 (opt-in) — 법인 라벨이 있거나, 뒷자리가 0으로 시작(주민번호 불가)하고 체크섬 유효
  crn: [
    {
      re: /(?<![\w-])(?<front>\d{6})(?<sep> {0,2}- {0,2})(?<back>\d{7})(?![\w-])/dg,
      ok: (x) => !allSameDigit(g(x, "front") + g(x, "back")) && (crnOnly(x)
        || (g(x, "back")[0] === "0" && crnChecksumValid(g(x, "front") + g(x, "back")))),
      mask: ["back"],
    },
    {
      re: /(?<![\w@.-])(?<front>\d{6})(?<back>\d{7})(?![\w@-])/dg,
      needs: "crn",
      ok: (x) => !allSameDigit(g(x, "front") + g(x, "back")) && !has(x, "rrn"),
      mask: ["back"],
    },
  ],
  // 이메일 — 로컬파트 첫 글자만 남기고 마스크, 도메인 유지. 파일명(image@2x.png)은 제외
  // 이미 가린 로컬파트(j*********5@…) 뒤꼬리에서 시작하지 않는다 — 가림표 바로 뒤 매치 금지
  email: [
    {
      re: new RegExp(`${EMAIL_START}(?<l1>[A-Za-z0-9])(?<lrest>[A-Za-z0-9._%+-]+)@${EMAIL_DOMAIN}`, "dg"),
      ok: (x) => !FILE_EXT_TLD.test(g(x, "tld")),
      mask: ["lrest"],
      maskAll: true,
    },
    { // 한 글자 로컬파트 — 첫 글자를 남기면 가린 게 없으므로 전부 가린다
      re: new RegExp(`${EMAIL_START}(?<l1>[A-Za-z0-9])@${EMAIL_DOMAIN}`, "dg"),
      ok: (x) => !FILE_EXT_TLD.test(g(x, "tld")),
      mask: ["l1"],
    },
  ],
  // 카드번호 — 가운데 마스크 + Luhn. 구분자 없는 15~16자리는 카드 라벨이 있을 때만
  card: [
    { // 4-4-4-4 (같은 구분자 강제)
      re: /(?<![\w-])(?<g1>\d{4})(?<sep>[- ])(?<g2>\d{4})\k<sep>(?<g3>\d{4})\k<sep>(?<g4>\d{4})(?![\w-])(?![- ]\d)/dg,
      ok: (x) => { const d = digitsOf(x.m[0]); return luhnValid(d) && !allSameDigit(d) },
      mask: ["g2", "g3"],
    },
    { // AMEX 4-6-5
      re: /(?<![\w-])(?<g1>3[47]\d{2})(?<sep>[- ])(?<g2>\d{6})\k<sep>(?<g3a>\d)(?<g3b>\d{4})(?![\w-])(?![- ]\d)/dg,
      ok: (x) => luhnValid(digitsOf(x.m[0])),
      mask: ["g2", "g3a"],
    },
    { // 온점 구분 4.4.4.4 — 카드 라벨 필요 (버전·좌표 모양과 겹침)
      re: /(?<![\w.-])(?<g1>\d{4})\.(?<g2>\d{4})\.(?<g3>\d{4})\.(?<g4>\d{4})(?![\w-])(?!\.\d)/dg,
      needs: "card",
      ok: (x) => { const d = digitsOf(x.m[0]); return luhnValid(d) && !allSameDigit(d) },
      mask: ["g2", "g3"],
    },
    { // 무구분 15~16자리 — 카드 라벨 필요
      re: /(?<![\w@.-])(?<g1>\d{4})(?<mid>\d{7,8})(?<g4>\d{4})(?![\w@-])/dg,
      needs: "card",
      ok: (x) => { const d = digitsOf(x.m[0]); return luhnValid(d) && !allSameDigit(d) },
      mask: ["mid"],
    },
  ],
  // 사업자등록번호 3-2-5 — 체크섬 유효 또는 사업자 라벨. 뒤 5자리(일련·검증번호) 마스크
  brn: [
    {
      re: /(?<![\w-])(?<a>\d{3})-(?<b>\d{2})-(?<c>\d{5})(?![\w-])/dg,
      ok: (x) => {
        const d = digitsOf(x.m[0])
        if (allSameDigit(d)) return false
        return has(x, "brn") || (brnChecksumValid(d) && !has(x, "account") && !otherCtx(x, "brn"))
      },
      mask: ["c"],
    },
    {
      re: /(?<![\w@.-])(?<a>\d{3})(?<b>\d{2})(?<c>\d{5})(?![\w@-])/dg,
      needs: "brn",
      ok: (x) => !allSameDigit(digitsOf(x.m[0])),
      mask: ["c"],
    },
  ],
  // 전화번호 — 가운데 자리만 마스크 (대표번호는 뒤 4자리).
  // 뒤에 "-"가 붙으면 더 긴 코드(예산과목 064-1100-1131-301-210)의 일부라 제외.
  phone: [
    { // 국내 일반: 휴대폰·지역·070/080/060·050x 안심번호. 구분자 -·공백·온점(PHONE_SEP) 또는 무구분
      re: new RegExp(`(?<![\\w@+-])(?<pre>${PHONE_PREFIX})(?<s1>${PHONE_SEP}?)(?<mid>\\d{3,4})(?<s2>${PHONE_SEP}?)(?<last>\\d{4})${PHONE_END}`, "dg"),
      ok: (x) => {
        const pre = g(x, "pre")
        const bare = g(x, "s1") === ""
        if (!phoneSepsOk(x, g(x, "s1"), g(x, "s2"))) return false
        if (!phoneDigitsOk(pre, g(x, "mid"), g(x, "last"), bare)) return false
        if (serialBefore(x)) return false
        if (!bare) return true // 구분자 있는 번호는 쉼표·온점 목록 안에서도 번호 ("02-…,010-…")
        // 무구분 — 소수점 뒤(3.0212345678)는 아님, 휴대폰이 아닌 번호는 쉼표 숫자 목록 안의 코드(…,0507502002,…) 제외
        if (/\d\.$/.test(before(x))) return false
        if (pre.startsWith("01")) return true // 휴대폰 무구분 목록 "01023456789,01098765432"
        return !/\d,$/.test(before(x)) && !/^,\d/.test(after(x, 2))
      },
      mask: ["mid"],
    },
    { // 괄호 지역번호: (02) 123-4567, (042)481-6300
      re: new RegExp(`(?<![\\w@])\\((?<pre>${PHONE_AREA})\\) ?(?<mid>\\d{3,4})(?<s2>${PHONE_SEP}?)(?<last>\\d{4})${PHONE_END}`, "dg"),
      ok: (x) => phoneDigitsOk(g(x, "pre"), g(x, "mid"), g(x, "last"), false) && (g(x, "s2") !== "." || !/^\.\d/.test(after(x, 2))),
      mask: ["mid"],
    },
    { // 지역번호 뒤 닫는 괄호: 02)450-1234
      re: new RegExp(`(?<![\\w@(+-])(?<!\\d\\.)(?<pre>${PHONE_AREA})\\) ?(?<mid>\\d{3,4})(?<s2>${PHONE_SEP})(?<last>\\d{4})${PHONE_END}`, "dg"),
      ok: (x) => phoneDigitsOk(g(x, "pre"), g(x, "mid"), g(x, "last"), false) && (g(x, "s2") !== "." || !/^\.\d/.test(after(x, 2))),
      mask: ["mid"],
    },
    { // 국제 표기: +82 10-1234-5678, +82-2-123-4567, +82 (0)10 1234 5678, +821012345678
      re: new RegExp(`(?<![\\w@+])(?<cc>\\+82)(?<s0>[-. ]?)(?:\\(0\\) ?)?(?<pre>1[016789]|2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70|80)(?<s1>${PHONE_SEP}?)(?<mid>\\d{3,4})(?<s2>${PHONE_SEP}?)(?<last>\\d{4})${PHONE_END}`, "dg"),
      ok: (x) => phoneSepsOk(x, g(x, "s1"), g(x, "s2")) && phoneDigitsOk("0" + g(x, "pre"), g(x, "mid"), g(x, "last"), g(x, "s1") === ""),
      mask: ["mid"],
    },
    { // 대표번호 15xx·16xx·18xx — 구분자 필수. 연도 범위 모양(1592-1598)·온점/공백 구분은 전화 라벨이 있을 때만.
      // 뒤 4자리 0000 은 자리표시자
      re: new RegExp(`(?<![\\w@+-])(?<!\\d\\.)(?<pre>1(?:5[2-9]\\d|6\\d\\d|8\\d\\d))(?<sep> {0,2}- {0,2}| {1,2}|\\.)(?<last>\\d{4})${PHONE_END}`, "dg"),
      ok: (x) => {
        if (g(x, "last") === "0000" || serialBefore(x)) return false
        if (g(x, "sep") === "." && /^\.\d/.test(after(x, 2))) return false
        const a = Number(g(x, "pre"))
        const b = Number(g(x, "last"))
        // 뒤 그룹이 앞 그룹 이상이고 올해 이하면 연도 범위(재위·생몰·전쟁·시대) — 폭과 무관
        const yearRange = b >= a && b <= new Date().getFullYear()
        return (g(x, "sep").trim() === "-" && !yearRange) || has(x, "phone")
      },
      mask: ["last"],
    },
  ],
  // 운전면허번호 — 지역코드(11~28)-연도-일련6-검증2 / 구형 지역명 + 2-6-2. 뒤 8자리 마스크
  driver: [
    { // 신형 — 무문맥이지만 비개인 식별번호 문맥("(접수)" 등)이면 아님
      re: /(?<![\w-])(?<r>1[1-9]|2[0-8])-(?<y>\d{2})-(?<s>\d{6})-(?<c>\d{2})(?![\w-])/dg,
      ok: (x) => has(x, "driver") || !otherCtx(x, "driver"),
      mask: ["s", "c"],
    },
    {
      re: /(?<rn>서울|부산|경기|강원|충북|충남|전북|전남|경북|경남|제주|대구|인천|광주|대전|울산) ?(?<y>\d{2})-(?<s>\d{6})-(?<c>\d{2})(?![\w-])/dg,
      mask: ["s", "c"],
    },
    {
      re: /(?<![\w@.-])(?<r>1[1-9]|2[0-8])(?<y>\d{2})(?<s>\d{6})(?<c>\d{2})(?![\w@-])/dg,
      needs: "driver",
      mask: ["s", "c"],
    },
  ],
  // 여권번호 — 신형 복수여권(M123A4567)은 무문맥, 그 밖의 종류 글자(S·R·O·D·G)와 구형(M12345678)은 여권 라벨
  // 필요 ("S123A4567 부품" 같은 제품 코드). 첫 글자만 남김
  passport: [
    {
      re: /(?<![A-Za-z0-9])(?<l>[MSRODG])(?<num>\d{3}[A-Z]\d{4})(?![A-Za-z0-9])/dg,
      ok: (x) => has(x, "passport") || (g(x, "l") === "M" && !otherCtx(x, "passport")),
      mask: ["num"],
    },
    {
      re: /(?<![A-Za-z0-9])(?<l>[MSRODG])(?<num>\d{8})(?![A-Za-z0-9])/dg,
      needs: "passport",
      mask: ["num"],
    },
    { // 소문자로 친 여권번호(m123a4567) — 여권 라벨이 있을 때만
      re: /(?<![A-Za-z0-9])(?<l>[msrodg])(?<num>\d{3}[a-z]\d{4}|\d{8})(?![A-Za-z0-9])/dg,
      needs: "passport",
      mask: ["num"],
    },
  ],
  // 계좌번호 — 하이픈 3~4그룹, 총 11~16자리 (10자리는 계좌 라벨 필요). 마지막 그룹 빼고 마스크.
  // 무구분 10~14자리는 계좌·은행 라벨이 있을 때만 (뒤 4자리 유지)
  account: [
    {
      // 마지막 그룹 1자리 허용 — 새마을금고 9002-1234-5678-9, 3-2-6-1·3-3-6-1 형식
      re: /(?<![\w-])(?<!\d\.)(?<head>\d{2,6}(?:-\d{2,6}){1,2})-(?<last>\d{1,8})(?![\w-])(?!\.\d)/dg,
      ok: (x) => {
        const s = x.m[0]
        const d = digitsOf(s)
        const acct = has(x, "account")
        if (allSameDigit(d) || (!acct && otherCtx(x, "account"))) return false
        // 쉼표 숫자 목록 안(1,234-…)은 계좌 라벨이 있을 때만 ("계좌 110-…,110-…" 나열)
        if (!acct && (/\d,$/.test(before(x)) || /^,\d/.test(after(x, 2)))) return false
        if (/^\d+(?:-0+)+$/.test(s)) return false // 010-0000-0000·000-00-00000 류 자리표시자
        if (d.length < 10 || d.length > 16 || (d.length === 10 && !acct)) return false
        if (/^\s*원/.test(after(x, 3))) return false // 금액 표기 뒤 "원"
        if (acct) return true
        if (/^(?:10|20|30|40)-(?:19|20)\d\d-\d{6,7}$/.test(s)) return false // 특허·상표·디자인 출원번호
        // 연도로 시작하는 날짜 부호 일련번호(2024-01-15-1234, 2024-0115-123456, 2023-10-123456)
        if (/^(?:19|20)\d\d-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])?-/.test(s)) return false
        if (s.split("-").filter((p) => /^(?:19|20)\d\d$/.test(p)).length >= 2) return false // 연도 나열 2019-2020-2021
        if (/^\d{3}-\d{2}-\d{5}$/.test(s) && brnChecksumValid(d)) return false // 사업자번호 몫
        return true
      },
      mask: ["head"],
    },
    {
      re: /(?<![\w@.-])(?<!\d,)(?<head>\d{6,10})(?<last>\d{4})(?![\w@-])(?!,\d)/dg,
      needs: "account",
      ok: (x) => !allSameDigit(x.m[0]),
      mask: ["head"],
    },
  ],
  // IPv4 (opt-in) — 옥텟 0~255, 첫 옥텟 10 이상(1.2.3.4 절 번호·버전 제외) 또는 IP 라벨. 뒤 두 옥텟 마스크
  ip: [
    {
      re: /(?<![\w.])(?<a>\d{1,3})\.(?<b>\d{1,3})\.(?<c>\d{1,3})\.(?<d>\d{1,3})(?![\w])(?!\.\d)/dg,
      ok: (x) => {
        const oct = [g(x, "a"), g(x, "b"), g(x, "c"), g(x, "d")]
        if (oct.some((o) => Number(o) > 255 || (o.length > 1 && o[0] === "0"))) return false
        return Number(oct[0]) >= 10 || has(x, "ip")
      },
      mask: ["c", "d"],
    },
  ],
  // 주소·인명 (opt-in) — 사전 + 문맥 게이트, redact-name-address.ts
  address: ADDRESS_VARIANTS,
  name: NAME_VARIANTS,
}
