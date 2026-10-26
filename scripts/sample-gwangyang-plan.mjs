import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { markdownToHwpx } from '../dist/index.js'
const out=process.argv[2] ?? 'output/gwangyang-plan-test'
const stem=out+'/kordoc 광양시 서식 추가지원 추진계획'
await mkdir(out,{recursive:true})
const md=await readFile('templates/gwangyang/examples/05_추진계획_2쪽.md','utf8'),warnings=[]
await writeFile(stem+'.md',md)
const options={preset:'plan',agency:'광양시',reportFrame:'gwangyang-1',cover:false,toc:false,autoFit:{minRatio:90,safety:0.95},margins:{top:15,bottom:15,left:20,right:20}}
const bytes=await markdownToHwpx(md,{gongmun:options,warnings})
await writeFile(stem+'.hwpx',Buffer.from(bytes))
await writeFile(stem+'.options.json',JSON.stringify(options,null,2))
await writeFile(out+'/generation.json',JSON.stringify({engine:'local kordoc dist/index.js',options,warnings,postprocessing:false},null,2))
console.log(warnings)


