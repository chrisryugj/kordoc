// bench 용 PDF 엔진 — kordoc 과 같은 경로를 부른다: 글 조각·연산자 목록은 hayro(src/pdf), 쪽 렌더는 kordoc OCR 과 같은 PDFium
import { tsImport } from "tsx/esm/api"

const load = p => tsImport(p, import.meta.url)
const [{ openHayro }, { hayroTextPage }, { hayroOps }, ops] = await Promise.all([
  load("../../src/pdf/hayro.ts"), load("../../src/pdf/hayro-text.ts"), load("../../src/pdf/hayro-ops.ts"), load("../../src/pdf/ops.ts"),
])
export const OPS = ops.OPS
let pdfium

/** PDF 를 연다(쪽 번호는 1부터). page() 는 쪽을 한 번 해석해 글 조각·연산자 목록을 함께 낸다 */
export async function openPdf(raw) {
  const doc = await openHayro(new Uint8Array(raw))
  let fdoc
  const render = async (pn, scale, colorSpace) => {
    pdfium ??= await (await import("@hyzyla/pdfium")).PDFiumLibrary.init()
    fdoc ??= await pdfium.loadDocument(new Uint8Array(raw))
    return fdoc.getPage(pn - 1).render({ scale, colorSpace, render: async ({ data }) => data })
  }
  return {
    numPages: doc.pageCount(),
    /** { items: pdf.js 모양 글 조각, fnArray, argsArray, view: [x0,y0,x1,y1] } */
    page(pn) {
      const p = hayroTextPage(doc, pn)
      return { items: p.items, ...hayroOps(p.events, p.strings), view: doc.pageView(pn - 1) }
    },
    /** RGBA 렌더 { data, width, height } — PDFium 은 BGRA 로 준다 */
    async render(pn, scale) {
      const r = await render(pn, scale, "BGRA")
      const data = new Uint8Array(r.data.length)
      for (let i = 0; i < data.length; i += 4) { data[i] = r.data[i + 2]; data[i + 1] = r.data[i + 1]; data[i + 2] = r.data[i]; data[i + 3] = 255 }
      return { data, width: r.width, height: r.height }
    },
    /** 회색 렌더 { data, width, height } */
    renderGray: (pn, scale) => render(pn, scale, "Gray"),
    close: () => { doc.close(); fdoc?.destroy() },
  }
}
