#!/usr/bin/env node
/**
 * 발행 게이트 — 라이선스 고지가 npm 패키지에 실제로 실리는지 확인한다.
 *
 * kordoc 은 Apache-2.0 파생 코드(cluster-detector, equation, ocr/engine)와
 * MIT 저작물(rhwp 서식, claw-hwp)을 배포본에 포함한다. 두 라이선스 모두
 * 재배포 시 저작권 고지와 라이선스 사본을 함께 제공할 것을 요구하므로,
 * package.json 의 files 배열에서 NOTICE·THIRD_PARTY 가 빠지면 조건을 어긴다.
 * 실제로 한 번 빠진 채 배포된 적이 있어 게이트로 고정한다.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const files = pkg.files ?? []

const errors = []

for (const required of ["NOTICE", "THIRD_PARTY"]) {
  if (!files.includes(required)) {
    errors.push(`package.json "files" 에 "${required}" 가 없다 — 배포 tarball 에 고지가 실리지 않는다`)
  }
  if (!existsSync(join(root, required))) {
    errors.push(`${required} 가 저장소에 없다`)
  }
}

// 라이선스 전문이 실제로 들어 있는지 (빈 디렉터리 방지)
const tpDir = join(root, "THIRD_PARTY")
if (existsSync(tpDir)) {
  const entries = readdirSync(tpDir)
  for (const needed of ["apache-2.0.LICENSE", "claw-hwp.LICENSE", "rhwp-forms.txt"]) {
    if (!entries.includes(needed)) {
      errors.push(`THIRD_PARTY/${needed} 누락`)
    }
  }
}

if (errors.length > 0) {
  console.error("✗ 라이선스 고지 게이트 실패:")
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log("✓ 라이선스 고지 게이트 통과 (NOTICE·THIRD_PARTY 배포 포함)")
