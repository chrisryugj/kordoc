import { it } from "node:test"
import assert from "node:assert/strict"
import { fitGwangyangText } from "../src/hwpx/gen-gwangyang-fit.js"
import { fitParagraph } from "../src/hwpx/fit-line.js"
import type { FrameCtx } from "../src/hwpx/gen-frame-seoul.js"
const ctx=(minRatio:number|null=90,safety?:number)=>({fit:{minRatio,safety}} as FrameCtx)
it("기관 문단은 기존 fitParagraph와 같은 압축을 쓰고 글자 크기를 유지한다",()=>{
 let changed=0
 for(let n=7;n<35;n++){
  const text='관련 사항을 검토하고 '.repeat(n)
  const want=fitParagraph(text,'맑은 고딕',13,44000,44000,90)
  const got=fitGwangyangText(text,'맑은 고딕',13,44000,ctx())
  assert.equal(got.pt,13)
  assert.equal(got.ratio,want?.ratio??100);assert.equal(got.spacing,want?.spacing??0)
  if(got.ratio!==100 || got.spacing!==0) changed++
 }
 assert.ok(changed>0,'실제 고아 줄 압축 사례')
})
it("autoFit false·minRatio·safety를 제목과 본문에 전달한다",()=>{
 for(const oneLine of [false,true]) {
  const text='부서별 행정문서 작성 체계 개선 및 공통서식 적용 검토사항'
  const off=fitGwangyangText(text,'맑은 고딕',13,16000,ctx(null),oneLine)
  assert.equal(off.ratio,100);assert.equal(off.spacing,0);assert.equal(off.pt,13)
  const fit=fitGwangyangText(text,'맑은 고딕',13,16000,ctx(97,0.95),oneLine)
  assert.ok(fit.ratio>=97);assert.equal(fit.pt,13)
 }
})
it("인라인 마크다운을 제거한 표시 문안으로 높이와 압축을 계산한다",()=>{
 assert.deepEqual(fitGwangyangText('**검토사항** 및 세부내용','맑은 고딕',13,8000,ctx()),fitGwangyangText('검토사항 및 세부내용','맑은 고딕',13,8000,ctx()))
})
import { markdownToHwpx } from "../src/index.js"
import JSZip from "jszip"
it("긴 설명상자는 떠 있는 표 대신 본문 흐름의 여러 상자로 이어진다",async()=>{
 const body=Array.from({length:24},(_,i)=>`검토항목${i}: 관련 부서와 협의하여 문서 작성 기준과 세부 운영방안을 검토하고 필요한 사항을 보완합니다.`)
 const md='# 검토보고\n\n```gwangyang\n'+JSON.stringify({type:'box',title:'검토사항',variant:'purple',body})+'\n```'
 const z=await JSZip.loadAsync(await markdownToHwpx(md,{gongmun:{preset:'report',agency:'광양시'}}))
 const s=await z.file('Contents/section0.xml')!.async('string')
 assert.ok((s.match(/<hp:tbl /g)??[]).length>=3)
 assert.ok(!s.includes('treatAsChar="0"'))
 for(let i=0;i<24;i++)assert.equal(s.split(`검토항목${i}:`).length-1,1)
})
it("한 쪽보다 큰 단일 상자 문단은 조용히 자르지 않는다",async()=>{
 const md='```gwangyang\n'+JSON.stringify({type:'box',title:'검토사항',body:['긴 문안 '.repeat(700)]})+'\n```'
 await assert.rejects(markdownToHwpx(md,{gongmun:{preset:'report',agency:'광양시'}}),/여러 문단으로 나누세요/)
})
