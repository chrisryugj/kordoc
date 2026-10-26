// Usage: node --import tsx scripts/compare-agency-regression.mjs BASE_CHECKOUT OUTPUT_DIR [--quick]
// BASE_CHECKOUT must contain the unmodified main source and resolve its dependencies.
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {mkdir,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {mock} from 'node:test'
// Freeze ZIP timestamps equally in both engines; compare unmodified output bytes.
mock.timers.enable({apis:['Date'],now:new Date('2026-01-01T00:00:00Z')})
import * as candidate from '../src/index.ts'
if(!process.argv[2] || !process.argv[3]) throw new Error('Usage: compare-agency-regression.mjs BASE_CHECKOUT OUTPUT_DIR [--quick]')
const basePath=resolve(process.argv[2]),out=resolve(process.argv[3]),quick=process.argv.includes('--quick')
const baseline=await import(pathToFileURL(resolve(basePath,'src/index.ts')).href)
const hash=b=>createHash('sha256').update(b).digest('hex')
const fixtures=[
 '# 기관 서식 비교\n\n> 업무 추진방향과 검토 사항을 공유하고자 함\n\n## 추진 내용\n\n□ 추진목적\n\nㅇ (지원대상) 문서 작성 담당자\n\n- 세부 검토사항\n\nㆍ 보완 사항\n\n※ 참고사항\n\n| 구분 | 내용 |\n|---|---|\n| 대상 | 희망 부서 |\n| 일정 | 협의 후 확정 |',
 '# 긴 문안 및 병합표 비교\n\n## 추진 배경\n\n□ '+ '기관별 작성 기준과 검토 내용을 확인한다. '.repeat(12)+'\n\nㅇ **(검토내용)** '+ '여러 줄에서 들여쓰기와 줄바꿈을 비교한다. '.repeat(12)+'\n\n- 하위 단계 점검\n\n<table><tr><th>구분</th><th>내용</th></tr><tr><td rowspan="2">공통</td><td>첫째 항목</td></tr><tr><td>둘째 항목</td></tr></table>\n\n### 후속 조치\n\n1. 단계별 검토\n\n가. 확인 결과\n\n※ 별도 참고 · 가운뎃점 유지',
]
const profiles=[{}, {bodyPt:14}, {bodyPt:15,fonts:{body:'함초롬바탕'},levels:[{pt:18},{pt:16},{pt:13}]}]
const names=baseline.agencyNames();if(names.length!==52)throw Error('Expected 52 baseline agencies; got '+names.length)
const cases=[]
for(const agency of quick?names:[...names,'공통'])for(const preset of quick?['report','plan','press']:['report','plan','press','ministry','gaejosik'])for(let f=0;f<(quick?1:fixtures.length);f++)for(let p=0;p<(quick?1:profiles.length);p++)cases.push({agency,preset,f,p})
if(!quick)for(const preset of ['official','report','plan','notice','minutes','gaejosik','ministry','bangchim','press'])for(let f=0;f<fixtures.length;f++)for(let p=0;p<profiles.length;p++)cases.push({preset,f,p})
await mkdir(out,{recursive:true});const rows=[]
for(const c of cases){
 const opts={preset:c.preset,...(c.agency?{agency:c.agency}:{}),...profiles[c.p],cover:false,toc:false}
 const bw=[],cw=[]
 const a=Buffer.from(await baseline.markdownToHwpx(fixtures[c.f],{gongmun:opts,warnings:bw}))
 const b=Buffer.from(await candidate.markdownToHwpx(fixtures[c.f],{gongmun:opts,warnings:cw}))
 const equal=a.equals(b),warningsEqual=JSON.stringify(bw)===JSON.stringify(cw)
 const row={...c,equal,warningsEqual,baseline:hash(a),candidate:hash(b)};rows.push(row)
 if(!equal){await writeFile(resolve(out,rows.length+'-baseline.hwpx'),a);await writeFile(resolve(out,rows.length+'-candidate.hwpx'),b)}
}
const summary={cases:rows.length,identical:rows.filter(r=>r.equal).length,different:rows.filter(r=>!r.equal).length,warningDifferences:rows.filter(r=>!r.warningsEqual).length}
await writeFile(resolve(out,'comparison.json'),JSON.stringify({summary,rows},null,2));console.log(summary)
if(summary.different||summary.warningDifferences)process.exitCode=1
