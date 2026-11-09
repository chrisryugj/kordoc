/**
 * PDF 수식 OCR 유닛 테스트 — 외부 모델/바이너리 의존성 없는 순수 로직만 검증.
 * (e2e 테스트는 모델 다운로드 필요하므로 별도 파일에서 수행)
 */

import { describe, it } from "node:test"
import { strict as assert } from "node:assert"

import {
  postProcessLatex,
  stripUnpairedLeftRight,
  stripTrailingWhitespace,
  collapseSpaces,
  stripEmptyGroups,
  fixLatexSpacing,
  isTrivialFormula,
  normalizeFormulaSpacing,
  hasHighRepetition,
  mergeContinuationLines,
  dropNestedDisplays,
  doubleBarNorms,
  uprightCapitalGreek,
  textModeCommands,
} from "../src/pdf/formula/postprocess.js"
import { __internal } from "../src/pdf/formula/detector.js"
import { repeatingTail } from "../src/pdf/formula/recognizer.js"
import { lineBands } from "../src/pdf/formula/pipeline.js"

const { nms, iou, letterbox } = __internal

describe("formula postprocess", () => {
  it("trailing whitespace command 제거", () => {
    assert.equal(stripTrailingWhitespace("x + y \\quad"), "x + y")
    assert.equal(stripTrailingWhitespace("x + y \\,"), "x + y")
    assert.equal(stripTrailingWhitespace("x + y \\! \\,"), "x + y")
    assert.equal(stripTrailingWhitespace("x + y"), "x + y")
  })

  it("잘린 인식 결과 끝의 짝 없는 역슬래시를 뗀다 — 줄바꿈 \\\\ 는 둔다", () => {
    assert.equal(postProcessLatex("\\{\\boldsymbol{\\tau}\\"), "\\{\\boldsymbol{\\tau}")
    assert.equal(postProcessLatex("a=b\\\\c=d"), "a=b\\\\c=d")
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

describe("capFormulaRegions — 쪽당 수식 영역 상한", () => {
  it("넘으면 별행 수식부터 남기고 원래 순서를 지킨다", async () => {
    const { capFormulaRegions } = await import("../src/pdf/formula/pipeline.js")
    const rs = [...Array(6)].map((_, i) => ({ id: i, kind: i === 5 ? "display" : "inline" }))
    assert.deepEqual(capFormulaRegions(rs, 3).map(r => r.id), [0, 1, 5])
    assert.equal(capFormulaRegions(rs, 10).length, 6)
  })
})

describe("stripUnpairedLeftRight (Pix2Text fix_latex)", () => {
  it("짝 없는 \\left·\\right 는 떼고 구분자만 남긴다", () => {
    assert.equal(stripUnpairedLeftRight("\\left( a + b"), "( a + b")
    assert.equal(stripUnpairedLeftRight("a + b \\right)"), "a + b )")
    assert.equal(stripUnpairedLeftRight("\\left[ \\left( x \\right) y"), "[ \\left( x \\right) y")
  })
  it("짝이 맞으면 그대로, \\leftarrow·\\rightarrow 는 다른 명령", () => {
    const ok = "\\left( \\frac{a}{b} \\right) \\leftarrow \\rightarrow"
    assert.equal(stripUnpairedLeftRight(ok), ok)
    assert.equal(postProcessLatex("\\left( x+y"), "(x+y")
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

  it("목록에 없는 정식 명령은 쪼개지 않는다 — 아는 명령 접두가 있어도 (arXiv 수식 정답 대조)", () => {
    for (const cmd of ["\\lesssim", "\\gtrsim", "\\leqslant", "\\geqslant", "\\subsetneq", "\\llbracket", "\\rrbracket", "\\Bigl(", "\\Bigr)", "\\biggl[", "\\pmod {2}", "\\bmod p", "\\sigmaalgebra"]) {
      assert.equal(fixLatexSpacing(cmd), cmd)
    }
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
    // 같은 첨자를 되풀이한 정상 식은 유지
    assert.equal(isTrivialFormula("S=\\sum_{\\ell,m}S_{\\ell,m}Y_{\\ell,m},"), false)
    assert.equal(isTrivialFormula("T_{\\ell,m}\\sim C_{\\ell,m}\\sim Q_{\\ell,m}."), false)
    // 부등식으로만 잇는 여러 줄 평가식도 유지
    assert.equal(
      isTrivialFormula(
        "\\begin{aligned}{I}&{\\leq\\frac{k_{0}}{4}|c\\widehat{E}|^{2}}\\\\{}&{+C(k_{0})|\\widehat{u\\times B}|^{2},}\\end{aligned}",
      ),
      false,
    )
    assert.equal(
      isTrivialFormula(
        "\\begin{aligned}{\\frac{d}{dt}L_{c}(t,\\xi)+k_{0}}&{|\\widehat{B}|^{2}}\\\\{}&{\\lesssim|\\widehat{u\\times B}|^{2},}\\end{aligned}",
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
describe("FormulaPipeline 자원 — 대상 쪽만 그리고, destroy 는 ONNX 세션까지 해제", () => {
  function threePagePdf(): Uint8Array {
    return new TextEncoder().encode(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
5 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
trailer << /Root 1 0 R >>`)
  }

  it("pageFilter 쪽만 그린다 — 필터 밖·문서 밖 쪽은 건너뛴다", async () => {
    const { FormulaPipeline } = await import("../src/pdf/formula/pipeline.js")
    const p = Object.create(FormulaPipeline.prototype) as Record<string, unknown>
    p.opts = { scale: 2, maxRegionsPerPage: 50, pageTimeoutMs: 60_000 }
    const processed: number[] = []
    p.processPage = async (n: number) => { processed.push(n); return null }
    await (p as unknown as InstanceType<typeof FormulaPipeline>).runOnBuffer(threePagePdf(), new Set([3, 9]))
    assert.deepEqual(processed, [3])
  })

  it("destroy 가 세션 3개를 release", async () => {
    const { FormulaPipeline } = await import("../src/pdf/formula/pipeline.js")
    const released: string[] = []
    const p = Object.create(FormulaPipeline.prototype) as Record<string, unknown>
    for (const k of ["mfd", "encoder", "decoder"]) p[k] = { release: async () => { released.push(k) } }
    await (p as unknown as InstanceType<typeof FormulaPipeline>).destroy()
    assert.deepEqual(released, ["mfd", "encoder", "decoder"])
  })
})

describe("formula continuation lines (mergeContinuationLines)", () => {
  const r = (y1: number, y2: number, latex: string, x1 = 100, x2 = 500, kind = "display") => ({ bbox: { x1, y1, x2, y2 }, kind, latex, score: 0.9 })
  it("바로 아래 붙은 관계 기호 줄을 위 식의 다음 줄로 잇는다", () => {
    const out = mergeContinuationLines([r(100, 140, "A=B+C"), r(150, 190, "\\leq D+E"), r(200, 240, "+F")])
    assert.equal(out.length, 1)
    assert.equal(out[0].latex, "\\begin{aligned}A=B+C \\\\ \\leq D+E \\\\ +F\\end{aligned}")
    assert.deepEqual(out[0].bbox, { x1: 100, y1: 100, x2: 500, y2: 240 })
  })
  it("여러 줄 상자를 읽은 조각(aligned)도 관계 기호로 시작하면 바깥 aligned 를 벗겨 잇는다", () => {
    const out = mergeContinuationLines([r(100, 240, "\\begin{aligned}&{E[u]} \\\\ {=}&{E[v]}\\end{aligned}"), r(260, 380, "\\begin{aligned}{\\leq}&{(1-\\beta)E[w]}\\end{aligned}")])
    assert.equal(out.length, 1)
    assert.equal(out[0].latex, "\\begin{aligned}&{E[u]} \\\\ {=}&{E[v]} \\\\ {\\leq}&{(1-\\beta)E[w]}\\end{aligned}")
  })
  it("기호로 시작하지 않거나 멀리 떨어진 식·inline 은 그대로", () => {
    const regions = [r(100, 140, "A=B"), r(150, 190, "x^2+y^2=1"), r(400, 440, "=C"), r(450, 470, "=D", 100, 200, "inline")]
    assert.equal(mergeContinuationLines(regions).length, 4)
  })
})

describe("formula nested display boxes (dropNestedDisplays)", () => {
  const r = (x1: number, y1: number, x2: number, y2: number, latex = "a=b", kind = "display") => ({ bbox: { x1, y1, x2, y2 }, kind, latex, score: 0.5 })
  it("여러 줄 display 상자 안에 든 한 줄 상자는 같은 줄을 또 읽은 것이라 뺀다", () => {
    const out = dropNestedDisplays([r(214, 268, 999, 408, "A\\leq B\\\\+C"), r(237, 341, 1023, 410, "+C"), r(183, 465, 1035, 577)])
    assert.deepEqual(out.map(o => o.latex), ["A\\leq B\\\\+C", "a=b"])
  })
  it("비슷한 높이로 겹친 상자·빈 상자 안·inline 은 그대로", () => {
    const regions = [r(100, 100, 900, 160), r(120, 110, 880, 165), r(100, 300, 900, 500, ""), r(150, 320, 800, 380), r(100, 600, 900, 800), r(200, 650, 300, 680, "x", "inline")]
    assert.equal(dropNestedDisplays(regions).length, 6)
  })
})

describe("formula decode loop (repeatingTail)", () => {
  it("같은 묶음이 네 번 이어진 꼬리(24토큰 이상)를 찾는다", () => {
    const loop = [7, 8, 9, 10, 11, 12]
    assert.equal(repeatingTail([1, 2, 3, ...loop, ...loop, ...loop, ...loop]), 6)
  })
  it("짧은 되풀이(행렬 0 & 0 …)·세 번만 되풀이는 고리가 아니다", () => {
    assert.equal(repeatingTail([1, 0, 5, 0, 5, 0, 5, 0, 5]), 0)
    const loop = [7, 8, 9, 10, 11, 12, 13, 14]
    assert.equal(repeatingTail([1, ...loop, ...loop, ...loop]), 0)
  })
})


describe("lineBands — 여러 줄 정렬식 줄 띠", () => {
  // w×h 흰 바탕에 [x1,y1,x2,y2) 검은 상자들을 칠한 프레임
  const frame = (w: number, h: number, boxes: number[][]) => {
    const data = new Uint8Array(w * h * 4).fill(255)
    for (const [x1, y1, x2, y2] of boxes) for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3)
    return { width: w, height: h, data }
  }

  it("줄 다섯을 가르고, 여러 줄에 걸친 큰 괄호(세로 획)는 줄 사이를 잇지 않는다", () => {
    const lines = [0, 1, 2, 3, 4].map(i => [20, 10 + i * 40, 300, 40 + i * 40])
    const bands = lineBands(frame(320, 220, [...lines, [5, 10, 8, 200]]), 2)
    assert.equal(bands.length, 5)
    assert.deepEqual(bands[0], [8, 42])
  })

  it("본문 높이 절반을 넘는 큰 아래 첨자 띠도 줄 사이 틈보다 좁게 붙어 있으면 그 줄에 붙인다", () => {
    // 줄마다 본문 30px + 6px 틈 + 첨자 18px, 줄 사이 틈 14px
    const boxes = [0, 1, 2].flatMap(i => [[20, 10 + i * 68, 300, 40 + i * 68], [40, 46 + i * 68, 90, 64 + i * 68]])
    assert.equal(lineBands(frame(320, 220, boxes), 2).length, 3)
  })

  it("한 줄 식의 합 기호 위아래 첨자 띠는 줄로 갈리지 않는다", () => {
    // 본문 30px 줄 위아래로 8px 첨자 띠
    const bands = lineBands(frame(320, 80, [[40, 5, 60, 13], [20, 20, 300, 50], [40, 56, 60, 64]]), 2)
    assert.equal(bands.length, 1)
  })
})


describe("doubleBarNorms", () => {
  it("막대 둘로 읽은 노름을 \\| 로", () => {
    assert.equal(doubleBarNorms("\\int||a(s)||_{op}ds"), "\\int\\|a(s)\\|_{op}ds")
    assert.equal(doubleBarNorms("(||W||^{2})"), "(\\|W\\|^{2})")
  })
  it("디코더 원문(토큰 사이 공백)도 postProcessLatex 에서 바뀐다", () => {
    assert.equal(postProcessLatex("\\int _ { 0 } ^ { t } | | a ( s ) | | _ { o p } d s"), "\\int_{0}^{t}\\|a(s)\\|_{op}ds")
  })
  it("절댓값 곱 |a||b| 와 이미 \\| 인 노름은 그대로", () => {
    assert.equal(doubleBarNorms("|a||b|"), "|a||b|")
    assert.equal(doubleBarNorms("\\|x\\|"), "\\|x\\|")
    assert.equal(doubleBarNorms("1-|x||y|+||z||"), "1-|x||y|+\\|z\\|")
  })
  it("여는 쪽만 막대 하나 + 가는 공백으로 읽은 노름 |\\, … \\| 을 \\| 로 (다른 막대가 끼면·\\left\\| 는 그대로)", () => {
    assert.equal(doubleBarNorms("\\sup_{n}|\\,g_{n}\\|_{\\infty}"), "\\sup_{n}\\|g_{n}\\|_{\\infty}")
    assert.equal(doubleBarNorms("|\\,a|+\\|b\\|"), "|\\,a|+\\|b\\|")
    assert.equal(doubleBarNorms("\\left\\|\\,e^{x}\\right\\|"), "\\left\\|\\,e^{x}\\right\\|")
  })
})

describe("uprightCapitalGreek", () => {
  it("기울인 대문자 그리스를 바로 선 꼴로, 소문자 \\varepsilon·\\varphi 는 그대로", () => {
    assert.equal(uprightCapitalGreek("(1+\\varepsilon)\\varSigma+\\varGamma_{n}"), "(1+\\varepsilon)\\Sigma+\\Gamma_{n}")
    assert.equal(uprightCapitalGreek("\\varphi(\\varOmega)"), "\\varphi(\\Omega)")
  })
  it("쓰레기 판정은 정규화 앞 글로 — 오독 줄이 맞춰져 분자·분모가 같아져도 여러 줄 식을 버리지 않는다 (2609.13201 (81)식)", () => {
    const raw = "\\begin{aligned}{N_{Z}}&{\\leq\\frac{2t^{2}}{n^{2}}Kn\\varSigma}\\\\&{=\\frac{2Kt^{2}\\varSigma}{2Kt^{2}\\Sigma}}\\\\&{=\\frac{2Kt^{2}\\Sigma}{n}}\\\\\\end{aligned}"
    const out = postProcessLatex(raw)
    assert.ok(out.includes("Kn\\Sigma") && !out.includes("\\varSigma"))
  })
})

describe("textModeCommands", () => {
  it("\\mathrm{\\boldmath~P~} 를 \\mathbf{P} 로, 식 끝 \\. 를 마침표로 (줄바꿈 \\\\ 뒤 . 는 그대로)", () => {
    assert.equal(textModeCommands("\\left\\|\\mathrm{\\boldmath~P_{i^{*}}~}\\widehat{\\mathrm{\\boldmath~w~}}"), "\\left\\|\\mathbf{P_{i^{*}}}\\widehat{\\mathbf{w}}")
    assert.equal(textModeCommands("x\\leq y\\."), "x\\leq y.")
    assert.equal(textModeCommands("a\\\\.b"), "a\\\\.b")
  })
})
