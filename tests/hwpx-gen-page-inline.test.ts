/**
 * v4.5.0 생성 신기능 테스트 — 페이지 옵션(용지·방향·다단·머리말/꼬리말),
 * 하이퍼링크 필드, 각주 개체, 이미지 실데이터 임베드.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { resolvePage } from "../src/hwpx/gen-page.js"
import { probeImageSize } from "../src/hwpx/gen-image.js"
import { parse } from "../src/index.js"

async function sectionOf(buf: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  return zip.file("Contents/section0.xml")!.async("string")
}

/** 3×2 픽셀 PNG — 실데이터 임베드·치수 프로브 검증용 */
const PNG_3x2 = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAADzHBLtAAAADUlEQVR4nGP8z8DAAAAGBAEAmFVPmQAAAABJRU5ErkJggg==",
  "base64",
))

describe("페이지 옵션 (v4.5.0)", () => {
  it("기본(옵션 없음)은 종전 pagePr 그대로 — A4 세로 1단", async () => {
    const sec = await sectionOf(await markdownToHwpx("본문"))
    assert.ok(sec.includes('landscape="WIDELY" width="59528" height="84188"'))
    assert.ok(sec.includes('colCount="1" sameSz="1" sameGap="0"'))
    assert.ok(!sec.includes("<hp:header"), "머리말 미방출")
  })

  it("가로 방향 — landscape=NARROWLY, 용지 치수는 유지 (코퍼스 실측 계약)", async () => {
    const sec = await sectionOf(await markdownToHwpx("본문", { page: { orientation: "landscape" } }))
    assert.ok(sec.includes('landscape="NARROWLY" width="59528" height="84188"'))
  })

  it("용지 프리셋 — A3 치수는 내림 정준(84188×119055)", async () => {
    const sec = await sectionOf(await markdownToHwpx("본문", { page: { size: "A3" } }))
    assert.ok(sec.includes('width="84188" height="119055"'))
  })

  it("커스텀 mm 치수 + 잘못된 값 거부", async () => {
    const sec = await sectionOf(await markdownToHwpx("본문", { page: { size: { widthMm: 100, heightMm: 150 } } }))
    assert.ok(sec.includes(`width="${Math.floor((100 * 7200) / 25.4)}"`))
    await assert.rejects(() => markdownToHwpx("x", { page: { size: { widthMm: -1, heightMm: 100 } } }))
    await assert.rejects(() => markdownToHwpx("x", { page: { columns: 0 } }))
    assert.equal(resolvePage(undefined), null)
    assert.equal(resolvePage({}), null)
  })

  it("다단 — colCount·기본 간격 8mm(2268)", async () => {
    const sec = await sectionOf(await markdownToHwpx("본문", { page: { columns: 3 } }))
    assert.ok(sec.includes('colCount="3" sameSz="1" sameGap="2268"'))
  })

  it("머리말/꼬리말 — rhwp 형상 ctrl + 재파싱 시 본문 앞/뒤 배치", async () => {
    const buf = await markdownToHwpx("본문 문단", { page: { header: "기관 **머리말**", footer: "쪽 꼬리말" } })
    const sec = await sectionOf(buf)
    assert.ok(/<hp:ctrl><hp:header id="1" applyPageType="BOTH"><hp:subList /.test(sec))
    assert.ok(/<hp:header[\s\S]*?charPrIDRef="1"><hp:t>머리말<\/hp:t>/.test(sec), "머리말 인라인 bold")
    assert.ok(sec.includes('<hp:footer id="2"'))
    const r = await parse(buf)
    assert.ok(r.success)
    if (r.success) {
      assert.ok(r.markdown.includes("머리말"), "머리말 왕복")
      assert.ok(r.markdown.includes("쪽 꼬리말"), "꼬리말 왕복")
    }
  })

  it("공문서 모드와 병행 — 페이지 옵션이 공문 여백을 깨지 않는다", async () => {
    const sec = await sectionOf(await markdownToHwpx("# 제목\n\n1. 본문", {
      gongmun: { preset: "report" },
      page: { orientation: "landscape" },
    }))
    assert.ok(sec.includes('landscape="NARROWLY"'))
  })
})

describe("하이퍼링크 필드 (v4.5.0)", () => {
  it("[text](url) → 실측 6-param HYPERLINK 필드 + 왕복 복원", async () => {
    const buf = await markdownToHwpx("이동은 [정부24](https://www.gov.kr)에서.")
    const sec = await sectionOf(buf)
    assert.ok(sec.includes('type="HYPERLINK"'))
    assert.ok(sec.includes('name="Command">https\\://www.gov.kr;1;0;0<'), "Command 콜론 이스케이프")
    assert.ok(sec.includes('name="Path">https://www.gov.kr<'))
    assert.ok(sec.includes("fieldEnd beginIDRef="))
    const r = await parse(buf)
    assert.ok(r.success)
    if (r.success) assert.ok(r.markdown.includes("[정부24](https://www.gov.kr)"), "링크 왕복")
  })

  it("표 셀 안 링크도 필드로", async () => {
    const buf = await markdownToHwpx("| a |\n|---|\n| [셀](https://ex.am/p?a=1&b=2) |")
    const sec = await sectionOf(buf)
    assert.ok(sec.includes('name="Path">https://ex.am/p?a=1&amp;b=2<'), "XML 이스케이프")
  })

  it("위험 스킴은 필드 없이 텍스트만", async () => {
    const sec = await sectionOf(await markdownToHwpx("[x](javascript:alert(1))"))
    assert.ok(!sec.includes("HYPERLINK"))
    assert.ok(sec.includes("<hp:t>x</hp:t>"))
  })

  it("빈 anchor는 url 텍스트로 (종전 동작 유지)", async () => {
    const sec = await sectionOf(await markdownToHwpx("[](https://ex.am)"))
    assert.ok(sec.includes("<hp:t>https://ex.am</hp:t>"))
  })
})

