/**
 * HWP·HWPX 의 OLE 개체(4바이트 길이 머리 + 복합 문서) 읽기.
 * 차트 개체는 한글이 함께 넣는 OOXML 차트 스트림을, 엑셀 개체는 Workbook 스트림(BIFF8)을 표로 낸다.
 */
import { createRequire } from "module"
import { parseChartXml, chartBlock } from "../shared/chart-xml.js"
import { parseXlsDocumentSync } from "../xls/parser.js"
import type { IRBlock } from "../types.js"

const require = createRequire(import.meta.url)
const CFB: { read(d: Buffer, o: { type: "buffer" }): { FileIndex: Array<{ name: string }> }; find(c: unknown, p: string): { content?: Buffer | Uint8Array } | null } = require("cfb")

const storageOf = (data: Buffer | undefined) => {
  if (!data || data.length < 12) return null
  try {
    return CFB.read(data.subarray(4), { type: "buffer" })
  } catch {
    return null
  }
}

export function oleChartXml(data: Buffer | undefined): Buffer | null {
  const cfb = storageOf(data)
  const e = cfb ? CFB.find(cfb, "OOXMLChartContents") : null
  return e?.content?.length ? Buffer.from(e.content) : null
}

/** OLE 개체 → 블록: 차트면 차트 표, 엑셀 개체면 시트 표(캡션 "엑셀 개체: 시트 이름"). 못 읽는 개체는 빈 배열 */
export function oleObjectBlocks(data: Buffer | undefined): IRBlock[] {
  const xml = oleChartXml(data)
  if (xml) {
    const chart = parseChartXml(xml.toString("utf8"))
    return chart ? [chartBlock(chart)] : []
  }
  const cfb = storageOf(data)
  if (!cfb || !cfb.FileIndex.some(e => e.name === "Workbook" || e.name === "Book")) return []
  try {
    const out: IRBlock[] = []
    let sheet = ""
    for (const b of parseXlsDocumentSync(data!.subarray(4)).blocks) {
      if (b.type === "heading") sheet = b.text ?? ""
      else if (b.type === "table" && b.table) out.push({ ...b, table: { ...b.table, caption: `엑셀 개체${sheet ? `: ${sheet}` : ""}` } })
    }
    return out
  } catch {
    // BIFF8 이 아닌 통합 문서(한셀 등)·손상 — 개체를 건너뛴다
    return []
  }
}
