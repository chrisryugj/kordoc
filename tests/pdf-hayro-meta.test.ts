import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { pdfString, pdfLinkAnnotations } from "../src/pdf/hayro-meta.js"
import { normalizeUnicode } from "../src/pdf/ops.js"
import type { HayroDoc, HayroLink } from "../src/pdf/hayro.js"

/** 바이트 → 한 글자 = 한 바이트 글 (엔진이 정보 사전·링크 글을 넘기는 모양) */
const latin1 = (bytes: number[]) => String.fromCharCode(...bytes)
const docWithLinks = (links: HayroLink[]) => ({ links: () => links }) as unknown as HayroDoc

describe("PDF 글 디코딩 (정보 사전·링크)", () => {
  it("BOM 이 있으면 UTF-16BE·UTF-16LE·UTF-8, 없으면 PDFDocEncoding", () => {
    assert.equal(pdfString(latin1([0xfe, 0xff, 0xd5, 0x5c, 0xae, 0x00])), "한글")
    assert.equal(pdfString(latin1([0xff, 0xfe, 0x5c, 0xd5, 0x00, 0xae])), "한글")
    assert.equal(pdfString(latin1([0xef, 0xbb, 0xbf, 0xed, 0x95, 0x9c])), "한")
    assert.equal(pdfString(latin1([0x80, 0x41, 0x92])), "•A™")
  })
  it("ESC 로 감싼 언어 표지는 뺀다", () => {
    assert.equal(pdfString(latin1([0xfe, 0xff, 0x00, 0x1b, 0x00, 0x6b, 0x00, 0x6f, 0x00, 0x1b, 0x00, 0x41])), "A")
    assert.equal(pdfString("\x1bko\x1bB"), "B")
  })
})

describe("링크 주소 고르기", () => {
  it("/URI — www. 는 http:// 를 붙이고, 허용 스킴(http·https·ftp·mailto·tel)만 받는다", () => {
    const urls = pdfLinkAnnotations(docWithLinks([
      { rect: [0, 0, 10, 10], uri: "www.example.com" },
      { rect: [0, 0, 10, 10], uri: "javascript:alert(1)" },
      { rect: [0, 0, 10, 10], uri: "mailto:a@b.kr" },
      { rect: [0, 0, 10, 10], uri: "relative/path" },
    ]), 0).map(a => a.url)
    assert.deepEqual(urls, ["http://www.example.com/", undefined, "mailto:a@b.kr", undefined])
  })
  it("UTF-8 바이트 주소는 글로 풀어 퍼센트 인코딩한다", () => {
    const [a] = pdfLinkAnnotations(docWithLinks([{ rect: [0, 0, 1, 1], uri: latin1([...Buffer.from("https://예.kr/가")]) }]), 0)
    assert.equal(a!.url, new URL("https://예.kr/가").href)
  })
  it("자바스크립트 동작은 app.launchURL·window.open 의 주소, 파일 동작은 이름#목적지", () => {
    const urls = pdfLinkAnnotations(docWithLinks([
      { rect: [0, 0, 1, 1], js: "app.launchURL('https://a.kr/x', true)" },
      { rect: [0, 0, 1, 1], js: "this.print()" },
      { rect: [0, 0, 1, 1], file: "http://b.kr/doc.pdf#old", dest: "chap1" },
    ]), 0).map(a => a.url)
    assert.deepEqual(urls, ["https://a.kr/x", undefined, "http://b.kr/doc.pdf#chap1"])
  })
})

describe("글 정규화", () => {
  it("합자·호환 글자를 풀고(ﬁ → fi), ﬅ 는 ſt", () => {
    assert.equal(normalizeUnicode("ﬁle ﬅ 한글"), "file ſt 한글")
  })
})
