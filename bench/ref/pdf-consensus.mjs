// PDF 교차검증 — pdftotext(poppler) + pdfjs raw 의 '합의(consensus)' 3-gram 대비 커버리지.
// 두 추출기가 모두 동의한 내용만 신뢰 기준으로 쓰고(pitfall #12), 읽기 순서는
// 추출기마다 달라 n-gram bag 비교만 수행한다 (순서 비교 금지).

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { normPdf, normText } from "../lib/normalize.mjs"

const execFileP = promisify(execFile)
const PDFTOTEXT_CANDIDATES = ["/opt/homebrew/bin/pdftotext", "pdftotext"]

let pdftotextBin = null
async function resolvePdftotext() {
  if (pdftotextBin !== null) return pdftotextBin
  for (const bin of PDFTOTEXT_CANDIDATES) {
    try {
      await execFileP(bin, ["-v"])
      pdftotextBin = bin
      return bin
    } catch (err) {
      if (err?.stderr?.includes("pdftotext version")) { pdftotextBin = bin; return bin }
    }
  }
  pdftotextBin = false
  return false
}

/** pdftotext — 페이지별 텍스트 (form-feed 구분) */
async function pdftotextPages(filePath) {
  const bin = await resolvePdftotext()
  if (!bin) return null
  try {
    const { stdout } = await execFileP(bin, ["-enc", "UTF-8", "-q", filePath, "-"], {
      maxBuffer: 256 * 1024 * 1024,
    })
    const pages = stdout.split("\f")
    if (pages[pages.length - 1] === "") pages.pop()
    return pages
  } catch {
    return null
  }
}

let pdfjsMod = null
async function loadPdfjs() {
  if (pdfjsMod !== null) return pdfjsMod
  try {
    pdfjsMod = await import("pdfjs-dist/legacy/build/pdf.mjs")
  } catch {
    pdfjsMod = false
  }
  return pdfjsMod
}

// CID 폰트 자산 — 파서와 동일 조건으로 추출해야 참조가 대칭 (없으면 CMap 필요
// 폰트 텍스트가 참조에서도 소실되어 해당 구간이 채점에서 빠진다)
let pdfjsAssets = null
async function resolvePdfjsAssets() {
  if (pdfjsAssets !== null) return pdfjsAssets
  try {
    const { createRequire } = await import("node:module")
    const { dirname, join } = await import("node:path")
    const pkgDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))
    pdfjsAssets = {
      cMapUrl: join(pkgDir, "cmaps") + "/",
      cMapPacked: true,
      standardFontDataUrl: join(pkgDir, "standard_fonts") + "/",
    }
  } catch {
    pdfjsAssets = {}
  }
  return pdfjsAssets
}

/** pdfjs getTextContent raw — 페이지별 텍스트 */
async function pdfjsPages(buffer) {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) return null
  let doc
  try {
    doc = await pdfjs.getDocument({
      // 독립 ArrayBuffer로 복사 — kordoc parse가 원본을 detach해도 안전
      data: Uint8Array.from(buffer),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0,
      ...(await resolvePdfjsAssets()),
    }).promise
  } catch {
    return null
  }
  const pages = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      try {
        const page = await doc.getPage(p)
        const tc = await page.getTextContent()
        pages.push(tc.items.map(it => it.str + (it.hasEOL ? "\n" : " ")).join(""))
        page.cleanup()
      } catch {
        pages.push("")
      }
    }
  } finally {
    await doc.destroy().catch(() => {})
  }
  return pages
}

/**
 * 반복 라인(머리글/바닥글) 제거 (pitfall #13) — 두 갈래:
 * (1) 전 문서 ≥ratio 페이지 반복 정규화 라인 → 위치 무관 제거 (기존)
 * (2) 페이지 가장자리(첫/끝 2개 비어있지 않은 줄) 라인이 ≥3개 페이지에서 반복
 *     → 가장자리 위치의 인스턴스만 제거.
 *     파서의 머리글/바닥글 제거(상하 12% 존 + 3페이지 반복)와 대칭을 맞추기 위한 것 —
 *     챕터별로 바뀌는 러닝헤더는 전 문서 70%에 못 미쳐 (1)이 못 잡는다.
 *     본문 중간의 동일 문구는 남겨서 파서의 본문 오삭제는 계속 감지한다.
 */
function dropRepeatedLines(pages, ratio = 0.7) {
  if (pages.length < 3) return pages
  const norm = l => normText(l).replace(/\d+/g, "#") // 페이지번호 가변부 무시
  const pageLines = pages.map(pg => pg.split("\n"))

  const lineCount = new Map() // 정규화 라인 → 등장 페이지 수 (위치 무관)
  const edgeCount = new Map() // 정규화 라인 → 가장자리 등장 페이지 수
  const edgeIdxSets = []      // 페이지별 가장자리 라인 인덱스
  for (const lines of pageLines) {
    const seen = new Set()
    const nonEmpty = []
    for (let i = 0; i < lines.length; i++) {
      const k = norm(lines[i])
      if (k.length < 2) continue
      nonEmpty.push(i)
      if (!seen.has(k)) { seen.add(k); lineCount.set(k, (lineCount.get(k) ?? 0) + 1) }
    }
    const edgeIdx = new Set([...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)])
    edgeIdxSets.push(edgeIdx)
    const seenEdge = new Set()
    for (const i of edgeIdx) {
      const k = norm(lines[i])
      if (!seenEdge.has(k)) { seenEdge.add(k); edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1) }
    }
  }

  const threshold = Math.ceil(pages.length * ratio)
  const repeatedAll = new Set([...lineCount.entries()].filter(([, n]) => n >= threshold).map(([k]) => k))
  const repeatedEdge = new Set([...edgeCount.entries()].filter(([, n]) => n >= 3).map(([k]) => k))
  if (repeatedAll.size === 0 && repeatedEdge.size === 0) return pages

  return pageLines.map((lines, pi) =>
    lines.filter((l, li) => {
      const k = norm(l)
      if (repeatedAll.has(k)) return false
      if (repeatedEdge.has(k) && edgeIdxSets[pi].has(li)) return false
      return true
    }).join("\n"))
}

