/**
 * redact 문서 단위 e2e 픽스처 — 파일 안 "모든 글자 저장소"에 합성 PII 를 심은 HWPX·HWP5 와,
 * 마스킹 결과 파일 바이트를 구현과 독립적으로 뒤지는 오라클.
 *
 * ※ 여기 번호·주소는 전부 합성(synthetic)이다 — 주민번호는 체크섬만 맞춘 가상 값, 도메인은 example.*.
 */

import JSZip from "jszip"
import { createRequire } from "node:module"
import { deflateRawSync, deflateSync, inflateRawSync } from "node:zlib"
import { markdownToHwpx } from "../../src/index.js"

const require = createRequire(import.meta.url)
const CFB = require("cfb")

// ─── 심을 PII (위치별로 서로 다른 값 — 어디서 샜는지 바로 보이게) ─────────

export const HWPX_PII = {
  body: "010-2345-6789",
  bodyRrn: "850315-1234563",
  footnoteHost: "010-3456-7890", // 각주가 달린 문단 본문
  footnote: "hong@example.com",
  footnoteRrn: "900101-1694788",
  table: "02-345-6789",
  headerCtxRrn: "7706121946111", // 표 열 머리글 "주민등록번호" 문맥으로만 잡히는 무구분 13자리
  nested: "110-234-567890",
  lineBreak: "kim.cs@example.org",
  header: "031-234-5678",
  footer: "park@example.net",
  textbox: "4615-6562-1819-3579",
  splitRun: "010-9876-5431",
  tabLabelRrn: "6811302781671",
  fieldMail: "link@example.com",
  entityPara: "010-7777-8888",
  shapeComment: "010-4444-5555",
  caption: "02-999-8888",
  metaTitle: "010-5555-6666",
  metaAuthor: "meta.author@example.com",
  metaDesc: "02-765-4321",
  preview: "010-1212-3434",
} as const

export const HWP5_PII = {
  body: "010-2345-6789",
  tabLabelRrn: "9001011694788",
  field: "010-1111-2222",
  cell: "02-345-6789",
  header: "031-234-5678",
  footnote: "hong@example.com",
  textbox: "4615-6562-1819-3579",
  hyperlink: "link@example.com",
  prvText: "010-1212-3434",
  summaryTitle: "010-5555-6666",
  summaryAuthor: "meta.author@example.com",
} as const

