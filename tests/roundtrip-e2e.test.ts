/**
 * patchHwpx 실파일 e2e — bench/corpus 3개 디렉토리(seoul/korea-kr/misc) 기반.
 *
 * 계획서 Wave 3 요구: 실HWPX 3건+ 문장/셀/헤딩 수정 → 패치 → 재파싱 일치
 * + section 외 ZIP 엔트리 바이트 동일 + ZIP 무결성(unzip -t) 통과.
 * 코퍼스는 gitignore 대상이라 존재할 때만 실행된다.
 *
 * KORDOC_E2E_FULL=1 이면 스윕이 디렉토리당 12건 제한 없이 전체를 돈다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx, patchHwpx } from "../src/index.js"

// import.meta.dirname은 Node 20.11+ — Node 18 ESM 호환을 위해 fileURLToPath 사용
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus")
const DIRS = ["seoul", "korea-kr", "misc", "review"]
const MARKER = "라운드트립검증"
const SWEEP_LIMIT = process.env.KORDOC_E2E_FULL ? Infinity : 12

// 코퍼스 완본 보유 기기(맥미니, hwpx 347)에서만 강제. 부분/부재 코퍼스 기기는 skip —
// 구본 코퍼스에선 GFM 표 후보 부재 등으로 상시 FAIL 해 `--ignore-scripts` 우회가
// 관행화됐었다. 하한은 bench/gate-if-corpus.mjs 모수 하한과 동일 취지 (170).
const CORPUS_COMPLETE = ["seoul", "korea-kr", "misc", "review"]
  .flatMap(d => { try { return corpusFiles(d) } catch { return [] } }).length >= 170
const CORPUS_SKIP = !CORPUS_COMPLETE && "bench corpus 완본 없음 (hwpx 모수 하한 170 미달)"

// ─── 헬퍼 ────────────────────────────────────────────

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

function corpusFiles(dir: string): string[] {
  const full = join(CORPUS, dir)
  if (!existsSync(full)) return []
  return readdirSync(full).filter(f => f.endsWith(".hwpx")).sort()
    .map(f => join(full, f))
}

async function parseFile(path: string) {
  const original = new Uint8Array(readFileSync(path))
  const parsed = await parseHwpx(toAB(original))
  return parsed.success ? { original, markdown: parsed.markdown } : null
}

/** 수정 대상으로 안전한 평문 라인 — 표/헤딩/이미지/링크/볼드 제외 */
function findPlainLine(md: string): string | undefined {
  return md.split("\n").find(l => {
    const t = l.trim()
    return t.length > 20 && !/^[|<#!*\->]/.test(t) && !t.includes("](") && !t.includes("**")
  })
}

async function reparse(data: Uint8Array) {
  const r = await parseHwpx(toAB(data))
  assert.ok(r.success, "패치본 재파싱 성공")
  return r
}

/** section XML 외 모든 ZIP 엔트리가 바이트 동일 + CRC 무결성 */
async function assertIntegrity(orig: Uint8Array, patched: Uint8Array): Promise<void> {
  // CRC 전수 검증 (unzip -t 동치 — 포터블)
  const zp = await JSZip.loadAsync(patched, { checkCRC32: true })
  const zo = await JSZip.loadAsync(orig)
  assert.deepEqual(Object.keys(zo.files).sort(), Object.keys(zp.files).sort(), "엔트리 목록 동일")
  for (const name of Object.keys(zo.files)) {
    if (zo.files[name].dir || /section\d+\.xml$/i.test(name)) continue
    const da = await zo.file(name)!.async("uint8array")
    const db = await zp.file(name)!.async("uint8array")
    assert.equal(Buffer.compare(Buffer.from(da), Buffer.from(db)), 0, `엔트리 바이트 보존: ${name}`)
  }
}

/** 시스템 unzip -t (있을 때만 — macOS/리눅스 기본 탑재) */
function assertUnzipT(data: Uint8Array): void {
  const tmp = join(tmpdir(), `kordoc-rt-${process.pid}-${Math.random().toString(36).slice(2)}.hwpx`)
  writeFileSync(tmp, data)
  try {
    const r = spawnSync("unzip", ["-t", tmp], { encoding: "utf-8" })
    if (r.error) return // unzip 미설치 환경 — CRC 검증으로 대체됨
    assert.equal(r.status, 0, `unzip -t 통과해야 함:\n${r.stdout}${r.stderr}`)
  } finally {
    rmSync(tmp, { force: true })
  }
}

interface CleanApply {
  path: string
  original: Uint8Array
  edited: string
  data: Uint8Array
}

/**
 * 후보 파일들을 순회하며 edit(md)가 깨끗하게(applied≥1, skipped=0) 적용되는
 * 첫 사례를 찾는다. 후보가 있는데 전부 실패하면 그 자체가 회귀 신호다.
 */
async function findCleanApply(
  paths: string[], edit: (md: string) => string | null, maxTries = 15,
): Promise<{ result: CleanApply | null; candidates: number }> {
  let candidates = 0
  for (const path of paths) {
    if (candidates >= maxTries) break
    const doc = await parseFile(path)
    if (!doc) continue
    const edited = edit(doc.markdown)
    if (edited === null || edited === doc.markdown) continue
    candidates++
    const res = await patchHwpx(doc.original, edited)
    if (!res.success || !res.data) continue
    if (res.applied >= 1 && res.skipped.length === 0) {
      return { result: { path, original: doc.original, edited, data: res.data }, candidates }
    }
  }
  return { result: null, candidates }
}

async function assertFullRoundtrip(c: CleanApply): Promise<void> {
  const r2 = await reparse(c.data)
  assert.equal(r2.markdown, c.edited, `재파싱 = 편집 마크다운: ${c.path}`)
  await assertIntegrity(c.original, c.data)
  assertUnzipT(c.data)
}

// ─── 1) 문단 수정 — 디렉토리별 1건씩 (3건) ──────────

describe("patchHwpx e2e: 문단 수정 (디렉토리별 실파일)", { skip: CORPUS_SKIP }, () => {
  for (const dir of DIRS) {
    it(`${dir} — 평문 문단 수정 → 재파싱 일치 + 바이트 보존 + unzip -t`, async () => {
      const paths = corpusFiles(dir)
      if (paths.length === 0) return
      const { result, candidates } = await findCleanApply(paths, md => {
        const line = findPlainLine(md)
        return line ? md.replace(line, `${line} ${MARKER}`) : null
      })
      assert.ok(candidates > 0, `${dir}에 수정 가능한 평문 문단이 있는 파일이 있어야 함`)
      assert.ok(result, `${dir}: ${candidates}개 후보 중 깨끗한 적용이 1건도 없음 — 회귀 의심`)
      await assertFullRoundtrip(result!)
    })
  }
})

// ─── 2) 헤딩 수정 ───────────────────────────────────

describe("patchHwpx e2e: 헤딩 수정", { skip: CORPUS_SKIP }, () => {
  it("헤딩 텍스트 수정 → 레벨 보존 + 재파싱 일치", async () => {
    // 공문서 코퍼스 144건 전수에 outline 헤딩이 0건이라(보도자료·결재문서는
    // 굵은글씨/번호 사용) 코퍼스 우선 + 합성 HWPX 폴백으로 검증한다.
    const editHeading = (md: string): string | null => {
      const line = md.split("\n").find(l => /^#{1,4} \S/.test(l.trim()) && !l.includes("]("))
      return line && md.indexOf(line) === md.lastIndexOf(line) ? md.replace(line, `${line} ${MARKER}`) : null
    }
    let found = (await findCleanApply(DIRS.flatMap(corpusFiles), editHeading)).result
    if (!found) {
      const buf = await markdownToHwpx("## 제2장 사업 추진 계획\n\n본문 문단 하나.\n\n### 세부 추진 일정\n\n둘째 문단.")
      const original = new Uint8Array(buf)
      const parsed = await parseHwpx(toAB(original))
      assert.ok(parsed.success)
      const edited = editHeading(parsed.markdown)
      assert.ok(edited, "합성 문서에 헤딩 존재")
      const res = await patchHwpx(original, edited!)
      assert.ok(res.success && res.applied >= 1 && res.skipped.length === 0,
        `헤딩 수정 깨끗한 적용: ${JSON.stringify(res.skipped)}`)
      found = { path: "(합성)", original, edited: edited!, data: res.data! }
    }
    await assertFullRoundtrip(found)
    // 헤딩 마크업이 보존됐는지 (텍스트만 바뀌고 # 레벨 유지)
    const r2 = await reparse(found.data)
    assert.ok(r2.markdown.split("\n").some(l => /^#{1,4} /.test(l.trim()) && l.includes(MARKER)), "헤딩 레벨 유지 + 마커 반영")
  })
})

// ─── 3) 표 셀 수정 — GFM / HTML ─────────────────────

describe("patchHwpx e2e: 표 셀 수정", { skip: CORPUS_SKIP }, () => {
  it("GFM 데이터 행 셀 수정 → 해당 셀만 반영", async () => {
    const paths = DIRS.flatMap(corpusFiles)
    const { result, candidates } = await findCleanApply(paths, md => {
      for (const line of md.split("\n")) {
        const t = line.trim()
        if (!t.startsWith("|") || /^[\s|:\-]+$/.test(t)) continue
        const cells = t.split(/(?<!\\)\|/).slice(1, -1)
        const idx = cells.findIndex(c => {
          const v = c.trim()
          return v.length >= 4 && /[가-힣]/.test(v) && !v.includes("![") && !v.includes("[이미지:") && !v.includes("<br>")
        })
        if (idx < 0) continue
        const newCells = [...cells]
        newCells[idx] = ` ${cells[idx].trim()} ${MARKER} `
        const newLine = line.replace(t, `|${newCells.join("|")}|`)
        if (md.indexOf(t) !== md.lastIndexOf(t)) continue // 중복 라인 회피 (replace 안전)
        return md.replace(line, newLine)
      }
      return null
    })
    assert.ok(candidates > 0, "GFM 표 있는 코퍼스 파일이 있어야 함")
    assert.ok(result, `${candidates}개 후보 중 GFM 셀 수정 깨끗한 적용 0건 — 회귀 의심`)
    await assertFullRoundtrip(result!)
  })

  it("HTML 표 셀 수정 (병합표) → 해당 셀만 반영", async () => {
    const paths = DIRS.flatMap(corpusFiles)
    const { result, candidates } = await findCleanApply(paths, md => {
      const m = md.match(/<td(?: colspan="\d+")?(?: rowspan="\d+")?>([가-힣][^<>]{5,60})<\/td>/)
      if (!m) return null
      const inner = m[1]
      if (md.indexOf(`>${inner}<`) !== md.lastIndexOf(`>${inner}<`)) return null
      return md.replace(`>${inner}</td>`, `>${inner} ${MARKER}</td>`)
    })
    assert.ok(candidates > 0, "HTML 표 있는 코퍼스 파일이 있어야 함")
    assert.ok(result, `${candidates}개 후보 중 HTML 셀 수정 깨끗한 적용 0건 — 회귀 의심`)
    await assertFullRoundtrip(result!)
  })
})

// ─── 4) 다중 섹션 문서 ──────────────────────────────

describe("patchHwpx e2e: 다중 섹션", { skip: CORPUS_SKIP }, () => {
  it("section1.xml 있는 문서 — 말미 문단 수정이 올바른 섹션에 적용", async () => {
    const paths = DIRS.flatMap(corpusFiles)
    let target: string | undefined
    for (const path of paths) {
      const zip = await JSZip.loadAsync(readFileSync(path)).catch(() => null)
      if (zip && Object.keys(zip.files).filter(n => /section\d+\.xml$/i.test(n)).length > 1) { target = path; break }
    }
    if (!target) return // 다중 섹션 파일이 코퍼스에 없으면 통과 (수집 의존)
    const { result } = await findCleanApply([target], md => {
      // 마지막 평문 라인 — 뒤 섹션에 있을 확률이 높은 위치
      const lines = md.split("\n")
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim()
        if (t.length > 20 && !/^[|<#!*\->]/.test(t) && !t.includes("](") && !t.includes("**")
          && md.indexOf(t) === md.lastIndexOf(t)) {
          return md.replace(lines[i], `${lines[i]} ${MARKER}`)
        }
      }
      return null
    })
    if (!result) return // 말미가 표/이미지뿐인 문서면 통과
    await assertFullRoundtrip(result)
  })
})

// ─── 5) 코퍼스 스윕 — 무손상 불변식 ─────────────────

describe("patchHwpx e2e: 코퍼스 스윕", { skip: CORPUS_SKIP }, () => {
  it("무변경 패치 → 원본 바이트 그대로 (전 파일)", async () => {
    let checked = 0
    for (const dir of DIRS) {
      for (const path of corpusFiles(dir).slice(0, SWEEP_LIMIT)) {
        const doc = await parseFile(path)
        if (!doc) continue
        const res = await patchHwpx(doc.original, doc.markdown)
        assert.ok(res.success, `무변경 패치 성공: ${path}`)
        assert.equal(res.applied, 0, `무변경인데 applied>0: ${path}`)
        assert.equal(
          Buffer.compare(Buffer.from(res.data!), Buffer.from(doc.original)), 0,
          `무변경 패치는 바이트 동일: ${path}`,
        )
        checked++
      }
    }
    assert.ok(checked > 0, "스윕 대상 파일 존재")
  })

  it("문단 수정 패치 → 어떤 파일에서도 손상 없음 (적용 or graceful skip)", async () => {
    let checked = 0
    let clean = 0
    for (const dir of DIRS) {
      for (const path of corpusFiles(dir).slice(0, SWEEP_LIMIT)) {
        const doc = await parseFile(path)
        if (!doc) continue
        const line = findPlainLine(doc.markdown)
        if (!line || doc.markdown.indexOf(line) !== doc.markdown.lastIndexOf(line)) continue
        const edited = doc.markdown.replace(line, `${line} ${MARKER}`)
        const res = await patchHwpx(doc.original, edited)
        assert.ok(res.success, `패치 성공: ${path}`)
        checked++

        const r2 = await reparse(res.data!) // 어떤 경우에도 재파싱은 성공해야 한다
        await assertIntegrity(doc.original, res.data!)
        if (res.applied >= 1 && res.skipped.length === 0) {
          clean++
          assert.equal(r2.markdown, edited, `깨끗한 적용은 재파싱 일치: ${path}`)
        } else {
          // graceful 경로 — 검증 리포트가 잔차를 정직하게 보고해야 한다
          assert.ok(res.verification, `skip 경로에도 verification 존재: ${path}`)
        }
      }
    }
    assert.ok(checked >= 10, `스윕 모수 확보 (현재 ${checked})`)
    // 깨끗한 적용률이 절반 밑이면 매핑 휴리스틱 회귀 신호
    assert.ok(clean / checked >= 0.5, `깨끗한 적용률 ${clean}/${checked} — 회귀 의심`)
    console.log(`  [sweep] 문단 수정 깨끗한 적용 ${clean}/${checked} (${(clean / checked * 100).toFixed(1)}%)`)
  })
})
