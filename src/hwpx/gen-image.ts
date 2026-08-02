/**
 * 이미지 placeholder 방출 (v4.0.5) — 마크다운 `![alt](url)`·HTML `<img>` 참조를
 * 텍스트로 뭉개지 않고 1×1 placeholder 바이너리 + <hp:pic>로 방출한다.
 *
 * 배경: 종전에는 이미지 참조가 alt 텍스트("image")로 각인돼 (1) 재파싱 시 이미지
 * 존재 자체가 소실되고 (2) 이미지 열이 빈 열이 되어 후행 열 트림으로 표 구조가
 * 붕괴했다(라운드트립 tableExact 최대 결손). 바이너리 원본이 없어도 참조와 위치를
 * 보존하는 것이 목적 — 실제 픽셀은 1×1 placeholder다.
 *
 * <hp:pic> 형상은 실측 한컴 저장본(corpus 10772982)을 미러 — 필수 자식 전부 포함.
 */

import { PIC_ID_BASE } from "./geometry.js"

/** 1×1 24bit 흰색 BMP (58바이트) — .bmp 참조용 */
const PLACEHOLDER_BMP = Uint8Array.from([
  0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00,
  0x28, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
  0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00,
  0x13, 0x0b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x00,
])

/** 1×1 투명 PNG (68바이트) — bmp 외 확장자 참조용 */
const PLACEHOLDER_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
  0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
  0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
}

/** 등록된 이미지 파트 — ZIP·manifest 등재용 */
export interface ImagePart {
  /** ZIP 경로 (BinData/xxx.ext) */
  name: string
  /** manifest item id == binaryItemIDRef (확장자 없는 basename) */
  itemId: string
  mime: string
  data: Uint8Array
  /** 실데이터 표기 크기 (HWPUNIT) — 없으면 placeholder 크기(1130) */
  wHU?: number
  hHU?: number
}

/** 매직바이트 → mime/확장자 (HWPX가 소화하는 래스터 포맷만 — webp 등은 미지원 폴백) */
function sniffImage(b: Uint8Array): { mime: string; ext: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { mime: "image/gif", ext: "gif" }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { mime: "image/bmp", ext: "bmp" }
  return null
}

/** 픽셀 치수 프로브 (PNG/JPEG/GIF/BMP) — 실패 시 null (placeholder 크기 폴백) */
export function probeImageSize(b: Uint8Array): { w: number; h: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  try {
    if (b[0] === 0x89 && b[1] === 0x50) {
      // PNG — IHDR은 시그니처(8)+길이(4)+"IHDR"(4) 뒤 고정 오프셋
      return { w: dv.getUint32(16), h: dv.getUint32(20) }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      // JPEG — SOF0~SOF15(0xC0~0xCF, C4/C8/CC 제외) 마커의 height/width
      let i = 2
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue }
        const marker = b[i + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5) }
        }
        i += 2 + dv.getUint16(i + 2)
      }
      return null
    }
    if (b[0] === 0x47 && b[1] === 0x49) {
      // GIF — logical screen descriptor (LE)
      return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) }
    }
    if (b[0] === 0x42 && b[1] === 0x4d) {
      // BMP — BITMAPINFOHEADER (LE, height는 절대값)
      return { w: dv.getUint32(18, true), h: Math.abs(dv.getInt32(22, true)) }
    }
  } catch { /* 손상 헤더 — 크기 미상 */ }
  return null
}

/** px → HWPUNIT (96dpi 기준: 1px = 75HU), 본문폭(170mm) 초과 시 비례 축소 */
const PX_TO_HU = 75
const MAX_IMG_W_HU = 48189 // 170mm — 공문서 본문폭과 동일한 보수적 상한

/**
 * 문서 단위 이미지 레지스트리 — url 기준 dedupe, 안전한 상대 파일명만 수용.
 * 수용 불가 url(스킴·경로 구분자·미지의 확장자)은 null — 호출부가 종전 alt 텍스트 폴백.
 */
export class ImageRegistry {
  private byUrl = new Map<string, ImagePart | null>()
  private ids = new Set<string>()
  readonly parts: ImagePart[] = []
  private picSeq = 0
  private binSeq = 0

  /** @param supplied url → 실데이터 바이트 (markdownToHwpx images 옵션) */
  constructor(private readonly supplied?: Map<string, Uint8Array>) {}

