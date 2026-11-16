// OCR 벤치 공용 (ocr-accuracy·ocr-robust) — 텍스트 추출·정규화·편집거리·래스터 글자 검사.
//
// 정규화는 두 가지를 같이 낸다 (둘 다 GT/OCR 양쪽 동일 적용 — 비대칭 정규화 금지):
//  strict(v1, 종전 그대로): NFC → 점 3개+ 리더 제거 → 공백 제거.
//  fair(v2): v1 에서 "문서 글자가 아닌 것"과 "픽셀로 구별 불가한 코드포인트 차이"만 더 걷는다.
//    1) 마크업: 문단 텍스트 안의 마크다운 표(columns.ts 레거시 다열 경로가 `| a | b |`·`| --- |`
//       를 문단 text 에 넣음 — 코퍼스 GT 에 "|" 1,210자), 링크 [글](url), <u>·~~ 서식 표지
//    2) 혼동 글리프: 가운뎃점 계열(· • ․ ‧ ∙ ⋅ ・ ･ ㆍ ᆞ) → ·, 로마 숫자 Ⅰ~ⅻ → 라틴(NFKC),
//       전각 ASCII(U+FF01~FF5E) → 반각(NFKC), 물결 ∼ 〜 → ~, 가로 막대 ― → —,
//       단위 한 글자 ㎡·㎜·㎏(U+3380~33DF)와 위 첨자 ¹²³ → NFKC ("㎡" 한 글자는 "m²" 두 글자와 같은 모양으로 그려진다).
//       • 는 글꼴마다 · 와 같은 크기로 그려진다(글머리 · 가 글자 높이 0.28~0.32배 — 코퍼스 실측, 정답 • 을 · 로 읽은 문서와 거꾸로인 문서가 다 있다).
//       큰 고리 ◯ 는 ○ 와 크기만 다르고 그 크기도 글꼴 몫이다(속기록 발언자 표지 ◯ 가 다른 문서의 ○ 와 같은 글자 높이로 그려짐).
//       그림자 고리 ❍ 도 ○ 로 — 글꼴에 따라 ○ 가 같은 그림자 고리로 그려진다(장흥 계획 ○ 와 함평·농진청 ❍ 의 획 비대칭이 같음)
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
/** 값 줄 — 숫자·부호·단위 표지(국·시·균·도 재원 표시 포함)만 */
const VALUE_LINE = /^[\d,.\-△▲+%()원천억만국시도균\s]+$/

