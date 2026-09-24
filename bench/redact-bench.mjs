#!/usr/bin/env node
// PII 마스킹(redact) 탐지 벤치 — 합성 정답 셋(bench/redact/cases.md) 룰별 P/R/F1 + 실코퍼스 오탐 실측.
//
// 트랙
//   synthetic : cases.md 의 [[유형:값]] 정답 스팬 대비 redactMarkdown 탐지를 채점 (게이트 대상)
//   random    : 번호형 룰 표면형 난수 (게이트 대상 — 번호형 룰만 켠다, 아래 runRandom)
//   external  : 스키프트(schift-ko-pii-v7) benchmark_v3 473문장 외부 정답 — 인명·주소·전화·이메일·주민번호
//               유형별 P/R/F1·스팬 정확 일치·범주별. 기관명은 법인·단체라 개인정보가 아니어서 모수 밖(겹친
//               탐지 수만 따로). 데이터는 Schift License(Apache 2.0 + 매출 조건) 라 저장소에 넣지 않는다 —
//               bench/collect-schift.mjs 로 bench/corpus/schift/ 에 받거나 --schift=경로. 없으면 SKIP
//   corpus    : bench/corpus 실문서를 파싱해 룰셋(기본 DEFAULT_REDACT_RULES, --corpus-rules 로 지정) 탐지
//               건수·모양을 센다 (보고용 — 정답 없음, 사람이 표본을 보고 오탐을 판정. --dump 로 원문 표본을
//               bench/out 에 떨군다. 인명·주소 모양은 한글을 "가" 로 바꿔 출력에 이름이 안 나오게)
//
// 채점 (프로필마다: default = DEFAULT_REDACT_RULES, all = 모듈이 아는 전 룰)
//   typed   : 탐지 룰이 정답 유형과 호환되고 스팬이 겹치면 TP. 겹쳐도 유형이 다르면 FP(오분류)+FN.
//             정답 없는 곳의 탐지는 FP. 룰이 꺼진 유형의 정답은 모수(recall)에서 빠진다.
//   masking : 유형 무관 — 탐지가 어떤 정답과든 겹치면 FP 아님, 켜진 유형의 정답이 어떤 탐지로든
//             덮이면 TP ("가려졌는가"만 본다).
//   exact   : typed TP 중 스팬 경계가 정답과 정확히 같은 비율.
//
// 사용법: node bench/redact-bench.mjs [--gate] [--verbose] [--random=N(기본 3000, 0=끔)] [--schift=path|--no-schift]
//          [--corpus[=dir[:ext,…],…]] [--corpus-rules=r,…] [--cache=dir] [--dump=path] [--json=path]
//   --corpus 는 기본으로 bench/corpus 전체를 하위 폴더까지 훑는다 (hwpx·hwp·pdf·docx·xlsx·hml)
//   모듈: 기본 ../dist/index.js (먼저 tsup 빌드). KORDOC_REDACT_MODULE=경로 로 다른 빌드와 비교.

import { readFile, readdir, writeFile, mkdir, realpath, stat } from "node:fs/promises"
import { join, extname, dirname, relative, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : undefined }
const gateMode = flag("gate")
const verbose = flag("verbose")

const modPath = process.env.KORDOC_REDACT_MODULE
  ? pathToFileURL(process.env.KORDOC_REDACT_MODULE).href
  : new URL("../dist/index.js", import.meta.url).href
const mod = await import(modPath)
const { redactMarkdown, redactText, DEFAULT_REDACT_RULES } = mod
// 모듈이 ALL_REDACT_RULES 를 내보내지 않으면(구버전 빌드·index 미재수출) 룰별 표본으로 지원 여부를 탐침
const PROBES = {
  rrn: "900101-1234568", phone: "010-2345-6789", email: "hong@example.com", card: "4111-1111-1111-1111",
  account: "110-234-567890", passport: "여권번호 M12345678", driver: "11-23-456789-01", brn: "사업자등록번호 123-45-56040",
  crn: "법인등록번호 110111-1022287", ip: "IP 192.168.10.25",
  name: "성명: 홍길동", address: "서울특별시 종로구 세종대로 209",
}
const ALL_RULES = mod.ALL_REDACT_RULES
  ?? Object.keys(PROBES).filter(r => redactMarkdown(PROBES[r], { rules: [r] }).hits.some(h => h.rule === r))

// 정답 유형 → 호환 룰 (유형명 = 룰명)
const TYPES = ["rrn", "phone", "email", "card", "account", "passport", "driver", "brn", "crn", "ip", "name", "address"]

