// 사용: vpos-scan.mts 코퍼스폴더… > out.tsv
// 문서마다 본문 최상위 문단의 첫 줄 vertpos 간격(앞 문단 대비)이 저장본과 처음 갈리는 곳 — 줄 수가 같은데 간격이 다르면 세로 규칙 문제
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
const REPO = fileURLToPath(new URL("../..", import.meta.url))
const at = (p: string) => pathToFileURL(REPO + p).href
const JSZip = (await import(at("node_modules/jszip/lib/index.js"))).default
const { DOMParser } = await import(at("src/xml/dom.ts"))
const { parseRenderStyles } = await import(at("src/render/head-styles.ts"))
const { reflowSection } = await import(at("src/render/reflow.ts"))
const n = (e: any, a: string, d = 0) => { const v = e?.getAttribute(a); return v == null ? d : Number(v) }
const rows: string[] = []
for (const dir of process.argv.slice(2)) for (const f of readdirSync(dir)) {
  if (!f.endsWith(".hwpx")) continue
  let zip; try { zip = await JSZip.loadAsync(readFileSync(join(dir, f))) } catch { continue }
  const hf = zip.file("Contents/header.xml"); if (!hf) continue
  let styles; try { styles = parseRenderStyles(await hf.async("string")) } catch { continue }
  for (const name of Object.keys(zip.files).filter(x => /^Contents\/section\d+\.xml$/.test(x)).sort()) {
    const xml = await zip.file(name).async("string")
    const A = new DOMParser().parseFromString(xml, "text/xml").documentElement
    const doc = new DOMParser().parseFromString(xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, ""), "text/xml"), root = doc.documentElement
    const pagePr = root.getElementsByTagName("hp:pagePr")[0]; if (!pagePr) continue
    const mg = pagePr.getElementsByTagName("hp:margin")[0]
    let PW = n(pagePr, "width", 59528), PH = n(pagePr, "height", 84188)
    if (pagePr.getAttribute("landscape") === "NARROWLY" && PW < PH) { const t = PW; PW = PH; PH = t }
    const tb = pagePr.getAttribute("gutterType") === "TOP_BOTTOM", gut = n(mg, "gutter")
    const BODY_W = PW - n(mg, "left", 8504) - n(mg, "right", 8504) - (tb ? 0 : gut), BODY_H = PH - n(mg, "top", 5668) - n(mg, "header") - n(mg, "bottom", 4252) - n(mg, "footer") - (tb ? gut : 0)
    try { reflowSection(root, styles, { BODY_W, BODY_H }, "keep") } catch { continue }
    const top = (r: any) => Array.from(r.childNodes).filter((c: any) => c.nodeName === "hp:p") as any[]
    const PA = top(A), PB = top(root)
    const own = (p: any) => Array.from(p.getElementsByTagName("hp:lineseg")).filter((s: any) => s.parentNode.parentNode === p) as any[]
    let prevOk = -1
    for (let i = 0; i < PA.length && i < PB.length; i++) {
      const a = own(PA[i]), b = own(PB[i])
      if (!a.length || !b.length) continue
      // 저장본은 새 쪽으로 넘어간 첫 줄 vertpos 를 앞 쪽 값에 이어 적기도 한다(실제는 새 쪽 위 — 둘째 줄부터 같다)
      const va0 = n(a[0], "vertpos"), va = va0 + n(a[0], "vertsize") > BODY_H && (a.length < 2 || n(a[1], "vertpos") < va0) ? 0 : va0, vb = n(b[0], "vertpos")
      if (va === vb) { prevOk = i; continue }
      // 원인 후보: 마지막으로 맞았던 문단 prevOk ~ i-1
      const c = prevOk >= 0 ? prevOk : 0
      const pa = own(PA[c]), pb = own(PB[c])
      const sameLines = pa.length === pb.length && pa.every((s: any, k: number) => s.getAttribute("textpos") === pb[k].getAttribute("textpos"))
      const between = []
      for (let j = c; j < i; j++) between.push(["hp:tbl", "hp:pic", "hp:rect", "hp:container", "hp:equation", "hp:line"].map(t => t.slice(3) + PA[j].getElementsByTagName(t).length).filter(x => !x.endsWith("0")).join(",") || "-")
      rows.push([sameLines ? "SAME" : "WRAP", f.slice(0, 40), name.slice(9, 17), c, i, `truth ${n(pa[0], "vertpos")}→${va} ours ${n(pb[0], "vertpos")}→${vb}`, `d ${va - vb}`, between.join("|"), JSON.stringify((PA[c].textContent ?? "").slice(0, 30))].join("	"))
      break
    }
  }
}
console.log(rows.join("\n"))
