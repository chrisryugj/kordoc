import { fitGwangyangText } from "./gen-gwangyang-fit.js"
import { buildGwangyangExtended } from "./gen-gwangyang-extended.js"
import type { ImageRegistry } from "./gen-image.js"
/** 1안의 독립 서식 부품: JSON fence → 편집 가능한 표. 원본 표 2~5 실측. */
import { type FrameCtx, ftbl, host } from "./gen-frame-seoul.js"
import { tc, para } from "./gen-gongmun-extra.js"
import { type CellBfSpec } from "./gen-table-bf.js"
import { generateParagraph } from "./md-runs.js"
import { inlineMapper } from "./style-registry.js"

export interface GwangyangBlock {
  type: "attachment" | "box" | "table-title" | "staff-header" | "institution-cover" | "rounded-box"
  title: string
  label?: string
  variant?: "white" | "purple" | "plain" | "tab"
  body?: string[]
  date?: string
  staff?: {role:string; name:string; phone:string}[]
  subtitle?: string
  dept?: string
  documentNumber?: string
  retention?: string
  disclosure?: string
  approvers?: string[]
}

export function parseGwangyangBlock(text: string): GwangyangBlock {
  const fail = (message: string): never => { throw new Error(`gwangyang 블록: ${message}`) }
  let value: unknown
  try { value = JSON.parse(text, (_key, value) => typeof value === "string" ? value.replace(/·/g,"‧") : value) } catch { return fail("유효한 JSON이 필요합니다") }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("객체가 필요합니다")
  const v = value as Record<string, unknown>
  const fields:Record<string,string[]> = {
    attachment:["label"], box:["variant","body"], "table-title":[],
    "rounded-box":["variant","body"], "staff-header":["date","staff"],
    "institution-cover":["subtitle","date","dept","documentNumber","retention","disclosure","approvers","body"],
  }
  if (typeof v.type !== "string" || !Object.hasOwn(fields,v.type)) return fail("지원하지 않는 type")
  const allowed = new Set(["type","title",...fields[v.type]])
  for (const key of Object.keys(v)) if (!allowed.has(key)) return fail(`지원하지 않는 필드: ${key}`)
  for (const key of ["title","label","date","subtitle","dept","documentNumber","retention","disclosure"]) {
    if ((key === "title" || v[key] !== undefined) && (typeof v[key] !== "string" || !v[key].trim() || v[key].length > (key === "title" ? 200 : key === "label" ? 20 : 80))) return fail(`${key} 문자열 길이를 확인하세요`)
  }
  if (["box","rounded-box","institution-cover"].includes(v.type) && (!Array.isArray(v.body) || !v.body.length || v.body.length > 100 || v.body.some(s=>typeof s !== "string" || s.length>5000))) return fail("body는 문자열 배열(1~100개)이어야 합니다")
  if (v.variant !== undefined && !(v.type === "box" ? ["white","purple"] : ["plain","tab"]).includes(String(v.variant))) return fail("지원하지 않는 variant")
  if (v.type === "staff-header") {
    if (typeof v.date !== "string" || !Array.isArray(v.staff) || !v.staff.length || v.staff.length>4) return fail("date와 staff 1~4명이 필요합니다")
    for (const s of v.staff) {
      if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).some(k=>!["role","name","phone"].includes(k)) || ["role","name","phone"].some(k=>typeof s[k] !== "string" || s[k].length>40)) return fail("staff에는 role, name, phone 문자열을 지정하세요")
    }
  }
  if (v.approvers !== undefined && (!Array.isArray(v.approvers) || !v.approvers.length || v.approvers.length>6 || v.approvers.some(s=>typeof s !== "string" || !s.trim() || s.length>20))) return fail("approvers는 직위 문자열 1~6개입니다")
  return v as unknown as GwangyangBlock
}

const none: CellBfSpec = { t: "none", b: "none", l: "none", r: "none" }

