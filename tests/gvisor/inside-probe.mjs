// CI 전용: `node --import ./tests/gvisor/inside-probe.mjs dist/cli.js ...` 로 띄우면 execArgv 를 따라 샌드박스 안에서도 먼저 돈다.
// 샌드박스 안(KORDOC_SANDBOX_INSIDE=1)에서 격리 신호를 stderr 한 줄로 남긴다. 판정은 tests/gvisor/opt-in.sh 가 한다.
// - gvisor: dmesg 첫 줄 "Starting gVisor..." — gVisor 가 지어낸 커널 로그(pkg/sentry/kernel/syslog.go)
// - network: 바깥 TCP 연결 결과 / write: 호스트 경로에 쓴 파일 — 호스트에서 안 보여야 한다
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { connect } from "node:net"

if (process.env.KORDOC_SANDBOX_INSIDE === "1") {
  let dmesg = ""
  try { dmesg = execFileSync("dmesg", { encoding: "utf8" }) } catch (e) { dmesg = String(e) }
  const network = await new Promise((done) => {
    const s = connect({ host: "1.1.1.1", port: 443, timeout: 3000 }, () => { s.destroy(); done("open") })
    s.on("error", (e) => done(`blocked:${e.code}`))
    s.on("timeout", () => { s.destroy(); done("timeout") })
  })
  if (process.env.PROBE_FILE) writeFileSync(process.env.PROBE_FILE, "inside")
  process.stderr.write(`[probe] ${JSON.stringify({ gvisor: dmesg.includes("Starting gVisor"), network })}\n`)
}
