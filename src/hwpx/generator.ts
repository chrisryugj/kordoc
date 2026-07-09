/**
 * Markdown → HWPX 역변환
 *
 * 지원: 헤딩(h1~h6), 단락, 볼드, 이탤릭, 인라인코드, 코드블록,
 *       순서/비순서 리스트, 수평선, 인용문, 테이블
 * jszip으로 HWPX ZIP 패키징.
 *
 * 엔트리(markdownToHwpx)와 재수출만 남김 — 구현은 목적별 모듈로 분리:
 *   gen-ids.ts        — NS/charPr/paraPr id 상수·테마 해석·XML 원자(escapeXml, charPr/paraPr)
 *   md-runs.ts        — 마크다운 블록/인라인 파싱 + run/문단 XML + PrvText
 *   gen-header.ts     — container/manifest/head.xml 생성
 *   gen-gongmun-fit.ts — 공문 자동장평 계획 + 리스트 항목부호 선계산
 *   gen-table.ts      — GFM/HTML(병합) 표 XML
 *   gen-section.ts    — secPr + 본문 section0.xml 조립
 */

import JSZip from "jszip"
import { type GongmunOptions, resolveGongmun } from "./gongmun.js"
import { type HwpxTheme, resolveTheme } from "./gen-ids.js"
import { buildPrvText, parseMarkdownToBlocks } from "./md-runs.js"
import { generateContainerXml, generateManifest, generateHeaderXml } from "./gen-header.js"
import { computeGongmunFitPlan, precomputeGongmunList } from "./gen-gongmun-fit.js"
import { blocksToSectionXml, type ChartPart } from "./gen-section.js"
import { buildProfileRemap, profileCharPrBase, type FormatProfile } from "./gen-profile.js"

export { type HwpxTheme } from "./gen-ids.js"
export {
  type FormatProfile, type TableProfile, type CellProfile,
  type BorderFillDef, type BorderDef, type CharPrDef,
} from "./gen-profile.js"

/** markdownToHwpx 옵션 */
export interface MarkdownToHwpxOptions {
  theme?: HwpxTheme
  /**
   * 공문서 모드 — 지정 시 한국 행정 공문서 표준 서식으로 렌더링한다.
   * (공식 여백, 명조 15pt 본문, 항목부호 8단계 행갈굼 정렬, 줄간격 등)
   * 미지정 시 기존 범용 마크다운 변환 동작 그대로 유지.
   */
  gongmun?: GongmunOptions
  /**
   * 서식 프로필 — 표의 borderFill(테두리·음영)·열 너비·셀 글꼴을 원본 문서 없이
   * 재현한다(이슈 #41). `hwpxToProfile()`로 추출하거나 직접 작성한 프로필을 넘기면,
   * 문서 내 표 등장 순서(table_index)로 매칭해 셀 좌표별 서식을 적용한다.
   * 미지정 시 기존 기본 서식(단일 SOLID 테두리·균등 열폭) 그대로.
   */
  profile?: FormatProfile
}


/**
 * 마크다운 텍스트를 HWPX (ArrayBuffer)로 변환.
 */
export async function markdownToHwpx(
  markdown: string,
  options?: MarkdownToHwpxOptions,
): Promise<ArrayBuffer> {
  const theme = resolveTheme(options?.theme)
  const gongmun = options?.gongmun ? resolveGongmun(options.gongmun) : null
  const blocks = parseMarkdownToBlocks(markdown)
  const gongmunList = gongmun ? precomputeGongmunList(blocks, gongmun) : null
  const fit = gongmun && gongmunList ? computeGongmunFitPlan(blocks, gongmun, gongmunList) : null
  // 서식 프로필 — charPr id는 기본(0~10) + 공문서 장평 variant 다음 번호부터 할당
  const remap = options?.profile
    ? buildProfileRemap(options.profile, profileCharPrBase(fit?.variants?.length ?? 0))
    : null
  const chartParts: ChartPart[] = []
  const sectionXml = blocksToSectionXml(blocks, theme, gongmun, gongmunList, fit, chartParts, remap)

  // 프로필이 있었는데 한 표에도 못 붙었으면 진단 경고 — 매칭은 보수적(불일치=미적용)이라
  // 마크다운을 크게 고쳐 쓴 경우 전멸할 수 있는데, 그걸 조용히 삼키지 않는다. 1회만.
  if (remap && remap.tables.length > 0) {
    const unused = remap.tables.filter(t => !t.used).length
    if (unused === remap.tables.length) {
      // eslint-disable-next-line no-console
      console.warn(`[kordoc] format profile: 프로필 표 ${unused}개가 문서 표와 매칭되지 않아 미적용 (행·열/첫 셀 텍스트 불일치)`)
    }
  }

  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })
  zip.file("META-INF/container.xml", generateContainerXml())
  zip.file("Contents/content.hpf", generateManifest(chartParts))
  zip.file("Contents/header.xml", generateHeaderXml(theme, gongmun, fit?.variants ?? [], remap))
  zip.file("Contents/section0.xml", sectionXml)
  for (const part of chartParts) zip.file(part.name, part.xml)
  // Preview/ — 한글 프로그램의 일부 버전(특히 macOS)이 존재 여부를 확인함
  zip.file("Preview/PrvText.txt", buildPrvText(blocks))

  return await zip.generateAsync({ type: "arraybuffer" })
}
