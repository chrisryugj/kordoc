/** 모델 오프라인 사이드로드 — 반입 매체가 오염돼도 캐시에 설치되지 않아야 한다.
 *  (폐쇄망 배포 v4.7.2: SHA-256 스펙이 SSOT, 별도 manifest 없음) */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_GROUPS, importModels, modelCacheStatus } from "../src/shared/model-bundle.js"

const cache = mkdtempSync(join(tmpdir(), "kordoc-cache-"))
const bundle = mkdtempSync(join(tmpdir(), "kordoc-bundle-"))
let savedCache: string | undefined

before(() => {
  savedCache = process.env.KORDOC_MODEL_CACHE
  process.env.KORDOC_MODEL_CACHE = cache
})
after(() => {
  if (savedCache === undefined) delete process.env.KORDOC_MODEL_CACHE
  else process.env.KORDOC_MODEL_CACHE = savedCache
})

describe("모델 사이드로드", () => {
  it("모델군은 텍스트 OCR·수식 OCR 두 갈래이고 캐시 하위 디렉토리 이름이 곧 번들 경로", () => {
    assert.deepEqual(MODEL_GROUPS.map((g) => g.subdir), ["ppocr", "pix2text"])
  })

  it("번들이 비어 있으면 전부 missing 으로 보고하고 실패 처리한다", async () => {
    const result = await importModels(bundle)
    assert.equal(result.ok, false)
    assert.ok(result.files.length > 0)
    assert.ok(result.files.every((f) => f.status === "missing"))
  })

  it("SHA 불일치 파일은 invalid 로 거부되고 캐시에 복사되지 않는다", async () => {
    const group = MODEL_GROUPS[0]
    const spec = group.specs[0]
    mkdirSync(join(bundle, group.subdir), { recursive: true })
    writeFileSync(join(bundle, group.subdir, spec.filename), "tampered-model-bytes")

    const result = await importModels(bundle)
    const entry = result.files.find((f) => f.filename === spec.filename)
    assert.equal(entry?.status, "invalid")
    assert.match(entry?.reason ?? "", /SHA256 mismatch/)
    assert.equal(result.ok, false)
    // 캐시 디렉토리가 만들어졌더라도 오염 파일 자체는 들어가지 않는다
    const installed = join(cache, group.subdir, spec.filename)
    assert.equal(existsSync(installed), false)
  })

  it("상태 조회는 다운로드·복사 없이 두 모델군을 모두 보고한다", async () => {
    const before = readdirSync(cache).length
    const status = await modelCacheStatus()
    assert.equal(status.length, 2)
    assert.ok(status.every((g) => g.allReady === false))
    assert.equal(readdirSync(cache).length, before)
  })
})
