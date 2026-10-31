/**
 * HWP 5.x → HWPX 변환 — 서식 그대로 옮긴다.
 *
 * 문서 모델이 같은 두 직렬화(이진 레코드 ↔ OWPML XML)라 값을 1:1 로 옮긴다: DocInfo → header.xml, BodyText 섹션 → sectionN.xml,
 * BinData 스토리지 → BinData/imageN.확장자, 요약 정보·미리보기 글 → content.hpf·Preview. 한글이 같은 문서를 .hwpx 로 저장한 짝을
 * 정답으로 속성 단위 일치를 잰다(bench/hwp2hwpx.mjs). 암호 문서는 password 로 연다. 배포용 문서(작성자가 복사·편집을 막은 문서)는
 * 변환하지 않는다.
 */

import JSZip from "jszip"
import { createRequire } from "module"
import { openHwp5Container, readHwp5DocInfoRecords, readHwp5SectionStreams, readHwp5SectionRecords, readHwp5BinData } from "../parser.js"
import { decompressStream, readRecords } from "../record.js"
import { recordTree, Cur, el, esc, type Rec } from "./util.js"
import { headerXml, docProps, paraShapeIds, XML_DECL, NS } from "./header.js"
import { sectionXml } from "./section.js"
import type { ConvertContext } from "./controls.js"
import { VERSION, KordocError } from "../../utils.js"

export interface HwpToHwpxOptions {
  /** 암호 문서의 열기 암호 */
  password?: string
}

const require = createRequire(import.meta.url)
const CFB: { read(d: Buffer, o: { type: "buffer" }): unknown; find(c: unknown, p: string): { content?: Buffer | Uint8Array } | null } = require("cfb")

const TAG_BIN_DATA = 0x12
const TAG_MEMO_SHAPE = 0x5c

/** BIN_DATA 항목 → 패키지 이름·미디어 형식 (스토리지 id 순서) */
function binItems(docInfo: Rec[]): Array<{ index: number; storageId: number; ext: string; ole: boolean }> {
  const out: Array<{ index: number; storageId: number; ext: string; ole: boolean }> = []
  docInfo.filter(r => r.tagId === TAG_BIN_DATA).forEach((r, i) => {
    const c = new Cur(r.data)
    const a = c.u16()
    const type = a & 0x0f
    if (type === 0) return // 연결 그림 — 파일 밖
    const storageId = c.u16()
    const ext = type === 1 ? c.str() : "OLE"
    out.push({ index: i + 1, storageId, ext, ole: type === 2 })
  })
  return out
}

/** OLE 스토리지(4바이트 길이 머리 + 복합 문서)의 OOXML 차트 스트림 — 한글이 차트 개체를 저장할 때 함께 넣는다 */
function oleChartXml(data: Buffer | undefined): Buffer | null {
  if (!data || data.length < 12) return null
  try {
    const cfb = CFB.read(data.subarray(4), { type: "buffer" })
    const e = CFB.find(cfb, "OOXMLChartContents")
    return e?.content?.length ? Buffer.from(e.content) : null
  } catch {
    return null
  }
}

/** 스크립트 스트림(길이 u32 + UTF-16 글이 머리·본문 순으로) → headerScripts.js · sourceScripts.js */
function scriptParts(data: Buffer | null): [Buffer, Buffer] | null {
  if (!data || data.length < 8) return null
  const parts: Buffer[] = []
  let o = 0
  for (let i = 0; i < 2; i++) {
    if (o + 4 > data.length) return null
    const n = data.readUInt32LE(o) * 2
    o += 4
    if (o + n > data.length) return null
    parts.push(data.subarray(o, o + n))
    o += n
  }
  return [parts[0], parts[1]]
}