// 게이트 = 무후퇴 플로어 (2026-09-23 실측: 합성 all/default micro F1 1.000, 난수 재현 1.000·오탐 0,
// 종전 엔진은 0.648 / 0.647 · 난수 오탐 775). 합성 셋은 룰 작성자가 만든 것이라 만점이 목표가 아니라
// "고친 표면형이 다시 안 깨지는지"를 지킨다 — 일반화 근거는 난수 트랙과 --corpus 오탐 실측.
const GATES = {
  all: { microF1: 0.97, microPrecision: 0.98, minRuleF1: 0.9 },
  default: { microF1: 0.97, microPrecision: 0.98, negFP: 0 },
  random: { recall: 0.99, fp: 0 },
  // 외부 정답(스키프트) 무후퇴 플로어 — 2026-09-24 실측: 인명 P 1.000 R 0.861, 주소·전화·이메일·주민 1.000/1.000,
  // 부정 예(법령 조문·행정구역만·기관 직위·문서번호 금액) 오탐 0. 인명 재현율 잔여는 문맥 없는 맨 이름(설계상 미탐)
  external: {
    name: { precision: 0.98, recall: 0.84 },
    address: { precision: 0.98, recall: 0.97 },
    phone: { precision: 0.98, recall: 0.99 }, email: { precision: 0.98, recall: 0.99 }, rrn: { precision: 0.98, recall: 0.99 },
    negativeFP: 0,
  },
}
/** 번호형 룰 — 난수 트랙은 번호 표면형만 만든다(양성 뒤 "(예금주 홍길동)" 같은 이름은 인명 룰로는 정답이라 끈다) */
const NUMBER_RULES = ALL_RULES.filter((r) => r !== "name" && r !== "address")

// ─── cases.md 파서 ───────────────────────────────────
function parseCases(src) {
  const cases = []
  let section = "(none)"
  let buf = []
  const flush = () => {
    if (buf.length === 0) return
    const raw = buf.join("\n")
    buf = []
    const gold = []
    let text = ""
    let last = 0
    for (const m of raw.matchAll(/\[\[([a-z]+):([\s\S]+?)\]\]/g)) {
      text += raw.slice(last, m.index)
      if (!TYPES.includes(m[1])) throw new Error(`알 수 없는 정답 유형: ${m[1]} (${section})`)
      gold.push({ type: m[1], start: text.length, end: text.length + m[2].length, value: m[2] })
      text += m[2]
      last = m.index + m[0].length
    }
    text += raw.slice(last)
    cases.push({ section, group: section.split("/")[0], text, gold })
  }
  for (const line of src.split("\n")) {
    if (line.startsWith("//")) continue
    const h = line.match(/^## (.+)$/)
    if (h) { flush(); section = h[1].trim(); continue }
    if (line.trim() === "") { flush(); continue }
    buf.push(line)
  }
  flush()
  return cases
}

const overlap = (a, b) => a.start < b.end && b.start < a.end

// ─── 채점 ────────────────────────────────────────────
function evaluate(cases, rules) {
  const enabled = new Set(rules)
  const per = Object.fromEntries(TYPES.map(t => [t, { tp: 0, fp: 0, fn: 0, exact: 0 }]))
  const mask = { tp: 0, fp: 0, fn: 0 }
  const bySection = new Map()
  const errors = []
  for (const c of cases) {
    const r = redactMarkdown(c.text, { rules })
    const hits = r.hits.map(h => ({ rule: h.rule, start: h.index, end: h.index + h.length }))
    const sec = bySection.get(c.section) ?? { gold: 0, found: 0, fp: 0 }
    bySection.set(c.section, sec)

    // typed — 정답마다 호환 룰의 겹치는 탐지를 하나씩 소비
    const used = new Set()
    for (const g of c.gold) {
      if (!enabled.has(g.type)) continue
      sec.gold++
      const i = hits.findIndex((h, k) => !used.has(k) && h.rule === g.type && overlap(h, g))
      if (i >= 0) {
        used.add(i)
        per[g.type].tp++
        sec.found++
        if (hits[i].start === g.start && hits[i].end === g.end) per[g.type].exact++
        else errors.push({ kind: "boundary", section: c.section, type: g.type, gold: g.value, got: c.text.slice(hits[i].start, hits[i].end) })
      } else {
        per[g.type].fn++
        const other = hits.find(h => overlap(h, g))
        errors.push({ kind: other ? `mistype(${other.rule})` : "miss", section: c.section, type: g.type, gold: g.value })
      }
    }
    hits.forEach((h, k) => {
      if (used.has(k)) return
      per[h.rule] ??= { tp: 0, fp: 0, fn: 0, exact: 0 }
      per[h.rule].fp++
      sec.fp++
      errors.push({ kind: "fp", section: c.section, rule: h.rule, got: c.text.slice(h.start, h.end) })
    })

    // masking — 유형 무관
    for (const h of hits) if (!c.gold.some(g => overlap(h, g))) mask.fp++
    for (const g of c.gold) {
      if (!enabled.has(g.type)) continue
      if (hits.some(h => overlap(h, g))) mask.tp++
      else mask.fn++
    }
  }
  const prf = (x) => {
    const p = x.tp + x.fp === 0 ? 1 : x.tp / (x.tp + x.fp)
    const rc = x.tp + x.fn === 0 ? 1 : x.tp / (x.tp + x.fn)
    return { ...x, precision: p, recall: rc, f1: p + rc === 0 ? 0 : (2 * p * rc) / (p + rc) }
  }
  const perRule = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, prf(v)]))
  const micro = prf(Object.values(per).reduce((a, v) => ({ tp: a.tp + v.tp, fp: a.fp + v.fp, fn: a.fn + v.fn }), { tp: 0, fp: 0, fn: 0 }))
  const exactTotal = Object.values(per).reduce((a, v) => a + v.exact, 0)
  const negFP = [...bySection.entries()].filter(([s]) => s.startsWith("neg/")).reduce((a, [, v]) => a + v.fp, 0)
  return { rules, perRule, micro, masking: prf(mask), exactRate: micro.tp ? exactTotal / micro.tp : 1, negFP, bySection, errors }
}

