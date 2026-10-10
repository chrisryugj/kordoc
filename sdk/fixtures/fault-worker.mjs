#!/usr/bin/env node
/**
 * SDK 장애 주입용 가짜 parse-worker — 실제 파싱 대신 정해진 방식으로 잘못 동작한다(SDK 테스트 전용, 배포물 아님).
 * SDK 가 `node <이 파일> parse-worker --protocol 2 …` 로 띄운다. 동작은 환경변수 KORDOC_FAULT 로 고른다.
 *
 *   ok             정상 handshake, parse 마다 {"success":true,"markdown":"ok:<file>"} (기본)
 *   no-ready       ready 를 쓰지 않고 멈춘다
 *   bad-protocol   ready 에 protocol 1 을 쓴다
 *   no-capability  ready 의 capabilities 가 비어 있다
 *   hang           parse 요청을 받고 응답하지 않는다
 *   hang-first     KORDOC_FAULT_STATE 파일이 없으면 만들고 멈추고, 있으면 ok 처럼 답한다 (교체 뒤 다음 요청 성공)
 *   exit-on-parse  parse 요청을 받으면 응답 없이 종료 코드 3 으로 끝난다
 *   partial-json   parse 요청에 JSON 절반을 쓰고 종료한다
 *   wrong-id       다른 id 로 답한다
 *   stderr-flood   parse 마다 stderr 에 8MiB 를 쓴 뒤 답한다
 *   slow           parse 마다 KORDOC_FAULT_DELAY_MS(기본 300) 뒤에 답한다
 *   by-file        요청 파일 이름으로 고른다 — "hang" 이 들어 있으면 응답하지 않고, "crash" 면 종료 코드 3 으로 끝나고
 *                  (KORDOC_FAULT_STATE 를 주면 그 파일이 있을 때만), "slow" 면 KORDOC_FAULT_DELAY_MS 뒤에 답하고, 나머지는 ok
 *   no-quit        quit 요청과 stdin 닫힘을 무시하고 계속 산다 (kill 로만 끝난다). parse 는 ok 처럼 답한다
 *   exit-hold-stderr
 *                  parse 요청을 받으면 stderr 를 물려받은 손자 프로세스를 KORDOC_FAULT_DELAY_MS(기본 3000) 동안 남기고
 *                  종료 코드 3 으로 끝난다 (워커가 끝나도 stderr 파이프가 닫히지 않는다)
 *
 * 모든 모드 공통:
 *   KORDOC_FAULT_READY_DELAY_MS  ready 를 이만큼 늦게 쓴다. KORDOC_FAULT_READY_STATE 를 함께 주면 그 파일이 없을 때는
 *                                만들고 바로 ready 를 쓰고, 있을 때만 늦춘다 (처음 워커는 바로, 교체 워커만 늦게)
 */

import { spawn } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

const mode = process.env.KORDOC_FAULT ?? "ok"
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const ok = (id, file) => out({ id, rss: process.memoryUsage.rss(), result: { success: true, fileType: "docx", markdown: `ok:${file}`, blocks: [], pid: process.pid } })

const readyDelay = Number(process.env.KORDOC_FAULT_READY_DELAY_MS ?? 0)
const readyState = process.env.KORDOC_FAULT_READY_STATE
if (readyState && !existsSync(readyState)) writeFileSync(readyState, String(process.pid))
else if (readyDelay) await new Promise((r) => setTimeout(r, readyDelay))

if (mode === "no-ready") setInterval(() => {}, 1 << 30)
else {
  out({ ready: true, version: "0.0.0-fault", protocol: mode === "bad-protocol" ? 1 : 2,
    capabilities: mode === "no-capability" ? [] : ["parse", "options", "transport.images.inline", "transport.images.files"] })
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on("line", async (line) => {
    if (!line.trim()) return
    const req = JSON.parse(line)
    if (req.cmd === "quit") { if (mode !== "no-quit") process.stdout.write("", () => process.exit(0)); return }
    switch (mode) {
      case "hang": return
      case "hang-first": {
        const state = process.env.KORDOC_FAULT_STATE
        if (state && !existsSync(state)) { writeFileSync(state, String(process.pid)); return }
        return ok(req.id, req.file)
      }
      case "exit-on-parse": return process.exit(3)
      case "exit-hold-stderr": {
        const hold = Number(process.env.KORDOC_FAULT_DELAY_MS ?? 3000)
        spawn(process.execPath, ["-e", `setTimeout(() => {}, ${hold})`], { stdio: ["ignore", "ignore", "inherit"], detached: true }).unref()
        return process.exit(3)
      }
      case "partial-json": return process.stdout.write('{"id":' + req.id + ',"rss":1,"result":{"succ', () => process.exit(0))
      case "wrong-id": return ok(req.id + 1000, req.file)
      case "stderr-flood": {
        const chunk = "x".repeat(64 * 1024) + "\n"
        for (let i = 0; i < 128; i++) if (!process.stderr.write(chunk)) await new Promise((r) => process.stderr.once("drain", r))
        return ok(req.id, req.file)
      }
      case "slow": return setTimeout(() => ok(req.id, req.file), Number(process.env.KORDOC_FAULT_DELAY_MS ?? 300))
      case "by-file": {
        const name = String(req.file).split(/[\\/]/).pop()
        if (name.includes("hang")) return
        if (name.includes("crash") && (!process.env.KORDOC_FAULT_STATE || existsSync(process.env.KORDOC_FAULT_STATE))) return process.exit(3)
        if (name.includes("slow")) return setTimeout(() => ok(req.id, req.file), Number(process.env.KORDOC_FAULT_DELAY_MS ?? 300))
        return ok(req.id, req.file)
      }
      default: return ok(req.id, req.file)
    }
  })
  rl.on("close", () => mode === "no-quit" ? setInterval(() => {}, 1 << 30) : process.stdout.write("", () => process.exit(0)))
}