/** 메모 확장(MemoExtended 스트림의 0x65 기록: 개수 u32 + 메모 id·부모 id u32 쌍) → Contents/memoExtended.xml, 없으면 null */
function memoExtendedXml(raw: Buffer | null, compressed: boolean): string | null {
  if (!raw) return null
  let rec: Rec | undefined
  try { rec = readRecords(compressed ? decompressStream(raw) : raw).find(r => r.tagId === 0x65) } catch { return null }
  if (!rec || rec.data.length < 4) return null
  const c = new Cur(rec.data)
  const memos: string[] = []
  for (let n = c.u32(); n > 0 && c.rest >= 8; n--) memos.push(el("he:memo", [["id", c.u32()], ["parentId", c.u32()]]))
  return memos.length ? XML_DECL + `<he:memosEx xmlns:he="http://www.hancom.co.kr/hwpml/2021/extended">${memos.join("")}</he:memosEx>` : null
}

const V13_DEFAULT_SCRIPT = "function OnDocument_New()\r\n{\r\n\t//todo : \r\n}\r\n\r\n"

export async function hwpToHwpx(input: Uint8Array | ArrayBuffer, options?: HwpToHwpxOptions): Promise<Uint8Array> {
  const buffer = Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input)
  const c = openHwp5Container(buffer, options)
  // 배포용 문서는 작성자가 복사·편집을 막은 문서다 — 편집 가능한 HWPX 로 풀어 주지 않는다
  if (c.distribution) throw new KordocError("배포용(읽기 전용) HWP 문서는 HWPX 로 변환하지 않습니다 — 작성자가 복사·편집을 막은 문서입니다")
  const docInfo = (readHwp5DocInfoRecords(c) ?? []) as Rec[]
  const sections = readHwp5SectionRecords(c, readHwp5SectionStreams(c), c.warnings)
  const bins = readHwp5BinData(c)

  const linkDoc = c.findStream("/DocOptions/_LinkDoc")
  const link = { path: "", pageInherit: 0, footnoteInherit: 0 }
  if (linkDoc && linkDoc.length >= 520) {
    const path = linkDoc.toString("utf16le", 0, 520).replace(/\u0000[\s\S]*$/, "")
    link.path = path
    link.pageInherit = linkDoc.readUInt32LE(520) & 1
    link.footnoteInherit = linkDoc.length >= 524 ? linkDoc.readUInt32LE(520) >>> 1 & 1 : 0
  }

  const items = binItems(docInfo)
  const charts: Array<{ name: string; xml: Buffer }> = []
  const chartByBin = new Map<number, string | null>()
  // BinData 이름 — 한글처럼 처음 참조한 차례로 번호를 매긴다(header 의 그림 채우기 → 본문). OLE 스토리지는 차트든 아니든 oleN, 그 밖은 imageN
  const refs = new Map<number, { id: string; kind: "image" | "ole" }>()
  const refer = (binId: number, kind: "image" | "ole"): string => {
    let r = refs.get(binId)
    if (!r) refs.set(binId, (r = { id: `${kind}${refs.size + 1}`, kind }))
    return r.id
  }
  const ctx: ConvertContext = {
    memoShapes: docInfo.filter(r => r.tagId === TAG_MEMO_SHAPE).length,
    paraIds: paraShapeIds(docInfo),
    fields: { stack: [] },
    masterPages: [],
    tailMasters: [],
    memos: new Map(),
    linkedParas: new Map(),
    chartOf(binId) {
      if (chartByBin.has(binId)) return chartByBin.get(binId)!
      const item = items.find(b => b.index === binId)
      const xml = item?.ole ? oleChartXml(bins.get(item.storageId)?.data) : null
      const name = xml ? `Chart/chart${charts.length + 1}.xml` : null
      if (xml && name) charts.push({ name, xml })
      chartByBin.set(binId, name)
      return name
    },
    binRef: binId => refer(binId, "image"),
    oleRef: binId => refer(binId, "ole"),
  }

  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })
  zip.file("version.xml", XML_DECL + el("hv:HCFVersion", [["xmlns:hv", "http://www.hancom.co.kr/hwpml/2011/version"], ["tagetApplication", "WORDPROCESSOR"],
    ["major", 5], ["minor", 1], ["micro", 1], ["buildNumber", 0], ["os", 1], ["xmlVersion", "1.5"], ["application", "kordoc"], ["appVersion", VERSION]]),
  { compression: "STORE" })
  zip.file("Contents/header.xml", headerXml(docInfo, link, ctx.binRef, sections.length))

  const sectionNames: string[] = []
  const sectionItems: string[] = []
  sections.forEach((recs, i) => {
    const name = `Contents/section${i}.xml`
    const mp0 = ctx.masterPages.length
    zip.file(name, sectionXml(recordTree((recs ?? []) as Rec[]), ctx))
    // 구역의 바탕쪽은 매니페스트에서 그 구역 앞에 둔다(한글 저장 꼴)
    for (let k = mp0; k < ctx.masterPages.length; k++) {
      zip.file(`Contents/masterpage${k}.xml`, ctx.masterPages[k])
      sectionItems.push(el("opf:item", [["id", `masterpage${k}`], ["href", `Contents/masterpage${k}.xml`], ["media-type", "application/xml"]]))
    }
    sectionNames.push(name)
    sectionItems.push(el("opf:item", [["id", `section${i}`], ["href", name], ["media-type", "application/xml"]]))
  })
  // 참조 차례로 BinData — 확장자는 스토리지 이름(BIN0001.jpg)을 따른다. 참조 없는 항목은 뒤에 붙인다
  for (const b of items) if (!refs.has(b.index)) refer(b.index, b.ole ? "ole" : "image")
  const manifest: string[] = [el("opf:item", [["id", "header"], ["href", "Contents/header.xml"], ["media-type", "application/xml"]])]
  const memoEx = memoExtendedXml(c.findStream("/MemoExtended"), c.compressed)
  if (memoEx) {
    zip.file("Contents/memoExtended.xml", memoEx)
    manifest.push(el("opf:item", [["id", "memoextended"], ["href", "Contents/memoExtended.xml"], ["media-type", "application/xml"]]))
  }
  for (const [binId, r] of refs) {
    const b = items.find(x => x.index === binId)
    const data = b && bins.get(b.storageId)
    if (!b || !data) continue
    const ext = r.kind === "ole" ? "ole" : (/\.([^.]+)$/.exec(data.name)?.[1] ?? b.ext)
    const name = `BinData/${r.id}.${ext}`
    zip.file(name, data.data, /^(png|jpe?g|gif)$/i.test(ext) ? { compression: "STORE" } : undefined)
    manifest.push(el("opf:item", [["id", r.id], ["href", name],
      ["media-type", r.kind === "ole" ? "application/ole" : `image/${ext.toLowerCase()}`], ["isEmbeded", r.kind === "ole" ? 0 : 1]]))
  }
  manifest.push(...sectionItems)
  for (const ch of charts) zip.file(ch.name, ch.xml)
  const scripts = scriptParts((() => {
    const raw = c.findStream("/Scripts/DefaultJScript")
    if (!raw) return null
    try { return c.compressed ? decompressStream(raw) : raw } catch { return null }
  })())
  // 한글 2024 기본 스크립트(끝 빈 줄 하나 더)는 한글이 HWPX 에 옮기지 않는다
  if (scripts && scripts[1].length && scripts[1].toString("utf16le") !== V13_DEFAULT_SCRIPT) {
    zip.file("Scripts/headerScripts.js", scripts[0])
    zip.file("Scripts/sourceScripts.js", scripts[1])
    const js = "application/x-javascript ;charset=utf-16"
    manifest.push(el("opf:item", [["id", "headersc"], ["href", "Scripts/headerScripts.js"], ["media-type", js]]),
      el("opf:item", [["id", "sourcesc"], ["href", "Scripts/sourceScripts.js"], ["media-type", js]]))
  }
  manifest.push(el("opf:item", [["id", "settings"], ["href", "settings.xml"], ["media-type", "application/xml"]]))

  const prvText = c.findStream("/PrvText")
  zip.file("Preview/PrvText.txt", prvText ? prvText.toString("utf16le").replace(/\u0000+$/, "") : "")
  const prvImage = c.findStream("/PrvImage")
  if (prvImage && prvImage.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) zip.file("Preview/PrvImage.png", prvImage, { compression: "STORE" })

  const caret = docProps(docInfo).caret
  zip.file("settings.xml", XML_DECL + '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" '
    + 'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">'
    + el("ha:CaretPosition", [["listIDRef", caret[0]], ["paraIDRef", caret[1]], ["pos", caret[2]]]) + "</ha:HWPApplicationSetting>")

  const rdfPart = (name: string, type: string): string => '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" '
    + `rdf:resource="${name}"/></rdf:Description><rdf:Description rdf:about="${name}"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#${type}"/></rdf:Description>`
  zip.file("META-INF/container.rdf", XML_DECL + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' + rdfPart("Contents/header.xml", "HeaderFile")
    + sectionNames.map(n => rdfPart(n, "SectionFile")).join("")
    + '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>')
  zip.file("META-INF/container.xml", XML_DECL + '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf">'
    + '<ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>'
    + '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/>'
    + "</ocf:rootfiles></ocf:container>")
  zip.file("META-INF/manifest.xml", XML_DECL + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>')
  zip.file("Contents/content.hpf", XML_DECL + `<opf:package ${NS} version="" unique-identifier="" id="">`
    + `<opf:metadata><opf:title>${esc("")}</opf:title><opf:language>ko</opf:language></opf:metadata>`
    + `<opf:manifest>${manifest.join("")}</opf:manifest><opf:spine>`
    + el("opf:itemref", [["idref", "header"], ["linear", "yes"]]) + sectionNames.map((_, i) => el("opf:itemref", [["idref", `section${i}`], ["linear", "yes"]])).join("")
    + "</opf:spine></opf:package>")

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
}

