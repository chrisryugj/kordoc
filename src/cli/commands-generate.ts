/** kordoc CLI 명령 — 생성·검수 — generate·profile·lint·redact */

import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { basename, dirname, resolve } from "path"
import { parse, detectFormat, markdownToHwpx, hwpxToProfile, PRESET_ALIAS, unknownFontWarnings, incompatibleGongmunWarnings, lintGongmunText, gongmunLintWarnings, lintMuncheText, muncheLintWarnings, usesGaejosikMunche } from "../index.js"
import { parseFormatProfileJson } from "../hwpx/profile-io.js"
import { buildGongmunOptions, BODY_FONTS, H2_MARKERS, BULLET2_CHARS, parseLevelsSpec, levelFontRecord } from "../hwpx/gongmun-surface.js"
import type { FormatProfile } from "../hwpx/gen-profile.js"
import { toArrayBuffer, sanitizeError } from "../utils.js"
import type { Command } from "commander"

export function registerGenerateCommands(program: Command): void {
  program
    .command("generate <markdown>")
    .alias("gen")
    .description("마크다운 → 공문서 HWPX 생성 — kordoc generate 보고서.md -o 보고서.hwpx --preset 보고서 (markdown에 '-' 지정 시 stdin)")
    .option("-o, --output <path>", "출력 HWPX 경로 (기본: <입력>.hwpx)")
    .option("--preset <name>", "공문서 프리셋: 기안문(official)·보고서(report)·계획서(plan)·통지(notice)·회의록(minutes)·개조식(gaejosik — 표지·목차·장헤더 자동)·업무보고(ministry — 중앙부처 업무보고: 장 띠·절 숫자칸·소제목 박스·① 항목 띠·성과 요약박스·별첨 띠)·보도자료(press)", "기안문")
    .option("--font <type>", "본문 글꼴: myeongjo(함초롬바탕) 또는 gothic(맑은 고딕)")
    .option("--pt <size>", "본문 글자 크기(pt)")
    .option("--line-spacing <percent>", "본문 줄간격(%)")
    .option("--profile <path>", "서식 프로필 JSON (kordoc profile로 추출) — 참조 문서의 표 테두리·음영·열폭·셀 글꼴 재현")
    .option("--org <name>", "표지 기관명 (표지를 켜는 프리셋 공통)")
    .option("--date <date>", "표지 날짜 (기본 오늘 — 'YYYY. M. D.')")
    .option("--toc", "목차 페이지 강제 켜기 (개조식 외 프리셋에서도 h2 목록으로 생성)")
    .option("--no-toc", "목차 페이지 끄기 (개조식 프리셋 기본 켜짐)")
    .option("--cover", "표지 페이지 강제 켜기 (개조식 외 프리셋에서도 첫 h1을 표지로)")
    .option("--no-cover", "표지 페이지 끄기 (개조식 프리셋 기본 켜짐)")
    .option("--approval <labels>", "결재란 직위 라벨 (쉼표 구분, 예: 담당,팀장,과장) — 문서 최상단 우측")
    .option("--page-numbers", "쪽번호 강제 켜기 (하단 중앙 '- 1 -')")
    .option("--no-page-numbers", "쪽번호 끄기 (개조식·보고서·계획서 기본 켜짐)")
    .option("--end-mark", "본문 끝 '끝.' 표시 강제 켜기")
    .option("--no-end-mark", "'끝.' 표시 끄기 (기안문 기본 켜짐)")
    .option("--no-body-title-box", "본문 첫 페이지 제목 반복 박스 끄기 (개조식+표지 기본 켜짐)")
    .option("--h2-marker <type>", "h2 장 제목 표기: band(로마자 채움 칸 + 제목 띠 표 — 보고서·계획서 기본)·roman(Ⅰ. 텍스트)·number(1. — 통지 기본)·box(장 없이 □ 대항목)·none")
    .option("--band-color <hex>", "띠 제목 번호칸 채움색 #RRGGBB (기본 #003366 — 실측 최다. 교육청형 밝은 띠: #DFE6F7)")
    .option("--band-text-color <hex>", "띠 제목 번호 글자색 #RRGGBB (기본 #FFFFFF — 밝은 띠면 #000000)")
    .option("--summary <text>", "보고서 요약 박스 (제목표 아래 음영 상자 — 마크다운 제목 직후 인용문(>)으로도 지정)")
    .option("--doc-info <spec>", "보고서 표지 문서정보표: docNum=스마트도시과-123,date=2026. 9. 6.,disclosure=공개,policyNo= (--cover와 함께)")
    .option("--dept <name>", "표지 부서명 (기관명 아래 괄호)")
    .option("--cover-label <text>", "표지 우상단 취급 표시 — '대외주의'·'비공개' 빨간 테두리 박스 (업무보고 프리셋 실측)")
    .option("--fonts <spec>", "요소별 글꼴 오버라이드: body=나눔명조,heading=나눔고딕,ref=한양중고딕,table=맑은 고딕")
    .option("--sizes <spec>", "개조식 요소별 크기(pt): dae=16,cham=13,table=12,coverTitle=30 …")
    .option("--levels <spec>", "항목부호 단계별 위계 타이포: 0=HY견고딕/17/bold,1=한컴돋움/15/bold,2=휴먼명조/14 (depth 0~7, 숫자=pt·bold·plain·글꼴명)")
    .option("--bullet2 <char>", "2단계 항목부호: ㅇ(이응 — 기안문·공고문 실측 지배) 또는 ○(원 — 보고서 양식)")
    .option("--suppress-single", "단일 형제 항목 부호 생략 (편람 규정 — 기본은 하나여도 부호 부여)")
    .option("--doc-head <spec>", "기안문 두문표: org=기관명,slogan=원훈,to=수신처,title=제목 (별지 제1호서식·서울 실결재 6행 표)")
    .option("--doc-foot <spec>", "기안문 결문표: sender=발신명의,drafter=주무관 홍길동,reviewer=과장 김철수,approver=국장 박영희,cooperator=협조자,docNum=시행(과-번호 (날짜)),receive=접수,zip=우편번호,address=주소,site=홈페이지,phone=전화,fax=전송,email=메일,disclosure=공개구분")
    .option("--report-info <text>", "보고서 담당자 행(제목표 아래) / 기안문 우상단 보고정보 행 — 예: '(2026. 7. 11., 과장 홍길동, ☎02-120)'")
    .option("--notice-head <spec>", "공고문 두문·결문: no=공고 제2026-1호,date=2026년 7월 11일,sender=행정안전부장관")
    .option("--press-head <spec>", "보도자료 머리: release=보도시점,distribute=배포일,dept=담당부서,manager=담당자,phone=연락처")
    .option("--press-sub <items>", "보도자료 부제 (세미콜론 구분, 제목 아래 '- … -')")
    .option("--plain", "공문서 모드 끄기 (범용 마크다운 변환)")
    .option("--paper <size>", "용지: A4·A3·B4·B5·Letter 또는 '210x297'(mm)")
    .option("--landscape", "용지 가로 방향")
    .option("--columns <n>", "다단 개수 (1~8)")
    .option("--header <text>", "머리말 텍스트 (모든 쪽, 인라인 마크다운 허용)")
    .option("--footer <text>", "꼬리말 텍스트")
    .option("--image-dir <dir>", "마크다운 이미지 참조(![](x.png))를 이 디렉토리에서 읽어 실데이터 임베드")
    .option("--silent", "진행 메시지 숨기기")
    .action(async (markdown: string, opts) => {
      try {
        const rootOpts = program.opts()
        const output: string | undefined = opts.output ?? rootOpts.output
        const silent: boolean = opts.silent ?? rootOpts.silent

        // 입력: '-' 이면 stdin, 아니면 파일
        let md: string
        let baseName = "document"
        if (markdown === "-") {
          md = readFileSync(0, "utf-8")
        } else {
          const inPath = resolve(markdown)
          md = readFileSync(inPath, "utf-8")
          baseName = basename(inPath).replace(/\.(md|markdown|txt)$/i, "")
        }

        // 공문서 옵션 구성 — 값 검증(열거)과 조립은 gongmun-surface SSOT, 여기는
        // commander 표면 사정(kv 파싱·--no-x 기본값)을 중립 입력으로 정돈하는 어댑터만
        let gongmun: import("../index.js").GongmunOptions | undefined
        if (!opts.plain) {
          const preset = PRESET_ALIAS[String(opts.preset).trim()]
          if (!preset) {
            process.stderr.write(`[kordoc] 알 수 없는 프리셋: ${opts.preset} (기안문/보고서/계획서/통지/회의록/개조식/업무보고/보도자료)\n`)
            process.exit(1)
          }
          const enumCheck = <T extends readonly string[]>(flag: string, value: unknown, allowed: T): (typeof allowed)[number] | undefined => {
            if (value === undefined) return undefined
            if (!allowed.includes(String(value))) {
              process.stderr.write(`[kordoc] ${flag} 는 ${allowed.join("/")}\n`)
              process.exit(1)
            }
            return value as (typeof allowed)[number]
          }
          // "key=value,key=value" 스펙 파싱 — 값의 '='는 보존(첫 '='만 분리). 쉼표는
          // 구분자라 값에 못 들어감 — '=' 없는 조각(잘린 값의 꼬리 등)은 무증상 드랍
          // 대신 경고로 노출 (v4.0.6: 두문 title 값 유실이 조용히 지나가던 것 봉합)
          const parseKv = (spec: string, flag: string): Record<string, string> => {
            const out: Record<string, string> = {}
            for (const piece of spec.split(",")) {
              const p = piece.trim()
              if (!p) continue
              const eq = p.indexOf("=")
              const key = eq > 0 ? p.slice(0, eq).trim() : ""
              const value = eq > 0 ? p.slice(eq + 1).trim() : ""
              if (!key || !value) {
                process.stderr.write(`[kordoc] ${flag}: 'key=value' 형식이 아닌 조각 무시 — "${p}" (값에 쉼표는 쓸 수 없습니다)\n`)
                continue
              }
              out[key] = value
            }
            return out
          }
          const pressKv = opts.pressHead ? parseKv(String(opts.pressHead), "--press-head") : {}
          gongmun = buildGongmunOptions({
            preset,
            font: enumCheck("--font", opts.font, BODY_FONTS),
            bodyPt: opts.pt ? Number(opts.pt) : undefined,
            lineSpacing: opts.lineSpacing ? Number(opts.lineSpacing) : undefined,
            org: opts.org, date: opts.date,
            cover: opts.cover, toc: opts.toc,
            approval: opts.approval ? String(opts.approval).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
            pageNumbers: opts.pageNumbers, endMark: opts.endMark,
            // --no-body-title-box 단독 플래그 — commander 기본 true는 "미지정"으로 정돈
            bodyTitleBox: opts.bodyTitleBox === false ? false : undefined,
            h2Marker: enumCheck("--h2-marker", opts.h2Marker, H2_MARKERS),
            bandColor: opts.bandColor, bandTextColor: opts.bandTextColor,
            fonts: opts.fonts ? parseKv(String(opts.fonts), "--fonts") : undefined,
            sizes: opts.sizes
              ? Object.fromEntries(
                Object.entries(parseKv(String(opts.sizes), "--sizes")).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v as number)),
              )
              : undefined,
            levels: opts.levels ? parseLevelsSpec(String(opts.levels)) : undefined,
            bullet2: enumCheck("--bullet2", opts.bullet2, BULLET2_CHARS),
            suppressSingle: opts.suppressSingle ? true : undefined,
            docHead: opts.docHead ? parseKv(String(opts.docHead), "--doc-head") : undefined,
            docFoot: opts.docFoot ? parseKv(String(opts.docFoot), "--doc-foot") : undefined,
            reportInfo: opts.reportInfo ? String(opts.reportInfo) : undefined,
            summary: opts.summary ? String(opts.summary) : undefined,
            docInfo: opts.docInfo ? parseKv(String(opts.docInfo), "--doc-info") : undefined,
            dept: opts.dept ? String(opts.dept) : undefined,
            coverLabel: opts.coverLabel ? String(opts.coverLabel) : undefined,
            noticeHead: opts.noticeHead ? parseKv(String(opts.noticeHead), "--notice-head") : undefined,
            press: opts.pressHead || opts.pressSub
              ? {
                release: pressKv.release, distribute: pressKv.distribute,
                sub: opts.pressSub ? String(opts.pressSub).split(";").map((s: string) => s.trim()).filter(Boolean) : undefined,
                contact: pressKv.dept || pressKv.manager || pressKv.phone ? { dept: pressKv.dept, manager: pressKv.manager, phone: pressKv.phone } : undefined,
              }
              : undefined,
          })
        }

        // 폰트 오버라이드 오타·미설치 경고 (A2) — 생성은 진행
        if (gongmun?.fonts && !silent) {
          for (const w of unknownFontWarnings(gongmun.fonts)) process.stderr.write(`[kordoc] ${w}\n`)
        }
        if (gongmun?.levels && !silent) {
          for (const w of unknownFontWarnings(levelFontRecord(gongmun.levels))) process.stderr.write(`[kordoc] ${w}\n`)
        }
        // 프리셋 비호환 옵션 경고 (v4.0.6) — 조용한 폐기 대신 노출, 생성은 진행
        if (gongmun && !silent) {
          for (const w of incompatibleGongmunWarnings(gongmun)) process.stderr.write(`[kordoc] ⚠ ${w}\n`)
        }
        // 공문서 표기법 검수 (편람 기준, 조언용) — 생성은 진행, stderr 경고만
        if (gongmun && !silent) {
          for (const w of gongmunLintWarnings(md, 5)) process.stderr.write(`[kordoc] ⚠ ${w}\n`)
        }
        // 개조식 문체 검수 — 보고서·계획서·개조식 프리셋만. 기안문(경어)·통지·보도자료는
        // 문체 관행이 달라 적용하지 않는다 (범위를 좁히는 것이 오탐을 막는다)
        if (gongmun && !silent && usesGaejosikMunche(gongmun.preset)) {
          for (const w of muncheLintWarnings(md, 5)) process.stderr.write(`[kordoc] ⚠ ${w}\n`)
        }

        // 서식 프로필 (이슈 #41) — 경계 zod 검증 후 라이브러리에 전달 (MCP와 공유 스키마)
        let profile: FormatProfile | undefined
        if (opts.profile) {
          profile = parseFormatProfileJson(readFileSync(resolve(String(opts.profile)), "utf-8"))
          if (!silent) process.stderr.write(`[kordoc] 서식 프로필 적용: 표 ${profile.tables.length}개 (${opts.profile})\n`)
        }

        // 페이지 옵션 (v4.5.0) — 용지·방향·다단·머리말/꼬리말
        let page: import("../index.js").PageOptions | undefined
        if (opts.paper || opts.landscape || opts.columns || opts.header || opts.footer) {
          let size: import("../index.js").PageOptions["size"]
          if (opts.paper) {
            const wh = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(String(opts.paper).trim())
            size = wh ? { widthMm: Number(wh[1]), heightMm: Number(wh[2]) } : (String(opts.paper) as "A4")
          }
          page = {
            ...(size !== undefined ? { size } : {}),
            ...(opts.landscape ? { orientation: "landscape" as const } : {}),
            ...(opts.columns ? { columns: Number(opts.columns) } : {}),
            ...(opts.header ? { header: String(opts.header) } : {}),
            ...(opts.footer ? { footer: String(opts.footer) } : {}),
          }
        }
        // 이미지 실데이터 (v4.5.0) — 참조 url이 안전한 파일명이고 디렉토리에 실재할 때만
        let imageBytes: Record<string, Uint8Array> | undefined
        if (opts.imageDir) {
          const dir = resolve(String(opts.imageDir))
          for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
            const url = m[1]
            if (!/^[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/.test(url) || url.includes("..")) continue
            try {
              const bytes = readFileSync(resolve(dir, url))
              ;(imageBytes ??= {})[url] = new Uint8Array(bytes)
            } catch { /* 파일 없음 — placeholder 유지 */ }
          }
          if (!silent) process.stderr.write(`[kordoc] 이미지 임베드: ${Object.keys(imageBytes ?? {}).length}개 (${dir})\n`)
        }

        const genWarnings: string[] = []
        const buf = await markdownToHwpx(md, gongmun || profile || page || imageBytes
          ? {
            ...(gongmun ? { gongmun } : {}), ...(profile ? { profile } : {}),
            ...(page ? { page } : {}), ...(imageBytes ? { images: imageBytes } : {}),
            warnings: genWarnings,
          }
          : undefined)
        if (!silent) for (const w of genWarnings) process.stderr.write(`[kordoc] ⚠ ${w}\n`)
        const outPath = resolve(output ?? (markdown === "-" ? `${baseName}.hwpx` : markdown.replace(/\.(md|markdown|txt)$/i, "") + ".hwpx"))
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, Buffer.from(buf))

        if (!silent) {
          const mode = gongmun ? `공문서:${gongmun.preset}` : "범용"
          process.stderr.write(`[kordoc] HWPX 생성 (${mode}) → ${outPath}\n`)
        }
      } catch (err) {
        process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
        process.exit(1)
      }
    })

  program
    .command("profile <file>")
    .description("HWPX 표 서식 프로필 추출 — 참조 문서의 표 테두리·음영·열폭·셀 글꼴을 JSON으로 (generate --profile로 재현) — kordoc profile 참조.hwpx -o 서식.json")
    .option("-o, --output <path>", "출력 JSON 경로 (기본: <입력>.profile.json)")
    .option("--silent", "진행 메시지 숨기기")
    .action(async (file: string, opts) => {
      try {
        const rootOpts = program.opts()
        const output: string | undefined = opts.output ?? rootOpts.output
        const silent: boolean = opts.silent ?? rootOpts.silent
        const absPath = resolve(file)
        const profile = await hwpxToProfile(readFileSync(absPath))
        const outPath = resolve(output ?? absPath.replace(/\.hwpx$/i, "") + ".profile.json")
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, JSON.stringify(profile, null, 2))
        if (!silent) process.stderr.write(`[kordoc] 서식 프로필 추출: 표 ${profile.tables.length}개 → ${outPath}\n`)
      } catch (err) {
        process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
        process.exit(1)
      }
    })

  program
    .command("lint <file>")
    .description("공문서 표기법 검수 — 날짜·시간·금액·붙임 등 행정업무운영 편람 표기법 (md/txt, '-'=stdin). error 있으면 exit 1")
    .option("--json", "JSON 출력")
    .option("--munche", "개조식 문체 검수 병행 — 서술형 종결·당위·수사·항목 길이 (보고서·계획서 원고용)")
    .action((file: string, opts) => {
      try {
        const raw = file === "-" ? readFileSync(0) : readFileSync(resolve(file))
        // 문서 파일을 UTF-8 텍스트로 읽으면 압축 바이트가 본문으로 둔갑해 위반 수백~수천 건이
        // 쏟아진다("보고서.hwpx" 실측 1,193건) — 검수 결과처럼 보이는 쓰레기가 최악이라 먼저 막는다.
        const kind = detectFormat(
          raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
        )
        if (kind !== "unknown") {
          process.stderr.write(
            `[kordoc] lint 는 텍스트(마크다운/txt)를 검사합니다 — ${kind} 문서는 받지 않습니다.\n` +
            `  원고 마크다운을 넘기거나, 문서 본문을 파이프하세요: kordoc ${file} | kordoc lint -\n`
          )
          process.exit(1)
        }
        const text = raw.toString("utf-8")
        const findings = lintGongmunText(text, { document: true })
        // 문체 검수는 옵트인 — 축이 다르고(표기법 vs 종결·수사), 개조식이 아닌 원고에는
        // 적용하면 안 되기 때문에 기본 동작은 종전 그대로 둔다
        const munche = opts.munche ? lintMuncheText(text) : []
        const errors = findings.filter((f) => f.severity === "error").length
          + munche.filter((f) => f.severity === "error").length
        if (opts.json) {
          const total = findings.length + munche.length
          process.stdout.write(JSON.stringify(
            { findings, ...(opts.munche ? { munche } : {}), summary: { total, errors, ok: errors === 0 } }, null, 2) + "\n")
        } else {
          // 사람용 리포트는 stderr — 기계용(--json)만 stdout (validate와 채널 일관)
          process.stderr.write(`[kordoc] 표기법 검수: 위반 ${findings.length}건 (error ${findings.filter((f) => f.severity === "error").length}, warning ${findings.filter((f) => f.severity !== "error").length})\n`)
          for (const f of findings) {
            process.stderr.write(`  L${f.line} [${f.severity}] ${f.rule}: "${f.match}" — ${f.message}${f.suggest ? ` → ${f.suggest}` : ""}\n`)
          }
          if (opts.munche) {
            const me = munche.filter((f) => f.severity === "error").length
            process.stderr.write(`[kordoc] 문체 검수: 위반 ${munche.length}건 (error ${me}, warning ${munche.length - me})\n`)
            for (const f of munche) {
              process.stderr.write(`  L${f.line} [${f.severity}] ${f.rule}: "${f.match}" — ${f.message}${f.suggest ? ` → ${f.suggest}` : ""}\n`)
            }
          }
        }
        process.exit(errors > 0 ? 1 : 0)
      } catch (err) {
        process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
        process.exit(1)
      }
    })

  program
    .command("redact <files...>")
    .description("개인정보 서식 보존 마스킹 — 주민번호·전화·이메일·카드·계좌를 탐지해 HWPX/HWP는 원본 서식 그대로 patch, 그 외 포맷은 마스킹된 마크다운 출력. 자동 검출 보조 도구이므로 결과는 반드시 사람이 최종 확인하세요 (이미지 안 텍스트는 탐지 불가)")
    .option("--rules <csv>", "적용 룰 (기본: rrn,phone,email,card,account — passport,driver는 opt-in)")
    .option("--mask-char <ch>", "마스크 문자 1글자 (기본: ●)")
    .option("-o, --output <path>", "출력 경로 (단일 파일 시)")
    .option("-d, --out-dir <dir>", "출력 디렉토리 (다중 파일 시)")
    .option("--dry-run", "탐지 리포트만 출력, 파일 미생성")
    .option("--json", "리포트를 JSON으로 stdout 출력")
    .option("--silent", "진행 메시지 숨기기")
    .action(async (files: string[], opts) => {
      const { redactMarkdown, DEFAULT_REDACT_RULES, patchHwpx, patchHwp } = await import("../index.js")
      const rootOpts = program.opts()
      const output: string | undefined = opts.output ?? rootOpts.output
      const silent: boolean = opts.silent ?? rootOpts.silent
      const KNOWN_RULES = new Set(["rrn", "phone", "email", "card", "account", "passport", "driver"])
      const rules = opts.rules
        ? String(opts.rules).split(",").map((r: string) => r.trim()).filter(Boolean)
        : [...DEFAULT_REDACT_RULES]
      const badRule = rules.find((r: string) => !KNOWN_RULES.has(r))
      if (badRule) {
        process.stderr.write(`[kordoc] 알 수 없는 룰: ${badRule} (허용: ${[...KNOWN_RULES].join(", ")})\n`)
        process.exit(1)
      }
      if (output && files.length > 1) {
        process.stderr.write(`[kordoc] ⚠️ -o/--output 은 단일 파일 전용이라 무시됩니다 — 다중 파일은 -d/--out-dir 를 사용하세요\n`)
      }
      const jsonReports: unknown[] = []
      for (const filePath of files) {
        const absPath = resolve(filePath)
        const fileName = basename(absPath)
        try {
          const buffer = readFileSync(absPath)
          const arrayBuffer = toArrayBuffer(buffer)
          const format = detectFormat(arrayBuffer)
          const parsed = await parse(arrayBuffer, { filePath: absPath })
          if (!parsed.success) {
            process.stderr.write(`[kordoc] FAIL: ${fileName} — ${parsed.error}\n`)
            process.exitCode = 1
            continue
          }
          const r = redactMarkdown(parsed.markdown, { rules: rules as never, maskChar: opts.maskChar })
          const byRule = new Map<string, number>()
          for (const h of r.hits) byRule.set(h.rule, (byRule.get(h.rule) ?? 0) + 1)
          const ruleSummary = [...byRule.entries()].map(([k, v]) => `${k} ${v}건`).join(", ") || "0건"

          let outPath: string | null = null
          let patchNote = ""
          if (!opts.dryRun && r.hits.length > 0) {
            const patchable = format === "hwpx" || format === "hwp"
            if (patchable) {
              const original = new Uint8Array(arrayBuffer)
              const result = format === "hwp"
                ? await patchHwp(original, r.text)
                : await patchHwpx(original, r.text)
              if (!result.success || !result.data) {
                process.stderr.write(`[kordoc] 패치 실패: ${fileName} — ${result.error ?? "알 수 없는 오류"}\n`)
                process.exitCode = 1
                continue
              }
              const ext = format === "hwp" ? ".hwp" : ".hwpx"
              outPath = resolve(
                output && files.length === 1
                  ? output
                  : resolve(opts.outDir ?? dirname(absPath), fileName.replace(/\.[^.]+$/, "") + ".redacted" + ext),
              )
              mkdirSync(dirname(outPath), { recursive: true })
              writeFileSync(outPath, result.data)
              if (result.skipped.length > 0) {
                patchNote = ` (⚠️ 미적용 ${result.skipped.length}건 — 해당 위치는 원문 잔존, 수동 확인 필요)`
                process.exitCode = 2
              }
            } else {
              outPath = resolve(
                output && files.length === 1
                  ? output
                  : resolve(opts.outDir ?? dirname(absPath), fileName.replace(/\.[^.]+$/, "") + ".redacted.md"),
              )
              mkdirSync(dirname(outPath), { recursive: true })
              writeFileSync(outPath, r.text, "utf-8")
              patchNote = ` (${format}는 서식 보존 미지원 — 마스킹된 마크다운으로 출력)`
            }
          }
          if (opts.json) {
            jsonReports.push({ file: absPath, format, rules, hits: r.hits, output: outPath })
          }
          if (!silent) {
            process.stderr.write(`[kordoc] ${fileName}: ${ruleSummary}${outPath ? ` → ${outPath}` : opts.dryRun ? " (dry-run)" : ""}${patchNote}\n`)
            for (const h of r.hits) process.stderr.write(`  - [${h.rule}] ${h.masked}\n`)
          }
        } catch (err) {
          process.stderr.write(`[kordoc] ERROR: ${fileName} — ${sanitizeError(err)}\n`)
          process.exitCode = 1
        }
      }
      if (opts.json) process.stdout.write(JSON.stringify(files.length === 1 ? jsonReports[0] ?? null : jsonReports, null, 2) + "\n")
    })
}
