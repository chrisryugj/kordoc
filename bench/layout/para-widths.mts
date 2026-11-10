// 문단 하나의 글자별 폭 합 — 사용: para-widths.mts file.hwpx "문단 글 앞부분" [section]
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
const REPO = fileURLToPath(new URL("../..", import.meta.url))
const at = (p: string) => pathToFileURL(REPO + p).href
const JSZip = (await import(at("node_modules/jszip/lib/index.js"))).default
const { DOMParser } = await import(at("src/xml/dom.ts"))
const { parseRenderStyles } = await import(at("src/render/head-styles.ts"))
const { buildPara } = await import(at("src/render/para-model.ts"))
const { glyphWidth } = await import(at("src/render/reflow.ts"))
const zip = await JSZip.loadAsync(readFileSync(process.argv[2]))
const styles = parseRenderStyles(await zip.file("Contents/header.xml").async("string"))
const doc = new DOMParser().parseFromString(await zip.file(`Contents/section${process.argv[4] ?? 0}.xml`).async("string"), "text/xml")
for (const p of Array.from(doc.getElementsByTagName("hp:p")) as any[]) {
  if (!(p.textContent ?? "").includes(process.argv[3])) continue
  const own = Array.from(p.childNodes).some((c: any) => c.nodeName === "hp:run" && Array.from(c.childNodes).some((t: any) => t.nodeName === "hp:t" && (t.textContent ?? "").includes(process.argv[3])))
  if (!own) continue
  const pm = buildPara(p)
  const segs = Array.from(p.getElementsByTagName("hp:lineseg")).filter((s: any) => s.parentNode.parentNode === p).map((s: any) => [Number(s.getAttribute("textpos")), Number(s.getAttribute("horzsize"))])
  let x = 0; const out: string[] = []
  const st0 = styles.charPr.get(pm.chars[8]?.prId ?? "")
  console.log("segs", JSON.stringify(segs), "face", st0?.face, st0?.latin?.face, "h", st0?.height, "ratio", st0?.ratio, "sp", st0?.spacing, "para", p.getAttribute("paraPrIDRef"), JSON.stringify(styles.paraGeom.get(p.getAttribute("paraPrIDRef"))).slice(0, 300))
  pm.chars.forEach((c: any, i: number) => {
    const st = styles.charPr.get(c.prId ?? "")
    const w = c.ch ? glyphWidth(c.ch, st).w : 0
    x += w
    if (process.env.ALL || i < 10 || segs.some((s: number[]) => Math.abs(s[0] - i) <= 2) || c.ctrlText) out.push(`${i}:${JSON.stringify(c.ch || c.ctrlText || "")}=${w} Σ${x}`)
  })
  console.log(out.join("  "))
  break
}
