/**
 * 수식 OCR 파이프라인 — PDFium 렌더 + MFD + MFR 통합
 *
 * 한 번 생성된 FormulaPipeline 인스턴스는 ONNX 세션을 재사용해 여러 PDF 에 적용 가능.
 * Docufinder 는 CLI 프로세스 단위로 새로 띄우기 때문에 세션 재사용은 PDF 내부 페이지 루프에만 적용됨.
 */

import type { PDFiumLibrary, PDFiumDocument } from "@hyzyla/pdfium"
import type { InferenceSession } from "onnxruntime-node"
import type { PreTrainedTokenizer } from "@huggingface/transformers"

/** sharp 은 CommonJS `export =` 형태라 타입을 직접 import 하기 까다로움. 함수형 시그니처만 사용. */
type SharpFactory = (
  input: Uint8Array | Buffer,
  options?: { raw?: { width: number; height: number; channels: number } },
) => {
  extract(region: { left: number; top: number; width: number; height: number }): {
    raw(): { toBuffer(): Promise<Buffer> }
  }
}

import { detectFormulaRegions } from "./detector.js"
import { recognizeFormula } from "./recognizer.js"
import {
  getFormulaModelsDir,
  MFD_MODEL,
  MFR_ENCODER_MODEL,
  MFR_DECODER_MODEL,
  MFR_TOKENIZER,
} from "./models.js"
import type { FormulaRegion, PixelFrame } from "./types.js"
import { join } from "path"

/** PDF 페이지 렌더 해상도 (scale=2 → 약 144 DPI). 수식 인식에는 이 이상은 과함. */
const RENDER_SCALE = 2

export interface FormulaPipelineOptions {
  /** 수식 인식 페이지 스케일 (기본 2). 값을 올리면 작은 수식 인식률 ↑, 속도 ↓. */
  scale?: number
  /** 페이지별 최대 수식 수 (안전 상한). 기본 50. */
  maxRegionsPerPage?: number
  /** 페이지 하나당 타임아웃 (ms, 기본 60000 = 1분). 초과 시 해당 페이지 skip. */
  pageTimeoutMs?: number
}

export interface PageFormulaResult {
  pageNumber: number
  /** 페이지 전체 렌더 이미지의 가로/세로 (원본 좌표계, scale 반영됨) */
  renderedWidth: number
  renderedHeight: number
  /** 원본 PDF 포인트 기준 너비/높이 (pdfjs 와 좌표 매핑용) */
  pdfWidth: number
  pdfHeight: number
  regions: FormulaRegion[]
}

/**
 * 수식 OCR 실행 컨텍스트. 처음 호출 시 무겁게 초기화 (ONNX 세션 로드),
 * 이후 runOnBuffer / runOnPages 를 여러 번 호출해 재사용 가능.
 *
 * 모든 의존성(onnxruntime-node, @huggingface/transformers, @hyzyla/pdfium, sharp)은
 * optional 이므로 dynamic import. 미설치 시 초기화에서 명확한 에러 메시지 반환.
 */
export class FormulaPipeline {
  private mfd: InferenceSession
  private encoder: InferenceSession
  private decoder: InferenceSession
  private tokenizer: PreTrainedTokenizer
  private ort: typeof import("onnxruntime-node")
  private sharp: SharpFactory
  private pdfium: PDFiumLibrary
  private opts: Required<FormulaPipelineOptions>

  private constructor(parts: {
    mfd: InferenceSession
    encoder: InferenceSession
    decoder: InferenceSession
    tokenizer: PreTrainedTokenizer
    ort: typeof import("onnxruntime-node")
    sharp: SharpFactory
    pdfium: PDFiumLibrary
    opts: Required<FormulaPipelineOptions>
  }) {
    this.mfd = parts.mfd
    this.encoder = parts.encoder
    this.decoder = parts.decoder
    this.tokenizer = parts.tokenizer
    this.ort = parts.ort
    this.sharp = parts.sharp
    this.pdfium = parts.pdfium
    this.opts = parts.opts
  }

