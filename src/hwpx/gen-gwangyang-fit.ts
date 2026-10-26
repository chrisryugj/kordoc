import type { FrameCtx } from "./gen-frame-seoul.js"
import { fitOneLine, fitParagraph, fitCharBreaks } from "./fit-line.js"
import { parseInlineMarkdown } from "./md-runs.js"
import { simulateWrap, faceClassForGen } from "./text-metrics.js"

/** 기존 공문서 피팅 정책을 기관 부품에도 전달한다. 글자 크기·색·선·폭은 변경하지 않는다. */
export function fitGwangyangText(text:string,font:string,pt:number,width:number,ctx:FrameCtx,oneLine=false) {
  const plain=parseInlineMarkdown(text).map(s=>s.text).join("")
  const min=ctx.fit?.minRatio === undefined ? 90 : ctx.fit.minRatio
  const safety=ctx.fit?.safety
  const cb=oneLine ? null : fitCharBreaks(plain,font,pt,width,width,min??101,safety)
  const fit=oneLine
    ? (min === null ? null : fitOneLine(plain,font,pt,width,pt,min,safety))
    : cb ?? (min === null ? null : fitParagraph(plain,font,pt,width,width,min,undefined,safety))
  const ratio=fit?.ratio??100,spacing=fit?.spacing??0
  const lines=simulateWrap(plain,width*Math.min(0.98,safety??0.98),width*Math.min(0.98,safety??0.98),pt*100,ratio,cb?"charAll":"keep",{faceClass:faceClassForGen(font),spacingPct:spacing}).lines
  return {pt,ratio,spacing,lines,keepWord:!cb,overflow:lines>1}
}
