// bench 용 PDF 엔진 — kordoc 의 hayro 경로(src/pdf)를 그대로 부른다: 글 조각·연산자 목록·쪽 렌더.
// OCR 채점이 재는 래스터는 kordoc OCR 이 보는 래스터와 같아야 하므로 따로 엔진을 두지 않는다
import { tsImport } from "tsx/esm/api"

const load = p => tsImport(p, import.meta.url)
const [{ openHayro }, { hayroTextPage }, { hayroOps }, ops] = await Promise.all([
  load("../../src/pdf/hayro.ts"), load("../../src/pdf/hayro-text.ts"), load("../../src/pdf/hayro-ops.ts"), load("../../src/pdf/ops.ts"),
])
export const OPS = ops.OPS

/** PDF 를 연다(쪽 번호는 1부터). page() 는 쪽을 한 번 해석해 글 조각·연산자 목록을 함께 낸다 */
export async function openPdf(raw) {
  const doc = await openHayro(new Uint8Array(raw))
  return {
    numPages: doc.pageCount(),
    /** { items: pdf.js 모양 글 조각, fnArray, argsArray, view: [x0,y0,x1,y1] } */
    page(pn) {
      const p = hayroTextPage(doc, pn)
      return { items: p.items, ...hayroOps(p.events, p.strings), view: doc.pageView(pn - 1) }
    },
    /** 흰 바탕 RGBA 렌더 { data, width, height } */
    render: (pn, scale) => doc.render(pn - 1, scale),
    close: () => doc.close(),
  }
}

/** RGBA → 회색(휘도, Rec.601) */
export function toGray({ data, width, height }) {
  const g = new Uint8Array(width * height)
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114 + 500) / 1000
  return { data: g, width, height }
}
