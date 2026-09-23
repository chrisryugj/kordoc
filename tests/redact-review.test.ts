/**
 * 적대적 검토(2026-09-23) 회귀 — 검증된 결함마다 재현 입력을 하나씩 고정한다. 번호는 검토 보고서 항목
 * (HIGH-1 … LOW-15). 값은 전부 합성(synthetic): 주민번호는 체크섬만 맞춘 가상 값, 도메인은 example.*.
 * CLI·MCP 배선(HIGH-2 출력, LOW-10 파일 이름, LOW-14 덮어쓰기, 응답 줄 수)은 redact-cli-mcp.test.ts.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { inflateRawSync } from "node:zlib"
import { markdownToHwpx } from "../src/index.js"
import { redactMarkdown, redactText, ALL_REDACT_RULES } from "../src/redact.js"
import { redactDocument } from "../src/redact-doc.js"
import { isBindingPath } from "../src/redact-scrub.js"
import {
  HWP5_OLE_PII, HWP5_OLE_CHART_PII, buildHwp5, buildPiiHwp5, paragraph, ctrlChar, ctrlIdLE, rec, oleObject,
  hwp5Stream, hwp5Leaks, tinyPng, chunk, crc32,
} from "./fixtures/redact-fixtures.js"

const P = (inner: string): string => `<hp:p paraPrIDRef="0" styleIDRef="0">${inner}</hp:p>`
const R = (inner: string): string => `<hp:run charPrIDRef="0">${inner}</hp:run>`

/** 생성기 HWPX 의 section0 끝에 XML 을 심고, 필요하면 엔트리를 더한다 */
async function hwpxWith(extra: string, entries: Record<string, Uint8Array | string> = {}, md = "본문"): Promise<Uint8Array> {
  const z = await JSZip.loadAsync(await markdownToHwpx(md))
  const s = await z.file("Contents/section0.xml")!.async("string")
  z.file("Contents/section0.xml", s.replace("</hs:sec>", extra + "</hs:sec>"))
  for (const [k, v] of Object.entries(entries)) z.file(k, v)
  return new Uint8Array(await z.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
}

/** ZIP 모든 엔트리(UTF-8·UTF-16LE·태그 제거 텍스트)에서 값이 보이는 엔트리 — 구현과 독립된 오라클 */
async function zipLeaks(data: Uint8Array, value: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(data)
  const out: string[] = []
  for (const [name, f] of Object.entries(zip.files)) {
    if (f.dir) continue
    const b = Buffer.from(await f.async("uint8array"))
    const texts = [b.toString("utf8"), b.toString("utf16le"), b.subarray(1).toString("utf16le")]
    if (texts.some((t) => t.includes(value) || t.replace(/<[^>]*>/g, "").includes(value))) out.push(name)
  }
  return out
}

const entryText = async (data: Uint8Array, name: string): Promise<string> =>
  (await JSZip.loadAsync(data)).file(name)!.async("string")

describe("HIGH-1 — 라벨이 주민번호와 법인번호를 함께 부를 때", () => {
  it("주민·생년월일 라벨이 창 안에 하나라도 있으면 주민번호로 가린다", () => {
    for (const text of [
      "주민등록번호(법인등록번호): 900101-1694788",
      "주민(법인)등록번호: 900101-1694788",
      "주민등록번호 (법인등록번호) 900101-1694788",
      "생년월일(법인등록번호) 900101-1694788",
      "사업자등록번호(주민등록번호): 900101-1694788",
      "| 성명(법인명) | 주민등록번호(법인등록번호) |\n| --- | --- |\n| 홍길동 | 900101-1694788 |",
      "| 주민등록번호<br>(법인등록번호) | 9001011694788 |",
    ]) {
      const r = redactMarkdown(text)
      assert.equal(r.hits.length, 1, text)
      assert.equal(r.hits[0].rule, "rrn", text)
      assert.ok(!r.text.includes("1694788"), `${text} → ${r.text}`)
    }
  })

  it("법인번호 라벨만 있으면 기본 룰은 두고(법인번호는 개인정보 아님), opt-in crn 룰이 가린다", () => {
    assert.equal(redactMarkdown("법인등록번호 110111-1022287").hits.length, 0)
    assert.deepEqual(redactMarkdown("법인등록번호 110111-1022287", { rules: [...ALL_REDACT_RULES] }).hits.map((h) => h.rule), ["crn"])
  })

  it("HWPX 본문·표·미리보기 텍스트에서도 가린다", async () => {
    const md = [
      "신청인 주민등록번호(법인등록번호): 900101-1694788",
      "",
      "| 성명(법인명) | 생년월일(법인등록번호) |",
      "| --- | --- |",
      "| 홍길동 | 850315-2002390 |",
    ].join("\n")
    const r = await redactDocument(new Uint8Array(await markdownToHwpx(md)))
    assert.deepEqual(r.residual, [])
    for (const v of ["900101-1694788", "850315-2002390"]) assert.deepEqual(await zipLeaks(r.data!, v), [], v)
  })
})

describe("MED-3 — 변경 추적 표지는 글자를 끊는다", () => {
  it("지운 번호와 넣은 번호가 붙어도 둘 다 가린다", async () => {
    const doc = await hwpxWith(P(R(`<hp:t>담당 연락처 <hp:deleteBegin Id="1" TcId="1"/>010-2345-6789<hp:deleteEnd Id="1" TcId="1"/><hp:insertBegin Id="2" TcId="2"/>010-9876-5432<hp:insertEnd Id="2" TcId="2"/> 입니다</hp:t>`)))
    const r = await redactDocument(doc)
    assert.deepEqual(r.residual, [])
    assert.deepEqual(r.fileHits.map((h) => h.masked).sort(), ["010-●●●●-5432", "010-●●●●-6789"])
    for (const v of ["010-2345-6789", "010-9876-5432"]) assert.deepEqual(await zipLeaks(r.data!, v), [], v)
  })

  it("지운 주민번호 뒤에 넣은 숫자가 붙어도 주민번호를 가린다", async () => {
    const doc = await hwpxWith(P(R(`<hp:t>주민등록번호 <hp:deleteBegin Id="1" TcId="1"/>900101-1694788<hp:deleteEnd Id="1" TcId="1"/><hp:insertBegin Id="2" TcId="2"/>000000-0000000<hp:insertEnd Id="2" TcId="2"/></hp:t>`)))
    const r = await redactDocument(doc)
    assert.deepEqual(await zipLeaks(r.data!, "900101-1694788"), [])
  })

  it("쪽 번호·단 정의·떠 있는 표 같은 조판 개체가 번호를 갈라도 파서처럼 이어 보고 가린다", async () => {
    const tbl = (await entryText(new Uint8Array(await markdownToHwpx("| 가 | 나 |\n| --- | --- |\n| 1 | 2 |")), "Contents/section0.xml"))
      .match(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/)![0].replace(/treatAsChar="1"/, 'treatAsChar="0"')
    for (const mid of [
      `<hp:ctrl><hp:colDef id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>`,
      `<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>`,
      tbl,
    ]) {
      const r = await redactDocument(await hwpxWith(P(R(`<hp:t>주민등록번호 9001011</hp:t>${mid}<hp:t>694788 끝</hp:t>`))))
      assert.deepEqual(r.residual, [], mid.slice(0, 30))
      assert.equal(r.fileHits.length, 1, mid.slice(0, 30))
    }
  })

  it("파일 수술이 놓친 값은 결과를 다시 읽은 본문 검사가 잔존으로 잡는다 (안전망)", async () => {
    // 비어 있는 수식 컨트롤이 번호 가운데 끼면 파서는 글자를 잇고(수식 글자 없음) 수술기는 끊는다
    const doc = buildHwp5(Buffer.concat([
      paragraph(0, ["주민등록번호 9001011", ctrlChar(0x0b, "eqed"), "694788 끝"], 1 << 11),
      rec(0x47, 1, Buffer.concat([ctrlIdLE("eqed"), Buffer.alloc(42)])),
    ]))
    const r = await redactDocument(doc)
    assert.equal(r.markdownHits.length, 1)
    assert.deepEqual(r.residual.map((h) => `${h.masked}@${h.part}`), ["900101●●●●●●●@(결과 본문 재파싱)"])
    assert.equal(r.changed, false)
  })
})

describe("MED-4 — 대형 명단은 선형 시간", () => {
  it("2,000행 명단(6천 곳)을 30초 안에 가리고 잔존 0 (종전 71초)", async () => {
    const rows = ["| 번호 | 성명 | 주민등록번호 | 연락처 | 이메일 |", "| --- | --- | --- | --- | --- |"]
    for (let i = 0; i < 2000; i++) {
      const rrn = `${String(50 + (i % 40))}${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}-1${String(100000 + ((i * 7919) % 900000))}`
      rows.push(`| ${i + 1} | 홍길${i} | ${rrn} | 010-${2000 + (i % 8000)}-${1000 + ((i * 37) % 9000)} | user${i}@example.com |`)
    }
    const doc = new Uint8Array(await markdownToHwpx(rows.join("\n")))
    const t0 = Date.now()
    const r = await redactDocument(doc)
    const ms = Date.now() - t0
    assert.ok(ms < 30000, `${ms}ms`)
    assert.ok(r.fileHits.length >= 6000, `${r.fileHits.length}`)
    assert.deepEqual(r.residual, [])
  })
})

describe("MED-5 — 서식 데이터 연결 경로는 이메일이 아니다", () => {
  const PATHS = ["./DataArea/PoliceArea/Suspect/List[0]/Job.Code@code.Name", "./DataArea/PoliceArea/Crime.Name.Code@code.Name"]

  it("isBindingPath", () => {
    for (const p of PATHS) assert.ok(isBindingPath(p), p)
    for (const p of ["hong@example.com", "mailto:hong@example.com", "hong.gd@code.example.org"]) assert.ok(!isBindingPath(p), p)
  })

  it("HWPX 셀·누름틀 이름 속성은 그대로 둔다 (fill_form 이 이름으로 찾는다)", async () => {
    const doc = await hwpxWith(P(R(`<hp:ctrl><hp:fieldBegin id="9" type="CLICK_HERE" name="${PATHS[1]}" editable="1" dirty="0" zorder="-1" fieldid="9"/></hp:ctrl><hp:t>죄명</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="9" fieldid="9"/></hp:ctrl>`)))
    const r = await redactDocument(doc)
    assert.equal(r.fileHits.length, 0)
    assert.ok((await entryText(r.data!, "Contents/section0.xml")).includes(`name="${PATHS[1]}"`))
  })

  it("HWP5 필드·셀 이름 레코드(CTRL_DATA)도 그대로 둔다", async () => {
    const name = Buffer.from(PATHS[0], "utf16le")
    const ctrlData = Buffer.concat([Buffer.alloc(12), Buffer.from([name.length / 2, 0]), name])
    const doc = buildHwp5(Buffer.concat([paragraph(0, ["직업"]), rec(0x57, 1, ctrlData)]))
    const r = await redactDocument(doc)
    assert.equal(r.fileHits.length, 0)
    assert.ok(hwp5Stream(r.data!, "/BodyText/Section0", true).includes(name))
  })
})

describe("MED-6 — 나열·공백 섞인 구분자·끝자리 1자리 계좌", () => {
  const masked = (text: string): string => redactMarkdown(text).text

  it("쉼표·온점·빗금으로 붙인 나열 — 라벨은 첫 값에만", () => {
    assert.equal(masked("연락처: 02-2345-6789,010-2345-6789"), "연락처: 02-●●●●-6789,010-●●●●-6789")
    assert.equal(masked("담당: 031-234-5678.010-2345-6789"), "담당: 031-●●●-5678.010-●●●●-6789")
    assert.equal(masked("hong@example.com;kim@example.org"), "h●●●@example.com;k●●@example.org")
    assert.equal(masked("계좌 110-123-456789,110-987-654321"), "계좌 ●●●-●●●-456789,●●●-●●●-654321")
    assert.equal(masked("주민등록번호 900101-1694788, 8503152002390"), "주민등록번호 900101-●●●●●●●, 850315●●●●●●●")
  })

  it("구분자 앞뒤 공백·그 밖의 줄표 글자", () => {
    for (const [text, want] of [
      ["연락처 010 2345-6789", "연락처 010 ●●●●-6789"],
      ["연락처 010-2345 -6789", "연락처 010-●●●● -6789"],
      ["전화) 02- 2345-6789", "전화) 02- ●●●●-6789"],
      ["휴대폰: 010 - 2345-6789", "휴대폰: 010 - ●●●●-6789"],
      ["010ㅡ2345ㅡ6789", "010ㅡ●●●●ㅡ6789"],
      ["주민번호 900101─1694788", "주민번호 900101─●●●●●●●"],
    ]) assert.equal(masked(text), want)
  })

  it("마지막 그룹이 1자리인 계좌", () => {
    assert.equal(masked("입금계좌: 새마을금고 9002-1234-5678-9"), "입금계좌: 새마을금고 ●●●●-●●●●-●●●●-9")
    assert.equal(masked("계좌번호 508-10-123456-7"), "계좌번호 ●●●-●●-●●●●●●-7")
  })

  it("라벨 없는 쉼표 숫자 나열은 계좌로 보지 않는다 (금액 목록 오탐 방지)", () => {
    assert.equal(redactMarkdown("1,234-567-890123").hits.length, 0)
  })
})

describe("MED-7 — 압축된 삽입 OLE 개체", () => {
  it("HWP5: 풀어서 안쪽 스트림(UTF-16·차트 XML)의 PII 를 잔존으로 보고한다", async () => {
    const r = await redactDocument(buildPiiHwp5({ withOlePii: true }))
    assert.deepEqual(r.residual.map((h) => `${h.masked}@${h.part}`).sort(), [
      "010-●●●●-4444@BinData/BIN0002.OLE", "010-●●●●-7878@BinData/BIN0002.OLE",
    ])
    assert.ok(r.warnings.some((w) => w.includes("BinData/BIN0002.OLE") && w.includes("가리지 못합니다")))
    // 원시 바이트로는 안 보인다 — 압축돼 있어서 (종전 재검사가 exit 0 이던 이유)
    assert.ok(!Buffer.from(r.data!).includes(Buffer.from(HWP5_OLE_PII, "utf16le")))
  })

  it("HWPX: BinData/*.ole 도 같은 방식으로 잔존 보고", async () => {
    const r = await redactDocument(await hwpxWith(P(R("<hp:t>본문 끝</hp:t>")), { "BinData/ole1.ole": oleObject() }))
    assert.deepEqual(r.residual.map((h) => `${h.masked}@${h.part}`).sort(), [
      "010-●●●●-4444@BinData/ole1.ole", "010-●●●●-7878@BinData/ole1.ole",
    ])
    for (const v of [HWP5_OLE_PII, HWP5_OLE_CHART_PII]) assert.ok(!JSON.stringify(r).includes(v))
  })
})

describe("MED-8 — 다시 압축한 HWP5 스트림에 한컴 꼬리 유지", () => {
  it("가린 섹션 스트림 끝 8바이트 = CRC32(해제본) + 해제본 크기", async () => {
    const r = await redactDocument(buildPiiHwp5())
    const stream = hwp5Stream(r.data!, "/BodyText/Section0")
    const raw = inflateRawSync(stream)
    assert.equal(stream.readUInt32LE(stream.length - 4), raw.length)
    assert.equal(stream.readUInt32LE(stream.length - 8), crc32(raw))
    assert.ok(raw.includes(Buffer.from("010-●●●●-6789", "utf16le")))
  })
})

describe("MED-9 — NUL 섞인 텍스트 엔트리", () => {
  it("BOM 없는 UTF-16LE Scripts·PrvText 도 가리고, 인코딩은 그대로", async () => {
    const r = await redactDocument(await hwpxWith(P(R("<hp:t>본문</hp:t>")), {
      "Scripts/headerScripts.js": Buffer.from('var tel = "010-2323-4545";\r\n', "utf16le"),
      "Preview/PrvText.txt": Buffer.from("<연락처><010-6767-8989>\r\n", "utf16le"),
    }))
    assert.deepEqual(r.residual, [])
    assert.deepEqual(r.unscanned, [])
    const zip = await JSZip.loadAsync(r.data!)
    const js = Buffer.from(await zip.file("Scripts/headerScripts.js")!.async("uint8array")).toString("utf16le")
    assert.equal(js, 'var tel = "010-●●●●-4545";\r\n')
    const prv = Buffer.from(await zip.file("Preview/PrvText.txt")!.async("uint8array")).toString("utf16le")
    assert.equal(prv, "<연락처><010-●●●●-8989>\r\n")
  })

  it("UTF-16 으로 저장된 XML 엔트리도 풀어서 가리고 UTF-16 으로 되쓴다", async () => {
    const xml = '﻿<?xml version="1.0" encoding="UTF-16"?><note><owner tel="010-2323-4545">담당 010-6767-8989</owner></note>'
    const r = await redactDocument(await hwpxWith(P(R("<hp:t>본문</hp:t>")), { "Contents/note.xml": Buffer.from(xml, "utf16le") }))
    assert.deepEqual(r.unscanned, [])
    const out = Buffer.from(await (await JSZip.loadAsync(r.data!)).file("Contents/note.xml")!.async("uint8array")).toString("utf16le")
    assert.equal(out, xml.replace("010-2323-4545", "010-●●●●-4545").replace("010-6767-8989", "010-●●●●-8989"))
  })

  it("인코딩을 모르는 텍스트 엔트리는 미검사(unscanned)로 실패 신호를 낸다", async () => {
    const r = await redactDocument(await hwpxWith(P(R("<hp:t>본문</hp:t>")), {
      "Scripts/broken.js": new Uint8Array([0x00, 0xd8, 0x41, 0x00, 0xff, 0x00, 0x30]),
    }))
    assert.deepEqual(r.unscanned, ["Scripts/broken.js"])
  })
})

describe("LOW-11 — 삽입 그림 메타데이터", () => {
  it("JPEG XMP·주석 세그먼트의 글자를 같은 길이로 가린다", async () => {
    const seg = (marker: number, body: Buffer): Buffer => {
      const h = Buffer.from([0xff, marker, 0, 0])
      h.writeUInt16BE(body.length + 2, 2)
      return Buffer.concat([h, body])
    }
    const xmp = Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0"), Buffer.from('<x:xmpmeta><rdf:li photoshop:LayerName="대변인실 042-234-7616"/></x:xmpmeta>', "utf8")])
    const jpg = Buffer.concat([
      Buffer.from([0xff, 0xd8]), seg(0xe1, xmp), seg(0xfe, Buffer.from("author hong@example.com")),
      Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]),
    ])
    const r = await redactDocument(await hwpxWith(P(R("<hp:t>본문</hp:t>")), { "BinData/image9.jpg": jpg }))
    assert.deepEqual(r.residual, [])
    const out = Buffer.from(await (await JSZip.loadAsync(r.data!)).file("BinData/image9.jpg")!.async("uint8array"))
    assert.equal(out.length, jpg.length)
    assert.ok(!out.includes(Buffer.from("042-234-7616")) && !out.includes(Buffer.from("hong@example.com")))
    assert.ok(out.includes(Buffer.from("042-***-7616")))
    assert.deepEqual(r.fileHits.map((h) => h.where), ["metadata", "metadata"])
  })

  it("PNG tEXt 청크는 가리고 CRC 를 다시 계산한다", async () => {
    const png = tinyPng()
    const iend = png.length - 12
    const text = chunk("tEXt", Buffer.from("Author\0Tel 010-2323-4545", "latin1"))
    const withText = Buffer.concat([png.subarray(0, iend), text, png.subarray(iend)])
    const r = await redactDocument(await hwpxWith(P(R("<hp:t>본문</hp:t>")), { "BinData/image8.png": withText }))
    const out = Buffer.from(await (await JSZip.loadAsync(r.data!)).file("BinData/image8.png")!.async("uint8array"))
    const at = out.indexOf(Buffer.from("tEXt"))
    const len = out.readUInt32BE(at - 4)
    assert.equal(out.subarray(at + 4, at + 4 + len).toString("latin1"), "Author\0Tel 010-****-4545")
    assert.equal(out.readUInt32BE(at + 4 + len), crc32(out.subarray(at, at + 4 + len)))
  })
})

