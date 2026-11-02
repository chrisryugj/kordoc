/** kordoc MCP 도구 — 변환 — convert_to_hwpx */

import { z } from "zod"
import { mkdir, access } from "fs/promises"
import { dirname } from "path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { KordocError } from "../utils.js"
import { MAX_FILE_SIZE, safeOutputPath, writeOutputFile, describeError, readValidatedFile } from "./shared.js"

export function registerConvertTools(server: McpServer): void {
  server.tool(
    "convert_to_hwpx",
    "HWP 문서를 HWPX 로 변환해 저장합니다. HWP 5.x 는 서식 그대로 옮깁니다 — 글꼴·글자/문단 모양·스타일·번호, 표(병합·테두리), 그림·도형·글상자, " +
    "수식, 머리말·꼬리말, 각주·미주, 쪽 번호, 누름틀·하이퍼링크, 차트. HWP 3.x 는 서식 보존 변환이 없어 글·표만 옮깁니다(결과에 알림). " +
    "\"hwp 를 hwpx 로 바꿔 줘\" 같은 요청에 쓰고, 바꾼 뒤 render_document 로 결과를 확인할 수 있습니다. 배포용(읽기 전용) 문서는 변환하지 않습니다.",
    {
      file_path: z.string().min(1).describe("변환할 HWP 파일의 절대 경로"),
      output_path: z.string().min(1).optional().describe("저장할 .hwpx 경로 (기본: 입력과 같은 폴더·같은 이름의 .hwpx — 그 파일이 이미 있으면 덮어쓰지 않고 실패하니 그때는 경로를 지정)"),
      password: z.string().optional().describe("암호로 보호된 HWP 의 열기 암호"),
      engine: z.enum(["kordoc", "hancom", "auto"]).optional()
        .describe("변환 엔진 — \"kordoc\"(기본, 어디서나) | \"hancom\"(Windows 한/글 자체 저장, 팝업 없이 — HWP 3.x 도 서식 그대로) | \"auto\"(한/글이 있으면 hancom)"),
    },
    async ({ file_path, output_path, password, engine }) => {
      try {
        const { buffer, resolved } = await readValidatedFile(file_path, MAX_FILE_SIZE, new Set([".hwp", ".hml"]))
        const outPath = safeOutputPath(output_path ?? resolved.replace(/\.(hwp|hml)$/i, "") + ".hwpx", new Set([".hwpx"]))
        if (outPath === resolved) throw new KordocError("출력 경로가 입력 파일과 같습니다")
        // 같은 이름 .hwpx 는 한글로 따로 저장해 둔 문서일 수 있다 — 기본 경로로는 덮어쓰지 않는다
        if (!output_path && await access(outPath).then(() => true, () => false)) {
          throw new KordocError(`${outPath} 이(가) 이미 있습니다 — 덮어쓰려면 output_path 로 경로를 직접 지정하세요`)
        }
        const { convertToHwpx, validateHwpx } = await import("../index.js")
        const result = await convertToHwpx(buffer, { password, engine })
        const check = await validateHwpx(result.data)
        await mkdir(dirname(outPath), { recursive: true })
        await writeOutputFile(outPath, result.data)
        const lines = [
          `${result.mode === "preserve" ? "서식 그대로" : "글·표만"} HWPX 로 변환했습니다${result.engine === "hancom" ? "(한/글 저장)" : ""}: ${outPath} (${result.data.length.toLocaleString()} 바이트)`,
          ...result.warnings.map(w => `⚠️ ${w}`),
          ...(check.ok ? [] : check.issues.map(i => `✗ 구조 문제 ${i.path ? `${i.path}: ` : ""}${i.message}`)),
        ]
        return { content: [{ type: "text", text: lines.join("\n") }], ...(check.ok ? {} : { isError: true }) }
      } catch (err) {
        return { content: [{ type: "text", text: `변환 실패: ${describeError(err)}` }], isError: true }
      }
    },
  )
}
