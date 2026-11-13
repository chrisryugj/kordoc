/**
 * WMF 내 비트맵 추출 — 비트맵(DIB) 하나만 그리는 WMF 는 그 DIB 를 BMP 로 추출해 kordoc BMP 디코더로 넘긴다.
 * 한글은 이미지를 WMF 로 래핑해 저장하기도 한다(공개 시료 WMF 441개 중 80개). 선·도형·텍스트 레코드가 하나라도 있으면
 * 추출하지 않는다 — 비트맵만 출력하면 그 선·텍스트가 누락된다. 벡터 WMF·EMF 는 렌더러가 없어 원본을 유지한다(SKIPPED_IMAGE).
 * Microsoft [MS-WMF] 공개 명세: 레코드 = 크기(16비트 word 수, 4바이트) + 함수 번호(2바이트) + 인자.
 */

const PLACEABLE = 0x9ac6cdd7
/** 그리기가 아닌 레코드 — 상태·좌표계·객체·클립·팔레트·이스케이프·MOVETO. 목록에 없는 레코드는 그리기로 간주한다 */
const STATE = new Set([
  0x001e, 0x0035, 0x0037, 0x00f7, 0x0102, 0x0103, 0x0104, 0x0105, 0x0106, 0x0107, 0x0108, 0x0127, 0x012c, 0x012d, 0x012e,
  0x0139, 0x0142, 0x0149, 0x01f0, 0x01f9, 0x0201, 0x0209, 0x020a, 0x020b, 0x020c, 0x020d, 0x020e, 0x020f, 0x0211, 0x0214,
  0x0220, 0x0231, 0x0234, 0x02fa, 0x02fb, 0x02fc, 0x0410, 0x0412, 0x0415, 0x0416, 0x0436, 0x0626, 0x06ff,
])
/** 비트맵을 그리는 레코드 — 파라미터 내 DIB 오프셋, 소스 사각형(x·y·너비·높이) 오프셋, ColorUsage 오프셋(-1 은 없음) */
const DIB: Record<number, { at: number; x: number; y: number; w: number; h: number; usage: number }> = {
  0x0f43: { at: 22, x: 12, y: 10, w: 8, h: 6, usage: 4 }, // STRETCHDIB
  0x0b41: { at: 20, x: 10, y: 8, w: 6, h: 4, usage: -1 }, // DIBSTRETCHBLT
  0x0940: { at: 16, x: 6, y: 4, w: 10, h: 8, usage: -1 }, // DIBBITBLT
  0x0d33: { at: 18, x: 8, y: 6, w: 12, h: 10, usage: 0 }, // SETDIBTODEV
}

/** 레코드를 순회하며 그리기 레코드 수와 비트맵(소스 사각형이 DIB 전체인 것)을 모은다. WMF 가 아니거나 손상되면 null */
function scan(d: Uint8Array): { draws: number; dibs: Uint8Array[] } | null {
  if (d.length < 18) return null
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  let o = v.getUint32(0, true) === PLACEABLE ? 22 : 0
  if (o + 18 > d.length || (v.getUint16(o, true) !== 1 && v.getUint16(o, true) !== 2) || v.getUint16(o + 2, true) !== 9) return null
  o += 18
  let draws = 0
  const dibs: Uint8Array[] = []
  while (o + 6 <= d.length) {
    const size = v.getUint32(o, true) * 2, fn = v.getUint16(o + 4, true), p = o + 6
    if (fn === 0) break // EOF
    if (size < 6 || o + size > d.length) return null
    const r = DIB[fn]
    // DIB 레코드는 크기가 (함수 번호 상위 바이트 + 3) word 보다 클 때만 비트맵을 포함한다 — 아니면 패턴 채우기(그리기)
    if (r && size / 2 > (fn >> 8) + 3 && size > r.at + 6 + 12) {
      const dib = d.subarray(p + r.at, o + size), dv = new DataView(dib.buffer, dib.byteOffset, dib.byteLength)
      const core = dv.getUint32(0, true) === 12
      const [dw, dh] = core ? [dv.getUint16(4, true), dv.getInt16(6, true)] : [dv.getInt32(4, true), dv.getInt32(8, true)]
      // 팔레트 인덱스(DIB_PAL_COLORS)·DIB 일부만 그리는 경우는 추출한 비트맵이 실제 렌더링과 달라 그리기로 간주한다
      const whole = v.getInt16(p + r.x, true) === 0 && v.getInt16(p + r.y, true) === 0 && v.getInt16(p + r.w, true) === dw && v.getInt16(p + r.h, true) === Math.abs(dh)
      if (whole && (r.usage < 0 || v.getUint16(p + r.usage, true) === 0)) dibs.push(dib)
      else draws++
    } else if (!STATE.has(fn)) draws++
    o += size
  }
  return { draws, dibs }
}

/** DIB(BITMAPINFO + 픽셀) 앞에 BITMAPFILEHEADER 를 붙여 BMP 파일로 만든다 */
function dibToBmp(dib: Uint8Array): Uint8Array | null {
  if (dib.length < 12) return null
  const v = new DataView(dib.buffer, dib.byteOffset, dib.byteLength), hs = v.getUint32(0, true)
  let colors: number, entry: number, masks = 0
  if (hs === 12) {
    const bpp = v.getUint16(10, true)
    colors = bpp <= 8 ? 1 << bpp : 0; entry = 3
  } else if (hs >= 40 && dib.length >= 40) {
    const bpp = v.getUint16(14, true), comp = v.getUint32(16, true), used = v.getUint32(32, true)
    colors = used || (bpp <= 8 ? 1 << bpp : 0); entry = 4
    if (hs === 40) masks = comp === 3 ? 12 : comp === 6 ? 16 : 0
  } else return null
  const bmp = new Uint8Array(14 + dib.length), bv = new DataView(bmp.buffer)
  bmp.set([0x42, 0x4d]); bv.setUint32(2, bmp.length, true); bv.setUint32(10, 14 + hs + masks + colors * entry, true)
  bmp.set(dib, 14)
  return bmp
}

/** 비트맵 하나만 그리는 WMF → 그 비트맵의 BMP 파일. 아니면 null.
 *  shortcut: 비트맵 원본 크기로 출력한다 — 대상 사각형 비율·매핑 모드 반전은 반영하지 않음, 그런 시료가 나오면 sharp resize 추가 */
export function wmfBitmap(d: Uint8Array): Uint8Array | null {
  const r = scan(d)
  return r && !r.draws && r.dibs.length === 1 ? dibToBmp(r.dibs[0]) : null
}

/** 그리기 레코드가 하나도 없는 빈 WMF */
export function isEmptyWmf(d: Uint8Array): boolean {
  const r = scan(d)
  return !!r && !r.draws && !r.dibs.length
}
