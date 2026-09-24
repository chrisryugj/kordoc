/**
 * PDF 수식 OCR 유닛 테스트 — 외부 모델/바이너리 의존성 없는 순수 로직만 검증.
 * (e2e 테스트는 모델 다운로드 필요하므로 별도 파일에서 수행)
 */

import { describe, it } from "node:test"
import { strict as assert } from "node:assert"

import {
  postProcessLatex,
  stripTrailingWhitespace,
  collapseSpaces,
  stripEmptyGroups,
  fixLatexSpacing,
  isTrivialFormula,
  normalizeFormulaSpacing,
  hasHighRepetition,
} from "../src/pdf/formula/postprocess.js"
import { __internal } from "../src/pdf/formula/detector.js"

const { nms, iou, letterbox } = __internal

describe("formula postprocess", () => {
  it("trailing whitespace command 제거", () => {
    assert.equal(stripTrailingWhitespace("x + y \\quad"), "x + y")
    assert.equal(stripTrailingWhitespace("x + y \\,"), "x + y")
    assert.equal(stripTrailingWhitespace("x + y \\! \\,"), "x + y")
    assert.equal(stripTrailingWhitespace("x + y"), "x + y")
  })

  it("연속 공백 축약", () => {
    assert.equal(collapseSpaces("a   b   c"), "a b c")
    assert.equal(collapseSpaces(" a b "), " a b ")
    assert.equal(collapseSpaces("\\frac{a}{b}"), "\\frac{a}{b}")
  })

  it("빈 그룹 제거 — 상첨자", () => {
    assert.equal(stripEmptyGroups("x^{} y"), "x y")
    assert.equal(stripEmptyGroups("x_{} y"), "x y")
    assert.equal(stripEmptyGroups("x_{ } y"), "x y")
  })

  it("빈 그룹 제거 — \\cmd{}", () => {
    assert.equal(stripEmptyGroups("\\hat{} y"), " y")
    assert.equal(stripEmptyGroups("\\bar{ } y"), " y")
    assert.equal(stripEmptyGroups("\\vec{}{x}"), "{x}")
  })

  it("clean LaTeX 에서는 idempotent (공백 없는 형태)", () => {
    const s = "\\frac{a}{b}"
    assert.equal(postProcessLatex(s), s)
    // normalizeFormulaSpacing 이 연산자 주변 공백을 제거 (LaTeX math mode 에선 의미 동일)
    assert.equal(postProcessLatex("x^{2}+y^{2}=z^{2}"), "x^{2}+y^{2}=z^{2}")
    assert.equal(postProcessLatex("x^{2} + y^{2} = z^{2}"), "x^{2}+y^{2}=z^{2}")
  })

  it("복합 후처리", () => {
    // trailing quad + 빈 sup + 연속 공백 — normalizer 로 `\sum_{i=1}` 뒤 공백 제거
    const raw = "\\sum_{i=1}^{} x_i   \\quad"
    assert.equal(postProcessLatex(raw), "\\sum_{i=1}x_i")
  })
})

describe("fixLatexSpacing", () => {
  it("\\cmd 뒤 영문자 분리", () => {
    assert.equal(fixLatexSpacing("\\cdotd"), "\\cdot d")
    assert.equal(fixLatexSpacing("\\timesd_{k}"), "\\times d_{k}")
    assert.equal(fixLatexSpacing("O(n^{2}\\cdotd)"), "O(n^{2}\\cdot d)")
  })

  it("\\cmd 뒤 중괄호는 영향 없음", () => {
    assert.equal(fixLatexSpacing("\\mathrm{model}"), "\\mathrm{model}")
    assert.equal(fixLatexSpacing("\\frac{a}{b}"), "\\frac{a}{b}")
    assert.equal(fixLatexSpacing("\\sqrt{d_{k}}"), "\\sqrt{d_{k}}")
  })

  it("\\cmd 뒤 공백이 이미 있으면 유지", () => {
    assert.equal(fixLatexSpacing("\\cdot d"), "\\cdot d")
    assert.equal(fixLatexSpacing("\\times d_{k}"), "\\times d_{k}")
  })

  it("일반 텍스트는 변경 없음", () => {
    assert.equal(fixLatexSpacing("x + y = z"), "x + y = z")
    assert.equal(fixLatexSpacing("d_{k}=d_{v}=64"), "d_{k}=d_{v}=64")
  })
})

