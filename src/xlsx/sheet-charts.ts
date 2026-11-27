/**
 * XLSX 시트의 차트·SmartArt: 시트 → 그리기 파트(xl/drawings/drawingN.xml) → 차트 파트(xl/charts/chartN.xml)·SmartArt 데이터.
 * 그리기 파트에 놓인 차례대로 표·목록 블록을 만든다. 종전에는 시트 칸 글만 읽고 차트를 버렸다.
 */
import type JSZip from "jszip"
import { DOMParser } from "../xml/dom.js"
import { localName } from "../shared/xml.js"
import { readZipEntry } from "../hwpx/parser-shared.js"
import { parseChartXml, chartBlock, smartArtBlocks } from "../shared/chart-xml.js"
import { stripDtd } from "../utils.js"
import type { IRBlock } from "../types.js"

/** base 파트 기준 상대 경로 → zip 경로("xl/worksheets/sheet1.xml" + "../drawings/drawing1.xml" → "xl/drawings/drawing1.xml") */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1)
  const parts = base.split("/").slice(0, -1)
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop()
    else if (seg && seg !== ".") parts.push(seg)
  }
  return parts.join("/")
}

const relsPathOf = (part: string) => {
  const i = part.lastIndexOf("/")
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`
}

async function readRels(zip: JSZip, part: string): Promise<Array<{ id: string; type: string; target: string }>> {
  const file = zip.file(relsPathOf(part))
  if (!file) return []
  const xml = await readZipEntry(file, "text")
  return [...xml.matchAll(/<Relationship\b[^>]*>/g)].map(m => ({
    id: m[0].match(/\bId="([^"]+)"/)?.[1] ?? "",
    type: m[0].match(/\bType="([^"]+)"/)?.[1] ?? "",
    target: m[0].match(/\bTarget="([^"]+)"/)?.[1] ?? "",
  })).filter(r => r.id && r.target)
}

/** 시트 하나의 차트·SmartArt 블록(pageNumber = 시트 순번) */
export async function sheetChartBlocks(zip: JSZip, sheetPath: string, page: number): Promise<IRBlock[]> {
  const out: IRBlock[] = []
  for (const drawingRel of (await readRels(zip, sheetPath)).filter(r => r.type.endsWith("/drawing"))) {
    const drawingPath = resolvePart(sheetPath, drawingRel.target)
    const drawingFile = zip.file(drawingPath)
    if (!drawingFile) continue
    const rels = new Map((await readRels(zip, drawingPath)).map(r => [r.id, resolvePart(drawingPath, r.target)]))
    const doc = new DOMParser().parseFromString(stripDtd(await readZipEntry(drawingFile, "text")), "text/xml")
    for (const el of [...doc.getElementsByTagName("*")]) {
      const name = localName(el)
      if (name !== "chart" && name !== "relIds") continue
      let id: string | null = null
      for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i]
        if ((name === "chart" && a.localName === "id") || (name === "relIds" && a.localName === "dm")) id = a.value
      }
      const part = id ? rels.get(id) : undefined
      const file = part ? zip.file(part) : null
      if (!file) continue
      try {
        const xml = await readZipEntry(file, "text")
        if (name === "relIds") out.push(...smartArtBlocks(xml, page))
        else {
          const chart = parseChartXml(xml)
          if (chart) out.push(chartBlock(chart, page))
        }
      } catch {
        // 깨진 차트 파트는 건너뛴다 — 시트 표를 막지 않는다
      }
    }
  }
  return out
}
