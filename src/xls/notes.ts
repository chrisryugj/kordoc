/**
 * XLS(BIFF8) 칸 메모 — MS-XLS 공개 명세의 NOTE(0x001C)·OBJ(0x005D)·TXO(0x01B6)+CONTINUE(0x003C).
 * 메모 글은 메모 개체(OBJ ftCmo ot=0x19) 뒤 TXO 의 CONTINUE 에, 칸 위치·작성자는 시트 끝 NOTE 에 있고 개체 id 로 잇는다.
 * XLSX 칸 메모와 같은 꼴(붙은 글 = 칸 글, 빈 칸은 칸 주소)
 */
import type { MemoNote } from "../types.js"
import type { BiffRecord } from "./record.js"
import type { RawCell } from "./cell.js"

const OP_NOTE = 0x001c, OP_OBJ = 0x005d, OP_TXO = 0x01b6, OP_CONTINUE = 0x003c, OP_BOF = 0x0809, OP_EOF = 0x000a
const OT_NOTE = 0x19

/** CONTINUE 조각마다 첫 바이트가 글자 폭(0 = 1바이트, 1 = UTF-16LE) — cch 글자를 모은다 */
function readContinuedText(records: BiffRecord[], from: number, cch: number): string {
  let out = ""
  for (let i = from; i < records.length && records[i].opcode === OP_CONTINUE && out.length < cch; i++) {
    const d = records[i].data
    if (d.length < 1) break
    const wide = (d[0] & 1) === 1
    const body = d.subarray(1)
    const take = cch - out.length
    out += wide ? body.subarray(0, Math.min(body.length, take * 2)).toString("utf16le") : body.subarray(0, Math.min(body.length, take)).toString("latin1")
  }
  return out
}

/** XLUnicodeString: cch u16 · fHighByte u8 · 글자 */
function xlString(d: Buffer, at: number): string {
  if (at + 3 > d.length) return ""
  const cch = d.readUInt16LE(at), wide = (d[at + 2] & 1) === 1
  const s = at + 3
  return wide ? d.subarray(s, s + cch * 2).toString("utf16le") : d.subarray(s, s + cch).toString("latin1")
}

const colName = (c: number): string => { let s = ""; for (c++; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s }

export function sheetNotes(records: BiffRecord[], bofIndex: number, cells: RawCell[]): MemoNote[] {
  const text = new Map<number, string>()
  const notes: Array<{ row: number; col: number; id: number; author: string }> = []
  let noteObj = -1, depth = 0
  for (let i = bofIndex + 1; i < records.length; i++) {
    const r = records[i]
    if (r.opcode === OP_BOF) { depth++; continue }  // 시트 안 차트 등 하위 흐름은 건너뛴다
    if (r.opcode === OP_EOF) { if (depth-- === 0) break; continue }
    if (depth > 0) continue
    if (r.opcode === OP_OBJ && r.data.length >= 8 && r.data.readUInt16LE(0) === 0x15) {
      noteObj = r.data.readUInt16LE(4) === OT_NOTE ? r.data.readUInt16LE(6) : -1
    } else if (r.opcode === OP_TXO && noteObj >= 0 && r.data.length >= 12) {
      const cch = r.data.readUInt16LE(10)
      if (cch > 0) text.set(noteObj, readContinuedText(records, i + 1, cch).replace(/\r\n?/g, "\n").trim())
      noteObj = -1
    } else if (r.opcode === OP_NOTE && r.data.length >= 8) {
      notes.push({ row: r.data.readUInt16LE(0), col: r.data.readUInt16LE(2), id: r.data.readUInt16LE(6), author: xlString(r.data, 8).replace(/\0+$/, "") })
    }
  }
  const at = new Map(cells.map(c => [`${c.row},${c.col}`, c.value]))
  const out: MemoNote[] = []
  for (const n of notes) {
    let t = text.get(n.id) ?? ""
    if (n.author && t.startsWith(n.author + ":")) t = t.slice(n.author.length + 1).trim()  // 엑셀이 글 첫 줄에 넣는 "작성자:"
    if (!t) continue
    const v = at.get(`${n.row},${n.col}`)
    const cell = v === null || v === undefined ? "" : String(v).trim()
    out.push({ text: t, anchor: cell || `${colName(n.col)}${n.row + 1}`, paragraph: cell, offset: 0, ...(n.author ? { author: n.author } : {}) })
  }
  return out
}
