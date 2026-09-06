/**
 * 레이아웃 보존 HTML — 페이지별 standalone SVG 를 `.kordoc-page[data-page]` 로 감싼 자급자족 문서 (#75 Task 4).
 * 의미 HTML(IRBlock → <h1>/<p>/<table>) 이 아니다 — 원본 조판 재현이 목적. CDN·외부 자원 없음.
 * 인쇄 CSS(@page 크기 = 첫 페이지 크기, 페이지마다 break-after) 를 포함해 PDF 경로가 그대로 소비한다.
 */

import type { RenderScene } from "./scene.js"
import { escapeXml } from "./svg-render.js"

export interface SceneHtmlOptions {
  /** <title> — 기본 "kordoc" */
  title?: string
}

/**
 * @param scene    페이지 크기 메타(전 페이지)
 * @param pageSvgs 페이지 번호 → standalone SVG (선택된 페이지만 있어도 된다 — 있는 페이지만 방출)
 */
export function renderSceneToHtml(scene: RenderScene, pageSvgs: Map<number, string>, options: SceneHtmlOptions = {}): string {
  const title = escapeXml(options.title ?? "kordoc")
  const first = scene.pages.find(p => pageSvgs.has(p.page)) ?? scene.pages[0]
  const pageSize = first ? `${first.width}pt ${first.height}pt` : "auto"
  const pages = [...pageSvgs.keys()].sort((a, b) => a - b).map(n => {
    const meta = scene.pages.find(p => p.page === n)
    const size = meta ? ` style="width:${meta.width}pt;height:${meta.height}pt"` : ""
    return `<div class="kordoc-page" data-page="${n}"${size}>${pageSvgs.get(n)}</div>`
  })
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
html, body { margin: 0; background: #e9e8e6; }
.kordoc-document { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 16px 0; }
.kordoc-page { position: relative; background: white; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
.kordoc-page > svg { display: block; width: 100%; height: 100%; }
@page { size: ${pageSize}; margin: 0; }
@media print {
  html, body { background: white; }
  .kordoc-document { gap: 0; padding: 0; }
  .kordoc-page { box-shadow: none; break-after: page; page-break-after: always; }
  .kordoc-page:last-child { break-after: auto; page-break-after: auto; }
}
</style>
</head>
<body>
<div class="kordoc-document">
${pages.join("\n")}
</div>
</body>
</html>
`
}
