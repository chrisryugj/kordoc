// prepublishOnly 게이트 래퍼 — 코퍼스가 온전한 기기에서만 bench:gate를 강제한다.
//
// 배경: bench:gate 첫 링크(score.mjs)의 모수 하한이 코퍼스 없는 기기에서 상시 FAIL이라
// `npm publish --ignore-scripts` 우회가 관행화됐고, 그 결과 test/build까지 통째로
// 스킵된 채 발행될 수 있었다. 이 래퍼는 코퍼스 부재를 SKIP(경고+exit 0)으로 분리해
// 게이트 체인(typecheck·test·build)이 어느 기기에서든 살아있게 한다.
// 코퍼스가 모수 하한 이상 존재하면 bench:gate 전체를 그대로 강제한다(우회 없음).

import { readdir } from "node:fs/promises"
import { join, dirname, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(root, "corpus")

// score.mjs MIN_POP과 같은 취지의 하한 (hwpx 170 / pdf 25)
const MIN = { hwpx: 170, pdf: 25 }

async function countByExt(dir, counts) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return counts // 코퍼스 폴더 자체가 없음
  }
  for (const e of entries) {
    if (e.isDirectory()) await countByExt(join(dir, e.name), counts)
    else {
      const ext = extname(e.name).toLowerCase()
      if (ext === ".hwpx") counts.hwpx++
      else if (ext === ".pdf") counts.pdf++
    }
  }
  return counts
}

const counts = await countByExt(corpusDir, { hwpx: 0, pdf: 0 })
const hasCorpus = counts.hwpx >= MIN.hwpx && counts.pdf >= MIN.pdf

if (!hasCorpus) {
  console.warn(
    `\n⚠️  [gate-if-corpus] bench 코퍼스 부재/부족 (hwpx ${counts.hwpx}/${MIN.hwpx}, pdf ${counts.pdf}/${MIN.pdf})` +
      `\n⚠️  bench:gate 를 SKIP 합니다 — typecheck/test/build 는 이미 통과한 상태로만 이 지점에 도달합니다.` +
      `\n⚠️  코퍼스 보유 기기(맥미니)에서는 bench:gate 가 정상 강제됩니다. --ignore-scripts 는 이제 불필요합니다.\n`,
  )
  process.exit(0)
}

const r = spawnSync("npm", ["run", "bench:gate"], { stdio: "inherit", shell: true })
process.exit(r.status ?? 1)
