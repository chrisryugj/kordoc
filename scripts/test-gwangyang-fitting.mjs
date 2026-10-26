import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { resolve,dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { markdownToHwpx,parse } from '../dist/index.js'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,'output/gwangyang-fitting')
await mkdir(out,{recursive:true})
const cases=JSON.parse(await readFile(resolve(root,'templates/gwangyang/samples.json'),'utf8'))
const sentence='관련 부서의 의견을 수렴하고 문서 작성 과정에서 확인된 개선사항을 반영하여 기관별 공통서식의 적용 범위와 세부 운영방안을 검토합니다.'
const results=[],shapes=new Map(),coverage=new Set()
for(const [index,c] of cases.entries()){
 let md=await readFile(resolve(root,'templates/gwangyang',c.file),'utf8')
 md=md.replace(/^# .+$/m,'# 부서별 행정문서 작성 체계 개선 및 공통서식 적용을 위한 세부 운영방안 검토보고')
 md=md.replace(/^## .+$/gm,'## 기관별 공통서식 적용 범위와 부서별 세부 검토사항 및 후속 추진계획')
 md=md.replace(/```gwangyang\s*\n([\s\S]*?)\n```/g,(_,json)=>{
  const b=JSON.parse(json)
  if(b.type==='staff-header') b.staff=[{role:'행정문서표준화지원부서장',name:'홍길동담당',phone:'0000'},{role:'기관서식운영지원팀장',name:'김담당',phone:'0001'}]
  else if(b.type==='institution-cover') {
   b.title='부서별 행정문서 공통서식 적용을 위한 추진계획 및 운영방안 검토'
   b.subtitle='민선9기 시정 비전과 기관별 문서 작성 체계를 반영한 공통서식 활용'
   b.documentNumber='행정문서표준화지원부서-12345';b.dept='행정문서표준화지원부서';b.approvers=['담당주무관','운영지원팀장','행정지원과장','담당국장','부시장'];b.body=[sentence,sentence,sentence]
  } else if(b.type==='box') {b.title='관련 부서 협의 결과 및 문서 작성 과정의 주요 검토사항';b.body=Array.from({length:4},(_,i)=>`◦ 검토사항 ${i+1}: **${sentence}**`)}
  else if(b.type==='rounded-box') {b.title='관련 부서 협의 결과 및 후속 검토사항';b.body=[sentence,sentence]}
  else if(b.type==='attachment') {b.label='붙임 123';b.title='기관별 보고서 공통서식 적용을 위한 세부 검토자료 및 항목별 산출내역'}
  else if(b.type==='table-title') b.title='부서별 공통서식 적용 범위 및 항목별 작성 기준과 후속 검토사항 비교표'
  return '```gwangyang\n'+JSON.stringify(b,null,2)+'\n```'
 })
 if(index===0) md=md.replace(/입력한 내용 \d+/g,sentence)
 if(index===3) md=md.replace('서식 비교 및 의견 수렴',sentence).replace('희망 부서 시범 사용',sentence)
 for(const enabled of [true,false]){
  const name=`${index+1}_${enabled?'피팅ON':'피팅OFF'}`,warnings=[]
  const options={...c.options,autoFit:enabled?{minRatio:90,safety:0.95}:false}
  const bytes=await markdownToHwpx(md,{gongmun:options,warnings})
  const parsed=await parse(bytes);assert.ok(parsed.markdown.includes('운영방안'))
  const zip=await JSZip.loadAsync(bytes),header=await zip.file('Contents/header.xml').async('string')
  await writeFile(resolve(out,name+'.hwpx'),Buffer.from(bytes));await writeFile(resolve(out,name+'.md'),md)
  await writeFile(resolve(out,name+'.options.json'),JSON.stringify(options,null,2))
  const compressed=(header.match(/<hh:spacing[^>]*hangul="-\d+"/g)??[]).length
  const borders=[...header.matchAll(/<hh:borderFill [\s\S]*?<\/hh:borderFill>/g)].map(m=>m[0].replace(/ id="\d+"/,'')).sort()
  const imageHashes=[]
  for(const entry of zip.file(/^BinData\//)) imageHashes.push(createHash('sha256').update(await entry.async('nodebuffer')).digest('hex'))
  const shape={borders:[...new Set(borders)],images:imageHashes.sort()}
  if(enabled) shapes.set(index,shape);else assert.deepEqual(shape,shapes.get(index),'ON/OFF에서 선·채움·로고 자산 보존')
  for(const id of c.assets) coverage.add(id)
  if(!enabled) assert.equal(compressed,0,'autoFit false일 때 새 부품 압축 없음')
  results.push({name,case:c.name,assets:c.assets,autoFit:options.autoFit,compressedStyles:compressed,warnings})
 }
}
assert.equal(coverage.size,14,'14종 긴 문안 테스트')
await writeFile(resolve(out,'fitting-results.json'),JSON.stringify(results,null,2))
console.log(JSON.stringify(results.map(({name,compressedStyles,warnings})=>({name,compressedStyles,warnings})),null,2))
