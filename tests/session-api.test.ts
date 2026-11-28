/** HwpxSession — 블록 단위 증분 패치 API 테스트 (v3.1) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx, patchHwpx } from "../src/index.js"
import { HwpxSession, openHwpxDocument, patchHwpxBlocks } from "../src/roundtrip/session.js"

// ─── 헬퍼 ────────────────────────────────────────────

const SYNTH_MD = `# 사업 개요

본 사업은 2026년 주민 복지 향상을 위한 시범사업이다.

| 항목 | 담당자 | 비고 |
| --- | --- | --- |
| 예산 | 홍길동 | 1억원 |
| 기간 | 김철수 | 6개월 |

마지막 문단.`

async function makeSynthetic(): Promise<{ original: Uint8Array; markdown: string }> {
  const buf = await markdownToHwpx(SYNTH_MD)
  const original = new Uint8Array(buf)
  const parsed = await parseHwpx(buf)
  assert.ok(parsed.success, "합성 HWPX 파싱 성공")
  return { original, markdown: parsed.markdown }
}

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

function assertBytesEqual(a: Uint8Array, b: Uint8Array, msg: string): void {
  assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0, msg)
}

/** section XML 외 모든 ZIP 엔트리가 바이트 동일한지 확인 */
async function assertNonSectionEntriesIdentical(a: Uint8Array, b: Uint8Array): Promise<void> {
  const za = await JSZip.loadAsync(a)
  const zb = await JSZip.loadAsync(b)
  assert.deepEqual(Object.keys(za.files).sort(), Object.keys(zb.files).sort(), "엔트리 목록 동일")
  for (const name of Object.keys(za.files)) {
    if (za.files[name].dir || /section\d+\.xml$/i.test(name) || name === "Preview/PrvText.txt") continue  // 미리보기 글은 고친 본문으로 다시 쓴다 (#248)
    const da = await za.file(name)!.async("uint8array")
    const db = await zb.file(name)!.async("uint8array")
    assert.equal(Buffer.compare(Buffer.from(da), Buffer.from(db)), 0, `엔트리 바이트 보존: ${name}`)
  }
}

// ─── 세션 열기 / 조회 ────────────────────────────────

describe("HwpxSession: 열기와 조회", () => {
  it("blocks/markdown/bytes 노출 + sourceRef 제공", async () => {
    const { original } = await makeSynthetic()
    const session = await openHwpxDocument(original)

    assert.ok(session.blocks.length >= 4, `블록 수: ${session.blocks.length}`)
    assert.ok(session.markdown.includes("주민 복지"))
    assertBytesEqual(session.bytes, original, "열기 직후 바이트 동일")

    const paraIdx = session.blocks.findIndex(b => b.text?.includes("주민 복지"))
    assert.ok(paraIdx >= 0)
    const ref = session.sourceRef(paraIdx)
    assert.ok(ref, "문단 sourceRef 존재")
    assert.equal(ref!.kind, "paragraph")
    // sectionIndex는 manifest 해석 순서에 따라 0이 아닐 수 있음 (settings류 엔트리 포함)
    assert.ok(ref!.sectionIndex >= 0)
    assert.ok(ref!.xmlStart >= 0)

    const tableIdx = session.blocks.findIndex(b => b.type === "table")
    assert.ok(tableIdx >= 0)
    const tref = session.sourceRef(tableIdx)
    assert.equal(tref?.kind, "table")
  })

  it("capability: 문단=text, 표=cell-text(셀 매트릭스), 범위 밖=locked", async () => {
    const { original } = await makeSynthetic()
    const session = await HwpxSession.open(original)

    const paraIdx = session.blocks.findIndex(b => b.type === "paragraph" && b.text?.includes("주민 복지"))
    assert.equal(session.capability(paraIdx).capability, "text")

    // 제목 블록 — 합성 문서에서 heading으로 분류되지 않을 수 있으므로 텍스트로 탐색
    const titleIdx = session.blocks.findIndex(b => b.text?.includes("사업 개요"))
    assert.ok(titleIdx >= 0)
    assert.equal(session.capability(titleIdx).capability, "text")

    const tableIdx = session.blocks.findIndex(b => b.type === "table")
    const tcap = session.capability(tableIdx)
    assert.equal(tcap.capability, "cell-text")
    assert.ok(tcap.cells, "셀 매트릭스 존재")
    assert.ok(tcap.cells![1][1].editable, "데이터 셀 편집 가능")

    const oob = session.capability(9999)
    assert.equal(oob.capability, "locked")
    assert.ok(oob.reason)

    assert.equal(session.capabilities().length, session.blocks.length)
  })
})