describe("normalizeFormulaSpacing", () => {
  it("\\mathrm 내부 character 공백 제거", () => {
    assert.equal(
      normalizeFormulaSpacing("\\mathrm { m o d d }"),
      "\\mathrm{modd}",
    )
    assert.equal(
      normalizeFormulaSpacing("\\mathrm { M u l t i H e a d }"),
      "\\mathrm{MultiHead}",
    )
  })

  it("숫자 사이 공백 제거", () => {
    assert.equal(normalizeFormulaSpacing("6 4"), "64")
    assert.equal(normalizeFormulaSpacing("2 0 1 8"), "2018")
    assert.equal(normalizeFormulaSpacing("d = 5 1 2"), "d=512")
  })

  it("괄호/구두점 주변 공백 제거", () => {
    assert.equal(normalizeFormulaSpacing("( Q, K, V )"), "(Q,K,V)")
    assert.equal(normalizeFormulaSpacing("h \\~ = 8"), "h\\~=8")
  })

  it("\\cmd 뒤 변수 공백 유지", () => {
    assert.equal(normalizeFormulaSpacing("\\cdot d"), "\\cdot d")
    assert.equal(normalizeFormulaSpacing("\\alpha b"), "\\alpha b")
    assert.equal(normalizeFormulaSpacing("O ( n \\cdot d )"), "O(n\\cdot d)")
  })

  it("첨자/중괄호 주변 공백 제거", () => {
    assert.equal(normalizeFormulaSpacing("d _ { k }"), "d_{k}")
    assert.equal(normalizeFormulaSpacing("W _ { i } ^ { Q }"), "W_{i}^{Q}")
  })

  it("연속 공백 정리", () => {
    assert.equal(normalizeFormulaSpacing("a   b"), "ab")
    assert.equal(normalizeFormulaSpacing("\\cdot   d"), "\\cdot d")
  })

  it("빈 문자열/공백만", () => {
    assert.equal(normalizeFormulaSpacing(""), "")
    assert.equal(normalizeFormulaSpacing("   "), "")
  })
})

