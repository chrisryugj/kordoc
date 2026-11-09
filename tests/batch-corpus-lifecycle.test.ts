import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, readFileSync, readdirSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ensureModelsIn } from "../src/pdf/formula/models.js"
import { cleanupModelDownloadPartials, modelDownloadPartialPath } from "../src/pdf/formula/model-partials.js"

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const document = fileURLToPath(new URL("./fixtures/dummy.hwpx", import.meta.url))
const downloadChild = fileURLToPath(new URL("./helpers/model-download-child.mjs", import.meta.url))
const bytes = Buffer.alloc(65536, 0x61)
const spec = { name: "test", filename: "test.onnx", url: "https://not-fetched.invalid/model", sha256: createHash("sha256").update(bytes).digest("hex"), sizeMb: 1 }
const pause = () => new Promise(resolve => setTimeout(resolve, 10))
const exitOf = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
  child.once("error", reject)
  child.once("exit", (code, signal) => resolve({ code, signal }))
})

// Linux can leave an exited grandchild as a zombie until its new parent reaps it.
// It has no running JS/native handles and is not a live worker.
function running(pid: number): boolean {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0]
    return state !== "Z" && state !== "X"
  } catch { return false }
}

for (const signal of ["SIGINT", "SIGKILL"] as const) {
  test(`active parallel batch terminates its workers after parent ${signal}`, { skip: process.platform !== "linux", timeout: 20000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "kordoc-active-batch-"))
    const out = join(dir, "out")
    await mkdir(out)
    // Repetition supplies a deterministic pending queue, not a representative
    // quality/performance corpus. At least one real conversion must finish first.
    const files = Array.from({ length: 256 }, (_, i) => join(dir, `document-${i}.hwpx`))
    files.forEach(path => copyFileSync(document, path))
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...files, "--jobs", "2", "--silent", "-d", out])
    const exited = exitOf(child)
    child.stdout!.resume()
    let stderr = ""
    child.stderr!.on("data", data => { stderr += data })
    let pids: number[] = []
    try {
      const deadline = Date.now() + 12000
      let completed = 0
      while (Date.now() < deadline) {
        try {
          // 부모 PID 로 찾는다 — gVisor 의 /proc/<pid>/task/<pid>/children 은 이 자식들을 보여 주지 않았다(CI gvisor 잡)
          pids = readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number)
            .filter(pid => { try { return Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1]) === child.pid && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("__convert-worker") } catch { return false } })
        } catch { /* child starting or already exited */ }
        completed = readdirSync(out).filter(name => name.endsWith(".md")).length
        if (completed > 0 && completed < files.length && pids.length === 2) break
        if (child.exitCode !== null || child.signalCode !== null) break
        await pause()
      }
      assert.equal(pids.length, 2, stderr)
      assert.ok(completed > 0 && completed < files.length, `must interrupt an active queue, completed ${completed}/${files.length}: ${stderr}`)
      assert.ok(child.kill(signal))
      assert.deepEqual(await exited, signal === "SIGINT" ? { code: 130, signal: null } : { code: null, signal: "SIGKILL" }, stderr)
      const deadlineAfterKill = Date.now() + 5000
      while (pids.some(running) && Date.now() < deadlineAfterKill) await pause()
      assert.ok(pids.every(pid => !running(pid)), `live workers remain: ${pids.filter(running).join(", ")}`)
      const settledCount = readdirSync(out).length
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(readdirSync(out).length, settledCount, "terminated workers must not continue producing output")
    } finally {
      child.kill("SIGKILL")
      for (const pid of pids) if (running(pid)) { try { process.kill(pid, "SIGKILL") } catch { /* already exited */ } }
      await exited
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test("SIGINT model download orphan is reclaimed by a successful retry", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-sigint-model-"))
  const child = spawn(process.execPath, ["--import", "tsx", downloadChild, dir, "hold"], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  const exited = exitOf(child)
  child.stderr!.resume()
  const originalFetch = globalThis.fetch
  try {
    let partial: string | undefined
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && !partial) {
      for (const name of await readdir(dir)) {
        if (name.includes(`-${child.pid}-`) && name.endsWith(".part") && (await stat(join(dir, name))).size === bytes.length) partial = name
      }
      if (!partial) await pause()
    }
    assert.ok(partial, "real download must create a partial before interruption")
    assert.ok(child.kill("SIGINT"))
    assert.deepEqual(await exited, { code: null, signal: "SIGINT" })
    assert.deepEqual(await readdir(dir), [partial])
    globalThis.fetch = async () => new Response(bytes)
    await ensureModelsIn(dir, [spec])
    assert.deepEqual(await readFile(join(dir, spec.filename)), bytes)
    assert.deepEqual(await readdir(dir), [spec.filename])
  } finally {
    globalThis.fetch = originalFetch
    child.kill("SIGKILL")
    await exited
    await rm(dir, { recursive: true, force: true })
  }
})

test("dead-owner cleanup removes regular partials but preserves symlinks and directories", { skip: process.platform !== "linux" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-partial-filetype-"))
  const departed = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" })
  assert.equal(departed.status, 0, departed.stderr)
  assert.throws(() => process.kill(departed.pid, 0), { code: "ESRCH" })
  const model = join(dir, spec.filename)
  const deadPath = () => modelDownloadPartialPath(model).replace(`-${process.pid}-`, `-${departed.pid}-`)
  const regular = deadPath(), linked = deadPath(), directory = deadPath()
  const target = join(dir, "unrelated-model")
  try {
    await writeFile(regular, "interrupted")
    await writeFile(target, bytes)
    await symlink(target, linked)
    await mkdir(directory)
    await writeFile(join(directory, "sentinel"), "keep")
    await cleanupModelDownloadPartials(model)
    await assert.rejects(lstat(regular), { code: "ENOENT" })
    assert.ok((await lstat(linked)).isSymbolicLink())
    assert.ok((await lstat(directory)).isDirectory())
    assert.deepEqual(await readFile(target), bytes)
    assert.equal(await readFile(join(directory, "sentinel"), "utf8"), "keep")
    assert.deepEqual((await readdir(dir)).sort(), [basename(linked), basename(directory), basename(target)].sort())
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("failed concurrent retry preserves another downloader's valid publication", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-partial-race-"))
  const originalFetch = globalThis.fetch
  let finishFirst!: () => void
  let firstStarted!: () => void
  const started = new Promise<void>(resolve => { firstStarted = resolve })
  let requests = 0
  try {
    await writeFile(join(dir, spec.filename), "corrupt cached model")
    globalThis.fetch = async () => {
      if (++requests > 1) return new Response(bytes)
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from("invalid replacement"))
        let closed = false
        finishFirst = () => { if (!closed) { closed = true; controller.close() } }
        firstStarted()
      } }))
    }
    const bad = ensureModelsIn(dir, [spec])
    const rejected = assert.rejects(bad, /SHA256 mismatch/)
    await started
    await ensureModelsIn(dir, [spec])
    assert.deepEqual(await readFile(join(dir, spec.filename)), bytes)
    finishFirst()
    await rejected
    assert.equal(requests, 2)
    assert.deepEqual(await readFile(join(dir, spec.filename)), bytes)
    assert.deepEqual(await readdir(dir), [spec.filename])
  } finally {
    finishFirst?.()
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})
