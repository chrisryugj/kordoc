/**
 * place_seal — 도장/서명 이미지를 앵커 문구("(인)"·"서명 또는 인" 등) 위에
 * 부유(글 앞) 배치. 표/페이지 불확장 (P6, claw-hwp placeSeal 이식).
 *
 * 원리:
 * - 앵커 문구가 든 문단을 찾아 그 문단에 <hp:pic> 부유 개체를 anchor 한다.
 *   핵심 속성: treatAsChar="0" + flowWithText="0" + allowOverlap="1" +
 *   textWrap="IN_FRONT_OF_TEXT" — flowWithText="1"이면 한컴이 개체 높이만큼
 *   셀/페이지를 키운다 (claw-hwp GT 검증 규칙).
 * - 수평 위치는 폰트 메트릭으로 계산: 전각(한글/CJK)=1em, ASCII·반각=0.5em,
 *   em = 앵커 run charPr 높이(1/100pt). 렌더 없이 배치하고 렌더는 검증용.
 * - 가운데/오른쪽 정렬 문단(서식 셀에 흔함)은 블록 전체가 밀리므로
 *   (사용가능폭 − 문단폭)의 정렬 이동분을 x에 더한다.
 * - 위치 프레임은 PARA(문단 좌상단 기준) — 한컴은 문단 위로는 못 올라가게
 *   클램프하므로, 여유 공간이 있는 표 셀에서는 줄 세로 중앙에 앉고 본문
 *   최상단 줄에서는 상단 정렬로 눕는다.
 *
 * 적용 범위: 본문/표 셀/글상자 문단 (머리말·꼬리말·각주 내 앵커는 제외).
 * ZIP 재조립은 patchZipEntries — 비변경 엔트리는 1바이트도 건드리지 않고,
 * 도장 PNG는 BinData 신규 엔트리 + manifest(opf:item) 등재로 추가한다.
 */

import JSZip from "jszip"
import { KordocError, precheckZipSize } from "../utils.js"
import {
  scanSectionXml, applySplices,
  type ScanParagraph, type ScanCell, type ScanTable, type SectionScan, type SpliceEdit,
} from "../roundtrip/source-map.js"
import { patchZipEntries } from "../roundtrip/zip-patch.js"
import { parseRenderStyles } from "../render/head-styles.js"

const HU_PER_MM = 7200 / 25.4
const mm2hu = (mm: number): number => Math.round(mm * HU_PER_MM)

/** 도장 배치 요청 */
export interface SealOp {
  /** 앵커 문구 (예: "(인)", "서명 또는 인") */
  anchor: string
  /** 같은 앵커가 여럿일 때 0-based 선택 (기본 0) */
  occurrence?: number
  /** 도장/서명 이미지 바이트 (투명 배경 PNG 권장) */
  image: Uint8Array
  /** 이미지 확장자 (기본 png) */
  ext?: "png" | "jpg" | "jpeg" | "bmp" | "gif"
  /** 도장 한 변 크기 mm (기본: 줄높이×1.6, 7~18mm 클램프) */
  sizeMm?: number
  /** overlap=문구 위에 겹침, right=문구 오른쪽 옆, auto=공간 있으면 right (기본 auto) */
  mode?: "overlap" | "right" | "auto"
  /** 미세조정 mm */
  dxMm?: number
  dyMm?: number
}

/** 배치 결과 (도장 1개당 1건) */
export interface SealPlacement {
  anchor: string
  occurrence: number
  sectionIndex: number
  mode: "overlap" | "right"
  posXMm: number
  posYMm: number
  sizeMm: number
  /** ZIP에 추가된 이미지 파트 경로 (BinData/imageN.ext) */
  entry: string
  /** 근사 한계 경고 — 탭·줄바꿈 문단(seal-8), 중첩표(seal-2), 글상자(seal-3). 실측 전 근사. */
  warnings?: string[]
}