describe("LOW-12 — 정수만인 속성값·XML 주석·처리 지시", () => {
  it("누름틀 이름 01023456789, 주석·처리 지시 속 PII 를 가리고 XML 은 그대로 읽힌다", async () => {
    const doc = await hwpxWith(
      `<!-- 작성자 연락처 010-2345-6789 --><?kordoc-note owner=hong@example.com?>` +
      P(R(`<hp:ctrl><hp:fieldBegin id="5" type="CLICK_HERE" name="01023456789" editable="1" dirty="0" zorder="-1" fieldid="5"/></hp:ctrl><hp:t>누름틀</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="5" fieldid="5"/></hp:ctrl>`)),
    )
    const r = await redactDocument(doc)
    assert.deepEqual(r.residual, [])
    for (const v of ["010-2345-6789", "hong@example.com", "01023456789"]) assert.deepEqual(await zipLeaks(r.data!, v), [], v)
    const sec = await entryText(r.data!, "Contents/section0.xml")
    assert.ok(sec.includes("<!-- 작성자 연락처 010-●●●●-6789 -->") && sec.includes("<?kordoc-note owner=h●●●@example.com?>"))
    assert.ok(sec.includes('name="010●●●●6789"'))
  })
})

describe("LOW-13 — 마스크 문자 검증", () => {
  it("비문자·전각 숫자·폭 없는 글자·결합 문자·구분 기호는 거부", () => {
    for (const mc of ["￾", "￿", "１", "​", "́", "_", ".", "-", "@", " ", "12"]) {
      assert.throws(() => redactText("010-2345-6789", { maskChar: mc }), /maskChar/, JSON.stringify(mc))
    }
  })

  it("허용된 문자로 가린 결과는 다시 훑어도 PII 가 아니다", () => {
    for (const mc of ["●", "*", "#", "■", "○"]) {
      const out = redactText("hong@example.com 010-2345-6789 900101-1694788", { maskChar: mc }).text
      assert.equal(redactText(out).hits.length, 0, `${mc}: ${out}`)
    }
  })
})