export interface ConvertToHwpxResult {
  data: Uint8Array
  /** preserve: 서식 그대로(HWP 5.x), content: 글·표만 옮겨 kordoc 기본 서식으로(HWP 3.x 등) */
  mode: "preserve" | "content"
  warnings: string[]
}

/**
 * 한글 문서 → HWPX. HWP 5.x 는 서식 그대로(hwpToHwpx), 서식 보존 변환이 없는 형식(HWP 3.x·HWPML)은 글·표를 옮겨 kordoc 기본
 * 서식으로 쓰고 그 사실을 경고로 남긴다. HWPX 는 그대로 돌려준다
 */
export async function convertToHwpx(input: Uint8Array | ArrayBuffer, options?: HwpToHwpxOptions): Promise<ConvertToHwpxResult> {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const { detectFormat } = await import("../../detect.js")
  const format = detectFormat(ab)
  if (format === "hwp") return { data: await hwpToHwpx(bytes, options), mode: "preserve", warnings: [] }
  if (format === "hwpx") return { data: bytes, mode: "preserve", warnings: ["이미 HWPX 문서입니다 — 그대로 둡니다"] }
  if (format !== "hwp3" && format !== "hwpml") throw new KordocError(`HWP 문서가 아닙니다 (${format})`)
  const { parse } = await import("../../index.js")
  const { markdownToHwpx } = await import("../../hwpx/generator.js")
  const parsed = await parse(ab, { password: options?.password })
  if (!parsed.success) throw new KordocError(parsed.error ?? "문서를 읽지 못했습니다")
  return {
    data: new Uint8Array(await markdownToHwpx(parsed.markdown)),
    mode: "content",
    warnings: [`${format === "hwp3" ? "HWP 3.x" : "HWPML"} 문서는 서식 그대로 옮기는 변환을 지원하지 않아 글·표만 kordoc 기본 서식으로 옮겼습니다`],
  }
}
