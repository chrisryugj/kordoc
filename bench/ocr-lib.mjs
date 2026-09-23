// OCR 벤치 공용 (ocr-accuracy·ocr-robust) — 텍스트 추출·정규화·편집거리·래스터 글자 검사.
//
// 정규화는 두 가지를 같이 낸다 (둘 다 GT/OCR 양쪽 동일 적용 — 비대칭 정규화 금지):
//  strict(v1, 종전 그대로): NFC → 점 3개+ 리더 제거 → 공백 제거.
//  fair(v2): v1 에서 "문서 글자가 아닌 것"과 "픽셀로 구별 불가한 코드포인트 차이"만 더 걷는다.
//    1) 마크업: 문단 텍스트 안의 마크다운 표(columns.ts 레거시 다열 경로가 `| a | b |`·`| --- |`
//       를 문단 text 에 넣음 — 코퍼스 GT 에 "|" 1,210자), 링크 [글](url), <u>·~~ 서식 표지
//    2) 혼동 글리프: 가운뎃점 계열(· ․ ‧ ∙ ⋅ ・ ･ ㆍ ᆞ) → ·, 로마 숫자 Ⅰ~ⅻ → 라틴(NFKC),
//       전각 ASCII(U+FF01~FF5E) → 반각(NFKC), 물결 ∼ 〜 → ~, 가로 막대 ― → —
//    3) 리더: … ⋯ 는 점 3개, ‥ 는 2개로 펴고 공백 제거 **뒤** 점 3개+ 제거 — OCR 이 리더를 "……"
//       두 글자·공백으로 끊어 읽어 종전 규칙(3개+)을 비껴가던 비대칭 해소
//    4) 추출 범위: 표 캡션·중첩 리스트 항목(children)은 글자로 세고, 이미지 파일 참조는 뺀다 (blockTexts 주석)
//  구별 가능한 차이(○ vs O, ‘’ vs ', 【】 vs [], ① vs 1)는 접지 않는다 — OCR 오류로 남긴다.

/**
 * IR 블록 → 텍스트 조각 (본문 블록 text, 표는 셀 row-major).
 * v2 는 표 캡션(detectTableCaptions 가 표 앞뒤 "표 N" 문단을 흡수)과 중첩 리스트 항목
 * (detectKoreanListBlocks 가 하위 항목을 children 으로 옮김)도 담는다 — v1(종전 textOf)은
 * 둘을 빠뜨려, 어느 쪽 파이프라인이 캡션·중첩을 만들었느냐에 따라 글자가 한쪽에서만
 * 사라졌다(gwd-info-plan: OCR 이 "[표 Ⅱ-5]"를 "[표 1-5]"로 읽자 캡션 패턴에 걸려 줄이 통째로
 * 비교에서 빠짐 — 실측). 이미지 블록(text = "image_001.png" 파일 참조)은 문서 글자가 아니라
 * v2 에서 뺀다 — 코퍼스 GT 에 219개(≈2.8천 자)가 PDF 경로 양쪽에 똑같이 들어가 분모를
 * 부풀리고, 이미지 입력 경로(ocr-robust)엔 아예 없어 한쪽 누락으로 잡혔다.
 */
export function blockTexts(blocks, { v1 = false } = {}) {
  const out = []
  const walk = (list) => {
    for (const b of list ?? []) {
      if (b.type === "table" && b.table) {
        if (!v1 && b.table.caption) out.push(b.table.caption)
        const { rows, cols, cells } = b.table
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const cell = cells[r]?.[c]
          if (cell?.text) out.push(cell.text)
        }
      } else if (b.text && (v1 || b.type !== "image")) out.push(b.text)
      if (!v1 && b.children?.length) walk(b.children)
    }
  }
  walk(blocks)
  return out
}

/** 문단 text 안의 마크다운 표 → 셀 글자만 (구분행 제거, 이스케이프 해제) */
export function stripMarkdownTable(text) {
  const lines = text.split("\n")
  if (!lines.some(l => /^\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l.trim()))) return text
  return lines
    .filter(l => !/^\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l.trim()))
    .map(l => {
      const t = l.trim()
      if (!t.startsWith("|") || !t.endsWith("|")) return l
      return t.slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|")).join(" ")
    })
    .join("\n")
}

/** 조각 목록 → v2 비교 문자열 (마크업은 조각마다 — 마크다운 표는 줄 단위라 이어 붙이기 전에 걷어야 한다) */
export const fairText = (segs) => normFair(segs.map(stripMarkup).join(" "))