// ─── 공용: 작은 PNG ───────────────────────────────────

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
export function crc32(b: Buffer): number { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
export function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** 검은 점이 찍힌 w×h 회색조 PNG — "첫 쪽 렌더"를 흉내 */
export function tinyPng(w = 8, h = 6): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0
  const raw = Buffer.alloc((w + 1) * h, 0x80)
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

// ─── HWPX ────────────────────────────────────────────

/**
 * markdownToHwpx 로 본문·표·중첩표·줄바꿈 문단·각주(각주 달린 문단 포함)·머리말/꼬리말을 만들고,
 * 생성기가 못 만드는 곳은 XML 을 직접 심는다: 글상자, run 이 가른 번호, 탭 라벨, 하이퍼링크 필드,
 * 엔티티 문단, 그림 설명(shapeComment), 표 캡션, 줄 배치 캐시(linesegarray), content.hpf 메타데이터,
 * PrvText 전용 줄, 미리보기 PNG, 삽입 이미지(BinData).
 */
export async function buildPiiHwpx(): Promise<Uint8Array> {
  const P = HWPX_PII
  const md = [
    "# 개인정보 처리 시험 문서",
    "",
    `신청인 주민등록번호 ${P.bodyRrn}, 연락처 ${P.body} 입니다.`,
    "",
    `각주가 달린 문단 연락처 ${P.footnoteHost} 참고.[^1]`,
    "",
    `[^1]: 각주 속 이메일 ${P.footnote}, 주민번호 ${P.footnoteRrn}`,
    "",
    "| 성명 | 연락처 | 주민등록번호 |",
    "| --- | --- | --- |",
    `| 홍길동 | ${P.table} | ${P.headerCtxRrn} |`,
    "",
    `<table><tr><td>바깥 셀</td><td><table><tr><td>중첩 계좌 ${P.nested}</td></tr></table></td></tr></table>`,
    "",
    `줄바꿈 문단 첫 줄<br>둘째 줄 메일 ${P.lineBreak}`,
  ].join("\n")
  const base = await markdownToHwpx(md, { page: { header: `머리말 담당 ${P.header}`, footer: `꼬리말 ${P.footer}` } })
  const zip = await JSZip.loadAsync(base)
  let sec = await zip.file("Contents/section0.xml")!.async("text")

  const para = (inner: string): string => `<hp:p paraPrIDRef="0" styleIDRef="0">${inner}</hp:p>`
  const run = (inner: string, cp = 0): string => `<hp:run charPrIDRef="${cp}">${inner}</hp:run>`
  const injected = [
    // 글상자 (drawText 안 문단)
    para(run(`<hp:rect id="900" zOrder="1" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="900"><hp:drawText lastWidth="20000" name="" editable="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${para(run(`<hp:t>글상자 카드 ${P.textbox}</hp:t>`))}</hp:subList></hp:drawText></hp:rect>`)),
    // run 경계가 번호를 가른 문단 (글자모양이 바뀐 자리)
    para(run(`<hp:t>분할 연락처 ${P.splitRun.slice(0, 6)}</hp:t>`, 0) + run(`<hp:t>${P.splitRun.slice(6)} 끝</hp:t>`, 1)),
    // 라벨과 값 사이 탭 — 무구분 주민번호는 라벨 문맥이 있어야 잡힌다
    para(run(`<hp:t>주민등록번호<hp:tab width="4000" leader="0" type="1"/>${P.tabLabelRrn}</hp:t>`)),
    // 하이퍼링크 필드 — 명령 문자열(stringParam)과 표시 텍스트 모두
    para(run(`<hp:ctrl><hp:fieldBegin id="77" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="77"><hp:parameters cnt="2" name=""><hp:stringParam name="Command">mailto\\:${P.fieldMail};1;0;0;</hp:stringParam><hp:stringParam name="Path">mailto:${P.fieldMail}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>${P.fieldMail}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="77" fieldid="77"/></hp:ctrl>`)),
    // XML 엔티티가 앞에 있는 문단 — 글자 위치 대응이 어긋나면 엉뚱한 곳을 가린다
    para(run(`<hp:t>R&amp;D &lt;담당&gt; ${P.entityPara}</hp:t>`) + `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`),
    // 그림 설명
    para(run(`<hp:pic id="901" zOrder="2" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="901" reverse="0"><hp:shapeComment>사진 속 연락처 ${P.shapeComment}</hp:shapeComment><hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"/></hp:pic><hp:t>그림 뒤 글</hp:t>`)),
  ].join("")
  sec = sec.replace("</hs:sec>", injected + "</hs:sec>")
  // 첫 표에 캡션
  sec = sec.replace(/(<hp:tbl\b[^>]*>)/, `$1<hp:caption side="TOP" fullSz="0" width="8504" gap="850" lastWidth="42520"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${para(run(`<hp:t>표 캡션 문의 ${P.caption}</hp:t>`))}</hp:subList></hp:caption>`)
  zip.file("Contents/section0.xml", sec)

  const hpf = await zip.file("Contents/content.hpf")!.async("text")
  zip.file("Contents/content.hpf", hpf.replace("<opf:metadata>", `<opf:metadata><opf:title>민원 ${P.metaTitle} 건</opf:title><opf:meta name="creator" content="text">${P.metaAuthor}</opf:meta><opf:meta name="description" content="text">연락처 ${P.metaDesc}</opf:meta>`))

  const prv = await zip.file("Preview/PrvText.txt")!.async("text")
  zip.file("Preview/PrvText.txt", prv + `\r\n<미리보기 전용><${P.preview}>`)
  zip.file("Preview/PrvImage.png", tinyPng())
  zip.file("BinData/image1.png", tinyPng(2, 2))
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
}

// ─── HWP5 ────────────────────────────────────────────

export function rec(tagId: number, level: number, data: Buffer): Buffer {
  const h = Buffer.alloc(4)
  h.writeUInt32LE(((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (data.length << 20)) >>> 0, 0)
  return Buffer.concat([h, data])
}
const utf16 = (s: string): Buffer => Buffer.from(s, "utf16le")
/** 확장/인라인 컨트롤 문자 8단위(16바이트) — ctrlId 는 파일 저장 순서(LE)로 */
export function ctrlChar(ch: number, id = "    "): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt16LE(ch, 0)
  b.writeUInt32LE((((id.charCodeAt(0) << 24) | (id.charCodeAt(1) << 16) | (id.charCodeAt(2) << 8) | id.charCodeAt(3)) >>> 0), 2)
  b.writeUInt16LE(ch, 14)
  return b
}
export function ctrlIdLE(id: string): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE((((id.charCodeAt(0) << 24) | (id.charCodeAt(1) << 16) | (id.charCodeAt(2) << 8) | id.charCodeAt(3)) >>> 0), 0)
  return b
}

