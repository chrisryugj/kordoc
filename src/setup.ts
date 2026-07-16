/**
 * 대화형 설치 마법사 — kordoc MCP
 *
 * `npx kordoc setup` 으로 실행.
 * 선택한 AI 클라이언트 설정 파일에 kordoc-mcp 서버를 자동 등록합니다.
 * API 키 불필요, macOS / Linux / Windows 공용.
 */

import { createInterface } from "node:readline/promises"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { homedir, platform } from "node:os"
import { stdin, stdout } from "node:process"

interface ClientConfig {
  readonly name: string
  readonly configPath: string
  readonly format: "mcpServers" | "servers" | "context_servers"
}

function detectClients(): readonly ClientConfig[] {
  const home = homedir()
  const os = platform()
  const clients: ClientConfig[] = []

  const claudePaths: Record<string, string> = {
    darwin: resolve(home, "Library/Application Support/Claude/claude_desktop_config.json"),
    win32: resolve(process.env["APPDATA"] ?? resolve(home, "AppData/Roaming"), "Claude/claude_desktop_config.json"),
    linux: resolve(home, ".config/Claude/claude_desktop_config.json"),
  }
  const claudePath = claudePaths[os]
  if (claudePath) clients.push({ name: "Claude Desktop", configPath: claudePath, format: "mcpServers" })

  clients.push({ name: "Claude Code (현재 디렉토리)", configPath: resolve(process.cwd(), ".mcp.json"), format: "mcpServers" })
  clients.push({ name: "Cursor", configPath: resolve(home, ".cursor/mcp.json"), format: "mcpServers" })
  clients.push({ name: "VS Code (현재 디렉토리)", configPath: resolve(process.cwd(), ".vscode/mcp.json"), format: "servers" })
  clients.push({ name: "Windsurf", configPath: resolve(home, ".codeium/windsurf/mcp_config.json"), format: "mcpServers" })
  clients.push({ name: "Gemini CLI", configPath: resolve(home, ".gemini/settings.json"), format: "mcpServers" })

  const zedPaths: Record<string, string> = {
    darwin: resolve(home, ".zed/settings.json"),
    linux: resolve(home, ".config/zed/settings.json"),
    win32: resolve(home, ".zed/settings.json"),
  }
  const zedPath = zedPaths[os]
  if (zedPath) clients.push({ name: "Zed", configPath: zedPath, format: "context_servers" })

  clients.push({ name: "Antigravity", configPath: resolve(home, ".gemini/antigravity/mcp_config.json"), format: "mcpServers" })

  return clients
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {}
  const raw = await readFile(path, "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

async function writeJsonFile(path: string, data: Record<string, unknown>): Promise<void> {
  const dir = dirname(path)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8")
}

/**
 * Windows 에선 npx.cmd 를 Claude Desktop 이 해석 못 해서 `cmd /c` 래핑이 필요하다.
 * `kordoc` 은 `npx kordoc mcp` 로 MCP 서버 실행, 또는 `kordoc-mcp` bin 직접 실행.
 * npx 래핑이 범용적이므로 `npx -y kordoc mcp` 로 통일.
 */
function buildServerEntry(): Record<string, unknown> {
  if (platform() === "win32") {
    return { command: "cmd", args: ["/c", "npx", "-y", "kordoc", "mcp"] }
  }
  return { command: "npx", args: ["-y", "kordoc", "mcp"] }
}

function buildZedEntry(): Record<string, unknown> {
  const base = platform() === "win32"
    ? { path: "cmd", args: ["/c", "npx", "-y", "kordoc", "mcp"] }
    : { path: "npx", args: ["-y", "kordoc", "mcp"] }
  return { command: base }
}

// ─── ANSI ─────────────────────────────────────────────────────────────
const ESC = "\x1b["
const c = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`,
  cyan: `${ESC}36m`, green: `${ESC}32m`, yellow: `${ESC}33m`,
  red: `${ESC}31m`, white: `${ESC}37m`,
} as const

function rgb(r: number, g: number, b: number): string {
  return `${ESC}38;2;${r};${g};${b}m`
}
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
async function typewrite(text: string, delay = 15): Promise<void> {
  for (const ch of text) { process.stdout.write(ch); await sleep(delay) }
  console.log()
}

async function printBanner(): Promise<void> {
  const gradients = [
    rgb(255, 120, 80), rgb(255, 140, 80), rgb(255, 160, 80),
    rgb(240, 180, 80), rgb(220, 200, 80), rgb(200, 220, 80),
  ]
  const logo = [
    "  _                  _            ",
    " | | _____  _ __ __| | ___   ___ ",
    " | |/ / _ \\| '__/ _` |/ _ \\ / __|",
    " |   < (_) | | | (_| | (_) | (__ ",
    " |_|\\_\\___/|_|  \\__,_|\\___/ \\___|",
  ]
  console.log()
  for (let i = 0; i < logo.length; i++) {
    console.log(`${gradients[i % gradients.length]}${c.bold}${logo[i]}${c.reset}`)
    await sleep(60)
  }
  console.log()
  await typewrite(`${c.dim}  모두 파싱해버리겠다  ━━  HWP · HWPX · PDF · XLSX · DOCX → Markdown${c.reset}`, 10)
  console.log()
  console.log(`${c.cyan}  ${"━".repeat(60)}${c.reset}`)
  console.log()
}

