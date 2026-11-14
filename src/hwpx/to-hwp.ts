/**
 * HWPX → HWP 5.0 (바이너리). kordoc 은 HWPX 를 만들고, HWP 로 저장할 때만 rhwp(@rhwp/core WASM)로 옮긴다.
 * @rhwp/core 는 optional peer dep(풀면 32MB) — 없으면 KordocError(조치 안내).
 */

import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { KordocError } from "../utils.js"

interface RhwpExport { contentLoss(): string; takeBytes(): Uint8Array; free(): void }
interface RhwpDocument { exportHwpWithReport(): RhwpExport; free(): void }
interface Rhwp {
  default(input: { module_or_path: Uint8Array }): Promise<unknown>
  HwpDocument: new (data: Uint8Array) => RhwpDocument
}

export interface HwpxToHwpOptions {
  /** HWP 로 옮기며 빠진 내용(rhwp 손실 보고)을 여기에 더한다 */
  warnings?: string[]
}

const LOSS_LABEL: Record<string, string> = {
  binaryContentEmptied: "첨부 내용 비움",
  controlOmitted: "개체 빠짐",
  metadataReduced: "속성 줄어듦",
}

let loading: Promise<Rhwp> | null = null

function loadRhwp(): Promise<Rhwp> {
  loading ??= (async () => {
    let rhwp: Rhwp
    try {
      rhwp = (await import("@rhwp/core")) as unknown as Rhwp
    } catch {
      throw new KordocError("HWP 저장에는 @rhwp/core 가 필요합니다 (npm install @rhwp/core). HWPX 는 없이 됩니다")
    }
    // wasm 은 패키지 안 파일을 넘긴다 — 넘기지 않으면 fetch 로 찾는다
    await rhwp.default({ module_or_path: await readFile(createRequire(import.meta.url).resolve("@rhwp/core/rhwp_bg.wasm")) })
    return rhwp
  })()
  loading.catch(() => { loading = null })
  return loading
}

export async function hwpxToHwp(hwpx: Uint8Array | ArrayBuffer, options?: HwpxToHwpOptions): Promise<Uint8Array> {
  const { HwpDocument } = await loadRhwp()
  const doc = new HwpDocument(hwpx instanceof Uint8Array ? hwpx : new Uint8Array(hwpx))
  try {
    const out = doc.exportHwpWithReport()
    try {
      const losses = (JSON.parse(out.contentLoss()) as { losses?: { code?: string; subject?: string }[] }).losses ?? []
      if (losses.length && options?.warnings) {
        const kinds = [...new Set(losses.map((l) => `${LOSS_LABEL[l.code ?? ""] ?? l.code}${l.subject ? `(${l.subject})` : ""}`))]
        options.warnings.push(`HWP 로 옮기며 빠진 내용 ${losses.length}건: ${kinds.join(", ")}`)
      }
      return out.takeBytes()
    } finally {
      out.free()
    }
  } finally {
    doc.free()
  }
}
