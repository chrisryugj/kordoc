import { fitGwangyangText } from "./gen-gwangyang-fit.js"
/** 광양시 1안: 사용자 제공 HWPX 실측. 2안: 원문 PDF에서 관찰한 3색 띠. */
import { type FrameCtx, ftbl, host } from "./gen-frame-seoul.js"
import { tc, para } from "./gen-gongmun-extra.js"
import { type CellBfSpec } from "./gen-table-bf.js"
import { type ImageRegistry } from "./gen-image.js"

export type ReportFrame = "gwangyang-1" | "gwangyang-2"
const BLUE = "#003366"
const none: CellBfSpec = { t: "none", b: "none", l: "none", r: "none" }

export function localTitle(title: string, variant: ReportFrame, ctx: FrameCtx, images: ImageRegistry | null, appearance: {subtitle?:string;color?:string;pt?:number} = {}): { xml: string; overflow: boolean } {
  const { reg, bf, W } = ctx
  const first = variant === "gwangyang-1"
  const size = appearance.pt ?? (first ? 20 : 22)
  const pp = reg.para({ align: "CENTER", lineSp: 130 })
  const fit = fitGwangyangText(title, ctx.frame.titleFont, size, W - 1200,ctx,true)
  const cp = reg.char({ font: ctx.frame.titleFont, pt: fit.pt, ratio: fit.ratio, spacing: fit.spacing, bold: !first, color: appearance.color ?? "#000000" })
  const empty = para("", reg.para({ lineSp: 100 }), reg.char({ font: ctx.frame.titleFont, pt: 1 }))
  if (first) {
    // 장식 이미지 대신 기존 높이의 빈 셀을 남긴다.
    const sub=appearance.subtitle ? fitGwangyangText(appearance.subtitle,ctx.frame.titleFont,16,W-1800,ctx,true) : null
    const heights = [537, Math.max(appearance.subtitle ? 5500 : 3116, fit.lines*size*130+282+(sub?sub.lines*16*120:0)), 565]
    const rows = heights.map((h,row) => tc({ row, col: 0, w: W, h,
      bf: bf.get(none),
      paras: row === 1 ? (appearance.subtitle ? para(appearance.subtitle,reg.para({left:1400,lineSp:120}),reg.char({font:ctx.frame.titleFont,pt:16,ratio:sub!.ratio,spacing:sub!.spacing})) : "") + para(title, pp, cp) : empty }))
    return { xml: host(ftbl(rows, W, heights.reduce((a,b) => a+b,0), 1), reg.para({ after: 1400, keepWithNext: true }), cp), overflow: fit.overflow }
  }
  const widths = [Math.floor(W / 8), Math.floor(W / 4), Math.floor(W / 4), Math.floor(W / 4)]
  widths.push(W - widths.reduce((a,b) => a+b, 0))
  const colors = ["#FFFFFF", BLUE, "#00A6D0", "#94C83D", "#FFFFFF"]
  const stripe = widths.map((w,col) => tc({ row: 0, col, w, h: 850, bf: bf.get({ ...none, fill: colors[col] }), paras: empty })).join("")
  const titleHeight=Math.max(4800,fit.lines*size*130+282)
  const titleRow = tc({ row: 1, col: 0, colSpan: 5, w: W, h: titleHeight, bf: bf.get({ ...none, t: ["1.0 mm", "#CCCCCC"], b: ["1.0 mm", "#CCCCCC"] }), paras: para(title, pp, cp) })
  return { xml: host(ftbl([stripe, titleRow], W, titleHeight+850, 5), reg.para({ after: 1400, keepWithNext: true }), cp), overflow: fit.overflow }
}

export function localChapter(title: string, index: number, variant: ReportFrame, ctx: FrameCtx): string {
  const { reg, bf, W } = ctx
  const first = variant === "gwangyang-1"
  const square = first ? Math.round(W * 2919/48046) : 2500
  const gap = first ? Math.round(W * 737/48046) : 600
  const baseHeight = first ? 2719 : 2500
  const widths = [square, gap, W-square-gap]
  const fit = fitGwangyangText(title, ctx.frame.titleFont, 16, widths[2] - 600,ctx,true)
  const height=Math.max(baseHeight,fit.lines*16*130+282)
  const cp = reg.char({ font: ctx.frame.titleFont, pt: fit.pt, ratio: fit.ratio, spacing: fit.spacing, bold: !first, color: "#000000" })
  const label = first ? String(index) : ["Ⅰ","Ⅱ","Ⅲ","Ⅳ","Ⅴ","Ⅵ","Ⅶ","Ⅷ","Ⅸ","Ⅹ"][index-1] ?? String(index)
  const specs: CellBfSpec[] = [first ? { ...none, fill: BLUE } : { t: ["0.12 mm", "#999999"], l: ["0.12 mm", "#999999"], r: ["0.5 mm", BLUE], b: ["0.5 mm", BLUE] }, none,
    { ...none, b: first ? ["0.4 mm", "#263056"] : ["0.2 mm", BLUE] }]
  const row = widths.map((w,col) => tc({ row: 0, col, w, h: height, bf: bf.get(specs[col]), paras: para(col === 0 ? label : col === 2 ? " " + title : "", reg.para({ align: col === 0 ? "CENTER" : "LEFT", lineSp: 130 }), col === 0 ? reg.char({ font: ctx.frame.titleFont, pt: 16, bold: true, color: first ? "#FFFFFF" : "#000000" }) : cp) })).join("")
  return host(ftbl([row], W, height, widths.length), reg.para({ before: 1400, after: 800, keepWithNext: true }), cp)
}

/** 보고요지는 별도 제목 없는 무지 레터박스. 캡션 설명상자는 명시적 box 블록으로 제공한다. */
export function localSummary(text: string, variant: ReportFrame, ctx: FrameCtx, body: { font: string; pt: number }): { xml: string; lines: number } {
  const { reg, bf, W } = ctx
  text=text.replace(/·/g,"‧")
  const f=fitGwangyangText(text,body.font,body.pt,W-3700,ctx)
  const cp = reg.char({...body,ratio:f.ratio,spacing:f.spacing})
  const pp = reg.para({ lineSp: 160,keepWord:f.keepWord,widowOrphan:true })
  const lines=f.lines
  if (variant === "gwangyang-2") return { xml: para(text, reg.para({ lineSp: 160, after: 700 }), cp), lines }
  const w=W-1500, h=lines*body.pt*160+1400
  const row=tc({row:0,col:0,w,h,name:"__kordoc_summary",bf:bf.get({t:"thin",b:"thin",l:"thin",r:"thin"}),paras:para(text,pp,cp)})
    .replace('hasMargin="0"','hasMargin="1"')
    .replace('<hp:cellMargin left="141" right="141" top="141" bottom="141"/>','<hp:cellMargin left="1100" right="1100" top="700" bottom="700"/>')
  return {xml:host(ftbl([row],w,h,1),reg.para({align:"CENTER",lineSp:100,after:700,keepWithNext:true}),cp),lines}
}