describe("LOW-15 — 과잉 마스킹", () => {
  it("날짜 부호 일련번호·기기 일련번호·부품 번호·접수번호·대표번호 자리표시자는 PII 가 아니다", () => {
    for (const text of ["관리번호 2024-0115-123456", "주문번호 2024-0115-123456", "S/N 1234-5678-9012", "S123A4567 부품 교체", "코드 R123B4567", "11-24-123456-01 (접수)", "대표번호 1588-0000", "2019-2020-2021", "공사비 110-123-456789원", "2023-10-123456"]) {
      assert.equal(redactMarkdown(text).hits.length, 0, text)
    }
  })

  it("바로 앞이 일련번호 라벨이면 전화 모양도 기기·상품 번호 — 전화 라벨이 있으면 전화", () => {
    for (const text of ["S/N 0507-9978-0522", "시리얼 번호: 010-2345-6789", "바코드 1588-1234"]) assert.equal(redactMarkdown(text).hits.length, 0, text)
    assert.equal(redactMarkdown("일련번호 문의 전화 010-2345-6789").hits.length, 1)
    assert.equal(redactMarkdown("예산담당관 044-200-5555").hits.length, 1)
  })
})

describe("HIGH-2 — 미할당 섹터 (라이브 스트림엔 PII 없음)", () => {
  const live = (): Buffer => Buffer.from(buildHwp5(paragraph(0, ["연락처는 삭제했습니다"])))

  it("압축 안 된 옛 사본 — 늘 비우고, 비운 자리의 PII 를 slack 위치로 보고", async () => {
    const stale = Buffer.alloc(512)
    Buffer.from("<신청인><010-2323-4545>", "utf16le").copy(stale)
    const r = await redactDocument(Buffer.concat([live(), stale]))
    assert.equal(r.changed, true)
    assert.deepEqual(r.fileHits.map((h) => `${h.where}:${h.masked}`), ["slack:010-●●●●-4545"])
    assert.deepEqual(hwp5Leaks(r.data!, { v: "010-2323-4545" }), [])
  })

  it("압축된 옛 BodyText 사본(한컴이 남기는 꼴)도 풀어 보고하고 비운다", async () => {
    const { deflateRawSync } = await import("node:zlib")
    const old = deflateRawSync(paragraph(0, ["신청인 연락처 010-2323-4545 입니다"]))
    const stale = Buffer.alloc(512)
    old.copy(stale)
    const input = Buffer.concat([live(), stale])
    const r = await redactDocument(input)
    assert.deepEqual(r.fileHits.map((h) => `${h.where}:${h.masked}`), ["slack:010-●●●●-4545"])
    const out = Buffer.from(r.data!)
    assert.ok(out.subarray(input.length - 512, input.length).every((b) => b === 0), "옛 사본 섹터가 남음")
    assert.deepEqual(r.residual, [])
  })

  it("미할당 영역이 없고 PII 도 없으면 결과는 원본 그대로", async () => {
    const r = await redactDocument(live())
    assert.equal(r.fileHits.length, 0)
    assert.equal(r.changed, false)
  })
})
