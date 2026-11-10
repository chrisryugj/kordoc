/**
 * PDF 엔진 — hayro(Rust PDF 해석기)를 wasm 으로 부른다. 크레이트는 rust/hayro-pdf, 만든 wasm 은 이 파일 옆 hayro-pdf.wasm
 * (rust/hayro-pdf/build.mjs 가 만든다. 빌드는 dist/ 로 같은 이름을 복사한다).
 *
 * 문서마다 wasm 인스턴스를 하나 만든다 — 한 문서를 읽다 멈춘(trap) 인스턴스가 다른 문서에 번지지 않고, 문서를 닫으면 메모리가 함께 풀린다.
 * 결과는 호출마다 두 버퍼(f64·바이트)에 담긴다(rust/hayro-pdf/src/lib.rs) — 다음 호출 전에 복사해 둔다.
 */

interface Engine {
  memory: WebAssembly.Memory
  alloc(len: number): number
  dealloc(ptr: number, len: number): void
  f64_ptr(): number
  f64_len(): number
  bytes_ptr(): number
  bytes_len(): number
  open(ptr: number, len: number): number
  page_count(): number
  events(page: number): number
  page_view(page: number): number
  page_rotate(page: number): number
  page_size(page: number): number
  render(page: number, scale: number): number
  font_info(ptr: number, len: number): number
  font_file(ptr: number, len: number): number
  image(ptr: number, len: number): number
  info(): number
  links(page: number): number
}

let compiled: Promise<WebAssembly.Module> | undefined

/** wasm 바이트 — Node 는 파일을, 브라우저는 번들러가 옮긴 자리(import.meta.url 기준)를 받는다.
 *  `new URL("…", import.meta.url)` 은 글자 그대로 둔다 — 번들러(Vite·webpack·Parcel)가 이 모양을 보고 wasm 을 옮긴다 */
async function wasmBytes(): Promise<ArrayBuffer | Uint8Array> {
  const url = new URL("./hayro-pdf.wasm", import.meta.url)
  if (typeof process !== "undefined" && process.versions?.node) {
    const { readFile } = await import("node:fs/promises")
    return readFile(url)
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`hayro-pdf.wasm 을 받지 못했습니다 (${res.status})`)
  return res.arrayBuffer()
}

