// PDF → 시각적 줄 단위 텍스트 추출 (한글 COM 실렌더 검증용 — bench/hangul-com-pdf.ps1 후속)
// 사용: node bench/extract-pdf-lines.mjs <a.pdf> [b.pdf …]  →  <a>_lines.txt
// 주의: 글 조각 추출(kordoc 의 hayro 경로, pdf.js 글 조각 규칙)은 공백이 소실될 수 있음 — verify-junctions.mjs가 무공백 기준으로 대조한다.
import { readFile, writeFile } from "node:fs/promises";
import { openPdf } from "./lib/pdf-engine.mjs";

async function extract(pdfPath) {
  const out = pdfPath.replace(/\.pdf$/i, "") + "_lines.txt";
  const doc = await openPdf(await readFile(pdfPath));
  const res = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const items = doc.page(p).items.map(i => ({ x: i.transform[4], y: i.transform[5], s: i.str })).filter(i => i.s.trim());
    const lines = [];
    for (const it of items.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x))) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= 2) last.t += it.s;
      else lines.push({ y: it.y, t: it.s });
    }
    res.push(`===== PAGE ${p} =====`, ...lines.map(l => l.t));
  }
  doc.close();
  await writeFile(out, res.join("\n"));
  console.log(out, "written");
}

for (const p of process.argv.slice(2)) await extract(p);
