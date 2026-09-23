/** kordoc MCP 서버 — Claude/Cursor에서 문서 파싱 도구로 사용. 도구 정의는 mcp/ 아래 도구군 모듈 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { realpathSync } from "fs"
import { pathToFileURL } from "url"
import { VERSION } from "./utils.js"
import { getAccessRoot, isOfflineMode } from "./shared/offline.js"
import { registerParseTools } from "./mcp/tools-parse.js"
import { registerFormTools } from "./mcp/tools-form.js"
import { registerRenderTools } from "./mcp/tools-render.js"
import { registerGenerateTools } from "./mcp/tools-generate.js"

export { ALLOWED_EXTENSIONS, PARSE_EXTENSIONS, IMAGE_EXTENSIONS, PROFILE_EXTENSIONS, safePath, safeOutputPath, describeError, capResponseText } from "./mcp/shared.js"
export { buildFillInputs } from "./mcp/tools-form.js"

const server = new McpServer({
  name: "kordoc",
  version: VERSION,
})

registerParseTools(server)
registerFormTools(server)
registerRenderTools(server)
registerGenerateTools(server)

// ─── 서버 시작 ───────────────────────────────────────

/** MCP 서버 시작 (중복 호출 무해) — kordoc-mcp bin 직접 실행 시 자동, `kordoc mcp` 서브커맨드에선 CLI가 호출 */
let serverStarted = false
export async function startMcpServer(): Promise<void> {
  if (serverStarted) return
  serverStarted = true
  // 폐쇄망 배포 감사용 — 적용된 제한을 기동 시 1회 stderr 에 남긴다 (stdout 은 MCP 프로토콜 전용)
  const root = getAccessRoot()
  if (isOfflineMode() || root) {
    const flags = [isOfflineMode() ? "offline" : null, root ? `root=${root}` : null].filter(Boolean)
    process.stderr.write(`[kordoc-mcp] 제한 모드: ${flags.join(", ")}\n`)
  }
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// 직접 실행(kordoc-mcp bin / node dist·src mcp)이 아닌 import(테스트의 헬퍼 import)에서는
// 자동 시작하지 않는다 — stdio 점유로 테스트 러너가 행. 판정 불가 시엔 기존 동작(자동 시작) 유지.
let autoStart = true
try {
  const entry = process.argv[1]
  if (entry && pathToFileURL(realpathSync(entry)).href !== import.meta.url) autoStart = false
} catch { /* 판정 실패 → 자동 시작 유지 */ }

if (autoStart) startMcpServer().catch((err) => { console.error(err); process.exit(1) })
