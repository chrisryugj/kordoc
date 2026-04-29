/**
 * Print Renderer — Markdown / IRBlock[] → PDF (puppeteer-core 기반).
 *
 * 흐름:
 *   blocks → markdown (blocksToMarkdown)
 *   markdown → HTML (markdown-it)
 *   HTML + 프리셋 CSS → PDF (puppeteer-core)
 *
 * puppeteer-core는 optional peer dep. 미설치 시 markdownToPdf는 명확한 에러를 던지지만
 * `renderHtml()`은 항상 동작 (외부 PDF 엔진과 결합용).
 *
 * 참조: docs/SPEC.md §1.3
 */

import { existsSync } from "fs"
import MarkdownIt from "markdown-it"
import type { IRBlock } from "../types.js"
import { blocksToMarkdown } from "../table/builder.js"
import { KordocError } from "../utils.js"

// ─── 타입 ─────────────────────────────────────────

export type PrintPreset = "default" | "gov-formal" | "compact"

export interface PageMargin {
  top: string | number // mm 또는 CSS string ("20mm", "1in")
  right: string | number
  bottom: string | number
  left: string | number
}

export interface PrintOptions {
  preset?: PrintPreset
  pageSize?: "A4" | "Letter"
  orientation?: "portrait" | "landscape"
  margin?: PageMargin
  /** 페이지 머리글 (HTML 허용, gov-formal 프리셋에서 자동 표시) */
  header?: string
  /** 페이지 바닥글 (HTML 허용) */
  footer?: string
  /** 워터마크 텍스트 (대각선 회색) */
  watermark?: string
  /** 사용자 정의 추가 CSS */
  extraCss?: string
}

// ─── 프리셋 CSS ───────────────────────────────────

const PRESETS: Record<PrintPreset, string> = {
  default: `
    @page { size: A4; margin: 20mm; }
    body { font-family: 'Pretendard', 'Malgun Gothic', '맑은 고딕', sans-serif; font-size: 11pt; line-height: 1.6; color: #111; }
    h1 { font-size: 20pt; margin: 1em 0 0.5em; }
    h2 { font-size: 16pt; margin: 1em 0 0.4em; }
    h3 { font-size: 13pt; margin: 0.8em 0 0.3em; }
    p { margin: 0.4em 0; }
    table { border-collapse: collapse; margin: 0.6em 0; width: 100%; }
    th, td { border: 1px solid #555; padding: 4px 8px; text-align: left; vertical-align: top; }
    th { background: #f0f0f0; }
    code { background: #f5f5f5; padding: 1px 4px; border-radius: 2px; font-family: 'D2Coding', Consolas, monospace; }
    pre { background: #f5f5f5; padding: 8px; border-radius: 4px; overflow-x: auto; }
    blockquote { border-left: 3px solid #ccc; padding-left: 12px; color: #555; margin: 0.6em 0; }
    img { max-width: 100%; }
  `,
  "gov-formal": `
    @page { size: A4; margin: 25mm 20mm; }
    body { font-family: '함초롬바탕', 'HCR Batang', 'Batang', 'Malgun Gothic', serif; font-size: 11pt; line-height: 1.7; color: #000; }
    h1 { font-size: 18pt; text-align: center; margin: 0.5em 0 1em; letter-spacing: 0.05em; }
    h2 { font-size: 14pt; margin: 1em 0 0.4em; border-bottom: 1px solid #999; padding-bottom: 2px; }
    h3 { font-size: 12pt; margin: 0.8em 0 0.3em; }
    p { margin: 0.3em 0; text-indent: 1em; }
    table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
    th, td { border: 1px solid #000; padding: 5px 8px; vertical-align: top; }
    th { background: #e8e8e8; font-weight: normal; }
    blockquote { border-left: 2px solid #555; padding-left: 12px; margin: 0.6em 0; }
  `,
  compact: `
    @page { size: A4; margin: 10mm; }
    body { font-family: 'Pretendard', 'Malgun Gothic', sans-serif; font-size: 9pt; line-height: 1.4; color: #111; }
    h1 { font-size: 14pt; margin: 0.5em 0 0.3em; }
    h2 { font-size: 12pt; margin: 0.5em 0 0.3em; }
    h3 { font-size: 10pt; margin: 0.4em 0 0.2em; }
    p { margin: 0.2em 0; }
    table { border-collapse: collapse; margin: 0.3em 0; width: 100%; font-size: 8pt; }
    th, td { border: 1px solid #777; padding: 2px 4px; }
    th { background: #f0f0f0; }
  `,
}