describe("각주 개체 (v4.5.0)", () => {
  it("[^1] 마커 + 정의 → hp:footNote (rhwp 계약: suffixChar 상시) + 왕복 인라인", async () => {
    const buf = await markdownToHwpx("본문입니다.[^n]\n\n[^n]: 각주 내용")
    const sec = await sectionOf(buf)
    assert.ok(/<hp:footNote number="1" suffixChar="41" instId="\d+"><hp:subList /.test(sec))
    assert.ok(sec.includes("<hp:t>각주 내용</hp:t>"))
    assert.ok(!sec.includes("[^n]"), "마커 리터럴 잔류 없음")
    const r = await parse(buf)
    assert.ok(r.success)
    if (r.success) assert.ok(r.markdown.includes("각주 내용"), "각주 왕복")
  })

  it("정의 없는 마커는 리터럴 보존, 번호는 등장 순서", async () => {
    const buf = await markdownToHwpx("a[^1] b[^2] c[^없음]\n\n[^1]: 첫째\n[^2]: 둘째")
    const sec = await sectionOf(buf)
    assert.ok(sec.includes('number="1"') && sec.includes('number="2"'))
    assert.ok(sec.includes("[^없음]"), "미정의 마커 리터럴")
  })
})

describe("이미지 실데이터 임베드 (v4.5.0)", () => {
  it("images 옵션 바이트 → BinData 실바이트 + 실치수 pic", async () => {
    const buf = await markdownToHwpx("![사진](photo.png)", { images: { "photo.png": PNG_3x2 } })
    const zip = await JSZip.loadAsync(buf)
    const bin = await zip.file("BinData/photo.png")!.async("uint8array")
    assert.equal(bin.length, PNG_3x2.length, "실바이트 임베드")
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    // 3×2px @96dpi → 225×150 HWPUNIT
    assert.ok(sec.includes('<hp:sz width="225" widthRelTo="ABSOLUTE" height="150"'))
  })

  it("data: URI는 맵 없이 임베드", async () => {
    const b64 = Buffer.from(PNG_3x2).toString("base64")
    const buf = await markdownToHwpx(`![x](data:image/png;base64,${b64})`)
    const zip = await JSZip.loadAsync(buf)
    assert.ok(zip.file("BinData/image1.png"), "순번 파일명으로 등재")
  })

  it("바이트 없는 참조는 종전 placeholder 유지", async () => {
    const buf = await markdownToHwpx("![x](chart.png)")
    const zip = await JSZip.loadAsync(buf)
    const bin = await zip.file("BinData/chart.png")!.async("uint8array")
    assert.ok(bin.length < 100, "1×1 placeholder")
  })

  it("포맷 미상 바이트(webp 등)는 placeholder 폴백", async () => {
    const junk = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])
    const buf = await markdownToHwpx("![x](a.png)", { images: { "a.png": junk } })
    const zip = await JSZip.loadAsync(buf)
    const bin = await zip.file("BinData/a.png")!.async("uint8array")
    assert.ok(bin.length < 100, "placeholder 폴백")
  })

  it("probeImageSize — PNG/JPEG/GIF/BMP 헤더", () => {
    assert.deepEqual(probeImageSize(PNG_3x2), { w: 3, h: 2 })
    // GIF logical screen 5×7
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 7, 0, 0, 0, 0])
    assert.deepEqual(probeImageSize(gif), { w: 5, h: 7 })
    assert.equal(probeImageSize(Uint8Array.from([1, 2, 3])), null)
  })

  it("본문폭 초과 이미지는 비례 축소 캡", async () => {
    // 1000×500 BMP 헤더 위조 (데이터는 placeholder여도 치수만 검사)
    const bmp = new Uint8Array(60)
    bmp[0] = 0x42; bmp[1] = 0x4d
    new DataView(bmp.buffer).setUint32(18, 1000, true)
    new DataView(bmp.buffer).setInt32(22, 500, true)
    const buf = await markdownToHwpx("![x](big.bmp)", { images: { "big.bmp": bmp } })
    const sec = await sectionOf(buf)
    // 1000px*75=75000 > 48189 → 캡, 높이 비례 축소
    assert.ok(sec.includes('<hp:sz width="48189"'))
    const m = /<hp:sz width="48189" widthRelTo="ABSOLUTE" height="(\d+)"/.exec(sec)
    assert.ok(m && Math.abs(+m[1] - 48189 / 2) < 5, `높이 비례: ${m?.[1]}`)
  })
})
