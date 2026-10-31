/**
 * 메모 달기 (#180) — HWPX 문서의 앵커 문구를 찾아 그 범위에 한글 메모("메모 넣기")를 단다. 본문 글·서식은 그대로 두고 앵커 앞뒤에
 * 메모 필드(fieldBegin type MEMO · fieldEnd)만 끼운다.
 *
 * 꼴은 한글 저장본(코퍼스 aift.hwpx)과 같다: fieldBegin 매개변수(Command "MEMO/모양/번호/만든 시각 FILETIME 하위/상위/작성자/"·
 * Number·Author·CreateDateTime)와 subList 의 메모 문단, header 의 hh:memoPr(메모 모양), 메모가 든 구역 secPr 의 memoShapeIDRef.
 * 메모를 단 문단은 줄 배치 캐시(linesegarray)를 비워 한글이 다시 짜게 한다(patch 와 같은 규칙).
 */

import JSZip from "jszip"
import { KordocError, precheckZipSize } from "../utils.js"
import {
  scanSectionXml, applySplices, paraTCharMap, escapeXmlText, changedLinesegRemovalSplices, type SpliceEdit,
} from "../roundtrip/source-map.js"
import { patchZipEntries } from "../roundtrip/zip-patch.js"
import { readZipEntry } from "../hwpx/parser-shared.js"
import { fileTimeText } from "../hwp5/record.js"
import { collectSites } from "./seal.js"

export interface MemoOp {
  /** 메모를 붙일 본문 글 (마크다운에 보이는 꼴 — 한컴 PUA 기호는 표시값) */
  anchor: string
  /** 메모 글 — 줄바꿈은 메모 안 문단 */
  text: string
  /** 작성자 (기본 "kordoc") */
  author?: string
  /** 같은 앵커가 여럿일 때 0-based 선택 (기본 0) */
  occurrence?: number
}

export interface MemoPlacement {
  anchor: string
  occurrence: number
  /** 문서 안 메모 번호 */
  number: number
  sectionIndex: number
}

export interface AddMemoResult {
  buffer: ArrayBuffer
  placed: MemoPlacement[]
}

/** MEMO 필드 id(fieldid) — '%%me' */
const MEMO_FIELD_ID = 0x25256d65
/** 메모가 처음인 문서에 넣는 메모 모양 — 한글 기본값(한글 저장본) */
const DEFAULT_MEMO_PR = `<hh:memoPr id="1" width="15591" lineWidth="3" lineType="SOLID" lineColor="#A9A9A9" fillColor="#CBFF99" activeColor="#FDBCDD" memoType="NOMAL"/>`

