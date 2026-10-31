/**
 * HWP 5.x 필드 컨트롤('%clk' 누름틀·'%hlk' 하이퍼링크·'%usr' 사용자 정보·'%fmu' 계산식·'%bmk' 책갈피 …) → hp:fieldBegin / hp:fieldEnd.
 *
 * CTRL_HEADER: 컨트롤 id · 속성 u32(bit0 양식 모드에서 편집 가능, bit15 내용 고침) · 기타 속성 u8(=Prop) · 명령 문자열 · 필드 id u32.
 * 이름은 CTRL_DATA 매개변수 묶음의 문자열 항목. fieldid 는 컨트롤 id 4바이트를 u32 로 읽은 값('%clk' → 627272811).
 * 매개변수는 명령을 종류별로 풀어 쓴다 — 누름틀 안내문·도움말, 하이퍼링크 경로·종류, 계산식·결과 형식·마지막 값.
 */

import { Cur, type RecNode, el, escText } from "./util.js"
import { fileTimeText as fileTime } from "../record.js"
import { TAG, paragraphsXml } from "./section.js"
import { subListAttrs, type ConvertContext } from "./controls.js"

const FIELD_TYPES: Record<string, string> = {
  "%clk": "CLICK_HERE", "%hlk": "HYPERLINK", "%usr": "USER_INFO", "%fmu": "FORMULA", "%bmk": "BOOKMARK", "%dte": "DATE", "%ddt": "DOC_DATE",
  "%pat": "PATH", "%mmg": "MAILMERGE", "%xrf": "CROSSREF", "%smr": "SUMMERY", "%prv": "PRIVATE_INFO", "%toc": "TABLEOFCONTENTS",
  "%%me": "MEMO", "%cpr": "PRIVATE_INFO", "%unk": "UNKNOWN",
}
const LINK_CATEGORIES = ["HWPHYPERLINK_TYPE_HWP", "HWPHYPERLINK_TYPE_URL", "HWPHYPERLINK_TYPE_EMAIL", "HWPHYPERLINK_TYPE_EX"] as const
const LINK_TARGETS = ["HWPHYPERLINK_TARGET_BOOKMARK", "HWPHYPERLINK_TARGET_OUTLINE", "HWPHYPERLINK_TARGET_TABLE",
  "HWPHYPERLINK_TARGET_FIGURE", "HWPHYPERLINK_TARGET_EQUATION", "HWPHYPERLINK_TARGET_HYPERLINK"] as const
const LINK_OPENS = ["HWPHYPERLINK_JUMP_CURRENTTAB", "HWPHYPERLINK_JUMP_NEWTAB", "HWPHYPERLINK_JUMP_NEWWINDOW", "HWPHYPERLINK_JUMP_DONTCARE"] as const

/** CTRL_DATA 매개변수 묶음의 첫 문자열 항목 — 필드 이름 */
function ctrlDataName(node: RecNode): string {
  const cd = node.kids.find(k => k.rec.tagId === TAG.CTRL_DATA)
  if (!cd || cd.rec.data.length < 12) return ""
  const d = cd.rec.data
  const n = d.readUInt16LE(10)
  return d.length >= 12 + n * 2 ? d.toString("utf16le", 12, 12 + n * 2) : ""
}

const str = (name: string, v: string, preserve = false): string =>
  `<hp:stringParam name="${name}"${preserve ? ' xml:space="preserve"' : ""}>${escText(v)}</hp:stringParam>`

/** "Key:wstring:N:값" 꼴에서 값 N 글자 */
function wstringValue(command: string, key: string): string {
  const m = new RegExp(`${key}:wstring:(\\d+):`).exec(command)
  return m ? command.slice(m.index + m[0].length, m.index + m[0].length + Number(m[1])) : ""
}

