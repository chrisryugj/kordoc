// 메타 동기화 — 수동 3점 정렬 커밋(483b8b5, b0b11fc 등)이 반복되던 드리프트 자동화.
//
//  1. plugins/kordoc/.claude-plugin/plugin.json 의 version ← package.json version
//  2. .claude/skills/gongmunseo/references/engine-spec.md ← docs/gongmunseo-engine-spec.md (정본)
//  3. server.json 의 version·packages[0].version ← package.json version (MCP 레지스트리)
//  4. plugins/kordoc/skills/kordoc/SKILL.md 의 npx 고정 버전(kordoc@X.Y.Z) ← package.json version
//
// 사용: node scripts/sync-meta.mjs          → 드리프트를 실제로 고침
//       node scripts/sync-meta.mjs --check  → 드리프트 있으면 exit 1 (prepublishOnly 게이트용)

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const checkOnly = process.argv.includes("--check")
let drift = 0

// 1. plugin.json version
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const pluginPath = join(root, "plugins/kordoc/.claude-plugin/plugin.json")
const pluginRaw = readFileSync(pluginPath, "utf8")
const plugin = JSON.parse(pluginRaw)
if (plugin.version !== pkg.version) {
  drift++
  if (checkOnly) {
    console.error(`✗ plugin.json version ${plugin.version} ≠ package.json ${pkg.version}`)
  } else {
    writeFileSync(pluginPath, pluginRaw.replace(`"version": "${plugin.version}"`, `"version": "${pkg.version}"`))
    console.log(`✓ plugin.json version ${plugin.version} → ${pkg.version}`)
  }
}

// 2. engine-spec SSOT (정본: docs/)
const canonical = join(root, "docs/gongmunseo-engine-spec.md")
const copy = join(root, ".claude/skills/gongmunseo/references/engine-spec.md")
if (existsSync(canonical) && existsSync(copy)) {
  const src = readFileSync(canonical, "utf8")
  if (readFileSync(copy, "utf8") !== src) {
    drift++
    if (checkOnly) {
      console.error("✗ engine-spec.md 드리프트: docs/(정본) ≠ .claude/skills/gongmunseo/references/")
    } else {
      writeFileSync(copy, src)
      console.log("✓ engine-spec.md 동기화 (docs/ → skills/references/)")
    }
  }
}

// 3. server.json version (MCP 레지스트리: 게시된 npm 버전과 같아야 등록된다)
const serverPath = join(root, "server.json")
const serverRaw = readFileSync(serverPath, "utf8")
const server = JSON.parse(serverRaw)
if (server.version !== pkg.version || server.packages[0].version !== pkg.version) {
  drift++
  if (checkOnly) {
    console.error(`✗ server.json version ${server.version} / packages[0] ${server.packages[0].version} ≠ package.json ${pkg.version}`)
  } else {
    server.version = pkg.version
    server.packages[0].version = pkg.version
    writeFileSync(serverPath, JSON.stringify(server, null, 2) + "\n")
    console.log(`✓ server.json version → ${pkg.version}`)
  }
}

// 4. 플러그인 스킬의 npx 고정 버전(kordoc@X.Y.Z) ← package.json version (디렉터리 심사가 범위 버전을 막는다)
const skillPath = join(root, "plugins/kordoc/skills/kordoc/SKILL.md")
const skillRaw = readFileSync(skillPath, "utf8")
const pinned = skillRaw.replace(/kordoc@(?:\^?\d+(?:\.\d+){0,2})(?=[\s`])/g, `kordoc@${pkg.version}`)
if (pinned !== skillRaw) {
  drift++
  if (checkOnly) {
    console.error(`✗ SKILL.md npx 고정 버전 ≠ package.json ${pkg.version}`)
  } else {
    writeFileSync(skillPath, pinned)
    console.log(`✓ SKILL.md npx 고정 버전 → ${pkg.version}`)
  }
}

if (drift === 0) console.log("✓ 메타 동기화 상태 양호 (드리프트 없음)")
else if (checkOnly) {
  console.error(`\n${drift}건 드리프트 — \`node scripts/sync-meta.mjs\` 로 정렬 후 커밋하세요.`)
  process.exit(1)
}