/** 문단: PARA_HEADER + PARA_TEXT(parts + 0x0d) + CHAR_SHAPE + LINE_SEG, ctrlMask 는 쓰인 컨트롤로 */
export function paragraph(level: number, parts: Array<string | Buffer>, ctrlMask = 0): Buffer {
  const text = Buffer.concat([...parts.map((p) => (typeof p === "string" ? utf16(p) : p)), Buffer.from([0x0d, 0x00])])
  const header = Buffer.alloc(24)
  header.writeUInt32LE(text.length / 2, 0)
  header.writeUInt32LE(ctrlMask >>> 0, 4)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(1, 16)
  const ls = Buffer.alloc(36)
  ls.writeInt32LE(1000, 8); ls.writeInt32LE(1000, 12); ls.writeInt32LE(600, 20)
  return Buffer.concat([rec(0x42, level, header), rec(0x43, level + 1, text), rec(0x44, level + 1, Buffer.alloc(8)), rec(0x45, level + 1, ls)])
}

/** 컨트롤 안 문단 목록 (LIST_HEADER + 문단) — 머리말·각주·글상자 공용 */
function subList(level: number, paras: Buffer[]): Buffer {
  const lh = Buffer.alloc(34)
  lh.writeUInt16LE(paras.length, 0)
  return Buffer.concat([rec(0x48, level, lh), ...paras])
}

function hwp5Section(): Buffer {
  const P = HWP5_PII
  const parts: Buffer[] = []
  // 1) 평범한 본문
  parts.push(paragraph(0, [`신청인 연락처 ${P.body} 입니다`]))
  // 2) 탭 라벨 + 무구분 주민번호 (patchHwp 는 탭 포함 문단을 skip 하던 형태)
  parts.push(paragraph(0, ["주민등록번호", ctrlChar(0x09), P.tabLabelRrn], 1 << 9))
  // 3) 누름틀(필드) 안 전화번호 — 필드 시작/끝 컨트롤이 번호를 감싼다
  parts.push(paragraph(0, ["담당 ", ctrlChar(0x03, "%clk"), P.field, ctrlChar(0x04, "%clk")], (1 << 3) | (1 << 4)))
  parts.push(rec(0x47, 1, Buffer.concat([ctrlIdLE("%clk"), Buffer.alloc(9)])))
  // 4) 2×2 표 셀
  const tblAnchor = paragraph(0, [ctrlChar(0x0b, "tbl ")], 1 << 11)
  const tblData = Buffer.alloc(8); tblData.writeUInt16LE(2, 4); tblData.writeUInt16LE(2, 6)
  const cells: Buffer[] = []
  const cellText = [["성명", "연락처"], ["홍길동", P.cell]]
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    const lh = Buffer.alloc(34); lh.writeUInt16LE(1, 0); lh.writeUInt16LE(c, 8); lh.writeUInt16LE(r, 10); lh.writeUInt16LE(1, 12); lh.writeUInt16LE(1, 14)
    cells.push(rec(0x48, 2, lh), paragraph(2, [cellText[r][c]]))
  }
  parts.push(tblAnchor, rec(0x47, 1, Buffer.concat([ctrlIdLE("tbl "), Buffer.alloc(42)])), rec(0x4d, 2, tblData), ...cells)
  // 5) 머리말 컨트롤
  parts.push(paragraph(0, [ctrlChar(0x10, "head")], 1 << 16))
  parts.push(rec(0x47, 1, Buffer.concat([ctrlIdLE("head"), Buffer.alloc(8)])), subList(2, [paragraph(2, [`머리말 담당 ${P.header}`])]))
  // 6) 각주 컨트롤
  parts.push(paragraph(0, ["본문 각주 표시", ctrlChar(0x11, "fn  ")], 1 << 17))
  parts.push(rec(0x47, 1, Buffer.concat([ctrlIdLE("fn  "), Buffer.alloc(8)])), subList(2, [paragraph(2, [`각주 속 메일 ${P.footnote}`])]))
  // 7) 글상자 (그리기 개체 + 문단 목록)
  parts.push(paragraph(0, [ctrlChar(0x0b, "gso ")], 1 << 11))
  parts.push(rec(0x47, 1, Buffer.concat([ctrlIdLE("gso "), Buffer.alloc(42)])), rec(0x4c, 2, Buffer.alloc(100)), subList(2, [paragraph(2, [`글상자 카드 ${P.textbox}`])]))
  // 8) 하이퍼링크 필드 — CTRL_HEADER 명령 문자열이 홀수 오프셋(11)에서 시작
  const cmd = `mailto:${P.hyperlink};1;0;0;`
  const hlk = Buffer.concat([ctrlIdLE("%hlk"), Buffer.alloc(4), Buffer.from([0]), Buffer.from([cmd.length & 0xff, cmd.length >> 8]), utf16(cmd), Buffer.alloc(4)])
  parts.push(paragraph(0, [ctrlChar(0x03, "%hlk"), P.hyperlink, ctrlChar(0x04, "%hlk")], (1 << 3) | (1 << 4)))
  parts.push(rec(0x47, 1, hlk))
  return Buffer.concat(parts)
}

