/**
 * HEIC·HEIF(HEVC) 디코딩 — 아이폰 기본 사진 형식. sharp prebuilt 에는 HEVC 디코더가 없다(AV1 인 AVIF 만 읽는다).
 *
 * libheif-js(libheif + libde265 의 wasm 빌드, LGPL-3.0)가 설치돼 있을 때만 동적 import 한다. HEVC 는 특허가 걸린 코덱이라
 * kordoc 이 함께 설치하지 않는다 — 필요한 사용자가 `npm install libheif-js` 로 설치한다. 없으면 MISSING_DEPENDENCY.
 * `libheif-js/wasm` 은 wasm 파일을 현재 작업 폴더 기준으로 찾아 실패하므로, wasm 이 내장된 번들(libheif-bundle.js)을 쓴다.
 * 이미지마다 인스턴스를 새로 만든다(수 ms) — wasm 메모리는 줄어들지 않아, 인스턴스 하나를 계속 쓰면 가장 큰 사진만큼의 heap 이 프로세스 끝까지 남는다.
 */

import { KordocError } from "../utils.js"

/** 기본 상한은 sharp 기본 limitInputPixels(16383²) — 이미지 파일 입력이 PNG·JPEG 와 같은 크기까지 받게(아이폰 48MP 사진 포함).
 *  문서 내 이미지 변환은 다른 포맷과 같은 MAX_PIXELS 를 넘긴다. 상한은 RGBA 버퍼를 할당하기 전에 헤더 크기로 확인한다 */
const MAX_HEIC_PIXELS = 0x3fff * 0x3fff

interface HeifImage {
  get_width(): number
  get_height(): number
  is_primary(): boolean
  display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (out: unknown) => void): void
  free(): void
}
interface Libheif { HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] } }
type LibheifFactory = () => Libheif

let loading: Promise<LibheifFactory> | undefined

function loadLibheif(): Promise<LibheifFactory> {
  return loading ??= import("libheif-js/libheif-wasm/libheif-bundle.js").then(
    mod => ((mod as { default?: LibheifFactory }).default ?? mod) as LibheifFactory,
    e => {
      loading = undefined
      throw new KordocError(`HEIC·HEIF 이미지를 읽으려면 optional dependency 'libheif-js' 가 필요합니다. \`npm install libheif-js\` 후 다시 실행하세요. 원인: ${(e as Error).message}`)
    },
  )
}

/** libheif-js 를 불러올 수 있는가 — 바꾸지 못한 HEIC 경고에 설치 안내를 붙일지 */
export const hasLibheif = (): Promise<boolean> => loadLibheif().then(() => true, () => false)

/** HEIC·HEIF primary 이미지 → RGBA8. 회전(irot)·반전(imir)은 libheif 가 적용한다 */
export async function heicToRgba(bytes: Uint8Array, maxPixels = MAX_HEIC_PIXELS): Promise<{ data: Uint8Array; width: number; height: number }> {
  const libheif = (await loadLibheif())()
  // libheif-js 는 오류를 console.log 로 출력한다 — CLI stdout·MCP stdio 가 깨지지 않게 디코딩하는 동안 끈다
  const log = console.log
  console.log = () => {}
  let images: HeifImage[] = []
  try {
    images = new libheif.HeifDecoder().decode(bytes)
    const img = images.find(i => i.is_primary()) ?? images[0]
    if (!img) throw new KordocError("HEIC·HEIF 디코딩 실패: 이미지가 없습니다")
    const width = img.get_width(), height = img.get_height()
    if (width * height > maxPixels) throw new KordocError(`HEIC·HEIF 이미지가 너무 큽니다 (${width}×${height})`)
    const data = new Uint8ClampedArray(width * height * 4)
    await new Promise<void>((resolve, reject) => img.display({ data, width, height }, out => out ? resolve() : reject(new KordocError("HEIC·HEIF 디코딩 실패"))))
    return { data: new Uint8Array(data.buffer), width, height }
  } finally {
    console.log = log
    for (const i of images) i.free()
  }
}
