import { closeSync, createReadStream, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { open } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { z } from "zod"
import { jobErrorCode, jobId, queryOptions, type JobErrorCode, type JobOptions } from "./types.js"

type SqlValue = string | number | null
interface Statement {
  get(...values: SqlValue[]): Record<string, unknown> | undefined
  all(...values: SqlValue[]): Record<string, unknown>[]
  run(...values: SqlValue[]): unknown
}
interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

const row = z.discriminatedUnion("status", [
  z.object({ id: jobId, status: z.literal("queued") }),
  z.object({ id: jobId, status: z.literal("running") }),
  z.object({ id: jobId, status: z.literal("succeeded") }),
  z.object({ id: jobId, status: z.literal("failed"), error: jobErrorCode }),
])
export type Job = z.infer<typeof row>
export type TerminalJob = Extract<Job, { status: "succeeded" | "failed" }>
export type SucceededJob = Extract<TerminalJob, { status: "succeeded" }>

const claim = z.object({ id: jobId, options: z.string().transform((json: string) => queryOptions.parse(JSON.parse(json))), attempts: z.number() })
const duplicate = z.object({ id: jobId, digest: z.string() })
const counts = z.object({ jobs: z.number(), pending: z.number(), pendingBytes: z.number() })
const maxAttempts = 2

export class JobStore {
  private readonly db: Database
  private readonly files: string

  constructor(dataDir: string) {
    const dir = resolve(dataDir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const directory = realpathSync(dir)
    this.files = join(directory, "files")
    // Built-in SQLite is loaded only when the service is requested. Other CLI paths run on Node 20.
    const { DatabaseSync }: { DatabaseSync: new (filename: string) => Database } = createRequire(import.meta.url)("node:sqlite")
    if (process.platform !== "win32" && (statSync(directory).mode & 0o022) !== 0) {
      throw new Error("The service data directory must not be writable by other users.")
    }
    this.db = new DatabaseSync(join(directory, "jobs.sqlite"))
    try {
      // In WAL mode an exclusive connection holds the SQLite lock until close, including between jobs.
      this.db.exec(`
        PRAGMA locking_mode = EXCLUSIVE;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA journal_size_limit = 1048576;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS jobs (
          seq INTEGER PRIMARY KEY,
          id TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
          options TEXT NOT NULL,
          ocr INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          input_bytes INTEGER NOT NULL,
          request_key TEXT UNIQUE,
          digest TEXT NOT NULL,
          finished INTEGER,
          result_bytes INTEGER NOT NULL DEFAULT 0,
          error TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, seq);
        CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(finished) WHERE finished IS NOT NULL;
        COMMIT;
      `)
      mkdirSync(this.files, { mode: 0o700, recursive: true })
      if (!lstatSync(this.files).isDirectory()) throw new Error("The service files directory must be a local directory.")
      this.db.prepare(`
        UPDATE jobs SET status = 'failed', error = 'WORKER_INTERRUPTED', finished = ?
        WHERE status = 'running' AND attempts >= ?
      `).run(Date.now(), maxAttempts)
      this.db.exec("UPDATE jobs SET status = 'queued' WHERE status = 'running'")
      this.cleanOrphans()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  get(id: string) {
    const found = this.db.prepare("SELECT id, status, error FROM jobs WHERE id = ?").get(id)
    return found ? row.parse(found) : undefined
  }

  findKey(key: string) {
    const found = this.db.prepare("SELECT id, digest FROM jobs WHERE request_key = ?").get(key)
    return found ? duplicate.parse(found) : undefined
  }

  counts() {
    return counts.parse(this.db.prepare(`
      SELECT COUNT(*) AS jobs, COUNT(*) FILTER (WHERE finished IS NULL) AS pending,
             COALESCE(SUM(input_bytes) FILTER (WHERE finished IS NULL), 0) AS pendingBytes FROM jobs
    `).get())
  }

  insert(id: string, options: JobOptions, bytes: number, key: string | undefined, digest: string) {
    this.db.prepare(`
      INSERT INTO jobs (id, options, status, ocr, input_bytes, request_key, digest)
      VALUES (?, ?, 'queued', ?, ?, ?, ?)
    `).run(id, JSON.stringify(options), Number(options.ocr !== "false"), bytes, key ?? null, digest)
  }

  claim(allowOcr: boolean) {
    const found = this.db.prepare(`
      UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE seq = (
        SELECT seq FROM jobs WHERE status = 'queued' AND (ocr = 0 OR ? = 1) ORDER BY seq LIMIT 1
      ) RETURNING id, options, attempts
    `).get(Number(allowOcr))
    return found ? claim.parse(found) : undefined
  }

  retryOrFail(job: { id: string; attempts: number }, error: JobErrorCode) {
    if (job.attempts >= maxAttempts) return this.fail(job.id, error)
    this.db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(job.id)
  }

  disableOcr() {
    const failed = this.db.prepare(`
      UPDATE jobs SET status = 'failed', finished = ?, error = 'OCR_DISABLED'
      WHERE status = 'queued' AND ocr = 1 RETURNING id
    `).all(Date.now())
    for (const job of failed) this.removeInput(jobId.parse(job.id))
  }

  retainedBytes(): number {
    return z.number().parse(this.db.prepare("SELECT COALESCE(SUM(result_bytes), 0) AS size FROM jobs").get()?.size)
  }

  succeed(id: string, bytes: number): TerminalJob {
    this.db.prepare("UPDATE jobs SET status = 'succeeded', finished = ?, result_bytes = ? WHERE id = ?")
      .run(Date.now(), bytes, id)
    this.removeInput(id)
    return { id, status: "succeeded" }
  }

  fail(id: string, error: JobErrorCode): TerminalJob {
    this.db.prepare("UPDATE jobs SET status = 'failed', finished = ?, error = ? WHERE id = ?")
      .run(Date.now(), error, id)
    this.removeInput(id)
    return { id, status: "failed", error }
  }

  remove(id: string) {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id)
    rmSync(this.resultPath(id), { force: true })
  }

  prune(ttl: number) {
    const expired = this.db.prepare("DELETE FROM jobs WHERE finished <= ? RETURNING id, status").all(Date.now() - ttl)
    for (const job of expired) {
      if (job.status === "succeeded") rmSync(this.resultPath(jobId.parse(job.id)), { force: true })
    }
  }

  inputPath(id: string): string {
    return join(this.files, id + ".upload")
  }

  openResult(job: SucceededJob) {
    const path = this.resultPath(job.id)
    return createReadStream(path, { fd: openSync(path, "r") })
  }

  private resultPath(id: string): string {
    return join(this.files, id + ".json")
  }

  removeInput(id: string) {
    rmSync(this.inputPath(id), { force: true })
  }

  syncFiles() {
    if (process.platform === "win32") return
    const dir = openSync(this.files, "r")
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }

  async writeResult(id: string, json: string) {
    const path = this.resultPath(id)
    const file = await open(path, "wx", 0o600)
    try {
      try {
        await file.writeFile(json)
        await file.sync()
      } finally {
        await file.close()
      }
      this.syncFiles()
    } catch (error) {
      rmSync(path, { force: true })
      throw error
    }
  }

  close() {
    this.db.close()
  }

  private cleanOrphans() {
    for (const entry of readdirSync(this.files, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = /^([^.]+)\.(upload|json)$/.exec(entry.name)
      if (!file || !jobId.safeParse(file[1]).success) continue
      const job = this.get(file[1])
      if (file[2] === "upload" ? job?.status === "queued" : job?.status === "succeeded") continue
      rmSync(join(this.files, entry.name))
    }
  }
}
