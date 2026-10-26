import { it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parse } from "../src/index.js"
import { DOMParser } from "@xmldom/xmldom"
import { parseGwangyangBlock } from "../src/hwpx/gen-gwangyang-block.js"
const f=(v:object)=>"```gwangyang\n"+JSON.stringify(v)+"\n```"
const staff={type:"staff-header",title:"담당자",date:"2026. 10. 26.",staff:[{role:"팀장",name:"홍길동",phone:"0000"}]}
const rounded={type:"rounded-box",title:"검토 개요",variant:"tab",body:["□ 변경 가능한 본문 & 참고 <값>"]}
const cover={type:"institution-cover",title:"표지 제목",dept:"담당부서",body:["□ 표지 요약"],approvers:["담당자","과장"]}
const options={gongmun:{preset:"report" as const,agency:"광양시",cover:false as const,toc:false}}
it("담당자 머리표는 H1 앞에 한 번만 나오고 로고 자리를 비워 둔다",async()=>{
 const buf=await markdownToHwpx(["# 본문제목",f(staff),f(rounded)].join("\n\n"),options),z=await JSZip.loadAsync(buf)
 const s=await z.file("Contents/section0.xml")!.async("string")
 assert.ok(s.indexOf("홍길동")<s.indexOf("본문제목"));assert.equal(s.split("홍길동").length-1,1)
 assert.match(s,/xmlns:hc="http:\/\/www.hancom.co.kr\/hwpml\/2011\/core"/)
 assert.equal(z.file(/BinData\//).length,0)
 assert.ok(!s.includes("<hp:pic"))
 assert.ok(!s.includes("감동시대"));assert.doesNotThrow(()=>new DOMParser({onError:(_level,message)=>{throw new Error(message)}}).parseFromString(s,"text/xml"))
 const parsed=await parse(buf)
 assert.ok(parsed.markdown.includes("변경 가능한 본문"))
 assert.match(s,/<hp:drawText[^>]+editable="1"/);assert.match(s,/ratio="3"/);assert.match(s,/ratio="20"/)
})
it("기관 표지 다음에 머리표와 본문이 새 쪽에서 시작한다",async()=>{
 const z=await JSZip.loadAsync(await markdownToHwpx(["# 본문제목",f(cover),f(staff),f(rounded)].join("\n\n"),options))
 const s=await z.file("Contents/section0.xml")!.async("string")
 assert.ok(s.indexOf("표지 제목")<s.indexOf("홍길동"))
 assert.match(s,/<hp:p pageBreak="1"/)
 assert.equal(s.split("표지 제목").length-1,1)
 assert.doesNotThrow(()=>new DOMParser({onError:(_level,message)=>{throw new Error(message)}}).parseFromString(s,"text/xml"))
})
it("중복 표지·머리표, 잘못된 필드, 한 쪽보다 큰 도형은 오류로 처리한다",async()=>{
 for(const v of [{...staff,staff:[]},{...staff,staff:[{role:"팀장",name:"홍길동"}]},{...cover,approvers:[]},{...rounded,variant:"purple"},{...rounded,body:[]}]) assert.throws(()=>parseGwangyangBlock(JSON.stringify(v)),/gwangyang/)
 await assert.rejects(markdownToHwpx([f(staff),f(staff)].join("\n\n"),options),/하나씩/)
 await assert.rejects(markdownToHwpx(f(cover),{gongmun:{...options.gongmun,cover:true}}),/중복/)
 await assert.rejects(markdownToHwpx(f({...rounded,body:Array(40).fill("긴 내용 ".repeat(15))}),options),/높이를 초과/)
})

it("머리표는 원본의 세로 구분선·직위 균등배치·날짜 높이를 보존한다",async()=>{
 const z=await JSZip.loadAsync(await markdownToHwpx(["# 헤더 확인",f(staff),f(rounded)].join("\n\n"),options))
 const s=await z.file("Contents/section0.xml")!.async("string"),h=await z.file("Contents/header.xml")!.async("string")
 const dom=new DOMParser().parseFromString(s,"text/xml")
 const tables=Array.from(dom.getElementsByTagName("hp:tbl"))
 const table=tables.find(t=>t.getAttribute("colCnt")==="4" && t.textContent?.includes("홍길동"))!
 const cells=Array.from(table.getElementsByTagName("hp:tc"))
 assert.equal(cells.length,5)
 assert.equal(cells[2].getElementsByTagName("hp:cellSz")[0].getAttribute("height"),"1382")
 const header=new DOMParser().parseFromString(h,"text/xml")
 for(const cell of cells.slice(3)) {
   const bf=Array.from(header.getElementsByTagName("hh:borderFill")).find(b=>b.getAttribute("id")===cell.getAttribute("borderFillIDRef"))!
   for(const edge of ["leftBorder","rightBorder"]) assert.equal(bf.getElementsByTagName("hh:"+edge)[0].getAttribute("type"),"SOLID")
 }
 assert.match(h,/face="HY울릉도M"/)
 const roleId=cells[3].getElementsByTagName("hp:p")[0].getAttribute("paraPrIDRef")
 const rolePara=Array.from(header.getElementsByTagName("hh:paraPr")).find(p=>p.getAttribute("id")===roleId)!
 assert.equal(rolePara.getElementsByTagName("hh:align")[0].getAttribute("horizontal"),"DISTRIBUTE")
})

it("머리표 뒤 첫 인용문은 참고문이 아니라 보고요지 상자가 된다",async()=>{
 const z=await JSZip.loadAsync(await markdownToHwpx(["# 제목",f(staff),"> 기관 서식 지원을 추진하고자 함","## 추진 내용","○ 작성 시험"].join("\n\n"),options))
 const s=await z.file("Contents/section0.xml")!.async("string")
 assert.match(s,/name="__kordoc_summary"/)
 assert.ok(!s.includes("보고 요지"))
 assert.match(s,/<hp:cellMargin left="1100" right="1100" top="700" bottom="700"\/>/)
 assert.ok(!s.includes("※"))
 const dom=new DOMParser().parseFromString(s,"text/xml")
 const table=Array.from(dom.getElementsByTagName("hp:tbl")).find(t=>t.textContent?.includes("홍길동"))!
 assert.equal(table.getElementsByTagName("hp:tbl").length,0)
 const h=new DOMParser().parseFromString(await z.file("Contents/header.xml")!.async("string"),"text/xml")
 const last=Array.from(table.getElementsByTagName("hp:tc")).at(-1)!
 const bf=Array.from(h.getElementsByTagName("hh:borderFill")).find(b=>b.getAttribute("id")===last.getAttribute("borderFillIDRef"))!
 for(const edge of ["rightBorder","bottomBorder"]) assert.equal(bf.getElementsByTagName("hh:"+edge)[0].getAttribute("type"),"SOLID")
})

it("광양시 본문·요지·상자 가운뎃점은 U+2027로 생성한다",async()=>{
 const z=await JSZip.loadAsync(await markdownToHwpx(["# 표기 시험","> 기획·검토","## 내용","ㅇ 작성·출력",f({...rounded,body:["서식·피팅"]}),"| 구분 | 내용 |","|---|---|","| 계획·보고 | 생성·검증 |"].join("\n\n"),options))
 const s=await z.file("Contents/section0.xml")!.async("string")
 for(const text of ["기획‧검토","작성‧출력","서식‧피팅"]) assert.ok(s.includes(text))
 assert.ok(!s.includes("·"))
})

it("기관 표지 하단 부서명은 시명 폭에 맞춰 균등 배치한다",async()=>{
 const z=await JSZip.loadAsync(await markdownToHwpx(f({...cover,dept:"담당부서"}),options))
 const section=new DOMParser().parseFromString(await z.file("Contents/section0.xml")!.async("string"),"text/xml")
 const header=new DOMParser().parseFromString(await z.file("Contents/header.xml")!.async("string"),"text/xml")
 const p=Array.from(section.getElementsByTagName("hp:p")).find(p=>p.textContent==="담당부서")!
 const style=Array.from(header.getElementsByTagName("hh:paraPr")).find(s=>s.getAttribute("id")===p.getAttribute("paraPrIDRef"))!
 assert.equal(style.getElementsByTagName("hh:align")[0].getAttribute("horizontal"),"DISTRIBUTE")
 assert.ok(Number(style.getElementsByTagName("hc:right")[0].getAttribute("value"))>0)
})

it("광양시 GFM·HTML·상자 표는 글자취급이고 바깥 여백은 모두 0이다",async()=>{
 const md="# 표 배치\n\n> 보고 목적\n\n| 구분 | 내용 |\n|---|---|\n| 입력 | 확인 |\n\n<table><tr><td>병합</td><td>표</td></tr><tr><td>가</td><td>나</td></tr></table>\n\n"+f({type:"box",variant:"purple",title:"확인",body:["설명"]})
 const z=await JSZip.loadAsync(await markdownToHwpx(md,options))
 const d=new DOMParser().parseFromString(await z.file("Contents/section0.xml")!.async("string"),"text/xml")
 for(const t of Array.from(d.getElementsByTagName("hp:tbl"))){
   const children=Array.from(t.childNodes) as any[]
   const pos=children.find(c=>c.nodeName==="hp:pos"),margin=children.find(c=>c.nodeName==="hp:outMargin")
   assert.equal(pos.getAttribute("treatAsChar"),"1")
   for(const edge of ["left","right","top","bottom"]) assert.equal(margin.getAttribute(edge),"0")
 }
})

it("광양시 본문 표의 앞뒤 간격은 개체 여백이 아닌 호스트 문단에 둔다",async()=>{
 const z=await JSZip.loadAsync(await markdownToHwpx("# 표 간격\n\n| 구분 | 내용 |\n|---|---|\n| 입력 | 확인 |\n\n<table><tr><td>HTML</td></tr><tr><td>검사</td></tr></table>",options))
 const d=new DOMParser().parseFromString(await z.file("Contents/section0.xml")!.async("string"),"text/xml")
 const h=new DOMParser().parseFromString(await z.file("Contents/header.xml")!.async("string"),"text/xml")
 for(const t of Array.from(d.getElementsByTagName("hp:tbl")).filter(t=>t.textContent?.includes("입력")||t.textContent?.includes("HTML"))){
   const host=t.parentNode!.parentNode as Element
   const p=Array.from(h.getElementsByTagName("hh:paraPr")).find(p=>p.getAttribute("id")===host.getAttribute("paraPrIDRef"))!
   assert.equal(p.getElementsByTagName("hc:prev")[0].getAttribute("value"),"400")
   assert.equal(p.getElementsByTagName("hc:next")[0].getAttribute("value"),"800")
   assert.equal(p.getElementsByTagName("hh:lineSpacing")[0].getAttribute("value"),"100")
 }
})