export interface PlaceSealResult {
  buffer: ArrayBuffer
  placed: SealPlacement[]
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  bmp: "image/bmp",
  gif: "image/gif",
}

/** 이미지 매직바이트가 확장자와 일치하는지 — .png 이름의 비-PNG(HTML 에러페이지·텍스트)가
 *  BinData 에 매장되고 image/png 로 등재되는 것을 차단 */
function imageMagicMatches(buf: Uint8Array, ext: string): boolean {
  switch (ext) {
    case "png": return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    case "jpg": case "jpeg": return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    case "bmp": return buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d
    case "gif": return buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46
    default: return false
  }
}

/** 코드 유닛 하나의 시각 폭(em) — CJK/한글/전각=1, ASCII·반각(공백 포함)=0.5, 제어=0 */
function glyphEm(code: number): number {
  if (code < 0x20) return 0
  if (code <= 0x7e) return 0.5
  if (code >= 0xff61 && code <= 0xffdc) return 0.5 // 반각 가나/자모
  return 1.0
}

/** 문자열의 폰트 메트릭 폭(mm) */
function measureMm(text: string, emMm: number): number {
  let w = 0
  for (const ch of text) w += glyphEm(ch.codePointAt(0) ?? 0) * emMm
  return w
}

/** 문단이 속한 셀·표 (앵커 문단 → 셀 폭·좌측 오프셋·정렬 이동 계산용) */
interface ParaSite {
  para: ScanParagraph
  cell?: ScanCell
  table?: ScanTable
  /** 중첩표(depth>0) 셀에 속한 문단 — seal-2 근사 한계 경고용 */
  nested?: boolean
  /** 바깥(조상) 셀 체인 — 중첩표 앵커 가로 원점에 바깥 셀 좌측 오프셋 가산용 (seal-2) */
  outer?: Array<{ cell: ScanCell; table: ScanTable }>
}

/** 섹션의 본문+셀+글상자 문단을 문서 순서로 평탄화 (머리말·각주 등 excluded 제외) */
function collectSites(scan: SectionScan): ParaSite[] {
  const sites: ParaSite[] = []
  for (const p of scan.bodyParagraphs) sites.push({ para: p })
  const walkTables = (tables: ScanTable[], depth: number, outer: Array<{ cell: ScanCell; table: ScanTable }>): void => {
    if (depth > 16) return
    for (const t of tables) {
      for (const row of t.rows) {
        for (const cell of row) {
          for (const p of cell.paragraphs) sites.push({ para: p, cell, table: t, nested: depth > 0, outer: outer.length ? outer : undefined })
          walkTables(cell.tables, depth + 1, [...outer, { cell, table: t }])
        }
      }
    }
  }
  walkTables(scan.tables, 0, [])
  walkTables(scan.orphanTables, 0, [])
  sites.sort((a, b) => a.para.start - b.para.start)
  return sites
}

/** 여는 태그 문자열에서 속성값 추출 */
function attrOf(openTag: string, name: string): string | undefined {
  const m = openTag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m?.[1]
}

/** para.start의 <hp:p ...> 여는 태그 전체 */
function paraOpenTag(xml: string, para: ScanParagraph): string {
  const end = xml.indexOf(">", para.start)
  return end === -1 ? "" : xml.slice(para.start, end + 1)
}

