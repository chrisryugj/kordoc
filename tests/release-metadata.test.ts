import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf-8"))

test("배포 메타데이터와 플러그인이 kordoc v4로 일치", () => {
  const pkg = json("package.json")
  const lock = json("package-lock.json")
  const plugin = json("plugins/kordoc/.claude-plugin/plugin.json")
  const skill = readFileSync(join(root, "plugins/kordoc/skills/kordoc/SKILL.md"), "utf-8")

  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[""].version, pkg.version)
  assert.equal(plugin.version, pkg.version)
  assert.ok(!skill.includes("kordoc@^3"))
  for (const preset of ["기안문", "보고서", "계획서", "통지", "회의록", "개조식", "보도자료"]) {
    assert.ok(skill.includes(`\`${preset}\``), `플러그인 문서에 ${preset} 프리셋`)
  }
})
