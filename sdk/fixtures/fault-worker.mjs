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
 */

import { existsSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

const mode = process.env.KORDOC_FAULT ?? "ok"
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const ok = (id, file) => out({ id, rss: process.memoryUsage.rss(), result: { success: true, fileType: "docx", markdown: `ok:${file}`, blocks: [], pid: process.pid } })

if (mode === "no-ready") setInterval(() => {}, 1 << 30)
else {
  out({ ready: true, version: "0.0.0-fault", protocol: mode === "bad-protocol" ? 1 : 2,
    capabilities: mode === "no-capability" ? [] : ["parse", "options", "transport.images.inline", "transport.images.files"] })
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on("line", async (line) => {
    if (!line.trim()) return
    const req = JSON.parse(line)
    if (req.cmd === "quit") { process.stdout.write("", () => process.exit(0)); return }
    switch (mode) {
      case "hang": return
      case "hang-first": {
        const state = process.env.KORDOC_FAULT_STATE
        if (state && !existsSync(state)) { writeFileSync(state, String(process.pid)); return }
        return ok(req.id, req.file)
      }
      case "exit-on-parse": return process.exit(3)
      case "partial-json": return process.stdout.write('{"id":' + req.id + ',"rss":1,"result":{"succ', () => process.exit(0))
      case "wrong-id": return ok(req.id + 1000, req.file)
      case "stderr-flood": {
        const chunk = "x".repeat(64 * 1024) + "\n"
        for (let i = 0; i < 128; i++) if (!process.stderr.write(chunk)) await new Promise((r) => process.stderr.once("drain", r))
        return ok(req.id, req.file)
      }
      case "slow": return setTimeout(() => ok(req.id, req.file), Number(process.env.KORDOC_FAULT_DELAY_MS ?? 300))
      default: return ok(req.id, req.file)
    }
  })
  rl.on("close", () => process.stdout.write("", () => process.exit(0)))
}