export function buildGwangyangBlock(block: GwangyangBlock, ctx: FrameCtx, images: ImageRegistry | null = null): string {
  if (["staff-header","institution-cover","rounded-box"].includes(block.type)) return buildGwangyangExtended(block,ctx,images)
  const { reg, bf, W } = ctx
  if (block.type === "table-title") {
    const f=fitGwangyangText(block.title,"휴먼명조",12,W,ctx,true)
    const cp = reg.char({ font: "휴먼명조", pt: 12, ratio:f.ratio,spacing:f.spacing,bold: true, underline: true })
    return generateParagraph(block.title, reg.para({ align: "CENTER", before: 600, after: 565, keepWithNext: true }), cp)
  }
  if (block.type === "attachment") {
    const label = block.label ?? "붙임 1"
    const lw = Math.round(W*5895/47904), gap = Math.round(W*454/47904), tw = W-lw-gap
    const fit = fitGwangyangText(block.title, ctx.frame.titleFont, 16, tw-300, ctx,true)
    const lf = fitGwangyangText(label, ctx.frame.titleFont, 16, lw-300, ctx,true)
    const cp = reg.char({ font: ctx.frame.titleFont, pt: fit.pt, ratio: fit.ratio, spacing: fit.spacing })
    const lp = reg.char({ font: ctx.frame.titleFont, pt: lf.pt, ratio: lf.ratio, spacing: lf.spacing, bold: true, color: "#FFFFFF" })
    const specs: CellBfSpec[] = [{ ...none, r: "thin", fill: "#003366" }, none, { ...none, b: ["0.25 mm", "#263056"] }]
    const height=Math.max(2776,Math.max(fit.lines,lf.lines)*16*130+282)
    const row = [lw,gap,tw].map((w,col) => tc({row:0,col,w,h:height,bf:bf.get(specs[col]),paras:para(col === 0 ? label : col === 2 ? block.title : "",reg.para({align: col === 0 ? "CENTER" : "LEFT",lineSp:130}),col === 0 ? lp : cp)})).join("")
    return host(ftbl([row],W,height,3),reg.para({before:1400,after:800,keepWithNext:true}),cp)
  }
  const purple = block.variant === "purple", w = W-1500
  const side = Math.round(w * (purple ? 14342/46428 : 10941/46429)), mid = w-2*side
  const baseCapHeight = purple ? 2094 : 1696
  const title = purple ? block.title : `〈 ${block.title} 〉`
  const fit = fitGwangyangText(title,"맑은 고딕",purple ? 12 : 13,mid-300,ctx,true)
  const capLines = fit.lines
  const capHeight = Math.max(baseCapHeight,Math.ceil((capLines*fit.pt*100+300)/2)*2), half=capHeight/2
  const cap = reg.char({font:"맑은 고딕",pt:fit.pt,ratio:fit.ratio,spacing:fit.spacing,bold:true,color:purple ? "#FFFFFF" : "#000000"})
  const blank = para("",reg.para({lineSp:100}),reg.char({font:"맑은 고딕",pt:1}))
  const bodyRows = (block.body ?? []).map((line, index, all) => {
    const pt = /^\s*\*\s/.test(line) ? 11 : 13
    const fit=fitGwangyangText(line,"맑은 고딕",pt,w-1200,ctx)
    const style = {font:"맑은 고딕",pt,bold:false,ratio:fit.ratio,spacing:fit.spacing}
    const lines = fit.lines
    const height = Math.max(1,lines)*pt*160+280
    const paragraphs = generateParagraph(line,reg.para({left:400,right:400,lineSp:160,keepWord:fit.keepWord,widowOrphan:true}),reg.char(style),inlineMapper(reg,style))
    return {height,xml:tc({row:index+2,col:0,colSpan:3,w,h:height,bf:bf.get({...none,l:"thin",r:"thin",b:index === all.length-1 ? "thin" : "none"}),paras:paragraphs})}
  })
  if(bodyRows.some(row=>row.height+capHeight>45000)) throw new Error("gwangyang 설명상자 문단이 한 쪽보다 깁니다. body 항목을 여러 문단으로 나누세요")
  const bodyHeight = bodyRows.reduce((sum,row)=>sum+row.height,0)
  // 떠 있는 표는 다음 쪽에서 뒤 표와 겹칠 수 있다. 한 쪽 단위로 묶어 본문 흐름에 배치한다.
  if (capHeight+bodyHeight>45000 && bodyRows.length>1) {
    const groups:string[][]=[];let group:string[]=[],height=capHeight
    bodyRows.forEach((row,i)=>{
      if(group.length && height+row.height>45000){groups.push(group);group=[];height=capHeight}
      group.push(block.body![i]);height+=row.height
    });if(group.length)groups.push(group)
    return groups.map(body=>buildGwangyangBlock({...block,body},ctx,images)).join("")
  }

  const cell = (row:number,col:number,width:number,height:number,spec:CellBfSpec,paras:string,span=1) => tc({row,col,w:width,h:height,bf:bf.get(spec),paras,rowSpan:span})
  const rows = [
    cell(0,0,side,half,none,blank)+cell(0,1,mid,capHeight,purple ? {...none,fill:"#3A3C84"} : none,para(title,reg.para({align:"CENTER",lineSp:100}),cap),2)+cell(0,2,side,half,none,blank),
    cell(1,0,side,half,{...none,t:"thin",l:"thin"},blank)+cell(1,2,side,half,{...none,t:"thin",r:"thin"},blank),
    ...bodyRows.map(row=>row.xml)
  ]
  return host(ftbl(rows,w,capHeight+bodyHeight,3,{bottomGap:0}),reg.para({align:"CENTER",lineSp:100,before:800,after:900}),cap)
}