// ─── patchBlocks — 문단/셀 편집 ─────────────────────

describe("HwpxSession.patchBlocks", () => {
  it("문단 편집: 적용 + 상태 갱신 + 비섹션 엔트리 보존", async () => {
    const { original } = await makeSynthetic()
    const session = await HwpxSession.open(original)
    const paraIdx = session.blocks.findIndex(b => b.text?.includes("주민 복지"))

    const res = await session.patchBlocks([
      { blockIndex: paraIdx, newText: "본 사업은 2026년 주민 안전 강화를 위한 본사업이다." },
    ])
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.equal(res.skipped.length, 0)
    assert.ok(res.data)

    // 세션 상태가 갱신됨
    assert.ok(session.blocks[paraIdx]?.text?.includes("주민 안전 강화") || session.markdown.includes("주민 안전 강화"))
    assert.ok(session.markdown.includes("주민 안전 강화"))
    assert.ok(!session.markdown.includes("주민 복지 향상"))

    // 재파싱 검증
    const reparsed = await parseHwpx(toAB(res.data!))
    assert.ok(reparsed.success)
    assert.ok(reparsed.markdown.includes("주민 안전 강화"))

    await assertNonSectionEntriesIdentical(original, res.data!)

    // changes: 전→후 diff에 modified 1건 (verification은 session에서 미사용)
    assert.equal(res.changes?.stats.modified, 1)
    assert.equal(res.changes?.stats.added, 0)
    assert.equal(res.changes?.stats.removed, 0)
    assert.equal(res.verification, undefined)
  })

  it("문단 편집: 원본 들여쓰기(선행 공백/전각공백) 보존", async () => {
    const section = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
  <hp:p id="0"><hp:run charPrIDRef="0"><hp:t>  ○ 25일 발행 당일 : 익월 게재</hp:t></hp:run></hp:p>
  <hp:p id="1"><hp:run charPrIDRef="0"><hp:t>　○ 전각공백 들여쓰기 줄</hp:t></hp:run></hp:p>
</hs:sec>`
    const zip = new JSZip()
    zip.file("mimetype", "application/hwp+zip")
    zip.file("Contents/section0.xml", section)
    const original = new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }))

    const session = await HwpxSession.open(original)
    const i0 = session.blocks.findIndex(b => b.text?.includes("25일"))
    const i1 = session.blocks.findIndex(b => b.text?.includes("전각공백"))
    const res = await session.patchBlocks([
      { blockIndex: i0, newText: "○ 5일경 : 수정된 텍스트" },
      { blockIndex: i1, newText: "○ 전각공백 수정됨" },
    ])
    assert.ok(res.success)
    assert.equal(res.applied, 2)

    const outXml = await (await JSZip.loadAsync(res.data!)).file("Contents/section0.xml")!.async("text")
    assert.ok(outXml.includes("<hp:t>  ○ 5일경 : 수정된 텍스트</hp:t>"), "일반 공백 들여쓰기 보존")
    assert.ok(outXml.includes("<hp:t>　○ 전각공백 수정됨</hp:t>"), "전각공백 들여쓰기 보존")
  })

  it("표 셀 편집: 격자 좌표로 적용", async () => {
    const { original } = await makeSynthetic()
    const session = await HwpxSession.open(original)
    const tableIdx = session.blocks.findIndex(b => b.type === "table")
    const table = session.blocks[tableIdx].table!
    assert.equal(table.cells[1][1].text.trim(), "홍길동")

    const res = await session.patchBlocks([
      { blockIndex: tableIdx, cells: [{ row: 1, col: 1, text: "박영희" }] },
    ])
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.equal(res.skipped.length, 0)

    const reparsed = await parseHwpx(toAB(res.data!))
    assert.ok(reparsed.success)
    assert.ok(reparsed.markdown.includes("박영희"))
    assert.ok(!reparsed.markdown.includes("홍길동"))
  })

  it("무변경 편집 → 원본과 바이트 동일 (CI 게이트 1)", async () => {
    const { original } = await makeSynthetic()
    const session = await HwpxSession.open(original)
    const paraIdx = session.blocks.findIndex(b => b.text?.includes("주민 복지"))
    const tableIdx = session.blocks.findIndex(b => b.type === "table")

    // 같은 텍스트로 "편집" + 빈 편집 목록
    const res1 = await session.patchBlocks([
      { blockIndex: paraIdx, newText: session.blocks[paraIdx].text! },
      { blockIndex: tableIdx, cells: [{ row: 1, col: 1, text: "홍길동" }] },
    ])
    assert.ok(res1.success)
    assert.equal(res1.applied, 0)
    assertBytesEqual(res1.data!, original, "무변경 patchBlocks = 바이트 동일")

    const res2 = await session.patchBlocks([])
    assert.ok(res2.success)
    assertBytesEqual(res2.data!, original, "빈 편집 = 바이트 동일")
    // 무변경 경로도 changes(전부 unchanged)를 채운다 — 결과 형태 일관성
    assert.ok(res2.changes, "무변경 경로 changes 존재")
    assert.equal(res2.changes!.stats.modified, 0)
  })

  it("no-op 첫 편집이 같은 블록의 유효한 두 번째 편집을 막지 않는다", async () => {
    const { original } = await makeSynthetic()
    const session = await HwpxSession.open(original)
    const paraIdx = session.blocks.findIndex(b => b.text?.includes("주민 복지"))

    const res = await session.patchBlocks([
      { blockIndex: paraIdx, newText: session.blocks[paraIdx].text! }, // no-op
      { blockIndex: paraIdx, newText: "유효한 두 번째 편집입니다." },   // 적용돼야 함
    ])
    assert.ok(res.success)
    assert.equal(res.applied, 1, "no-op이 슬롯을 점유하면 안 됨")
    assert.ok(session.markdown.includes("유효한 두 번째 편집입니다."))
  })

  it("빈 문자열 비우기는 skip (블록 핸들 소실 + patchHwpx 비대칭 방지)", async () => {
    const { original } = await makeSynthetic()
    const session = await HwpxSession.open(original)
    const paraIdx = session.blocks.findIndex(b => b.text?.includes("마지막 문단"))
    const before = session.blocks.length

    const res = await session.patchBlocks([{ blockIndex: paraIdx, newText: "" }])
    assert.ok(res.success)
    assert.equal(res.applied, 0)
    assert.equal(res.skipped.length, 1)
    assert.match(res.skipped[0].reason, /비우기|삭제/)
    assertBytesEqual(res.data!, original, "비우기 거부 = 바이트 동일")
    assert.equal(session.blocks.length, before, "블록 수 불변")
  })

  it("동시 호출은 직렬화되어 두 편집 모두 보존된다 (lost-update 방지)", async () => {
    const { original } = await makeSynthetic()
    const session = await HwpxSession.open(original)
    const idxA = session.blocks.findIndex(b => b.text?.includes("주민 복지"))
    const idxB = session.blocks.findIndex(b => b.text?.includes("마지막 문단"))

    // await 없이 동시 발사 — 내부 큐가 직렬화해야 함
    const p1 = session.patchBlocks([{ blockIndex: idxA, newText: "동시 편집 A 결과입니다." }])
    const p2 = session.patchBlocks([{ blockIndex: idxB, newText: "동시 편집 B 결과입니다." }])
    const [r1, r2] = await Promise.all([p1, p2])
    assert.ok(r1.success && r2.success)
    assert.equal(r1.applied + r2.applied, 2)
    assert.ok(session.markdown.includes("동시 편집 A 결과입니다."), "편집 A 보존")
    assert.ok(session.markdown.includes("동시 편집 B 결과입니다."), "편집 B 보존")
  })

  it("전각 공백 변경도 patchHwpx와 동일하게 적용된다 (silent drop 금지)", async () => {
    const buf = await markdownToHwpx("앞문단입니다.\n\n주소　서울특별시\n\n뒷문단입니다.")
    const original = new Uint8Array(buf)
    const session = await HwpxSession.open(original)
    const idx = session.blocks.findIndex(b => b.text?.includes("주소"))
    assert.ok(idx >= 0)

    const res = await session.patchBlocks([{ blockIndex: idx, newText: "주소 서울특별시" }])
    assert.ok(res.success)
    assert.equal(res.applied, 1, "정규화 동치라도 실제 변경은 적용")

    // patchHwpx 경로와 바이트 동일 (동등성)
    const parsed = await parseHwpx(toAB(original))
    assert.ok(parsed.success)
    const batch = await patchHwpx(original, parsed.markdown.replace("주소　서울특별시", "주소 서울특별시"))
    assert.ok(batch.success && batch.applied === 1)
    assertBytesEqual(res.data!, batch.data!, "전각 공백 편집 동등성")
  })

  it("반환 data 변조가 세션 내부 상태를 오염시키지 않는다", async () => {
    const { original } = await makeSynthetic()
    const session = await HwpxSession.open(original)
    const idx = session.blocks.findIndex(b => b.text?.includes("마지막 문단"))

    const r1 = await session.patchBlocks([{ blockIndex: idx, newText: "변조 테스트 문단." }])
    assert.ok(r1.success)
    r1.data!.fill(0) // 호출자가 버퍼 재사용/변조

    const idx2 = session.blocks.findIndex(b => b.text?.includes("변조 테스트"))
    const r2 = await session.patchBlocks([{ blockIndex: idx2, newText: "후속 편집도 정상 동작." }])
    assert.ok(r2.success, `후속 패치 성공해야 함: ${r2.error ?? ""}`)
    assert.equal(r2.applied, 1)
  })

  it("ArrayBuffer 입력 후 외부 변이가 세션을 오염시키지 않는다", async () => {
    const { original } = await makeSynthetic()
    const ab = toAB(original)
    const session = await HwpxSession.open(ab)
    new Uint8Array(ab).fill(0) // 호출자가 원본 버퍼 재사용

    const idx = session.blocks.findIndex(b => b.text?.includes("마지막 문단"))
    const res = await session.patchBlocks([{ blockIndex: idx, newText: "격리 확인 문단." }])
    assert.ok(res.success, `외부 변이와 무관하게 성공: ${res.error ?? ""}`)
    assert.equal(res.applied, 1)
  })

  it("범위 밖/중복/잘못된 형식 → skipped 보고", async () => {
    const { original } = await makeSynthetic()
    const session = await HwpxSession.open(original)
    const paraIdx = session.blocks.findIndex(b => b.text?.includes("주민 복지"))
    const tableIdx = session.blocks.findIndex(b => b.type === "table")

    const res = await session.patchBlocks([
      { blockIndex: 9999, newText: "x" },                              // 범위 밖
      { blockIndex: paraIdx, newText: "첫 번째 편집입니다." },          // 정상
      { blockIndex: paraIdx, newText: "두 번째 편집은 무시됩니다." },   // 중복
      { blockIndex: tableIdx, newText: "표에 newText는 불가" },         // 형식 오류
    ])
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.equal(res.skipped.length, 3)
    assert.ok(session.markdown.includes("첫 번째 편집입니다."))
    assert.ok(!session.markdown.includes("두 번째"))
  })

  it("patchHwpxBlocks 원샷 API", async () => {
    const { original } = await makeSynthetic()
    const parsed = await parseHwpx(toAB(original))
    assert.ok(parsed.success)
    const paraIdx = parsed.blocks.findIndex(b => b.text?.includes("마지막 문단"))

    const res = await patchHwpxBlocks(original, [{ blockIndex: paraIdx, newText: "수정된 마지막 문단." }])
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    const reparsed = await parseHwpx(toAB(res.data!))
    assert.ok(reparsed.success && reparsed.markdown.includes("수정된 마지막 문단."))
  })
})

// ─── CI 게이트 2: 증분 ≡ 일괄 동등성 ────────────────

describe("동등성: n회 연속 patchBlocks ≡ 일괄 patchHwpx", () => {
  it("문단 1건 + 셀 1건 — 같은 호출 1번 vs 분할 호출 2번 vs patchHwpx 일괄", async () => {
    const { original, markdown } = await makeSynthetic()

    const NEW_PARA = "본 사업은 2026년 주민 안전 강화를 위한 본사업이다."
    const NEW_CELL = "박영희"

    // 경로 A: patchHwpx 일괄 (마크다운 도메인)
    const editedMd = markdown
      .replace("본 사업은 2026년 주민 복지 향상을 위한 시범사업이다.", NEW_PARA)
      .replace("홍길동", NEW_CELL)
    const batch = await patchHwpx(original, editedMd)
    assert.ok(batch.success)
    assert.equal(batch.applied, 2)
    assert.equal(batch.skipped.length, 0)

    // 경로 B: 세션 한 번의 patchBlocks
    const sB = await HwpxSession.open(original)
    const paraIdxB = sB.blocks.findIndex(b => b.text?.includes("주민 복지"))
    const tableIdxB = sB.blocks.findIndex(b => b.type === "table")
    const oneCall = await sB.patchBlocks([
      { blockIndex: paraIdxB, newText: NEW_PARA },
      { blockIndex: tableIdxB, cells: [{ row: 1, col: 1, text: NEW_CELL }] },
    ])
    assert.ok(oneCall.success)
    assert.equal(oneCall.applied, 2)

    // 경로 C: 세션 두 번의 patchBlocks (증분)
    const sC = await HwpxSession.open(original)
    const paraIdxC = sC.blocks.findIndex(b => b.text?.includes("주민 복지"))
    const r1 = await sC.patchBlocks([{ blockIndex: paraIdxC, newText: NEW_PARA }])
    assert.ok(r1.success && r1.applied === 1)
    const tableIdxC = sC.blocks.findIndex(b => b.type === "table")
    const r2 = await sC.patchBlocks([{ blockIndex: tableIdxC, cells: [{ row: 1, col: 1, text: NEW_CELL }] }])
    assert.ok(r2.success && r2.applied === 1)

    assertBytesEqual(oneCall.data!, batch.data!, "1회 patchBlocks ≡ patchHwpx 일괄")
    assertBytesEqual(r2.data!, batch.data!, "2회 증분 patchBlocks ≡ patchHwpx 일괄")
  })

  it("같은 문단 연속 수정 — 최종 상태가 일괄 최종 수정과 동일", async () => {
    const { original, markdown } = await makeSynthetic()
    const FINAL = "최종 확정된 문단 텍스트이다."

    const batch = await patchHwpx(original, markdown.replace("마지막 문단.", FINAL))
    assert.ok(batch.success && batch.applied === 1)

    const s = await HwpxSession.open(original)
    const idx1 = s.blocks.findIndex(b => b.text?.includes("마지막 문단"))
    const r1 = await s.patchBlocks([{ blockIndex: idx1, newText: "중간 수정 단계의 문단." }])
    assert.ok(r1.success && r1.applied === 1)
    const idx2 = s.blocks.findIndex(b => b.text?.includes("중간 수정 단계"))
    assert.ok(idx2 >= 0, "수정된 문단 재발견")
    const r2 = await s.patchBlocks([{ blockIndex: idx2, newText: FINAL }])
    assert.ok(r2.success && r2.applied === 1)

    // 중간 단계를 거쳐도 같은 XML 결과 — 재파싱 마크다운 동일성으로 검증
    // (deflate 입력이 같아도 중간 회수에 따라 압축 결과가 다를 이유는 없지만,
    //  보수적으로 내용 동일성 게이트로 둔다)
    const a = await parseHwpx(toAB(r2.data!))
    const b = await parseHwpx(toAB(batch.data!))
    assert.ok(a.success && b.success)
    assert.equal(a.markdown, b.markdown, "연속 수정 최종 내용 ≡ 일괄 수정 내용")
    assertBytesEqual(r2.data!, batch.data!, "연속 수정 바이트 ≡ 일괄 수정 바이트")
  })
})
