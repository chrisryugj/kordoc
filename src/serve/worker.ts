import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import type { Writable } from "node:stream"
import { z } from "zod"
import type { FileType } from "../types.js"
import { parserErrorCode, type JobErrorCode, type JobOptions } from "./types.js"

const fileType = z.enum({
  hwpx: "hwpx", hwp: "hwp", hwp3: "hwp3", hwpml: "hwpml", pdf: "pdf",
  xlsx: "xlsx", xls: "xls", docx: "docx", pptx: "pptx", image: "image", unknown: "unknown",
} satisfies { [Kind in FileType]: Kind })

const ready = z.object({ ready: z.literal(true), protocol: z.literal(2), capabilities: z.array(z.string()) })
const answer = z.union([
  z.object({ id: z.number(), result: z.discriminatedUnion("success", [
    z.object({
      success: z.literal(true), markdown: z.string(), fileType,
      warnings: z.array(z.unknown()).optional(), blocks: z.array(z.unknown()),
    }),
    z.object({ success: z.literal(false), code: z.string().optional() }),
  ]) }),
  z.object({ id: z.number(), error: z.object({ code: z.string() }) }),
])

type Outcome =
  | { kind: "success"; json: string }
  | { kind: "failure"; error: JobErrorCode }
  | { kind: "retry"; error: JobErrorCode }

type WorkerConnection = {
  child: ChildProcess
  stdin: Writable
  closed: Promise<void>
  lines: AsyncIterator<string>
  lastId: number
}

const inherited = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "NODE_OPTIONS", "NODE_PATH",
  "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "XDG_CACHE_HOME",
  "KORDOC_MODEL_CACHE", "KORDOC_MAX_UNZIP_MB", "KORDOC_ROOT",
])
class WorkerTimeout extends Error {}

export class ParseWorker {
  private connection?: WorkerConnection
  private readonly wireLimit: number

  constructor(private readonly timeoutMs: number, resultLimit: number) {
    this.wireLimit = Math.max(16 * 1024 * 1024, resultLimit * 2)
  }

  async run(file: string, options: JobOptions): Promise<Outcome> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new WorkerTimeout()), this.timeoutMs)
    })
    try {
      const outcome = await Promise.race([this.exchange(file, options), timeout])
      // Protocol 2 tracks seen IDs, so recycle workers after a bounded number of requests.
      if (this.connection?.lastId === 4_096) await this.retire()
      return outcome
    } catch (error) {
      await this.retire()
      return { kind: "retry", error: error instanceof WorkerTimeout ? "WORKER_TIMEOUT" : "WORKER_FAILED" }
    } finally {
      clearTimeout(timer)
    }
  }

  async retire() {
    const connection = this.connection
    if (!connection) return
    connection.child.kill("SIGKILL")
    await connection.closed
  }

  private start(): WorkerConnection {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key.toUpperCase())))
    const child = spawn(process.execPath, [
      ...process.execArgv, process.argv[1], "parse-worker", "--protocol", "2", "--max-response-bytes", String(this.wireLimit),
    ], { stdio: ["pipe", "pipe", "ignore", "ipc"], env: { ...env, KORDOC_OFFLINE: "1", KORDOC_NO_HANCOM: "1" }, windowsHide: true })
    child.on("error", () => {})
    const { stdin, stdout } = child
    if (!stdin || !stdout) {
      child.kill("SIGKILL")
      throw new Error("Could not open worker pipes")
    }
    stdin.on("error", () => {})
    const reader = createInterface({ input: stdout, crlfDelay: Infinity })
    stdout.on("error", () => reader.close())
    const closed = new Promise<void>(resolve => child.once("close", () => {
      reader.close()
      if (this.connection?.child === child) this.connection = undefined
      resolve()
    }))
    let bytes = 0
    stdout.on("data", (chunk: Buffer) => {
      const newline = chunk.indexOf(10)
      if (bytes + (newline === -1 ? chunk.length : newline) > this.wireLimit) child.kill("SIGKILL")
      bytes = newline === -1 ? bytes + chunk.length : chunk.length - chunk.lastIndexOf(10) - 1
    })
    const connection = { child, stdin, closed, lines: reader[Symbol.asyncIterator](), lastId: 0 }
    this.connection = connection
    return connection
  }

  private async exchange(file: string, options: JobOptions): Promise<Outcome> {
    const connection = this.connection ?? this.start()
    const next = async () => {
      const frame = await connection.lines.next()
      if (frame.done || Buffer.byteLength(frame.value) > this.wireLimit) throw new Error("Invalid worker frame")
      const value: unknown = JSON.parse(frame.value)
      return value
    }

    if (connection.lastId === 0) {
      const hello = ready.parse(await next())
      if (!hello.capabilities.includes("parse")) throw new Error("Worker lacks parse capability")
    }
    const id = ++connection.lastId
    const request = JSON.stringify({
      id, cmd: "parse", file,
      options: {
        images: false,
        ocr: options.ocr === "force" ? "force" : options.ocr === "true",
        pages: options.pages,
      },
    })
    await new Promise<void>((resolve, reject) => {
      connection.stdin.write(request + "\n", error => error ? reject(error) : resolve())
    })
    const message = answer.parse(await next())
    if (message.id !== id) throw new Error("Unexpected worker response ID")
    if ("error" in message) {
      if (message.error.code === "RESPONSE_TOO_LARGE") return { kind: "failure", error: "RESULT_TOO_LARGE" }
      throw new Error("Invalid worker response")
    }
    if (!message.result.success) {
      const code = parserErrorCode.safeParse(message.result.code)
      return { kind: "failure", error: code.success ? code.data : "PARSE_ERROR" }
    }
    const { markdown, fileType, warnings, blocks } = message.result
    const json = JSON.stringify({ markdown, fileType, warnings: warnings ?? [], ...(options.blocks === "true" ? { blocks } : {}) })
    return { kind: "success", json }
  }
}