/**
 * 문자 3-gram multiset (normPdf 적용 후) — Map<gram, count>
 *
 * perLine: 참조(추출기) 텍스트는 줄 단위로 gram을 계산한다.
 * 줄 경계를 넘는 gram은 문서 내용이 아니라 추출기의 순회 순서(셀 방문 순서,
 * 단 병합 순서)를 인코딩한 것 — 파일 서두의 "순서 비교 금지" 원칙의 잔존 누수였다.
 * (예: pdftotext가 "산출식=" 줄 다음 "16,422" 줄을 붙여 '=16' gram을 만들면
 * 셀 순서가 다른 파서는 내용 손실 없이도 벌점을 받는다.)
 * kordoc 측은 전체 텍스트로 계산 유지 — 초과 gram은 커버리지에 벌점이 없고,
 * 문단 리플로우(참조의 여러 줄 = kordoc 한 줄)를 흡수해야 하므로.
 */
function trigramBag(texts, { perLine = false } = {}) {
  const bag = new Map()
  const chunks = []
  for (const t of texts) {
    if (perLine) {
      // 하이픈 줄바꿈 결합은 줄 분리 전에 (normPdf 내 동일 규칙은 줄 단위에선 no-op)
      chunks.push(...t.replace(/(\S)-[ \t]*\n[ \t]*(?=[a-z가-힣])/g, "$1").split("\n"))
    } else {
      chunks.push(t)
    }
  }
  for (const c of chunks) {
    const s = normPdf(c)
    for (let i = 0; i + 3 <= s.length; i++) {
      const g = s.substr(i, 3)
      bag.set(g, (bag.get(g) ?? 0) + 1)
    }
  }
  return bag
}

function intersectBag(a, b) {
  const out = new Map()
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, n] of small) {
    const m = big.get(k)
    if (m) out.set(k, Math.min(n, m))
  }
  return out
}

const bagSize = bag => { let s = 0; for (const n of bag.values()) s += n; return s }

/**
 * PDF 교차검증 커버리지.
 * @param filePath PDF 경로 (pdftotext용)
 * @param buffer   PDF 버퍼 (pdfjs용)
 * @param kordocPlainText kordoc 마크다운의 평문 (mdToPlain 적용 후)
 * @param needsOcrPages   kordoc pageQuality 기준 OCR 필요 페이지 집합(1-based) — 모수 격리 (pitfall #14)
 */
export async function pdfCrossCoverage(filePath, buffer, kordocPlainText, needsOcrPages = new Set()) {
  const [popplerPages, pdfjsPagesArr] = await Promise.all([
    pdftotextPages(filePath),
    pdfjsPages(buffer),
  ])

  if (!popplerPages && !pdfjsPagesArr) {
    return { status: "no-reference", coverage: null, weak: true }
  }

  const filterOcr = pages =>
    pages ? pages.filter((_, i) => !needsOcrPages.has(i + 1)) : null

  const a = popplerPages ? dropRepeatedLines(filterOcr(popplerPages)) : null
  const b = pdfjsPagesArr ? dropRepeatedLines(filterOcr(pdfjsPagesArr)) : null

  let consensus
  let weak = false
  if (a && b) {
    consensus = intersectBag(trigramBag(a, { perLine: true }), trigramBag(b, { perLine: true }))
  } else {
    consensus = trigramBag(a ?? b, { perLine: true })
    weak = true // 단일 추출기 — 보고만, 게이트 제외
  }

  const consensusSize = bagSize(consensus)
  if (consensusSize < 50) {
    return { status: "tiny-consensus", coverage: null, weak: true, consensusSize }
  }

  const kordocBag = trigramBag([kordocPlainText])
  const covered = bagSize(intersectBag(kordocBag, consensus))
  const coverage = covered / consensusSize

  // 미커버 3-gram 상위 샘플 (디버깅용)
  const missing = []
  for (const [g, n] of consensus) {
    const have = kordocBag.get(g) ?? 0
    if (have < n) missing.push([g, n - have])
  }
  missing.sort((x, y) => y[1] - x[1])

  return {
    status: "ok",
    coverage,
    weak,
    consensusSize,
    coveredSize: covered,
    excludedOcrPages: [...needsOcrPages],
    topMissing: missing.slice(0, 10).map(([g, n]) => `${g}×${n}`),
  }
}
