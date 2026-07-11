// HWPX 요소 전수 다이제스트 (styleDigest) — 문서 스타일·구조를 압축 JSON으로 덤프.
// 실측 대조·회귀 검증·스타일 역분석의 기반 도구 (2026-07 공문서 전수 학습 세션에서 검증).
// 사용: node scripts/style-digest.mjs <in.hwpx> <out.json>
// 출력: { meta, fonts, charPrs, paraPrs, borderFills, sections:[{secPr, headers, footers, body:[...]}] }
// body 항목: {p:{pr,runs:[[charPr,text]...],ctrl?}} | {tbl:{rows,cols,w,h,cells:[...]}} | {shape...}
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

const [src, out] = process.argv.slice(2);
const zip = await JSZip.loadAsync(await readFile(src));
const names = Object.keys(zip.files);
const read = async (n) => zip.file(n) ? await zip.file(n).async("string") : null;
const parse = (s) => new DOMParser().parseFromString(s, "text/xml");
const A = (el, name) => el.getAttribute(name);
const kids = (el, tag) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && (tag ? n.nodeName.endsWith(":" + tag) || n.nodeName === tag : true));
const findAll = (el, tag) => Array.from(el.getElementsByTagName("*")).filter((n) => n.nodeName.endsWith(":" + tag));
const pt = (v) => (v == null || v === "" ? null : Math.round(Number(v)) / 100); // HWPUNIT height/100 = pt

// ── header.xml: 스타일 테이블 ───────────────────────────
const headerXml = await read(names.find((n) => /header\.xml$/i.test(n)));
const hdr = parse(headerXml);

const fonts = {};
for (const ff of findAll(hdr, "fontface")) {
  const lang = A(ff, "lang");
  for (const f of kids(ff, "font")) fonts[`${lang}:${A(f, "id")}`] = A(f, "face");
}
const fontName = (lang, id) => fonts[`${lang}:${id}`] ?? `#${id}`;

const charPrs = {};
for (const cp of findAll(hdr, "charPr")) {
  const id = A(cp, "id");
  const o = { pt: pt(A(cp, "height")) };
  const fr = kids(cp, "fontRef")[0];
  if (fr) o.font = { h: fontName("HANGUL", A(fr, "hangul")), l: fontName("LATIN", A(fr, "latin")) };
  if (o.font && o.font.h === o.font.l) o.font = o.font.h;
  const bold = kids(cp, "bold").length > 0 || A(cp, "bold") === "1";
  if (bold) o.bold = 1;
  if (kids(cp, "italic").length) o.italic = 1;
  if (kids(cp, "underline").length && A(kids(cp, "underline")[0], "type") !== "NONE") o.ul = 1;
  const tc = A(cp, "textColor");
  if (tc && tc !== "#000000") o.color = tc;
  const sc = A(cp, "shadeColor");
  if (sc && sc !== "none" && sc !== "#FFFFFF") o.shade = sc;
  const sp = kids(cp, "spacing")[0];
  if (sp && A(sp, "hangul") !== "0") o.spacing = A(sp, "hangul");
  const ratio = kids(cp, "ratio")[0];
  if (ratio && A(ratio, "hangul") !== "100") o.ratio = A(ratio, "hangul");
  charPrs[id] = o;
}

const paraPrs = {};
for (const pp of findAll(hdr, "paraPr")) {
  const id = A(pp, "id");
  const o = {};
  const al = kids(pp, "align")[0];
  if (al) { o.align = A(al, "horizontal"); if (A(al, "vertical") && A(al, "vertical") !== "BASELINE") o.valign = A(al, "vertical"); }
  const bs = kids(pp, "breakSetting")[0];
  if (bs) { o.brkNonLatin = A(bs, "breakNonLatinWord"); o.brkLatin = A(bs, "breakLatinWord"); if (A(bs, "keepWithNext") === "1") o.keepNext = 1; }
  if (A(pp, "snapToGrid") === "1") o.grid = 1;
  // margin·lineSpacing이 hp:switch>hp:default 안에 있을 수 있다(전자결재 산출 기안문 실측)
  // — hp:default가 표준 HWPUNIT 값, hp:case(HwpUnitChar)는 글자단위라 default 우선
  const swDefault = kids(pp, "switch").flatMap((sw) => kids(sw, "default"));
  const scopes = [pp, ...swDefault];
  const m = scopes.flatMap((s) => kids(s, "margin"))[0];
  if (m) {
    const g = (t) => { const el = kids(m, t)[0]; return el ? Number(A(el, "value")) : 0; };
    const mm = { indent: g("intent"), left: g("left"), right: g("right"), before: g("prev"), after: g("next") };
    for (const [k, v] of Object.entries(mm)) if (v) o[k] = v;
  }
  const ls = scopes.flatMap((s) => kids(s, "lineSpacing"))[0];
  if (ls) o.lineSp = `${A(ls, "value")}${A(ls, "type") === "PERCENT" ? "%" : A(ls, "type")}`;
  const hd = kids(pp, "heading")[0];
  if (hd && A(hd, "type") !== "NONE") o.heading = `${A(hd, "type")}:${A(hd, "level")}`;
  const bd = A(pp, "borderFillIDRef");
  if (bd && bd !== "0" && bd !== "1" && bd !== "2") o.borderFill = bd;
  paraPrs[id] = o;
}

