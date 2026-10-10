import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"

// 한컴 기준 폭표로 98%까지 차서 "한 줄"로 본 항목. rhwp 등 다른 조판기는 두 글자가 넘친다(생성 보고서 9건 실측 25곳)
const LINE = "현행 2대 발급기는 모두 2019년 설치되어 기기 노후화 정도 높음"
const MD = `# 계획\n\n## 추진 배경\n\n□ 기존 발급기 노후화\n  ㅇ ${LINE}\n`

async function squeeze(autoFit?: { safety?: number }) {
  const data = await markdownToHwpx(MD, { gongmun: { preset: "report", cover: false, ...(autoFit ? { autoFit } : {}) } })
  const zip = await JSZip.loadAsync(data)
  const sec = await zip.file("Contents/section0.xml")!.async("text")
  const head = await zip.file("Contents/header.xml")!.async("text")
  const item = [...sec.matchAll(/<hp:p\b[^>]*>[\s\S]*?<\/hp:p>/g)].find(m => m[0].includes("노후화 정도"))![0]
  const id = [...item.matchAll(/<hp:run charPrIDRef="(\d+)"><hp:t>([^<]*)/g)].find(m => m[2].includes("현행"))![1]
  const char = head.match(new RegExp('<hh:charPr id="' + id + '"[\\s\\S]*?</hh:charPr>'))![0]
  const ratio = Number(char.match(/<hh:ratio hangul="(\d+)"/)![1])
  const spacing = Number(char.match(/<hh:spacing hangul="(-?\d+)"/)![1])
  return 1 - (ratio / 100) * (1 + spacing / 100)
}

describe("autoFit.safety", () => {
  it("낮추면 꽉 찬 줄을 기본보다 더 줄여 여유를 둔다", async () => {
    const base = await squeeze()
    const safe = await squeeze({ safety: 0.96 })
    assert.ok(safe > base, `압축량 기본 ${base} → safety 0.96 ${safe}`)
  })
  it("기본(0.98)보다 느슨한 값은 효과가 없다", async () => {
    assert.equal(await squeeze({ safety: 1 }), await squeeze())
  })
  it("범위를 벗어나면 막는다", async () => {
    await assert.rejects(markdownToHwpx(MD, { gongmun: { preset: "report", autoFit: { safety: 0.5 } } }), /autoFit\.safety/)
  })
})
