/**
 * 견본 HWPX 의 항목부호 단계별 서식 — 기관마다 □·ㅇ·- (또는 1. 가. 1)) 단계의 글꼴·크기·굵기 관행이 달라, 그 기관 문서
 * 한 벌에서 배워 generate 의 단계별 위계 타이포(GongmunOptions.levels, `--levels`)로 넘긴다. 같은 단계인데 서식이 다른
 * 문단(편차)도 함께 낸다(`kordoc lint --styles`).
 *
 * 문단 단계는 생성 엔진과 같은 부호 해석(outline.parseLeadingMarker)으로, 서식은 부호 뒤 첫 글자가 든 글자 모양으로 잰다.
 * 칸이 여럿인 데이터 표 안 문단은 표 서식(작은 글씨 '-' 항목 등)이라 빼고, 본문을 담는 1×1 틀 상자 안 문단은 남긴다.
 * 대표값은 단계·속성마다 표본 MIN_SAMPLES 개 이상이고 한 값이 MIN_SHARE 이상일 때만 정한다 — 섞여 쓴 속성은 비워 엔진
 * 기본을 따르게 한다. □·ㅇ·- 계열과 법정 계열 가운데 표본이 많은 쪽을 문서의 계열로 본다.
 * 착안·임계값: hwp-auto-docfit style_unify.py·document_review.py (MIT, THIRD_PARTY/hwp-auto-docfit.LICENSE)
 */

import JSZip from "jszip"
import type { Element as XmlElement } from "@xmldom/xmldom"
import { extractHwpxStyles } from "./styles.js"
import { resolveSectionPaths } from "./zip-sections.js"
import { parseLeadingMarker } from "./outline.js"
import { createXmlParser, readZipEntry } from "./parser-shared.js"
import { KordocError, stripDtd, precheckZipSize } from "../utils.js"
import { detectFormat } from "../detect.js"
import type { GongmunLevelStyle } from "./gongmun.js"

const MIN_SAMPLES = 3
const MIN_SHARE = 0.6

/** 한 문단의 단계 서식 표본 */
interface LevelSample {
  scheme: "box" | "legal"
  depth: number
  marker: string
  text: string
  font?: string
  pt?: number
  bold: boolean
}

export interface LevelStat {
  scheme: "box" | "legal"
  depth: number
  /** 이 단계에 쓰인 부호 (등장 순) */
  markers: string[]
  samples: number
  /** 속성별 값 → 문단 수 */
  font: Record<string, number>
  pt: Record<string, number>
  bold: Record<string, number>
}

export interface LevelDeviation {
  depth: number
  /** 문단 앞 40자 */
  text: string
  got: GongmunLevelStyle
  expected: GongmunLevelStyle
}

export interface LevelStyleReport {
  /** 표본을 잴 수 없었던 사유 (글자 모양 정의가 없는 HWPX 등) */
  note?: string
  /** 문서의 부호 계열 — 표본 없으면 null */
  scheme: "box" | "legal" | null
  /** 대표값이 정해진 단계·속성만 (generate levels 입력) */
  levels: Record<string, GongmunLevelStyle>
  /** `--levels` 문자열 ("0=HY견고딕/17/bold,1=…") — 대표값이 없으면 "" */
  spec: string
  stats: LevelStat[]
  /** 대표값과 다른 문단 (문서 계열만) */
  deviations: LevelDeviation[]
}

const local = (n: { nodeName: string }): string => n.nodeName.replace(/^.*:/, "")

/** <hp:t> 글 — 탭 요소는 "\t" (항목부호 뒤는 공백이 아니라 탭인 문서가 많다: "□<hp:tab/>" + "첫째 대항목") */
function runText(t: XmlElement): string {
  let out = ""
  for (let n = t.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) out += n.nodeValue ?? ""
    else if (n.nodeType === 1 && local(n) === "tab") out += "\t"
  }
  return out
}

/** 칸이 여럿인 표 안 문단 — 가장 가까운 표의 행·열 수로 (1×1 틀 상자는 본문으로 본다) */
function inDataTable(p: XmlElement): boolean {
  for (let n = p.parentNode as XmlElement | null; n; n = n.parentNode as XmlElement | null) {
    if (n.nodeType === 1 && local(n) === "tbl") {
      const el = n
      return Number(el.getAttribute("rowCnt") ?? 1) * Number(el.getAttribute("colCnt") ?? 1) > 1
    }
  }
  return false
}

/** 글자 모양 id → 한글 글꼴명 — 한컴 HWPX 는 글꼴을 번호(<hh:fontRef hangul="1">)로 가리키고 이름은 글꼴 목록
 *  (<hh:fontface lang="HANGUL"><hh:font id face>)에 둔다 */
function hangulFaces(headerXml: string): Map<string, string> {
  const doc = createXmlParser().parseFromString(stripDtd(headerXml), "text/xml")
  const faces = new Map<string, string>()
  const fontfaces = doc.getElementsByTagNameNS("*", "fontface")
  for (let i = 0; i < fontfaces.length; i++) {
    if (fontfaces[i].getAttribute("lang") !== "HANGUL") continue
    const fonts = fontfaces[i].getElementsByTagNameNS("*", "font")
    for (let k = 0; k < fonts.length; k++) faces.set(fonts[k].getAttribute("id") ?? "", fonts[k].getAttribute("face") ?? "")
  }
  const out = new Map<string, string>()
  const charPrs = doc.getElementsByTagNameNS("*", "charPr")
  for (let i = 0; i < charPrs.length; i++) {
    const ref = charPrs[i].getElementsByTagNameNS("*", "fontRef")[0]
    const face = ref ? faces.get(ref.getAttribute("hangul") ?? "") : undefined
    if (face) out.set(charPrs[i].getAttribute("id") ?? "", face)
  }
  return out
}

