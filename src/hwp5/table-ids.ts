/**
 * HWP5 표 순번 (#75 Task 7 · #76 조인 키) — 섹션 레코드에서 표 컨트롤(CTRL_HEADER 'tbl ')을 문서(레코드) 순서로
 * 번호 매긴다. 파서(IRTable.sourceId)와 렌더 어댑터(RenderRegion.sourceId)가 **같은 프리패스**로 키를 얻어야
 * 중첩 표·머리말 안 표·깊이 상한으로 한쪽만 건너뛰는 개체가 있어도 번호가 어긋나지 않는다.
 * HWPX 의 `hp:tbl id` 에 해당하며, 형식은 `t{전역 1-based 순번}` (여러 구역은 base 누적).
 */

import { TAG_CTRL_HEADER, type HwpRecord } from "./record.js"

/** "tbl " — LE 저장(" lbt")을 readUInt32LE 로 읽은 BE 상수 (parser.ts CTRL_TBL 과 동일) */
const CTRL_ID_TBL = 0x74626c20

function swap32(id: number): number {
  return (((id & 0xff) << 24) | (((id >>> 8) & 0xff) << 16) | (((id >>> 16) & 0xff) << 8) | ((id >>> 24) & 0xff)) >>> 0
}

export function isHwp5TableCtrl(rec: HwpRecord): boolean {
  if (rec.tagId !== TAG_CTRL_HEADER || rec.data.length < 4) return false
  const id = rec.data.readUInt32LE(0)
  return id === CTRL_ID_TBL || swap32(id) === CTRL_ID_TBL
}

/** 레코드 인덱스(CTRL_HEADER 위치) → sourceId. count 는 이 섹션의 표 수(다음 섹션 base 로 누적) */
export function indexHwp5Tables(records: HwpRecord[], base = 0): { ids: Map<number, string>; count: number } {
  const ids = new Map<number, string>()
  let n = 0
  for (let i = 0; i < records.length; i++) {
    if (isHwp5TableCtrl(records[i])) { n++; ids.set(i, `t${base + n}`) }
  }
  return { ids, count: n }
}
