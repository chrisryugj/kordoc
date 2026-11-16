import { it } from "node:test"
import assert from "node:assert/strict"
import { openHayro } from "../src/pdf/hayro.js"
import { hayroFontInfo, hayroTextPage } from "../src/pdf/hayro-text.js"
import { hayroOps } from "../src/pdf/hayro-ops.js"
import { OPS } from "../src/pdf/ops.js"
import { readFileSync } from "node:fs"
import { parse } from "../src/index.js"

/** 글꼴 F1 하나로 content 를 찍은 한 쪽 */
function onePagePdf(content: string, font: string): Uint8Array {
  const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    font, stream(content),
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i++) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += String(o).padStart(10, "0") + " 00000 n \n"
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Uint8Array(Buffer.from(pdf, "latin1"))
}

/** 글자 폭 970 인 Helvetica 한 쪽 — 줄마다 `[(AB) 200 (C) 124 (D)] TJ` 를 Tm 13배로 x 를 바꿔 찍는다 */
function tjPdf(): Uint8Array {
  const lines: string[] = []
  for (let k = 0; k < 24; k++) lines.push(`BT /F1 1 Tf 13 0 0 13 ${(101.996 + k * 7.13).toFixed(3)} ${700 - k * 20} Tm [(AB) 200 (C) 124 (D)] TJ ET`)
  return onePagePdf(lines.join(" "), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 65 /LastChar 70 /Widths [970 970 970 970 970 970] >>")
}

it("TJ 200(−0.2em) 틈은 pdf.js 와 같은 줄에서 끊는다", async () => {
  // TJ 200 은 글자 크기 × −0.2 문턱에 딱 걸린다 — 끊기는 f64 셈의 끝자리로 갈린다. 기대값은 pdf.js 4.10 getTextContent 의 결과
  const items = hayroTextPage(await openHayro(tjPdf()), 1).items.filter(it => it.str).map(it => it.str)
  assert.deepEqual(items, [...Array(19).fill("ABCD"), ...Array(5).fill(["AB", "CD"]).flat()])
})

// LaurenzV/hayro#1813 의 시험 파일 그대로 — ToUnicode 없는 임베디드 CID 글꼴(Adobe-Korea1·Japan1, Identity-H). hayro 고정 커밋을 올릴 때 글이 다시 빠지면 잡는다
it("ToUnicode 없는 임베디드 CID 글꼴도 UCS2 CMap 으로 글을 낸다", async () => {
  const r = await parse(new Uint8Array(readFileSync(new URL("./fixtures/embedded-cid-font-ucs2.pdf", import.meta.url))), { ocr: false })
  assert.ok(r.success)
  assert.equal(r.markdown.replace(/[#\s]/g, ""), "가나다あいう")
})

it("유니코드 없는 글자는 pdf.js 처럼 글자 코드를 글자로 내고 폭을 센다", async () => {
  // 글리프 이름 /g3 은 유니코드가 없다. 기대값은 pdf.js 4.10 getTextContent 의 결과 — 공백으로 셈하면 조각 폭이 0 이 되어 쪽 글이 버려지고 NEEDS_OCR 판정에서도 빠진다
  const font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [2 /g3] >> /FirstChar 2 /LastChar 2 /Widths [872] >>"
  const items = hayroTextPage(await openHayro(onePagePdf("BT /F1 12 Tf 100 700 Td <0202> Tj ET", font)), 1).items.filter(it => it.str)
  assert.deepEqual(items.map(it => [it.str, it.width]), [["\u0002\u0002", 2 * 872 * 12 / 1000]])
})

it("ToUnicode 없는 Adobe-Korea1 글꼴의 ToUnicode 표는 pdf.js 처럼 UCS2 CMap 으로 채운다", async () => {
  // 표가 비면 restoreUnmappedCidSpaces 가 표에 없는 대체 공백 글리프를 못 가려 글자 코드 한자(䞻)가 남는다
  const doc = await openHayro(new Uint8Array(readFileSync(new URL("./fixtures/embedded-cid-font-ucs2.pdf", import.meta.url))))
  const units = hayroTextPage(doc, 1).fonts.map(k => hayroFontInfo(doc, k)!.toUnicode.map(([, u]) => u).join(""))
  assert.ok(units.some(u => u.includes("가") && u.includes("다")))
})

it("연산자 목록의 showText 는 TJ 숫자를 글자 사이에 둔다 (자간·낱말 간격은 숫자가 아니다)", async () => {
  // pdf.js 연산자 목록의 모양 — joinTrackedHangul 이 같은 TJ 안 이동으로 자간과 균등배분을 가른다
  const doc = await openHayro(tjPdf())
  const { events, strings } = doc.events(0)
  const ops = hayroOps(events, strings)
  const run = ops.argsArray[ops.fnArray.indexOf(OPS.showText)]![0] as unknown[]
  // 숫자는 콘텐츠에 적힌 값 그대로 — 자리에서 되살리면 끝자리가 흔들려 0.15em 문턱의 자간이 pdf.js 와 달리 갈린다
  assert.deepEqual(run.map(g => typeof g === "number" ? g : (g as { unicode: string }).unicode), ["A", "B", 200, "C", 124, "D"])
  const spaced = onePagePdf("BT /F1 10 Tf 2 Tc 3 Tw 150 Tz 100 700 Td [(A B) -300 (C)] TJ ET", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const ev2 = (await openHayro(spaced)).events(0)
  const ops2 = hayroOps(ev2.events, ev2.strings)
  const run2 = ops2.argsArray[ops2.fnArray.indexOf(OPS.showText)]![0] as unknown[]
  assert.deepEqual(run2.map(g => typeof g === "number" ? Math.round(g) : (g as { unicode: string }).unicode), ["A", " ", "B", -300, "C"])
})

it("칠하기 연산은 콘텐츠 그대로 — 넓이 없는 채움은 채움, B 는 fillStroke 하나, w 는 제자리", async () => {
  // hayro 는 넓이 없는 채움을 가는 긋기로, B 를 채움·긋기 두 번으로 준다. 그대로 내면 그라데이션 띠·도형 테두리가 표 괘선으로 읽힌다
  const page = hayroTextPage(await openHayro(onePagePdf("100 100 0 50 re f* 1 0 0 RG 2 w 200 100 50 50 re B", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")), 1)
  const { fnArray, argsArray } = hayroOps(page.events, page.strings)
  const paints = fnArray.filter(f => [OPS.fill, OPS.eoFill, OPS.stroke, OPS.fillStroke, OPS.eoFillStroke].includes(f))
  assert.deepEqual(paints, [OPS.eoFill, OPS.fillStroke])
  assert.deepEqual(argsArray[fnArray.indexOf(OPS.constructPath)]!.slice(0, 2), [[OPS.rectangle], [100, 100, 0, 50]])
  const at = fnArray.lastIndexOf(OPS.constructPath)
  assert.deepEqual([fnArray[at - 1], argsArray[at - 1]], [OPS.setStrokeRGBColor, [255, 0, 0]])
  // 선 굵기는 콘텐츠의 w 자리 — 두 경로 사이
  const w = fnArray.indexOf(OPS.setLineWidth)
  assert.deepEqual(argsArray[w], [2])
  assert.ok(fnArray.indexOf(OPS.eoFill) < w && w < at)
})

it("연산자가 상한(1,000만)을 넘는 쪽은 해석하지 않고 오류를 낸다", async () => {
  // 엔진은 동기라 시간으로 끊지 못한다 — 쪽 하나가 하는 일의 양으로 끊는다
  const doc = await openHayro(onePagePdf("n ".repeat(10_000_001), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"))
  assert.throws(() => doc.events(0), /more than 10000000 content operators/)
})