/** 서식·링크 마크업 제거 (문서 글자 아님) */
export function stripMarkup(text) {
  return stripMarkdownTable(text)
    .replace(/\[([^\[\]]*)\]\((?:https?:|mailto:|tel:|#)[^)\s]*\)/gi, "$1")
    .replace(/<\/?u>/g, "")
    .replace(/~~/g, "")
}

const DOTS = /[\u00b7\u2024\u2027\u2219\u22c5\u30fb\uff65\u318d\u119e]/g
/** 픽셀로 구별 불가한 코드포인트 접기 */
export function foldConfusables(s) {
  return s
    .replace(DOTS, "\u00b7")
    .replace(/[\u2160-\u217f\uff01-\uff5e]/g, c => c.normalize("NFKC"))
    .replace(/[\u223c\u301c]/g, "~")
    .replace(/\u2015/g, "\u2014")
}

/** v1 — 종전 ocr-accuracy 정규화 그대로 */
export const normStrict = (s) => s.normalize("NFC").replace(/[·.․‥…]{3,}/g, "").replace(/\s+/g, "")

/** v2 — 혼동 글리프·리더 비대칭 제거 (헤더 주석 참조). 마크업은 조각 단위로 fairText 가 먼저 걷는다 */
export function normFair(s) {
  return foldConfusables(s.normalize("NFC"))
    .replace(/[\u2026\u22ef]/g, "...")
    .replace(/\u2025/g, "..")
    .replace(/\s+/g, "")
    .replace(/[\u00b7.]{3,}/g, "")
}

export const hangulOnly = (s) => s.replace(/[^가-힣]/g, "")

/** 문자 multiset 대조 — 읽기 순서와 무관한 인식률 */
export function charBagPR(gt, hyp) {
  const bag = new Map()
  for (const ch of gt) bag.set(ch, (bag.get(ch) ?? 0) + 1)
  let hit = 0
  for (const ch of hyp) {
    const n = bag.get(ch) ?? 0
    if (n > 0) { bag.set(ch, n - 1); hit++ }
  }
  return { hit, recall: gt.length ? hit / gt.length : 1, precision: hyp.length ? hit / hyp.length : 1 }
}

/** 문자 편집거리 (two-row DP) */
export function editDistance(a, b) {
  if (a === b) return 0
  const n = a.length, m = b.length
  if (!n || !m) return Math.max(n, m)
  let prev = new Uint32Array(m + 1), cur = new Uint32Array(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j
  for (let i = 1; i <= n; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= m; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[m]
}

const WIDE = /[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

/**
 * 래스터 글자 검사 — 텍스트층 글자(문자·숫자) 중심 주변에 대비(최대-최소 휘도 ≥ 60)가 있는
 * 비율. 래스터가 텍스트층을 실제로 그렸는지의 OCR 무관 객관 신호: 비내장 글꼴을 pdfium 이
 * 대체하지 못하면 한글이 통째로 안 그려진다(코퍼스 82쪽 실측: nanet-seoul-minutes 0.088/0.071, 나머지 ≥ 0.971).
 * 그런 페이지는 OCR 정확도의 표본이 아니다.
 * @returns page → 비율 (글자 없으면 1)
 */
export async function rasterGlyphCoverage(raw, pages, scale = 2) {
  const { createRequire } = await import("node:module")
  const { dirname, join } = await import("node:path")
  const require = createRequire(import.meta.url)
  const pkgDir = dirname(require.resolve("pdfjs-dist/package.json"))
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const { PDFiumLibrary } = await import("@hyzyla/pdfium")
  const doc = await getDocument({
    data: new Uint8Array(raw), useSystemFonts: true, disableFontFace: true, isEvalSupported: false,
    cMapUrl: join(pkgDir, "cmaps") + "/", cMapPacked: true, standardFontDataUrl: join(pkgDir, "standard_fonts") + "/",
  }).promise
  const lib = await PDFiumLibrary.init()
  const fdoc = await lib.loadDocument(new Uint8Array(raw))
  const out = new Map()
  try {
    for (const p of fdoc.pages()) {
      const pn = p.number + 1
      if (!pages.includes(pn)) continue
      const page = await doc.getPage(pn)
      const vpH = page.getViewport({ scale: 1 }).height
      const tc = await page.getTextContent()
      const r = await p.render({ scale, colorSpace: "Gray", render: async ({ data }) => data })
      const W = r.width, H = r.height, px = r.data
      const bpp = px.length / (W * H) // Gray = 1, 방어적으로 BGRA 도 허용
      const lum = (x, y) => px[(y * W + x) * bpp]
      let n = 0, ok = 0
      for (const it of tc.items) {
        if (typeof it.str !== "string" || !it.str.trim()) continue
        const [, b, c, d, e, f] = it.transform
        if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3) continue
        const fs = Math.abs(d)
        if (fs <= 0 || it.width <= 0) continue
        const s = [...it.str]
        const wts = s.map(ch => ch === " " ? 0.3 : WIDE.test(ch) ? 1 : 0.55)
        const tot = wts.reduce((x, y) => x + y, 0)
        let acc = 0
        for (let i = 0; i < s.length; i++) {
          const cx = (e + (acc + wts[i] / 2) / tot * it.width) * scale
          acc += wts[i]
          if (!/[\p{L}\p{N}]/u.test(s[i])) continue
          const cy = (vpH - f - 0.38 * fs) * scale
          const rad = Math.max(2, Math.round(fs * scale / 3))
          let mn = 255, mx = 0
          for (let y = Math.max(0, Math.round(cy - rad)); y < Math.min(H, Math.round(cy + rad)); y++) {
            for (let x = Math.max(0, Math.round(cx - rad)); x < Math.min(W, Math.round(cx + rad)); x++) {
              const v = lum(x, y); if (v < mn) mn = v; if (v > mx) mx = v
            }
          }
          n++
          if (mx - mn >= 60) ok++
        }
      }
      out.set(pn, n ? ok / n : 1)
    }
  } finally {
    fdoc.destroy()
    lib.destroy()
    await doc.destroy()
  }
  return out
}
