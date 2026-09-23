/** 공문서 정렬·줄바꿈·문자 다듬기 (v4.14.2) — 부호 뒤 탭(내어쓰기용 자동 탭)·어절 줄바꿈·묶음 빈칸·따옴표·실글꼴 폭 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parse, patchHwpx } from "../src/index.js"
import { polishGongmunText } from "../src/hwpx/gongmun-typo.js"
import { fontAdvanceEm1000 } from "../src/hwpx/font-metrics.js"
import { measureTextWidth, faceClassForGen, simulateWrap } from "../src/hwpx/text-metrics.js"
import { markerLayout } from "../src/hwpx/gen-marker.js"
import { fitParagraph } from "../src/hwpx/fit-line.js"
import { tabAdvance, buildPara } from "../src/render/para-model.js"
import { DEFAULT_PARA_GEOM } from "../src/render/head-styles.js"
import { reflowSection } from "../src/render/reflow.js"
import { faceClassOf } from "../src/hwpx/text-metrics.js"
import { resolveGongmun, mmToHwpunit } from "../src/hwpx/gongmun.js"
import { MINISTRY } from "../src/hwpx/gen-frame-ministry.js"
import { DOMParser } from "@xmldom/xmldom"

async function parts(buf: ArrayBuffer): Promise<{ sec: string; head: string }> {
  const z = await JSZip.loadAsync(buf)
  return { sec: await z.file("Contents/section0.xml")!.async("text"), head: await z.file("Contents/header.xml")!.async("text") }
}
/** 텍스트를 담은 문단 XML */
const paraOf = (sec: string, text: string): string => {
  const at = sec.indexOf(text)
  assert.ok(at > 0, `문단 없음: ${text}`)
  return sec.slice(sec.lastIndexOf("<hp:p ", at), sec.indexOf("</hp:p>", at) + 7)
}
const paraPrOf = (head: string, p: string): string => {
  const id = p.match(/paraPrIDRef="(\d+)"/)![1]
  return head.match(new RegExp(`<hh:paraPr id="${id}"[\\s\\S]*?</hh:paraPr>`))![0]
}