describe("isTrivialFormula", () => {
  it("2자 이하 trivial", () => {
    assert.equal(isTrivialFormula("O"), true)
    assert.equal(isTrivialFormula("a"), true)
    assert.equal(isTrivialFormula("."), true)
    assert.equal(isTrivialFormula("n"), true)
    assert.equal(isTrivialFormula("{O}"), true) // 중괄호 제거 후 1자
    assert.equal(isTrivialFormula(" x "), true)
    assert.equal(isTrivialFormula("ab"), true)
  })

  it("단일 \\cmd trivial", () => {
    assert.equal(isTrivialFormula("\\imath"), true)
    assert.equal(isTrivialFormula("\\varPi"), true)
    assert.equal(isTrivialFormula("\\pi"), true)
    assert.equal(isTrivialFormula("\\eta"), true)
    assert.equal(isTrivialFormula("\\sigma"), true)
    assert.equal(isTrivialFormula("\\theta"), true)
    assert.equal(isTrivialFormula("\\emptyset"), true)
  })

  it("단일 \\mathrm 장식 trivial", () => {
    assert.equal(isTrivialFormula("\\mathrm{fcloc}"), true)
    assert.equal(isTrivialFormula("\\mathrm{abc}"), true)
    assert.equal(isTrivialFormula("\\textrm{hi}"), true)
    assert.equal(isTrivialFormula("\\operatorname{max}"), true)
  })

  it("반복 토큰 dominant trivial", () => {
    assert.equal(isTrivialFormula("\\pm \\pm \\pm \\pm \\pm"), true)
    assert.equal(isTrivialFormula("a a a a"), true)
    // \cap \exists \exists \rceil — 4 토큰, max=2, 50% → trivial
    assert.equal(isTrivialFormula("\\cap \\exists \\exists \\rceil"), true)
  })

  it("의미 있는 수식은 keep", () => {
    assert.equal(isTrivialFormula("O(1)"), false)
    assert.equal(isTrivialFormula("O(n^{2})"), false)
    assert.equal(isTrivialFormula("d_{k}"), false) // 4자
    assert.equal(isTrivialFormula("d_{k}=64"), false)
    assert.equal(isTrivialFormula("\\sqrt{d_{k}}"), false)
    assert.equal(isTrivialFormula("PE_{pos+k}"), false)
    assert.equal(isTrivialFormula("\\mathrm{Attention}(Q,K,V)"), false)
    assert.equal(
      isTrivialFormula("d_{k}=d_{v}=d_{\\mathrm{model}}/h=64"),
      false,
    )
    assert.equal(isTrivialFormula("\\frac{1}{\\sqrt{d_{k}}}"), false)
  })

  it("substring 반복 패턴 trivial (arxiv OCR garbage)", () => {
    // \alpha_{N}= 반복
    assert.equal(
      isTrivialFormula(
        "\\alpha_{1}=\\alpha_{2}=\\alpha_{3}=\\alpha_{4}=\\alpha_{4}=\\alpha_{4}=\\alpha_{4}",
      ),
      true,
    )
    // \mathcal{P}_{c} 반복
    assert.equal(
      isTrivialFormula(
        "c=c_{c}\\in\\mathcal{P}_{c}\\cdots\\in\\mathcal{P}_{c}\\in\\mathcal{P}_{c}\\in\\mathcal{P}_{c}",
      ),
      true,
    )
    // \omega_{n}^{\prime} 반복
    assert.equal(
      isTrivialFormula(
        "\\omega_{n}^{\\prime}=\\omega_{n}^{\\prime}+\\omega_{n}^{\\prime}=\\omega_{n}^{\\prime}+\\omega_{n}^{\\prime}=\\omega_{n}^{\\prime}+\\omega_{n}^{\\prime}",
      ),
      true,
    )
    // c_{c}^{\prime}\phi_{c}^{\prime} 반복
    assert.equal(
      isTrivialFormula(
        "c=c_{c}^{\\prime}\\phi_{c}^{\\prime}=c_{c}^{\\prime}\\phi_{c}^{\\prime}=c_{c}^{\\prime}\\phi_{c}^{\\prime}=c_{c}^{\\prime}\\phi_{c}^{\\prime}",
      ),
      true,
    )
  })

  it("정상 수식은 반복 필터에 걸리지 않음", () => {
    // 반복 있어도 정당한 경우
    assert.equal(isTrivialFormula("x^{2}+y^{2}=z^{2}"), false)
    assert.equal(
      isTrivialFormula("d_{k}=d_{v}=d_{\\mathrm{model}}/h=64"),
      false,
    )
    assert.equal(
      isTrivialFormula(
        "\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}(\\frac{QK^{T}}{\\sqrt{d_{k}}})V",
      ),
      false,
    )
    // MultiHead aligned
    assert.equal(
      isTrivialFormula(
        "\\begin{aligned}{\\mathrm{MultiHead}(Q,K,V)}&{=\\mathrm{Concat}(\\mathrm{head}_{1},...,\\mathrm{head}_{h})W^{O}}\\end{aligned}",
      ),
      false,
    )
  })

  it("\\square placeholder trivial (MFR 인식 실패 마커)", () => {
    assert.equal(isTrivialFormula("W^{\\square}\\in\\prod_{\\mathbb{R}}h"), true)
    assert.equal(isTrivialFormula("a + \\square"), true)
  })

  it("단독 숫자/실수 trivial", () => {
    assert.equal(isTrivialFormula("1.0"), true)
    assert.equal(isTrivialFormula("42"), true)
    assert.equal(isTrivialFormula("-3.14"), true)
    assert.equal(isTrivialFormula("{4000}"), true)
    // 변수 동반 숫자는 정상
    assert.equal(isTrivialFormula("x=1.0"), false)
    assert.equal(isTrivialFormula("steps=4000"), false)
  })

  it("동일 괄호 그룹 중복 trivial", () => {
    assert.equal(isTrivialFormula("C(T_{2})(T_{2})"), true)
    assert.equal(isTrivialFormula("{k_{c}}{k_{c}}"), true)
    // 다른 인자는 정상
    assert.equal(isTrivialFormula("C(T_{2})(T_{1})"), false)
  })

  it("\\frac{X}{X} 분자=분모 trivial", () => {
    assert.equal(isTrivialFormula("\\frac{\\eta}{\\eta}"), true)
    assert.equal(isTrivialFormula("k<\\frac{\\eta}{\\eta}"), true)
    // 다른 분자/분모는 정상
    assert.equal(isTrivialFormula("\\frac{a}{b}"), false)
    assert.equal(isTrivialFormula("\\frac{QK^{T}}{\\sqrt{d_{k}}}"), false)
  })

  it("동일 함수 인자 반복 trivial", () => {
    assert.equal(isTrivialFormula("C(\\tau_{2},\\mu^{\\prime},\\mu^{\\prime})"), true)
    assert.equal(isTrivialFormula("f(x,x,x)"), true)
    // 서로 다른 인자는 정상
    assert.equal(isTrivialFormula("f(x,y,z)"), false)
    assert.equal(isTrivialFormula("\\mathrm{Attention}(Q,K,V)"), false)
  })

  it("matrix placeholder (\\begin{matrix} + \\cdots 반복) trivial", () => {
    assert.equal(
      isTrivialFormula(
        "\\partial\\left(\\begin{matrix}{k_{c}}&{\\cdots}\\\\\\end{matrix}\\right)=ct\\to\\partial\\begin{matrix}{r_{c}}&{\\cdots}\\\\{r_{c}}&{\\cdots}",
      ),
      true,
    )
    // \cdots 1회는 정당 (표현식에 실제 값 있음)
    assert.equal(
      isTrivialFormula("\\begin{matrix}a&b\\\\c&\\cdots\\end{matrix}"),
      false,
    )
  })

  it("비정상 변수명 (\\mathrm{긴단어} 2-3자 접두) trivial", () => {
    assert.equal(isTrivialFormula("cl_{\\mathrm{model}}"), true)
    assert.equal(isTrivialFormula("to_{\\mathrm{max}}"), true)
    // 단일 문자는 정상
    assert.equal(isTrivialFormula("d_{\\mathrm{model}}"), false)
    assert.equal(isTrivialFormula("W_{\\mathrm{out}}"), false)
  })

  it("\\mathsf/\\mathtt/\\texttt 포함 trivial (다이어그램 타이포그래피)", () => {
    assert.equal(isTrivialFormula("\\mathtt{Welgnt}"), true)
    assert.equal(isTrivialFormula("\\mathsf{Tr}_{s}"), true)
    assert.equal(isTrivialFormula("\\exists\\texttt{wg}\\in\\texttt{w}"), true)
  })

  it("\\begin{aligned} + 등호 없음 trivial", () => {
    assert.equal(
      isTrivialFormula(
        "\\begin{aligned}{\\exists\\times\\Xi^{3}\\subset\\partial\\cap\\Xi^{\\prime}}\\end{aligned}",
      ),
      true,
    )
    // 등호 있으면 유지
    assert.equal(
      isTrivialFormula(
        "\\begin{aligned}a&=b\\\\c&=d\\end{aligned}",
      ),
      false,
    )
  })

  it("\\begin{matrix} + \\downarrow 반복 trivial (architecture diagram)", () => {
    assert.equal(
      isTrivialFormula(
        "\\begin{matrix}3\\times3,512\\\\\\downarrow\\\\\\downarrow\\end{matrix}",
      ),
      true,
    )
  })

  it("\\mathrm{word} 이항 연산자 단일 패턴 trivial", () => {
    assert.equal(isTrivialFormula("\\mathrm{to}-\\infty"), true)
    assert.equal(isTrivialFormula("\\mathrm{up}+1"), true)
    // 실제 연산 수식은 유지
    assert.equal(isTrivialFormula("\\mathrm{sin}(x)+1"), false)
  })

  it("hasHighRepetition 직접 검증", () => {
    assert.equal(hasHighRepetition("short"), false)
    assert.equal(
      hasHighRepetition("\\alpha_{4}=\\alpha_{4}=\\alpha_{4}=\\alpha_{4}"),
      true,
    )
    assert.equal(hasHighRepetition("x^{2}+y^{2}=z^{2}"), false)
  })

  it("postProcessLatex 가 trivial 시 빈 문자열 반환", () => {
    assert.equal(postProcessLatex("O"), "")
    assert.equal(postProcessLatex("\\imath"), "")
    assert.equal(postProcessLatex("\\mathrm{fcloc}"), "")
    assert.equal(postProcessLatex("\\pm \\pm \\pm \\pm"), "")
    // 정상 수식은 유지
    assert.equal(
      postProcessLatex("d_{k}=d_{v}=64"),
      "d_{k}=d_{v}=64",
    )
  })
})

