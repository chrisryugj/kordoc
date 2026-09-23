/** kordoc MCP 도구 — 생성 — extract_profile·generate_document */

import { z } from "zod"
import { readFile, writeFile, mkdir, realpath } from "fs/promises"
import { resolve, dirname, join } from "path"
import { markdownToHwpx, unknownFontWarnings, usesGaejosikMunche, PRESET_ALIAS, incompatibleGongmunWarnings, gongmunLintWarnings, muncheLintWarnings } from "../index.js"
import type { GongmunOptions } from "../index.js"
import { buildGongmunOptions, BODY_FONTS, H2_MARKERS, BULLET2_CHARS, FONT_ROLE_KEYS, SIZE_KEYS, DOC_HEAD_KEYS, DOC_FOOT_KEYS, DOC_INFO_KEYS, NOTICE_HEAD_KEYS, PRESS_CONTACT_KEYS, BODY_PT_RANGE, LINE_SPACING_RANGE, SIZE_PT_RANGE, APPROVAL_MAX, LEVEL_STYLE_KEYS } from "../hwpx/gongmun-surface.js"
import { assertWithinRoot } from "../shared/offline.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { PROFILE_EXTENSIONS, safePath, safeOutputPath, describeError, readValidatedFile } from "./shared.js"

export function registerGenerateTools(server: McpServer): void {
  // ─── 도구: extract_profile ───────────────────────────

  server.tool(
    "extract_profile",
    "참조 HWPX 문서에서 표 서식 프로필(테두리·음영·열 너비·셀 글꼴)을 JSON으로 추출합니다. 추출한 프로필을 generate_document의 profile_path로 넘기면 원본 문서 없이 같은 표 서식을 재현합니다 — \"이 문서 표 서식 그대로 만들어줘\" 워크플로의 1단계.",
    {
      hwpx_path: z.string().min(1).describe("서식을 추출할 참조 HWPX 파일의 절대 경로"),
      output_path: z.string().min(1).describe("프로필 JSON 출력 절대 경로 (.json 권장)"),
    },
    async ({ hwpx_path, output_path }) => {
      try {
        const out = safeOutputPath(output_path, PROFILE_EXTENSIONS)
        const { buffer } = await readValidatedFile(hwpx_path)
        const { hwpxToProfile } = await import("../index.js")
        const profile = await hwpxToProfile(buffer)
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, JSON.stringify(profile, null, 2))
        return {
          content: [{ type: "text", text: `서식 프로필 추출 완료: 표 ${profile.tables.length}개 → ${out}\n(generate_document의 profile_path로 사용)` }],
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `오류: ${describeError(err)}` }],
          isError: true,
        }
      }
    }
  )

  server.tool(
    "generate_document",
    "마크다운을 HWPX 한글 문서로 생성합니다. \"보고서로/공문서로/개조식으로/계획서로 뽑아줘·만들어줘\" 요청이 이 도구입니다. 프리셋 매핑: 정부 표준 보고서(표지·목차·로마숫자 장헤더 자동)='개조식', 중앙부처 업무보고·국회 서면보고(재경부 실측: 장 띠·절 숫자칸·소제목 박스·① 항목 띠·연노랑 성과 요약박스·별첨 띠, □ 뒤 (키워드) 파랑)='업무보고', 기안문·시행문·알림공문='기안문', 1페이지 요약보고서='보고서', 추진계획='계획서'. 표는 실측 정부 서식(헤더 음영+이중선·외곽 굵은선·내용 비례 열폭), 쪽번호·결재란·'끝.' 표시 지원. ⚠ 생성 전 확인 권장: 문서종류(보고서/기안문)·제목·기관명(org)·날짜·목차 여부가 불명확하면 사용자에게 물어보세요 — 엉뚱한 프리셋 선택이 가장 흔한 오생성 원인. 마크다운 규칙(v4.13 서울 실결재 실측 위계): #(h1)=문서 제목, ##(h2)=장(보고서 Ⅰ Ⅱ / 기안문·통지는 법정 1.), ###(h3)=□ 대항목(기안문 가.), 그 아래 리스트=ㅇ → - → ㆍ(기안문 가. → 1) → 가)), 본문에 □/ㅇ/-/1./가. 를 직접 써도 같은 위계로 정규화, ※시작·'출처:'·'자료:'=참고(13pt), 제목 직후 인용문(>)=보고서 요약박스 — ★보고서는 반드시 제목 직후 `> …하고자 함` 한 문장(쉼표 허용·부호 없음·3줄 이내 약 90~100자)로 보고 목적을 넣을 것(없거나 3줄 초과면 경고), <right>텍스트</right>=우측정렬. □·제목은 한 줄에 자동 축소, 본문은 어절 단위 줄바꿈(낱말·날짜가 줄 끝에서 안 쪼개짐)·부호 뒤 탭 정렬(둘째 줄이 첫 줄 내용과 같은 위치), 마지막 줄이 짧은 고아 줄과 공백이 크게 벌어지는 줄은 자간 축소로 정리, 곧은따옴표는 ‘’“”로. 법령 코드 (282791)·KOSIS 표 ID DT_…·(법정동코드 …)·○○ MCP 조회 같은 내부 식별자·도구 언급은 자동 제거 — 출처는 기관·자료명만 쓸 것. (원본 서식 보존 제자리 수정은 patch_document, 서식 빈칸 채우기는 fill_form)",
    {
      markdown: z.string().min(1).describe("HWPX로 변환할 마크다운 전문. 표는 GFM 문법 사용 (예: '| 이름 | 부서 |\\n| --- | --- |\\n| 홍길동 | 기획팀 |')"),
      output_path: z.string().min(1).describe("출력 HWPX 파일의 절대 경로 (.hwpx 권장)"),
      profile_path: z.string().optional().describe("서식 프로필 JSON 경로 (extract_profile로 추출) — 참조 문서의 표 테두리·음영·열폭·셀 글꼴을 재현. 표 행·열 수와 첫 셀 텍스트가 일치하는 표에만 적용"),
      // 값 집합·범위는 gongmun-surface SSOT에서 파생 (CLI와 드리프트 불가 — v4.0.4 영역1-1)
      preset: z.enum(Object.keys(PRESET_ALIAS) as [string, ...string[]]).optional()
        .describe("공문서 프리셋 — 지정 시 한국 행정 공문서 표준 서식 적용. '개조식'=정부 표준 개조식 보고서(표지·목차·로마숫자 장 헤더 자동 + □○-※ 부호별 폰트), '업무보고'=중앙부처 업무보고(##=Ⅰ 장 띠, ###=파란 숫자칸 절, ####=남색 소제목 박스, #####=① 하늘색 항목 띠, > ▪…=연노랑 성과 요약박스, ## 별첨 …=별첨 띠, ❶⇒ 부호 보존, 함초롬바탕 15·각주 맑은 고딕 12), '보도자료'=머리박스+제목 25pt+□→ㅇ→*(각주) 체계. 미지정 시 범용 마크다운 변환"),
      font: z.enum(BODY_FONTS).optional().describe("본문 글꼴(공문서 모드): myeongjo=명조 계열(개조식·보고서·계획서는 실측 휴먼명조, 그 외 함초롬바탕), gothic=맑은 고딕"),
      body_pt: z.number().int().min(BODY_PT_RANGE.min).max(BODY_PT_RANGE.max).optional().describe("본문 글자 크기(pt, 공문서 모드). 기본: 기안문 12, 보고서·계획서·통지 15"),
      line_spacing: z.number().int().min(LINE_SPACING_RANGE.min).max(LINE_SPACING_RANGE.max).optional().describe("본문 줄간격(%, 공문서 모드). 기본: 프리셋별 실측값(기안문 160, 회의록 130 등)"),
      org: z.string().optional().describe("표지 기관명 (표지를 켜는 모든 프리셋에서 사용 가능). 미지정 시 표지에 기관명 생략"),
      date: z.string().optional().describe("표지 날짜 ('YYYY. M. D.' 표기 권장). 미지정 시 오늘 날짜"),
      toc: z.boolean().optional().describe("목차 페이지 생성 여부 — h2 목록을 Ⅰ Ⅱ Ⅲ 장으로 자동 구성. 전 프리셋 사용 가능(보도자료 제외). 미지정 시 개조식 프리셋만 켜짐"),
      cover: z.boolean().optional().describe("표지 페이지 생성 여부 — 첫 h1을 제목으로 파랑 장식 표지. 전 프리셋 사용 가능(보도자료 제외 — 머리박스 서식과 양립 불가). 미지정 시 개조식 프리셋만 켜짐 (org/date 지정 시 자동 켜짐)"),
      approval: z.array(z.string()).max(APPROVAL_MAX).optional().describe("결재란 직위 라벨 (최대 6개, 예: ['담당','팀장','과장']) — 문서 최상단 우측에 서명 공란 결재 표 생성"),
      page_numbers: z.boolean().optional().describe("쪽번호(하단 중앙 '- 1 -', 표지·목차 카운트 제외). 미지정 시 개조식·보고서·계획서 켜짐"),
      end_mark: z.boolean().optional().describe("본문 끝 '끝.' 표시 (행정업무규정). 미지정 시 기안문만 켜짐, 본문이 이미 '끝.'으로 끝나면 중복 생성 안 함"),
      body_title_box: z.boolean().optional().describe("본문 첫 페이지 제목 반복 박스 (개조식 실측 관행). 미지정 시 개조식+표지 조합에서 켜짐"),
      h2_marker: z.enum(H2_MARKERS).optional().describe("h2 장 제목 표기: band=로마자 채움 칸+제목 띠 표(보고서·계획서 기본), roman='Ⅰ. 제목' 텍스트, number='1. 제목'(통지 기본), box=장 없이 □ 대항목으로, none=번호 없음. 기안문 본문의 h2는 항상 법정 '1.' 항목"),
      band_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe("띠 제목 번호칸 채움색 #RRGGBB (기본 #003366 실측 최다. 교육청형 밝은 띠는 #DFE6F7 + band_text_color #000000)"),
      band_text_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe("띠 제목 번호 글자색 #RRGGBB (기본 #FFFFFF)"),
      summary: z.string().optional().describe("보고서 요약 박스 — 제목표 아래 #DFE6F7 음영 상자(서울 실결재 관행). 마크다운 제목 직후 인용문(> …)으로도 지정 가능"),
      doc_info: z.object(Object.fromEntries(DOC_INFO_KEYS.map(k => [k, z.string().optional()]))).optional().describe("보고서 표지 문서정보표 — docNum=문서번호/date=결재일자/disclosure=공개여부/policyNo=방침번호 (cover=true와 함께)"),
      dept: z.string().optional().describe("표지 부서명 — 기관명 아래 '(스마트도시과)' (cover와 함께)"),
      cover_label: z.string().optional().describe("표지 우상단 취급 표시 — '대외주의'·'비공개' 빨간 테두리 박스 (업무보고 프리셋 실측, cover와 함께)"),
      fonts: z.object(Object.fromEntries(FONT_ROLE_KEYS.map(k => [k, z.string().optional()])))
        .optional().describe("요소별 글꼴 오버라이드(공문서 모드) — body=본문(○·-)/heading=제목 계열(□·장헤더·표지·목차)/ref=※ 참고/table=표 셀. 개조식·보고서·계획서는 네 역할 전부, 그 외 프리셋은 body만 적용"),
      sizes: z.object(Object.fromEntries(SIZE_KEYS.map(k => [k, z.number().min(SIZE_PT_RANGE.min).max(SIZE_PT_RANGE.max).optional()])))
        .optional().describe("개조식 요소별 글자 크기(pt) 오버라이드 — dae=□/cham=※/chapter=장헤더/coverTitle·coverSub=표지/tocLabel·tocRoman·tocItem=목차/table=표 셀/bodyTitle=본문 첫 페이지 제목 반복 박스. 미지정 요소는 body_pt 비례 기본값"),
      levels: z.record(z.string().regex(/^[0-7]$/), z.object(Object.fromEntries(LEVEL_STYLE_KEYS.map(k => [k, k === "pt" ? z.number().min(SIZE_PT_RANGE.min).max(SIZE_PT_RANGE.max).optional() : k === "bold" ? z.boolean().optional() : z.string().optional()]))))
        .optional().describe("항목부호 단계별 위계 타이포(공문서 모드, v4.12.3) — {\"0\":{font:\"HY견고딕\",pt:17,bold:true},\"1\":{font:\"한컴돋움\",bold:true}} 꼴(depth 0~7). 실측: 전자결재 기안문 □/ㅇ/- 계열은 □=HY견고딕 +2~3pt 굵게·ㅇ=한컴돋움 굵게·-=휴먼명조 본문. 법정 8단계(1. 가.)는 본문 동일이 관행이라 기본 미적용"),
      bullet2: z.enum(BULLET2_CHARS).optional().describe("2단계 항목부호 — 'ㅇ'(이응, 전자결재 기안문·공고문 실측 지배) / '○'(원, 보고서 양식). 미지정 시 통지·보도자료 ㅇ, 그 외 ○"),
      suppress_single: z.boolean().optional().describe("단일 형제 항목 부호 생략(편람 규정, 법정 번호 standard 전용 — 불릿 체계인 보고서·계획서·개조식·보도자료엔 무효). 기본 false — 하나뿐인 항목에도 부호(1. 가.)를 부여 (부호 없는 계단 들여쓰기가 실무 눈에 어색)"),
      doc_head: z.object(Object.fromEntries(DOC_HEAD_KEYS.map(k => [k, z.string().optional()])))
        .optional().describe("기안문 두문표(별지 제1호서식·서울 실결재 6행 표) — org=행정기관명(굴림 20pt bold 자간띄움)/slogan=원훈(상단 10pt)/to=수신('내부결재'면 발신명의 생략)/via=경유/title=제목(미지정 시 첫 h1). 기안문 프리셋 전용"),
      doc_foot: z.object(Object.fromEntries(DOC_FOOT_KEYS.map(k => [k, z.string().optional()])))
        .optional().describe("기안문 결문표 — sender=발신명의(18pt bold 중앙)/drafter·reviewer·approver='직위 성명' 결재선/cooperator=협조자/recipients=수신자 목록/docNum=시행 '과-번호 (날짜)'/receive=접수/zip·address·site/phone·fax·email/disclosure=공개구분. 기안문 프리셋 전용"),
      report_info: z.string().optional().describe("보고서: 제목표 아래 담당자 행 '(2026. 9. 6., 스마트도시과 홍길동, ☎450-1234)' / 기안문: 우상단 12pt 보고정보 행"),
      notice_head: z.object(Object.fromEntries(NOTICE_HEAD_KEYS.map(k => [k, z.string().optional()])))
        .optional().describe("공고문 두문·결문 — no=공고번호(본문 위 bold)/date=날짜(본문 아래 우측)/sender=발신명의(우측 bold). 통지 프리셋 전용"),
      press: z.object({
        release: z.string().optional(), distribute: z.string().optional(),
        sub: z.array(z.string()).optional(),
        contact: z.object(Object.fromEntries(PRESS_CONTACT_KEYS.map(k => [k, z.string().optional()]))).optional(),
      }).optional().describe("보도자료 옵션 — release=보도시점/distribute=배포일(머리박스)/sub=부제 배열('- … -')/contact=담당 부서·담당자·연락처 표"),
      paper: z.enum(["A4", "A3", "B4", "B5", "Letter"]).optional().describe("용지 크기 (v4.5.0). 기본 A4"),
      landscape: z.boolean().optional().describe("용지 가로 방향 (v4.5.0). 기본 세로"),
      columns: z.number().int().min(1).max(8).optional().describe("다단 개수 (v4.5.0). 기본 1단"),
      header: z.string().optional().describe("머리말 텍스트 — 모든 쪽 상단, 인라인 마크다운 허용 (v4.5.0)"),
      footer: z.string().optional().describe("꼬리말 텍스트 — 모든 쪽 하단 (v4.5.0)"),
      image_dir: z.string().optional().describe("마크다운 이미지 참조(![](x.png))를 이 디렉토리에서 읽어 실데이터 임베드 (v4.5.0, PNG/JPEG/GIF/BMP). 미지정 시 참조만 placeholder로 보존"),
    },
    async ({ markdown, output_path, profile_path, preset, font, body_pt, line_spacing, org, date, toc, cover, approval, page_numbers, end_mark, body_title_box, h2_marker, band_color, band_text_color, summary, doc_info, dept, cover_label, fonts, sizes, levels, bullet2, suppress_single, doc_head, doc_foot, report_info, notice_head, press, paper, landscape, columns, header, footer, image_dir }) => {
      try {
        // 조립은 gongmun-surface SSOT(buildGongmunOptions) — CLI와 의미론 공유 (v4.0.4)
        let gongmun: GongmunOptions | undefined
        if (preset) {
          gongmun = buildGongmunOptions({
            preset: PRESET_ALIAS[preset], font, bodyPt: body_pt, lineSpacing: line_spacing,
            org, date, cover, toc, approval,
            pageNumbers: page_numbers, endMark: end_mark, bodyTitleBox: body_title_box,
            h2Marker: h2_marker, bandColor: band_color, bandTextColor: band_text_color, fonts, sizes, levels, bullet2, suppressSingle: suppress_single,
            docHead: doc_head, docFoot: doc_foot, reportInfo: report_info,
            noticeHead: notice_head, press, summary, docInfo: doc_info, dept, coverLabel: cover_label,
          })
        }
        // 서식 프로필 (이슈 #41) — 경로 검증(realpath + .json) 후 경계 zod 검증 (CLI --profile과 공유 스키마)
        let profile: import("../hwpx/gen-profile.js").FormatProfile | undefined
        if (profile_path) {
          const { parseFormatProfileJson } = await import("../hwpx/profile-io.js")
          profile = parseFormatProfileJson(await readFile(safePath(profile_path, PROFILE_EXTENSIONS), "utf-8"))
        }
        const out = safeOutputPath(output_path, new Set([".hwpx"]))
        // 페이지 옵션 (v4.5.0)
        const page = paper || landscape || columns || header || footer
          ? {
            ...(paper ? { size: paper } : {}),
            ...(landscape ? { orientation: "landscape" as const } : {}),
            ...(columns ? { columns } : {}),
            ...(header ? { header } : {}),
            ...(footer ? { footer } : {}),
          }
          : undefined
        // 이미지 실데이터 (v4.5.0) — 안전한 파일명 참조만 디렉토리에서 읽는다
        let images: Record<string, Uint8Array> | undefined
        if (image_dir) {
          const dir = await realpath(resolve(image_dir))
          assertWithinRoot(dir)
          for (const m of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
            const url = m[1]
            if (!/^[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/.test(url) || url.includes("..")) continue
            try {
              images ??= {}
              images[url] = new Uint8Array(await readFile(join(dir, url)))
            } catch { /* 파일 없음 — placeholder 유지 */ }
          }
        }
        const genWarnings: string[] = []
        const buf = await markdownToHwpx(markdown, gongmun || profile || page || images
          ? {
            ...(gongmun ? { gongmun } : {}), ...(profile ? { profile } : {}),
            ...(page ? { page } : {}), ...(images ? { images } : {}),
            warnings: genWarnings,
          }
          : undefined)
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, Buffer.from(buf))

        const mode = gongmun ? `공문서:${gongmun.preset}` : "범용"
        const tableCount = (markdown.match(/^\s*\|.*\|\s*$/gm) || []).length > 0
          ? `, 표 포함` : ""
        // 폰트 오버라이드 오타·미설치 경고 (A2) — 생성은 진행, 경고만 병기.
        // 프리셋 비호환 옵션(조용한 폐기)·편람 표기법 검수도 같은 채널로 병기
        const fontWarns = gongmun?.fonts ? unknownFontWarnings(gongmun.fonts) : []
        if (gongmun) fontWarns.push(...incompatibleGongmunWarnings(gongmun))
        if (gongmun) fontWarns.push(...gongmunLintWarnings(markdown, 5))
        // 개조식 문체 검수 — 보고서·계획서·개조식 프리셋만 (기안문 경어체 등에는 미적용)
        if (gongmun && usesGaejosikMunche(gongmun.preset)) fontWarns.push(...muncheLintWarnings(markdown, 5))
        fontWarns.push(...genWarnings)
        const warnText = fontWarns.length ? `\n⚠ ${fontWarns.join("\n⚠ ")}` : ""
        return {
          content: [{ type: "text", text: `✓ HWPX 생성 (${mode}${tableCount}) → ${out}\n크기: ${(buf.byteLength / 1024).toFixed(1)}KB${warnText}` }],
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `오류: ${describeError(err)}` }],
          isError: true,
        }
      }
    }
  )
}