const f3 = (x) => x.toFixed(3)
function printEval(name, ev) {
  console.log(`\n### 프로필 ${name} — 룰: ${ev.rules.join(",")}`)
  console.log("룰        TP   FP   FN   P      R      F1     exact")
  for (const [k, v] of Object.entries(ev.perRule)) {
    if (v.tp + v.fp + v.fn === 0) continue
    console.log(`${k.padEnd(9)} ${String(v.tp).padStart(3)}  ${String(v.fp).padStart(3)}  ${String(v.fn).padStart(3)}  ${f3(v.precision)}  ${f3(v.recall)}  ${f3(v.f1)}  ${v.tp ? f3(v.exact / v.tp) : "  -  "}`)
  }
  const m = ev.micro
  console.log(`micro     ${String(m.tp).padStart(3)}  ${String(m.fp).padStart(3)}  ${String(m.fn).padStart(3)}  ${f3(m.precision)}  ${f3(m.recall)}  ${f3(m.f1)}  ${f3(ev.exactRate)}`)
  const k = ev.masking
  console.log(`masking   ${String(k.tp).padStart(3)}  ${String(k.fp).padStart(3)}  ${String(k.fn).padStart(3)}  ${f3(k.precision)}  ${f3(k.recall)}  ${f3(k.f1)}   (유형 무관)`)
  console.log(`음성 절(neg/*) 오탐: ${ev.negFP}`)
}

// ─── 실행: synthetic ─────────────────────────────────
const cases = parseCases(await readFile(join(root, "redact/cases.md"), "utf8"))
const goldCount = cases.reduce((a, c) => a + c.gold.length, 0)
console.log(`# redact 벤치 — 합성 케이스 ${cases.length}개 (정답 스팬 ${goldCount}, 음성 케이스 ${cases.filter(c => c.gold.length === 0).length})`)
console.log(`모듈: ${modPath.replace(/^file:\/\//, "")}`)

const evals = {
  default: evaluate(cases, [...DEFAULT_REDACT_RULES]),
  all: evaluate(cases, [...ALL_RULES]),
}
for (const [name, ev] of Object.entries(evals)) printEval(name, ev)

// 표면형(절)별 재현율 — all 프로필
console.log("\n### 절별 (all 프로필) — 정답 찾음/전체, 오탐")
for (const [s, v] of evals.all.bySection) {
  if (v.gold === 0 && v.fp === 0 && !verbose) continue
  console.log(`  ${s.padEnd(20)} ${v.gold ? `${v.found}/${v.gold}` : "  - "}${v.fp ? `  FP ${v.fp}` : ""}`)
}
const errs = evals.all.errors.filter(e => verbose || e.kind !== "boundary")
if (errs.length) {
  console.log(`\n### 오류 (all 프로필${verbose ? "" : ", 경계 차이 제외 — --verbose 로 전부"}) ${errs.length}건`)
  for (const e of errs) console.log(`  [${e.kind}] ${e.section} ${e.type ?? e.rule}: ${JSON.stringify(e.gold ?? e.got)}${e.got && e.gold ? ` → ${JSON.stringify(e.got)}` : ""}`)
}

// ─── 실행: random (시드 고정 난수 표면형) ─────────────
// 손으로 쓴 cases.md 는 룰과 같은 사람이 만들어 표면형 회귀만 지킨다. 여기서는 값 자체를 난수로 —
// 유효한 생년월일·체크섬·국번을 무작위로 뽑아 모양·구분자·문맥 조합을 섞고, 음성은 날짜·금액·코드·
// 연도 범위 난수. 값은 실행 중에만 만들고 파일로 남기지 않는다.
const randomN = Number(opt("random") ?? 3000)
let randomReport = null
if (randomN > 0) randomReport = runRandom(randomN, Number(opt("seed") ?? 20260923))

