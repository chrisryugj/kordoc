/**
 * 레이아웃 HTML → PDF (#75 Task 6). 그리기를 다시 구현하지 않고 페이지 SVG 를 담은 HTML 을 Chromium 이 인쇄한다.
 * puppeteer-core 는 optional peer dep, Chromium 은 번들하지 않는다 — 없으면 KordocError(조치 안내).
 */

import { KordocError } from "../utils.js"
import { findChromiumPath } from "../print/renderer.js"

export interface ScenePdfOptions {
  /** Chromium 실행 파일 — 미지정 시 PUPPETEER_EXECUTABLE_PATH → OS 표준 경로 자동 탐지 */
  browserExecutablePath?: string
}

/** 레이아웃 HTML(renderSceneToHtml 산출) → PDF. @page 크기·break-after 는 HTML 의 인쇄 CSS 가 담당 */
export async function renderHtmlToPdf(html: string, options: ScenePdfOptions = {}): Promise<Buffer> {
  let puppeteer: typeof import("puppeteer-core")
  try {
    puppeteer = await import("puppeteer-core")
  } catch {
    throw new KordocError("PDF 렌더에는 puppeteer-core 가 필요합니다 (npm install puppeteer-core). SVG/HTML/PNG 는 Chromium 없이 됩니다")
  }
  const executablePath = options.browserExecutablePath ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? findChromiumPath()
  if (!executablePath) {
    throw new KordocError("Chromium 실행 파일을 찾을 수 없습니다 — browserExecutablePath 옵션 또는 PUPPETEER_EXECUTABLE_PATH 환경변수를 지정하세요")
  }
  const browser = await puppeteer.default.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: "load" })
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}