function params(type: string, prop: number, command: string): string {
  const items: string[] = [`<hp:integerParam name="Prop">${prop}</hp:integerParam>`]
  const preserve = /^\s|\s$/.test(command)
  if (type === "BOOKMARK") return `<hp:parameters cnt="1" name="">${items[0]}</hp:parameters>`
  items.push(str("Command", command, preserve))
  if (type === "CLICK_HERE") {
    items.push(str("Direction", wstringValue(command, "Direction")))
    const help = wstringValue(command, "HelpState")
    if (help) items.push(str("HelpState", help))
  } else if (type === "HYPERLINK") {
    const parts = command.split(/(?<!\\);/)
    items.push(str("Path", parts[0].replace(/\\(.)/g, "$1")))
    items.push(str("Category", LINK_CATEGORIES[Number(parts[1])] ?? LINK_CATEGORIES[1]))
    items.push(str("TargetType", LINK_TARGETS[Number(parts[2])] ?? LINK_TARGETS[0]))
    items.push(str("DocOpenType", LINK_OPENS[Number(parts[3])] ?? LINK_OPENS[0]))
  } else if (type === "USER_INFO") {
    items.push(str("Category", command))
  } else if (type === "FORMULA") {
    const [formula, rest = ""] = command.split("??")
    const [format, last = ""] = rest.split(";;")
    items.push(str("Formula", formula), str("ResultFormat", format), str("LastResult", last))
  }
  return `<hp:parameters cnt="${items.length}" name="">${items.join("")}</hp:parameters>`
}

export interface FieldState { stack: Array<{ id: number; fieldid: number }> }


/**
 * 메모 — HWP 는 '%unk' 필드에 "MEMO/모양/번호/생성 시각 하위/상위/작성자/" 명령을 두고 글은 구역 끝 메모 목록에 둔다. HWPX 는 MEMO 필드
 * ('%%me') 매개변수와 subList 로 쓴다
 */
function memoFieldXml(id: number, a: number, prop: number, command: string, ctx: ConvertContext): string {
  const [, shape = "", num = "0", low = "0", high = "0", author = ""] = command.split("/")
  const n = Number(num) || 0
  const items = [`<hp:integerParam name="Prop">${prop}</hp:integerParam>`, str("Command", command), str("ID", `memo${n}`),
    `<hp:integerParam name="Number">${n}</hp:integerParam>`, str("Author", author), str("MemoShapeIDRef", shape),
    str("CreateDateTime", fileTime(Number(low) >>> 0, Number(high) >>> 0))]
  const g = ctx.memos.get(n)
  return el("hp:fieldBegin", [["id", id], ["type", "MEMO"], ["name", ""], ["editable", a & 1], ["dirty", (a >>> 15) & 1], ["zorder", n],
    ["fieldid", 0x25256d65]], `<hp:parameters cnt="${items.length}" name="">${items.join("")}</hp:parameters>`
    + (g ? el("hp:subList", subListAttrs(g.head.rec.data), paragraphsXml(g.paras, ctx)) : ""))
}

/** 필드 시작 컨트롤 → hp:ctrl/hp:fieldBegin, 열린 필드에 쌓는다 */
export function fieldBeginXml(node: RecNode, kind: string, ctx: ConvertContext): string {
  const state = ctx.fields
  const c = new Cur(node.rec.data, 4)
  const a = c.u32(), prop = c.u8(), command = c.str(), id = c.u32()
  if (kind === "%unk" && command.startsWith("MEMO/")) {
    state.stack.push({ id, fieldid: 0x25256d65 })
    return "<hp:ctrl>" + memoFieldXml(id, a, prop, command, ctx) + "</hp:ctrl>"
  }
  const fieldid = node.rec.data.readUInt32LE(0)
  state.stack.push({ id, fieldid })
  const type = FIELD_TYPES[kind] ?? "UNKNOWN"
  return "<hp:ctrl>" + el("hp:fieldBegin", [["id", id], ["type", type], ["name", ctrlDataName(node)], ["editable", a & 1],
    ["dirty", (a >>> 15) & 1], ["zorder", -1], ["fieldid", fieldid]], params(type, prop, command)) + "</hp:ctrl>"
}

/** 필드 끝(인라인 컨트롤 4) — 가장 안쪽 열린 필드와 짝 */
export function fieldEndXml(state: FieldState): string {
  const f = state.stack.pop()
  return f ? "<hp:ctrl>" + el("hp:fieldEnd", [["beginIDRef", f.id], ["fieldid", f.fieldid]]) + "</hp:ctrl>" : ""
}
