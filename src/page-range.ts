/** 페이지/섹션 범위 파싱 유틸리티 */

/**
 * 페이지 범위 지정을 1-based Set<number>로 변환.
 *
 * @param spec - [1,2,3] 또는 "1-3" 또는 "1,3,5-7"
 * @param maxPages - 최대 페이지 수 (클램핑 상한)
 * @returns 1-based 페이지 번호 Set
 */
export function parsePageRange(spec: number[] | string, maxPages: number): Set<number> {
  const result = new Set<number>()
  if (maxPages <= 0) return result

  if (Array.isArray(spec)) {
    for (const n of spec) {
      const page = Math.round(n)
      if (page >= 1 && page <= maxPages) result.add(page)
    }
    return result
  }

  if (typeof spec !== "string" || spec.trim() === "") return result

  const parts = spec.split(",")
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
    if (rangeMatch) {
      const start = Math.max(1, parseInt(rangeMatch[1], 10))
      const end = Math.min(maxPages, parseInt(rangeMatch[2], 10))
      for (let i = start; i <= end; i++) result.add(i)
    } else {
      const page = parseInt(trimmed, 10)
      if (!isNaN(page) && page >= 1 && page <= maxPages) result.add(page)
    }
  }

  return result
}

/**
 * 파싱 상한 이후에 실제 문서 범위에 속하는 요청이 있는가. 경고용으로 전체 범위를 Set에 펼치면
 * 페이지 상한을 우회해 거대한 범위만큼 메모리를 쓰므로 구간 교차만 검사한다.
 * 배열의 Math.round, 단일 문자열의 parseInt 등 parsePageRange의 기존 문법은 그대로 유지한다.
 */
export function hasRequestedPagesAfter(spec: number[] | string, maxParsed: number, total: number): boolean {
  if (total <= 0 || total <= maxParsed) return false
  const beyond = (page: number): boolean => page >= 1 && page <= total && page > maxParsed
  if (Array.isArray(spec)) return spec.some(n => beyond(Math.round(n)))
  if (typeof spec !== "string" || spec.trim() === "") return false

  for (const part of spec.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
    if (rangeMatch) {
      const start = Math.max(1, parseInt(rangeMatch[1], 10), Math.floor(maxParsed) + 1)
      const end = Math.min(total, parseInt(rangeMatch[2], 10))
      if (start <= end) return true
    } else if (beyond(parseInt(trimmed, 10))) return true
  }
  return false
}