  /** url 등록(중복 시 기존 파트) — 수용 불가면 null */
  take(url: string): ImagePart | null {
    const cached = this.byUrl.get(url)
    if (cached !== undefined) return cached
    // 실데이터 경로 (v4.5.0) — images 옵션 바이트 또는 data: URI를 실제로 임베드
    const real = this.takeReal(url)
    if (real) {
      this.byUrl.set(url, real)
      return real
    }
    let part: ImagePart | null = null
    // 파일명만 허용 — 경로 구분자·스킴 배제 (ZIP 경로 주입 방지)
    const m = /^([A-Za-z0-9._-]+)\.([A-Za-z0-9]+)$/.exec(url)
    const mime = m ? IMAGE_EXT_MIME[m[2].toLowerCase()] : undefined
    if (m && mime && !url.includes("..")) {
      let itemId = m[1].replace(/[^A-Za-z0-9_]/g, "_")
      // itemId 충돌(a.png vs a.bmp) 시 접미 부여
      let n = 1
      while (this.ids.has(itemId)) itemId = `${m[1].replace(/[^A-Za-z0-9_]/g, "_")}_${n++}`
      this.ids.add(itemId)
      part = {
        name: `BinData/${url}`,
        itemId,
        mime,
        data: m[2].toLowerCase() === "bmp" ? PLACEHOLDER_BMP : PLACEHOLDER_PNG,
      }
      this.parts.push(part)
    }
    this.byUrl.set(url, part)
    return part
  }

  /** 실데이터 등록 — images 맵 바이트·data: URI. 포맷 미상(webp 등)은 null → placeholder 폴백 */
  private takeReal(url: string): ImagePart | null {
    let bytes = this.supplied?.get(url)
    if (!bytes && url.startsWith("data:")) {
      const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url)
      if (m) {
        try { bytes = new Uint8Array(Buffer.from(m[1].replace(/\s+/g, ""), "base64")) } catch { /* 손상 base64 */ }
      }
    }
    if (!bytes || bytes.length === 0) return null
    const sniffed = sniffImage(bytes)
    if (!sniffed) return null
    // ZIP 파트명 — 안전한 원본 파일명이면 유지, 아니면(경로·data URI) 순번 파일명
    const safe = /^([A-Za-z0-9._-]+)\.([A-Za-z0-9]+)$/.exec(url)
    const base = safe && !url.includes("..") ? safe[1] : `image${++this.binSeq}`
    let itemId = base.replace(/[^A-Za-z0-9_]/g, "_")
    let n = 1
    while (this.ids.has(itemId)) itemId = `${base.replace(/[^A-Za-z0-9_]/g, "_")}_${n++}`
    this.ids.add(itemId)
    const dim = probeImageSize(bytes)
    let wHU: number | undefined, hHU: number | undefined
    if (dim && dim.w > 0 && dim.h > 0) {
      wHU = dim.w * PX_TO_HU
      hHU = dim.h * PX_TO_HU
      if (wHU > MAX_IMG_W_HU) {
        hHU = Math.round(hHU * (MAX_IMG_W_HU / wHU))
        wHU = MAX_IMG_W_HU
      }
    }
    const part: ImagePart = { name: `BinData/${itemId}.${sniffed.ext}`, itemId, mime: sniffed.mime, data: bytes, wHU, hHU }
    this.parts.push(part)
    return part
  }

  /** manifest <opf:item> 조각들 (실측: isEmbeded="1") */
  manifestItems(): string[] {
    return this.parts.map((p) => `<opf:item id="${p.itemId}" href="${p.name}" media-type="${p.mime}" isEmbeded="1"/>`)
  }

  /** 인라인 <hp:pic> XML — 실측 저장본 미러, treatAsChar=1 (셀·문단 안 배치) */
  inlinePicXml(part: ImagePart): string {
    const id = PIC_ID_BASE + ++this.picSeq
    // placeholder는 ≈4mm 정사각, 실데이터는 실치수(96dpi 환산·본문폭 캡)
    const w = part.wHU ?? 1130
    const h = part.hHU ?? 1130
    // xmlns:hc는 pic 요소에 인라인 선언 — 섹션 루트는 hs/hp만 선언하므로(기존 산출물
    // 바이트 보존) hc: 자식(transMatrix·img 등)이 여기서 네임스페이스를 얻는다
    return `<hp:pic id="${id}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}" reverse="0" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">`
      + `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/>`
      + `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.floor(w / 2)}" centerY="${Math.floor(h / 2)}" rotateimage="1"/>`
      + `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>`
      + `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>`
      + `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>`
      + `<hp:imgDim dimwidth="${w}" dimheight="${h}"/>`
      + `<hc:img binaryItemIDRef="${part.itemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>`
      + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
      + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
      + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
      + `</hp:pic>`
  }
}

/** 마크다운 이미지 참조 정규식 — `![alt](url)` */
export const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

/**
 * 텍스트에서 이미지 참조를 걷어내고 url 목록 반환 — 셀·문단 공용.
 * (레지스트리 수용 여부와 무관하게 걷는다 — 수용 실패 url은 호출부가 alt로 폴백)
 */
export function splitImageRefs(text: string): { text: string; urls: string[] } {
  const urls: string[] = []
  const out = text.replace(MD_IMAGE_RE, (_, url: string) => { urls.push(url); return "" })
  return { text: out, urls }
}
