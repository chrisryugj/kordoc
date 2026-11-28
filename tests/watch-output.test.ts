import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
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

for (const savedAgain of [false, true]) {
  const name = savedAgain
    ? "watch waits for the debounce when a file is saved again just before a rerun"
    : "watch re-converts a file saved while its webhook is still pending"
  test(name, { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-watch-resave-"))
    const input = join(dir, "input")
    const output = join(dir, "output")
    mkdirSync(input)
    // 첫 응답은 시험이 풀어 줄 때까지 붙잡아, 같은 파일의 처리가 확실히 진행 중이게 한다
    const received: string[] = []
    let releaseFirst: (() => void) | undefined
    const server = createServer((req, res) => {
      let body = ""
      req.setEncoding("utf8").on("data", chunk => { body += chunk })
      req.on("end", () => {
        received.push(JSON.parse(body).markdown.trim())
        if (received.length === 1) releaseFirst = () => res.end("ok")
        else res.end("ok")
      })
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
    const preload = new URL("./helpers/watch-webhook-preload.mjs", import.meta.url).href
    const env: NodeJS.ProcessEnv = { ...process.env, HOOK_PORT: String((server.address() as AddressInfo).port) }
    delete env.KORDOC_OFFLINE
    const child = spawn(process.execPath, ["--import", "tsx", "--import", preload, cli, "watch", input, "-d", output, "--webhook", "http://hook.example.invalid/"], {
      stdio: ["ignore", "ignore", "pipe"],
      env,
    })
    const exited = once(child, "exit")
    let logs = ""
    child.stderr.setEncoding("utf8").on("data", chunk => { logs += chunk })
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10000
      while (!predicate() && child.exitCode === null && Date.now() < deadline) await delay(50)
      assert.ok(predicate(), logs)
    }
    try {
      await waitFor(() => logs.includes("[kordoc watch]"))
      await delay(100)
      const file = join(input, "report.hwpx")
      writeFileSync(file, Buffer.from(await markdownToHwpx("first version")))
      await waitFor(() => releaseFirst !== undefined)
      writeFileSync(file, Buffer.from(await markdownToHwpx("second version")))
      await delay(2500) // 디바운스(1초)가 처리 중에 끝나도록
      if (savedAgain) {
        writeFileSync(file, Buffer.from(await markdownToHwpx("third version")))
        await delay(300) // 새 디바운스가 남은 채로 첫 처리를 끝낸다
      }
      releaseFirst!()
      const last = savedAgain ? "third version" : "second version"
      await waitFor(() => received.length >= 2)
      await delay(2500) // 중복 전송이 있다면 도착할 시간
      assert.deepEqual(received, ["first version", last])
      assert.ok(readFileSync(join(output, "report.md"), "utf8").includes(last))
    } finally {
      child.kill()
      await exited
      server.closeAllConnections()
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
