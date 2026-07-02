/**
 * 수식 OCR 통합 (optional)
 *
 * 페이지 이미지 렌더 후 수식만 검출/인식해 blocks 에 formula paragraph 를 삽입.
 * 모델은 최초 실행 시 자동 다운로드 (./formula/index.js 에 위임).
 */

import type { IRBlock, ParseWarning } from "../types.js"

/**
 * 수식 OCR 을 적용하여 blocks 에 formula paragraph 를 삽입한다.
 *
 * 좌표 매핑:
 *   - pdfium 픽셀 bbox (top-left origin) → PDF 포인트 (bottom-left origin) 변환
 *   - 수식 bbox 의 y center 와 같은 페이지 내 pdfjs block 의 y center 비교로 삽입 위치 결정
 *   - pdfjs 가 이미 뽑은 수식 흔적(block) 과 겹치면 해당 block 제거 (중복 방지)
 *
 * 실패/trivial 수식(latex === "") 은 삽입하지 않는다.
 */
export async function applyFormulaOcr(
  buffer: ArrayBuffer,
  blocks: IRBlock[],
  pageFilter: Set<number> | null,
  effectivePageCount: number,
  warnings: ParseWarning[],
  _onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const formulaMod = await import("./formula/index.js")
  const { FormulaPipeline, ensureFormulaModels } = formulaMod

  // 모델 준비 — 없으면 자동 다운로드. 진행률은 stderr 로 출력.
  await ensureFormulaModels((p) => {
    if (p.phase === "download" && p.total) {
      const pct = Math.floor((p.downloaded / p.total) * 100)
      process.stderr.write(`\r[kordoc-formula] ${p.spec.name} ${pct}% (${formatMb(p.downloaded)}/${formatMb(p.total)})`)
      if (p.downloaded >= p.total) process.stderr.write("\n")
    } else if (p.phase === "verify") {
      process.stderr.write(`[kordoc-formula] ${p.spec.name} SHA-256 검증 중...\n`)
    } else if (p.phase === "done") {
      process.stderr.write(`[kordoc-formula] ${p.spec.name} 준비 완료\n`)
    } else if (p.phase === "skip") {
      // 조용히 스킵
    }
  })

  const pipeline = await FormulaPipeline.create()
  try {
    const pagesResult = await pipeline.runOnBuffer(buffer, pageFilter)

    if (pagesResult.length === 0) return

    let insertedCount = 0
    let removedDupCount = 0

    for (const page of pagesResult) {
      const pageNumber = page.pageNumber
      const pdfHeight = page.pdfHeight
      const scaleX = page.renderedWidth > 0 ? page.pdfWidth / page.renderedWidth : 0.5
      const scaleY = page.renderedHeight > 0 ? page.pdfHeight / page.renderedHeight : 0.5

      // 1) 수식 → (PDF 포인트 bbox, latex) 정규화 + trivial 제외
      interface FormulaCandidate {
        block: IRBlock
        pdfBbox: { x1: number; x2: number; yTop: number; yBottom: number }
        centerY: number // PDF bottom-up
      }
      const candidates: FormulaCandidate[] = []
      for (const r of page.regions) {
        if (!r.latex || !r.latex.trim()) continue
        const wrapped = r.kind === "display" ? `$$${r.latex}$$` : `$${r.latex}$`

        const x1 = r.bbox.x1 * scaleX
        const x2 = r.bbox.x2 * scaleX
        // pdfium 픽셀 y → PDF bottom-up
        const yTop = pdfHeight - r.bbox.y1 * scaleY
        const yBottom = pdfHeight - r.bbox.y2 * scaleY
        const centerY = (yTop + yBottom) / 2
        const width = x2 - x1
        const height = yTop - yBottom

        candidates.push({
          block: {
            type: "paragraph",
            text: wrapped,
            pageNumber,
            bbox: { page: pageNumber, x: x1, y: yBottom, width, height },
          },
          pdfBbox: { x1, x2, yTop, yBottom },
          centerY,
        })
      }
      if (candidates.length === 0) continue

      // 2) 같은 페이지의 pdfjs block 중 수식 bbox 와 크게 겹치는 것 제거
      //    (pdfjs 가 수식을 텍스트로 파편 추출한 경우 — overlap ratio ≥ 0.6 이면 중복으로 간주)
      const OVERLAP_THRESHOLD = 0.6
      const indicesToRemove = new Set<number>()
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]
        if (b.pageNumber !== pageNumber) continue
        if (b.type === "table") continue // 표는 건드리지 않음
        if (!b.bbox || b.bbox.width <= 0 || b.bbox.height <= 0) continue
        const blockArea = b.bbox.width * b.bbox.height
        if (blockArea <= 0) continue

        for (const c of candidates) {
          const ox1 = Math.max(b.bbox.x, c.pdfBbox.x1)
          const ox2 = Math.min(b.bbox.x + b.bbox.width, c.pdfBbox.x2)
          const oy1 = Math.max(b.bbox.y, c.pdfBbox.yBottom)
          const oy2 = Math.min(b.bbox.y + b.bbox.height, c.pdfBbox.yTop)
          const interArea = Math.max(0, ox2 - ox1) * Math.max(0, oy2 - oy1)
          if (interArea / blockArea >= OVERLAP_THRESHOLD) {
            indicesToRemove.add(i)
            break
          }
        }
      }

      if (indicesToRemove.size > 0) {
        // 내림차순으로 제거해야 인덱스가 밀리지 않음
        const sorted = [...indicesToRemove].sort((a, b) => b - a)
        for (const idx of sorted) blocks.splice(idx, 1)
        removedDupCount += indicesToRemove.size
      }

      // 3) 각 수식을 y 좌표 기준 적절한 위치에 삽입
      //    수식들을 위→아래(centerY 큰 것부터) 정렬 후, 각 수식마다 현재 blocks 에서
      //    "center y < 수식 center y" 인 첫 블록(= 수식보다 아래) 앞에 삽입.
      candidates.sort((a, b) => b.centerY - a.centerY)

      for (const c of candidates) {
        let insertIdx = -1
        let pageFirstIdx = -1
        let pageLastIdx = -1
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i]
          if (b.pageNumber !== pageNumber) continue
          if (pageFirstIdx === -1) pageFirstIdx = i
          pageLastIdx = i
          if (!b.bbox) continue
          const blockCenter = b.bbox.y + b.bbox.height / 2
          if (blockCenter < c.centerY) {
            insertIdx = i
            break
          }
        }

        if (insertIdx !== -1) {
          blocks.splice(insertIdx, 0, c.block)
        } else if (pageLastIdx !== -1) {
          blocks.splice(pageLastIdx + 1, 0, c.block)
        } else {
          // 해당 페이지에 텍스트 블록 없음 — 맨 끝에 추가
          blocks.push(c.block)
        }
        insertedCount++
      }
    }

    if (insertedCount > 0 || removedDupCount > 0) {
      process.stderr.write(
        `[kordoc-formula] ${insertedCount}개 수식 삽입, ${removedDupCount}개 중복 block 제거 (${pagesResult.length}개 페이지)\n`,
      )
    }
  } finally {
    await pipeline.destroy().catch(() => {})
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
