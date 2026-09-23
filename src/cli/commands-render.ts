/** kordoc CLI 명령 — 렌더 — render·crop·tables·render-worker */

import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, resolve } from "path"
import { parse } from "../index.js"
import { VERSION, toArrayBuffer, sanitizeError, KordocError } from "../utils.js"
import type { Command } from "commander"

export function registerRenderCommands(program: Command): void {
  program
    .command("render <file>")
    .description("레이아웃 보존 렌더 — HWPX·HWP(5.x)를 SVG(기본, HWPX 는 전체 페이지 세로 스택)·HTML·PNG·JPEG·PDF로. 한컴 저장본은 조판 캐시 그대로, 캐시 없는 생성본·편집본은 순수 TS 조판(reflow, 기본 켬) — kordoc render 문서.hwpx -o 문서.svg / --format png --pages 2-4 -d ./pages / --format pdf -o 문서.pdf")
    .option("-o, --output <path>", "출력 경로 (단일 산출: svg 스택·html·pdf·한 쪽 png/jpeg. 기본: <입력>.<확장자>)")
    .option("-d, --out-dir <dir>", "페이지별 산출 디렉토리 (svg/png/jpeg 여러 쪽 → page_001.png …)")
    .option("--format <fmt>", "svg(기본) | html | png | jpeg | pdf")
    .option("--pages <range>", "렌더할 페이지 (1-based: 3 / 1-3 / 1,3,7-9)")
    .option("--max-width <px>", "래스터 최대 폭 px (기본 1400)")
    .option("--title <text>", "HTML/PDF 문서 제목")
    .option("--browser <path>", "PDF 용 Chromium 실행 파일 (기본: PUPPETEER_EXECUTABLE_PATH 또는 자동 탐지)")
    .option("--highlight <terms>", "검색어 형광펜 (쉼표 구분)")
    .option("--no-reflow", "순수 TS 조판 끄기 (조판 캐시 없는 문서가 빈 페이지로 나올 수 있음)")
    .option("--reflow-mode <mode>", "reflow 줄바꿈 모드: keep(어절) | charAll(글자)", "keep")
    .option("--silent", "진행 메시지 숨기기")
    .action(async (file: string, opts) => {
      try {
        const rootOpts = program.opts()
        const output: string | undefined = opts.output ?? rootOpts.output
        const outDir: string | undefined = opts.outDir ?? rootOpts.outDir
        const silent: boolean = opts.silent ?? rootOpts.silent
        // 루트 --format(markdown 기본) 이 서브커맨드 뒤 --format 을 흡수한다(cli-options 회귀) — 기본값이 아니면 그 값을 쓴다
        const fmt: string = opts.format ?? (rootOpts.format && rootOpts.format !== "markdown" ? rootOpts.format : "svg")
        const pages: string | undefined = opts.pages ?? rootOpts.pages
        if (!["svg", "html", "png", "jpeg", "pdf"].includes(fmt)) throw new KordocError(`--format 은 svg|html|png|jpeg|pdf 중 하나: ${fmt}`)
        const highlights = opts.highlight ? String(opts.highlight).split(",") : undefined
        const absPath = resolve(file)
        const stem = file.replace(/\.hwpx?$/i, "")
        if (fmt === "svg" && !outDir && !pages && !/\.hwp$/i.test(absPath)) {
          // 종전 동작(HWPX) — 전체 페이지 세로 스택 SVG 한 파일. HWP5 는 통합 렌더러(페이지별)
          const { renderHwpxToSvg } = await import("../render/index.js")
          const buffer = readFileSync(absPath)
          const result = await renderHwpxToSvg(toArrayBuffer(buffer), { highlights, reflow: opts.reflow, reflowMode: opts.reflowMode })
          const outPath = resolve(output ?? stem + ".svg")
          mkdirSync(dirname(outPath), { recursive: true })
          writeFileSync(outPath, result.svg, "utf-8")
          if (!silent) {
            process.stderr.write(`[kordoc] 렌더 (${result.pageCount}페이지, ${result.width}x${result.height}pt, 텍스트 ${result.stats.texts}·이미지 ${result.stats.images}·표 ${result.stats.tables}) → ${outPath}\n`)
            for (const w of result.warnings) process.stderr.write(`[kordoc] ⚠️ ${w}\n`)
          }
          return
        }
        const { renderDocument } = await import("../render/index.js")
        const { scene, assets } = await renderDocument(absPath, {
          format: fmt as "svg" | "html" | "png" | "jpeg" | "pdf", pages, highlights, reflow: opts.reflow, reflowMode: opts.reflowMode,
          maxWidthPx: opts.maxWidth ? Number(opts.maxWidth) : undefined, title: opts.title, browserExecutablePath: opts.browser,
        })
        const ext = fmt === "jpeg" ? "jpg" : fmt
        const written: string[] = []
        if (fmt === "html" || fmt === "pdf" || (assets.length === 1 && !outDir)) {
          const outPath = resolve(output ?? stem + "." + ext)
          mkdirSync(dirname(outPath), { recursive: true })
          writeFileSync(outPath, assets[0].data)
          written.push(outPath)
        } else {
          if (!outDir) throw new KordocError(`페이지 ${assets.length}장 산출은 --out-dir 이 필요합니다 (한 쪽만 내려면 --pages 로 선택)`)
          mkdirSync(resolve(outDir), { recursive: true })
          for (const a of assets) {
            const outPath = resolve(outDir, `page_${String(a.page).padStart(3, "0")}.${ext}`)
            writeFileSync(outPath, a.data)
            written.push(outPath)
          }
        }
        if (!silent) {
          process.stderr.write(`[kordoc] 렌더 ${fmt} (${scene.pages.length}페이지 중 ${assets.length}건, 텍스트 ${scene.stats.texts}·이미지 ${scene.stats.images}·표 ${scene.stats.tables}·도형 ${scene.stats.shapes}) → ${written.length === 1 ? written[0] : resolve(outDir!)}\n`)
          for (const w of scene.warnings) process.stderr.write(`[kordoc] ⚠️ ${w}\n`)
        }
      } catch (err) {
        // exit(1) 을 바로 부르면 파이프 stderr 가 유실된다 — exitCode 로 정상 종료
        process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command("crop <file>")
    .description("렌더 영역 잘라내기 — 표·이미지·문단·도형을 페이지 이미지에서 crop (HWPX·HWP) — kordoc crop 문서.hwpx --target table -d ./regions")
    .option("-d, --out-dir <dir>", "출력 디렉토리 (필수) — <유형>_<번호>_page_<쪽>.png + regions.json")
    .option("--target <types>", "유형(쉼표): table | image | paragraph | shape", "table")
    .option("--format <fmt>", "png(기본) | jpeg")
    .option("--pages <range>", "대상 페이지 (1-based)")
    .option("--padding <pt>", "bbox 둘레 여백 pt", "0")
    .option("--max-width <px>", "페이지 래스터 최대 폭 px (crop 해상도, 기본 1400)")
    .option("--no-reflow", "순수 TS 조판 끄기")
    .option("--reflow-mode <mode>", "reflow 줄바꿈 모드: keep | charAll", "keep")
    .option("--silent", "진행 메시지 숨기기")
    .action(async (file: string, opts) => {
      try {
        const rootOpts = program.opts()
        const outDir: string | undefined = opts.outDir ?? rootOpts.outDir
        const silent: boolean = opts.silent ?? rootOpts.silent
        const fmt: string = opts.format ?? (rootOpts.format && rootOpts.format !== "markdown" ? rootOpts.format : "png")
        const pages: string | undefined = opts.pages ?? rootOpts.pages
        if (!["png", "jpeg"].includes(fmt)) throw new KordocError(`--format 은 png|jpeg 중 하나: ${fmt}`)
        if (!outDir) throw new KordocError("--out-dir 이 필요합니다 (crop 은 파일 여러 개를 냅니다)")
        const types = String(opts.target).split(",").map((t: string) => t.trim()).filter(Boolean)
        for (const t of types) if (!["table", "image", "paragraph", "shape"].includes(t)) throw new KordocError(`--target 유형 오류: ${t}`)
        const { extractRenderedRegions } = await import("../render/index.js")
        const regions = await extractRenderedRegions(resolve(file), {
          types: types as Array<"table" | "image" | "paragraph" | "shape">, format: fmt as "png" | "jpeg", pages,
          paddingPt: Number(opts.padding) || 0, maxWidthPx: opts.maxWidth ? Number(opts.maxWidth) : undefined, reflow: opts.reflow, reflowMode: opts.reflowMode,
        })
        const dir = resolve(outDir)
        mkdirSync(dir, { recursive: true })
        const ext = fmt === "jpeg" ? "jpg" : "png"
        const manifest = regions.map(r => {
          const name = `${r.region.id.replace("-", "_")}_page_${String(r.page).padStart(3, "0")}.${ext}`
          writeFileSync(resolve(dir, name), r.data)
          return { file: name, id: r.region.id, type: r.region.type, sourceId: r.region.sourceId, parentId: r.region.parentId, page: r.page, bbox: r.bbox, widthPx: r.widthPx, heightPx: r.heightPx }
        })
        writeFileSync(resolve(dir, "regions.json"), JSON.stringify(manifest, null, 2))
        if (!silent) process.stderr.write(`[kordoc] crop ${regions.length}건 (${types.join(",")}) → ${dir}\n`)
      } catch (err) {
        // exit(1) 을 바로 부르면 파이프 stderr 가 유실된다 — exitCode 로 정상 종료
        process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command("tables <file>")
    .description("표 추출·분류 — 의미표/레이아웃(조직도 등)/불확실 분류 JSON + 선택적 시각 crop (HWPX·HWP) — kordoc tables 문서.hwpx --visual non-tabular-and-uncertain -d ./tables")
    .option("-o, --output <path>", "JSON 출력 경로 (기본 stdout; -d 지정 시 <out-dir>/tables.json)")
    .option("-d, --out-dir <dir>", "crop 저장 디렉토리 (--visual 지정 시 필수)")
    .option("--visual <policy>", "crop 대상: none(기본) | non-tabular | non-tabular-and-uncertain | all", "none")
    .option("--crop-format <fmt>", "png(기본) | jpeg", "png")
    .option("--padding <pt>", "crop 여백 pt", "0")
    .option("--cells", "JSON 에 셀 텍스트 격자 포함")
    .option("--silent", "진행 메시지 숨기기")
    .action(async (file: string, opts) => {
      try {
        const rootOpts = program.opts()
        const output: string | undefined = opts.output ?? rootOpts.output
        const outDir: string | undefined = opts.outDir ?? rootOpts.outDir
        const silent: boolean = opts.silent ?? rootOpts.silent
        const policy = String(opts.visual)
        if (!["none", "non-tabular", "non-tabular-and-uncertain", "all"].includes(policy)) throw new KordocError(`--visual 은 none|non-tabular|non-tabular-and-uncertain|all: ${policy}`)
        if (policy !== "none" && !outDir) throw new KordocError("--visual 은 crop 파일을 내므로 --out-dir 이 필요합니다")
        const cropFmt = String(opts.cropFormat)
        if (!["png", "jpeg"].includes(cropFmt)) throw new KordocError(`--crop-format 은 png|jpeg: ${cropFmt}`)
        const { extractTables } = await import("../table/visual.js")
        const tables = await extractTables(resolve(file), { policy: policy as "none" | "non-tabular" | "non-tabular-and-uncertain" | "all", format: cropFmt as "png" | "jpeg", paddingPt: Number(opts.padding) || 0 })
        const dir = outDir ? resolve(outDir) : undefined
        if (dir) mkdirSync(dir, { recursive: true })
        const ext = cropFmt === "jpeg" ? "jpg" : "png"
        const report = tables.map(t => {
          const crops = t.crops.map(c => {
            const name = `${t.id.replace(/[^\w.-]/g, "_")}_page_${String(c.page).padStart(3, "0")}.${ext}`
            if (dir) writeFileSync(resolve(dir, name), c.data)
            return { file: dir ? name : undefined, page: c.page, bbox: c.bbox }
          })
          return {
            id: t.id, sourceId: t.sourceId, page: t.page, classification: t.classification,
            table: { rows: t.table.rows, cols: t.table.cols, hasHeader: t.table.hasHeader, caption: t.table.caption, ...(opts.cells ? { cells: t.table.cells.map(r => r.map(c => c.text)) } : {}) },
            regions: t.regions, crops, warnings: t.warnings,
          }
        })
        const json = JSON.stringify(report, null, 2)
        const jsonPath = output ? resolve(output) : dir ? resolve(dir, "tables.json") : undefined
        if (jsonPath) { mkdirSync(dirname(jsonPath), { recursive: true }); writeFileSync(jsonPath, json + "\n") }
        else process.stdout.write(json + "\n")
        if (!silent) {
          const kinds = report.reduce<Record<string, number>>((m, r) => { m[r.classification.kind] = (m[r.classification.kind] ?? 0) + 1; return m }, {})
          process.stderr.write(`[kordoc] 표 ${report.length}개 (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(", ")}) crop ${report.reduce((n, r) => n + r.crops.length, 0)}건${jsonPath ? ` → ${jsonPath}` : ""}\n`)
        }
      } catch (err) {
        process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command("render-worker")
    .description("persistent 렌더 워커 — stdin NDJSON 요청 → 조판 SVG 파일 출력 (프로세스 유지, 콜드스타트 제거)")
    .action(async () => {
      // 프로토콜(NDJSON, 한 줄=한 요청/응답):
      //  요청 {"id":1,"file":"a.hwpx","out":"a.svg","reflow":true,"highlight":["term"]}
      //  응답 {"id":1,"ok":true,"out":"a.svg","width":..,"height":..,"pageCount":..,"stats":{..},"warnings":[..]}
      //  {"cmd":"quit"} 로 종료. 모듈은 최초 1회만 로드 → 이후 요청은 콜드스타트 없음.
      const { createInterface } = await import("node:readline")
      const { renderHwpxToSvg } = await import("../render/index.js")
      const rl = createInterface({ input: process.stdin })
      const write = (o: unknown): void => void process.stdout.write(JSON.stringify(o) + "\n")
      write({ ready: true, version: VERSION })
      for await (const line of rl) {
        const t = line.trim()
        if (!t) continue
        let req: { id?: number; cmd?: string; file?: string; out?: string; reflow?: boolean; reflowMode?: string; highlight?: string[] }
        // 비JSON 라인도 응답은 낸다 — 무음 삼킴이면 id 대기 클라이언트가 영구 행
        try { req = JSON.parse(t) } catch { write({ ok: false, error: "잘못된 JSON 라인" }); continue }
        if (req === null || typeof req !== "object") { write({ ok: false, error: "JSON 객체가 아닙니다" }); continue }
        if (req.cmd === "quit") { rl.close(); break }
        const id = req.id
        try {
          if (!req.file || !req.out) throw new Error("file·out 필수")
          const buffer = readFileSync(resolve(req.file))
          const result = await renderHwpxToSvg(toArrayBuffer(buffer), {
            highlights: req.highlight, reflow: req.reflow, reflowMode: req.reflowMode as "keep" | "charAll" | undefined,
          })
          const outPath = resolve(req.out)
          mkdirSync(dirname(outPath), { recursive: true })
          writeFileSync(outPath, result.svg, "utf-8")
          write({ id, ok: true, out: outPath, width: result.width, height: result.height, pageCount: result.pageCount, stats: result.stats, warnings: result.warnings })
        } catch (err) {
          write({ id, ok: false, error: sanitizeError(err) })
        }
      }
    })
}
