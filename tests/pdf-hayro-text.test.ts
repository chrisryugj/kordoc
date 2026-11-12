import { it } from "node:test"
import assert from "node:assert/strict"
import { openHayro } from "../src/pdf/hayro.js"
import { hayroTextPage } from "../src/pdf/hayro-text.js"
import { readFileSync } from "node:fs"
import { parse } from "../src/index.js"

/** 글자 폭 970 인 Helvetica 한 쪽 — 줄마다 `[(AB) 200 (C) 124 (D)] TJ` 를 Tm 13배로 x 를 바꿔 찍는다 */
function tjPdf(): Uint8Array {
  const lines: string[] = []
  for (let k = 0; k < 24; k++) lines.push(`BT /F1 1 Tf 13 0 0 13 ${(101.996 + k * 7.13).toFixed(3)} ${700 - k * 20} Tm [(AB) 200 (C) 124 (D)] TJ ET`)
  const content = lines.join(" ")
  const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 65 /LastChar 70 /Widths [970 970 970 970 970 970] >>", stream(content),
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
