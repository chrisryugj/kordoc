/**
 * 보안 로직 테스트 — 방어적 상수 및 입력 검증
 *
 * 모든 테스트가 실제 소스 코드를 직접 import하여 검증.
 * 로직 복제 없음 — 소스가 변경되면 테스트도 함께 깨짐.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readRecords, extractText } from "../src/hwp5/record.js"
import { buildTable, MAX_COLS, MAX_ROWS } from "../src/table/builder.js"
import { KordocError, sanitizeError, isPathTraversal } from "../src/utils.js"
import type { CellContext } from "../src/types.js"

// ─── readRecords: MAX_RECORDS 제한 ─────────────────────

describe("readRecords — MAX_RECORDS 제한", () => {
  it("500,000개 초과 레코드는 잘림 + 잘림 전 데이터 정합성", () => {
    const recordCount = 500_001
    const buf = Buffer.alloc(recordCount * 4)
    for (let i = 0; i < recordCount; i++) {
      // tagId = i의 하위 10비트, level=0, size=0
      buf.writeUInt32LE((i & 0x3ff) | (0 << 10) | (0 << 20), i * 4)
    }
    const records = readRecords(buf)
    assert.equal(records.length, 500_000)
    // 잘림 전 데이터 정합성 — 첫 번째와 마지막 레코드의 tagId 검증
    assert.equal(records[0].tagId, 0)
    assert.equal(records[499_999].tagId, 499_999 & 0x3ff)
    assert.equal(records[499_999].size, 0)
  })
})

// ─── buildTable: 악성 span 값 ────────────────────────────

describe("buildTable — 악성 span 값 방어", () => {
  it("극단적 colSpan/rowSpan에도 크래시 없이 테이블 생성", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 9999, rowSpan: 9999 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.rows, 1)
    assert.ok(table.cols >= 1)
  })

  it("MAX_ROWS 초과 행은 잘림", () => {
    const rows: CellContext[][] = Array.from({ length: MAX_ROWS + 1 }, () => [
      { text: "x", colSpan: 1, rowSpan: 1 },
    ])
    const table = buildTable(rows)
    assert.equal(table.rows, MAX_ROWS)
  })
})

// ─── extractText: 제어문자 코드 10 (각주/미주) ──────────────

describe("extractText — 제어문자 코드 10 처리", () => {
  it("코드 10(각주/미주)이 확장 제어문자로 14바이트 스킵됨", () => {
    const buf = Buffer.alloc(2 + 14 + 2)
    buf.writeUInt16LE(0x000a, 0)
    buf.writeUInt16LE("Z".charCodeAt(0), 16)
    assert.equal(extractText(buf), "\nZ")  // 구역/단 나눔 → 줄바꿈 출력 + 14바이트 스킵
  })

  it("코드 10 뒤에 payload가 부족하면 스킵 안 함 (안전 처리)", () => {
    const buf = Buffer.alloc(6)
    buf.writeUInt16LE(0x000a, 0)
    buf.writeUInt16LE("A".charCodeAt(0), 2)
    buf.writeUInt16LE("B".charCodeAt(0), 4)
    const result = extractText(buf)
    assert.equal(typeof result, "string")
  })
})

// ─── isPathTraversal — 실제 utils.ts 함수 직접 테스트 ──────

describe("isPathTraversal — 실제 함수 테스트", () => {
  it("악성 경로는 true 반환", () => {
    const malicious = [
      "..\\..\\etc\\passwd",
      "Contents\\..\\..\\secret.xml",
      "C:\\Windows\\system32\\config",
      "/etc/passwd",
      "../../../secret",
    ]
    for (const name of malicious) {
      assert.equal(isPathTraversal(name), true, `"${name}" → true`)
    }
  })

  it("정상 경로는 false 반환", () => {
    const safe = [
      "Contents/section0.xml",
      "section1.xml",
      "Contents/Sub/section2.xml",
    ]
    for (const name of safe) {
      assert.equal(isPathTraversal(name), false, `"${name}" → false`)
    }
  })
})

// ─── sanitizeError — 실제 utils.ts 함수 직접 테스트 ────────

describe("sanitizeError — 실제 함수 테스트", () => {
  it("KordocError는 메시지 그대로 반환", () => {
    const messages = [
      "빈 버퍼이거나 유효하지 않은 입력입니다.",
      "암호화된 HWP는 지원하지 않습니다",
      "ZIP 압축 해제 크기 초과 (ZIP bomb 의심)",
      "파일 경로가 비어있습니다",
    ]
    for (const msg of messages) {
      assert.equal(sanitizeError(new KordocError(msg)), msg)
    }
  })

  it("일반 Error는 일반 메시지로 대체", () => {
    const unsafeErrors = [
      new Error("ENOENT: no such file, open 'C:\\Users\\admin\\secret.hwp'"),
      new Error("Cannot read properties at /opt/app/node_modules/pdfjs-dist/build/pdf.js:1234"),
      new Error("EACCES: permission denied, open '/home/user/.ssh/id_rsa'"),
      "string error with C:\\path\\leak",
    ]
    for (const err of unsafeErrors) {
      assert.equal(sanitizeError(err), "문서 처리 중 오류가 발생했습니다")
    }
  })
})

// ─── KordocError — instanceof 체인 검증 ─────────────────

describe("KordocError", () => {
  it("Error의 서브클래스이며 name이 KordocError", () => {
    const err = new KordocError("test")
    assert.ok(err instanceof Error)
    assert.ok(err instanceof KordocError)
    assert.equal(err.name, "KordocError")
    assert.equal(err.message, "test")
  })
})
