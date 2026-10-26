import { it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { GWANGYANG_STYLE_ASSETS } from "../src/index.js"
const base=new URL('../templates/gwangyang/',import.meta.url)
const cases=JSON.parse(readFileSync(new URL('samples.json',base),'utf8'))
it("광양시 14종 카탈로그와 샘플 입력이 일치한다",()=>{
 assert.equal(GWANGYANG_STYLE_ASSETS.length,14)
 assert.equal(new Set(GWANGYANG_STYLE_ASSETS.map(a=>a.id)).size,14)
 assert.equal(GWANGYANG_STYLE_ASSETS.filter(a=>a.reportFrame==='gwangyang-1').length,11)
 const covered=new Set()
 for(const sample of cases){
  const md=readFileSync(new URL(sample.file,base),'utf8')
  const blocks=[...md.matchAll(/```gwangyang\s*\n([\s\S]*?)\n```/g)].map(m=>JSON.parse(m[1]))
  for(const id of sample.assets){
   const asset=GWANGYANG_STYLE_ASSETS.find(a=>a.id===id)!
   assert.ok(asset,id);assert.equal(sample.options.reportFrame,asset.reportFrame)
   const input:string=asset.input
   if(input==='# 제목') assert.match(md,/^# /m)
   else if(input==='## 소제목') assert.match(md,/^## /m)
   else if(input==='table') assert.match(md,/<table>|\|---/)
   else {const [type,variant]=input.split(':');assert.ok(blocks.some(b=>b.type===type && (!variant || (b.variant??(type==='rounded-box'?'plain':'white'))===variant)),id)}
   covered.add(id)
  }
 }
 assert.equal(covered.size,14)
})
