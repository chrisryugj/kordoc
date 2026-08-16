/**
 * 페이지별 마크다운 사영 (#68)
 *
 * 문서를 다시 파싱하지 않고 이미 만들어진 `IRBlock.pageNumber` 로만 블록을 갈라
 * 페이지마다 `blocksToMarkdown()` 을 돌린다. 페이지 번호의 신뢰도는 파서가
 * 정하는 것이고(`metadata.pageMode` — "layout" 은 실제 페이지, "section" 은
 * 섹션 근사), 여기서는 그 값을 그대로 존중한다.
 */

import type { IRBlock, PageMarkdown } from "./types.js"
import { blocksToMarkdown } from "./table/builder.js"

/**
 * 블록을 페이지 번호로 묶어 페이지별 마크다운을 만든다.
 *
 * - 어떤 블록에도 페이지 번호가 없으면 `undefined` — 페이지 개념이 없는 포맷에
 *   "전부 1페이지" 같은 없는 사실을 만들어 내지 않는다.
 * - 번호가 없는 블록은 **직전 블록의 페이지로 이어붙인다.** 블록은 읽기 순서라
 *   이게 원문 위치에 가장 가깝고, 무엇보다 어느 페이지에도 안 실려 조용히
 *   사라지는 블록이 생기지 않는다. 선두의 번호 없는 블록은 첫 실번호 페이지로.
 * - 관측된 최소~최대 페이지 사이의 빈 페이지도 항목으로 낸다. 여러 페이지에
 *   걸친 표는 시작 페이지 한 블록이라 중간 페이지가 실제로 비어 있고, 이때
 *   항목을 빼면 소비자가 배열 길이로 페이지 수를 셀 수 없다.
 */
export function blocksToPages(blocks: IRBlock[]): PageMarkdown[] | undefined {
  const firstNumbered = blocks.find(b => typeof b.pageNumber === "number")?.pageNumber
  if (firstNumbered === undefined) return undefined

  const byPage = new Map<number, IRBlock[]>()
  let current = firstNumbered
  for (const block of blocks) {
    if (typeof block.pageNumber === "number") current = block.pageNumber
    const bucket = byPage.get(current)
    if (bucket) bucket.push(block)
    else byPage.set(current, [block])
  }

  const numbers = [...byPage.keys()]
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)

  const pages: PageMarkdown[] = []
  for (let pageNumber = min; pageNumber <= max; pageNumber++) {
    const pageBlocks = byPage.get(pageNumber)
    pages.push({ pageNumber, markdown: pageBlocks ? blocksToMarkdown(pageBlocks) : "" })
  }
  return pages
}
