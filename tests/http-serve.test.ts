import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const fixture = new URL("./fixtures/dummy.hwpx", import.meta.url)
const otherFixture = new URL("./fixtures/textbox-nested/textbox-nested.hwp", import.meta.url)
const [major, minor] = process.versions.node.split(".").map(Number)
const supported = major > 24 || (major === 24 && minor >= 15)
const testOptions = { skip: supported ? false : "serve requires Node.js 24.15+", timeout: 45_000 }

async function start(dataDir: string, args: string[] = [], options: { token?: string; worker?: "hold" | "crash" } = {}) {
  const env = { ...process.env }
  delete env.KORDOC_SANDBOX
  delete env.KORDOC_SERVE_TOKEN
  if (options.token) env.KORDOC_SERVE_TOKEN = options.token
  if (options.worker) {
    const preload = new URL("./fixtures/serve-worker.mjs", import.meta.url)
    preload.searchParams.set("mode", options.worker)
    preload.searchParams.set("attempts", join(dataDir, "worker-attempts.log"))
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${preload.href}`].filter(Boolean).join(" ")
  }
  const child = spawn(process.execPath, ["--import", "tsx", cli, "serve", "--port", "0", "--data-dir", dataDir, ...args], {
    env, stdio: ["ignore", "ignore", "pipe"],
  })
  let stderr = ""
  let done = false
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", code => { done = true; resolve(code) })
  })
  const stop = async () => {
    if (!done) child.kill()
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000)
    try { return await exited } finally { clearTimeout(deadline) }
  }
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
  try {
    for (let i = 0; i < 1_000 && !done; i++) {
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stderr)?.[0]
      if (url) return { url, stop }
      await delay(10)
    }
    assert.fail(`serve did not start: ${stderr}`)
  } catch (error) {
    await stop()
    throw error
  }
}

function upload(url: string, body: Uint8Array | string, headers?: Record<string, string>) {
  return fetch(url, {
    method: "POST", body, headers: { "content-type": "application/octet-stream", ...headers },
    signal: AbortSignal.timeout(15_000),
  })
}

async function submitJob(url: string, bytes: Uint8Array, query = "") {
  const added = await upload(url + "/v1/jobs" + query, bytes)
  assert.equal(added.status, 202)
  const path = added.headers.get("location")
  assert.ok(path)
  await added.body?.cancel()
  return path
}

async function poll(url: string, statuses = ["succeeded", "failed"]) {
  for (let i = 0; i < 1_000; i++) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    assert.equal(resp.status, 200)
    const job = await resp.json()
    if (statuses.includes(job.status)) return job
    await delay(10)
  }
  assert.fail(`job did not reach ${statuses.join(" or ")}`)
}

test("serve parses bytes, reuses a job on retry, and persists its result across restart", testOptions, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-http-"))
  let server: Awaited<ReturnType<typeof start>> | undefined
  try {
    const file = await readFile(fixture)
    server = await start(dir)
    const parsed = await upload(server.url + "/v1/parse?blocks=true", file)
    assert.equal(parsed.status, 200, await parsed.clone().text())
    const result = await parsed.json()
    assert.equal(result.fileType, "hwpx")
    assert.match(result.markdown, /서면자문 의견서/)
    assert.ok(Array.isArray(result.blocks) && result.blocks.length > 0)

    const results = await Promise.all(Array.from({ length: 3 }, () =>
      upload(server!.url + "/v1/jobs", file, { "idempotency-key": "same-document" })))
    const path = results[0].headers.get("location")
    assert.match(path ?? "", /^\/v1\/jobs\/[a-f\d-]+$/)
    const accepted = await Promise.all(results.map(async reply => {
      assert.equal(reply.status, 202, await reply.clone().text())
      assert.equal(reply.headers.get("location"), path)
      return reply.json()
    }))
    assert.ok(accepted.every(job => job.jobId === accepted[0].jobId))
    const conflicting = await upload(server.url + "/v1/jobs", "another file", { "idempotency-key": "same-document" })
    assert.equal(conflicting.status, 409)
    await conflicting.body?.cancel()

    const finished = await poll(server.url + path)
    assert.equal(finished.status, "succeeded", JSON.stringify(finished))
    assert.equal(finished.result.markdown, result.markdown)
    assert.equal(finished.result.blocks, undefined)

    const otherFile = await readFile(otherFixture)
    const distinct = await Promise.all([file, otherFile].map(bytes => upload(server!.url + "/v1/jobs", bytes)))
    const [firstJob, secondJob] = await Promise.all(distinct.map(async response => {
      assert.equal(response.status, 202)
      const path = response.headers.get("location")
      assert.ok(path)
      await response.body?.cancel()
      return poll(server!.url + path)
    }))
    assert.equal(firstJob.result.fileType, "hwpx")
    assert.match(firstJob.result.markdown, /서면자문 의견서/)
    assert.equal(secondJob.result.fileType, "hwp")
    assert.match(secondJob.result.markdown, /글상자 앞 본문/)
    await server.stop()

    server = await start(dir)
    assert.deepEqual(await poll(server.url + path), finished)
    const again = await upload(server.url + "/v1/jobs", file, { "idempotency-key": "same-document" })
    assert.equal(again.status, 202)
    assert.equal((await again.json()).jobId, accepted[0].jobId)
  } finally {
    await server?.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("serve enforces authentication, body and query limits, and reports parse errors", testOptions, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-http-"))
  let server: Awaited<ReturnType<typeof start>> | undefined
  const headers = { authorization: "Bearer integration-test-token" }
  try {
    server = await start(dir, ["--max-upload-bytes", "64"], { token: "integration-test-token" })
    const unauthorized = await upload(server.url + "/v1/jobs", "test")
    assert.equal(unauthorized.status, 401)
    await unauthorized.body?.cancel()

    const fromBrowser = await upload(server.url + "/v1/jobs", "test", { ...headers, origin: "https://example.org" })
    assert.equal(fromBrowser.status, 403)
    await fromBrowser.body?.cancel()

    const options = await upload(server.url + "/v1/jobs?filePath=ignored", "test", headers)
    assert.equal(options.status, 400)
    await options.body?.cancel()

    const oversized = await upload(server.url + "/v1/jobs", Buffer.alloc(65), headers)
    assert.equal(oversized.status, 413)
    await oversized.body?.cancel()

    const invalidFile = await upload(server.url + "/v1/parse", "invalid document", headers)
    assert.equal(invalidFile.status, 422, await invalidFile.clone().text())
    assert.equal((await invalidFile.json()).error.code, "UNSUPPORTED_FORMAT")
  } finally {
    await server?.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

const posixTestOptions = {
  ...testOptions, skip: testOptions.skip || (process.platform === "win32" && "SIGTERM requires POSIX signals"),
}

test("serve resumes a running job after repeated orderly shutdowns", posixTestOptions, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-http-"))
  let server: Awaited<ReturnType<typeof start>> | undefined
  const args = ["--workers", "1"]
  try {
    server = await start(dir, args, { worker: "hold" })
    const path = await submitJob(server.url, await readFile(fixture))
    await poll(server.url + path, ["running"])
    assert.equal(await server.stop(), 0)

    server = await start(dir, args, { worker: "hold" })
    await poll(server.url + path, ["running"])
    assert.equal(await server.stop(), 0)

    server = await start(dir, args)
    const job = await poll(server.url + path)
    assert.equal(job.status, "succeeded", JSON.stringify(job))
    assert.match(job.result.markdown, /서면자문 의견서/)
  } finally {
    await server?.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("serve preserves a queued OCR job when startup cannot bind its port", posixTestOptions, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-http-"))
  const occupied = createServer()
  let server: Awaited<ReturnType<typeof start>> | undefined
  const args = ["--workers", "1"]
  try {
    occupied.listen(0, "127.0.0.1")
    await once(occupied, "listening")
    const address = occupied.address()
    assert.ok(address && typeof address === "object")

    const bytes = await readFile(fixture)
    server = await start(dir, args, { worker: "hold" })
    const first = await submitJob(server.url, bytes)
    await poll(server.url + first, ["running"])
    const ocr = await submitJob(server.url, bytes, "?ocr=true")
    await poll(server.url + ocr, ["queued"])
    assert.equal(await server.stop(), 0)

    await assert.rejects(start(dir, [...args, "--port", String(address.port), "--ocr-workers", "0"]), /EADDRINUSE/)

    server = await start(dir, args)
    const job = await poll(server.url + ocr)
    assert.equal(job.status, "succeeded", JSON.stringify(job))
    assert.match(job.result.markdown, /서면자문 의견서/)
  } finally {
    occupied.close()
    await server?.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("serve fails a job after two parser crashes", testOptions, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-http-"))
  let server: Awaited<ReturnType<typeof start>> | undefined
  try {
    server = await start(dir, ["--workers", "1"], { worker: "crash" })
    const path = await submitJob(server.url, await readFile(fixture))
    const job = await poll(server.url + path)
    assert.equal(job.status, "failed", JSON.stringify(job))
    assert.equal(job.error.code, "WORKER_FAILED")
    assert.equal(await readFile(join(dir, "worker-attempts.log"), "utf8"), "parse\nparse\n")
  } finally {
    await server?.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("serve rejects excess jobs without dropping retained jobs and admits more after expiry", testOptions, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-http-"))
  let server: Awaited<ReturnType<typeof start>> | undefined
  const limits = ["--workers", "1", "--max-jobs", "1", "--max-retained-jobs", "1"]
  const headers = { "idempotency-key": "retained-job" }
  try {
    const file = await readFile(fixture)
    server = await start(dir, limits)
    const added = await upload(server.url + "/v1/jobs", file, headers)
    assert.equal(added.status, 202, await added.clone().text())
    const path = added.headers.get("location")
    assert.ok(path)
    await added.body?.cancel()
    assert.equal((await poll(server.url + path)).status, "succeeded")

    const rejected = await upload(server.url + "/v1/jobs", file)
    assert.equal(rejected.status, 503)
    assert.ok(rejected.headers.get("retry-after"))
    await rejected.body?.cancel()
    const duplicate = await upload(server.url + "/v1/jobs", file, headers)
    assert.equal(duplicate.status, 202)
    assert.equal(duplicate.headers.get("location"), path)
    await duplicate.body?.cancel()
    await server.stop()

    server = await start(dir, [...limits, "--job-ttl-ms", "1"])
    const expired = await fetch(server.url + path)
    assert.equal(expired.status, 404)
    await expired.body?.cancel()
    const admitted = await upload(server.url + "/v1/jobs", file, headers)
    assert.equal(admitted.status, 202)
    assert.notEqual(admitted.headers.get("location"), path)
    await admitted.body?.cancel()
  } finally {
    await server?.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("a parser child exits when its IPC host disconnects with stdin still open", testOptions, async () => {
  const env = { ...process.env }
  delete env.KORDOC_SANDBOX
  const child = spawn(process.execPath, ["--import", "tsx", cli, "parse-worker", "--protocol", "2"], {
    env, stdio: ["pipe", "pipe", "inherit", "ipc"],
  })
  assert.ok(child.stdout)
  const lines = createInterface({ input: child.stdout })
  const exited = once(child, "exit", { signal: AbortSignal.timeout(20_000) })
  try {
    const [line] = await once(lines, "line", { signal: AbortSignal.timeout(15_000) })
    assert.equal(JSON.parse(line).ready, true)
    child.disconnect()
    assert.deepEqual(await exited, [0, null])
  } finally {
    lines.close()
    child.kill("SIGKILL")
    await exited
  }
})