/** OLE 속성 집합 (VT_LPWSTR 만) — 실파일 \x05HwpSummaryInformation 과 같은 꼴 */
function summaryInfo(props: Array<[number, string]>): Buffer {
  const header = Buffer.alloc(48)
  header.writeUInt16LE(0xfffe, 0)
  header.writeUInt32LE(1, 24)
  Buffer.from("60b6a29f6110d411b4c6006097c09d8c", "hex").copy(header, 28)
  header.writeUInt32LE(48, 44)
  const bodies = props.map(([, s]) => {
    const str = utf16(s + "\0")
    const b = Buffer.alloc(8 + Math.ceil(str.length / 4) * 4)
    b.writeUInt32LE(0x1f, 0)
    b.writeUInt32LE(s.length + 1, 4)
    str.copy(b, 8)
    return b
  })
  const table = Buffer.alloc(8 + props.length * 8)
  let off = table.length
  props.forEach(([id], i) => { table.writeUInt32LE(id, 8 + i * 8); table.writeUInt32LE(off, 12 + i * 8); off += bodies[i].length })
  table.writeUInt32LE(off, 0)
  table.writeUInt32LE(props.length, 4)
  return Buffer.concat([header, table, ...bodies])
}

/** 검사할 수 없는 삽입 OLE 개체(BinData) 안에만 있는 번호 — 잔존(residual) 신호 검증용 */
export const HWP5_OLE_PII = "010-3333-4444" // 차트 원본 Contents 스트림 (UTF-16)
export const HWP5_OLE_CHART_PII = "010-5656-7878" // 차트 OOXMLChartContents 스트림 (UTF-8 XML)

/**
 * 한컴 BinData OLE 개체 모양 — 4바이트 크기 + OLE 복합 파일(Contents·OOXMLChartContents). 한컴 실저장본의
 * 삽입 OLE 는 전부 raw deflate 로 압축돼 있다(코퍼스 92/92) — 압축된 채로는 원시 바이트 검사에 안 보인다
 */