/** 메모 필드 여는 ctrl — 매개변수와 메모 글 문단 (한글 저장본 꼴) */
function memoBeginXml(P: string, fid: number, num: number, author: string, text: string, now: Date): string {
  const ft = BigInt(now.getTime()) * 10000n + 116444736000000000n
  const low = Number(ft & 0xffffffffn), high = Number(ft >> 32n)
  const esc = escapeXmlText
  const params = [
    `<${P}:integerParam name="Prop">0</${P}:integerParam>`,
    `<${P}:stringParam name="Command">${esc(`MEMO/65535/${num}/${low}/${high}/${author.replace(/\//g, "")}/`)}\\;;</${P}:stringParam>`,
    `<${P}:stringParam name="ID">memo${num}</${P}:stringParam>`,
    `<${P}:integerParam name="Number">${num}</${P}:integerParam>`,
    `<${P}:stringParam name="Author">${esc(author)}</${P}:stringParam>`,
    `<${P}:stringParam name="MemoShapeIDRef">65535</${P}:stringParam>`,
    `<${P}:stringParam name="CreateDateTime">${fileTimeText(low, high)}</${P}:stringParam>`,
  ]
  const paras = text.split(/\r?\n/).map(line =>
    `<${P}:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><${P}:run charPrIDRef="0"><${P}:t>${esc(line)}</${P}:t></${P}:run></${P}:p>`).join("")
  return `<${P}:ctrl><${P}:fieldBegin id="${fid}" type="MEMO" name="" editable="1" dirty="1" zorder="${num}" fieldid="${MEMO_FIELD_ID}">`
    + `<${P}:parameters cnt="${params.length}" name="">${params.join("")}</${P}:parameters>`
    + `<${P}:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras}</${P}:subList>`
    + `</${P}:fieldBegin></${P}:ctrl>`
}

/** HWPX 의 앵커 문구마다 메모를 단다. 앵커는 문서 순서(본문·표 칸·글상자)로 찾고, 한 문단 안에 있어야 한다 */
export async function addMemoHwpx(hwpxBuffer: ArrayBuffer, ops: MemoOp[], now = new Date()): Promise<AddMemoResult> {
  if (ops.length === 0) throw new KordocError("add_memo: 달 메모가 없습니다")
  precheckZipSize(hwpxBuffer)
  const zip = await JSZip.loadAsync(hwpxBuffer)
  const sectionPaths = Object.keys(zip.files).filter(n => /[Ss]ection\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/i)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/i)?.[1] ?? 0))
  if (sectionPaths.length === 0) throw new KordocError("HWPX에서 섹션 파일을 찾을 수 없습니다")
  const headerPath = Object.keys(zip.files).find(n => /(^|\/)header\.xml$/i.test(n))
  if (!headerPath) throw new KordocError("HWPX에서 header.xml 을 찾을 수 없습니다")
  const header = await readZipEntry(zip.file(headerPath)!, "text")
  const xmls: string[] = []
  for (const p of sectionPaths) xmls.push(await readZipEntry(zip.file(p)!, "text"))
  const scans = xmls.map((x, i) => scanSectionXml(x, i))
  const sites = scans.map(collectSites)

  // 새 메모 번호·필드 id — 문서에 있는 것 다음부터
  let num = 0, fid = 1_000_000_000
  for (const x of xmls) {
    for (const m of x.matchAll(/<(?:\w+:)?integerParam name="Number">(\d{1,9})</g)) num = Math.max(num, Number(m[1]))
    for (const m of x.matchAll(/\bid="(\d{1,10})"/g)) if (Number(m[1]) < 2 ** 31 - 1) fid = Math.max(fid, Number(m[1]) + 1)
  }
  // 메모 모양 — 있으면 첫 메모 모양, 없으면 한글 기본값으로 만든다
  const memoPrId = /<hh:memoPr\b[^>]*\bid="(\d+)"/.exec(header)?.[1] ?? "1"
  const newHeader = header.includes("<hh:memoPr") ? header
    : header.includes("</hh:refList>") ? header.replace("</hh:refList>", `<hh:memoProperties itemCnt="1">${DEFAULT_MEMO_PR}</hh:memoProperties></hh:refList>`)
      : null
  if (newHeader === null) throw new KordocError("add_memo: header.xml 에 refList 가 없어 메모 모양을 넣을 수 없습니다")

  const splices: SpliceEdit[][] = xmls.map(() => [])
  const placed: MemoPlacement[] = []
  for (const op of ops) {
    if (!op.anchor) throw new KordocError("add_memo: anchor 문구가 필요합니다")
    if (!op.text) throw new KordocError("add_memo: 메모 글이 필요합니다")
    const want = op.occurrence ?? 0
    let found: { si: number; para: (typeof sites)[number][number]["para"]; at: number; map: ReturnType<typeof paraTCharMap> } | undefined
    let total = 0
    for (let si = 0; si < xmls.length && !found; si++) {
      for (const site of sites[si]) {
        const map = paraTCharMap(site.para, xmls[si])
        for (let from = 0; ;) {
          const at = map.text.indexOf(op.anchor, from)
          if (at < 0) break
          if (total++ === want) { found = { si, para: site.para, at, map }; break }
          from = at + op.anchor.length
        }
        if (found) break
      }
    }
    if (!found) {
      throw new KordocError(`add_memo: 앵커 "${op.anchor}" ${want}번째 등장을 찾지 못했습니다 (한 문단 안 본문 글 ${total}회 등장 — occurrence 0..${Math.max(0, total - 1)})`)
    }
    const { si, para, at, map } = found
    const end = at + op.anchor.length - 1
    const inEntity = (i: number): boolean => i > 0 && i < map.text.length && map.from[i] === map.from[i - 1]
    if (inEntity(at) || inEntity(end + 1)) throw new KordocError(`add_memo: 앵커 "${op.anchor}" 경계가 한 글자 표기 가운데에 걸립니다`)
    const xml = xmls[si]
    /** hp:t 를 끊고 ctrl 을 끼운다 — 끊은 뒤 여는 태그는 원래 hp:t 여는 태그 그대로 */
    const cut = (pos: number, seg: number, ctrl: string): SpliceEdit => {
      const t = para.tRanges[seg]
      const open = xml.slice(xml.lastIndexOf("<", t.contentStart - 1), t.contentStart)
      const close = `</${open.slice(1).match(/^[^\s>/]+/)![0]}>`
      return { start: pos, end: pos, replacement: `${close}${ctrl}${open}` }
    }
    const P = /^<(\w+):/.exec(xml.slice(xml.lastIndexOf("<", para.tRanges[map.seg[at]].contentStart - 1)))?.[1] ?? "hp"
    num++
    const id = fid++
    splices[si].push(
      cut(map.from[at], map.seg[at], memoBeginXml(P, id, num, op.author || "kordoc", op.text, now)),
      cut(map.to[end], map.seg[end], `<${P}:ctrl><${P}:fieldEnd beginIDRef="${id}" fieldid="${MEMO_FIELD_ID}"/></${P}:ctrl>`),
    )
    placed.push({ anchor: op.anchor, occurrence: want, number: num, sectionIndex: si })
  }

  const encoder = new TextEncoder()
  const replacements = new Map<string, Uint8Array>()
  if (newHeader !== header) replacements.set(headerPath, encoder.encode(newHeader))
  for (let si = 0; si < xmls.length; si++) {
    if (!splices[si].length) continue
    const xml = xmls[si]
    // 메모를 단 문단은 줄 배치 캐시를 비운다 — 구역의 메모 모양 참조(secPr memoShapeIDRef)가 0 이면 쓸 모양으로
    const all = [...splices[si], ...changedLinesegRemovalSplices(xml, splices[si])]
    const ref = /(<(?:\w+:)?secPr\b[^>]*?\bmemoShapeIDRef=")0"/.exec(xml)
    if (ref) all.push({ start: ref.index + ref[1].length, end: ref.index + ref[0].length - 1, replacement: memoPrId })
    replacements.set(sectionPaths[si], encoder.encode(applySplices(xml, all)))
  }
  const out = patchZipEntries(new Uint8Array(hwpxBuffer), replacements)
  return { buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer, placed }
}