// ─── HTML 생성 ─────────────────────────────────

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
})

/**
 * Markdown 또는 IRBlock[] → HTML 문자열.
 * 외부 PDF 엔진(weasyprint, wkhtmltopdf 등)과 결합 가능.
 */
export function renderHtml(
  markdown: string,
  options?: PrintOptions,
): string {
  const preset = options?.preset ?? "default"
  const css = PRESETS[preset] + (options?.extraCss ?? "")
  const body = md.render(markdown)

  const watermark = options?.watermark
    ? `<div class="watermark">${escapeHtml(options.watermark)}</div>`
    : ""
  const watermarkCss = options?.watermark
    ? `
    .watermark {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) rotate(-30deg);
      font-size: 80pt;
      color: rgba(0,0,0,0.08);
      pointer-events: none;
      z-index: 9999;
      white-space: nowrap;
    }`
    : ""

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<style>${css}${watermarkCss}</style>
</head>
<body>
${watermark}
${body}
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// ─── PDF 생성 ─────────────────────────────────

/**
 * puppeteer-core로 HTML → PDF 변환.
 * 환경에 Chromium 실행 파일 필요 (PUPPETEER_EXECUTABLE_PATH 환경변수 또는 자동 감지).
 */
async function htmlToPdf(html: string, options?: PrintOptions): Promise<Buffer> {
  let puppeteer: typeof import("puppeteer-core")
  try {
    puppeteer = await import("puppeteer-core")
  } catch {
    throw new KordocError(
      "PDF 생성에 puppeteer-core가 필요합니다. 설치: npm install puppeteer-core",
    )
  }

  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ?? findChromiumPath()
  if (!executablePath) {
    throw new KordocError(
      "Chromium 실행 파일을 찾을 수 없습니다. PUPPETEER_EXECUTABLE_PATH 환경변수를 설정하세요.",
    )
  }

  const browser = await puppeteer.default.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })

  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: "networkidle0" })

    const margin = options?.margin
    const pdf = await page.pdf({
      format: options?.pageSize ?? "A4",
      landscape: options?.orientation === "landscape",
      printBackground: true,
      margin: margin
        ? {
            top: toCss(margin.top),
            right: toCss(margin.right),
            bottom: toCss(margin.bottom),
            left: toCss(margin.left),
          }
        : undefined,
      displayHeaderFooter: !!(options?.header || options?.footer),
      headerTemplate: options?.header ?? "<div></div>",
      footerTemplate:
        options?.footer ??
        '<div style="font-size:8pt;width:100%;text-align:center;color:#777;"><span class="pageNumber"></span>/<span class="totalPages"></span></div>',
    })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}

function toCss(v: string | number): string {
  return typeof v === "number" ? `${v}mm` : v
}

/** Windows/Mac/Linux의 일반적 Chrome 경로 자동 감지 */
function findChromiumPath(): string | null {
  // 사용자가 명시 안 했으면 OS 표준 경로 시도
  // Windows
  const win = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ]
  // Mac
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ]
  // Linux
  const linux = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]

  const candidates =
    process.platform === "win32" ? win : process.platform === "darwin" ? mac : linux

  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

/** Markdown → PDF (Buffer). */
export async function markdownToPdf(
  markdown: string,
  options?: PrintOptions,
): Promise<Buffer> {
  const html = renderHtml(markdown, options)
  return htmlToPdf(html, options)
}

/** IRBlock[] → PDF (Buffer). */
export async function blocksToPdf(
  blocks: IRBlock[],
  options?: PrintOptions,
): Promise<Buffer> {
  const markdown = blocksToMarkdown(blocks)
  return markdownToPdf(markdown, options)
}