  /**
   * 수식 OCR 엔진 초기화. 모델 파일이 로컬에 없으면 즉시 실패 — 호출자가
   * `ensureFormulaModels()` 를 먼저 돌려야 한다.
   */
  static async create(options?: FormulaPipelineOptions): Promise<FormulaPipeline> {
    const opts: Required<FormulaPipelineOptions> = {
      scale: options?.scale ?? RENDER_SCALE,
      maxRegionsPerPage: options?.maxRegionsPerPage ?? 50,
      pageTimeoutMs: options?.pageTimeoutMs ?? 60_000,
    }

    const [ortMod, sharpModRaw, hfMod, pdfiumMod] = await Promise.all([
      tryImport<typeof import("onnxruntime-node")>(
        "onnxruntime-node",
        () => import("onnxruntime-node"),
      ),
      tryImport<{ default?: SharpFactory } & SharpFactory>(
        "sharp",
        () => import("sharp") as unknown as Promise<{ default?: SharpFactory } & SharpFactory>,
      ),
      tryImport<typeof import("@huggingface/transformers")>(
        "@huggingface/transformers",
        () => import("@huggingface/transformers"),
      ),
      tryImport<typeof import("@hyzyla/pdfium")>(
        "@hyzyla/pdfium",
        () => import("@hyzyla/pdfium"),
      ),
    ])
    // CJS `export =` + ESM interop → default 속성에 래핑될 때도, 안 될 때도 있음.
    const sharpAny = sharpModRaw as { default?: SharpFactory } | SharpFactory
    const sharpMod: SharpFactory =
      typeof sharpAny === "function"
        ? sharpAny
        : (sharpAny.default ?? (sharpAny as unknown as SharpFactory))

    const modelsDir = getFormulaModelsDir()
    const mfdPath = join(modelsDir, MFD_MODEL.filename)
    const encPath = join(modelsDir, MFR_ENCODER_MODEL.filename)
    const decPath = join(modelsDir, MFR_DECODER_MODEL.filename)
    const tokPath = join(modelsDir, MFR_TOKENIZER.filename)

    const sessionOpts: import("onnxruntime-node").InferenceSession.SessionOptions = {
      graphOptimizationLevel: "all",
      executionProviders: ["cpu"],
    }

    // 각 세션은 I/O 바운드 아님 → 병렬 로드로 1~2초 단축
    const [mfd, encoder, decoder] = await Promise.all([
      ortMod.InferenceSession.create(mfdPath, sessionOpts),
      ortMod.InferenceSession.create(encPath, sessionOpts),
      ortMod.InferenceSession.create(decPath, sessionOpts),
    ])

    // Transformers.js 의 PreTrainedTokenizer 를 로컬 tokenizer.json 으로 로드.
    // AutoTokenizer.from_pretrained 는 HF hub 접근을 시도하므로 우회.
    const { readFile } = await import("fs/promises")
    const tokenizerJson = JSON.parse(await readFile(tokPath, "utf-8"))
    const PretrainedCtor = hfMod.PreTrainedTokenizer as unknown as new (
      json: unknown,
      config: Record<string, unknown>,
    ) => PreTrainedTokenizer
    const tokenizer = new PretrainedCtor(tokenizerJson, {})

    const pdfium = await pdfiumMod.PDFiumLibrary.init()

    return new FormulaPipeline({
      mfd,
      encoder,
      decoder,
      tokenizer,
      ort: ortMod,
      sharp: sharpMod,
      pdfium,
      opts,
    })
  }

  /** 리소스 해제 — 더 이상 사용하지 않을 때 호출. ONNX 세션은 onnxruntime-node 1.14+ release() 로 (구버전은 GC — ocr/engine.ts destroy 와 같은 방식) */
  async destroy(): Promise<void> {
    for (const s of [this.mfd, this.encoder, this.decoder]) {
      const rel = (s as unknown as { release?: () => Promise<void> }).release
      if (typeof rel === "function") {
        try { await rel.call(s) } catch { /* ignore */ }
      }
    }
    try {
      this.pdfium.destroy()
    } catch {
      // ignore
    }
  }

  /**
   * PDF 버퍼를 열어 페이지별 수식 영역을 인식한다.
   * 실패한 페이지는 skip (에러 전파 없음 — 로그만).
   *
   * @param pageFilter null 이면 전체 페이지. Set 이면 1-based 페이지 번호 일치만.
   */
  async runOnBuffer(
    buffer: ArrayBuffer | Uint8Array,
    pageFilter: Set<number> | null = null,
    onPageProgress?: (pageNumber: number, total: number) => void,
  ): Promise<PageFormulaResult[]> {
    const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    const doc: PDFiumDocument = await this.pdfium.loadDocument(view)
    try {
      const pages: PageFormulaResult[] = []
      // 대상 쪽만 연다 — doc.pages() 는 모든 쪽을 불러오고 render() 가 끝에서만 닫아, 필터 밖 쪽이 문서를 닫을 때까지 남았다
      // (ocr/pdf-ocr.ts runPdfOcr 와 같은 수정). pdfium 쪽 번호는 0-based — pdfjs 블록/pageFilter 는 1-based.
      // 환산 없이는 필터가 한 페이지 밀리고 수식이 이전 페이지 블록에 붙는다 (off-by-one).
      const count = doc.getPageCount()
      const pageNos = pageFilter
        ? [...pageFilter].filter(p => p >= 1 && p <= count).sort((a, b) => a - b)
        : Array.from({ length: count }, (_, i) => i + 1)
      for (const pageNo of pageNos) {
        const page = doc.getPage(pageNo - 1)
        onPageProgress?.(pageNo, count)

        try {
          const result = await withTimeout(
            this.processPage(pageNo, page),
            this.opts.pageTimeoutMs,
            `formula page ${pageNo} timed out after ${this.opts.pageTimeoutMs}ms`,
          )
          if (result) pages.push(result)
        } catch (e) {
          // 페이지 단위 실패는 조용히 넘어간다 — 전체 PDF 파싱 실패 방지.
          process.stderr.write(
            `[kordoc-formula] page ${pageNo} skipped: ${(e as Error).message}\n`,
          )
        }
      }
      return pages
    } finally {
      doc.destroy()
    }
  }

