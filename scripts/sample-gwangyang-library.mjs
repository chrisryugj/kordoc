/** 빌드된 로컬 API로 14종을 작성·재파싱한다. npm run sample:gwangyang */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { markdownToHwpx, parse, GWANGYANG_STYLE_ASSETS } from '../dist/index.js'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const templates=resolve(root,'templates/gwangyang')
const out=resolve(process.argv[2]??resolve(root,'output/gwangyang'))
await mkdir(out,{recursive:true})
const cases=JSON.parse(await readFile(resolve(templates,'samples.json'),'utf8'))
const coverage=new Set(),results=[]
for(const sample of cases){
 const md=await readFile(resolve(templates,sample.file),'utf8'),warnings=[]
 const bytes=await markdownToHwpx(md,{gongmun:sample.options,warnings})
 const zip=await JSZip.loadAsync(bytes),section=await zip.file('Contents/section0.xml').async('string')
 assert.ok(section.includes('<hp:tbl '),'실제 표 생성')
 if(sample.assets.includes('gy1-rounded-tab')) assert.match(section,/<hp:rect[^>]+ratio="20"/)
 if(sample.assets.includes('gy1-cover')) assert.match(section,/pageBreak="1"/)
 const parsed=await parse(bytes)
 const title=md.match(/^# (.+)$/m)?.[1]
 assert.ok(title && parsed.markdown.includes(title),'작성 제목 재파싱')
 assert.equal(warnings.length,0,`${sample.name}: ${warnings.join('; ')}`)
 await writeFile(resolve(out,sample.name+'.hwpx'),Buffer.from(bytes))
 await writeFile(resolve(out,sample.name+'.md'),md)
 await writeFile(resolve(out,sample.name+'.options.json'),JSON.stringify(sample.options,null,2))
 await writeFile(resolve(out,sample.name+'.roundtrip.md'),parsed.markdown)
 for(const id of sample.assets){assert.ok(GWANGYANG_STYLE_ASSETS.some(a=>a.id===id));coverage.add(id)}
 results.push({name:sample.name,assets:sample.assets,warnings,roundtrip:'passed'})
}
assert.equal(coverage.size,GWANGYANG_STYLE_ASSETS.length,'모든 에셋을 샘플에서 사용')
const result={agency:'광양시',assetCount:GWANGYANG_STYLE_ASSETS.length,covered:coverage.size,samples:results}
await writeFile(resolve(out,'작성테스트.json'),JSON.stringify(result,null,2))
await writeFile(resolve(out,'에셋목록.json'),JSON.stringify(GWANGYANG_STYLE_ASSETS,null,2))
console.log(JSON.stringify({output:out,assets:coverage.size,samples:results.length,result:'PASS'},null,2))
