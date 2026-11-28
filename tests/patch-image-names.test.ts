/** patch 입구: parse() 가 바꾼 그림 확장자를 원본 이름으로 맞춘다 (alignImageNames) */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { alignImageNames } from "../src/roundtrip/markdown-units.js"

describe("그림 파일명 맞추기", () => {
  it("번호가 같고 확장자만 다른 참조는 원본 이름으로 — 칸 안 그림도", () => {
    const orig = "가\n\n![image](image_001.bmp)\n\n| 광<br>![image](image_002.gif) |"
    const edited = "가 고침\n\n![image](image_001.png)\n\n| 광<br>![image](image_002.png) |"
    assert.equal(alignImageNames(edited, orig), "가 고침\n\n![image](image_001.bmp)\n\n| 광<br>![image](image_002.gif) |")
  })

  it("원본에 없는 번호·그림 없는 원본은 그대로", () => {
    assert.equal(alignImageNames("![image](image_009.png)", "![image](image_001.bmp)"), "![image](image_009.png)")
    assert.equal(alignImageNames("![image](image_001.png)", "그림 없음"), "![image](image_001.png)")
  })
})
