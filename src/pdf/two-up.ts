/**
 * 가로 쪽 두 쪽 모아찍기(2-up) — 서식 두 쪽을 가로 한 면에 나란히 찍은 쪽(행정업무운영 편람 부록 별지 서식)은 왼쪽 쪽을 다 읽고
 * 오른쪽 쪽을 읽는다. 블록은 쪽 위→아래로 서 있어, 오른쪽 서식 표의 윗변이 왼쪽 서식 제목보다 높으면 오른쪽 표가 먼저 나왔다.
 * 가로 쪽이고, 가운데 띠를 가로지르는 블록이 없고(쪽 번호 꼴 제외), 좌우 반쪽에 다 자리 있는 블록이 있고 한쪽이라도 쪽 높이 절반 넘게
 * 내용이 찰 때만 좌 → 우로 다시 선다(오른쪽이 그림 위주인 보도자료 2-up — 그림은 자리가 없다)
 */

import type { IRBlock } from "../types.js"

export function orderTwoUpPage(blocks: IRBlock[], pageWidth: number, pageHeight: number): IRBlock[] {
  if (pageWidth < pageHeight * 1.2 || blocks.length < 2) return blocks
  const mid = pageWidth / 2, tol = pageWidth * 0.01
  const left: IRBlock[] = [], right: IRBlock[] = [], rest: IRBlock[] = []
  // 자리 없는 블록(합친 문단·그림)은 앞 블록과 같은 쪽에 — 첫 블록 앞이면 뒤에 오는 첫 자리 블록 쪽
  let side: IRBlock[] | null = null
  const pending: IRBlock[] = []
  for (const b of blocks) {
    if (!b.bbox) { if (side) side.push(b); else pending.push(b); continue }
    if (b.type === "paragraph" && /^[-–—－\s\d]+$/.test(b.text ?? "")) { rest.push(b); continue }
    if (b.bbox.x + b.bbox.width <= mid + tol) side = left
    else if (b.bbox.x >= mid - tol) side = right
    else return blocks
    if (pending.length) side.push(...pending.splice(0))
    side.push(b)
  }
  if (pending.length) return blocks
  const span = (bs: IRBlock[]) => {
    const boxed = bs.filter(b => b.bbox)
    return boxed.length ? Math.max(...boxed.map(b => b.bbox!.y + b.bbox!.height)) - Math.min(...boxed.map(b => b.bbox!.y)) : 0
  }
  if (!left.some(b => b.bbox) || !right.some(b => b.bbox) || Math.max(span(left), span(right)) < pageHeight * 0.5) return blocks
  return [...left, ...right, ...rest]
}
