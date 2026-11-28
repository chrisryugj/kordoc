import { z } from "zod"
import type { ErrorCode } from "../types.js"

const pages = z.string().max(256)
  .regex(/^[1-9]\d{0,5}(?:-[1-9]\d{0,5})?(?:,[1-9]\d{0,5}(?:-[1-9]\d{0,5})?)*$/)
  .refine(value => value.split(",").every(part => {
    const [start, end] = part.split("-")
    return end === undefined || Number(start) <= Number(end)
  }))

export const queryOptions = z.strictObject({
  ocr: z.enum(["false", "true", "force"]).default("false"),
  blocks: z.enum(["false", "true"]).default("false"),
  pages: pages.optional(),
})

export type JobOptions = z.infer<typeof queryOptions>

export interface ServeOptions {
  host: string
  port: number
  dataDir: string
  workers: number
  ocrWorkers: number
  maxUploads: number
  maxUploadBytes: number
  maxPendingBytes: number
  maxJobs: number
  maxResultBytes: number
  maxRetainedBytes: number
  maxRetainedJobs: number
  jobTtlMs: number
  jobTimeoutMs: number
  syncTimeoutMs: number
  uploadTimeoutMs: number
}

export const jobId = z.uuidv4()

const parserErrors = [
  "EMPTY_INPUT", "UNSUPPORTED_FORMAT", "ENCRYPTED", "DRM_PROTECTED", "CORRUPTED",
  "DECOMPRESSION_BOMB", "ZIP_BOMB", "IMAGE_BASED_PDF", "NO_SECTIONS", "PARSE_ERROR",
  "MISSING_DEPENDENCY", "OUTPUT_TOO_LARGE", "FILE_NOT_FOUND",
] satisfies ErrorCode[]
export const parserErrorCode = z.enum(parserErrors)
export const jobErrorCode = z.enum([
  ...parserErrors, "WORKER_FAILED", "WORKER_TIMEOUT", "WORKER_INTERRUPTED",
  "RESULT_TOO_LARGE", "RESULT_CAPACITY", "RESULT_STORAGE_FAILED", "OCR_DISABLED",
])
export type JobErrorCode = z.infer<typeof jobErrorCode>

const jobErrors = {
  OCR_DISABLED: "OCR is disabled on this service.",
  EMPTY_INPUT: "The document is empty.",
  UNSUPPORTED_FORMAT: "The document format is unsupported.",
  ENCRYPTED: "The document is encrypted.",
  DRM_PROTECTED: "The document is protected by DRM.",
  CORRUPTED: "The document is corrupt.",
  DECOMPRESSION_BOMB: "Document decompression exceeded parser limits.",
  ZIP_BOMB: "Document decompression exceeded parser limits.",
  IMAGE_BASED_PDF: "The PDF contains image-based pages that require OCR.",
  NO_SECTIONS: "The document does not contain any parseable sections.",
  PARSE_ERROR: "The document could not be parsed.",
  MISSING_DEPENDENCY: "The parser dependency required by this document is unavailable.",
  OUTPUT_TOO_LARGE: "The parse result exceeds the parser's size limit.",
  FILE_NOT_FOUND: "The uploaded document is unavailable.",
  WORKER_FAILED: "The parser process exited or produced an invalid response.",
  WORKER_TIMEOUT: "The parser attempt exceeded its time limit.",
  WORKER_INTERRUPTED: "The parser attempt was interrupted by a service restart.",
  RESULT_TOO_LARGE: "The parse result exceeds its size limit.",
  RESULT_CAPACITY: "There is no room to retain the parse result.",
  RESULT_STORAGE_FAILED: "The parse result could not be saved.",
} satisfies Record<JobErrorCode, string>

export function jobError(code: JobErrorCode) {
  return { code, message: jobErrors[code] }
}
