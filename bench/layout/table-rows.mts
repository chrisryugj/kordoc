// 최상위 문단 i 의 표: 저장본 lineseg 로 잰 행 높이 vs reflow 뒤 행 높이 — 사용: table-rows.mts file.hwpx sectionN i
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
const REPO = fileURLToPath(new URL("../..", import.meta.url))
const at = (p: string) => pathToFileURL(REPO + p).href
const JSZip = (await import(at("node_modules/jszip/lib/index.js"))).default
const { DOMParser } = await import(at("src/xml/dom.ts"))
const { parseRenderStyles } = await import(at("src/render/head-styles.ts"))
const { reflowSection } = await import(at("src/render/reflow.ts"))
const { measureTableRowHeights } = await import(at("src/render/para-model.ts"))
const zip = await JSZip.loadAsync(readFileSync(process.argv[2]))
const styles = parseRenderStyles(await zip.file("Contents/header.xml").async("string"))
const xml = await zip.file(`Contents/${process.argv[3]}.xml`).async("string")
const A = new DOMParser().parseFromString(xml, "text/xml").documentElement
const root = new DOMParser().parseFromString(xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, ""), "text/xml").documentElement
const n = (e: any, a: string, d = 0) => { const v = e?.getAttribute(a); return v == null ? d : Number(v) }
const pagePr = root.getElementsByTagName("hp:pagePr")[0], mg = pagePr.getElementsByTagName("hp:margin")[0]
const tb = pagePr.getAttribute("gutterType") === "TOP_BOTTOM", gut = n(mg, "gutter")
reflowSection(root, styles, { BODY_W: n(pagePr, "width") - n(mg, "left") - n(mg, "right") - (tb ? 0 : gut), BODY_H: n(pagePr, "height") - n(mg, "top") - n(mg, "bottom") - n(mg, "header") - n(mg, "footer") - (tb ? gut : 0) }, "keep")
const top = (r: any) => Array.from(r.childNodes).filter((c: any) => c.nodeName === "hp:p") as any[]
const i = Number(process.argv[4]), ta = top(A)[i].getElementsByTagName("hp:tbl")[0], tbb = top(root)[i].getElementsByTagName("hp:tbl")[0]
const ra = measureTableRowHeights(ta), rb = measureTableRowHeights(tbb)
console.log("rows truth", JSON.stringify(ra), "sum", ra.reduce((x: number, y: number) => x + y, 0))
console.log("rows ours ", JSON.stringify(rb), "sum", rb.reduce((x: number, y: number) => x + y, 0))
// 다른 행의 칸 문단: 저장본 vs reflow 줄 시작
const cellsA = Array.from(ta.getElementsByTagName("hp:tc")) as any[], cellsB = Array.from(tbb.getElementsByTagName("hp:tc")) as any[]
cellsA.forEach((c: any, k: number) => {
  const row = n(c.getElementsByTagName("hp:cellAddr")[0], "rowAddr")
  const pa = Array.from(c.getElementsByTagName("hp:p")) as any[], pb = Array.from(cellsB[k].getElementsByTagName("hp:p")) as any[]
  pa.forEach((p: any, j: number) => {
    const sa = Array.from(p.getElementsByTagName("hp:lineseg")).map((s: any) => `${s.getAttribute("textpos")}@${s.getAttribute("vertpos")}/${s.getAttribute("vertsize")}`)
    const sb = Array.from(pb[j].getElementsByTagName("hp:lineseg")).map((s: any) => `${s.getAttribute("textpos")}@${s.getAttribute("vertpos")}/${s.getAttribute("vertsize")}`)
    if (sa.join() !== sb.join()) console.log("row", row, "cell", k, "p", j, "truth", sa.join(" "), "ours", sb.join(" "), JSON.stringify((p.textContent ?? "").slice(0, 30)))
  })
})