function runRandom(n, seed0) {
  let seed = seed0 >>> 0 // mulberry32 — 시드마다 독립 수열
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const ri = (k) => Math.floor(rnd() * k)
  const pick = (arr) => arr[ri(arr.length)]
  const dg = (k) => Array.from({ length: k }, () => ri(10)).join("")
  const pad = (x, k) => String(x).padStart(k, "0")
  const fw = (s) => s.replace(/[0-9-]/g, (c) => c === "-" ? "－" : String.fromCharCode(c.charCodeAt(0) + 0xfee0))
  const luhnFix = (body) => { for (let c = 0; c < 10; c++) { const s2 = body + c; let sum = 0; for (let i = 0; i < s2.length; i++) { let d = +s2[s2.length - 1 - i]; if (i % 2) { d *= 2; if (d > 9) d -= 9 } sum += d } if (sum % 10 === 0) return s2 } }
  const brnFix = (d9) => { const w = [1, 3, 7, 1, 3, 7, 1, 3, 5]; let s2 = 0; for (let i = 0; i < 9; i++) s2 += w[i] * +d9[i]; s2 += Math.floor(+d9[8] * 5 / 10); return d9 + ((10 - s2 % 10) % 10) }
  const dim = (y, m) => [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  const GEN = {
    rrn: () => {
      const foreign = rnd() < 0.2
      const y = 1930 + ri(96), m = 1 + ri(12), d = 1 + ri(dim(y, m))
      const g = (y >= 2000 ? (foreign ? pick([7, 8]) : pick([3, 4])) : (foreign ? pick([5, 6]) : pick([1, 2])))
      const front = pad(y % 100, 2) + pad(m, 2) + pad(d, 2), back = g + dg(6)
      const form = ri(5)
      const label = foreign ? pick(["외국인등록번호", "외국인등록번호:"]) : pick(["주민등록번호", "주민번호:", "주민등록번호 :"])
      if (form === 0) return [`${label} `, front + back, ""]
      if (form === 1) return ["신청인(", `${front}-${back}`, ")의 서류"]
      if (form === 2) return [`${label} `, `${front} - ${back}`, ""]
      if (form === 3) return [`${label} `, fw(`${front}-${back}`), ""]
      return [`${label} `, `${front}–${back}`, " 확인"]
    },
    phone: () => {
      const form = ri(9)
      const sub = () => { let x; do x = dg(4); while (x === "0000"); return x }
      if (form === 0) return ["연락처 ", `010-${sub()}-${sub()}`, ""]
      // 서식 칸에 손으로 친 공백 섞인 구분자·그 밖의 줄표 글자 (적대적 검토 MED-6)
      if (form === 7) { const [a, b] = pick([[" - ", "-"], ["- ", "-"], ["-", " -"], [" ", "-"]]); return [pick(["연락처 ", "휴대폰: "]), `010${a}${sub()}${b}${sub()}`, ""] }
      if (form === 8) { const d = pick(["‐", "─", "ㅡ", "－", "–"]); return ["전화 ", `0${pick(["10", "2", "31", "51"])}${d}${String(2 + ri(8)) + dg(3)}${d}${sub()}`, ""] }
      if (form === 1) { const sep = pick([".", " ", ""]); return ["휴대폰 ", `010${sep}${sub()}${sep}${sub()}`, ""] }
      const area = pick(["02", "031", "032", "033", "041", "042", "043", "044", "051", "052", "053", "054", "055", "061", "062", "063", "064"])
      const mid = String(2 + ri(8)) + dg(pick([2, 3]))
      if (form === 2) return ["☎ ", `${area}-${mid}-${sub()}`, ""]
      if (form === 3) return ["문의처 ", `(${area}) ${mid}-${sub()}`, ""]
      if (form === 4) return ["Tel. ", `+82 ${area.slice(1)}-${mid}-${sub()}`, ""]
      if (form === 5) return ["고객센터 ", `${pick(["1588", "1577", "1644", "1661", "1899", "1522"])}-${sub()}`, ""]
      return ["인터넷전화 ", `070-${String(2 + ri(8)) + dg(3)}-${sub()}`, ""]
    },
    email: () => {
      const local = pick(["hong", "kim.cs", "gd_lee", "park-01", "choi+tag", "user2026"]) + dg(ri(3))
      return [pick(["문의: ", "이메일 ", "메일(", "전자우편: "]), `${local}@${pick(["example.com", "example.co.kr", "example.org", "mail.example.net"])}`, pick(["", ")", "입니다", "."])]
    },
    card: () => {
      if (rnd() < 0.2) { const n = luhnFix(pick(["34", "37"]) + dg(12)); const sep = pick(["-", " "]); return ["카드번호 ", `${n.slice(0, 4)}${sep}${n.slice(4, 10)}${sep}${n.slice(10)}`, ""] }
      let n; do n = luhnFix(pick(["4", "5", "9410", "6243", "3569", "4518"]).padEnd(15, "x").replace(/x/g, () => String(ri(10)))); while (/^(\d)\1+$/.test(n))
      const sep = pick(["-", " "])
      return [pick(["카드번호 ", "결제카드: ", "법인카드 "]), n.match(/.{4}/g).join(sep), ""]
    },
    account: () => {
      const fmt = pick([[3, 3, 6], [6, 2, 6], [4, 3, 6], [3, 6, 5], [3, 4, 4, 2], [3, 6, 2, 3], [4, 2, 7], [4, 4, 4], [3, 2, 6], [4, 4, 4, 1], [3, 2, 6, 1], [3, 3, 6, 1]])
      const groups = fmt.map((k, i) => (i === 0 ? String(1 + ri(9)) + dg(k - 1) : dg(k)))
      if (groups.slice(1).every((x) => /^0+$/.test(x))) groups[1] = "1".padEnd(groups[1].length, "2")
      return [pick(["입금계좌: ○○은행 ", "계좌번호 ", "환급계좌 ", ""]), groups.join("-"), pick(["", " (예금주 홍길동)"])]
    },
    brn: () => {
      const d = brnFix(String(1 + ri(9)) + dg(2) + pad(1 + ri(98), 2) + dg(4))
      return [pick(["사업자등록번호 ", "업체(", "사업자번호: "]), `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`, pick(["", ")"])]
    },
    passport: () => rnd() < 0.5 ? ["여권번호 ", pick("MSROD") + dg(8), ""] : ["여권 ", pick("MSROD") + dg(3) + String.fromCharCode(65 + ri(26)) + dg(4), " 발급"],
    driver: () => ["운전면허번호 ", `${11 + ri(18)}-${dg(2)}-${dg(6)}-${dg(2)}`, ""],
  }
  const NEG = [
    () => `시행일: ${2000 + ri(30)}-${pad(1 + ri(12), 2)}-${pad(1 + ri(28), 2)}.`,
    () => `기간 ${2000 + ri(30)}.${pad(1 + ri(12), 2)}.${pad(1 + ri(28), 2)}.~${2000 + ri(30)}.${pad(1 + ri(12), 2)}.${pad(1 + ri(28), 2)}.`,
    () => `금 ${(ri(9) + 1)},${dg(3)},${dg(3)},${dg(3)}원`,
    () => `| ${2000 + ri(30)} | ${ri(999)},${dg(3)} | ${ri(99)}.${ri(10)}% |`,
    () => `제${1 + ri(200)}조의${1 + ri(9)}제${1 + ri(9)}항`,
    () => `NCS 능력단위(${pad(ri(30), 2)}${dg(8)}_${pad(ri(30), 2)}v${1 + ri(5)})`,
    () => { const a = 1500 + ri(400); return `(${a}-${Math.min(2026, a + ri(160))})` },
    () => `예산과목 ${1000 + ri(9000)}-${100 + ri(900)}-${100 + ri(900)}(일반연구비)`,
    () => `☞ : 0${60 + ri(5)}-${1000 + ri(9000)}-${1000 + ri(9000)}-${100 + ri(900)}-${100 + ri(900)} : 사업`,
    () => `【출원번호】 ${pick(["10", "20", "30", "40"])}-${2000 + ri(26)}-${dg(7)}`,
    () => `좌표 ${30 + ri(10)}.${dg(4)}, ${120 + ri(10)}.${dg(4)}`,
    () => `${ri(24)}:${pad(ri(60), 2)}-${ri(24)}:${pad(ri(60), 2)}`,
    () => `문서번호 ${pick(["행정지원과", "정보화담당관", "민원여권과"])}-${ri(99999)}(${2000 + ri(26)}. ${1 + ri(12)}. ${1 + ri(28)}.)`,
    () => `ISBN 979-11-${dg(4)}-${dg(3)}-${ri(10)}`,
    () => `v${ri(10)}.${ri(20)}.${ri(10)}.${ri(10)}`,
    // 적대적 검토 LOW-15 — 날짜 부호 일련번호·기기 일련번호·부품 번호·접수번호·대표번호 자리표시자
    () => `관리번호 ${2000 + ri(26)}-${pad(1 + ri(12), 2)}${pad(1 + ri(28), 2)}-${dg(6)}`,
    () => `S/N ${dg(4)}-${dg(4)}-${dg(4)}`,
    () => `${pick("SMRG")}${dg(3)}${pick("ABC")}${dg(4)} 부품 교체`,
    () => `${11 + ri(18)}-${dg(2)}-${dg(6)}-${dg(2)} (접수)`,
    () => `대표번호 ${pick(["1588", "1577", "1644"])}-0000`,
  ]
  const types = Object.keys(GEN)
  const per = Object.fromEntries(types.map((t) => [t, { gold: 0, found: 0 }]))
  let negFP = 0, posFP = 0
  const misses = [], fps = []
  for (let i = 0; i < n; i++) {
    const t = types[i % types.length]
    const [pre, val, post] = GEN[t]()
    const text = pre + val + post
    const hits = redactMarkdown(text, { rules: NUMBER_RULES }).hits
    per[t].gold++
    const ok = hits.some((h) => h.rule === t && h.index <= pre.length && h.index + h.length >= pre.length + val.length)
    if (ok) per[t].found++
    else if (misses.length < 12) misses.push(`${t}: ${JSON.stringify(text)} → ${JSON.stringify(hits.map((h) => h.rule))}`)
    posFP += hits.filter((h) => h.index + h.length <= pre.length || h.index >= pre.length + val.length).length
    const neg = NEG[i % NEG.length]()
    const nh = redactMarkdown(neg, { rules: NUMBER_RULES }).hits
    negFP += nh.length
    if (nh.length && fps.length < 12) fps.push(`${JSON.stringify(neg)} → ${nh.map((h) => h.rule).join(",")}`)
  }
  // 나열 — 라벨은 첫 값 앞에만, 값끼리는 쉼표·세미콜론·빗금·온점으로 붙인다 (적대적 검토 MED-6)
  per.list = { gold: 0, found: 0 }
  const LIST_TYPES = ["phone", "email", "rrn", "account"]
  for (let i = 0; i < Math.ceil(n / 8); i++) {
    const t = LIST_TYPES[i % LIST_TYPES.length]
    let [pre, v1] = GEN[t]()
    const v2 = GEN[t]()[1]
    // 라벨 없는 쉼표 숫자 나열은 계좌로 보지 않는다(1,234-… 오탐 방지) — 나열은 라벨 아래에서만 잰다
    if (t === "account" && !/계좌|은행/.test(pre)) pre = "계좌번호 "
    // 온점 나열은 둘째 값이 하이픈 번호이고 첫 값이 온점 구분이 아닐 때만 — "5678.1588-1234"·
    // "6789.01012345678"·"010.1234.5678.070-…" 는 소수·점 코드와 구별되지 않아 계약상 미탐(보고서 9장)
    const dotOk = t === "phone" && /^0\d{1,2}-/.test(v2) && !v1.includes(".")
    const sep = pick([",", ", ", ";", "/", dotOk ? "." : ","])
    const text = pre + v1 + sep + v2
    const hits = redactMarkdown(text, { rules: NUMBER_RULES }).hits
    for (const [a, b] of [[pre.length, pre.length + v1.length], [pre.length + v1.length + sep.length, text.length]]) {
      per.list.gold++
      if (hits.some((h) => h.index <= a && h.index + h.length >= b)) per.list.found++
      else if (misses.length < 12) misses.push(`list/${t}: ${JSON.stringify(text)} → ${JSON.stringify(hits.map((h) => h.rule))}`)
    }
  }
  console.log(`\n### 난수 표면형 (시드 ${seed0}, 양성 ${n} + 나열 ${per.list.gold} · 음성 ${n}) — 번호형 룰 전부`)
  for (const t of [...types, "list"]) console.log(`  ${t.padEnd(9)} 재현 ${per[t].found}/${per[t].gold} (${f3(per[t].found / per[t].gold)})`)
  console.log(`  음성 오탐 ${negFP} · 양성 문장 주변 오탐 ${posFP}`)
  for (const m of misses) console.log(`  [miss] ${m}`)
  for (const f of fps) console.log(`  [fp] ${f}`)
  const recall = Object.values(per).reduce((a, v) => a + v.found, 0) / Object.values(per).reduce((a, v) => a + v.gold, 0)
  return { n, seed: seed0, recall, negFP, posFP, per }
}

// ─── 실행: external (스키프트 외부 정답) ───────────────
// 채점: 정답과 같은 유형 룰의 탐지가 겹치면 TP(탐지 하나는 한 번만), 남는 탐지는 룰별 FP. exact 는 TP 중 [시작,끝)
// 이 정답과 같은 비율(인명 "서윤은"처럼 조사까지 덮으면 겹침 TP 지만 exact 아님). 기관명 정답은 모수 밖 — 기관명과
// 겹친 탐지는 FP 로 세고 그 수를 따로 보인다. 부정 예(negative·N01~N04)의 FP 는 게이트
const SCHIFT_TYPE = { private_person: "name", private_address: "address", private_phone: "phone", private_email: "email", resident_id: "rrn" }
const EXTERNAL_TYPES = ["name", "address", "phone", "email", "rrn"]
const isNegativeCategory = (c) => c === "negative" || /^N\d/.test(c)
const prfOf = (x) => {
  const p = x.tp + x.fp === 0 ? 1 : x.tp / (x.tp + x.fp)
  const rc = x.tp + x.fn === 0 ? 1 : x.tp / (x.tp + x.fn)
  return { ...x, precision: p, recall: rc, f1: p + rc === 0 ? 0 : (2 * p * rc) / (p + rc) }
}
let externalReport = null
if (!flag("no-schift")) externalReport = await runSchift(opt("schift") ?? join(root, "corpus/schift/benchmark_v3.jsonl"))

async function runSchift(path) {
  let src
  try { src = await readFile(path, "utf8") } catch {
    console.log(`\n### 외부 정답 (스키프트) — SKIP: ${path} 없음 (node bench/collect-schift.mjs 로 받거나 --schift=경로)`)
    return null
  }
  const rows = src.trim().split("\n").map((l) => JSON.parse(l))
  const per = Object.fromEntries(ALL_RULES.map((r) => [r, { tp: 0, fp: 0, fn: 0, exact: 0 }]))
  const cat = new Map()
  let orgGold = 0, orgOverlap = 0
  const errors = []
  for (const r of rows) {
    const hits = redactText(r.text, { rules: [...ALL_RULES] }).hits.map((h) => ({ rule: h.rule, start: h.index, end: h.index + h.length }))
    const c = cat.get(r.category) ?? { gold: 0, found: 0, fp: 0 }
    cat.set(r.category, c)
    const used = new Set()
    for (const [s0, e0, lab] of r.spans) {
      const t = SCHIFT_TYPE[lab]
      if (!t) { if (lab === "private_organization") orgGold++; continue }
      c.gold++
      const i = hits.findIndex((h, k) => !used.has(k) && h.rule === t && h.start < e0 && s0 < h.end)
      if (i >= 0) {
        used.add(i)
        per[t].tp++
        c.found++
        if (hits[i].start === s0 && hits[i].end === e0) per[t].exact++
      } else {
        per[t].fn++
        errors.push(`[놓침 ${t}] ${r.category}: ${r.text.slice(0, s0)}⟦${r.text.slice(s0, e0)}⟧${r.text.slice(e0)}`)
      }
    }
    hits.forEach((h, k) => {
      if (used.has(k)) return
      per[h.rule].fp++
      c.fp++
      const org = r.spans.some(([s0, e0, lab]) => lab === "private_organization" && h.start < e0 && s0 < h.end)
      if (org) orgOverlap++
      errors.push(`[오탐 ${h.rule}${org ? "·기관명" : ""}] ${r.category}: ${r.text.slice(0, h.start)}⟦${r.text.slice(h.start, h.end)}⟧${r.text.slice(h.end)}`)
    })
  }
  const perType = Object.fromEntries(EXTERNAL_TYPES.map((t) => [t, prfOf(per[t])]))
  const others = Object.entries(per).filter(([k, v]) => !EXTERNAL_TYPES.includes(k) && v.fp > 0)
  const micro = prfOf(Object.values(per).reduce((a, v) => ({ tp: a.tp + v.tp, fp: a.fp + v.fp, fn: a.fn + v.fn }), { tp: 0, fp: 0, fn: 0 }))
  const exactTotal = EXTERNAL_TYPES.reduce((a, t) => a + per[t].exact, 0)
  const negativeFP = [...cat.entries()].filter(([k]) => isNegativeCategory(k)).reduce((a, [, v]) => a + v.fp, 0)
  console.log(`\n### 외부 정답 (스키프트 benchmark_v3, ${rows.length}문장) — all 룰, 기관명 ${orgGold}개는 모수 밖`)
  console.log("유형      TP   FP   FN   P      R      F1     exact")
  for (const t of EXTERNAL_TYPES) {
    const v = perType[t]
    console.log(`${t.padEnd(9)} ${String(v.tp).padStart(3)}  ${String(v.fp).padStart(3)}  ${String(v.fn).padStart(3)}  ${f3(v.precision)}  ${f3(v.recall)}  ${f3(v.f1)}  ${v.tp ? f3(v.exact / v.tp) : "  -  "}`)
  }
  for (const [k, v] of others) console.log(`${k.padEnd(9)}   -  ${String(v.fp).padStart(3)}    -  (정답 유형 밖 룰의 오탐)`)
  console.log(`micro     ${String(micro.tp).padStart(3)}  ${String(micro.fp).padStart(3)}  ${String(micro.fn).padStart(3)}  ${f3(micro.precision)}  ${f3(micro.recall)}  ${f3(micro.f1)}  ${f3(micro.tp ? exactTotal / micro.tp : 1)}`)
  console.log(`기관명 스팬과 겹친 탐지(오탐으로 셈): ${orgOverlap} · 부정 예 오탐: ${negativeFP}`)
  console.log("범주별 — 찾음/정답, 오탐")
  for (const [k, v] of [...cat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${k.padEnd(24)} ${v.gold ? `${v.found}/${v.gold}` : "  - "}${v.fp ? `  FP ${v.fp}` : ""}`)
  }
  if (verbose) for (const e of errors) console.log(`  ${e}`)
  else if (errors.length) console.log(`  (놓침·오탐 ${errors.length}건 — --verbose 로 목록)`)
  return { rows: rows.length, perType, micro, exactRate: micro.tp ? exactTotal / micro.tp : 1, orgGold, orgOverlap, negativeFP,
    categories: Object.fromEntries(cat) }
}

// ─── 실행: corpus ────────────────────────────────────
const corpusOpt = args.find(a => a === "--corpus" || a.startsWith("--corpus="))
let corpusReport = null
if (corpusOpt) {
  // 기본: 코퍼스 전체(하위 폴더까지). 지정: 폴더[:확장자,…] 목록
  const dirs = corpusOpt.includes("=") ? corpusOpt.split("=")[1].split(",") : [""]
  corpusReport = await runCorpus(dirs)
}

/** 폴더 아래 모든 파일 — 하위 폴더·심링크까지 (같은 실경로는 한 번만) */
async function walk(dir, seen = new Set()) {
  let real
  try { real = await realpath(dir) } catch { return [] }
  if (seen.has(real)) return []
  seen.add(real)
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    let isDir = e.isDirectory(), isFile = e.isFile()
    if (e.isSymbolicLink()) { try { const st = await stat(p); isDir = st.isDirectory(); isFile = st.isFile() } catch { continue } }
    if (isDir) out.push(...await walk(p, seen))
    else if (isFile) out.push(p)
  }
  return out.sort()
}

async function runCorpus(specs) {
  const { parse } = mod
  const rules = opt("corpus-rules") ? opt("corpus-rules").split(",") : [...DEFAULT_REDACT_RULES]
  const corpus = join(root, "corpus")
  const cacheDir = opt("cache")
  const tally = {}, byDir = {}, shapes = {}, dump = []
  let docs = 0, fails = 0
  const t0 = Date.now()
  const seenFiles = new Set()
  for (const spec of specs) {
    const [dir, extsRaw] = spec.split(":")
    const exts = (extsRaw ?? "hwpx,hwp,pdf,docx,xlsx,hml").split(",")
    const files = (await walk(join(corpus, dir))).filter(f => exts.includes(extname(f).slice(1).toLowerCase()))
    for (const path of files) {
      const rel = relative(corpus, path)
      if (seenFiles.has(rel)) continue
      seenFiles.add(rel)
      const top = rel.split(sep)[0]
      let md = null
      const cachePath = cacheDir ? join(cacheDir, rel + ".md") : null
      if (cachePath) { try { md = await readFile(cachePath, "utf8") } catch { /* 캐시 없음 */ } }
      if (md === null) {
        try {
          // 문서 하나가 멈춰도 전체가 서지 않게 60초 제한 (OCR 이 도는 스캔 PDF 등)
          const r = await Promise.race([
            parse(await readFile(path), { filePath: path }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 60000).unref()),
          ])
          if (!r.success) { fails++; continue }
          md = r.markdown
          if (cachePath) { await mkdir(dirname(cachePath), { recursive: true }); await writeFile(cachePath, md) }
        } catch { fails++; continue }
      }
      docs++
      const f = rel
      const dir = top
      const r = redactMarkdown(md, { rules })
      for (const h of r.hits) {
        tally[h.rule] = (tally[h.rule] ?? 0) + 1
        byDir[dir] ??= {}
        byDir[dir][h.rule] = (byDir[dir][h.rule] ?? 0) + 1
        const raw = md.slice(h.index, h.index + h.length)
        const shape = `${h.rule}:${raw.replace(/\d/g, "9").replace(/[A-Za-z]/g, "a").replace(/[가-힣]/g, "가")}`
        shapes[shape] = (shapes[shape] ?? 0) + 1
        dump.push({ dir, file: f, rule: h.rule, raw, context: md.slice(Math.max(0, h.index - 40), h.index + h.length + 25).replace(/\s+/g, " ") })
      }
    }
  }
  console.log(`\n### 코퍼스 (룰: ${opt("corpus-rules") ? rules.join(",") : "기본 룰셋"}) — 문서 ${docs} (파싱 실패 ${fails}), ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  console.log(`룰별 탐지: ${JSON.stringify(tally)}`)
  for (const [d, t] of Object.entries(byDir)) console.log(`  ${d.padEnd(16)} ${JSON.stringify(t)}`)
  console.log("상위 모양 (숫자→9, 영문→a):")
  for (const [s, n] of Object.entries(shapes).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(5)}  ${s}`)
  const dumpPath = opt("dump")
  if (dumpPath) {
    // 원문 표본에는 실문서의 실제 번호가 들어 있다 — gitignore 된 bench/out 아래에만 쓸 것
    await mkdir(dirname(dumpPath), { recursive: true })
    await writeFile(dumpPath, JSON.stringify(dump, null, 1))
    console.log(`표본 ${dump.length}건 → ${dumpPath}`)
  }
  return { docs, fails, tally, byDir }
}

// ─── JSON · 게이트 ───────────────────────────────────
const jsonPath = opt("json")
if (jsonPath) {
  const slim = (ev) => ({ rules: ev.rules, perRule: ev.perRule, micro: ev.micro, masking: ev.masking, exactRate: ev.exactRate, negFP: ev.negFP })
  await writeFile(jsonPath, JSON.stringify({ cases: cases.length, gold: goldCount, default: slim(evals.default), all: slim(evals.all), random: randomReport, external: externalReport, corpus: corpusReport }, null, 2))
}

if (gateMode) {
  const fails = []
  const a = evals.all, d = evals.default
  if (a.micro.f1 < GATES.all.microF1) fails.push(`all micro F1 ${f3(a.micro.f1)} < ${GATES.all.microF1}`)
  if (a.micro.precision < GATES.all.microPrecision) fails.push(`all micro P ${f3(a.micro.precision)} < ${GATES.all.microPrecision}`)
  for (const [k, v] of Object.entries(a.perRule)) {
    if (v.tp + v.fn === 0) continue
    if (v.f1 < GATES.all.minRuleF1) fails.push(`all ${k} F1 ${f3(v.f1)} < ${GATES.all.minRuleF1}`)
  }
  if (d.micro.f1 < GATES.default.microF1) fails.push(`default micro F1 ${f3(d.micro.f1)} < ${GATES.default.microF1}`)
  if (d.micro.precision < GATES.default.microPrecision) fails.push(`default micro P ${f3(d.micro.precision)} < ${GATES.default.microPrecision}`)
  if (d.negFP > GATES.default.negFP) fails.push(`default 음성 절 오탐 ${d.negFP} > ${GATES.default.negFP}`)
  if (randomReport) {
    if (randomReport.recall < GATES.random.recall) fails.push(`난수 재현율 ${f3(randomReport.recall)} < ${GATES.random.recall}`)
    if (randomReport.negFP + randomReport.posFP > GATES.random.fp) fails.push(`난수 오탐 ${randomReport.negFP + randomReport.posFP} > ${GATES.random.fp}`)
  }
  if (externalReport) {
    for (const t of EXTERNAL_TYPES) {
      const v = externalReport.perType[t], g = GATES.external[t]
      if (v.precision < g.precision) fails.push(`외부 정답 ${t} P ${f3(v.precision)} < ${g.precision}`)
      if (v.recall < g.recall) fails.push(`외부 정답 ${t} R ${f3(v.recall)} < ${g.recall}`)
    }
    if (externalReport.negativeFP > GATES.external.negativeFP) fails.push(`외부 정답 부정 예 오탐 ${externalReport.negativeFP} > ${GATES.external.negativeFP}`)
  }
  if (fails.length) {
    console.log(`\n❌ 게이트 실패:\n  ${fails.join("\n  ")}`)
    process.exit(1)
  }
  console.log("\n✅ 게이트 통과")
}
