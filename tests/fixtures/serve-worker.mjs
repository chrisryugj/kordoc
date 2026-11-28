import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

if (process.argv[2] === "parse-worker") {
  const { searchParams } = new URL(import.meta.url)
  const input = createInterface({ input: process.stdin })
  process.once("disconnect", () => process.exit())
  process.stdout.write(JSON.stringify({ ready: true, protocol: 2, capabilities: ["parse"] }) + "\n")
  for await (const line of input) {
    if (JSON.parse(line).cmd !== "parse") process.exit(1)
    appendFileSync(searchParams.get("attempts"), "parse\n")
    if (searchParams.get("mode") === "crash") process.exit(1)
  }
  process.exit(0)
}
