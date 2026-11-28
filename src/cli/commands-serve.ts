import { InvalidArgumentError, type Command } from "commander"
import type { ServeOptions } from "../serve/types.js"

const MiB = 1024 * 1024
const int = (min: number, max = 2_147_483_647) => (value: string): number => {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < min || number > max) {
    throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}.`)
  }
  return number
}

export function registerServeCommand(program: Command): void {
  program.command("serve")
    .description("Serve single-document Markdown parsing over HTTP (Node.js 24.15+)")
    .option("--host <address>", "Bind address (IP address or localhost)", "127.0.0.1")
    .option("--port <port>", "Bind port (0 for an available port)", int(0, 65535), 8787)
    .option("--data-dir <dir>", "Private directory for the queue and its files", ".kordoc-serve")
    .option("--workers <count>", "Maximum concurrent parser workers", int(1, 32), 2)
    .option("--ocr-workers <count>", "Maximum concurrent OCR requests", int(0, 32), 1)
    .option("--max-uploads <count>", "Maximum concurrent uploads", int(1, 1024), 4)
    .option("--max-upload-bytes <bytes>", "Maximum bytes per document", int(1, 500 * MiB), 50 * MiB)
    .option("--max-pending-bytes <bytes>", "Maximum bytes in uploads and pending inputs", int(1, Number.MAX_SAFE_INTEGER), 512 * MiB)
    .option("--max-jobs <count>", "Maximum queued and running jobs, including upload reservations", int(1, 100_000), 1024)
    .option("--max-result-bytes <bytes>", "Maximum bytes per projected JSON result", int(1, 64 * MiB), 16 * MiB)
    .option("--max-retained-bytes <bytes>", "Maximum bytes in completed results", int(1, Number.MAX_SAFE_INTEGER), 512 * MiB)
    .option("--max-retained-jobs <count>", "Maximum job records, including pending jobs", int(1, 100_000), 2048)
    .option("--job-ttl-ms <ms>", "Retention time after a job finishes", int(1), 86_400_000)
    .option("--job-timeout-ms <ms>", "Time limit for each parser attempt", int(1), 120_000)
    .option("--sync-timeout-ms <ms>", "Time limit for a synchronous request to wait for a result", int(1), 15_000)
    .option("--upload-timeout-ms <ms>", "Time limit to receive a document", int(1), 30_000)
    .action(async (options: ServeOptions) => {
      try {
        const { serve } = await import("../serve/server.js")
        await serve(options)
      } catch (error) {
        program.error(`[kordoc] ${error instanceof Error ? error.message : "Service failed"}`)
      }
    })
}