/** 컴파일한 wasm — 한 번만. 실패하면 다음 호출에서 다시 해 본다 */
function module(): Promise<WebAssembly.Module> {
  compiled ??= wasmBytes().then(b => WebAssembly.compile(b as BufferSource)).catch(e => { compiled = undefined; throw e })
  return compiled
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** 열린 PDF 한 개. 쪽 번호는 0부터 */
export interface HayroDoc {
  pageCount(): number
  /** 쪽 사건열과 문자열 표 — 사전 해석과 콜백이 어긋난 쪽은 오류 */
  events(page: number): { events: Float64Array; strings: string[] }
  /** 쪽 보기 상자 [x0,y0,x1,y1] — CropBox∩MediaBox */
  pageView(page: number): number[]
  /** 쪽 회전(0·90·180·270) */
  pageRotate(page: number): number
  /** 렌더 크기 [가로, 세로](pt, 회전 반영) */
  pageSize(page: number): [number, number]
  /** 흰 바탕 RGBA 렌더 */
  render(page: number, scale: number): { data: Uint8Array; width: number; height: number }
  /** 글꼴 정보 JSON(없으면 "") */
  fontInfo(key: string): string
  /** 글꼴의 TrueType 파일(없으면 빈 배열) */
  fontFile(key: string): Uint8Array
  /** 디코딩한 그림 (kind 2 RGB, 3 RGBA) — 못 그린 그림은 null */
  image(id: string): { width: number; height: number; kind: number; data: Uint8Array } | null
  /** 정보 사전(글은 라틴1 한 글자 = 한 바이트, 날짜는 "D:…") */
  info(): Record<string, string>
  /** 링크 주석 재료 */
  links(page: number): HayroLink[]
  close(): void
}

export interface HayroLink { rect: number[]; uri?: string; file?: string; filespec?: string; dest?: string; js?: string }

/** 열지 못한 이유 — 1 읽을 수 없음, 2 암호 필요, 3 지원하지 않는 암호화 */
export class HayroOpenError extends Error {
  constructor(readonly reason: "invalid" | "password" | "encryption") { super(`PDF 를 열 수 없습니다 (${reason})`) }
}

/** PDF 를 연다. 읽을 수 없거나 암호가 걸린 PDF 는 HayroOpenError */
export async function openHayro(buffer: ArrayBuffer | Uint8Array): Promise<HayroDoc> {
  const w = new WebAssembly.Instance(await module()).exports as unknown as Engine
  const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  // 포인터·길이는 u32 — 메모리가 2GB 를 넘으면 i32 로 음수가 되므로 >>> 0 으로 읽는다
  const p = w.alloc(src.length) >>> 0
  new Uint8Array(w.memory.buffer, p, src.length).set(src)
  const rc = w.open(p, src.length)
  if (rc !== 0) throw new HayroOpenError(rc === 2 ? "password" : rc === 3 ? "encryption" : "invalid")
  let alive = true
  const bytesView = () => new Uint8Array(w.memory.buffer, w.bytes_ptr() >>> 0, w.bytes_len() >>> 0)
  const bytes = () => bytesView().slice()
  const f64 = () => { const p = w.f64_ptr() >>> 0; return new Float64Array(w.memory.buffer.slice(p, p + (w.f64_len() >>> 0) * 8)) }
  const text = () => decoder.decode(bytesView())
  /** 글 인자 — alloc 한 자리에 UTF-8 로(Rust 는 호출 동안 읽기만 한다) */
  const withStr = (s: string, fn: (ptr: number, len: number) => number): number => {
    const b = encoder.encode(s), q = w.alloc(b.length) >>> 0
    new Uint8Array(w.memory.buffer, q, b.length).set(b)
    try { return fn(q, b.length) } finally { w.dealloc(q, b.length) }
  }
  const call = <T>(fn: () => T): T => {
    if (!alive) throw new Error("닫힌 PDF 문서입니다")
    return fn()
  }
  return {
    pageCount: () => call(() => w.page_count()),
    events: page => call(() => {
      if (w.events(page) < 0) throw new Error(text())
      return { events: f64(), strings: text().split("\u0001") }
    }),
    pageView: page => call(() => { w.page_view(page); return Array.from(f64()) }),
    pageRotate: page => call(() => w.page_rotate(page)),
    pageSize: page => call(() => { w.page_size(page); const v = f64(); return [v[0] ?? 0, v[1] ?? 0] }),
    render: (page, scale) => call(() => {
      w.render(page, scale)
      const [width = 0, height = 0] = f64()
      return { data: bytes(), width, height }
    }),
    fontInfo: key => call(() => { withStr(key, (q, l) => w.font_info(q, l)); return text() }),
    fontFile: key => call(() => { withStr(key, (q, l) => w.font_file(q, l)); return bytes() }),
    image: id => call(() => {
      if (withStr(id, (q, l) => w.image(q, l)) !== 3) return null
      const [width = 0, height = 0, kind = 0] = f64()
      return { width, height, kind, data: bytes() }
    }),
    info: () => call(() => { w.info(); return JSON.parse(text() || "{}") as Record<string, string> }),
    links: page => call(() => { w.links(page); return JSON.parse(text() || "[]") as HayroLink[] }),
    close: () => { alive = false },
  }
}

/** OCR·수식 래스터가 쓰는 쪽 모양 — 원래 크기(pt)와 배율 렌더(RGBA) */
export interface RasterPage {
  getOriginalSize(): { originalWidth: number; originalHeight: number }
  render(o: { scale: number; render?: (r: { data: Uint8Array; width: number; height: number }) => unknown }): Promise<{ data: Uint8Array; width: number; height: number }>
}

/** 쪽(0부터)을 래스터 쪽으로 */
export function rasterPage(doc: HayroDoc, index: number): RasterPage {
  return {
    getOriginalSize: () => { const [originalWidth, originalHeight] = doc.pageSize(index); return { originalWidth, originalHeight } },
    render: async ({ scale }) => doc.render(index, scale),
  }
}
