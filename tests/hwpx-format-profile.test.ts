/**
 * 서식 프로필(Format Profile) — 이슈 #41 / PR #42.
 * generate가 프로필의 borderFill(테두리·음영)·열너비·셀 글꼴을 적용하는지,
 * 그리고 리맵/XML 빌더 단위 동작과 하위호환(미지정 시 불변)을 검증한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, hwpxToProfile } from "../src/index.js"
import {
  buildProfileRemap, borderFillDefToXml, profileCharPrXml, profileCharPrBase,
  type FormatProfile,
} from "../src/hwpx/gen-profile.js"

const GFM = "| a | b |\n|---|---|\n| 1 | 2 |"

async function parts(buf: ArrayBuffer): Promise<{ header: string; section: string }> {
  const zip = await JSZip.loadAsync(buf)
  return {
    header: await zip.file("Contents/header.xml")!.async("text"),
    section: await zip.file("Contents/section0.xml")!.async("text"),
  }
}

describe("gen-profile 단위", () => {
  it("profileCharPrBase = 11 + variants*4", () => {
    assert.equal(profileCharPrBase(0), 11)
    assert.equal(profileCharPrBase(2), 19)
  })

  it("buildProfileRemap — 표별 borderFill id 네임스페이스 독립", () => {
    const profile: FormatProfile = {
      tables: [
        {
          table_index: 0, rows: 1, cols: 1,
          cells: [{ row: 0, col: 0, borderFillIDRef: "10" }],
          used_border_fills: { "10": { topBorder: { type: "SOLID", width: "0.1 mm", color: "#111111" } } },
        },
        {
          table_index: 1, rows: 1, cols: 1,
          cells: [{ row: 0, col: 0, borderFillIDRef: "10" }],
          used_border_fills: { "10": { topBorder: { type: "SOLID", width: "0.1 mm", color: "#222222" } } },
        },
      ],
    }
    const remap = buildProfileRemap(profile, 11)
    // 표0의 "10" → 전역 3, 표1의 "10" → 전역 4 (같은 로컬 키라도 충돌 없음)
    assert.equal(remap.tables[0].cellBf.get("0,0"), 3)
    assert.equal(remap.tables[1].cellBf.get("0,0"), 4)
    assert.equal(remap.borderFillXmls.length, 2)
    assert.match(remap.borderFillXmls[0], /#111111/)
    assert.match(remap.borderFillXmls[1], /#222222/)
  })

  it("borderFillDefToXml — fill 있으면 winBrush, 없으면 생략", () => {
    const withFill = borderFillDefToXml(3, {
      topBorder: { type: "SOLID", width: "0.5 mm", color: "#0000FF" },
      fill: { faceColor: "#EEEEEE" },
    })
    assert.match(withFill, /id="3"/)
    assert.match(withFill, /<hh:topBorder type="SOLID" width="0.5 mm" color="#0000FF"\/>/)
    assert.match(withFill, /<hh:winBrush faceColor="#EEEEEE"/)
    const noFill = borderFillDefToXml(4, { topBorder: { type: "SOLID", width: "0.1 mm", color: "#000000" } })
    assert.doesNotMatch(noFill, /winBrush/)
  })

  it("profileCharPrXml — underline·fontRef_hangul 정직 반영 (볼드여도 폰트 강제 안 함)", () => {
    const xml = profileCharPrXml(11, { height_hwpunit: "1400", bold: true, underline: true, fontRef_hangul: "1", textColor: "#FF0000" })
    assert.match(xml, /id="11" height="1400"/)
    assert.match(xml, /bold="1"/)
    assert.match(xml, /<hh:underline type="BOTTOM"/)
    assert.match(xml, /hangul="1"/)  // charPr()과 달리 볼드→2 강제치환 없음
  })

  it("profileCharPrXml — 생성 header에 없는 fontface 순번은 0으로 접는다 (dangling IDREF 방지)", () => {
    // 원본 문서 fontfaces 순번 7 — 생성 header는 HANGUL 3종(0~2)뿐
    const xml = profileCharPrXml(11, { fontRef_hangul: "7" })
    assert.match(xml, /<hh:fontRef hangul="0"/)
    const ok = profileCharPrXml(12, { fontRef_hangul: "2" })
    assert.match(ok, /<hh:fontRef hangul="2"/)
  })
})

describe("markdownToHwpx — 서식 프로필 소비", () => {
  const profile: FormatProfile = {
    tables: [{
      table_index: 0, rows: 2, cols: 2,
      col_widths_hwpunit: ["10000", "34000"],
      cells: [
        { row: 0, col: 0, borderFillIDRef: "hdr", charPrIDRef: "big" },
        { row: 0, col: 1, borderFillIDRef: "hdr" },
      ],
      used_border_fills: {
        "hdr": { topBorder: { type: "SOLID", width: "0.4 mm", color: "#0000FF" }, fill: { faceColor: "#DDEEFF" } },
      },
      used_char_prs: {
        "big": { height_hwpunit: "1400", bold: true, textColor: "#FF0000", fontRef_hangul: "2" },
      },
    }],
  }

  it("셀 borderFill·음영이 header에 정의되고 셀이 참조한다", async () => {
    const { header, section } = await parts(await markdownToHwpx(GFM, { profile }))
    assert.match(header, /<hh:borderFills itemCnt="3">/)
    assert.match(header, /<hh:borderFill id="3"[\s\S]*?#0000FF[\s\S]*?<hh:winBrush faceColor="#DDEEFF"/)
    assert.match(section, /<hp:tc[^>]*borderFillIDRef="3"/)  // (0,0),(0,1) 셀
  })

  it("열너비가 col_widths_hwpunit대로 적용된다", async () => {
    const { section } = await parts(await markdownToHwpx(GFM, { profile }))
    assert.match(section, /<hp:cellSz width="10000"/)
    assert.match(section, /<hp:cellSz width="34000"/)
    assert.match(section, /<hp:sz width="44000"/)  // 표 폭 = 합
  })

  it("셀 charPr가 header에 정의되고 셀 런이 참조한다", async () => {
    const { header, section } = await parts(await markdownToHwpx(GFM, { profile }))
    assert.match(header, /<hh:charPr id="11" height="1400"[^>]*bold="1"/)
    assert.match(section, /<hp:run charPrIDRef="11">/)  // (0,0) 셀 런
  })

  it("HTML 병합표 — 앵커 좌표 서식 + 병합셀 폭 합산", async () => {
    const merged = [
      "<table>",
      '<tr><th colspan="2">머리</th><th>C</th></tr>',
      "<tr><td>a</td><td>b</td><td>c</td></tr>",
      "</table>",
    ].join("\n")
    const mprof: FormatProfile = {
      tables: [{
        table_index: 0, rows: 2, cols: 3,
        col_widths_hwpunit: ["10000", "12000", "22000"],
        cells: [{ row: 0, col: 0, colSpan: 2, borderFillIDRef: "m" }],
        used_border_fills: { "m": { fill: { faceColor: "#CCCCCC" } } },
      }],
    }
    const { header, section } = await parts(await markdownToHwpx(merged, { profile: mprof }))
    assert.match(header, /<hh:winBrush faceColor="#CCCCCC"/)
    // colspan=2 앵커 셀이 리맵 borderFill(3) 참조 + 폭 = 10000+12000
    assert.match(section, /borderFillIDRef="3"[\s\S]*?colSpan="2"[\s\S]*?width="22000"/)
  })

  it("앵커 없는 sparse 프로필 — table_index=방출 순번 매칭 유지 (손편집 계약)", async () => {
    const twoTables = GFM + "\n\n| x | y |\n|---|---|\n| 9 | 8 |"
    const only2nd: FormatProfile = {
      tables: [{
        table_index: 1, rows: 2, cols: 2,
        cells: [{ row: 0, col: 0, borderFillIDRef: "z" }],
        used_border_fills: { "z": { topBorder: { type: "SOLID", width: "0.7 mm", color: "#00AA00" } } },
      }],
    }
    const { header, section } = await parts(await markdownToHwpx(twoTables, { profile: only2nd }))
    assert.match(header, /<hh:borderFills itemCnt="3">/)
    assert.match(header, /#00AA00/)
    // 리맵 borderFill(3)을 참조하는 셀이 정확히 1개 (두 번째 표의 (0,0))
    assert.equal((section.match(/borderFillIDRef="3"/g) ?? []).length, 1)
  })

  it("방출 안 된 표(1×1 제목박스)가 있어도 앵커로 정합 — 남의 서식 오적용 없음 (v3.18.0 P1)", async () => {
    // 원본: [1×1 제목, 2×2 RED(첫 셀 a), 2×2 GREEN(첫 셀 x)] — parse 는 1×1 을 표로 방출 안 함
    const twoTables = GFM + "\n\n| x | y |\n|---|---|\n| 9 | 8 |"  // 첫 셀 "a", "x"
    const withDropped: FormatProfile = {
      tables: [
        {
          table_index: 0, rows: 1, cols: 1, anchor_text: "제목",
          cells: [{ row: 0, col: 0, borderFillIDRef: "t" }],
          used_border_fills: { "t": { fill: { faceColor: "#BBBBBB" } } },  // 전역 id 3 소비
        },
        {
          table_index: 1, rows: 2, cols: 2, anchor_text: "a",
          cells: [{ row: 0, col: 0, borderFillIDRef: "r" }],
          used_border_fills: { "r": { fill: { faceColor: "#FF0000" } } },
        },
        {
          table_index: 2, rows: 2, cols: 2, anchor_text: "x",
          cells: [{ row: 0, col: 0, borderFillIDRef: "g" }],
          used_border_fills: { "g": { fill: { faceColor: "#00FF00" } } },
        },
      ],
    }
    const { header, section } = await parts(await markdownToHwpx(twoTables, { profile: withDropped }))
    // 1×1 프로필(id 3)은 미소비, RED=id 4 → 첫 표, GREEN=id 5 → 둘째 표
    assert.match(header, /#FF0000/)
    assert.match(header, /#00FF00/)
    const firstRed = section.indexOf('borderFillIDRef="4"')
    const firstGreen = section.indexOf('borderFillIDRef="5"')
    assert.ok(firstRed !== -1 && firstGreen !== -1, "RED·GREEN 둘 다 적용")
    assert.ok(firstRed < firstGreen, "RED 가 첫 표, GREEN 이 둘째 표 (순서 뒤바뀜 없음)")
    assert.doesNotMatch(section, /borderFillIDRef="3"/)  // 1×1 프로필은 어디에도 안 붙음
  })

  it("동형 쌍둥이 표 — 같은 앵커·치수라도 등장 순서대로 1:1 소비", async () => {
    const twins = "| 구분 | 값 |\n|---|---|\n| 1 | 2 |\n\n| 구분 | 값 |\n|---|---|\n| 3 | 4 |"
    const prof: FormatProfile = {
      tables: [
        {
          table_index: 0, rows: 2, cols: 2, anchor_text: "구분",
          cells: [{ row: 0, col: 0, borderFillIDRef: "a" }],
          used_border_fills: { "a": { fill: { faceColor: "#AA0000" } } },
        },
        {
          table_index: 1, rows: 2, cols: 2, anchor_text: "구분",
          cells: [{ row: 0, col: 0, borderFillIDRef: "b" }],
          used_border_fills: { "b": { fill: { faceColor: "#0000AA" } } },
        },
      ],
    }
    const { section } = await parts(await markdownToHwpx(twins, { profile: prof }))
    const i3 = section.indexOf('borderFillIDRef="3"')
    const i4 = section.indexOf('borderFillIDRef="4"')
    assert.ok(i3 !== -1 && i4 !== -1 && i3 < i4, "첫 표→프로필0, 둘째 표→프로필1")
  })

  it("html_table 생성 실패가 이후 표 순번을 밀지 않는다 (시도 기준 순번)", async () => {
    // 행이 없어 파싱 실패하는 HTML 표 + 정상 GFM 표. 앵커 없는 프로필이 table_index=1 로 GFM 표를 지정.
    const md = "<table></table>\n\n" + GFM
    const prof: FormatProfile = {
      tables: [{
        table_index: 1, rows: 2, cols: 2,
        cells: [{ row: 0, col: 0, borderFillIDRef: "k" }],
        used_border_fills: { "k": { fill: { faceColor: "#123123" } } },
      }],
    }
    const { section } = await parts(await markdownToHwpx(md, { profile: prof }))
    // html 표가 실패로 문단 폴백돼도 GFM 표는 순번 1 을 유지해 프로필이 붙는다
    assert.match(section, /borderFillIDRef="3"/)
  })

  it("행·열 불일치 프로필은 무시된다 (하위호환, 예외 없음)", async () => {
    const badProfile: FormatProfile = {
      tables: [{
        table_index: 0, rows: 5, cols: 9,  // 실제는 2x2
        cells: [{ row: 0, col: 0, borderFillIDRef: "x" }],
        used_border_fills: { "x": { topBorder: { type: "SOLID", width: "0.1 mm", color: "#123456" } } },
      }],
    }
    const { section } = await parts(await markdownToHwpx(GFM, { profile: badProfile }))
    // 프로필 무시 → 모든 셀 기본 borderFillIDRef="2", 리맵 id는 셀에 안 붙음
    assert.doesNotMatch(section, /borderFillIDRef="3"/)
    assert.match(section, /borderFillIDRef="2"/)
  })

  it("gongmun + profile 병용 — charPr id 충돌 없이 둘 다 유효", async () => {
    const buf = await markdownToHwpx(GFM, { gongmun: { preset: "plan" }, profile })
    const { header, section } = await parts(buf)
    // gongmun variant charPr 다음 번호부터 프로필 charPr 할당 → id 중복 없음
    const ids = [...header.matchAll(/<hh:charPr id="(\d+)"/g)].map(m => +m[1])
    assert.equal(new Set(ids).size, ids.length, "charPr id 중복 없음")
    assert.ok(section.length > 0)
  })

  it("profile 미지정 시 기존 출력 불변 (회귀 가드)", async () => {
    const { header, section } = await parts(await markdownToHwpx(GFM))
    assert.match(header, /<hh:borderFills itemCnt="2">/)
    assert.match(section, /borderFillIDRef="2"/)
    assert.doesNotMatch(header, /borderFill id="3"/)
  })
})

describe("hwpxToProfile — 추출", () => {
  it("표 구조·셀 좌표·병합 스팬을 정확히 뽑는다", async () => {
    const merged = [
      "<table>",
      '<tr><th colspan="2">구분</th><th>내용</th></tr>',
      '<tr><td rowspan="2">사업</td><td>세부1</td><td>예산 100</td></tr>',
      "<tr><td>세부2</td><td>예산 200</td></tr>",
      "</table>",
    ].join("\n")
    const prof = await hwpxToProfile(await markdownToHwpx(merged))
    assert.equal(prof.schema_version, "0.3.0")
    assert.equal(prof.tables.length, 1)
    const t = prof.tables[0]
    assert.equal(t.table_index, 0)
    assert.equal(t.rows, 3)
    assert.equal(t.cols, 3)
    assert.equal(t.anchor_text, "구분", "첫 셀(0,0) 정규화 앵커")
    const anchor = t.cells.find(c => c.row === 0 && c.col === 0)!
    assert.equal(anchor.colSpan, 2)
    const rs = t.cells.find(c => c.row === 1 && c.col === 0)!
    assert.equal(rs.rowSpan, 2)
  })

  it("중첩표는 top-level 표로 세지 않는다 (generate tableSeq와 정합)", async () => {
    const nested = [
      "<table>",
      "<tr><th>항목</th><th>상세</th></tr>",
      "<tr><td>내역</td><td><table><tr><td>값1</td><td>값2</td></tr></table></td></tr>",
      "</table>",
    ].join("\n")
    const prof = await hwpxToProfile(await markdownToHwpx(nested))
    assert.equal(prof.tables.length, 1, "top-level 표 1개만")
  })
})

describe("round-trip — generate(profile) → hwpxToProfile → 재생성", () => {
  const profile: FormatProfile = {
    tables: [{
      table_index: 0, rows: 2, cols: 2,
      col_widths_hwpunit: ["10000", "34000"],
      cells: [
        { row: 0, col: 0, borderFillIDRef: "hdr", charPrIDRef: "big" },
        { row: 0, col: 1, borderFillIDRef: "hdr" },
      ],
      used_border_fills: {
        "hdr": { topBorder: { type: "SOLID", width: "0.4 mm", color: "#0000FF" }, fill: { faceColor: "#DDEEFF" } },
      },
      used_char_prs: { "big": { height_hwpunit: "1400", bold: true, textColor: "#FF0000", fontRef_hangul: "2" } },
    }],
  }

  it("추출 프로필의 셀 서식이 입력과 동치 (색·음영·너비 보존)", async () => {
    const extracted = await hwpxToProfile(await markdownToHwpx(GFM, { profile }))
    const t = extracted.tables[0]
    // 셀 (0,0)이 참조하는 borderFill 정의가 원본 색·음영과 동치 (키는 리맵되어 다름)
    const anchor = t.cells.find(c => c.row === 0 && c.col === 0)!
    const bf = t.used_border_fills[anchor.borderFillIDRef!]
    assert.equal(bf.topBorder!.color, "#0000FF")
    assert.equal(bf.fill!.faceColor, "#DDEEFF")
    // 셀 charPr 동치
    const cp = t.used_char_prs![anchor.charPrIDRef!]
    assert.equal(cp.height_hwpunit, "1400")
    assert.equal(cp.bold, true)
    assert.equal(cp.fontRef_hangul, "2")
    // 열너비 보존
    assert.deepEqual(t.col_widths_hwpunit, ["10000", "34000"])
  })

  it("추출 프로필을 재소비하면 같은 서식이 재현된다 (완결 왕복)", async () => {
    const extracted = await hwpxToProfile(await markdownToHwpx(GFM, { profile }))
    const { header, section } = await parts(await markdownToHwpx(GFM, { profile: extracted }))
    assert.match(header, /#0000FF/)
    assert.match(header, /<hh:winBrush faceColor="#DDEEFF"/)
    assert.match(header, /height="1400"[^>]*bold="1"/)
    assert.match(section, /<hp:cellSz width="10000"/)
    assert.match(section, /<hp:cellSz width="34000"/)
  })
})

describe("폰트명 왕복 (스키마 0.3.0)", () => {
  const profile: FormatProfile = {
    tables: [{
      table_index: 0, rows: 2, cols: 2,
      cells: [{ row: 0, col: 0, charPrIDRef: "cp" }],
      used_border_fills: {},
      used_char_prs: { "cp": { height_hwpunit: "1200", fontRef_hangul: "7", fontName_hangul: "휴먼명조" } },
    }],
  }

  it("fontName_hangul이 header fontface로 append되고 charPr가 참조한다 (순번 폴딩 제거)", async () => {
    const { header } = await parts(await markdownToHwpx(GFM, { profile }))
    // 정적 3종(0~2) 뒤 id 3으로 append — HANGUL·LATIN 양쪽
    assert.match(header, /<hh:fontface lang="HANGUL" fontCnt="4">/)
    assert.match(header, /<hh:fontface lang="LATIN" fontCnt="4">/)
    assert.match(header, /<hh:font id="3" face="휴먼명조"/)
    // charPr는 append 글꼴 id 참조 (이름 없던 시절의 0 폴딩 아님), 나머지 언어 슬롯도 같은 id(툴바 글꼴명 조건)
    assert.match(header, /<hh:fontRef hangul="3" latin="3" hanja="3" japanese="3" other="3" symbol="3" user="3"/)
    assert.match(header, /<hh:fontface lang="HANJA" fontCnt="4">/)
  })

  it("같은 글꼴 이름은 표·charPr를 넘어 dedupe된다", () => {
    const two: FormatProfile = {
      tables: [0, 1].map(i => ({
        table_index: i, rows: 1, cols: 1,
        cells: [{ row: 0, col: 0, charPrIDRef: "cp" }],
        used_border_fills: {},
        used_char_prs: { "cp": { fontName_hangul: "휴먼명조" } },
      })),
    }
    const remap = buildProfileRemap(two, 11, 3, 3)
    assert.deepEqual(remap.fontFaces, ["휴먼명조"])
    assert.match(remap.charPrXmls[0], /hangul="3"/)
    assert.match(remap.charPrXmls[1], /hangul="3"/)
  })

  it("추출 → 재생성 왕복: 원본 fontfaces의 글꼴 이름이 생성 문서에 살아남는다", async () => {
    const gen1 = await markdownToHwpx(GFM, { profile })
    const extracted = await hwpxToProfile(gen1)
    const cps = Object.values(extracted.tables[0].used_char_prs!)
    assert.ok(cps.some(c => c.fontName_hangul === "휴먼명조"), `추출 charPr에 휴먼명조 없음: ${JSON.stringify(cps)}`)
    const { header } = await parts(await markdownToHwpx(GFM, { profile: extracted }))
    assert.match(header, /face="휴먼명조"/)
  })
})

describe("앵커 다중 지문 — anchor_row (0.3.0)", () => {
  it("(0,0) 빈 셀 크로스탭 — 순번이 어긋나도 첫 행 지문으로 매칭된다", async () => {
    const gfm = "|  | 상반기 | 하반기 |\n|---|---|---|\n| 서울 | 1 | 2 |"
    const profile: FormatProfile = {
      tables: [{
        table_index: 9, // 의도적으로 어긋난 순번 — anchor_row가 없으면 매칭 실패
        rows: 2, cols: 3,
        anchor_row: "|상반기|하반기",
        cells: [{ row: 0, col: 1, borderFillIDRef: "hd" }],
        used_border_fills: { "hd": { fill: { faceColor: "#ABCDEF" } } },
      }],
    }
    const { header, section } = await parts(await markdownToHwpx(gfm, { profile }))
    assert.match(header, /<hh:winBrush faceColor="#ABCDEF"/)
    assert.match(section, /borderFillIDRef="3"/)
  })

  it("동형이지만 첫 행이 다른 표에는 적용하지 않는다 (오적용 방지)", async () => {
    const gfm = "|  | 1분기 | 2분기 |\n|---|---|---|\n| 서울 | 1 | 2 |"
    const profile: FormatProfile = {
      tables: [{
        table_index: 9, rows: 2, cols: 3,
        anchor_row: "|상반기|하반기",
        cells: [{ row: 0, col: 1, borderFillIDRef: "hd" }],
        used_border_fills: { "hd": { fill: { faceColor: "#ABCDEF" } } },
      }],
    }
    // borderFill XML은 매칭 여부와 무관하게 header에 방출된다 — 셀 참조(id 3)만 게이트
    const { section } = await parts(await markdownToHwpx(gfm, { profile }))
    assert.doesNotMatch(section, /borderFillIDRef="3"/)
  })

  it("추출기가 첫 행 지문을 담는다 — 병합 행0도 col_widths 분배로 보존", async () => {
    // 행0 전체 병합(colspan=2) — 종전에는 col_widths_hwpunit 소실
    const html = `<table><tr><td colspan="2">제목</td></tr><tr><td>가</td><td>나</td></tr></table>`
    const extracted = await hwpxToProfile(await markdownToHwpx(html))
    const t = extracted.tables[0]
    assert.equal(t.anchor_row, "제목|") // 병합 커버 열은 빈 슬롯 — 소비측과 동일 키 공간
    assert.equal(t.col_widths_hwpunit?.length, 2)
    // 행1 span-1 셀 실폭으로 확정 (합 ≈ 표폭)
    const sum = t.col_widths_hwpunit!.map(Number).reduce((a, b) => a + b, 0)
    const w = Number(t.width_hwpunit)
    assert.ok(Math.abs(sum - w) <= 2, `col_widths 합 ${sum} ≠ 표폭 ${w}`)
  })

  it("모든 행이 병합인 열도 균등 분배로 col_widths가 나온다", async () => {
    const html = `<table><tr><td colspan="2">가</td></tr><tr><td colspan="2">나</td></tr></table>`
    const extracted = await hwpxToProfile(await markdownToHwpx(html))
    const t = extracted.tables[0]
    assert.equal(t.cols, 2)
    assert.equal(t.col_widths_hwpunit?.length, 2)
  })
})
