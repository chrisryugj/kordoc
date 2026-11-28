import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { open } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { isIP } from "node:net"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { JobStore, type SucceededJob, type TerminalJob } from "./store.js"
import { jobError, jobId, parserErrorCode, queryOptions, type JobOptions, type ServeOptions } from "./types.js"
import { ParseWorker } from "./worker.js"

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

function capacity() {
  return new HttpError(503, "CAPACITY", "The service is at capacity. Retry later.")
}

function sendJson(res: ServerResponse, status: number, body: unknown, close = false) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(close ? { Connection: "close" } : {}),
  })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, error: HttpError) {
  if (res.destroyed || res.writableEnded) return
  if (error.status === 503) res.setHeader("Retry-After", "1")
  sendJson(res, error.status, { error: { code: error.code, message: error.message } }, true)
}

function isLoopback(host: string) {
  if (host === "localhost" || isIP(host) === 4 && host.startsWith("127.")) return true
  return isIP(host) === 6 && new URL(`http://[${host.split("%", 1)[0]}]`).hostname === "[::1]"
}

function isLoopbackHeader(header: string | undefined) {
  const host = /^([A-Za-z\d.-]+|\[[A-Fa-f\d:]+\])(?::\d{1,5})?$/.exec(header ?? "")?.[1]
  return !!host && isLoopback(host.toLowerCase().replace(/^\[|\]$/g, ""))
}

function checkedOptions(url: URL) {
  const params = Object.fromEntries(url.searchParams)
  if (Object.keys(params).length !== [...url.searchParams].length) {
    throw new HttpError(400, "INVALID_OPTIONS", "Query options must not repeat.")
  }
  const result = queryOptions.safeParse(params)
  if (!result.success) {
    throw new HttpError(400, "INVALID_OPTIONS", "Use only ocr=false|true|force, blocks=false|true, and ascending page ranges.")
  }
  return result.data
}

const sha256 = (value: string) => createHash("sha256").update(value).digest()
const jobUrl = (id: string) => `/v1/jobs/${id}`

export async function serve(options: ServeOptions) {
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (major < 24 || major === 24 && minor < 15) {
    throw new Error("kordoc serve requires Node.js 24.15.0 or later.")
  }

  const host = options.host.toLowerCase() === "localhost" ? "127.0.0.1" : options.host
  if (!isIP(host)) throw new Error("--host must be an IP address or localhost.")
  const loopback = isLoopback(host)
  const token = process.env.KORDOC_SERVE_TOKEN
  if (!token && !loopback) throw new Error("Set KORDOC_SERVE_TOKEN before binding to a non-loopback address.")
  if (token && (token.length > 4096 || !/^[A-Za-z\d._~+/-]+=*$/.test(token))) {
    throw new Error("KORDOC_SERVE_TOKEN must be a valid bearer token.")
  }

  const service = new ParseService({ ...options, host }, loopback, token ? sha256(token) : undefined)
  await service.run()
}

type WorkerSlot = { worker: ParseWorker; task?: Promise<void> }
type ClaimedJob = NonNullable<ReturnType<JobStore["claim"]>>

class ParseService {
  private readonly store: JobStore
  private readonly slots: WorkerSlot[]
  private readonly ocrLimit: number
  private readonly waiters = new Map<string, (job: TerminalJob) => void>()
  private readonly requests = new Set<Promise<void>>()
  private readonly server = createServer({ headersTimeout: 10_000, requestTimeout: 0, connectionsCheckingInterval: 1_000 })
  private stop = (_error?: Error) => {}
  private stopping = false
  private uploads = 0
  private reservedInputs = 0
  private reservedInputBytes = 0
  private reservedResultBytes = 0
  private runningOcr = 0

  constructor(private readonly options: ServeOptions, private readonly loopback: boolean, private readonly tokenHash?: Buffer) {
    this.store = new JobStore(options.dataDir)
    this.slots = Array.from({ length: options.workers }, () => ({
      worker: new ParseWorker(options.jobTimeoutMs, options.maxResultBytes),
    }))
    this.ocrLimit = Math.min(options.ocrWorkers, Math.max(1, options.workers - 1))
    this.server.maxConnections = Math.max(128, options.maxUploads + options.maxJobs + 32)
    this.server.setTimeout(60_000)
    this.server.on("request", this.receive)
    this.server.on("checkContinue", this.receive)
  }