const borderFills = {};
for (const bf of findAll(hdr, "borderFill")) {
  const id = A(bf, "id");
  const o = {};
  for (const side of ["leftBorder", "rightBorder", "topBorder", "bottomBorder"]) {
    const b = kids(bf, side)[0];
    if (b && A(b, "type") !== "NONE") o[side.replace("Border", "")] = `${A(b, "type")} ${A(b, "width")} ${A(b, "color")}`;
  }
  const fill = findAll(bf, "winBrush")[0];
  if (fill && A(fill, "faceColor") && A(fill, "faceColor") !== "none") o.fill = A(fill, "faceColor");
  const grad = findAll(bf, "gradation")[0];
  if (grad) o.gradient = 1;
  if (Object.keys(o).length) borderFills[id] = o;
}

// styles (named)
const styles = {};
for (const st of findAll(hdr, "style")) styles[A(st, "id")] = { name: A(st, "name"), pPr: A(st, "paraPrIDRef"), cPr: A(st, "charPrIDRef") };

// ── section 순회 ─────────────────────────────────────────
function digestP(p) {
  const o = { pr: A(p, "paraPrIDRef"), st: A(p, "styleIDRef") };
  if (o.st === "0" || o.st == null) delete o.st;
  const runs = [];
  const objs = [];
  for (const run of kids(p, "run")) {
    const cpr = A(run, "charPrIDRef");
    let text = "";
    for (const ch of kids(run)) {
      const t = ch.nodeName.replace(/^\w+:/, "");
      if (t === "t") text += ch.textContent;
      else if (t === "tbl") objs.push(digestTbl(ch));
      else if (t === "rect" || t === "ellipse" || t === "polygon" || t === "line" || t === "curve" || t === "container") objs.push(digestShape(ch));
      else if (t === "pic") objs.push({ pic: { w: szOf(ch, "w"), h: szOf(ch, "h") } });
      else if (t === "secPr") objs.push({ secPr: digestSecPr(ch) });
      else if (t === "ctrl") { const c = digestCtrl(ch); if (c) objs.push(c); }
      else if (t === "autoNum" || t === "pageNum") { text += `⟨${t}⟩`; }
      else if (t === "fieldBegin") text += "⟨field⟩";
    }
    if (text) runs.push([cpr, text]);
    else if (cpr != null && !kids(run).length) runs.push([cpr, ""]);
  }
  if (runs.length) o.runs = runs;
  if (objs.length) o.objs = objs;
  const lineSegs = findAll(p, "lineseg").length;
  if (lineSegs > 1) o.lines = lineSegs;
  return { p: o };
}

function szOf(el, attr) {
  const sz = findAll(el, "sz")[0] || findAll(el, "orgSz")[0];
  return sz ? A(sz, attr === "w" ? "width" : "height") : null;
}

function digestCtrl(ctrl) {
  const out = {};
  for (const ch of kids(ctrl)) {
    const t = ch.nodeName.replace(/^\w+:/, "");
    if (t === "header" || t === "footer") {
      const paras = findAll(ch, "p").filter((x) => x.parentNode && x.nodeName.endsWith(":p"));
      out[t] = paras.map((pp) => digestP(pp));
    } else if (t === "pageNum" || t === "pageNumCtrl" || t === "newNum") out[t] = { pos: A(ch, "pos") ?? A(ch, "num") };
    else if (t === "colPr") out.cols = A(ch, "colCount");
  }
  return Object.keys(out).length ? { ctrl: out } : null;
}

