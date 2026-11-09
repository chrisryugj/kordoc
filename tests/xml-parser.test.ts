/**
 * XML 파서(src/xml/dom.ts, quick-xml wasm) 고정점 — 잘 짜인 문서는 알림 없이 읽고, 깨진 문서는 고쳐 읽고 알린다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DOMParser, warnInto } from "../src/xml/dom.js"
import type { ParseWarning } from "../src/types.js"

const read = (xml: string) => {
  const issues: string[] = []
  const doc = new DOMParser({ onError: (level, msg) => { issues.push(level) ; void msg } }).parseFromString(xml, "text/xml")
  return { xml: String(doc.documentElement), issues }
}

describe("XML 파서: 잘 짜인 문서", () => {
  it("알림 없이 읽는다 — 엔티티·CDATA·주석·처리 명령·네임스페이스", () => {
    const r = read(`<?xml version="1.0"?><r xmlns:p="u"><p:a x="1 &amp; 2">a&lt;b<![CDATA[<c>]]><!--n--><?pi d?></p:a></r>`)
    assert.equal(r.xml, `<r xmlns:p="u"><p:a x="1 &amp; 2">a&lt;b<![CDATA[<c>]]><!--n--><?pi d?></p:a></r>`)
    assert.deepEqual(r.issues, [])
  })
})

describe("XML 파서: 깨진 문서 고쳐 읽기", () => {
  const cases: [string, string, string, string][] = [
    ["닫는 태그 빠짐", `<r><p><t>ab</p><p><t>cd</t></p></r>`, `<r><p><t>ab</t></p><p><t>cd</t></p></r>`, "error"],
    ["입력이 중간에 끝남", `<r><p><t>abc</t><t>de`, `<r><p><t>abc</t><t>de</t></p></r>`, "error"],
    ["태그 중간에 끝남", `<r><p><t>abc</t><t x="1`, `<r><p><t>abc</t></p></r>`, "error"],
    ["글 속 '<'", `<r><t>a<b</t><t>c</t></r>`, `<r><t>a&lt;b</t><t>c</t></r>`, "error"],
    ["'>' 빠진 시작 태그", `<r><a b="1"<t>x</t></a></r>`, `<r><a b="1"><t>x</t></a></r>`, "error"],
    ["'>' 빠진 닫는 태그", `<r><a>t</a<b>u</b></r>`, `<r><a>t</a><b>u</b></r>`, "error"],
    ["태그 안에 끼어든 태그", `<r><a b="1" c=<q>"2" d="3">t</a></r>`, `<r><a b="1" c="2" d="3">t</a></r>`, "error"],
    ["속성 값 안의 '<'", `<r><a b="x</y">t</a></r>`, `<r><a b="x&lt;/y">t</a></r>`, "error"],
    ["따옴표 짝 어긋남", `<r><a b="1>text</a><t q="z">w</t></r>`, `<r><a>text</a><t q="z">w</t></r>`, "error"],
    ["모르는 엔티티·홀로 쓴 &", `<r>a&foo;b & c</r>`, `<r>a&amp;foo;b &amp; c</r>`, "error"],
    ["같은 속성 두 번", `<r a="1" a="2">x</r>`, `<r a="1">x</r>`, "error"],
    ["따옴표 없는 값·값 없는 속성·= 빠짐", `<r a=1 b c"3">x</r>`, `<r a="1" b="" c="3">x</r>`, "warning"],
    ["여는 태그 없는 닫는 태그", `<r><a>1</b></a></r>`, `<r><a>1</a></r>`, "error"],
    ["루트 뒤 요소", `<r><a>1</a></r><a>2</a>`, `<r><a>1</a><a>2</a></r>`, "error"],
    ["끝나지 않은 주석", `<r><a>1</a><!-- x <a>2</a></r>`, `<r><a>1</a>&lt;!-- x <a>2</a></r>`, "error"],
    ["DOCTYPE 건너뜀", `<!DOCTYPE r [<!ENTITY e "x">]><r>y</r>`, `<r>y</r>`, ""],
    ["선언 안 된 접두사", `<r><p:a>x</p:a></r>`, `<r><p:a>x</p:a></r>`, "error"],
  ]
  for (const [name, input, want, level] of cases) {
    it(name, () => {
      const r = read(input)
      assert.equal(r.xml, want)
      assert.deepEqual([...new Set(r.issues)], level ? [level] : [])
    })
  }

  it("루트 요소가 없으면 fatalError 를 알리고 던진다", () => {
    const levels: string[] = []
    assert.throws(() => new DOMParser({ onError: l => { levels.push(l) } }).parseFromString("hello", "text/xml"))
    assert.equal(levels.at(-1), "fatalError")
  })

  it("warnInto: 고친 곳은 MALFORMED_XML 경고, 루트 없음은 경고 없이 던진다(호출자 catch 가 알린다)", () => {
    const w: ParseWarning[] = []
    new DOMParser(warnInto(w, "DOCX word/document.xml")).parseFromString("<r><a>1</r>", "text/xml")
    assert.equal(w.length, 1)
    assert.equal(w[0].code, "MALFORMED_XML")
    assert.match(w[0].message, /^DOCX word\/document\.xml XML 오류: /)
    assert.throws(() => new DOMParser(warnInto(w, "x")).parseFromString("", "text/xml"))
    assert.equal(w.length, 1)
  })

  it("끝나지 않은 표기가 많아도 선형 시간 — 끝 표지를 다시 찾지 않는다", { timeout: 20000 }, () => {
    for (const open of ["<!--", "<![CDATA[", "<?x", "<!DOCTYPE", '<a b="', "<", "</"]) {
      const r = read("<r>" + open.repeat(200_000) + "</r>")
      assert.equal(r.issues.includes("error"), true, open)
    }
  })
})
