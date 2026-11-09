import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runscArgs } from "../src/shared/sandbox.js"

const linuxOnly = { skip: process.platform !== "linux" }

const cli = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env: { ...process.env, ...env }, encoding: "utf8", input: "" })

describe("gVisor 샌드박스 (KORDOC_SANDBOX=gvisor)", () => {
  it("runsc 는 네트워크를 끄고 do 로 같은 명령을 다시 실행한다", () => {
    assert.deepEqual(runscArgs(["node", "cli.js", "a.hwpx"], true), ["--network=none", "do", "--quiet", "--", "node", "cli.js", "a.hwpx"])
  })

  it("root 가 아니면 rootless(호스트 네트워크) 대신 오류", () => {
    assert.throws(() => runscArgs(["node"], false), /root/)
  })

  it("켜져 있는데 띄울 수 없으면 격리 없이 계속하지 않고 오류로 멈춘다", linuxOnly, () => {
    const r = cli(["tests/fixtures/dummy.hwpx"], { KORDOC_SANDBOX: "gvisor", KORDOC_RUNSC: "/nonexistent/runsc" })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /gVisor/)
    assert.equal(r.stdout, "")
  })

  it("파일을 쓰는 명령·옵션은 결과가 사라지므로 오류로 멈춘다", linuxOnly, () => {
    for (const args of [["a.hwpx", "-o", "a.md"], ["a.hwpx", "--out-dir=out"], ["to-hwpx", "a.hwp"]]) {
      const r = cli(args, { KORDOC_SANDBOX: "gvisor" })
      assert.equal(r.status, 1, args.join(" "))
      assert.match(r.stderr, /표준 출력/)
    }
  })

  it("MCP 서버도 격리 없이 돌지 않고 오류로 멈춘다", linuxOnly, () => {
    for (const r of [cli(["mcp"], { KORDOC_SANDBOX: "gvisor" }),
      spawnSync(process.execPath, ["--import", "tsx", "src/mcp.ts"], { env: { ...process.env, KORDOC_SANDBOX: "gvisor" }, encoding: "utf8", input: "" })]) {
      assert.equal(r.status, 1)
      assert.match(r.stderr, /표준 출력/)
    }
  })

  it("지원하지 않는 값은 오류", () => {
    const r = cli(["--version"], { KORDOC_SANDBOX: "docker" })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /gvisor 만/)
  })

  it("샌드박스 안의 parse-worker 는 files 전송을 알리지 않고 거절한다", () => {
    const req = JSON.stringify({ id: 1, cmd: "parse", file: process.cwd() + "/tests/fixtures/dummy.hwpx", transport: { images: "files", assetsDir: process.cwd() } })
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "parse-worker", "--protocol", "2"], {
      env: { ...process.env, KORDOC_SANDBOX: "gvisor", KORDOC_SANDBOX_INSIDE: "1" }, encoding: "utf8", input: req + "\n" + '{"cmd":"quit"}\n',
    })
    const [ready, res] = r.stdout.trim().split("\n").map((l) => JSON.parse(l))
    assert.ok(!ready.capabilities.includes("transport.images.files"))
    assert.equal(res.error.code, "INVALID_REQUEST")
  })

  it("macOS·Windows 에서는 경고만 내고 그대로 실행한다", { skip: process.platform === "linux" }, () => {
    for (const args of [["tests/fixtures/dummy.hwpx"], ["tests/fixtures/dummy.hwpx", "-o", join(tmpdir(), "kordoc-sandbox-test.md")]]) {
      const r = cli(args, { KORDOC_SANDBOX: "gvisor" })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stderr, /Linux 에서만 동작/)
    }
  })

  it("꺼 두면 그대로 실행한다", () => {
    const env = { ...process.env }
    delete env.KORDOC_SANDBOX
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], { env, encoding: "utf8" })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /\d+\.\d+\.\d+/)
  })
})
