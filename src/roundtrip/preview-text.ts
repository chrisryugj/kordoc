/**
 * 미리보기 글(HWPX Preview/PrvText.txt · HWP 5.x PrvText) 다시 쓰기 — patch 가 본문을 고친 뒤 고치기 전 글이 미리보기에
 * 남지 않게 한다 (#248). 한글이 저장하는 꼴을 따른다: 문단은 한 줄, 표는 행마다 한 줄에 칸 글을 "<…>" 로 감싼다.
 * 미리보기 그림(PrvImage)은 다시 그릴 수 없어 그대로 두고 호출자가 경고로 알린다.
 */
import type JSZip from "jszip"
import type { IRBlock } from "../types.js"
import { parseHwpxDocument } from "../hwpx/parser.js"
import { readZipEntry } from "../hwpx/parser-shared.js"
import { patchZipEntries } from "./zip-patch.js"

/** 미리보기 그림은 다시 그리지 못한다 — 고치기 전 첫 쪽 그림이 남는다는 것을 알린다 */
export const PREVIEW_IMAGE_NOTE = "미리보기 그림(PrvImage)은 고치기 전 첫 쪽 그림 그대로입니다. 미리보기 글(PrvText)은 고친 본문으로 다시 썼습니다"

/** 한글 미리보기 글 길이 — 앞부분만 싣는다 */
export const PREVIEW_MAX_CHARS = 1024

const plain = (s: string): string => s.replace(/<\/?(?:sup|sub|u)>/g, "").replace(/\\([<$])/g, "$1").replace(/\s+/g, " ").trim()

/** IR 블록 → 미리보기 글 */
export function previewTextFromBlocks(blocks: IRBlock[], max = PREVIEW_MAX_CHARS): string {
  const lines: string[] = []
  let size = 0
  const push = (line: string): boolean => {
    lines.push(line)
    size += line.length + 2
    return size < max
  }
  const walk = (list: IRBlock[], depth: number): boolean => {
    if (depth > 8) return true
    for (const b of list) {
      if (b.type === "table" && b.table) {
        for (const row of b.table.cells) {
          const cells = row.filter(c => c && (c.colSpan > 0 || c.rowSpan > 0)).map(c => `<${plain(c.text ?? "")}>`)
          if (cells.length && !push(cells.join(""))) return false
        }
      } else if (b.type !== "image" && b.type !== "separator" && b.text) {
        if (!push(plain(b.text))) return false
      }
      if (b.children && !walk(b.children, depth + 1)) return false
    }
    return true
  }
  walk(blocks, 0)
  return lines.join("\r\n").slice(0, max)
}

/** 원본 미리보기 글 바이트의 인코딩대로 새 글을 쓴다 — UTF-16LE(BOM 또는 둘째 바이트 0) · 그 밖 UTF-8 */
export function encodePreviewLike(original: Uint8Array, text: string): Uint8Array {
  const utf16 = (original[0] === 0xff && original[1] === 0xfe) || (original.length >= 2 && original[1] === 0 && original[0] !== 0)
  if (!utf16) return new TextEncoder().encode(text)
  const bom = original[0] === 0xff && original[1] === 0xfe
  const body = Buffer.from(text, "utf16le")
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body
}

const PREVIEW_TEXT = "Preview/PrvText.txt"

/**
 * HWPX 패치본(data = original + replacements)의 미리보기 글을 고친 본문으로 다시 쓴 판. 미리보기 글이 없으면 data 그대로.
 * 미리보기 그림이 있으면 warnings 에 알린다 — patch·fill 공용
 */
export async function refreshHwpxPreview(
  zip: JSZip, original: Uint8Array, replacements: Map<string, Uint8Array>, data: Uint8Array, warnings: string[],
): Promise<Uint8Array> {
  if (zip.file(/^Preview\/PrvImage\./i).length) warnings.push(PREVIEW_IMAGE_NOTE)
  const prv = zip.file(PREVIEW_TEXT)
  if (!prv) return data
  const reparsed = await parseHwpxDocument(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
  replacements.set(PREVIEW_TEXT, encodePreviewLike(await readZipEntry(prv, "uint8array"), previewTextFromBlocks(reparsed.blocks)))
  return patchZipEntries(original, replacements)
}
