/**
 * 공유 렌더 장면(RenderScene) 계약 — HWPX/HWP5 어댑터가 채우고 SVG·HTML·래스터·PDF·crop 이 소비한다 (#75).
 *
 * 좌표 규약: 공개 bbox 는 **pt**, **페이지 로컬**(물리 페이지 좌상단 원점), 페이지 번호 **1-based**.
 * 한 논리 개체가 여러 페이지에 걸치면 `regions` 에 페이지별 조각을 여럿 둔다(세로 스택 전역 좌표 금지).
 * region id 는 같은 문서·같은 옵션이면 결정적 — 그리기(문서) 순서로 유형별 일련번호를 매긴다.
 */

export type RenderSourceFormat = "hwpx" | "hwp"

export type RenderObjectType = "paragraph" | "table" | "image" | "shape" | "equation" | "unknown"

export interface PageBBox {
  /** 1-based 페이지 */
  page: number
  /** pt, 페이지 로컬, 좌상단 원점 */
  x: number
  y: number
  width: number
  height: number
}

export interface RenderRegion {
  /** 결정적 id — `table-000017` 꼴 */
  id: string
  type: RenderObjectType
  /** 첫 조각의 페이지 (편의 필드) */
  page: number
  /** 페이지별 조각 — 한 논리 개체가 여러 물리 페이지에 걸칠 수 있다 */
  regions: PageBBox[]
  /** 원본 식별자(HWPX `hp:tbl id` 등) — 있을 때만 */
  sourceId?: string
  /** 중첩 표·셀 안 이미지·문단 안 개체의 부모 region */
  parentId?: string
}

export interface ScenePage {
  page: number
  /** pt */
  width: number
  height: number
}

export interface RenderScene {
  format: RenderSourceFormat
  pages: ScenePage[]
  regions: RenderRegion[]
  warnings: string[]
  stats: { texts: number; tables: number; images: number; shapes: number }
}

/** 유형별 일련번호 → 결정적 id (`table-000017`). seq 는 1-based */
export function regionId(type: RenderObjectType, seq: number): string {
  return `${type}-${String(seq).padStart(6, "0")}`
}

/** 두 bbox 의 합집합 (같은 페이지 가정) */
export function unionBBox(a: PageBBox, b: PageBBox): PageBBox {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { page: a.page, x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

/**
 * region 수집기 — 어댑터가 그리는 순서대로 `add()` 하면 유형별 카운터로 id 를 발급한다.
 * 같은 논리 개체의 추가 페이지 조각은 `addFragment()`.
 */
export class RegionCollector {
  readonly regions: RenderRegion[] = []
  private readonly counters = new Map<RenderObjectType, number>()

  add(type: RenderObjectType, bbox: PageBBox, extra: { sourceId?: string; parentId?: string } = {}): string {
    const seq = (this.counters.get(type) ?? 0) + 1
    this.counters.set(type, seq)
    const id = regionId(type, seq)
    const region: RenderRegion = { id, type, page: bbox.page, regions: [bbox] }
    if (extra.sourceId) region.sourceId = extra.sourceId
    if (extra.parentId) region.parentId = extra.parentId
    this.regions.push(region)
    return id
  }

  addFragment(id: string, bbox: PageBBox): void {
    const r = this.regions.find((x) => x.id === id)
    if (!r) return
    // 같은 페이지 조각은 합집합, 다른 페이지면 새 조각
    const same = r.regions.find((f) => f.page === bbox.page)
    if (same) Object.assign(same, unionBBox(same, bbox))
    else r.regions.push(bbox)
  }
}
