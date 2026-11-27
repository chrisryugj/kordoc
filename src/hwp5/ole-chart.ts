/** HWP5 차트 개체: OLE 스토리지(4바이트 길이 머리 + 복합 문서)의 OOXML 차트 스트림. 한글이 차트 개체를 저장할 때 함께 넣는다 */
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const CFB: { read(d: Buffer, o: { type: "buffer" }): unknown; find(c: unknown, p: string): { content?: Buffer | Uint8Array } | null } = require("cfb")

export function oleChartXml(data: Buffer | undefined): Buffer | null {
  if (!data || data.length < 12) return null
  try {
    const cfb = CFB.read(data.subarray(4), { type: "buffer" })
    const e = CFB.find(cfb, "OOXMLChartContents")
    return e?.content?.length ? Buffer.from(e.content) : null
  } catch {
    return null
  }
}