describe("formula detector — IoU / NMS / letterbox", () => {
  it("iou — 완전 겹침 = 1, 분리 = 0", () => {
    assert.ok(Math.abs(iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 0, y1: 0, x2: 10, y2: 10 }) - 1) < 1e-6)
    assert.ok(iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 20, y1: 20, x2: 30, y2: 30 }) < 1e-6)
  })

  it("iou — 4분의 1 겹침", () => {
    const v = iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 5, y1: 5, x2: 15, y2: 15 })
    // inter=25, areaA=areaB=100, union=175 → 25/175 ≈ 0.143
    assert.ok(Math.abs(v - 25 / 175) < 1e-3)
  })

  it("nms — IoU ≥ 임계값이면 낮은 score 제거", () => {
    const cands = [
      { x1: 0, y1: 0, x2: 10, y2: 10, kind: "inline" as const, score: 0.9 },
      { x1: 1, y1: 1, x2: 11, y2: 11, kind: "inline" as const, score: 0.8 }, // IoU ≈ 0.68
      { x1: 100, y1: 100, x2: 110, y2: 110, kind: "inline" as const, score: 0.85 }, // 분리
    ]
    const kept = nms(cands, 0.45)
    assert.equal(kept.length, 2)
    // 높은 score 두 개 유지
    assert.ok(kept.find((c) => c.score === 0.9))
    assert.ok(kept.find((c) => c.score === 0.85))
  })

  it("letterbox — 정사각형 이미지는 패딩 없이 전체 커버", () => {
    // 100×100 RGBA 이미지를 target=10 으로
    const data = new Uint8Array(100 * 100 * 4)
    data.fill(128) // mid gray
    const frame = { width: 100, height: 100, data }
    const out = letterbox(frame, 10)
    assert.equal(out.scale, 0.1)
    assert.equal(out.padX, 0)
    assert.equal(out.padY, 0)
    assert.equal(out.tensor.length, 3 * 10 * 10)
    // 중앙 픽셀은 128/255 ≈ 0.502
    const midIdx = 5 * 10 + 5
    assert.ok(Math.abs(out.tensor[midIdx] - 128 / 255) < 0.02)
  })

  it("letterbox — 가로로 긴 이미지는 상하 패딩", () => {
    const data = new Uint8Array(200 * 100 * 4)
    data.fill(255)
    const frame = { width: 200, height: 100, data }
    const out = letterbox(frame, 100)
    assert.equal(out.scale, 0.5)
    assert.equal(out.padX, 0)
    assert.equal(out.padY, 25)
    // 패딩 영역 (y=0) 은 114/255
    const padIdx = 0 * 100 + 50
    assert.ok(Math.abs(out.tensor[padIdx] - 114 / 255) < 0.01)
    // 본문 영역 (y=50) 은 255/255 = 1
    const contentIdx = 50 * 100 + 50
    assert.ok(Math.abs(out.tensor[contentIdx] - 1) < 0.01)
  })
})

