import { z } from 'zod'

const text=z.string().trim().min(1)
const id=z.string().regex(/^[a-z][a-z0-9-]*$/)
const padding=z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative()}).strict()
// 등록 자료의 계약이다. 생성 엔진의 실행 옵션 스키마와 구분한다.
export const agencyStyleSchema=z.object({
  schemaVersion:z.literal(1), id, name:text, version:z.string().regex(/^\d+\.\d+\.\d+$/),
  status:z.enum(['draft','local-tested','released']), officialStandard:z.boolean(),
  presets:z.array(z.enum(['report','plan','official','notice','minutes','gaejosik','press','ministry','bangchim'])).min(1),
  defaultVariant:id,
  variants:z.array(z.object({id,label:text,evidence:z.enum(['hwpx-user-confirmed','pdf-approximation','designed'])}).strict()).min(1),
  sources:z.array(z.object({id,kind:z.enum(['user-original','public-document','agent-created']),reference:text,use:text,redistribution:z.enum(['not-reviewed','permitted','excluded'])}).strict()).min(1),
  writingGuide:text, sampleIndex:text,
  tokens:z.object({bodyFont:text,bodyPt:z.number().positive(),middleDot:z.enum(['·','‧']),summaryCaption:z.boolean(),summaryPaddingHU:padding,tablePaddingHU:padding}).strict(),
  fitting:z.object({engine:z.literal('kordoc-existing'),minRatio:z.number().min(1).max(100),safety:z.number().positive().max(1),overflow:z.literal('grow-or-split-or-error'),targetPagesGuaranteed:z.literal(false)}).strict(),
  assets:z.array(z.object({id,name:text,variant:id,input:text}).strict()).min(1),
  validation:z.object({automated:z.array(text).min(1),visual:z.array(text).min(1),evidenceDocs:z.array(text).min(1)}).strict(),
  runtime:z.object({kind:z.literal('compiled-adapter'),codeRefs:z.array(text).min(1),manifestLoadsRenderer:z.literal(false)}).strict(),
}).strict().superRefine((v,ctx)=>{
  const fail=message=>ctx.addIssue({code:z.ZodIssueCode.custom,message})
  for(const [name,values] of [['variant',v.variants.map(x=>x.id)],['asset',v.assets.map(x=>x.id)],['source',v.sources.map(x=>x.id)],['preset',v.presets]])
    if(new Set(values).size!==values.length) fail(`${name}: 중복 ID`)
  const variants=new Set(v.variants.map(x=>x.id))
  if(!variants.has(v.defaultVariant)) fail('defaultVariant: 등록되지 않은 변형')
  for(const a of v.assets) if(!variants.has(a.variant)) fail(`${a.id}: 등록되지 않은 변형`)
})
