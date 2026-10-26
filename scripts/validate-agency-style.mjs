import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { agencyStyleSchema } from '../templates/agency-style/schema.mjs'

const file=path.resolve(process.argv[2] ?? 'templates/gwangyang/style.json')
const base=path.dirname(file), root=path.resolve(import.meta.dirname,'..')
async function existing(ref) {
  const resolved=path.resolve(base,ref),relative=path.relative(root,resolved)
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) throw new Error(`저장소 외부 참조: ${ref}`)
  await access(resolved)
  return resolved
}
const manifest=agencyStyleSchema.parse(JSON.parse(await readFile(file,'utf8')))
for(const ref of [manifest.writingGuide,...manifest.runtime.codeRefs,...manifest.validation.evidenceDocs]) await existing(ref)
const samples=JSON.parse(await readFile(await existing(manifest.sampleIndex),'utf8'))
if(!Array.isArray(samples)||!samples.length) throw new Error('샘플 목록이 필요합니다')
const assets=new Map(manifest.assets.map(a=>[a.id,a])),covered=new Set()
for(const sample of samples){
  await existing(sample.file)
  if(sample.options?.agency!==manifest.name || !manifest.presets.includes(sample.options?.preset)) throw new Error(`${sample.name}: 기관 또는 프리셋 불일치`)
  for(const id of sample.assets){
    if(!assets.has(id)||assets.get(id).variant!==sample.options.reportFrame) throw new Error(`${sample.name}: 에셋/변형 불일치 ${id}`)
    covered.add(id)
  }
}
for(const id of assets.keys()) if(!covered.has(id)) throw new Error(`샘플 누락: ${id}`)
console.log(`${manifest.name}: 등록 규격·파일 참조·${covered.size}종 샘플 연결 확인 (렌더 검증은 별도)`)