/** 견본 HWPX → 단계별 대표 서식과 편차 */
export async function extractLevelStyles(buffer: ArrayBuffer): Promise<LevelStyleReport> {
  const format = detectFormat(buffer)
  if (format !== "hwpx") throw new KordocError(`단계별 서식은 HWPX 견본에서만 잽니다 (감지된 포맷: ${format}) — 한글에서 HWPX 로 저장해 넘기세요`)
  precheckZipSize(buffer)
  const zip = await JSZip.loadAsync(buffer)
  const decompressed = { total: 0 }
  const styles = await extractHwpxStyles(zip, decompressed)
  const header = zip.file("Contents/header.xml") ?? zip.file("Contents/head.xml")
  const faces = header ? hangulFaces(await readZipEntry(header, "text", decompressed.total)) : new Map<string, string>()
  const samples: LevelSample[] = []
  for (const path of await resolveSectionPaths(zip)) {
    const file = zip.file(path)
    if (!file) continue
    const xml = await readZipEntry(file, "text", decompressed.total)
    decompressed.total += xml.length * 2
    const doc = createXmlParser().parseFromString(stripDtd(xml), "text/xml")
    const paras = doc.getElementsByTagNameNS("*", "p")
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i]
      if (inDataTable(p)) continue
      // 문단 직속 run 만 — 칸 안 문단은 그 문단이 따로 잡힌다
      const runs: Array<{ text: string; charPr: string | null }> = []
      for (let c = p.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1 || local(c) !== "run") continue
        const el = c as unknown as Element
        let text = ""
        const ts = el.getElementsByTagNameNS("*", "t")
        for (let k = 0; k < ts.length; k++) if (ts[k].parentNode === el) text += runText(ts[k] as unknown as XmlElement)
        runs.push({ text, charPr: el.getAttribute("charPrIDRef") })
      }
      const text = runs.map(r => r.text).join("")
      const lm = parseLeadingMarker(text)
      if ((lm.kind !== "box" && lm.kind !== "legal") || !lm.rest) continue
      // 부호 뒤 첫 글자가 든 run 의 글자 모양
      const at = text.indexOf(lm.rest)
      let pos = 0, charPr: string | null = null
      for (const r of runs) {
        if (at < pos + r.text.length) { charPr = r.charPr; break }
        pos += r.text.length
      }
      const cp = charPr ? styles.charProperties.get(charPr) : undefined
      if (!cp) continue
      samples.push({ scheme: lm.kind, depth: lm.depth, marker: lm.marker, text: lm.rest, font: faces.get(charPr!) ?? cp.fontName, pt: cp.fontSize, bold: !!cp.bold })
    }
  }
  const report = summarize(samples)
  return styles.charProperties.size === 0 ? { ...report, note: "글자 모양 정의(header.xml charPr)가 없어 서식을 잴 수 없음" } : report
}

const tally = (values: Array<string | undefined>): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const v of values) if (v !== undefined) out[v] = (out[v] ?? 0) + 1
  return out
}
/** 표본 MIN_SAMPLES 이상·점유 MIN_SHARE 이상인 값 */
const dominant = (counts: Record<string, number>, total: number): string | undefined => {
  const [value, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? []
  return value !== undefined && total >= MIN_SAMPLES && n! >= total * MIN_SHARE ? value : undefined
}

function summarize(samples: LevelSample[]): LevelStyleReport {
  const box = samples.filter(s => s.scheme === "box").length, legal = samples.length - box
  const scheme = samples.length === 0 ? null : box >= legal ? "box" : "legal"
  const stats: LevelStat[] = []
  const levels: Record<string, GongmunLevelStyle> = {}
  for (const sch of ["box", "legal"] as const) {
    for (const depth of [...new Set(samples.filter(s => s.scheme === sch).map(s => s.depth))].sort((a, b) => a - b)) {
      const group = samples.filter(s => s.scheme === sch && s.depth === depth)
      const st: LevelStat = {
        scheme: sch, depth, markers: [...new Set(group.map(s => s.marker))], samples: group.length,
        font: tally(group.map(s => s.font)), pt: tally(group.map(s => s.pt?.toString())), bold: tally(group.map(s => String(s.bold))),
      }
      stats.push(st)
      if (sch !== scheme) continue
      const font = dominant(st.font, group.length), pt = dominant(st.pt, group.length), bold = dominant(st.bold, group.length)
      const style: GongmunLevelStyle = { ...(font ? { font } : {}), ...(pt ? { pt: Number(pt) } : {}), ...(bold ? { bold: bold === "true" } : {}) }
      if (Object.keys(style).length) levels[depth] = style
    }
  }
  const deviations: LevelDeviation[] = []
  for (const s of samples) {
    const want = s.scheme === scheme ? levels[s.depth] : undefined
    if (!want) continue
    const got: GongmunLevelStyle = { font: s.font, pt: s.pt, bold: s.bold }
    if ((want.font !== undefined && want.font !== s.font) || (want.pt !== undefined && want.pt !== s.pt) || (want.bold !== undefined && want.bold !== s.bold)) {
      deviations.push({ depth: s.depth, text: s.text.slice(0, 40), got, expected: want })
    }
  }
  const spec = Object.entries(levels).map(([d, st]) =>
    `${d}=${[st.font, st.pt, st.bold === undefined ? undefined : st.bold ? "bold" : "plain"].filter(v => v !== undefined).join("/")}`).join(",")
  return { scheme, levels, spec, stats, deviations }
}