  private async processPage(
    pageNumber: number,
    page: import("@hyzyla/pdfium").PDFiumPage,
  ): Promise<PageFormulaResult | null> {
    const { originalWidth: pdfWidth, originalHeight: pdfHeight } = page.getOriginalSize()

    const sharpCtor = this.sharp
    const rendered = await page.render({
      scale: this.opts.scale,
      render: async ({ data, width, height }) => {
        // 임시로 PNG 로 인코딩하지 않고 raw 그대로 반환 — 바로 쓸 거라서.
        return data
      },
    })
    // rendered.data 는 BGRA — sharp 로 RGBA 로 변환
    const { data: bgra, width: rw, height: rh } = rendered
    const rgba = bgraToRgba(bgra)

    const pageFrame: PixelFrame = { width: rw, height: rh, data: rgba }

    // 1) 수식 영역 검출
    const regions0 = await detectFormulaRegions(this.mfd, pageFrame, this.ort)
    if (regions0.length === 0) {
      return { pageNumber, renderedWidth: rw, renderedHeight: rh, pdfWidth, pdfHeight, regions: [] }
    }

    const capped = regions0.slice(0, this.opts.maxRegionsPerPage)
    const regions: FormulaRegion[] = []

    // 2) 각 영역 crop → 인식
    for (const r of capped) {
      const x1 = Math.floor(Math.max(0, r.bbox.x1))
      const y1 = Math.floor(Math.max(0, r.bbox.y1))
      const x2 = Math.ceil(Math.min(rw, r.bbox.x2))
      const y2 = Math.ceil(Math.min(rh, r.bbox.y2))
      const cw = x2 - x1
      const ch = y2 - y1
      if (cw < 4 || ch < 4) continue

      // sharp 로 raw RGBA 에서 crop → raw RGBA 반환
      const cropRgba = await sharpCtor(rgba, {
        raw: { width: rw, height: rh, channels: 4 },
      })
        .extract({ left: x1, top: y1, width: cw, height: ch })
        .raw()
        .toBuffer()

      const cropFrame: PixelFrame = { width: cw, height: ch, data: new Uint8Array(cropRgba) }

      let latex = ""
      try {
        latex = await recognizeFormula(
          {
            encoder: this.encoder,
            decoder: this.decoder,
            tokenizer: this.tokenizer,
            ort: this.ort,
          },
          cropFrame,
        )
      } catch (e) {
        process.stderr.write(
          `[kordoc-formula] recognize failed at page ${pageNumber} ${JSON.stringify(r.bbox)}: ${(e as Error).message}\n`,
        )
        latex = ""
      }

      regions.push({ ...r, latex })
    }

    return {
      pageNumber,
      renderedWidth: rw,
      renderedHeight: rh,
      pdfWidth,
      pdfHeight,
      regions,
    }
  }
}

async function tryImport<T>(name: string, loader: () => Promise<T>): Promise<T> {
  try {
    return await loader()
  } catch (e) {
    throw new Error(
      `수식 OCR 을 사용하려면 optional dependency '${name}' 이 필요합니다. ` +
        `\`npm install ${name}\` 후 다시 실행하세요. 원인: ${(e as Error).message}`,
    )
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  // 타임아웃으로 race 가 끝난 뒤에도 원 promise 는 계속 실행된다 — 사후 reject 가
  // unhandled rejection(Node 기본 정책: 프로세스 종료)이 되지 않게 흡수
  promise.catch(() => {})
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** pdfium 의 BGRA 버퍼를 RGBA 로 변환 (Red ↔ Blue 스왑). */
function bgraToRgba(bgra: Uint8Array): Uint8Array {
  const out = new Uint8Array(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2] // R ← B
    out[i + 1] = bgra[i + 1] // G ← G
    out[i + 2] = bgra[i] // B ← R
    out[i + 3] = bgra[i + 3] // A ← A
  }
  return out
}
