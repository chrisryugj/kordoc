/**
 * 레이아웃 보존 렌더 (src/render/) — 단위 + 실파일 e2e.
 * 실파일 검증은 bench/corpus (gitignore) 존재 시에만.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { toInt32, solveBoundaries, solveRowHeights } from "../src/render/layout.js"
import { renderHwpxToSvg } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus")

describe("render: toInt32 (uint32 음수)", () => {
  it("4294967103 → -193 (사진대지 vertOffset 실측)", () => {
    assert.equal(toInt32("4294967103"), -193)
  })
  it("일반 양수·음수 문자열·결측", () => {
    assert.equal(toInt32("17645"), 17645)
    assert.equal(toInt32("-850"), -850)
    assert.equal(toInt32(undefined, 7), 7)
    assert.equal(toInt32("abc", 3), 3)
  })
})

describe("render: 열 경계 전파 솔버", () => {
  it("span-1 셀 없는 그리드도 제약 전파로 풀림 (트레일러 축소판)", () => {
    // 3경계 그리드: |0..2|=30, |2..3|=10, 전체=40 → x=[0,?,30,40], 첫 제약으로 x2=30
    const x = solveBoundaries([
      { a: 0, b: 2, size: 30 },
      { a: 2, b: 3, size: 10 },
    ], 3, 40)
    assert.equal(x[0], 0)
    assert.equal(x[2], 30)
    assert.equal(x[3], 40)
  })
  it("역방향 전파 — 오른쪽 끝에서 왼쪽으로", () => {
    // x4=100 확정, |3..4|=20 → x3=80, |1..3|=50 → x1=30
    const x = solveBoundaries([
      { a: 3, b: 4, size: 20 },
      { a: 1, b: 3, size: 50 },
    ], 4, 100)
    assert.equal(x[3], 80)
    assert.equal(x[1], 30)
  })
  it("미해결 경계는 균등 보간", () => {
    const x = solveBoundaries([], 4, 100)
    assert.deepEqual(x, [0, 25, 50, 75, 100])
  })
})

describe("render: 행 높이 솔버", () => {
  it("h=1 더미(헤어라인 장식 셀)가 섞여도 rs=1 max가 이김", () => {
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 1, height: 2700 },
      { rowAddr: 0, rowSpan: 1, height: 1 },
    ], 1)
    assert.equal(h[0], 2700)
  })
  it("rowSpan 잔여 균등분배 + 콘텐츠 초과 성장 (사진대지 실측 모델)", () => {
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 1, height: 16441, contentH: 22209 }, // 사진이 설계보다 큼
      { rowAddr: 1, rowSpan: 1, height: 3042 },
    ], 2)
    assert.equal(h[0], 22209)
    assert.equal(h[1], 3042)
    assert.equal(h[0] + h[1], 25251) // 표 sz 실측 일치
  })
})

describe("render: 조판 캐시 없는 파일 거부", () => {
  it("markdownToHwpx 산출물(lineseg 없음) → KordocError", async () => {
    const hwpx = await markdownToHwpx("# 제목\n\n본문 문단입니다.")
    await assert.rejects(
      renderHwpxToSvg(hwpx),
      (err: Error) => err.message.includes("조판 캐시"),
    )
  })
})

describe("render: reflow 표 밀어내기 (셀 콘텐츠 성장)", () => {
  it("긴 셀로 자란 표 뒤 문단이 표 바닥 아래에 온다 (리뷰#6 겹침)", async () => {
    // 셀 폭(약 22000HWPUNIT)을 여러 줄로 감는 긴 텍스트 — 선언 행높이 1500을 훌쩍 넘긴다
    const long = "서울특별시 도시기반시설 관리 실태 전수조사 결과에 따라 노후 시설물의 안전등급 재산정과 보수보강 우선순위 조정이 필요하며 연차별 투자계획을 수립하여 시행한다."
    const hwpx = await markdownToHwpx(`| 항목 | 내용 |\n| --- | --- |\n| 개요 | ${long} |\n\n표뒤문단입니다.`)
    const r = await renderHwpxToSvg(hwpx, { reflow: true })
    // 표 바닥 = 수평 border(<line y1==y2>) 최대 y, 뒤 문단 = 해당 <text>의 y
    const borderYs = [...r.svg.matchAll(/<line x1="[\d.-]+" y1="([\d.-]+)" x2="[\d.-]+" y2="([\d.-]+)"/g)]
      .filter(m => m[1] === m[2]).map(m => parseFloat(m[1]))
    const tableBottom = Math.max(...borderYs)
    const after = [...r.svg.matchAll(/<text [^>]*y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)]
      .find(m => m[2].includes("표뒤문단"))
    assert.ok(after, "표 뒤 문단 텍스트가 렌더에 없음")
    assert.ok(parseFloat(after[1]) > tableBottom,
      `표 뒤 문단(y=${after[1]})이 표 바닥(y=${tableBottom}) 위에 겹침`)
    // 성장 자체가 일어났는지 — 선언 표높이(행 1500×2=3000u=30pt)보다 실제 표가 크다
    const tableTop = Math.min(...borderYs)
    assert.ok(tableBottom - tableTop > 30, "재현 전제(셀 성장) 자체가 깨짐 — 테스트 입력 확인 필요")
  })
})

describe("render: 실파일 e2e (corpus 존재 시)", { skip: !existsSync(CORPUS) }, () => {
  const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(join(CORPUS, rel)))
  // base64 데이터 URI엔 "NaN"이 유효 부분열로 우연히 등장한다 — 좌표 검사에서 제외
  const geometry = (svg: string): string => svg.replace(/href="[^"]*"/g, "")

  it("결재문서(36427937) — 텍스트·이미지·표, NaN 없음", async () => {
    const file = "review/36427937_결재문서본문.hwpx"
    if (!existsSync(join(CORPUS, file))) return
    const r = await renderHwpxToSvg(read(file))
    assert.ok(r.svg.startsWith("<svg"))
    assert.equal(r.width, 595.28)
    assert.ok(r.svg.includes("시행"))
    assert.ok(r.svg.includes("문화예술과"))
    assert.equal(r.stats.images, 2) // 로고 PNG 2
    assert.ok(r.stats.tables >= 3)
    assert.ok(!geometry(r.svg).includes("NaN"))
  })

  it("사진대지(10772982) — uint32 음수 오프셋 사진 2장 모두, 셀 좌/우 배치", async () => {
    const file = "hwp5/10772982_4. 도시시설물 관리개선 사진.hwpx"
    if (!existsSync(join(CORPUS, file))) return
    const r = await renderHwpxToSvg(read(file))
    assert.equal(r.stats.images, 2)
    const xs = [...r.svg.matchAll(/<image x="([\d.]+)"/g)].map(m => parseFloat(m[1]))
    assert.equal(xs.length, 2)
    // 두 사진은 서로 다른 열 셀 — x 간격이 셀 폭(238pt)급으로 벌어져야 함
    assert.ok(Math.abs(xs[0] - xs[1]) > 150, `사진 x 좌표가 같은 셀에 몰림: ${xs}`)
    assert.ok(!geometry(r.svg).includes("NaN"))
  })
})
