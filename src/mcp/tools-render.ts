/** kordoc MCP 도구 — 렌더 — render_document·crop_regions·extract_tables */

import { z } from "zod"
import { writeFile, mkdir } from "fs/promises"
import { dirname, join } from "path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { MAX_FILE_SIZE, safeOutputPath, describeError, readValidatedFile } from "./shared.js"

export function registerRenderTools(server: McpServer): void {
  // ─── 도구: render_document ───────────────────────────

  server.tool(
    "render_document",
    "HWPX·HWP 문서를 실제 조판 그대로 렌더해 PNG/JPEG 이미지로 응답하거나 SVG·HTML·PDF 파일로 저장합니다. generate_document·fill_form·patch_document·place_seal 결과물을 눈으로 확인하는 용도 — 생성/수정 후 이 도구로 렌더해 깨짐·잘림·배치를 검증하고 다시 고치는 루프를 권장합니다. 한컴 저장본(HWPX·HWP 모두)은 조판 캐시로 정확히, AI 생성본(캐시 없음)은 순수 조판 엔진(reflow)으로 렌더되며 후자는 한컴 실조판의 근사입니다 (참고용 미리보기).",
    {
      file_path: z.string().min(1).describe("렌더할 HWPX 또는 HWP(5.x) 파일의 절대 경로"),
      format: z.enum(["png", "jpeg", "svg", "html", "pdf"]).default("png").describe("png/jpeg=이미지로 응답에 직접 반환(output_path 는 선택) / svg·html·pdf=output_path 에 파일 저장(필수). svg 는 pages 미지정 HWPX 면 전체 세로 스택 1파일, 그 외 페이지별 파일. html=자급자족 레이아웃 HTML 1파일, pdf=Chromium 필요"),
      output_path: z.string().min(1).optional().describe("결과 저장 경로 (확장자는 format 과 일치 — .png/.jpg/.svg/.html/.pdf). 페이지별 산출은 _page_NNN 접미"),
      highlights: z.array(z.string().min(1)).optional().describe("형광펜 표시할 검색어 목록 — 채운 값·수정 문구 위치 확인용"),
      reflow_mode: z.enum(["keep", "charAll"]).default("keep").describe("reflow 줄바꿈: keep=어절 단위, charAll=글자 단위"),
      pages: z.string().min(1).optional().describe("페이지 선택(1-based: '3', '1-3', '1,3,7-9') — 지정하면 페이지별 산출(이미지 응답은 최대 8쪽). HWPX png/svg 에서 미지정이면 전체를 세로 스택 1장으로"),
      max_width_px: z.number().int().min(200).max(4000).optional().describe("래스터(png/jpeg) 최대 폭 px — 큰 문서 응답 부피 조절"),
    },
    async ({ file_path, format, output_path, highlights, reflow_mode, pages, max_width_px }) => {
      try {
        const EXT: Record<string, string[]> = { png: [".png"], jpeg: [".jpg", ".jpeg"], svg: [".svg"], html: [".html", ".htm"], pdf: [".pdf"] }
        const needsFile = format === "svg" || format === "html" || format === "pdf"
        if (needsFile && !output_path) {
          return { content: [{ type: "text", text: `format: "${format}" 은 output_path(${EXT[format][0]})가 필수입니다 — 원문은 커서 응답에 직접 담지 않습니다.` }], isError: true }
        }
        const outPath = output_path ? safeOutputPath(output_path, new Set(EXT[format])) : undefined
        const { buffer, resolved } = await readValidatedFile(file_path, MAX_FILE_SIZE, new Set([".hwpx", ".hwp"]))
        const isHwp5 = resolved.toLowerCase().endsWith(".hwp")
        if (!isHwp5 && !pages && (format === "png" || format === "svg")) {
          // 종전 동작(HWPX·pages 미지정): 전 페이지 세로 스택 1장/1파일
          const { renderHwpxToSvg } = await import("../render/index.js")
          // reflow는 조판 캐시가 있으면 무시되므로 항상 켠다 — 한컴본·생성본 모두 커버
          const result = await renderHwpxToSvg(buffer, { highlights, reflow: true, reflowMode: reflow_mode })
          const summary = [
            `렌더 완료: ${result.pageCount}페이지, ${Math.round(result.width)}x${Math.round(result.height)}pt (텍스트 ${result.stats.texts}·이미지 ${result.stats.images}·표 ${result.stats.tables})`,
            ...result.warnings.map(w => `⚠️ ${w}`),
          ]
          if (format === "svg") {
            await mkdir(dirname(outPath!), { recursive: true })
            await writeFile(outPath!, result.svg, "utf-8")
            summary.push(`저장: ${outPath}`)
            return { content: [{ type: "text", text: summary.join("\n") }] }
          }
          const { rasterizeSvg } = await import("../render/rasterize.js")
          const raster = await rasterizeSvg(result.svg, result.width, result.height, max_width_px ? { maxWidthPx: max_width_px } : undefined)
          if (outPath) {
            await mkdir(dirname(outPath), { recursive: true })
            await writeFile(outPath, raster.png)
            summary.push(`저장: ${outPath}`)
          }
          summary.push(`이미지 ${raster.widthPx}x${raster.heightPx}px — 잘림·겹침·빈칸·페이지 넘침이 보이면 원인 텍스트를 수정해 다시 생성/패치하세요.`)
          return {
            content: [
              { type: "image", data: raster.png.toString("base64"), mimeType: "image/png" },
              { type: "text", text: summary.join("\n") },
            ],
          }
        }
        // 통합 렌더러(renderDocument) — 페이지별 산출. HWP5 는 항상 이 경로
        const { renderDocument } = await import("../render/index.js")
        const { scene, assets } = await renderDocument(buffer, { format, pages, highlights, reflow: true, reflowMode: reflow_mode, maxWidthPx: max_width_px })
        const summary = [
          `렌더 완료: 문서 ${scene.pages.length}페이지 중 ${assets.filter(a => a.page !== undefined).length || 1}건 (텍스트 ${scene.stats.texts}·이미지 ${scene.stats.images}·표 ${scene.stats.tables}·도형 ${scene.stats.shapes})`,
          ...scene.warnings.map(w => `⚠️ ${w}`),
        ]
        const suffixed = (p: string, page: number) => p.replace(/(\.[^.]+)$/, `_page_${String(page).padStart(3, "0")}$1`)
        if (outPath) {
          await mkdir(dirname(outPath), { recursive: true })
          for (const a of assets) {
            const p = a.page === undefined || assets.length === 1 ? outPath : suffixed(outPath, a.page)
            await writeFile(p, a.data as Buffer | string)
            summary.push(`저장: ${p}`)
          }
        }
        if (format === "png" || format === "jpeg") {
          const MAX_PAGES = 8
          const shown = assets.slice(0, MAX_PAGES)
          if (assets.length > MAX_PAGES) summary.push(`⚠️ ${MAX_PAGES}쪽까지만 응답에 담았습니다 — pages 를 좁히세요`)
          return {
            content: [
              ...shown.map(a => ({ type: "image" as const, data: (a.data as Buffer).toString("base64"), mimeType: format === "jpeg" ? "image/jpeg" : "image/png" })),
              { type: "text", text: summary.join("\n") },
            ],
          }
        }
        return { content: [{ type: "text", text: summary.join("\n") }] }
      } catch (err) {
        return {
          content: [{ type: "text", text: `렌더 실패: ${describeError(err)}` }],
          isError: true,
        }
      }
    },
  )

  // ─── 도구: crop_regions ──────────────────────────────

  server.tool(
    "crop_regions",
    "HWPX·HWP 문서를 렌더해 표·이미지·문단·도형 영역을 페이지 이미지에서 잘라 파일로 저장합니다(render_document 와 같은 조판 엔진, 페이지 로컬 pt bbox 를 실배율로 환산). 표가 진짜 데이터표인지 조직도인지는 판단하지 않습니다(그건 extract_tables) — 렌더러가 아는 개체를 자를 뿐. 결과: output_dir/<유형>_<번호>_page_<쪽>.png + regions.json(id·유형·페이지·bbox pt).",
    {
      file_path: z.string().min(1).describe("HWPX 또는 HWP(5.x) 파일 절대 경로"),
      output_dir: z.string().min(1).describe("crop 파일 저장 디렉토리"),
      target: z.array(z.enum(["table", "image", "paragraph", "shape"])).default(["table"]).describe("잘라낼 개체 유형"),
      format: z.enum(["png", "jpeg"]).default("png"),
      pages: z.string().min(1).optional().describe("대상 페이지(1-based 범위)"),
      padding_pt: z.number().min(0).max(100).default(0).describe("bbox 둘레 여백 pt"),
    },
    async ({ file_path, output_dir, target, format, pages, padding_pt }) => {
      try {
        const { buffer } = await readValidatedFile(file_path, MAX_FILE_SIZE, new Set([".hwpx", ".hwp"]))
        const dir = safeOutputPath(join(output_dir, "regions.json"), new Set([".json"])).replace(/[\\/]regions\.json$/, "")
        const { extractRenderedRegions } = await import("../render/index.js")
        const regions = await extractRenderedRegions(buffer, { types: target, format, pages, paddingPt: padding_pt, reflow: true })
        await mkdir(dir, { recursive: true })
        const ext = format === "jpeg" ? "jpg" : "png"
        const manifest = []
        for (const r of regions) {
          const name = `${r.region.id.replace("-", "_")}_page_${String(r.page).padStart(3, "0")}.${ext}`
          await writeFile(join(dir, name), r.data)
          manifest.push({ file: name, id: r.region.id, type: r.region.type, sourceId: r.region.sourceId, parentId: r.region.parentId, page: r.page, bbox: r.bbox, widthPx: r.widthPx, heightPx: r.heightPx })
        }
        await writeFile(join(dir, "regions.json"), JSON.stringify(manifest, null, 2))
        return { content: [{ type: "text", text: `crop ${regions.length}건 → ${dir}\n` + manifest.map(m => `${m.file}  p${m.page} (${m.bbox.x},${m.bbox.y} ${m.bbox.width}×${m.bbox.height}pt)${m.sourceId ? ` src=${m.sourceId}` : ""}`).join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text", text: `crop 실패: ${describeError(err)}` }], isError: true }
      }
    },
  )

  // ─── 도구: extract_tables ────────────────────────────

  server.tool(
    "extract_tables",
    "HWPX·HWP 문서의 표를 추출·분류합니다(#76). 표마다 semantic-table(데이터표) / non-tabular-layout(조직도·연락망·결재란처럼 표를 캔버스로 쓴 것) / uncertain 분류와 근거 신호, 페이지·bbox(pt, 렌더 region 조인), 정책(visual)에 따른 crop 이미지를 돌려줍니다 — 조직도는 이미지로, 데이터표는 셀 구조로 넘기는 멀티모달 파이프라인용. 휴리스틱(네트워크·LLM 없음), 중첩표도 독립 분류. crop 은 output_dir 에 저장하고 8장까지 응답에 함께 담습니다.",
    {
      file_path: z.string().min(1).describe("HWPX 또는 HWP(5.x) 파일 절대 경로"),
      output_dir: z.string().min(1).optional().describe("crop 파일·tables.json 저장 디렉토리 (visual 이 none 이 아니면 필수)"),
      visual: z.enum(["none", "non-tabular", "non-tabular-and-uncertain", "all"]).default("none").describe("crop 대상: none=분류·bbox 만 / non-tabular=조직도류만 / non-tabular-and-uncertain(권장) / all"),
      format: z.enum(["png", "jpeg"]).default("png"),
      padding_pt: z.number().min(0).max(100).default(0).describe("crop 둘레 여백 pt"),
      cells: z.boolean().default(false).describe("응답 JSON 에 셀 텍스트 격자 포함"),
    },
    async ({ file_path, output_dir, visual, format, padding_pt, cells }) => {
      try {
        if (visual !== "none" && !output_dir) {
          return { content: [{ type: "text", text: "visual 이 none 이 아니면 crop 파일을 저장할 output_dir 이 필요합니다." }], isError: true }
        }
        const { buffer } = await readValidatedFile(file_path, MAX_FILE_SIZE, new Set([".hwpx", ".hwp"]))
        const dir = output_dir ? safeOutputPath(join(output_dir, "tables.json"), new Set([".json"])).replace(/[\\/]tables\.json$/, "") : undefined
        const { extractTables } = await import("../table/visual.js")
        const tables = await extractTables(buffer, { policy: visual, format, paddingPt: padding_pt })
        if (dir) await mkdir(dir, { recursive: true })
        const ext = format === "jpeg" ? "jpg" : "png"
        const images: Array<{ type: "image"; data: string; mimeType: string }> = []
        const report = []
        for (const t of tables) {
          const crops = []
          for (const c of t.crops) {
            const name = `${t.id.replace(/[^\w.-]/g, "_")}_page_${String(c.page).padStart(3, "0")}.${ext}`
            if (dir) await writeFile(join(dir, name), c.data)
            if (images.length < 8) images.push({ type: "image", data: c.data.toString("base64"), mimeType: c.mimeType })
            crops.push({ file: dir ? name : undefined, page: c.page, bbox: c.bbox })
          }
          report.push({
            id: t.id, sourceId: t.sourceId, page: t.page, classification: t.classification,
            table: { rows: t.table.rows, cols: t.table.cols, hasHeader: t.table.hasHeader, caption: t.table.caption, ...(cells ? { cells: t.table.cells.map(r => r.map(c => c.text)) } : {}) },
            regions: t.regions, crops, warnings: t.warnings,
          })
        }
        const json = JSON.stringify(report, null, 2)
        if (dir) await writeFile(join(dir, "tables.json"), json + "\n")
        const kinds = report.reduce<Record<string, number>>((m, r) => { m[r.classification.kind] = (m[r.classification.kind] ?? 0) + 1; return m }, {})
        const head = `표 ${report.length}개 (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(", ") || "없음"}) crop ${report.reduce((n, r) => n + r.crops.length, 0)}건${dir ? ` → ${dir}` : ""}${images.length < report.reduce((n, r) => n + r.crops.length, 0) ? " (응답에는 8장까지)" : ""}`
        return { content: [...images, { type: "text", text: `${head}\n${json}` }] }
      } catch (err) {
        return { content: [{ type: "text", text: `표 추출 실패: ${describeError(err)}` }], isError: true }
      }
    },
  )
}
