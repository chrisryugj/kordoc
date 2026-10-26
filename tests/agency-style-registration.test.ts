import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { GWANGYANG_STYLE_ASSETS, markdownToHwpx } from '../src/index.js'
import JSZip from 'jszip'
// @ts-ignore — 등록 검사는 Node에서 직접 실행하는 ESM 스키마를 공유한다.
import { agencyStyleSchema } from '../templates/agency-style/schema.mjs'

const manifest=JSON.parse(readFileSync(new URL('../templates/gwangyang/style.json',import.meta.url),'utf8'))
it('광양시 등록 자료가 실제 14종 카탈로그 및 샘플과 연결된다',()=>{
  assert.deepEqual(manifest.assets,GWANGYANG_STYLE_ASSETS.map(a=>({id:a.id,name:a.name,variant:a.reportFrame,input:a.input})))
  assert.match(execFileSync(process.execPath,['scripts/validate-agency-style.mjs'],{encoding:'utf8'}),/14종/)
})
it('다른 기관의 중복 ID·미등록 변형·지원하지 않는 등록 필드를 거부한다',()=>{
  for(const mutate of [
    (v:any)=>v.assets.push({...v.assets[0]}),
    (v:any)=>v.defaultVariant='missing',
    (v:any)=>v.assets[0].variant='missing',
    (v:any)=>v.fitting.targetPagesGuaranteed=true,
    (v:any)=>v.runtime.manifestLoadsRenderer=true,
    (v:any)=>v.unknown=true,
  ]) {
    const value=structuredClone(manifest);mutate(value)
    assert.equal(agencyStyleSchema.safeParse(value).success,false)
  }
})
it('작성 지침의 괄호 항목 예시를 기존 생성 경로로 작성할 수 있다',async()=>{
  const guide=readFileSync(new URL('../templates/gwangyang/writing-guide.md',import.meta.url),'utf8')
  const md=guide.match(/```markdown\r?\n([\s\S]*?)\r?\n```/)![1]
  const bytes=await markdownToHwpx('# 기관 스타일 작성 시험\n\n> 부서별 서식 활용을 지원하고자 함\n\n'+md,{gongmun:{preset:'plan',agency:'광양시',cover:false,toc:false}})
  const zip=await JSZip.loadAsync(bytes),xml=await zip.file('Contents/section0.xml')!.async('string')
  for(const label of ['(지원대상)','(지원범위)','(적용방법)']) assert.ok(xml.includes(label))
  assert.ok(xml.includes('name="__kordoc_summary"'))
  assert.ok(!xml.includes('·'))
})