  async run() {
    const stop = new Promise<Error | undefined>(resolve => { this.stop = resolve })
    const onSignal = () => this.halt()
    let expiry: NodeJS.Timeout | undefined
    try {
      this.store.prune(this.options.jobTtlMs)
      if (!this.ocrLimit) this.store.disableOcr()
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject)
        this.server.listen(this.options.port, this.options.host, () => {
          this.server.off("error", reject)
          this.server.on("error", error => this.halt(error))
          resolve()
        })
      })
      process.on("SIGINT", onSignal)
      process.on("SIGTERM", onSignal)
      const address = this.server.address()
      if (!address || typeof address === "string") throw new Error("Could not determine server address.")
      const host = isIP(address.address) === 6 ? `[${address.address}]` : address.address
      process.stderr.write(`[kordoc] Listening on http://${host}:${address.port}\n`)
      expiry = setInterval(() => {
        try { this.store.prune(this.options.jobTtlMs) } catch (error) { this.halt(error) }
      }, Math.min(60_000, Math.max(1_000, this.options.jobTtlMs)))
      this.pump()
      const error = await stop
      if (error) throw error
    } finally {
      this.stopping = true
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      clearInterval(expiry)
      this.server.close()
      this.server.closeAllConnections()
      await Promise.allSettled([
        ...this.requests, ...this.slots.flatMap(slot => [slot.task, slot.worker.retire()]),
      ])
      this.store.close()
    }
  }

  private halt(error?: unknown) {
    if (this.stopping) return
    this.stopping = true
    this.stop(error === undefined ? undefined : error instanceof Error ? error : new Error("Service failed."))
  }

  private receive = (req: IncomingMessage, res: ServerResponse) => {
    res.on("timeout", () => {
      if (res.headersSent) res.destroy()
    })
    const task = this.route(req, res).catch(error => {
      if (res.headersSent) res.destroy()
      else if (error instanceof HttpError) sendError(res, error)
      else sendError(res, new HttpError(500, "INTERNAL_ERROR", "The service could not complete the request."))
      if (!(error instanceof HttpError)) this.halt(error)
    }).finally(() => this.requests.delete(task))
    this.requests.add(task)
  }

  private authorize(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.origin !== undefined || this.loopback && !isLoopbackHeader(req.headers.host)) {
      throw new HttpError(403, "FORBIDDEN", "Browser origins and non-loopback Host headers on a loopback listener are forbidden.")
    }
    if (!this.tokenHash) return
    const token = /^Bearer (\S{1,4096})$/i.exec(req.headers.authorization ?? "")?.[1]
    if (!token || !timingSafeEqual(this.tokenHash, sha256(token))) {
      res.setHeader("WWW-Authenticate", "Bearer")
      throw new HttpError(401, "UNAUTHORIZED", "A valid bearer token is required.")
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    this.authorize(req, res)
    if (this.stopping) throw capacity()
    if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) {
      throw new HttpError(400, "INVALID_REQUEST", "The request target must be a local path.")
    }
    const url = new URL(req.url, "http://localhost")
    const sync = url.pathname === "/v1/parse"
    if (req.method === "POST" && (sync || url.pathname === "/v1/jobs")) {
      const options = checkedOptions(url)
      if (options.ocr !== "false" && !this.ocrLimit) {
        throw new HttpError(400, "OCR_DISABLED", "OCR is disabled on this service.")
      }
      const id = await this.submit(req, res, options, sync)
      if (!sync) {
        res.setHeader("Location", jobUrl(id))
        sendJson(res, 202, { jobId: id })
        return
      }

      const job = await this.waitForJob(id, res)
      if (res.destroyed) return
      if (!job) {
        res.setHeader("Location", jobUrl(id))
        sendJson(res, 504, { jobId: id, error: { code: "WAIT_TIMEOUT", message: "The job is still processing." } })
        return
      }
      try {
        if (job.status === "failed") {
          let status = 500
          if (job.error === "WORKER_TIMEOUT") status = 504
          else if (parserErrorCode.safeParse(job.error).success && job.error !== "FILE_NOT_FOUND") status = 422
          sendJson(res, status, { error: jobError(job.error) })
        } else await this.sendResult(res, job, false)
      } finally {
        this.store.remove(id)
      }
      return
    }

    const jobsPrefix = "/v1/jobs/"
    const id = url.pathname.startsWith(jobsPrefix) ? jobId.safeParse(url.pathname.slice(jobsPrefix.length)) : undefined
    if (req.method === "GET" && id?.success) {
      if (url.search) throw new HttpError(400, "INVALID_OPTIONS", "Job lookups do not accept query options.")
      this.store.prune(this.options.jobTtlMs)
      const job = this.store.get(id.data)
      if (job?.status === "succeeded") await this.sendResult(res, job, true)
      else if (job) {
        sendJson(res, 200, {
          jobId: job.id, status: job.status, ...(job.status === "failed" ? { error: jobError(job.error) } : {}),
        })
      } else throw new HttpError(404, "NOT_FOUND", "Job not found.")
      return
    }

    if (sync || url.pathname === "/v1/jobs" || id?.success) {
      res.setHeader("Allow", id?.success ? "GET" : "POST")
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed for this endpoint.")
    }
    throw new HttpError(404, "NOT_FOUND", "Endpoint not found.")
  }

  private async submit(req: IncomingMessage, res: ServerResponse, options: JobOptions, sync: boolean) {
    if (req.headers["content-type"]?.trim().toLowerCase() !== "application/octet-stream" || req.headers["content-encoding"] !== undefined) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send raw document bytes as application/octet-stream.")
    }
    const rawKey = req.headers["idempotency-key"]
    if (rawKey !== undefined && (sync || typeof rawKey !== "string" || !/^[\x21-\x2B\x2D-\x7E]{1,128}$/.test(rawKey))) {
      throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY", "Use a single printable Idempotency-Key on POST /v1/jobs.")
    }
    const length = req.headers["content-length"] === undefined ? undefined : Number(req.headers["content-length"])
    const tooLarge = () => new HttpError(413, "UPLOAD_TOO_LARGE", "The document exceeds the upload size limit.")
    if (length !== undefined && length > this.options.maxUploadBytes) throw tooLarge()
    if (this.uploads >= this.options.maxUploads) throw capacity()

    this.store.prune(this.options.jobTtlMs)
    const existing = rawKey ? this.store.findKey(rawKey) : undefined
    const id = existing?.id ?? randomUUID()
    let reserved = 0
    const reserveBytes = (bytes: number) => {
      if (this.store.counts().pendingBytes + this.reservedInputBytes + bytes > this.options.maxPendingBytes) throw capacity()
      this.reservedInputBytes += bytes
      reserved += bytes
    }
    if (!existing) {
      const { jobs, pending } = this.store.counts()
      if (jobs + this.reservedInputs >= this.options.maxRetainedJobs ||
          pending + this.reservedInputs >= this.options.maxJobs) throw capacity()
      if (length !== undefined) reserveBytes(length)
      this.reservedInputs++
    }

    this.uploads++
    let inserted = false
    let ownsFile = false
    const timer = setTimeout(() => {
      if (!req.complete) res.once("finish", () => req.destroy())
      sendError(res, new HttpError(408, "UPLOAD_TIMEOUT", "The upload exceeded its time limit."))
    }, this.options.uploadTimeoutMs)
    try {
      const file = existing ? undefined : await open(this.store.inputPath(id), "wx", 0o600)
      ownsFile = file !== undefined
      const hash = createHash("sha256").update(JSON.stringify(options)).update("\0")
      let size = 0
      try {
        if (req.headers.expect?.toLowerCase() === "100-continue" && !res.writableEnded) res.writeContinue()
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected upload stream encoding.")
          if (res.writableEnded) throw new HttpError(408, "UPLOAD_TIMEOUT", "The upload exceeded its time limit.")
          size += chunk.length
          if (size > this.options.maxUploadBytes) throw tooLarge()
          if (file && size > reserved) reserveBytes(size - reserved)
          hash.update(chunk)
          await file?.writeFile(chunk)
        }
        if (!req.complete || res.writableEnded || this.stopping) {
          throw new HttpError(400, "INCOMPLETE_UPLOAD", "The upload did not complete.")
        }
        clearTimeout(timer)
        if (size === 0) throw new HttpError(400, "EMPTY_UPLOAD", "Send a document in the request body.")
        await file?.sync()
      } catch (error) {
        if (req.aborted || req.destroyed && !req.complete) {
          throw new HttpError(400, "INCOMPLETE_UPLOAD", "The upload did not complete.")
        }
        throw error
      } finally {
        await file?.close()
      }

      const digest = hash.digest("hex")
      const duplicate = rawKey ? this.store.findKey(rawKey) : undefined
      if (existing && !duplicate) throw new HttpError(503, "RETRY_UPLOAD", "The original job expired. Retry the upload.")
      if (duplicate) {
        if (duplicate.digest !== digest) {
          throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This key was used with different document bytes or options.")
        }
        return duplicate.id
      }
      if (this.stopping) throw capacity()
      this.store.syncFiles()
      this.store.insert(id, options, size, rawKey, digest)
      inserted = true
      this.pump()
      return id
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOSPC" || error.code === "EDQUOT")) {
        throw capacity()
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (ownsFile && !inserted) this.store.removeInput(id)
      this.uploads--
      this.reservedInputBytes -= reserved
      if (!existing) this.reservedInputs--
    }
  }

  private waitForJob(id: string, res: ServerResponse): Promise<TerminalJob | undefined> {
    const job = this.store.get(id)
    if (job?.status === "succeeded" || job?.status === "failed") return Promise.resolve(job)
    if (res.destroyed) return Promise.resolve(undefined)
    return new Promise(resolve => {
      const finish = (job?: TerminalJob) => {
        clearTimeout(timer)
        res.off("close", disconnected)
        this.waiters.delete(id)
        resolve(job)
      }
      const disconnected = () => finish()
      const timer = setTimeout(disconnected, this.options.syncTimeoutMs)
      this.waiters.set(id, finish)
      res.once("close", disconnected)
    })
  }

  private async sendResult(res: ServerResponse, job: SucceededJob, wrapped: boolean) {
    let result: ReturnType<JobStore["openResult"]>
    try {
      result = this.store.openResult(job)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new HttpError(404, "NOT_FOUND", "Job result not found.")
      }
      throw error
    }
    try {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      if (wrapped) {
        const envelope = async function* () {
          yield `{"jobId":"${job.id}","status":"succeeded","result":`
          yield* result
          yield "}"
        }
        await pipeline(Readable.from(envelope()), res)
      } else await pipeline(result, res)
    } catch (error) {
      if (!(error instanceof Error && "code" in error &&
          (error.code === "ERR_STREAM_PREMATURE_CLOSE" || error.code === "ECONNRESET" || error.code === "EPIPE"))) throw error
    } finally {
      result.destroy()
    }
  }

  private pump() {
    if (this.stopping) return
    try {
      for (const slot of this.slots) {
        if (slot.task) continue
        const job = this.store.claim(this.runningOcr < this.ocrLimit)
        if (!job) break
        const ocr = job.options.ocr !== "false"
        if (ocr) this.runningOcr++
        slot.task = this.runJob(slot.worker, job).catch(error => this.halt(error)).finally(() => {
          if (ocr) this.runningOcr--
          slot.task = undefined
          this.pump()
        })
      }
    } catch (error) { this.halt(error) }
  }

  private async runJob(worker: ParseWorker, job: ClaimedJob) {
    const outcome = await worker.run(this.store.inputPath(job.id), job.options)
    if (this.stopping) return
    let terminal: TerminalJob | undefined
    switch (outcome.kind) {
      case "retry": terminal = this.store.retryOrFail(job, outcome.error); break
      case "failure": terminal = this.store.fail(job.id, outcome.error); break
      case "success": terminal = await this.saveResult(job.id, outcome.json); break
      default: throw new Error("Unexpected parser outcome", { cause: outcome satisfies never })
    }
    if (terminal) this.waiters.get(job.id)?.(terminal)
  }

  private async saveResult(id: string, json: string): Promise<TerminalJob> {
    const size = Buffer.byteLength(json)
    if (size > this.options.maxResultBytes) return this.store.fail(id, "RESULT_TOO_LARGE")
    this.store.prune(this.options.jobTtlMs)
    if (size + this.reservedResultBytes + this.store.retainedBytes() > this.options.maxRetainedBytes) {
      return this.store.fail(id, "RESULT_CAPACITY")
    }
    this.reservedResultBytes += size
    try {
      try {
        await this.store.writeResult(id, json)
      } catch {
        return this.store.fail(id, "RESULT_STORAGE_FAILED")
      }
      return this.store.succeed(id, size)
    } finally {
      this.reservedResultBytes -= size
    }
  }
}
