/** kordoc MCP 도구 — 서식·편집 — parse_form·fill_form·place_seal·patch_document·redact_document */

import { z } from "zod"
import { readFile, writeFile, mkdir, stat, realpath } from "fs/promises"
import { extname, dirname } from "path"
import { parse, detectFormat, detectZipFormat, detectOle2Format, blocksToMarkdown, extractFormFields, fillFormFields, markdownToHwpx, fillHwpx, patchHwpx, patchHwp, BUILTIN_TEMPLATES, resolveBuiltinTemplate, readBuiltinTemplate } from "../index.js"
import { fillWithUniqueGuard, type FillInput } from "../form/match.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { IMAGE_EXTENSIONS, safePath, safeOutputPath, describeError, capResponseText, readValidatedFile } from "./shared.js"

/** fields + formats 를 FillInput 맵으로 결합 (formats의 라벨은 fields와 동일 표기 기준) */
export function buildFillInputs(fields: Record<string, string>, formats?: Record<string, string>): Record<string, FillInput> {
  const out: Record<string, FillInput> = {}
  for (const [k, v] of Object.entries(fields)) {
    const format = formats?.[k]
    out[k] = format ? { value: v, format } : v
  }
  return out
}

export function registerFormTools(server: McpServer): void {
  // ─── 도구: parse_form ───────────────────────────────

  server.tool(
    "parse_form",
    "한국 서식 문서에서 레이블-값 쌍을 구조화된 JSON으로 추출합니다. 양식/서식 문서에 최적화.",
    {
      file_path: z.string().min(1).describe("서식 문서 파일의 절대 경로"),
    },
    async ({ file_path }) => {
      try {
        const { buffer } = await readValidatedFile(file_path)
        // 서식 입력란(빈 후행 열)이 필드로 잡히도록 보존 (#47)
        const result = await parse(buffer, { keepTrailingEmptyCols: true })

        if (!result.success) {
          return {
            content: [{ type: "text", text: `파싱 실패: ${result.error}` }],
            isError: true,
          }
        }

        const form = extractFormFields(result.blocks)
        return {
          content: [{ type: "text", text: JSON.stringify(form, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `오류: ${describeError(err)}` }],
          isError: true,
        }
      }
    }
  )

  // ─── 도구: fill_form ───────────────────────────────

  server.tool(
    "fill_form",
    "한국 서식 문서의 빈칸을 채워서 새 문서로 출력합니다. hwpx-preserve를 사용하면 원본 서식(테두리, 폰트, 병합 등)을 100% 유지합니다. HWPX 누름틀(CLICK_HERE) 필드는 이름으로 정확 매칭되어 우선 채워집니다. file_path 대신 template으로 내장 정부 표준 기안문 서식을 쓸 수 있습니다 — gian(일반기안문, 별지 제1호서식: 행정기관명·수신자·경유·제목·본문·붙임·발신명의·기안자·검토자·결재권자 등 23필드) / gian-simple(간이기안문, 별지 제2호서식: 내부결재용 13필드).",
    {
      file_path: z.string().min(1).optional().describe("서식 템플릿 문서의 절대 경로 (HWP, HWPX, PDF, XLSX, DOCX). template 사용 시 생략"),
      template: z.enum(["gian", "gian-simple", "일반기안문", "간이기안문"]).optional().describe("내장 정부 표준 서식 이름 — file_path 대신 사용. gian=일반기안문(별지 제1호서식), gian-simple=간이기안문(별지 제2호서식)"),
      fields: z.record(z.string(), z.string()).describe("채울 필드 맵 (라벨 → 값). 예: {\"성명\": \"홍길동\", \"전화번호\": \"010-1234-5678\"}"),
      formats: z.record(z.string(), z.string()).optional().describe("필드별 값 서식 (라벨 → 포맷). 정준값 하나로 서식마다 다른 모양을 채울 때: date:yy.mm.dd / phone:hyphen·dot·digits / rrn:hyphen·masked / mask:###-## / 자유 패턴(yyyy년 m월 d일, ###-####-####)"),
      require_unique: z.boolean().optional().describe("한 키가 서식의 2곳 이상에 매칭되면 채우지 않고 거부 — 반복 라벨 양식에서 남의 블록 오염 방지 (배열 값은 예외)"),
      mask_values: z.boolean().optional().describe("응답에 값 대신 글자수만 표시 — 개인정보 채움 시 값이 대화 로그에 남지 않게"),
      output_format: z.enum(["markdown", "hwpx", "hwpx-preserve"]).default("hwpx-preserve").describe("출력 포맷: hwpx-preserve (원본 스타일 보존, HWPX 전용), hwpx (새 HWPX 생성), markdown"),
      output_path: z.string().optional().describe("출력 파일 저장 경로 (선택). 지정 시 파일로 저장, 미지정 시 텍스트로 반환"),
    },
    async ({ file_path, template, fields, formats, require_unique, mask_values, output_format, output_path }) => {
      try {
        // 출력 경로 사전 검증 (포맷별 확장자 allowlist) — 채우기 전에 실패시킨다
        const outExts = output_format === "markdown" ? new Set([".md", ".markdown", ".txt"]) : new Set([".hwpx"])
        const outPath = output_path ? safeOutputPath(output_path, outExts) : undefined

        // 입력 소스 — 내장 템플릿(template) 또는 파일 경로(file_path) 중 하나
        let buffer: ArrayBuffer
        if (template) {
          const t = resolveBuiltinTemplate(template)
          if (!t) {
            return {
              content: [{ type: "text", text: `알 수 없는 내장 템플릿: ${template} (사용 가능: ${BUILTIN_TEMPLATES.map(x => `${x.id}(${x.aliases[0]})`).join(", ")})` }],
              isError: true,
            }
          }
          buffer = readBuiltinTemplate(t)
        } else if (file_path) {
          buffer = (await readValidatedFile(file_path)).buffer
        } else {
          return {
            content: [{ type: "text", text: "file_path 또는 template 중 하나를 지정해주세요" }],
            isError: true,
          }
        }

        // ─── hwpx-preserve: 원본 ZIP 직접 수정 (스타일 보존) ───
        if (output_format === "hwpx-preserve") {
          // ZIP 은 내부 구조로 세분화한 포맷을 보고한다 — PPTX 를 "hwpx" 로 안내하던 오해 방지 (#80).
          // 다른 포맷으로 확인될 때만 거부하고, 판별 불가(손상 ZIP 등)는 종전대로 HWPX 로 시도
          let format: string = detectFormat(buffer)
          if (format === "hwpx") { const z = await detectZipFormat(buffer); if (z !== "unknown") format = z }
          const isHwpx = format === "hwpx"
          if (!isHwpx) {
            return {
              content: [{ type: "text", text: `hwpx-preserve는 HWPX 파일만 지원합니다 (감지된 포맷: ${format}). hwpx 또는 markdown을 사용하세요.` }],
              isError: true,
            }
          }

          const inputs = buildFillInputs(fields, formats)
          const hwpxResult = require_unique
            ? await fillWithUniqueGuard(inputs, (vals, blocked) => fillHwpx(buffer, vals, blocked))
            : { ...(await fillHwpx(buffer, inputs)), rejected: [] as string[] }
          // 마스킹 verify — 채운 결과를 재파싱해 값이 실제 문서에 있는지만 확인 (값 미노출)
          let verifyLine: string | null = null
          if (mask_values && hwpxResult.filled.length > 0) {
            const reparsed = await parse(Buffer.from(hwpxResult.buffer))
            // 마크다운 이스케이프(\*,\|,\~ 등)·개행/연속공백 정규화 후 비교 — rrn:masked
            // ('900315-1******')의 * 이스케이프로 생기던 결정적 false negative 방지.
            // 빈 값은 includes('')===true 로 항상 통과하던 것을 FILLED 에서 제외한다.
            const norm = (s: string): string => s.replace(/\\([\\`*_{}[\]()#+.!|~>-])/g, "$1").replace(/\s+/g, " ")
            const normMd = reparsed.success ? norm(reparsed.markdown) : ""
            const okCount = reparsed.success
              ? hwpxResult.filled.filter(f => f.value !== "" && normMd.includes(norm(f.value))).length
              : 0
            verifyLine = `검증(마스킹): ${okCount}/${hwpxResult.filled.length} FILLED — 재파싱 대조, 값 미노출`
          }
          const summary = [
            `채워진 필드: ${hwpxResult.filled.length}개 (원본 스타일 보존)`,
            hwpxResult.rejected.length > 0 ? `모호 라벨 거부(2곳+ 매칭): ${hwpxResult.rejected.join(", ")}` : null,
            hwpxResult.unmatched.length > 0 ? `매칭 실패: ${hwpxResult.unmatched.join(", ")}` : null,
            verifyLine,
          ].filter(Boolean).join(" | ")

          const filledList = hwpxResult.filled
            .map(f => `  - ${f.label}: ${mask_values ? `[${[...f.value].length}자]` : f.value}`).join("\n")

          if (outPath) {
            await mkdir(dirname(outPath), { recursive: true })
            await writeFile(outPath, Buffer.from(hwpxResult.buffer))
            return {
              content: [{ type: "text", text: `[${summary}]\n\n채워진 필드:\n${filledList}\n\nHWPX 파일 저장 (원본 서식 유지): ${outPath}` }],
            }
          }

          return {
            content: [{ type: "text", text: `[${summary}]\n\n채워진 필드:\n${filledList}\n\n⚠️ output_path를 지정하면 원본 서식이 유지된 HWPX 파일로 저장됩니다.` }],
          }
        }

        // ─── 일반 경로: parse → fill → output ─── (양식 입력란 보존, #47)
        const result = await parse(buffer, { keepTrailingEmptyCols: true })
        if (!result.success) {
          return {
            content: [{ type: "text", text: `파싱 실패: ${result.error}` }],
            isError: true,
          }
        }

        const formInfo = extractFormFields(result.blocks)
        const irInputs = buildFillInputs(fields, formats)
        const fillResult = require_unique
          ? await fillWithUniqueGuard(irInputs, (vals, blocked) => fillFormFields(result.blocks, vals, blocked))
          : { ...fillFormFields(result.blocks, irInputs), rejected: [] as string[] }

        if (fillResult.filled.length === 0 && formInfo.fields.length === 0) {
          return {
            content: [{ type: "text", text: `서식 필드를 찾을 수 없습니다. 일반 문서이거나 서식 패턴이 감지되지 않았습니다.` }],
            isError: true,
          }
        }

        const markdown = blocksToMarkdown(fillResult.blocks)
        // mask_values 시 채운 값(주민번호·연락처 등)이 응답(대화 로그)에 노출되지 않게
        // 본문 미리보기를 안내 문구로 대체 (sfill-8). 값은 output_path 파일에만 기록된다.
        const previewMd = mask_values
          ? "⚠️ mask_values 활성 — 개인정보 노출 방지를 위해 본문을 응답에 포함하지 않습니다. output_path 로 파일 저장 후 확인하세요."
          : markdown
        const summary = [
          `채워진 필드: ${fillResult.filled.length}개`,
          fillResult.rejected.length > 0 ? `모호 라벨 거부(2곳+ 매칭): ${fillResult.rejected.join(", ")}` : null,
          fillResult.unmatched.length > 0 ? `매칭 실패: ${fillResult.unmatched.join(", ")}` : null,
          formInfo.fields.length > 0 ? `서식 필드: ${formInfo.fields.length}개 (확신도 ${(formInfo.confidence * 100).toFixed(0)}%)` : null,
        ].filter(Boolean).join(" | ")

        if (output_format === "hwpx") {
          const hwpxBuffer = await markdownToHwpx(markdown)
          if (outPath) {
            await mkdir(dirname(outPath), { recursive: true })
            await writeFile(outPath, Buffer.from(hwpxBuffer))
            return {
              content: [{ type: "text", text: `[${summary}]\n\nHWPX 파일 저장: ${outPath}` }],
            }
          }
          return {
            content: [{ type: "text", text: `[${summary}]\n\n⚠️ output_path를 지정하면 HWPX 파일로 저장됩니다. 미리보기:\n\n${previewMd}` }],
          }
        }

        // markdown
        if (outPath) {
          await mkdir(dirname(outPath), { recursive: true })
          await writeFile(outPath, markdown, "utf-8")
          return {
            content: [{ type: "text", text: `[${summary}]\n\n마크다운 파일 저장: ${outPath}\n\n${previewMd}` }],
          }
        }
        return {
          content: [{ type: "text", text: `[${summary}]\n\n${previewMd}` }],
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `오류: ${describeError(err)}` }],
          isError: true,
        }
      }
    }
  )

  // ─── 도구: place_seal ─────────────────────────────

  server.tool(
    "place_seal",
    "도장/서명 이미지를 앵커 문구(\"(인)\"·\"서명 또는 인\" 등) 위에 부유(글 앞) 배치합니다. 표/페이지를 키우지 않습니다 (HWPX 전용).",
    {
      file_path: z.string().min(1).describe("대상 HWPX 문서의 절대 경로"),
      image_path: z.string().min(1).describe("도장/서명 이미지 절대 경로 (투명 배경 PNG 권장)"),
      anchor: z.string().default("(인)").describe("앵커 문구 — 이 문구 기준으로 배치"),
      occurrence: z.number().int().min(0).default(0).describe("같은 앵커가 여럿일 때 0-based 선택"),
      size_mm: z.number().positive().optional().describe("도장 한 변 크기 mm (기본: 줄높이×1.6, 7~18 클램프)"),
      mode: z.enum(["overlap", "right", "auto"]).default("auto").describe("overlap=문구 위 겹침, right=문구 오른쪽 옆, auto=공간 있으면 right"),
      dx_mm: z.number().optional().describe("x 미세조정 mm"),
      dy_mm: z.number().optional().describe("y 미세조정 mm"),
      output_path: z.string().min(1).describe("출력 HWPX 저장 경로"),
    },
    async ({ file_path, image_path, anchor, occurrence, size_mm, mode, dx_mm, dy_mm, output_path }) => {
      try {
        const outPath = safeOutputPath(output_path, new Set([".hwpx"]))
        const { buffer } = await readValidatedFile(file_path)
        const format = detectFormat(buffer)
        if (format !== "hwpx") {
          return {
            content: [{ type: "text", text: `place_seal 은 HWPX 파일만 지원합니다 (감지된 포맷: ${format}).` }],
            isError: true,
          }
        }
        // 이미지 경로도 문서와 동일하게 검증 (realpath + 확장자 allowlist)
        const imgResolved = safePath(image_path, IMAGE_EXTENSIONS)
        const imgSize = (await stat(imgResolved)).size
        if (imgSize > 500 * 1024 * 1024) {
          return { content: [{ type: "text", text: `도장 이미지가 너무 큽니다 (${(imgSize / 1024 / 1024).toFixed(0)}MB) — 500MB 이하여야 합니다.` }], isError: true }
        }
        const image = new Uint8Array(await readFile(imgResolved))
        const ext = extname(imgResolved).slice(1).toLowerCase() as "png" | "jpg" | "jpeg" | "bmp" | "gif"
        const { placeSealHwpx } = await import("../form/seal.js")
        const result = await placeSealHwpx(buffer, [{
          anchor, occurrence, image, ext,
          sizeMm: size_mm, mode, dxMm: dx_mm, dyMm: dy_mm,
        }])
        await mkdir(dirname(outPath), { recursive: true })
        await writeFile(outPath, Buffer.from(result.buffer))
        const p0 = result.placed[0]
        const warnLines = (p0.warnings ?? []).map(w => `\n⚠️ ${w}`).join("")
        return {
          content: [{
            type: "text",
            text: `도장 배치 완료: "${p0.anchor}" #${p0.occurrence} → ${p0.mode} (x ${p0.posXMm}mm, y ${p0.posYMm}mm, ${p0.sizeMm}mm각, ${p0.entry})\n저장: ${outPath}${warnLines}\n표/페이지 불확장(글 앞 부유) — 한컴에서 위치 확인 후 dx_mm/dy_mm 로 미세조정 가능합니다.`,
          }],
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `도장 배치 실패: ${describeError(err)}` }],
          isError: true,
        }
      }
    },
  )

  // ─── 도구: patch_document ────────────────────────────

  server.tool(
    "patch_document",
    "원본 HWPX/HWP의 서식(글꼴·표·도장칸·이미지)을 1바이트도 건드리지 않고, 편집된 마크다운의 바뀐 텍스트만 제자리 치환해 새 문서로 출력합니다. parse_document로 얻은 마크다운을 수정해 넘기세요 — 양식 빈칸 채우기·문구 수정에 적합하며 한컴 한글에서 변조 경고 없이 열립니다. (블록 추가/삭제·표 구조 변경은 미지원, 미적용 항목은 결과에 보고)",
    {
      file_path: z.string().min(1).describe("원본 문서의 절대 경로 (HWPX 또는 HWP 5.x)"),
      edited_markdown: z.string().min(1).describe("parse_document 출력 마크다운을 편집한 전체 마크다운. 바뀐 문단/셀 텍스트만 반영하고 블록 수·순서는 원본과 같게 유지하세요"),
      output_path: z.string().min(1).describe("출력 파일 저장 절대 경로 (원본과 같은 확장자: .hwpx 또는 .hwp)"),
    },
    async ({ file_path, edited_markdown, output_path }) => {
      try {
        const out = safeOutputPath(output_path, new Set([".hwpx", ".hwp"]))
        const { buffer } = await readValidatedFile(file_path)
        // ZIP(hwpx/xlsx/docx/pptx)·OLE2(hwp/xls) 모두 내부 구조로 세분화한 포맷으로 판정·안내 (#80).
        // 다른 포맷으로 확인될 때만 거부 — 판별 불가(손상 컨테이너 등)는 종전대로 HWPX/HWP 패처가 판단한다
        let format: string = detectFormat(buffer)
        if (format === "hwpx") { const z = await detectZipFormat(buffer); if (z !== "unknown") format = z }
        else if (format === "hwp") { const o = detectOle2Format(buffer); if (o !== "unknown") format = o }
        const isHwpx = format === "hwpx"
        if (!isHwpx && format !== "hwp") {
          return {
            content: [{ type: "text", text: `patch_document는 HWPX 또는 HWP 5.x만 지원합니다 (감지된 포맷: ${format}).` }],
            isError: true,
          }
        }

        const original = new Uint8Array(buffer)
        const result = isHwpx
          ? await patchHwpx(original, edited_markdown)
          : await patchHwp(original, edited_markdown)

        if (!result.success || !result.data) {
          return {
            content: [{ type: "text", text: `패치 실패: ${result.error ?? "알 수 없는 오류"}` }],
            isError: true,
          }
        }

        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, Buffer.from(result.data))

        const v = result.verification?.stats
        const lossless = v ? (v.modified === 0 && v.added === 0 && v.removed === 0) : undefined
        const lines = [
          `✓ ${result.applied}개 변경 적용 (${isHwpx ? "HWPX" : "HWP"}, 원본 서식 보존) → ${out}`,
          lossless === true ? "검증: 편집 내용과 재파싱 결과 완전 일치" :
            lossless === false ? `검증 잔차: 수정 ${v!.modified} · 추가 ${v!.added} · 삭제 ${v!.removed} (반영 안 된 편집 있음)` : null,
          result.skipped.length > 0
            ? `미적용 ${result.skipped.length}건:\n` + result.skipped.map(s => `  - ${s.reason}`).join("\n")
            : null,
        ].filter(Boolean)

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `오류: ${describeError(err)}` }],
          isError: true,
        }
      }
    }
  )

  // ─── 도구: redact_document ───────────────────────────

  server.tool(
    "redact_document",
    "문서의 개인정보(주민번호·전화·이메일·카드·계좌)를 탐지해 서식 보존 마스킹합니다. HWPX/HWP는 원본 서식 1바이트 그대로 patch, 그 외 포맷은 마스킹된 마크다운으로 출력. 자동 검출 보조 도구 — 결과 리포트를 사람이 최종 확인해야 하며 이미지 안 텍스트는 탐지하지 못합니다. 마스킹 후 render_document로 눈으로 확인하는 것을 권장합니다.",
    {
      file_path: z.string().min(1).describe("대상 문서의 절대 경로"),
      rules: z.array(z.enum(["rrn", "phone", "email", "card", "account", "passport", "driver"])).optional()
        .describe("적용 룰 (기본: rrn·phone·email·card·account — passport·driver는 opt-in)"),
      mask_char: z.string().min(1).max(1).optional().describe("마스크 문자 1글자 (기본: ●)"),
      output_path: z.string().min(1).optional().describe("출력 경로 (HWPX/HWP는 같은 확장자, 그 외는 .md) — dry_run이 아니면 필수"),
      dry_run: z.boolean().default(false).describe("탐지 리포트만 반환, 파일 미생성"),
    },
    async ({ file_path, rules, mask_char, output_path, dry_run }) => {
      try {
        const { buffer } = await readValidatedFile(file_path)
        const format = detectFormat(buffer)
        const patchable = format === "hwpx" || format === "hwp"
        if (!dry_run && !output_path) {
          return { content: [{ type: "text", text: "output_path가 필요합니다 (탐지만 원하면 dry_run: true)." }], isError: true }
        }
        const outPath = !dry_run
          ? safeOutputPath(output_path!, new Set(patchable ? [format === "hwp" ? ".hwp" : ".hwpx"] : [".md", ".markdown", ".txt"]))
          : undefined
        const parsed = await parse(buffer, { filePath: file_path })
        if (!parsed.success) {
          return { content: [{ type: "text", text: `파싱 실패: ${parsed.error}` }], isError: true }
        }
        const { redactMarkdown } = await import("../redact.js")
        const r = redactMarkdown(parsed.markdown, { rules, maskChar: mask_char })
        const byRule = new Map<string, number>()
        for (const h of r.hits) byRule.set(h.rule, (byRule.get(h.rule) ?? 0) + 1)
        const lines = [
          `탐지: ${r.hits.length}건 (${[...byRule.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "없음"})`,
          ...r.hits.map(h => `  - [${h.rule}] ${h.masked}`),
        ]
        if (!dry_run && r.hits.length > 0) {
          if (patchable) {
            const original = new Uint8Array(buffer)
            const result = format === "hwp" ? await patchHwp(original, r.text) : await patchHwpx(original, r.text)
            if (!result.success || !result.data) {
              return { content: [{ type: "text", text: `마스킹 패치 실패: ${result.error ?? "알 수 없는 오류"}` }], isError: true }
            }
            await mkdir(dirname(outPath!), { recursive: true })
            await writeFile(outPath!, Buffer.from(result.data))
            lines.push(`저장: ${outPath} (원본 서식 보존)`)
            if (result.skipped.length > 0) {
              lines.push(`⚠️ 미적용 ${result.skipped.length}건 — 해당 위치는 원문이 남아 있으니 반드시 수동 확인:`)
              for (const s of result.skipped) lines.push(`  - ${s.reason}`)
            }
            lines.push("render_document로 마스킹 결과를 눈으로 확인하세요.")
          } else {
            await mkdir(dirname(outPath!), { recursive: true })
            await writeFile(outPath!, r.text, "utf-8")
            lines.push(`저장: ${outPath} (${format}는 서식 보존 미지원 — 마스킹된 마크다운)`)
          }
        } else if (!dry_run) {
          lines.push("탐지 0건 — 출력 파일을 만들지 않았습니다.")
        }
        lines.push("주의: 자동 검출은 보조 수단입니다. 이미지 속 텍스트·표기 변형은 놓칠 수 있으니 최종 공개 전 사람 검토가 필요합니다.")
        return { content: [{ type: "text", text: capResponseText(lines.join("\n")) }] }
      } catch (err) {
        return { content: [{ type: "text", text: `마스킹 실패: ${describeError(err)}` }], isError: true }
      }
    },
  )
}
