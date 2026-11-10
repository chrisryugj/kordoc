// reflow 전 경로 대조 — lineseg 를 지우고 reflowSection 으로 다시 조판해 문단별 줄 시작(textpos)을 한컴 저장본과 비교
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
const REPO = fileURLToPath(new URL("../..", import.meta.url))
const at = (p: string) => pathToFileURL(REPO + p).href
const JSZip = (await import(at("node_modules/jszip/lib/index.js"))).default
const { DOMParser } = await import(at("src/xml/dom.ts"))
const { parseRenderStyles, hwpxAppMajor, hwpxAppBuild } = await import(at("src/render/head-styles.ts"))
const { reflowSection, hancomLangOf } = await import(at("src/render/reflow.ts"))
const { buildPara } = await import(at("src/render/para-model.ts"))
const blame: Record<string, [number, number, number]> = {}
const MODE = (process.env.MODE ?? "keep") as "keep" | "charAll"
const num = (el: Element | null, a: string, d: number) => { const v = el?.getAttribute(a); return v == null ? d : Number(v) }
const st = { multi: 0, multiOk: 0, all: 0, linesOk: 0 }
const byDir: Record<string, number[]> = {}
const byKind: Record<string, number[]> = {}
let dumped = 0
const objCat: Record<string, number[]> = {}
const byFace: Record<string, number[]> = {}
const horzStat: Record<string, number[]> = {}
const horzDiff: Record<string, number> = {}
let hdumped = 0
const hangRows: string[] = []
const fvRows: Array<{ f: string; d: number; idx: number; n: number; va: string; t: string }> = [] // FVDUMP=cell — 첫 줄 vertpos 다른 문단
const paraRows: string[] = [] // PARADUMP=out.tsv — 두 줄+ 문단마다 파일·순번·일치·정답·우리 줄 시작·글
let paraIdx = 0
let hangIdx = 0
const numstat = [0, 0]
const vfirst: Record<string, number> = {}
let vfdumped = 0
const vstat: Record<string, number[]> = {}
const vfield: Record<string, number> = {}
const tblh: Record<string, number> = {}
let tblhd = 0
const tb: Record<string, number> = {}
let tbd = 0
let vdumped = 0
const faceDoc: Record<string, number[]> = {}
let fdumped = 0
let catd = 0
const perFileOk: Record<string, number[]> = {}
const perFileLines: Record<string, number[]> = {}
const hfile: Record<string, number> = {}
const noSegWhere: Record<string, number> = {}
const catOf = (p: Element, g: number[]) => {
  if (g.length === 0) return "no-lineseg"
  const direct = Array.from(p.getElementsByTagName("hp:pos") as unknown as Element[]).filter(e => { let a: any = e.parentNode; let d = 0; while (a && a !== p) { if (a.nodeName === "hp:tc" || a.nodeName === "hp:subList") return false; a = a.parentNode; d++ } return true })
  const wraps = direct.map(e => (e.parentNode as Element).getAttribute("textWrap") + ":" + e.getAttribute("treatAsChar"))
  if (wraps.some(w => /^(SQUARE|TIGHT|THROUGH):0/.test(w))) return "float-wrap"
  if (wraps.some(w => /:0$/.test(w))) return "float-other"
  return "inline-only"
}
const kindOf = (p: Element) => {
  let a: any = p.parentNode, inCell = false
  while (a) { if (a.nodeName === "hp:tc") { inCell = true; break } a = a.parentNode }
  const hasTab = p.getElementsByTagName("hp:tab").length > 0
  const hasObj = ["hp:tbl", "hp:pic", "hp:rect", "hp:equation", "hp:container", "hp:line"].some(t => p.getElementsByTagName(t).length > 0)
  return (inCell ? "cell" : "body") + (hasTab ? "+tab" : "") + (hasObj ? "+obj" : "")
}
for (const dir of process.argv.slice(2)) for (const f of readdirSync(dir)) {
  if (!f.endsWith(".hwpx")) continue
  paraIdx = 0
  let zip; try { zip = await JSZip.loadAsync(readFileSync(join(dir, f))) } catch { continue }
  const hf = zip.file("Contents/header.xml"); if (!hf) continue
  const vf = zip.file("version.xml")
  let styles; try { styles = parseRenderStyles(await hf.async("string"), { appMajor: hwpxAppMajor(vf ? await vf.async("string") : null), appBuild: hwpxAppBuild(vf ? await vf.async("string") : null) }) } catch { continue }
  for (const name of Object.keys(zip.files).filter(n => /^Contents\/section\d+\.xml$/.test(n))) {
    let doc; try { doc = new DOMParser().parseFromString(await zip.file(name)!.async("string"), "text/xml") } catch { continue }
    const root = doc.documentElement as unknown as Element
    const pagePr = root.getElementsByTagName("hp:pagePr")[0] as unknown as Element | undefined
    if (!pagePr) continue
    const margin = pagePr.getElementsByTagName("hp:margin")[0] as unknown as Element
    let PW = num(pagePr, "width", 59528), PH = num(pagePr, "height", 84188)
    if (pagePr.getAttribute("landscape") === "NARROWLY" && PW < PH) { const t = PW; PW = PH; PH = t }
    // 제본 여백(gutter)은 렌더(svg-render pageGeom)처럼 왼쪽(LEFT_ONLY·LEFT_RIGHT) 또는 위(TOP_BOTTOM)에서 본문을 줄인다
    const gutterTB = pagePr.getAttribute("gutterType") === "TOP_BOTTOM", gutter = num(margin, "gutter", 0)
    const BODY_W = PW - num(margin, "left", 8504) - num(margin, "right", 8504) - (gutterTB ? 0 : gutter)
    const noFoot = root.getElementsByTagName("hp:footer").length === 0, noHead = root.getElementsByTagName("hp:header").length === 0
    const BODY_H = PH - num(margin, "top", 5668) - num(margin, "header", 0) - num(margin, "bottom", 4252) - num(margin, "footer", 0) - (gutterTB ? gutter : 0) + (process.env.FOOTX && noFoot && (process.env.FOOTX !== "2" || noHead) ? num(margin, "footer", 0) : 0)
    const ps = Array.from(root.getElementsByTagName("hp:p") as unknown as Element[])
    const truth = new Map<Element, number[]>()
    const tHorz = new Map<Element, number>()
    const tSeg = new Map<Element, number[][]>()
    for (const p of ps) {
      const lsa = Array.from(p.childNodes as unknown as Element[]).find(c => c.nodeName === "hp:linesegarray")
      if (!lsa) continue
      truth.set(p, Array.from(lsa.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => Number(s.getAttribute("textpos"))))
      tHorz.set(p, Number((lsa.getElementsByTagName("hp:lineseg")[0] as unknown as Element)?.getAttribute("horzsize")))
      tSeg.set(p, Array.from(lsa.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => ["vertpos", "vertsize", "textheight", "baseline", "spacing"].map(a => Number(s.getAttribute(a)))))
      p.removeChild(lsa)
    }
    if (truth.size === 0) continue
    try { reflowSection(root, styles, { BODY_W, BODY_H }, MODE) } catch { continue }
    if (process.env.VFIRST) {
      // 최상위 문단: 직전 문단의 끝(마지막 줄 vertpos)이 맞았는데 이 문단 첫 줄 vertpos 가 틀린 경우 — 드리프트의 시작점
      let prevOk = true, prevP: Element | null = null
      for (const p of Array.from(root.childNodes as unknown as Element[]).filter(c => c.nodeName === "hp:p")) {
        const ts = tSeg.get(p); const lsa2 = Array.from(p.childNodes as unknown as Element[]).find(c => c.nodeName === "hp:linesegarray")
        if (!ts || !lsa2 || ts.length === 0) { prevOk = false; continue }
        const gs = Array.from(lsa2.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => Number(s.getAttribute("vertpos")))
        if (gs.length === 0) { prevOk = false; continue }
        const okFirst = gs[0] === ts[0][0]
        if (prevOk && !okFirst) { const key = String(gs[0] - ts[0][0]); vfirst[key] = (vfirst[key] ?? 0) + 1; if (vfdumped++ < Number(process.env.VFIRST)) console.log("VF", f.slice(0, 26), "d", gs[0] - ts[0][0], "T", ts[0][0], "K", gs[0], "beyondH", ts[0][0] + ts[0][1] > BODY_H ? 1 : 0, "over", ts[0][0] + ts[0][1] - BODY_H, "pp", p.getAttribute("paraPrIDRef"), "prevpp", prevP?.getAttribute("paraPrIDRef"), "prevCell", prevP ? Array.from(prevP.getElementsByTagName("hp:tbl") as unknown as Element[]).filter(t => t.parentNode?.parentNode === prevP && (t.getElementsByTagName("hp:pos")[0] as unknown as Element)?.getAttribute("treatAsChar") === "0").map(t => t.getAttribute("pageBreak")).join("/") : "", "prevT", JSON.stringify(tSeg.get(prevP!)?.slice(-1)), JSON.stringify((p.textContent ?? "").slice(0, 30)), ["hp:tbl", "hp:pic", "hp:rect", "hp:equation", "hp:container"].filter(tg => p.getElementsByTagName(tg).length).join(",")) }
        const fullSegs = Array.from(lsa2.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => ["vertpos", "vertsize", "spacing"].map(a => Number(s.getAttribute(a))))
        prevOk = okFirst && gs.length === ts.length && fullSegs.every((v, i) => v[0] === ts[i][0] && v[1] === ts[i][1] && v[2] === ts[i][4]); prevP = p
      }
    }
    for (const [p, t] of truth) {
      if (process.env.ONLYFWS && !Array.from(p.childNodes as unknown as Element[]).some(r => r.nodeName === "hp:run" && (r as Element).getElementsByTagName("hp:fwSpace").length > 0)) continue
      const lsa = Array.from(p.childNodes as unknown as Element[]).find(c => c.nodeName === "hp:linesegarray")
      const g = lsa ? Array.from(lsa.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => Number(s.getAttribute("textpos"))) : []
      const ok = g.length === t.length && g.every((x, i) => x === t[i])
      st.all++; if (g.length === t.length) st.linesOk++
      if (process.env.TBLH && ok && lsa && t.length === 1 && kindOf(p) === "body+obj") {
        const direct = Array.from(p.childNodes as unknown as Element[]).filter(c => c.nodeName === "hp:run").flatMap(r => Array.from(r.childNodes as unknown as Element[]).filter(c => c.nodeName === "hp:tbl"))
        if (direct.length === 1) {
          const gv = Number((lsa.getElementsByTagName("hp:lineseg")[0] as unknown as Element).getAttribute("vertsize")), tv = tSeg.get(p)![0][1]
          const sz = Number((direct[0].getElementsByTagName("hp:sz")[0] as unknown as Element).getAttribute("height"))
          const cellPs = Array.from(direct[0].getElementsByTagName("hp:p") as unknown as Element[])
          const cellOk = cellPs.every(cp => { const tt = truth.get(cp) ?? [], ll = Array.from(cp.childNodes as unknown as Element[]).find(c => c.nodeName === "hp:linesegarray"); const gg = ll ? Array.from(ll.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(x => Number(x.getAttribute("textpos"))) : []; return gg.length === tt.length })
          const key = (tv === gv ? "same" : Math.abs(tv - gv) <= 8 ? "±8" : tv > gv ? "T>K" : "T<K") + (cellOk ? " cells-ok" : " cells-wrap")
          tblh[key] = (tblh[key] ?? 0) + 1
          if (key === (process.env.TBLKEY ?? "T<K cells-ok") && tblhd++ < Number(process.env.TBLH)) console.log("TH", f.slice(0, 26), "T", tv, "K", gv, "sz", sz, "rows", direct[0].getAttribute("rowCnt"), "cols", direct[0].getAttribute("colCnt"), "treat", (direct[0].getElementsByTagName("hp:pos")[0] as unknown as Element)?.getAttribute("treatAsChar"))
        }
      }
      if (ok && lsa && t.length > 0) {
        const gs = Array.from(lsa.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => ["vertpos", "vertsize", "textheight", "baseline", "spacing"].map(a => Number(s.getAttribute(a))))
        const ts = tSeg.get(p)!, kk = kindOf(p).split("+")[0] + (kindOf(p).includes("obj") ? "+obj" : "")
        if (process.env.VSJSON === kk && !gs.every((x, i) => x[1] === ts[i][1] && x[2] === ts[i][2] && x[3] === ts[i][3] && x[4] === ts[i][4])) ((globalThis as any).vsRows ??= []).push({ f, T: ts, K: gs })
        if (process.env.SEQDUMP === kk) console.log("SEQ", (p.parentNode as any)?.nodeName, JSON.stringify(f), ts[0][0], gs[0][0], ts[0][0] - gs[0][0], t.length, JSON.stringify((p.textContent ?? "").slice(0, 24)))
        const v = (vstat[kk] ??= [0, 0, 0, 0, 0])
        v[0]++
        if (gs.every((x, i) => x[1] === ts[i][1] && x[2] === ts[i][2] && x[3] === ts[i][3] && x[4] === ts[i][4])) v[1]++
        if (!gs.every((x, i) => x[1] === ts[i][1] && x[2] === ts[i][2] && x[3] === ts[i][3] && x[4] === ts[i][4])) { const i = gs.findIndex((x, j) => x[1] !== ts[j][1] || x[4] !== ts[j][4]); if (i >= 0) { const dv = gs[i][1] - ts[i][1], ds = gs[i][4] - ts[i][4]; const key = kk + " " + (dv === 0 ? "h=" : dv > 0 ? "h+" : "h-") + (Math.abs(dv) > 1000 ? "big" : "") + " " + (ds === 0 ? "sp=" : "sp" + (ds > 0 ? "+" : "-")); vfield[key] = (vfield[key] ?? 0) + 1 } }
        if (process.env.TBDUMP === kk && gs.every((x, i) => x[1] === ts[i][1] && x[4] === ts[i][4]) && !gs.every((x, i) => x[2] === ts[i][2] && x[3] === ts[i][3])) { const i = gs.findIndex((x, j) => x[2] !== ts[j][2] || x[3] !== ts[j][3]); const key = `vs${ts[i][1] === ts[i][2] ? "=th" : "≠th"} K${gs[i][1] === gs[i][2] ? "=th" : "≠th"}`; tb[key] = (tb[key] ?? 0) + 1; if (tbd++ < 10) console.log("TB", f.slice(0, 24), "line", i, "of", gs.length, "T", JSON.stringify(ts[i]), "K", JSON.stringify(gs[i]), ["hp:tbl", "hp:pic", "hp:equation", "hp:rect"].map(tg => tg + p.getElementsByTagName(tg).length).join(","), JSON.stringify((p.textContent ?? "").slice(0, 20))) }
        if (gs.every((x, i) => x[1] === ts[i][1] && x[2] === ts[i][2] && x[3] === ts[i][3] && x[4] === ts[i][4])) {} else if (process.env.VDUMP === kk && vdumped++ < Number(process.env.VDN ?? 12)) console.log("VD", f.slice(0, 26), "pp", p.getAttribute("paraPrIDRef"), "T", JSON.stringify(ts.slice(0, 2)), "K", JSON.stringify(gs.slice(0, 2)), JSON.stringify((p.textContent ?? "").slice(0, 30)))
        if (gs.every((x, i) => i === 0 || x[0] - gs[i - 1][0] === ts[i][0] - ts[i - 1][0])) v[2]++
        if (gs[0][0] === ts[0][0]) v[3]++
        else if (process.env.FVDUMP === kk) {
          // 첫 줄 vertpos 가 다른 문단 — 칸 안 몇째 문단인지·칸 세로 정렬·차이(FVJSON=out.json 으로 모은다)
          const sub = p.parentNode as unknown as Element, sibs = sub ? Array.from(sub.childNodes as unknown as Element[]).filter(c => c.nodeName === "hp:p") : []
          fvRows.push({ f, d: ts[0][0] - gs[0][0], idx: sibs.indexOf(p), n: sibs.length, va: sub?.getAttribute?.("vertAlign") ?? "", t: (p.textContent ?? "").slice(0, 20) })
        }
        if (process.env.PFV && kk === "body" && gs[0][0] === ts[0][0]) (globalThis as any).pfv = { ...((globalThis as any).pfv ?? {}), [f]: (((globalThis as any).pfv ?? {})[f] ?? 0) + 1 }
      }
      if (process.env.PERFILE) { const pl = (perFileLines[dir + "/" + f] ??= [0, 0]); pl[0]++; if (g.length === t.length) pl[1]++ }
      if (process.env.BRK && t.length >= 2 && !ok) {
        const pm = buildPara(p); const txt = pm.chars.map((c: any) => c.ch || "□").join("")
        const k = t.findIndex((x, i) => i > 0 && g[i] !== x)
        if (k > 0 && g[k] !== undefined) {
          const T = t[k], G = g[k]
          const ctx = (at: number) => JSON.stringify(txt.slice(Math.max(0, at - 4), at)) + "|" + JSON.stringify(txt.slice(at, at + 4))
          console.log("BRK", f.slice(0, 20), "d", G - T, "truth", ctx(T), "ours", ctx(G))
        }
      }
      if (process.env.BLAME && t.length >= 2) {
        const pm = buildPara(p)
        const keyOf = (c: any) => { const st = styles.charPr.get(c.prId ?? ""); if (!st || !c.ch || c.ch.length !== 1) return null; const lang = hancomLangOf(c.ch.codePointAt(0)!); const L = lang === "hangul" ? undefined : st[lang]; return ((L?.face ?? st.face) ?? "?") + (st.bold ? "|B" : "") + "	" + c.ch }
        if (ok) { for (const c of pm.chars) { const k = keyOf(c); if (k) (blame[k] ??= [0, 0, 0])[2]++ } }
        else {
          const k = t.findIndex((x, i) => i > 0 && g[i] !== x)
          if (k > 0 && g[k] !== undefined) {
            const over = g[k] < t[k] ? 0 : 1
            for (let i = t[k - 1]; i < t[k]; i++) { const kk = keyOf(pm.chars[i] ?? {}); if (kk) (blame[kk] ??= [0, 0, 0])[over]++ }
          }
        }
      }
      if (process.env.DUMPKIND && kindOf(p) === process.env.DUMPKIND && t.length >= 2 && !ok && dumped++ < Number(process.env.DUMPN ?? 12)) {
        const objs = ["hp:tbl", "hp:pic", "hp:rect", "hp:equation", "hp:container", "hp:line"].map(tg => tg + ":" + p.getElementsByTagName(tg).length).filter(x => !x.endsWith(":0")).join(",")
        const tac = Array.from(p.getElementsByTagName("hp:pos") as unknown as Element[]).map(e => e.getAttribute("treatAsChar")).join("")
        console.log("DUMP", f.slice(0, 30), "truth", JSON.stringify(t), "got", JSON.stringify(g), objs, "tac", tac, (() => { const a: string[] = []; let x: any = p.parentNode; while (x && x.nodeName !== "hs:sec") { a.push(x.nodeName.replace("hp:", "")); x = x.parentNode } return a.join("<") })(), "pp", p.getAttribute("paraPrIDRef"), JSON.stringify((p.textContent ?? "").slice(0, 50)))
      }
      if (g.length === 0) { const path: string[] = []; let a: any = p.parentNode; while (a && a.nodeName !== "hs:sec") { if (/^hp:(drawText|caption|tc|subList|rect|container|ellipse|polygon|pic|tbl|equation|footNote|endNote|header|footer|ctrl)$/.test(a.nodeName)) path.push(a.nodeName.slice(3)); a = a.parentNode } const k = path.reverse().join(">") || "top"; noSegWhere[k] = (noSegWhere[k] ?? 0) + 1 }
      if (t.length >= 2 && kindOf(p).startsWith("body+") && kindOf(p).includes("obj")) { const c = (objCat[catOf(p, g)] ??= [0, 0]); c[0]++; if (ok) c[1]++ }
        if (process.env.CATDUMP && !ok && t.length >= 2 && kindOf(p).startsWith("body+") && catOf(p, t) === process.env.CATDUMP && catd++ < 30) console.log("CD", f.slice(0, 30), "pp", p.getAttribute("paraPrIDRef"), "T", JSON.stringify(t), "K", JSON.stringify(g), JSON.stringify((p.textContent ?? "").slice(0, 50)))
      if (t.length >= 2 && kindOf(p) === (process.env.FACEKIND ?? "body")) {
        const run = Array.from(p.childNodes as unknown as Element[]).find(c => c.nodeName === "hp:run")
        const face = (styles.charPr.get(run?.getAttribute("charPrIDRef") ?? "")?.hft && process.env.HFTFACE ? "HFT:" : "") + styles.charPr.get(run?.getAttribute("charPrIDRef") ?? "")?.face ?? "?"
        const fc = (byFace[face] ??= [0, 0]); fc[0]++; if (ok) fc[1]++; if (process.env.FACEDOC === face) { const fd = (faceDoc[f] ??= [0, 0]); fd[0]++; if (ok) fd[1]++; if (!ok && process.env.FACEDUMP && fdumped++ < 30) console.log("FD", f.slice(0, 30), "truth", JSON.stringify(t), "got", JSON.stringify(g), "pp", p.getAttribute("paraPrIDRef"), "txt", JSON.stringify(buildPara(p).chars.map((c: any) => c.ch || "\u0000").join(""))) }
      }
      if (t.length >= 2) { const gh = lsa ? Number((lsa.getElementsByTagName("hp:lineseg")[0] as unknown as Element)?.getAttribute("horzsize")) : -1; const kk = kindOf(p).split("+")[0]; const hs2 = (horzStat[kk] ??= [0, 0, 0]); hs2[0]++; if (gh === tHorz.get(p)) { hs2[1]++; if (ok) hs2[2]++ } else { const d = tHorz.get(p)! - gh; if (process.env.HDUMP && kk === process.env.HDUMP && (process.env.HSIGN === "+" ? d > 600 : process.env.HSIGN === "-" ? d < -600 : /^\d+$/.test(process.env.HSIGN ?? "") ? d === Number(process.env.HSIGN) : Math.abs(d) > 4) && (hfile[f] = (hfile[f] ?? 0) + 1) && hdumped++ < Number(process.env.HDN ?? 30)) console.log("HD", f.slice(0, 28), (() => { const a: string[] = []; let x: any = p.parentNode; while (x && x.nodeName !== "hs:sec") { a.push(x.nodeName.replace("hp:", "")); x = x.parentNode } return a.join("<") })(), "truth", tHorz.get(p), "got", gh, "d", d, "pp", p.getAttribute("paraPrIDRef"), JSON.stringify(styles.paraGeom.get(p.getAttribute("paraPrIDRef") ?? "") ?? {}).slice(0, 160)); const key = kk + " " + (Math.abs(d) <= 4 ? String(d) : d > 0 ? (d < 600 ? "+5~600" : "+600~") : (d > -600 ? "-5~600" : "-600~")); horzDiff[key] = (horzDiff[key] ?? 0) + 1 } }
      if (t.length >= 2 && process.env.PERFILE) { const pf = (perFileOk[dir + "/" + f] ??= [0, 0]); pf[0]++; if (ok) pf[1]++ }
      if (t.length >= 2 && styles.paraGeom.get(p.getAttribute("paraPrIDRef") ?? "")?.number) { numstat[0]++; if (ok) numstat[1]++; else if (process.env.NUMDUMP) { const n = styles.paraGeom.get(p.getAttribute("paraPrIDRef") ?? "")!.number!; console.log("ND", f.slice(0, 24), "lv", n.level, JSON.stringify(n.heads.get(n.level)), "T", JSON.stringify(t), "K", JSON.stringify(g), JSON.stringify((p.textContent ?? "").slice(0, 24))) } }
      if (process.env.HANGOUT && t.length >= 2 && (styles.paraGeom.get(p.getAttribute("paraPrIDRef") ?? "")?.marginIntent ?? 0) < 0) hangRows.push([f, name, hangIdx++, ok ? 1 : 0, p.getAttribute("paraPrIDRef"), (p.textContent ?? "").slice(0, 16)].join("\t"))
      if (process.env.LCD && g.length !== t.length) console.log("LCD", dir.split("/").pop(), f.slice(0, 30), JSON.stringify(t), JSON.stringify(g), kindOf(p), JSON.stringify((p.textContent ?? "").slice(0, 24)))
      if (process.env.PARADUMP && t.length >= 2) paraRows.push([f, paraIdx, ok ? 1 : 0, JSON.stringify(t), JSON.stringify(g), (p.textContent ?? "").slice(0, 40).replace(/\s/g, " ")].join("\t"))
      paraIdx++
      if (t.length >= 2) { st.multi++; if (ok) st.multiOk++; const kk = (byKind[kindOf(p)] ??= [0, 0]); kk[0]++; if (ok) kk[1]++ }
      const d = (byDir[dir.split("/").pop()!] ??= [0, 0, 0, 0]); d[0]++; if (g.length === t.length) d[1]++; if (t.length >= 2) { d[2]++; if (ok) d[3]++ }
    }
  }
}
console.log(`all ${st.all} 줄수일치 ${st.linesOk} (${(100 * st.linesOk / st.all).toFixed(2)}%) | 두 줄+ ${st.multi} 전부일치 ${st.multiOk} (${(100 * st.multiOk / st.multi).toFixed(2)}%)`)
for (const [d, v] of Object.entries(noSegWhere).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log("  noseg", d.padEnd(40), v)
for (const [d, v] of Object.entries(faceDoc).sort((a, b) => (b[1][0] - b[1][1]) - (a[1][0] - a[1][1])).slice(0, 15)) console.log("  facedoc", v[1], "/", v[0], d)
for (const [d, v] of Object.entries(vfirst).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log("  vfirst d", d.padEnd(8), v)
for (const [d, v] of Object.entries(tblh)) console.log("  tblh", d, v)
for (const [d, v] of Object.entries(tb)) console.log("  tb", d, v)
for (const [d, v] of Object.entries(vfield).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log("  vfield", d.padEnd(22), v)
for (const [d, v] of Object.entries(vstat)) console.log("  vert", d.padEnd(9), `줄 시작 맞는 ${v[0]} 중 높이·기준선·간격 일치 ${v[1]} · 줄 간격 일치 ${v[2]} · 첫 줄 vertpos 일치 ${v[3]}`)
console.log("  number paras", numstat[1], "/", numstat[0])
for (const [d, v] of Object.entries(hfile).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log("  hfile", v, d)
for (const [d, v] of Object.entries(horzDiff).sort((a, b) => b[1] - a[1]).slice(0, 16)) console.log("  hdiff", d.padEnd(14), v)
for (const [d, v] of Object.entries(horzStat)) console.log("  horz", d, `폭 일치 ${v[1]}/${v[0]}, 그중 줄 시작 일치 ${v[2]}`)
for (const [d, v] of Object.entries(byFace).sort((a, b) => b[1][0] - a[1][0]).slice(0, 22)) console.log("  face", d.padEnd(20), `${v[1]}/${v[0]} (${(100 * v[1] / v[0]).toFixed(1)}%)`)
for (const [d, v] of Object.entries(objCat)) console.log("  objcat", d.padEnd(14), `${v[1]}/${v[0]}`)
for (const [d, v] of Object.entries(byKind)) console.log("  kind", d.padEnd(16), `${v[1]}/${v[0]} (${(100 * v[1] / v[0]).toFixed(1)}%)`)
for (const [d, v] of Object.entries(byDir)) console.log("  ", d.padEnd(16), `줄수 ${v[1]}/${v[0]}  두줄+ ${v[3]}/${v[2]}`)

if (process.env.PARADUMP) (await import("node:fs")).writeFileSync(process.env.PARADUMP, paraRows.join("\n"))
if (process.env.FVJSON) (await import("node:fs")).writeFileSync(process.env.FVJSON, JSON.stringify(fvRows))
if (process.env.VSOUT) (await import("node:fs")).writeFileSync(process.env.VSOUT, JSON.stringify((globalThis as any).vsRows ?? []))
if (process.env.PERFILE) (await import("node:fs")).writeFileSync(process.env.PERFILE, JSON.stringify({ ok: perFileOk, lines: perFileLines }))

if (process.env.FACEJSON) (await import("node:fs")).writeFileSync(process.env.FACEJSON, JSON.stringify(faceDoc))

if (process.env.HANGOUT) (await import("node:fs")).writeFileSync(process.env.HANGOUT, hangRows.join("\n"))
if (process.env.PFV) for (const [k, v] of Object.entries((globalThis as any).pfv ?? {})) console.log("PFV", v, k)
if (process.env.BLAME) (await import("node:fs")).writeFileSync(process.env.BLAME, JSON.stringify(blame))
