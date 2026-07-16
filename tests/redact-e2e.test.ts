/** redact 배선 e2e — 생성 HWPX의 PII를 parse→redactMarkdown→patchHwpx로 서식 보존 마스킹 (killer feature #2) */
import { describe, it } from "node:test"
import assert from "node:assert"
import { markdownToHwpx, parse, patchHwpx, redactMarkdown } from "../src/index.js"

describe("redact e2e (HWPX 서식 보존 마스킹)", () => {
  it("주민번호·전화·이메일이 patch 후 재파싱에서 마스킹돼 있다", async () => {
    const md = [
      "# 개인정보 포함 문서",
      "",
      "신청인 주민등록번호는 850315-1234567 이고 연락처는 010-1234-5678 입니다.",
      "",
      "| 항목 | 값 |",
      "| --- | --- |",
      "| 이메일 | hong@example.com |",
    ].join("\n")
    const hwpx = await markdownToHwpx(md)
    const parsed = await parse(hwpx)
    assert.ok(parsed.success)

    const r = redactMarkdown(parsed.markdown)
    assert.ok(r.hits.length >= 3, `히트 3건 이상이어야 함 (실제 ${r.hits.length})`)
    assert.ok(r.hits.some(h => h.rule === "rrn"))
    assert.ok(r.hits.some(h => h.rule === "phone"))
    assert.ok(r.hits.some(h => h.rule === "email"))

    const patched = await patchHwpx(new Uint8Array(hwpx), r.text)
    assert.ok(patched.success && patched.data, `patch 실패: ${patched.error}`)

    const reparsed = await parse(patched.data!.buffer as ArrayBuffer)
    assert.ok(reparsed.success)
    const final = reparsed.markdown
    assert.ok(!final.includes("850315-1234567"), "주민번호 원문이 남아 있음")
    assert.ok(!final.includes("010-1234-5678"), "전화번호 원문이 남아 있음")
    assert.ok(!final.includes("hong@example.com"), "이메일 원문이 남아 있음")
    assert.ok(final.includes("850315-●●●●●●●"), "서식 보존 마스킹 형태가 아님")
    assert.ok(final.includes("010-●●●●-5678"))
    assert.ok(final.includes("h●●●@example.com"))
  })

  it("redactMarkdown은 base64 이미지 라인을 건드리지 않는다", () => {
    const b64line = "![image](data:image/png;base64,iVBORw0KGgo01012345678AAAA)"
    const md = "전화 010-9876-5432\n" + b64line
    const r = redactMarkdown(md)
    assert.ok(r.text.includes(b64line), "data URI 라인이 변형됨")
    assert.ok(r.text.includes("010-●●●●-5432"))
    assert.equal(r.hits.length, 1)
  })
})
