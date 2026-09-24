import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { markdownToHwpx } from "../src/hwpx/generator.js"

for (const format of ["markdown", "json"]) {
  test(`watch preserves subdirectories in ${format} output`, { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-watch-output-"))
    const input = join(dir, "input")
    const output = join(dir, "output")
    mkdirSync(join(input, "alpha"), { recursive: true })
    mkdirSync(join(input, "beta"), { recursive: true })
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
    const child = spawn(process.execPath, ["--import", "tsx", cli, "watch", input, "-d", output, "--format", format], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, KORDOC_OFFLINE: "1" },
    })
    const exited = once(child, "exit")
    let logs = ""
    child.stderr.setEncoding("utf8").on("data", chunk => { logs += chunk })
    child.stdout.resume()
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10000
      while (!predicate() && child.exitCode === null && Date.now() < deadline) await delay(50)
      assert.ok(predicate(), logs)
    }
    const ext = format === "json" ? ".json" : ".md"
    try {
      await waitFor(() => logs.includes("[kordoc watch]"))
      await delay(100)
      for (const folder of ["alpha", "beta"]) {
        writeFileSync(join(input, folder, "report.hwpx"), Buffer.from(await markdownToHwpx(`${folder} document`)))
      }
      await waitFor(() => logs.split("→").length >= 3)
      for (const folder of ["alpha", "beta"]) {
        const path = join(output, folder, `report${ext}`)
        assert.ok(existsSync(path), `Missing ${path}; logs: ${logs}`)
        assert.ok(readFileSync(path, "utf8").includes(`${folder} document`))
      }
      writeFileSync(join(input, "report.hwpx"), Buffer.from(await markdownToHwpx("root document")))
      await waitFor(() => existsSync(join(output, `report${ext}`)))
      assert.ok(readFileSync(join(output, `report${ext}`), "utf8").includes("root document"))
    } finally {
      child.kill()
      await exited
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
