/**
 * 분류된 표 ↔ 렌더 region 조인 (#76 Task 6·7). bbox 는 여기서 계산하지 않는다 — #75 의 RenderRegion.sourceId(hp:tbl id) 로 IRTable.sourceId 를 잇는다.
 * HWP5 는 렌더 어댑터가 없어 분류만 되고 regions/crops 는 비며 경고를 남긴다.
 */

import { readFile } from "node:fs/promises"
import { parse } from "../index.js"
import type { IRBlock, IRTable, TableClassificationSummary } from "../types.js"
import type { PageBBox } from "../render/scene.js"
import { renderDocumentToScene } from "../render/document.js"
import { extractRenderedRegions } from "../render/regions.js"
import { detectFormat } from "../detect.js"
import { KordocError, toArrayBuffer } from "../utils.js"
import { collectTableBlocks } from "./classifier.js"

export type TableVisualPolicy = "none" | "non-tabular" | "non-tabular-and-uncertain" | "all"

export interface ExtractTableVisualOptions {
  /** 어떤 분류에 crop 을 만들지 — 기본 non-tabular-and-uncertain. none 이면 분류·region 만 */
  policy?: TableVisualPolicy
  format?: "png" | "jpeg"
  paddingPt?: number
  /** 페이지 래스터 최대 폭 px */
  maxWidthPx?: number
}

export interface ExtractedTableCrop { page: number; bbox: PageBBox; mimeType: "image/png" | "image/jpeg"; data: Buffer }

export interface ExtractedTable {
  /** sourceId(HWPX) 또는 문서 순서 `tbl-N` */
  id: string
  page: number
  table: IRTable
  classification: TableClassificationSummary
  sourceId?: string
  regions: PageBBox[]
  crops: ExtractedTableCrop[]
  /** 표별 경고 — region 미매칭·중복 매칭·HWP5 미지원 */
  warnings: string[]
}

function wantsCrop(kind: TableClassificationSummary["kind"], policy: TableVisualPolicy): boolean {
  if (policy === "none") return false
  if (policy === "all") return true
  if (kind === "non-tabular-layout") return true
  return policy === "non-tabular-and-uncertain" && kind === "uncertain"
}

/** 문서 → 분류된 표 목록(+HWPX 는 region·crop). 정상 parse 는 래스터하지 않는다 — 이 API 만 명시적으로 */
export async function extractTables(input: string | ArrayBuffer | Buffer, options: ExtractTableVisualOptions = {}): Promise<ExtractedTable[]> {
  const policy = options.policy ?? "non-tabular-and-uncertain"
  const buffer = typeof input === "string" ? toArrayBuffer(await readFile(input)) : Buffer.isBuffer(input) ? toArrayBuffer(input) : input
  const parsed = await parse(buffer, { classifyTables: true })
  if (!parsed.success) throw new KordocError(`파싱 실패: ${parsed.error}`)
  const blocks: IRBlock[] = collectTableBlocks(parsed.blocks)
  const out: ExtractedTable[] = blocks.map((b, i) => ({
    id: b.table!.sourceId ?? `tbl-${i + 1}`, page: b.pageNumber ?? 1, table: b.table!, classification: b.table!.classification!,
    sourceId: b.table!.sourceId, regions: [], crops: [], warnings: [],
  }))
  if (out.length === 0) return out
  const format = detectFormat(buffer)
  if (format !== "hwpx") {
    for (const t of out) t.warnings.push(format === "hwp" ? "HWP5 는 레이아웃 렌더 미지원 — region·crop 없음(분류만)" : `${format} 은 렌더 미지원 — region·crop 없음`)
    return out
  }
  // region 조인 — sourceId 1:1. 중복·미매칭은 경고
  let scene
  try { scene = (await renderDocumentToScene(buffer, { reflow: true })).scene } catch (e) {
    for (const t of out) t.warnings.push(`렌더 실패 — region 없음: ${e instanceof Error ? e.message : String(e)}`)
    return out
  }
  const bySource = new Map<string, typeof scene.regions>()
  for (const r of scene.regions) if (r.type === "table" && r.sourceId) (bySource.get(r.sourceId) ?? bySource.set(r.sourceId, []).get(r.sourceId)!).push(r)
  const cropIds = new Set<string>()
  for (const t of out) {
    if (!t.sourceId) { t.warnings.push("sourceId 없음 — region 조인 불가"); continue }
    const hits = bySource.get(t.sourceId) ?? []
    if (hits.length === 0) { t.warnings.push(`렌더 region 미매칭(sourceId ${t.sourceId})`); continue }
    if (hits.length > 1) { t.warnings.push(`렌더 region 중복 매칭(sourceId ${t.sourceId}, ${hits.length}개) — 첫 개체만`) }
    t.regions = hits[0].regions.map(b => ({ ...b }))
    t.page = hits[0].page
    t.table.regions = t.regions.map(b => ({ page: b.page, x: b.x, y: b.y, width: b.width, height: b.height }))
    if (wantsCrop(t.classification.kind, policy)) cropIds.add(hits[0].id)
  }
  if (cropIds.size === 0) return out
  const assets = await extractRenderedRegions(buffer, { types: ["table"], format: options.format, paddingPt: options.paddingPt, maxWidthPx: options.maxWidthPx, reflow: true, filter: r => cropIds.has(r.id) })
  for (const t of out) {
    if (!t.sourceId) continue
    for (const a of assets) if (a.region.sourceId === t.sourceId) t.crops.push({ page: a.page, bbox: a.bbox, mimeType: a.mimeType, data: a.data })
  }
  return out
}