/** 앵커가 든 run의 charPrIDRef·네임스페이스 프리픽스·run 닫는 위치 */
function anchorRunInfo(
  xml: string,
  para: ScanParagraph,
  anchor: string,
): { charPr: string; prefix: string; insertAt: number } | null {
  // 앵커 문자열이 통째로 들어있는 tRange 우선, 없으면 마지막 tRange (run 경계에 걸친 앵커)
  let tr = para.tRanges.find(r => !r.selfClosing && xml.slice(r.contentStart, r.contentEnd).includes(anchor))
  if (!tr) {
    // 앵커가 run 경계에 걸침(부분 굵게·엔티티 분할) — 마지막 run 이 아니라 앵커 첫 글자가
    // 든 run(앵커 대표 크기)으로 폴백해 글자 크기 배율 드리프트를 줄인다.
    const head = anchor[0]
    tr = para.tRanges.find(r => !r.selfClosing && xml.slice(r.contentStart, r.contentEnd).includes(head))
      ?? para.tRanges[para.tRanges.length - 1]
  }
  if (!tr) return null

  const before = xml.slice(Math.max(0, para.start), tr.contentStart)
  const runOpen = [...before.matchAll(/<([A-Za-z0-9]+):run\b[^>]*>/g)].pop()
  const prefix = runOpen?.[1] ?? tr.prefix ?? "hp"
  const charPr = (runOpen && attrOf(runOpen[0], "charPrIDRef")) || "0"
  const close = xml.indexOf(`</${prefix}:run>`, tr.contentEnd)
  if (close === -1) return null
  return { charPr, prefix, insertAt: close + `</${prefix}:run>`.length }
}

/** 셀 <hp:tc> 안의 cellAddr 근접 창 — cellSz/cellMargin 은 cellAddr 의 형제
 *  (한컴 저장본: addr→span→sz→margin→subList, kordoc 생성본: subList→addr→span→sz→margin) */
function cellAddrWindow(xml: string, cell: ScanCell): string | null {
  if (!cell.addrTagRange) return null
  return xml.slice(cell.addrTagRange.end, cell.addrTagRange.end + 400)
}

/** 셀의 cellSz 폭(hwpunit) */
function cellSzWidthHu(xml: string, cell: ScanCell): number | null {
  const win = cellAddrWindow(xml, cell)
  if (win) {
    const m = win.match(/<[A-Za-z0-9]+:cellSz\b[^>]*\bwidth="(\d+)"/)
    if (m) return Number(m[1])
  }
  // 폴백: 첫 문단 앞 역탐색 (addrTagRange 없는 변형 — 한컴 저장본 배치에서 유효)
  const firstPara = cell.paragraphs[0]
  if (!firstPara) return null
  const upto = xml.slice(0, firstPara.start)
  const szMatch = [...upto.matchAll(/<[A-Za-z0-9]+:cellSz\b[^>]*\bwidth="(\d+)"[^>]*>/g)].pop()
  return szMatch ? Number(szMatch[1]) : null
}

/** 셀의 콘텐츠 폭(mm) — cellSz − cellMargin 좌우 */
function cellContentWidthMm(xml: string, cell: ScanCell): number | null {
  const width = cellSzWidthHu(xml, cell)
  if (width === null) return null
  let content = width
  const win = cellAddrWindow(xml, cell)
  const mg = win?.match(/<[A-Za-z0-9]+:cellMargin\b[^>]*>/)
  if (mg) {
    content -= Number(attrOf(mg[0], "left") ?? 0) + Number(attrOf(mg[0], "right") ?? 0)
  }
  return content > 0 ? content / HU_PER_MM : null
}

/**
 * 앵커 셀의 표 내 좌측 오프셋(mm) — 같은 행에서 colAddr 이 앞서는 셀들의 cellSz 폭 합.
 *
 * 한컴은 셀 문단에 anchor 된 front 부유(flowWithText=0) 개체의 가로 오프셋을
 * 셀이 아니라 **단(컬럼) 원점**에서 잰다(P1 실측 — PARA/COLUMN 동일). 그래서
 * 셀 내부 좌표에 셀의 좌측 오프셋을 더해야 화면상 앵커 문구를 따라간다.
 * 한계: rowSpan 이 얽힌 복잡 그리드·들여쓴 표는 근사가 어긋날 수 있다(dx 로 보정).
 */
