import { appendFileSync, existsSync } from "node:fs"
import { Server } from "node:http"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"

const { searchParams } = new URL(import.meta.url)
const socketTimeoutMs = Number(searchParams.get("socketTimeoutMs"))
if (process.argv[2] === "serve" && socketTimeoutMs) {
  const { setTimeout } = Server.prototype
  Server.prototype.setTimeout = function (_milliseconds, callback) {
    return setTimeout.call(this, socketTimeoutMs, callback)
  }
}

if (process.argv[2] === "parse-worker") {
  const input = createInterface({ input: process.stdin })
  process.once("disconnect", () => process.exit())
  process.stdout.write(JSON.stringify({ ready: true, protocol: 2, capabilities: ["parse"] }) + "\n")
  for await (const line of input) {
    const { id, cmd } = JSON.parse(line)
    if (cmd !== "parse") process.exit(1)
    appendFileSync(searchParams.get("attempts"), "parse\n")
    const mode = searchParams.get("mode")
    if (mode === "crash") process.exit(1)
    if (mode === "gate-second") {
      if (id === 2) {
        while (!existsSync(searchParams.get("release"))) await delay(10)
      }
      const result = { success: true, fileType: "hwpx", markdown: `result ${id}`, warnings: [], blocks: [] }
      process.stdout.write(JSON.stringify({ id, result }) + "\n")
    }
  }
  process.exit(0)
}