function digestSecPr(sp) {
  const o = {};
  const pg = findAll(sp, "pagePr")[0];
  if (pg) {
    o.page = { w: A(pg, "width"), h: A(pg, "height"), landscape: A(pg, "landscape") };
    const mg = findAll(pg, "margin")[0];
    if (mg) o.margin = { l: A(mg, "left"), r: A(mg, "right"), t: A(mg, "top"), b: A(mg, "bottom"), header: A(mg, "header"), footer: A(mg, "footer") };
  }
  const grid = findAll(sp, "grid")[0];
  if (grid) o.grid = { lineGrid: A(grid, "lineGrid"), charGrid: A(grid, "charGrid") };
  const pageNum = findAll(sp, "startNum")[0];
  if (pageNum) o.startNum = { page: A(pageNum, "page") };
  return o;
}

function digestTbl(tbl) {
  const o = {
    rows: A(tbl, "rowCnt"), cols: A(tbl, "colCnt"),
    w: szOf(tbl, "w"), h: szOf(tbl, "h"),
    bf: A(tbl, "borderFillIDRef"),
    repeatHeader: A(tbl, "repeatHeader"),
  };
  const inMargin = findAll(tbl, "inMargin")[0];
  if (inMargin) o.inMargin = `${A(inMargin, "left")}/${A(inMargin, "top")}`;
  const pos = findAll(tbl, "pos")[0];
  if (pos) o.pos = { treatAsChar: A(tbl, "textWrap") === null ? undefined : undefined, wrap: A(tbl, "textWrap"), affect: A(pos, "affectLSpacing") };
  o.cells = [];
  for (const tr of kids(tbl, "tr")) {
    for (const tc of kids(tr, "tc")) {
      const addr = findAll(tc, "cellAddr")[0];
      const span = findAll(tc, "cellSpan")[0];
      const csz = findAll(tc, "cellSz")[0];
      const cell = {
        rc: addr ? `${A(addr, "rowAddr")},${A(addr, "colAddr")}` : "?",
        span: span && (A(span, "colSpan") !== "1" || A(span, "rowSpan") !== "1") ? `${A(span, "rowSpan")}x${A(span, "colSpan")}` : undefined,
        w: csz ? A(csz, "width") : null, h: csz ? A(csz, "height") : null,
        bf: A(tc, "borderFillIDRef"),
        vAlign: (() => { const sl = kids(tc, "subList")[0]; return sl ? A(sl, "vertAlign") : null; })(),
        paras: [],
      };
      const sl = kids(tc, "subList")[0];
      if (sl) for (const pp of kids(sl, "p")) cell.paras.push(digestP(pp));
      if (!cell.span) delete cell.span;
      o.cells.push(cell);
    }
  }
  return { tbl: o };
}

function digestShape(sh) {
  const t = sh.nodeName.replace(/^\w+:/, "");
  const o = { kind: t, w: szOf(sh, "w"), h: szOf(sh, "h") };
  const fill = findAll(sh, "winBrush")[0];
  if (fill) o.fill = A(fill, "faceColor");
  const paras = [];
  for (const sl of findAll(sh, "subList")) for (const pp of kids(sl, "p")) paras.push(digestP(pp));
  if (paras.length) o.paras = paras;
  const texts = findAll(sh, "t").map((x) => x.textContent).join("");
  if (texts && !paras.length) o.text = texts;
  return { shape: o };
}

const sections = [];
for (const n of names.filter((x) => /Contents\/section\d+\.xml$/i.test(x)).sort()) {
  const doc = parse(await read(n));
  const body = [];
  const root = findAll(doc, "sec")[0] || doc.documentElement;
  for (const p of kids(root, "p")) body.push(digestP(p));
  sections.push({ file: n, body });
}

const digest = { src, fonts, charPrs, paraPrs, borderFills, styles, sections };
await writeFile(out, JSON.stringify(digest, null, 1), "utf-8");
const stats = `paras=${sections.reduce((a, s) => a + s.body.length, 0)} charPrs=${Object.keys(charPrs).length} paraPrs=${Object.keys(paraPrs).length} tbls=${JSON.stringify(digest).split('"tbl"').length - 1}`;
console.log(`OK ${out} ${stats}`);