export function blockTexts(blocks, { v1 = false } = {}) {
  const out = []
  const walk = (list) => {
    for (const b of list ?? []) {
      if (b.type === "table" && b.table) {
        if (!v1 && b.table.caption) out.push(b.table.caption)
        const { rows, cols, cells } = b.table
        for (let r = 0; r < rows; r++) {
          const lines = []
          for (let c = 0; c < cols; c++) lines.push((cells[r]?.[c]?.text ?? "").split("\n").filter(l => l.trim()))
          // v2: 값 칸 둘 이상이 여러 줄로 나란히 쌓인 행은 칸 글을 줄 번호별로 펼친다(첫 줄끼리, 둘째 줄끼리 …). 보이지 않는 칸
          // 경계(한컴 클립)로 갈린 행들을 픽셀만 보는 OCR 은 한 행의 여러 줄 칸으로 읽어, 행 우선 펼침이 두 행 글을 칸마다 섞었다
          // (예산서 "526,657 / 395,010" 값 열). 글이 꺾인 칸만 여러 줄인 행은 그대로 행 우선 (2026-09-28)
          const stacked = !v1 && lines.filter(l => l.length >= 2 && l.every(x => VALUE_LINE.test(x.trim()))).length >= 2
          if (!stacked) { for (let c = 0; c < cols; c++) { const cell = cells[r]?.[c]; if (cell?.text) out.push(cell.text) } continue }
          const depth = Math.max(0, ...lines.map(l => l.length))
          for (let k = 0; k < depth; k++) for (const l of lines) if (l[k]) out.push(l[k])
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
    .replace(/<\/?su[bp]>/g, "")
    .replace(/~~/g, "")
}

const DOTS = /[\u00b7\u2022\u2024\u2027\u2219\u22c5\u30fb\uff65\u318d\u119e]/g
/** 픽셀로 구별 불가한 코드포인트 접기 */
export function foldConfusables(s) {
  return s
    .replace(DOTS, "\u00b7")
    .replace(/[\u2160-\u217f\uff01-\uff5e\uff61-\uff64\u3380-\u33df\u00b2\u00b3\u00b9]/g, c => c.normalize("NFKC"))
    .replace(/[\u223c\u301c]/g, "~")
    .replace(/\u2015/g, "\u2014")
    .replace(/[\u25ef\u274d]/g, "\u25cb")
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
 * @returns page → 비율 (글자 없으면 1). `.hidden` 은 page → 그려지지 않은 글 조각(검사 글자 둘 이상 중 20% 미만에만 잉크 —
 *   흰 글·투명 글·그림에 덮인 글) 목록

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
  out.hidden = new Map()
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
      const hidden = []
      for (const it of tc.items) {
        let ni = 0, oki = 0
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
          n++; ni++
          if (mx - mn >= 60) { ok++; oki++ }
        }
        if (ni >= 2 && oki / ni < 0.2) hidden.push(it.str)
      }
      out.set(pn, n ? ok / n : 1)
      out.hidden.set(pn, hidden)
    }
  } finally {
    fdoc.destroy()
    lib.destroy()
    await doc.destroy()
  }
  return out
}

/**
 * 글줄 안 글자 그림 수 — 글줄 높이(본문 글자 크기 0.4~2배) 그림이 같은 줄 텍스트층 글 조각 사이(양옆 글자 크기 2배 안)에 박힌 것.
 * 괄호·쉼표·글머리를 글자 대신 그림으로 찍은 PDF 는 텍스트층에 그 글자가 없어 정답이 불완전하다(성과관리 시행계획: 쪽마다 9~10개,
 * 코퍼스 나머지 쪽 0~1개). 줄 머리 아이콘(글 조각이 오른쪽에만 있음)은 세지 않는다. rs 는 imageRects 한 쪽 결과
 */
export function inlineGlyphImages(rs) {
  const items = rs.textItems ?? []
  const fsz = items.map(i => i.fs).sort((a, b) => a - b)[items.length >> 1] ?? 10
  let n = 0
  for (const r of rs) {
    const h = r.y2 - r.y1
    if (h > fsz * 2 || h < fsz * 0.4) continue
    const line = items.filter(i => Math.min(i.y2, r.y2) - Math.max(i.y1, r.y1) >= Math.min(h, i.fs) * 0.5)
    if (line.some(i => i.x2 <= r.x1 + fsz * 0.3 && r.x1 - i.x2 <= fsz * 2) && line.some(i => i.x1 >= r.x2 - fsz * 0.3 && i.x1 - r.x2 <= fsz * 2)) n++
  }
  return n
}

/**
 * 그림 영역을 잘라 PNG 로 — rectsByPage 는 쪽 번호 → PDF 사용자 좌표(y 위로) 사각형들. PDF OCR 과 같은 216dpi(3배)로 렌더하고
 * 둘레에 흰 여백 8px 을 둔다 (OCR 채점 v3: 본문 글과 한 블록에 섞인 그림 글을 따로 읽는 데 쓴다)
 */
export async function renderRectPngs(raw, rectsByPage, scale = 3) {
  const { PDFiumLibrary } = await import("@hyzyla/pdfium")
  const sharp = (await import("sharp")).default
  const lib = await PDFiumLibrary.init()
  const fdoc = await lib.loadDocument(new Uint8Array(raw))
  const out = []
  try {
    for (const p of fdoc.pages()) {
      const rs = rectsByPage.get(p.number + 1)
      if (!rs?.length) continue
      const img = await p.render({ scale, colorSpace: "Gray", render: async ({ data }) => data })
      const W = img.width, H = img.height, bpp = img.data.length / (W * H), Hpt = H / scale
      for (const r of rs) {
        const x0 = Math.max(0, Math.floor(r.x1 * scale)), x1 = Math.min(W, Math.ceil(r.x2 * scale))
        const y0 = Math.max(0, Math.floor((Hpt - r.y2) * scale)), y1 = Math.min(H, Math.ceil((Hpt - r.y1) * scale))
        if (x1 - x0 < 4 || y1 - y0 < 4) continue
        const g = Buffer.alloc((x1 - x0) * (y1 - y0))
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[(y - y0) * (x1 - x0) + x - x0] = img.data[(y * W + x) * bpp]
        out.push(await sharp(g, { raw: { width: x1 - x0, height: y1 - y0, channels: 1 } })
          .extend({ top: 8, bottom: 8, left: 8, right: 8, background: "#ffffff" }).withMetadata({ density: scale * 72 }).png().toBuffer())
      }
    }
  } finally {
    fdoc.destroy()
    lib.destroy()
  }
  return out
}

/** 정답 a 에서 OCR b 보다 남는(OCR 이 못 읽은) 글자 가운데 hidden(그려지지 않은 텍스트층 글)에 든 것만 뺀다 */
export function dropExplainedMisses(a, b, hidden) {
  return dropExplainedExtras(b, a, hidden)
}

/** OCR 비교 문자열 b 에서 정답 a 보다 남는 글자 가운데 extra(그림 글) 에 든 것만 뺀다 — 정답 글자와 짝지어질 글자는 건드리지 않는다 */
export function dropExplainedExtras(a, b, extra) {
  const count = (s) => { const m = new Map(); for (const c of s) m.set(c, (m.get(c) ?? 0) + 1); return m }
  const A = count(a), B = count(b), E = count(extra), cut = new Map()
  for (const [c, n] of E) { const k = Math.min(n, (B.get(c) ?? 0) - (A.get(c) ?? 0)); if (k > 0) cut.set(c, k) }
  if (!cut.size) return b
  const chars = [...b]
  for (let i = chars.length - 1; i >= 0; i--) {
    const k = cut.get(chars[i])
    if (k) { cut.set(chars[i], k - 1); chars[i] = "" }
  }
  return chars.join("")
}

/**
 * 쪽마다 그림 배치 사각형(PDF 사용자 좌표, y 위로) — 그리기 명령의 변환 행렬을 따라 그림 단위 정사각형을 옮긴다.
 * OCR 채점에서 텍스트층 글이 하나도 없는 그림 영역 안의 OCR 글(인포그래픽·스캔 삽화)을 가르는 데만 쓴다.
 */
export async function imageRects(raw, pages) {
  const { createRequire } = await import("node:module")
  const { dirname, join } = await import("node:path")
  const require = createRequire(import.meta.url)
  const pkgDir = dirname(require.resolve("pdfjs-dist/package.json"))
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const doc = await getDocument({
    data: new Uint8Array(raw), useSystemFonts: true, disableFontFace: true, isEvalSupported: false,
    cMapUrl: join(pkgDir, "cmaps") + "/", cMapPacked: true, standardFontDataUrl: join(pkgDir, "standard_fonts") + "/",
  }).promise
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
  const out = new Map()
  try {
    for (const pn of pages) {
      const page = await doc.getPage(pn)
      const { fnArray, argsArray } = await page.getOperatorList()
      const rects = []
      let ctm = [1, 0, 0, 1, 0, 0]
      const stack = []
      for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i], a = argsArray[i]
        if (fn === OPS.save) stack.push(ctm)
        else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
        else if (fn === OPS.transform) ctm = mul(ctm, a)
        else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a?.[0]) && a[0].length === 6) ctm = mul(ctm, a[0]) }
        else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
        else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
          const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]]
          const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]]
          rects.push({ x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) })
        }
      }
      // 텍스트층 글자 자리(글 조각 가운데) — 그림 안에 텍스트층 글자가 있는지 가른다
      const tc = await page.getTextContent()
      rects.textPts = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ x: it.transform[4] + (it.width || 0) / 2, y: it.transform[5] + Math.abs(it.transform[3] || it.height || 0) * 0.3 }))
      rects.textItems = tc.items.filter(it => it.str && it.str.trim()).map(it => {
        const fs = Math.abs(it.transform[3] || it.height || 0)
        return { x1: it.transform[4], x2: it.transform[4] + (it.width || 0), y1: it.transform[5], y2: it.transform[5] + fs, fs }
      })
      out.set(pn, rects)
    }
  } finally {
    await doc.destroy()
  }
  return out
}
