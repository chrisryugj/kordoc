/** HWPX 구조 검증 (validateHwpx) 테스트 — 생성기 산출물 자기검증 + 결함 주입 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { validateHwpx } from "../src/validate.js"

/** 생성기 산출물을 열어 변형을 가한 뒤 다시 zip 버퍼로 */
async function tamper(buf: ArrayBuffer, mutate: (zip: JSZip) => void | Promise<void>): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(buf)
  await mutate(zip)
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("validateHwpx", () => {
  it("markdownToHwpx 산출물은 검증을 통과한다 (자기검증 게이트)", async () => {
    const buf = await markdownToHwpx("# 제목\n\n본문 문단입니다.\n\n| 구분 | 내용 |\n| --- | --- |\n| 가 | 나 |")
    const result = await validateHwpx(buf)
    assert.deepEqual(result.issues, [], "생성기 산출물에 구조 문제가 없어야 함")
    assert.equal(result.ok, true)
    assert.ok(result.entryCount >= 5, "필수 엔트리 이상 존재")
  })

  it("ZIP이 아닌 버퍼는 즉시 실패", async () => {
    const result = await validateHwpx(new Uint8Array([1, 2, 3, 4]))
    assert.equal(result.ok, false)
    assert.match(result.issues[0].message, /ZIP/)
  })

  it("필수 파일 누락을 잡는다", async () => {
    const buf = await markdownToHwpx("본문")
    const broken = await tamper(buf, zip => zip.remove("Contents/header.xml"))
    const result = await validateHwpx(broken)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some(i => i.message.includes("Contents/header.xml")), "header.xml 누락 보고")
  })

  it("XML 웰폼드 위반을 잡는다", async () => {
    const buf = await markdownToHwpx("본문")
    const broken = await tamper(buf, zip => {
      zip.file("Contents/section0.xml", "<hs:sec><hp:p>닫히지 않음</hs:sec>")
    })
    const result = await validateHwpx(broken)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some(i => i.path === "Contents/section0.xml" && i.message.includes("웰폼드")))
  })

  it("secCnt와 실제 섹션 수 불일치를 잡는다", async () => {
    const buf = await markdownToHwpx("본문")
    const broken = await tamper(buf, async zip => {
      const header = await zip.files["Contents/header.xml"].async("string")
      assert.match(header, /secCnt="1"/, "전제: 생성기 헤더의 secCnt=1")
      zip.file("Contents/header.xml", header.replace(/secCnt="1"/, 'secCnt="3"'))
    })
    const result = await validateHwpx(broken)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some(i => i.message.includes("secCnt=3")))
  })

  it("manifest의 깨진 참조를 잡는다", async () => {
    const buf = await markdownToHwpx("본문")
    const broken = await tamper(buf, async zip => {
      const hpf = await zip.files["Contents/content.hpf"].async("string")
      zip.file(
        "Contents/content.hpf",
        hpf.replace(
          "</opf:manifest>",
          '<opf:item id="ghost" href="Contents/ghost.xml" media-type="application/xml"/></opf:manifest>',
        ),
      )
    })
    const result = await validateHwpx(broken)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some(i => i.message.includes("Contents/ghost.xml")))
  })

  it("manifest href가 Contents/ 상대경로(표준 OCF/한컴 원본)여도 오탐 없이 통과", async () => {
    // kordoc 생성기는 href="Contents/xxx"로 쓰지만 한컴 원본은 href="xxx"(Contents/ 기준 상대).
    // 후자를 "없는 파일 참조"로 오탐하면 정상 파일을 결함으로 보고하는 버그가 된다.
    const buf = await markdownToHwpx("본문")
    const relativized = await tamper(buf, async zip => {
      const hpf = await zip.files["Contents/content.hpf"].async("string")
      zip.file("Contents/content.hpf", hpf.replace(/href="Contents\//g, 'href="'))
    })
    const result = await validateHwpx(relativized)
    assert.deepEqual(result.issues, [], "상대경로 href도 통과해야 함")
    assert.equal(result.ok, true)
  })

  it("mimetype 내용이 다르면 잡는다", async () => {
    const buf = await markdownToHwpx("본문")
    const broken = await tamper(buf, zip => {
      zip.file("mimetype", "application/zip")
    })
    const result = await validateHwpx(broken)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some(i => i.path === "mimetype"))
  })

  it("mimetype이 첫 엔트리가 아니면 잡는다", async () => {
    const src = await JSZip.loadAsync(await markdownToHwpx("본문"))
    const reordered = new JSZip()
    // mimetype을 마지막에 넣어 첫 엔트리 규칙 위반을 재현
    for (const name of Object.keys(src.files).filter(n => !src.files[n].dir && n !== "mimetype")) {
      reordered.file(name, await src.files[name].async("uint8array"))
    }
    reordered.file("mimetype", await src.files["mimetype"].async("string"))
    const result = await validateHwpx(await reordered.generateAsync({ type: "arraybuffer" }))
    assert.equal(result.ok, false)
    assert.ok(result.issues.some(i => i.message.includes("첫 zip 엔트리")))
  })
})