function stepHeader(step: number, total: number, title: string): void {
  const dots = `${c.dim}${"·".repeat(Math.max(0, 40 - title.length))}${c.reset}`
  console.log(`  ${c.cyan}${c.bold}[${step}/${total}]${c.reset} ${c.white}${c.bold}${title}${c.reset} ${dots}`)
  console.log()
}

function successLine(label: string, detail: string): void {
  console.log(`  ${c.green}${c.bold}+${c.reset} ${c.white}${label}${c.reset}${c.dim} ${detail}${c.reset}`)
}
function failLine(label: string, detail: string): void {
  console.log(`  ${c.red}${c.bold}x${c.reset} ${c.white}${label}${c.reset}${c.dim} ${detail}${c.reset}`)
}

async function printComplete(): Promise<void> {
  console.log()
  const box = [
    `  ${c.green}${c.bold}╔${"═".repeat(50)}╗${c.reset}`,
    `  ${c.green}${c.bold}║${c.reset}${" ".repeat(14)}${c.green}${c.bold}Setup Complete!${c.reset}${" ".repeat(22)}${c.green}${c.bold}║${c.reset}`,
    `  ${c.green}${c.bold}╚${"═".repeat(50)}╝${c.reset}`,
  ]
  for (const line of box) { console.log(line); await sleep(40) }
  console.log()
  console.log(`  ${c.dim}클라이언트를 재시작하면 'kordoc' MCP 서버가 활성화됩니다.${c.reset}`)
  console.log(`  ${c.dim}15개 도구: parse_document / parse_metadata / parse_pages / parse_table${c.reset}`)
  console.log(`  ${c.dim}          detect_format / compare_documents / parse_form / fill_form${c.reset}`)
  console.log(`  ${c.dim}          place_seal / patch_document / extract_profile / generate_document${c.reset}`)
  console.log(`  ${c.dim}          render_document / redact_document / parse_chunks${c.reset}`)
  console.log()
}

export async function runSetup(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })

  try {
    await printBanner()

    stepHeader(1, 2, "MCP 클라이언트 선택")
    const clients = detectClients()
    clients.forEach((cl, i) => {
      const exists = existsSync(cl.configPath)
      const badge = exists ? `${c.green} [감지됨]${c.reset}` : ""
      const num = `${c.cyan}${String(i + 1).padStart(2)}${c.reset}`
      console.log(`  ${num}) ${c.white}${cl.name}${c.reset}${badge}`)
    })
    console.log()
    const clientInput = (await rl.question(`  ${c.cyan}>${c.reset} 번호 (예: 1,3): `)).trim()

    if (!clientInput) {
      console.log(`\n  ${c.yellow}선택 없음${c.reset} — 수동 설정 안내:`)
      printManualConfig()
      return
    }

    const indices = clientInput
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < clients.length)

    if (indices.length === 0) {
      console.log(`\n  ${c.yellow}유효한 선택 없음${c.reset} — 수동 설정 안내:`)
      printManualConfig()
      return
    }

    console.log()
    stepHeader(2, 2, "설정 파일 업데이트")
    const entry = buildServerEntry()

    for (const idx of indices) {
      const client = clients[idx]
      await sleep(150)
      try {
        const config = await readJsonFile(client.configPath)
        const key = client.format
        const serverEntry = key === "context_servers" ? buildZedEntry() : entry
        const servers = (config[key] ?? {}) as Record<string, unknown>
        servers["kordoc"] = serverEntry
        config[key] = servers
        await writeJsonFile(client.configPath, config)
        successLine(client.name, client.configPath)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failLine(client.name, msg)
      }
    }

    await printComplete()
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_USE_AFTER_CLOSE") return
    throw err
  } finally {
    rl.close()
  }
}

function printManualConfig(): void {
  const entry = buildServerEntry()
  console.log()
  console.log(`  ${c.dim}아래 JSON을 설정 파일의 mcpServers에 추가하세요:${c.reset}`)
  console.log()
  console.log(`  ${c.cyan}"kordoc"${c.reset}: ${JSON.stringify(entry, null, 4)}`)
  console.log()
}
