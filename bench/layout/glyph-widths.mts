// 문서의 모든 문단 글자 폭(우리 glyphWidth) — 사용: glyph-widths.mts in.hwpx out.json
import { readFileSync, writeFileSync } from "node:fs"
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
const out: any[] = []
for (const name of Object.keys(zip.files).filter(n => /^Contents\/section\d+\.xml$/.test(n)).sort()) {
  const doc = new DOMParser().parseFromString(await zip.file(name).async("string"), "text/xml")
  for (const p of Array.from(doc.getElementsByTagName("hp:p")) as any[]) {
    const pm = buildPara(p)
    let t = ""; const w: number[] = []; const f: string[] = []
    for (const c of pm.chars) {
      if (!c.ch) continue
      const st = styles.charPr.get(c.prId ?? "")
      if (!st) continue
      const cp = c.ch.codePointAt(0)!
      const L = st.latin && (cp < 0x250 || (cp >= 0x2018 && cp < 0x2020))
      t += c.ch; w.push(glyphWidth(c.ch, st).w); f.push(`${L ? st.latin.face : st.face}|${st.height}|${L ? st.latin.ratio : st.ratio}|${L ? st.latin.spacing : st.spacing}${st.bold ? "|b" : ""}`)
    }
    if (t.trim().length >= 6) out.push({ t, w, f })
  }
}
writeFileSync(process.argv[3], JSON.stringify(out))
console.log(out.length)