function cellLeftOffsetMm(xml: string, table: ScanTable, cell: ScanCell): number {
  if (cell.colAddr === undefined) return 0
  // 표 전체 행을 훑어 colAddr별 열폭 테이블을 구성한다 — rowSpan 으로 덮인 행의 <hp:tr>
  // 에는 선행 열 셀 엔트리가 없어(그 행만 보면 오프셋 0), 결재란 세로병합에서 도장이 한
  // 열(약 77mm) 왼쪽에 찍혔다. 다른 행에서 같은 colAddr 의 열폭을 조회해 면역시킨다.
  const colW = new Map<number, number>()
  for (const row of table.rows) {
    for (const c of row) {
      if (c.colAddr === undefined || colW.has(c.colAddr)) continue
      // colSpan>1 병합 셀은 폭이 여러 열에 걸쳐 있어 한 colAddr 에 귀속되지 않는다 — 단일
      // 열 셀로만 열폭을 확정해 가로 병합 제목행에서의 이중계상(도장 표 밖)을 막는다 (seal-1 colspan).
      if (c.colSpan > 1) continue
      const w = cellSzWidthHu(xml, c)
      if (w) colW.set(c.colAddr, w)
    }
  }
  let sum = 0
  for (let col = 0; col < cell.colAddr; col++) sum += colW.get(col) ?? 0
  return sum / HU_PER_MM
}

/** 본문 단 폭(mm) — secPr pagePr(용지 − 좌우 여백), 실패 시 150mm */
function bodyColumnWidthMm(xml: string): number {
  const page = xml.match(/<[A-Za-z0-9]+:pagePr\b[^>]*\bwidth="(\d+)"[^>]*>/)
  const margin = xml.match(/<[A-Za-z0-9]+:margin\b[^>]*\bleft="(\d+)"[^>]*\bright="(\d+)"[^>]*>/)
  if (!page) return 150
  const w = Number(page[1]) - (margin ? Number(margin[1]) + Number(margin[2]) : 0)
  return w > 0 ? w / HU_PER_MM : 150
}