describe("부호 뒤 탭 — 첫 줄 내용과 둘째 줄 정렬", () => {
  it("v5 항목·참고는 부호 run(부호 + 탭) + 내용 run, 문단은 내어쓰기용 자동 탭(tabPr 1)", async () => {
    const { sec, head } = await parts(await markdownToHwpx("# 보고\n\n> 검토하고자 함\n\n### 대항목\n\n- 중항목 내용\n  - ※ 참고 내용", { gongmun: { preset: "report" } }))
    assert.match(head, /<hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"\/>/)
    for (const [marker, text] of [["□", "대항목"], ["ㅇ", "중항목 내용"], ["※", "참고 내용"]]) {
      const p = paraOf(sec, text)
      assert.match(p, new RegExp(`<hp:t>${marker}<hp:tab width="\\d+" leader="0" type="1"/></hp:t></hp:run><hp:run charPrIDRef="\\d+"><hp:t>${text}`), `${marker} 부호 run + 탭`)
      const pr = paraPrOf(head, p)
      assert.ok(pr.includes('tabPrIDRef="1"'), `${marker} 자동 탭`)
      // 내어쓰기 = 부호 실폭 + 1타 → 탭 정지점 = 둘째 줄 시작
      assert.ok(Number(pr.match(/<hc:intent value="(-\d+)"/)![1]) < 0, `${marker} 내어쓰기`)
    }
  })

  it("기안문 법정 부호(1. 가.)도 탭, 개조식·보도자료(gen-section)도 탭", async () => {
    const official = await parts(await markdownToHwpx("# 제목\n\n1. 관련 근거\n\n  가. 세부 내용", { gongmun: { preset: "official" } }))
    assert.match(paraOf(official.sec, "관련 근거"), /<hp:t>1\.<hp:tab /)
    for (const preset of ["gaejosik", "press"] as const) {
      const { sec, head } = await parts(await markdownToHwpx("# 제목\n\n### 대항목\n\n- 중항목\n  - 소항목", { gongmun: { preset } }))
      const p = paraOf(sec, "소항목")
      assert.match(p, /<hp:tab width="\d+" leader="0" type="1"\/><\/hp:t><\/hp:run>/, `${preset} 부호 뒤 탭`)
      assert.ok(paraPrOf(head, p).includes('tabPrIDRef="1"'), `${preset} 자동 탭`)
    }
  })

  it("내어쓰기 = 부호 실폭(한컴돋움 ○ 1.0em) + 1타", () => {
    const lay = markerLayout("한컴돋움", 15, 1, "○")
    assert.deepEqual(lay, { left: 750, hang: 1500 + 750, markerW: 1500 })
  })

  it("렌더 탭 정지점 — 첫 줄은 내어쓰기 위치, 그 밖엔 기본 40pt", () => {
    const geom = { ...DEFAULT_PARA_GEOM, marginIntent: -2250, autoTabLeft: true }
    assert.equal(tabAdvance(1500, true, geom), 750)
    assert.equal(tabAdvance(1500, false, geom), 2500)
    assert.equal(tabAdvance(1500, true, { ...geom, autoTabLeft: false }), 2500)
  })
})

describe("어절 줄바꿈·외톨이줄 보호 (v5)", () => {
  it("본문·요약박스·표 셀 모두 BREAK_WORD(어절), 본문은 widowOrphan", async () => {
    const { sec, head } = await parts(await markdownToHwpx("# 보고\n\n> 목적을 검토하고자 함\n\n- 항목\n\n| 구분 | 내용 |\n|---|---|\n| 가 | 나 |", { gongmun: { preset: "report" } }))
    for (const t of ["목적을 검토하고자 함", "항목", "나"]) {
      const pr = paraPrOf(head, paraOf(sec, t))
      assert.ok(pr.includes('breakNonLatinWord="BREAK_WORD"'), `${t}: 어절`)
    }
    assert.ok(paraPrOf(head, paraOf(sec, "항목")).includes('widowOrphan="1"'))
  })
})

describe("문자 다듬기 — 묶음 빈칸·따옴표", () => {
  it("날짜·연월·월일·시각 범위·금액의 공백은 U+00A0, 따옴표는 ‘’“”·연도 약식 ’26", () => {
    const n = (s: string) => polishGongmunText(s).replace(/\u00a0/g, "⍽")
    assert.equal(n("2026. 1. 22. 시행, 2026. 2. 확정"), "2026.⍽1.⍽22. 시행, 2026.⍽2. 확정")
    assert.equal(n("용역 2026. 5. 7.~11. 6.(3억 원)"), "용역 2026.⍽5.⍽7.~11.⍽6.(3억⍽원)")
    assert.equal(n("회의 14:00 ~ 16:00, 992억 5,700만 원"), "회의 14:00⍽~⍽16:00, 992억 5,700만⍽원")
    assert.equal(n("'미확인'은 \"예시\"이고 '26. 9. 9.까지"), "‘미확인’은 “예시”이고 ’26.⍽9.⍽9.까지")
    // 소수·버전·개수 앞 숫자는 날짜가 아니다
    assert.equal(n("0.2%, v1.2. 3개, 3. 12개 과제"), "0.2%, v1.2. 3개, 3. 12개 과제")
    // 인라인 코드·링크 URL 은 그대로
    assert.equal(n("`'x' 2026. 1. 1.` [링크](https://a.b/'q')"), "`'x' 2026. 1. 1.` [링크](https://a.b/'q')")
  })

  it("생성물은 <hp:nbSpace/>(묶음 빈칸)로 내고, 파서는 공백으로 읽는다", async () => {
    const buf = await markdownToHwpx("# 보고\n\n> 검토하고자 함\n\n- 기준일 2026. 9. 23. '확정'", { gongmun: { preset: "report" } })
    const { sec } = await parts(buf)
    assert.ok(sec.includes("2026.<hp:nbSpace/>9.<hp:nbSpace/>23."), "날짜 묶음 빈칸")
    const r = await parse(buf)
    assert.ok(r.success && r.markdown.includes("기준일 2026. 9. 23. ‘확정’"), r.success ? r.markdown : "")
  })
})

describe("실글꼴 폭표·조판 비용", () => {
  it("한컴돋움 가운뎃점 0.331em·HY견고딕 숫자 0.625em·휴먼명조 한글 1.0em (한컴오피스 번들 TTF)", () => {
    assert.equal(fontAdvanceEm1000("한컴돋움", 0xb7), 331)
    assert.equal(fontAdvanceEm1000("HY견고딕", 0x31), 625)
    assert.equal(fontAdvanceEm1000("휴먼명조", 0xac00), 1000)
    assert.equal(fontAdvanceEm1000("없는글꼴", 0xac00), null)
    // 묶음 빈칸은 공백 폭(0.5em)
    assert.equal(measureTextWidth("가\u00a0나", 1000, 100, { faceClass: faceClassForGen("한컴돋움") }), 2500)
  })

  it("fitParagraph — 짧은 꼬리 줄은 한 줄 줄이고, 넉넉한 둘째 줄은 그대로", () => {
    const fc = faceClassForGen("한컴돋움"), W = 40000
    const wrap = (t: string) => simulateWrap(t, W * 0.995, W * 0.995, 1500, 100, "keep", { faceClass: fc })
    let t = "가나다 라마바"
    while (!(wrap(t).lines === 2 && wrap(t).lastLineWidth < W * 0.1)) t += " 사아"
    const f = fitParagraph(t, "한컴돋움", 15, W, W)
    assert.ok(f && (f.spacing < 0 || f.ratio < 100), "고아 줄 압축")
    let u = t
    while (!(wrap(u).lines === 2 && wrap(u).lastLineWidth > W * 0.5)) u += " 자차"
    assert.equal(fitParagraph(u, "한컴돋움", 15, W, W), null)
  })
})

describe("패치 — 부호 run 보존", () => {
  it("생성 문서 항목 내용을 고쳐도 부호 run·탭은 그대로, 내용 run 만 다시 쓴다", async () => {
    const buf = await markdownToHwpx("# 보고\n\n> 검토하고자 함\n\n### 대항목\n\n- 첫째 내용\n- 둘째 내용", { gongmun: { preset: "report" } })
    const r = await parse(buf)
    assert.ok(r.success)
    const res = await patchHwpx(new Uint8Array(buf), r.markdown.replace("둘째 내용", "둘째 내용을 고쳤음"))
    assert.ok(res.success && res.applied === 1)
    const { sec } = await parts(res.data!.buffer.slice(res.data!.byteOffset, res.data!.byteOffset + res.data!.byteLength) as ArrayBuffer)
    assert.match(paraOf(sec, "둘째 내용을 고쳤음"), /<hp:t>ㅇ<hp:tab [^>]*\/><\/hp:t><\/hp:run><hp:run charPrIDRef="\d+"><hp:t>둘째 내용을 고쳤음<\/hp:t>/)
  })
})

describe("경계 사례 — 별표 강조·두 자리 번호·표지 묶음 빈칸·압축 하한·렌더", () => {
  it("인용문 '**강조** 내용'은 ※ 참고 — 강조 별표를 부호로 떼지 않는다", async () => {
    const { sec } = await parts(await markdownToHwpx("# 제목\n\n### 대항목\n\n> **강조** 내용", { gongmun: { preset: "gaejosik" } }))
    const p = paraOf(sec, "강조")
    assert.match(p, /<hp:t>※<hp:tab /)
    assert.doesNotMatch(p, /<hp:t>\*<hp:tab /)
  })

  it("h2 두 자리 번호(10.)는 공백으로 잇는다 — 내어쓰기보다 넓어 탭이 기본 탭 칸으로 튄다", async () => {
    const names = ["첫째", "둘째", "셋째", "넷째", "다섯째", "여섯째", "일곱째", "여덟째", "아홉째", "열째"]
    const md = "# 보도\n\n" + names.map((n) => `## ${n} 절\n\n본문`).join("\n\n")
    const { sec } = await parts(await markdownToHwpx(md, { gongmun: { preset: "press", h2Marker: "number" } }))
    assert.match(paraOf(sec, "아홉째 절"), /<hp:t>9\.<hp:tab /)
    assert.match(paraOf(sec, "열째 절"), /<hp:t>10\. 열째 절<\/hp:t>/)
  })

  it("표지·목차·장 제목·표·참고까지 묶음 빈칸은 <hp:nbSpace/> — 문자 U+00A0 를 XML 에 남기지 않는다", async () => {
    const md = "# 2026. 9. 23. 업무 보고\n\n## 2026. 9. 추진 배경\n\n### 대항목 9. 23. 확정\n\n- 내용 3억 원\n\n| 구분 | 일자 |\n|---|---|\n| 가 | 2026. 9. 23. |\n\n> 참고 9. 23. 확정"
    for (const preset of ["gaejosik", "press", "report", "official"] as const) {
      const { sec } = await parts(await markdownToHwpx(md, { gongmun: { preset } }))
      assert.ok(!sec.includes("\u00a0"), `${preset}: 문자 U+00A0`)
      assert.ok(sec.includes("<hp:nbSpace/>"), `${preset}: 묶음 빈칸`)
    }
  })

  it("autoFit.minRatio 는 문단 압축의 장평 하한, autoFit false 면 참고(※)도 무압축", async () => {
    const W = 40000
    let t = "가나다 라마바"
    for (let i = 0; i < 80; i++, t += " 사아자") {
      const f = fitParagraph(t, "한컴돋움", 15, W, W, 97)
      if (f) assert.ok(f.ratio >= 97, `장평 ${f.ratio}`)
    }
    const refs = Array.from({ length: 24 }, (_, i) => `  - ※ 참고 ${"내용을 적음 ".repeat(6 + i)}끝`).join("\n")
    const md = `# 보고\n\n> 검토하고자 함\n\n### 대항목\n\n- 항목\n${refs}`
    const squeezed = async (autoFit?: false): Promise<number> => {
      const { sec, head } = await parts(await markdownToHwpx(md, { gongmun: { preset: "report", ...(autoFit === false ? { autoFit } : {}) } }))
      let n = 0
      for (const m of sec.matchAll(/<hp:t>※<hp:tab [^>]*\/><\/hp:t><\/hp:run><hp:run charPrIDRef="(\d+)">/g)) {
        const pr = head.match(new RegExp(`<hh:charPr id="${m[1]}"[\\s\\S]*?</hh:charPr>`))![0]
        if (!/<hh:ratio hangul="100"/.test(pr) || !/<hh:spacing hangul="0"/.test(pr)) n++
      }
      return n
    }
    assert.ok((await squeezed()) > 0, "기본은 고아 줄을 압축")
    assert.equal(await squeezed(false), 0)
  })

  it("줄바꿈은 묶음 빈칸에서 끊지 않는다 — 어절·글자 단위 모두", () => {
    const fc = faceClassForGen("한컴돋움")
    const text = "가".repeat(10) + " 2026.\u00a09.\u00a023."
    const W = measureTextWidth("가".repeat(10) + " 2026.\u00a09.", 1000, 100, { faceClass: fc }) + 100
    for (const mode of ["keep", "charAll"] as const) assert.deepEqual(simulateWrap(text, W, W, 1000, 100, mode, { faceClass: fc }).starts, [0, 11], mode)
  })

  it("렌더 reflow — hp:nbSpace 는 공백으로 그리되 줄은 날짜 앞에서 바꾼다", () => {
    const xml = `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>${"가".repeat(10)} 2026.<hp:nbSpace/>9.<hp:nbSpace/>23.</hp:t></hp:run></hp:p></hs:sec>`
    const root = new DOMParser().parseFromString(xml, "text/xml").documentElement as unknown as Element
    const p = root.getElementsByTagName("hp:p")[0]
    assert.deepEqual(buildPara(p).chars.filter((c) => c.nb).map((c) => c.ch), [" ", " "])
    const W = measureTextWidth("가".repeat(10) + " 2026.\u00a09.", 1000, 100, { faceClass: faceClassOf(undefined) }) + 100
    reflowSection(root, { charPr: new Map(), paraAlign: new Map(), paraGeom: new Map(), borderFill: new Map() }, { BODY_W: W, BODY_H: 100000 })
    const segs = p.getElementsByTagName("hp:lineseg")
    const starts: number[] = []
    for (let i = 0; i < segs.length; i++) starts.push(Number(segs[i].getAttribute("textpos")))
    assert.deepEqual(starts, [0, 11])
  })

  it("따옴표 — 링크·코드 뒤 첫머리는 앞 구간 끝 글자로, 태그 뒤는 여는 따옴표", () => {
    assert.equal(polishGongmunText("'[링크](https://a.b)' 참조"), "‘[링크](https://a.b)’ 참조")
    assert.equal(polishGongmunText("'`x`' 값"), "‘`x`’ 값")
    assert.equal(polishGongmunText('<center>"제목"</center>'), "<center>“제목”</center>")
  })

  it("렌더 탭 — 첫 줄 자동 탭이 우선, 그 밖엔 저장된 탭 폭(한컴 조판값), 없으면 기본 40pt", () => {
    const geom = { ...DEFAULT_PARA_GEOM, marginIntent: -2250, autoTabLeft: true }
    assert.equal(tabAdvance(1500, true, geom, 999), 750)
    assert.equal(tabAdvance(1500, false, geom, 3000), 3000)
    assert.equal(tabAdvance(1500, false, geom), 2500)
  })

  it("업무보고 항목 띠는 한 줄 — 조금 넘치면 장평·자간으로 담고, 크게 넘치면 압축하지 않는다", async () => {
    const g = resolveGongmun({ preset: "ministry" })
    const avail = mmToHwpunit(210 - g.margins.left - g.margins.right) - 1800
    const fc = faceClassForGen(MINISTRY.bandFont)
    const bandOf = async (scale: number) => {
      let text = "(물가) 민생"
      while (measureTextWidth(text, MINISTRY.item.pt * 100, 100, { faceClass: fc }) < avail * scale) text += " 물가관리"
      const { sec, head } = await parts(await markdownToHwpx(`# 업무보고\n\n## 장\n\n##### ${text}\n\nㅇ 항목`, { gongmun: { preset: "ministry" } }))
      const at = sec.indexOf('name="__kordoc_h5"')
      const cell = sec.slice(at, sec.indexOf("</hp:tc>", at))
      const id = [...cell.matchAll(/<hp:run charPrIDRef="(\d+)"><hp:t>([^<]*)/g)].find((m) => m[2].includes("민생"))![1]
      const pr = head.match(new RegExp(`<hh:charPr id="${id}"[\\s\\S]*?</hh:charPr>`))![0]
      return { text, ratio: Number(pr.match(/<hh:ratio hangul="(\d+)"/)![1]), spacing: Number(pr.match(/<hh:spacing hangul="(-?\d+)"/)![1]) }
    }
    const near = await bandOf(1.12)
    assert.ok(near.ratio < 100 || near.spacing < 0, "조금 넘치면 압축")
    const body = near.text.replace(/^\(물가\) /, "")
    assert.ok(measureTextWidth(body, MINISTRY.item.pt * 100, near.ratio, { faceClass: fc, spacingPct: near.spacing }) <= avail, "압축 뒤 한 줄")
    const far = await bandOf(1.6)
    assert.deepEqual([far.ratio, far.spacing], [100, 0])
  })
})