// 수식 파이프라인 자원 — 모델 없이 인스턴스 필드만 채워 쪽 순회·세션 해제를 본다 (생성자는 private, create() 는 모델 필요)
describe("FormulaPipeline 자원 — 대상 쪽만 열고, destroy 는 ONNX 세션까지 해제", () => {
  function threePagePdf(): Uint8Array {
    return new TextEncoder().encode(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
5 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
trailer << /Root 1 0 R >>`)
  }

  it("pageFilter 쪽만 연다 (종전 doc.pages() 는 전 쪽을 불러 필터 밖 쪽을 닫지 않았다)", async () => {
    const { FormulaPipeline } = await import("../src/pdf/formula/pipeline.js")
    const { PDFiumLibrary, PDFiumDocument } = await import("@hyzyla/pdfium")
    const p = Object.create(FormulaPipeline.prototype) as Record<string, unknown>
    p.pdfium = await PDFiumLibrary.init()
    p.opts = { scale: 2, maxRegionsPerPage: 50, pageTimeoutMs: 60_000 }
    const processed: number[] = []
    p.processPage = async (n: number) => { processed.push(n); return null }
    const proto = PDFiumDocument.prototype as unknown as { getPage(i: number): unknown; pages(): unknown }
    const origGet = proto.getPage, origPages = proto.pages
    const opened: number[] = []
    let iterated = false
    proto.getPage = function (this: unknown, i: number) { opened.push(i); return origGet.call(this, i) }
    proto.pages = function (this: unknown) { iterated = true; return origPages.call(this) }
    try {
      await (p as unknown as InstanceType<typeof FormulaPipeline>).runOnBuffer(threePagePdf(), new Set([3, 9]))
    } finally {
      proto.getPage = origGet
      proto.pages = origPages
      ;(p.pdfium as { destroy(): void }).destroy()
    }
    assert.equal(iterated, false)
    assert.deepEqual(opened, [2])
    assert.deepEqual(processed, [3])
  })

  it("destroy 가 세션 3개를 release", async () => {
    const { FormulaPipeline } = await import("../src/pdf/formula/pipeline.js")
    const released: string[] = []
    const p = Object.create(FormulaPipeline.prototype) as Record<string, unknown>
    for (const k of ["mfd", "encoder", "decoder"]) p[k] = { release: async () => { released.push(k) } }
    p.pdfium = { destroy: () => {} }
    await (p as unknown as InstanceType<typeof FormulaPipeline>).destroy()
    assert.deepEqual(released, ["mfd", "encoder", "decoder"])
  })
})
