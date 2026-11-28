import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const preload = fileURLToPath(new URL("./helpers/serve-clock-preload.mjs", import.meta.url))
const fixture = new URL("./fixtures/dummy.hwpx", import.meta.url)
const [major, minor] = process.versions.node.split(".").map(Number)
const supported = major > 24 || (major === 24 && minor >= 15)
const testOptions = { skip: supported ? false : "serve requires Node.js 24.15+", timeout: 45_000 }

test("serve asks for a fresh upload when an idempotent retry outlives the original job", testOptions, async t => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-http-expiry-"))
  const env = { ...process.env }
  delete env.KORDOC_SANDBOX
  delete env.KORDOC_SERVE_TOKEN
  const ttl = 600_000
  const child = spawn(process.execPath, [
    "--import", "tsx", "--import", preload, cli, "serve", "--port", "0", "--data-dir", dir,
    "--job-ttl-ms", String(ttl),
  ], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] })
  const exited = once(child, "close")
  t.after(async () => {
    child.kill()
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000)
    try {
      await exited
    } finally {
      clearTimeout(deadline)
      await rm(dir, { recursive: true, force: true })
    }
  })
  let stderr = ""
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
  const signal = t.signal
  let base: string | undefined
  for (let i = 0; i < 1000 && !base && child.exitCode === null; i++) {
    base = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr)?.[1]
    if (!base) await delay(10, undefined, { signal })
  }
  assert.ok(base, stderr)

  const file = await readFile(fixture)
  const jobs = base + "/v1/jobs"
  const headers = { "content-type": "application/octet-stream", "idempotency-key": "slow-retry" }
  const upload = () => fetch(jobs, { method: "POST", body: file, headers, signal })
  const first = await upload()
  assert.equal(first.status, 202)
  const original = first.headers.get("location")
  assert.ok(original)
  await first.body?.cancel()
  for (;;) {
    const result = await fetch(base + original, { signal })
    assert.equal(result.status, 200)
    const { status } = await result.json()
    if (status === "succeeded") break
    assert.ok(status === "queued" || status === "running", status)
    await delay(10, undefined, { signal })
  }

  const retry = request(jobs, {
    method: "POST", signal, headers: { ...headers, Expect: "100-continue", "Content-Length": file.length },
  })
  const continued = once(retry, "continue", { signal })
  retry.flushHeaders()
  await continued
  const advanced = once(child, "message", { signal })
  child.send(ttl * 2)
  const [message] = await advanced
  assert.equal(message, "clock-advanced")
  const replied = once(retry, "response", { signal })
  retry.end(file)
  const [response] = await replied
  let body = ""
  for await (const chunk of response) body += chunk
  assert.equal(response.statusCode, 503, body)
  assert.equal(JSON.parse(body).error.code, "RETRY_UPLOAD")
  assert.ok(response.headers["retry-after"])
  assert.equal(response.headers.location, undefined)

  const expired = await fetch(base + original, { signal })
  assert.equal(expired.status, 404)
  await expired.body?.cancel()
  const fresh = await upload()
  assert.equal(fresh.status, 202)
  const replacement = fresh.headers.get("location")
  assert.ok(replacement)
  assert.notEqual(replacement, original)
  await fresh.body?.cancel()
})