/** 부유(글 앞) hp:pic XML — claw-hwp buildPic 폴백 템플릿의 float 변형 */
function buildFloatPicXml(
  itemId: string,
  sizeHu: number,
  posXHu: number,
  posYHu: number,
  ids: { id: number; instid: number },
): string {
  const w = sizeHu
  const h = sizeHu
  // xmlns:hc 자체 선언 — kordoc 생성 section0.xml 은 hc 프리픽스를 선언하지 않아
  // (한컴 저장본은 선언), pic 요소에 지역 선언해야 웰폼드가 유지된다 (중복 선언 무해).
  return (
    `<hp:pic xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" id="${ids.id}" zOrder="0" numberingType="PICTURE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${ids.instid}" reverse="0">` +
    `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/>` +
    `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
    `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
    `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>` +
    `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
    `<hp:imgDim dimwidth="${w}" dimheight="${h}"/>` +
    `<hc:img binaryItemIDRef="${itemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>` +
    `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
    // horzRelTo=COLUMN: 셀 안에서는 셀 콘텐츠 영역이 원점(한컴 실측 — v3.10 사진대지),
    // 본문에서는 단 왼쪽이 원점이라 PARA와 동일하게 동작한다. PARA를 쓰면 셀 내부
    // 개체의 가로 원점을 한컴이 표를 담은 바깥 문단으로 잡아 도장이 옆 셀로 밀린다
    // (P1 시각검증 실측). 세로는 PARA 유지 — 앵커 줄 기준 배치.
    `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="${posYHu}" horzOffset="${posXHu}"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>kordoc seal</hp:shapeComment>` +
    `</hp:pic>`
  )
}

/**
 * HWPX에 도장/서명 이미지를 앵커 문구 기준으로 부유 배치한다.
 *
 * @param hwpxBuffer 원본 HWPX
 * @param ops 도장 배치 요청 (여러 개 가능 — 같은 이미지 재사용 시에도 op마다 파트가 추가됨)
 * @throws KordocError 앵커 미발견 (본문 내 등장 횟수를 메시지에 포함)
 */
export async function placeSealHwpx(hwpxBuffer: ArrayBuffer, ops: SealOp[]): Promise<PlaceSealResult> {
  if (ops.length === 0) throw new KordocError("place_seal: 배치할 도장이 없습니다")
  const u8 = new Uint8Array(hwpxBuffer)
  precheckZipSize(hwpxBuffer) // 파싱 경로와 같은 ZIP bomb 가드
  const zip = await JSZip.loadAsync(hwpxBuffer)

  const sectionPaths = Object.keys(zip.files)
    .filter(name => /[Ss]ection\d+\.xml$/i.test(name))
    // 사전순 대신 숫자순 — section10 이 section2 앞에 오면 occurrence·sectionIndex 가
    // 파서(zip-sections compareSectionPaths)의 문서 순서와 어긋나 엉뚱한 위치에 날인된다.
    .sort((a, b) => (Number(a.match(/(\d+)\.xml$/i)?.[1] ?? 0)) - (Number(b.match(/(\d+)\.xml$/i)?.[1] ?? 0)))
  if (sectionPaths.length === 0) throw new KordocError("HWPX에서 섹션 파일을 찾을 수 없습니다")

  const manifestPath = Object.keys(zip.files).find(name => /\.hpf$/i.test(name))

  // 스타일 (charPr 높이 = 1/100pt, 문단 정렬)
  const headerPath = Object.keys(zip.files).find(name => /(^|\/)header\.xml$/i.test(name))
  const styles = headerPath ? parseRenderStyles(await zip.file(headerPath)!.async("text")) : null

  const sectionXmls: string[] = []
  const scans: SectionScan[] = []
  for (let si = 0; si < sectionPaths.length; si++) {
    const xml = await zip.file(sectionPaths[si])!.async("text")
    sectionXmls.push(xml)
    scans.push(scanSectionXml(xml, si))
  }
  const sitesBySection = scans.map(collectSites)

  // 기존 BinData 번호·manifest id와 충돌하지 않는 시작 번호
  const usedIds = new Set<string>()
  let manifestXml = ""
  if (manifestPath) {
    manifestXml = await zip.file(manifestPath)!.async("text")
    for (const m of manifestXml.matchAll(/<opf:item\b[^>]*\bid="([^"]+)"/g)) usedIds.add(m[1])
  }
  const usedImageNums = new Set<number>()
  for (const name of Object.keys(zip.files)) {
    const m = name.match(/^BinData\/(?:image|img)(\d+)\./i)
    if (m) usedImageNums.add(Number(m[1]))
  }
  const nextImageNum = (): number => {
    let n = 1
    while (usedImageNums.has(n) || usedIds.has(`image${n}`)) n++
    usedImageNums.add(n)
    return n
  }

  // 개체 id — 문서 내 기존 숫자 id 최댓값 다음부터 (충돌 방지·결정적)
  let maxId = 1_000_000
  for (const xml of sectionXmls) {
    for (const m of xml.matchAll(/\b(?:id|instid)="(\d+)"/g)) {
      const v = Number(m[1])
      if (Number.isFinite(v) && v > maxId) maxId = v
    }
  }

  const splicesBySection: SpliceEdit[][] = sectionPaths.map(() => [])
  const additions = new Map<string, Uint8Array>()
  const manifestItems: string[] = []
  const placed: SealPlacement[] = []

  for (const op of ops) {
    if (!op.anchor) throw new KordocError("place_seal: anchor 문구가 필요합니다")
    if (!op.image || op.image.length === 0) throw new KordocError("place_seal: 도장 이미지가 필요합니다")
    const ext = (op.ext ?? "png").toLowerCase()
    if (!MIME[ext]) throw new KordocError(`place_seal: 지원하지 않는 이미지 확장자 .${ext} (png/jpg/bmp/gif)`)
    if (!imageMagicMatches(op.image, ext)) throw new KordocError(`place_seal: 이미지 내용이 .${ext} 형식이 아닙니다 (매직바이트 불일치)`)
    const wantOcc = op.occurrence ?? 0

    // 앵커 탐색 — 전 섹션 문서 순서, 문단 내 다중 등장 포함
    let found: { si: number; site: ParaSite; idxInText: number } | null = null
    let total = 0
    for (let si = 0; si < scans.length && !found; si++) {
      for (const site of sitesBySection[si]) {
        let from = 0
        for (;;) {
          const idx = site.para.text.indexOf(op.anchor, from)
          if (idx === -1) break
          if (total === wantOcc) {
            found = { si, site, idxInText: idx }
            break
          }
          total++
          from = idx + op.anchor.length
        }
        if (found) break
      }
    }
    if (!found) {
      // 전체 등장 수를 처음부터 다시 세어 에러 메시지에 (claw-hwp와 동일한 안내)
      total = 0
      for (let si = 0; si < scans.length; si++) {
        for (const site of sitesBySection[si]) {
          let from = 0
          for (;;) {
            const idx = site.para.text.indexOf(op.anchor, from)
            if (idx === -1) break
            total++
            from = idx + op.anchor.length
          }
        }
      }
      throw new KordocError(
        `place_seal: 앵커 "${op.anchor}" ${wantOcc}번째 등장을 찾지 못했습니다 ` +
        `(본문 내 ${total}회 등장 — occurrence 0..${Math.max(0, total - 1)})`,
      )
    }

    const { si, site, idxInText } = found
    const xml = sectionXmls[si]
    const run = anchorRunInfo(xml, site.para, op.anchor)
    if (!run) {
      throw new KordocError(`place_seal: 앵커 "${op.anchor}" 문단에서 run을 찾지 못했습니다`)
    }

    // 폰트 메트릭
    const charPrHeight = styles?.charPr.get(run.charPr)?.height ?? 1000 // 1/100pt
    const fontPt = charPrHeight / 100
    const emMm = (fontPt * 25.4) / 72
    const lineHMm = emMm
    const startXMm = measureMm(site.para.text.slice(0, idxInText), emMm)
    const anchorWMm = measureMm(op.anchor, emMm)
    // NaN·음수 sizeMm(CLI 비숫자·직접 호출)은 기본 크기로 폴백 — hp:sz width="NaN" 등
    // OWPML 정수 속성에 NaN 문자열이 기록되던 것 원천 차단 (seal-4)
    const sizeMm = (op.sizeMm != null && Number.isFinite(op.sizeMm) && op.sizeMm > 0)
      ? op.sizeMm
      : Math.max(7, Math.min(18, lineHMm * 1.6))

    // 사용가능 폭 + 정렬 이동
    const availMm = (site.cell ? cellContentWidthMm(xml, site.cell) : null) ?? bodyColumnWidthMm(xml)
    const paraPrId = attrOf(paraOpenTag(xml, site.para), "paraPrIDRef") ?? "0"
    const align = styles?.paraAlign.get(paraPrId)
    let alignShiftMm = 0
    if (align === "CENTER" || align === "RIGHT") {
      const paraWMm = measureMm(site.para.text, emMm)
      alignShiftMm = align === "CENTER" ? (availMm - paraWMm) / 2 : availMm - paraWMm
      if (!Number.isFinite(alignShiftMm) || alignShiftMm < 0) alignShiftMm = 0
    }

    let mode = op.mode ?? "auto"
    if (mode === "auto") {
      mode = availMm - (alignShiftMm + startXMm + anchorWMm) >= sizeMm + 2 ? "right" : "overlap"
    }

    // 셀 앵커: 한컴이 front 부유 가로 오프셋을 단(컬럼) 원점에서 재므로 셀 좌측 오프셋 가산.
    // 중첩표는 바깥(조상) 셀 좌측 오프셋도 체인으로 더한다 — 실측 확정: 바깥 셀 미가산 시
    // 도장이 바깥 열 폭만큼 왼쪽(옆 셀)으로 밀린다 (seal-2, '항상 페이지 단' 모델).
    const cellShiftMm = site.cell && site.table
      ? cellLeftOffsetMm(xml, site.table, site.cell) +
        (site.outer ?? []).reduce((s, o) => s + cellLeftOffsetMm(xml, o.table, o.cell), 0)
      : 0
    const posXMm =
      (mode === "right" ? startXMm + anchorWMm + 2 : startXMm + anchorWMm / 2 - sizeMm / 2) +
      alignShiftMm + cellShiftMm + (op.dxMm ?? 0)
    // 줄 세로 중앙 — PARA 프레임은 문단 위로 클램프되므로 본문 최상단 줄에선 상단 정렬로 동작
    const posYMm = -(sizeMm - lineHMm) / 2 + (op.dyMm ?? 0)

    // 이미지 파트 + manifest 아이템
    const n = nextImageNum()
    const entry = `BinData/image${n}.${ext}`
    const itemId = `image${n}`
    usedIds.add(itemId)
    additions.set(entry, op.image)
    manifestItems.push(`<opf:item id="${itemId}" href="${entry}" media-type="${MIME[ext]}" isEmbeded="1"/>`)

    // 부유 pic run 삽입 (앵커 run 뒤 — PARA 프레임이라 run 위치는 배치에 영향 없음)
    const pic = buildFloatPicXml(itemId, mm2hu(sizeMm), mm2hu(posXMm), mm2hu(posYMm), {
      id: ++maxId,
      instid: ++maxId,
    })
    splicesBySection[si].push({
      start: run.insertAt,
      end: run.insertAt,
      replacement: `<${run.prefix}:run charPrIDRef="${run.charPr}">${pic}</${run.prefix}:run>`,
    })

    // 근사 한계 경고 — 메트릭·원점 모델이 근사인 케이스를 결과에 명시(placed 소비자가 dx/dy 보정)
    const warnings: string[] = []
    const paraSeg = xml.slice(site.para.start, run.insertAt)
    if (/<[A-Za-z0-9]+:tab\b/.test(paraSeg)) warnings.push("탭이 든 문단 — 도장 가로 위치가 근사값입니다 (dx 로 보정)")
    if (/<[A-Za-z0-9]+:(lineBreak|br)\b/.test(paraSeg)) warnings.push("줄바꿈이 든 문단 — 앵커가 2번째 줄 이하면 세로 위치가 어긋날 수 있습니다 (dy 로 보정)")
    if (site.nested) warnings.push("중첩표(표 안 표) 셀 앵커 — 바깥 셀 오프셋을 체인으로 가산하나 셀 여백·정렬은 근사입니다 (필요 시 dx 로 보정)")
    if (site.para.inTextbox) warnings.push("글상자 앵커 — 글상자 기하를 반영하지 않아 정렬 보정이 근사입니다 (dx/dy 로 보정)")

    placed.push({
      anchor: op.anchor,
      occurrence: wantOcc,
      sectionIndex: si,
      mode,
      posXMm: Math.round(posXMm * 100) / 100,
      posYMm: Math.round(posYMm * 100) / 100,
      sizeMm: Math.round(sizeMm * 100) / 100,
      entry,
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  }

  // 재조립 — 변경 섹션 + manifest 교체, 이미지 파트 추가
  const encoder = new TextEncoder()
  const replacements = new Map<string, Uint8Array>()
  for (let si = 0; si < sectionPaths.length; si++) {
    if (splicesBySection[si].length === 0) continue
    replacements.set(sectionPaths[si], encoder.encode(applySplices(sectionXmls[si], splicesBySection[si])))
  }
  if (manifestPath && manifestItems.length > 0) {
    const patched = manifestXml.includes("</opf:manifest>")
      ? manifestXml.replace("</opf:manifest>", `${manifestItems.join("")}</opf:manifest>`)
      : manifestXml
    if (patched !== manifestXml) replacements.set(manifestPath, encoder.encode(patched))
  }

  const out = patchZipEntries(u8, replacements, additions)
  return {
    buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
    placed,
  }
}
