/**
 * HWP3 그리기 개체 트리 워커 (#73) 회귀 테스트.
 *
 * ch=11 확장 블록이 pic_type 3 이면 그림이 아니라 그리기 개체 트리이고, 표지 제목·
 * 순서도 라벨이 그 안 글상자에 들어간다. 종전엔 블록을 통째로 건너뛰어 사라졌다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { collectDrawingTextBoxLists } from "../src/hwp3/drawing.js"

/** 공통 헤더(92바이트) — 선언 길이는 자기 4바이트를 뺀 값이다. */
function commonHeader(objectType: number, connectionInfo: number, surplus = 0): Buffer {
  const buf = Buffer.alloc(92)
  buf.writeUInt32LE(88 + surplus, 0) // header_length
  buf.writeUInt16LE(objectType, 4)
  buf.writeUInt16LE(connectionInfo, 6)
  // 좌표 40 + basic_attr 40 + options 4 는 0 으로 둔다 (회전·그라데이션·비트맵 없음)
  return buf
}

/** 프레임 헤더 — 선언 길이가 고정부(24)와 같으면 하이퍼텍스트 정보가 없다. */
function frameHeader(objectCount = 1, headerLength = 24): Buffer {
  const buf = Buffer.alloc(28)
  buf.writeUInt32LE(headerLength, 0)
  buf.writeUInt32LE(0, 4) // z_order
  buf.writeUInt32LE(objectCount, 8)
  return buf
}

/** 글상자(type 6) 세부 정보: 정보1 길이 + 정보2 길이 + 문단 리스트 */
function textBoxDetails(list: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32LE(0, 0)
  head.writeUInt32LE(list.length, 4)
  return Buffer.concat([head, list])
}

const LIST_A = Buffer.from("문단리스트A", "utf-8")
const LIST_B = Buffer.from("문단리스트B", "utf-8")

describe("collectDrawingTextBoxLists — 글상자 문단 리스트 회수", () => {
  it("글상자 하나의 문단 리스트를 그대로 돌려준다", () => {
    const ext = Buffer.concat([frameHeader(), commonHeader(6, 0), textBoxDetails(LIST_A)])
    assert.deepEqual(collectDrawingTextBoxLists(ext), [LIST_A])
  })

  it("하이퍼텍스트 정보가 붙은 프레임 헤더를 건너뛴다", () => {
    // 선언 길이가 고정부보다 크면 621바이트 하이퍼텍스트 정보가 뒤따른다 (rhwp #2831)
    const ext = Buffer.concat([
      frameHeader(1, 641),
      Buffer.alloc(621),
      commonHeader(6, 0),
      textBoxDetails(LIST_A),
    ])
    assert.deepEqual(collectDrawingTextBoxLists(ext), [LIST_A])
  })

  it("형제 체인(bit0)을 끝까지 따라간다", () => {
    const ext = Buffer.concat([
      frameHeader(2),
      commonHeader(6, 0x01),
      textBoxDetails(LIST_A),
      commonHeader(6, 0x00),
      textBoxDetails(LIST_B),
    ])
    assert.deepEqual(collectDrawingTextBoxLists(ext), [LIST_A, LIST_B])
  })

  it("컨테이너 자식(bit1)으로 내려간다 — 묶음 개체 안 글상자", () => {
    const ext = Buffer.concat([
      frameHeader(1),
      commonHeader(0, 0x02), // 컨테이너, 자식 있음
      Buffer.alloc(8), // 컨테이너도 길이 8바이트를 차지한다 (rhwp #5141)
      commonHeader(6, 0x00),
      textBoxDetails(LIST_A),
    ])
    assert.deepEqual(collectDrawingTextBoxLists(ext), [LIST_A])
  })

  it("비-글상자 도형의 잉여 구간이 표 78 과 맞으면 문단 리스트를 회수한다", () => {
    // 사각형(type 2)도 '글상자로 만들기'면 공통 헤더 뒤에 같은 블록을 싣고,
    // 그 전체 길이를 header_length 로 선언한다 (rhwp #5558)
    const surplus = 8 + LIST_A.length
    const ext = Buffer.concat([
      frameHeader(1),
      commonHeader(2, 0x00, surplus),
      textBoxDetails(LIST_A),
      Buffer.alloc(8), // 사각형 세부 정보(정보1·정보2 = 0)
    ])
    assert.deepEqual(collectDrawingTextBoxLists(ext), [LIST_A])
  })

  it("잉여 구간이 표 78 과 안 맞으면 건너뛴다 — 없는 텍스트를 지어내지 않는다", () => {
    const ext = Buffer.concat([
      frameHeader(1),
      commonHeader(2, 0x00, 16),
      Buffer.alloc(16), // 정보1/정보2 길이 합이 잉여-8 과 다르다
      Buffer.alloc(8),
    ])
    assert.deepEqual(collectDrawingTextBoxLists(ext), [])
  })

  it("점 배열 도형(다각형·곡선)의 세부 정보를 정확히 소비한다", () => {
    const polygon = Buffer.alloc(12)
    polygon.writeUInt32LE(0, 0)
    polygon.writeUInt32LE(3, 4) // 점 3개
    polygon.writeUInt32LE(0, 8)
    const ext = Buffer.concat([
      frameHeader(2),
      commonHeader(5, 0x01),
      polygon,
      Buffer.alloc(3 * 8),
      commonHeader(6, 0x00),
      textBoxDetails(LIST_B),
    ])
    assert.deepEqual(collectDrawingTextBoxLists(ext), [LIST_B])
  })

  it("점 개수가 남은 바이트를 넘으면 던진다 — 호출자가 종전 동작으로 되돌아간다", () => {
    const polygon = Buffer.alloc(12)
    polygon.writeUInt32LE(0xffffff, 4)
    const ext = Buffer.concat([frameHeader(1), commonHeader(5, 0x00), polygon])
    assert.throws(() => collectDrawingTextBoxLists(ext), /점 개수 비정상/)
  })

  it("자식 체인이 깊으면 던진다 — 스택 고갈 방어 (rhwp #4285)", () => {
    const parts = [frameHeader(1)]
    for (let i = 0; i < 300; i++) parts.push(commonHeader(0, 0x02), Buffer.alloc(8))
    parts.push(commonHeader(6, 0x00), textBoxDetails(LIST_A))
    assert.throws(() => collectDrawingTextBoxLists(Buffer.concat(parts)), /중첩/)
  })

  it("잘린 트리는 던진다", () => {
    const ext = Buffer.concat([frameHeader(1), commonHeader(6, 0).subarray(0, 40)])
    assert.throws(() => collectDrawingTextBoxLists(ext))
  })
})
