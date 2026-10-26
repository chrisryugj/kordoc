import { it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parse } from "../src/index.js"
import { parseGwangyangBlock } from "../src/hwpx/gen-gwangyang-block.js"
import { dataCellSpec } from "../src/hwpx/gen-table-bf.js"

const fence = (v: object) => "```gwangyang\n" + JSON.stringify(v) + "\n```"
const options = { gongmun: {preset:"report" as const,agency:"광양시"} }
it("1안의 붙임·흰 설명상자·보라 설명상자·표 제목을 자유 문안으로 생성한다",async()=>{
 const md=["# 부품 확인",fence({type:"attachment",label:"붙임 12",title:"세부 내역"}),fence({type:"box",title:"관련 현황",body:["※ 13pt 참고","* 11pt 주석"]}),fence({type:"box",variant:"purple",title:"검토 의견",body:["▣ **검토할 사항**","◦ 가변 문안"]}),fence({type:"table-title",title:"비용 비교"})].join("\n\n")
 const warnings:string[]=[]
 const buf=await markdownToHwpx(md,{...options,warnings}),z=await JSZip.loadAsync(buf)
 assert.ok(!warnings.some(w=>w.includes("요약박스가 없습니다")))
 const h=await z.file("Contents/header.xml")!.async("string"),s=await z.file("Contents/section0.xml")!.async("string")
 assert.match(h,/faceColor="#3A3C84"/)
 assert.match(s,/treatAsChar="1"/)
 assert.match(h,/height="1100"/)
 assert.match(h,/height="1300"/)
 assert.match(h,/<hh:underline type="BOTTOM"/)
 assert.match(h,/width="0.25 mm" color="#263056"/)
 assert.equal((s.match(/<hp:tbl /g)??[]).length,4)
 const result=await parse(buf)
 for(const t of ["붙임 12","세부 내역","검토 의견","가변 문안","비용 비교"]) assert.ok(result.markdown.includes(t),t)
})
it("잘못된 부품 입력은 내용을 조용히 버리지 않고 오류로 알려준다",async()=>{
 for(const value of ['not json','[]',JSON.stringify({type:"box",title:"x",body:"text"}),JSON.stringify({type:"box",title:"x",body:["x"],variant:"green"}),JSON.stringify({type:"attachment",title:"x",typo:"x"})]) assert.throws(()=>parseGwangyangBlock(value),/gwangyang/)
 await assert.rejects(markdownToHwpx(fence({type:"box",title:"x",body:["x"]}),{gongmun:{preset:"report",reportFrame:"gwangyang-2"}}),/광양시 1안/)
})
it("병합 첫 열의 묶음 경계는 실선, 내부 행 경계는 점선이다",async()=>{
 const md="# 묶음표\n\n<table>\n<tr><th>그룹</th><th>항목</th></tr>\n<tr><td rowspan=\"2\">A</td><td>가</td></tr>\n<tr><td>나</td></tr>\n<tr><td rowspan=\"2\">B</td><td>다</td></tr>\n<tr><td>라</td></tr>\n</table>"
 const z=await JSZip.loadAsync(await markdownToHwpx(md,options))
 const s=await z.file("Contents/section0.xml")!.async("string"),h=await z.file("Contents/header.xml")!.async("string")
 const cells=[...s.matchAll(/<hp:tc [\s\S]*?<\/hp:tc>/g)].map(m=>m[0])
 const getBorder=(text:string)=>{
  const cell=cells.find(c=>c.includes(`<hp:t>${text}</hp:t>`))!
  const id=cell.match(/borderFillIDRef="(\d+)"/)![1]
  return [...h.matchAll(/<hh:borderFill [\s\S]*?<\/hh:borderFill>/g)].map(m=>m[0]).find(b=>b.startsWith(`<hh:borderFill id="${id}"`))!
 }
 assert.match(getBorder("가"),/<hh:bottomBorder type="DASH"/)
 assert.match(getBorder("나"),/<hh:bottomBorder type="SOLID"/)
 assert.match(getBorder("다"),/<hh:topBorder type="SOLID"/)
 const base={theme:"gwangyang-1" as const,row:2,rowEnd:2,col:1,colEnd:1,rowCnt:5,colCnt:2,headerRows:1,groupBoundaries:new Set([1,3,5])}
 assert.equal(dataCellSpec(base).b,"thin")
})