export function oleObject(): Buffer {
  const inner = CFB.utils.cfb_new()
  CFB.utils.cfb_add(inner, "/Contents", Buffer.concat([Buffer.alloc(8), utf16(`담당 연락처 ${HWP5_OLE_PII}`), Buffer.alloc(8)]))
  CFB.utils.cfb_add(inner, "/OOXMLChartContents", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="urn:c"><c:title><c:v>문의 ${HWP5_OLE_CHART_PII}</c:v></c:title></c:chartSpace>`, "utf8"))
  const cf = CFB.write(inner, { type: "buffer" }) as Buffer
  const size = Buffer.alloc(4)
  size.writeUInt32LE(cf.length, 0)
  return Buffer.concat([size, cf])
}

/** 한컴 압축 스트림 — raw deflate + 8바이트 꼬리(CRC32(비압축) LE + 비압축 크기 LE) */
export function hancomDeflate(raw: Buffer): Buffer {
  const tail = Buffer.alloc(8)
  tail.writeUInt32LE(crc32(raw), 0)
  tail.writeUInt32LE(raw.length, 4)
  return Buffer.concat([deflateRawSync(raw), tail])
}

/** 압축 HWP5 한 벌 — 섹션 레코드와 스트림 목록만 바꿔 끼운다 (FileHeader 압축 플래그 on) */
export function buildHwp5(section: Buffer, streams: Record<string, Buffer> = {}): Uint8Array {
  const fileHeader = Buffer.alloc(256)
  fileHeader.write("HWP Document File", 0, "ascii")
  fileHeader[35] = 5
  fileHeader.writeUInt32LE(1, 36) // 압축
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, "/FileHeader", fileHeader)
  CFB.utils.cfb_add(cfb, "/DocInfo", hancomDeflate(Buffer.alloc(0)))
  CFB.utils.cfb_add(cfb, "/BodyText/Section0", hancomDeflate(section))
  for (const [path, data] of Object.entries(streams)) CFB.utils.cfb_add(cfb, path, data)
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Buffer)
}

/**
 * 압축 HWP5 — BodyText·DocInfo 는 한컴처럼 꼬리 붙은 raw deflate, PrvText·요약정보·PrvImage 는 원시,
 * BinData 그림은 원시. withOlePii: 압축된 삽입 OLE 개체(BinData/BIN0002.OLE, 차트)에 번호를 넣는다 —
 * 도구가 가릴 수 없는 곳
 */
export function buildPiiHwp5(opts: { withOlePii?: boolean } = {}): Uint8Array {
  const P = HWP5_PII
  return buildHwp5(hwp5Section(), {
    "/PrvText": utf16(`<신청인><${P.prvText}>\r\n<연락처><${P.body}>\r\n`),
    "/\x05HwpSummaryInformation": summaryInfo([[2, `신청인 ${P.summaryTitle} 민원`], [4, P.summaryAuthor], [8, "USER"]]),
    "/PrvImage": tinyPng(),
    "/BinData/BIN0001.png": tinyPng(2, 2),
    ...(opts.withOlePii ? { "/BinData/BIN0002.OLE": deflateRawSync(oleObject()) } : {}),
  })
}

// ─── 오라클: 결과 파일 바이트에서 심은 값 찾기 (구현 코드와 독립) ─────────

/** 값을 찾을 바이트 표현 — UTF-8·UTF-16LE 그대로 */
function encodings(v: string): Buffer[] {
  return [Buffer.from(v, "utf8"), Buffer.from(v, "utf16le")]
}

/**
 * ZIP 모든 엔트리(압축 해제본) + 태그 제거·엔티티 해제 텍스트 + 숫자만 이은 투영에서 심은 값 찾기.
 * 반환: "값 → 엔트리" 누출 목록.
 */
export async function hwpxLeaks(data: Uint8Array, values: Record<string, string>): Promise<string[]> {
  const zip = await JSZip.loadAsync(data)
  const leaks: string[] = []
  for (const [name, f] of Object.entries(zip.files)) {
    if (f.dir) continue
    const bytes = Buffer.from(await f.async("uint8array"))
    const text = bytes.toString("utf8")
    const stripped = text.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\\:/g, ":")
    const digits = text.replace(/<[^>]*>/g, "").replace(/\D/g, "")
    for (const [key, v] of Object.entries(values)) {
      const vd = v.replace(/\D/g, "")
      if (encodings(v).some((e) => bytes.includes(e)) || stripped.includes(v) || (vd.length >= 9 && digits.includes(vd))) {
        leaks.push(`${key} → ${name}`)
      }
    }
  }
  for (const [key, v] of Object.entries(values)) {
    if (encodings(v).some((e) => Buffer.from(data).includes(e))) leaks.push(`${key} → (ZIP 원시 바이트)`)
  }
  return leaks
}

/** OLE 모든 스트림(원시 + raw deflate 해제 시도) + 파일 전체 원시 바이트에서 UTF-16LE·UTF-8 로 찾기 */
export function hwp5Leaks(data: Uint8Array, values: Record<string, string>): string[] {
  const cfb = CFB.parse(Buffer.from(data))
  const leaks: string[] = []
  cfb.FileIndex.forEach((e: { type: number; content?: Uint8Array }, i: number) => {
    if (e.type !== 2 || !e.content) return
    const raw = Buffer.from(e.content)
    const blobs = [raw]
    try { blobs.push(inflateRawSync(raw)) } catch { /* 압축 아님 */ }
    for (const [key, v] of Object.entries(values)) {
      if (blobs.some((b) => encodings(v).some((enc) => b.includes(enc)))) leaks.push(`${key} → ${cfb.FullPaths[i]}`)
    }
  })
  for (const [key, v] of Object.entries(values)) {
    if (encodings(v).some((e) => Buffer.from(data).includes(e))) leaks.push(`${key} → (OLE 원시 바이트)`)
  }
  return leaks
}

/** 스트림 원문 (압축이면 해제) */
export function hwp5Stream(data: Uint8Array, path: string, inflate = false): Buffer {
  const e = CFB.find(CFB.parse(Buffer.from(data)), path)
  if (!e?.content) throw new Error(`스트림 없음: ${path}`)
  const b = Buffer.from(e.content)
  return inflate ? inflateRawSync(b) : b
}
