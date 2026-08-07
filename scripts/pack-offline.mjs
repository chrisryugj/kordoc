// 폐쇄망(내부망) 반입용 오프라인 설치 번들 생성.
//
// kordoc tarball + 런타임 의존성을 **실제로 설치한 상태**로 묶는다. 내부망에서는
// 압축만 풀면 바로 실행되므로 npm 레지스트리도 인터넷도 필요 없다.
//
// 사용: node scripts/pack-offline.mjs [--out <dir>] [--with-ocr] [--with-models]
//   --with-ocr     OCR/수식 엔진(optional deps: onnxruntime-node·sharp·pdfium 등) 포함 (~수백MB)
//   --with-models  로컬 캐시의 OCR 모델을 함께 동봉 (kordoc models --export 와 동일 검증)
//
// ⚠ 네이티브 모듈(sharp·onnxruntime-node·pdfium)은 OS/CPU 종속이다.
//    번들은 **반입 대상과 같은 OS/arch 에서** 만들어야 한다 — 파일명에 플랫폼을 박아둔다.

import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))

const args = process.argv.slice(2)
const withOcr = args.includes("--with-ocr")
const withModels = args.includes("--with-models")
const outIdx = args.indexOf("--out")
const outDir = resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : join(root, "dist-offline"))

const platform = `${process.platform}-${process.arch}`
const stageName = `kordoc-offline-${pkg.version}-${platform}`
const stage = join(outDir, stageName)

function run(cmd, cmdArgs, cwd = root) {
  return execFileSync(cmd, cmdArgs, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] })
}

console.error(`[pack-offline] ${stageName} (ocr=${withOcr}, models=${withModels})`)

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// 1. kordoc 자체를 tarball 로 (npm pack 이 files 필드를 그대로 적용)
console.error("[pack-offline] npm pack …")
const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", stage]))[0].filename
const tgz = join(stage, packed)

// 2. staging 에 실제 설치 — 내부망에서 압축만 풀면 되도록
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: "kordoc-offline", private: true, type: "module", dependencies: { kordoc: `file:${packed}` } }, null, 2) + "\n",
)
console.error("[pack-offline] npm install (오프라인 트리 구성) …")
run("npm", ["install", "--no-audit", "--no-fund", ...(withOcr ? [] : ["--omit=optional"])], stage)
rmSync(tgz, { force: true })
rmSync(join(stage, "package-lock.json"), { force: true })

// 설치가 끝난 트리이므로 file: 참조를 남기지 않는다 — 내부망에서 npm install 을
// 다시 돌리면 사라진 tgz 를 찾다 깨진다
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "kordoc-offline",
      version: pkg.version,
      private: true,
      type: "module",
      description: "설치 완료된 kordoc 오프라인 트리 — npm install 불필요, INSTALL.md 참조",
    },
    null,
    2,
  ) + "\n",
)

// 3. 모델 동봉 (SHA 검증은 kordoc models --export 가 수행)
if (withModels) {
  console.error("[pack-offline] 모델 내보내기 …")
  run(process.execPath, [join(root, "dist", "cli.js"), "models", "--export", join(stage, "models")])
}

// 4. 설치 안내 — 폐쇄망 담당자가 이 파일만 보고 끝낼 수 있게
writeFileSync(join(stage, "INSTALL.md"), installGuide(pkg.version, platform, withModels))

// 5. 압축
const tarName = `${stageName}.tar.gz`
console.error("[pack-offline] 압축 …")
run("tar", ["-czf", tarName, stageName], outDir)
rmSync(stage, { recursive: true, force: true })

const sizeMb = (statSync(join(outDir, tarName)).size / 1024 / 1024).toFixed(1)
console.error(`[pack-offline] 완료: ${join(outDir, tarName)} (${sizeMb}MB)`)

function installGuide(version, plat, models) {
  return `# kordoc ${version} 오프라인 설치 (${plat})

인터넷·npm 레지스트리 접근 없이 설치합니다. 이 번들은 **${plat}** 전용입니다
(네이티브 모듈 포함 — 다른 OS/CPU 에서는 같은 플랫폼에서 다시 만들어야 합니다).

## 1. 압축 해제

\`\`\`
tar -xzf kordoc-offline-${version}-${plat}.tar.gz
cd kordoc-offline-${version}-${plat}
\`\`\`

## 2. 동작 확인

\`\`\`
node node_modules/kordoc/dist/cli.js --version
\`\`\`

## 3. 폐쇄망 제한 적용 (권장)

두 환경변수를 시스템/서비스 단위로 고정하십시오.

| 변수 | 값 | 효과 |
|------|-----|------|
| \`KORDOC_OFFLINE\` | \`1\` | 모든 아웃바운드 통신(모델 다운로드·webhook)을 시도 전에 차단 |
| \`KORDOC_ROOT\` | 작업 디렉토리 절대경로 | MCP 서버의 파일 읽기/쓰기를 해당 디렉토리 하위로 제한 |

## 4. MCP 서버 등록 (선택)

\`\`\`
KORDOC_OFFLINE=1 KORDOC_ROOT=/작업/경로 node node_modules/kordoc/dist/cli.js setup
\`\`\`

폐쇄망 모드에서는 \`npx\` 대신 설치된 \`dist/mcp.js\` 절대경로로 등록되고,
위 두 변수가 MCP 설정 파일의 \`env\` 에 함께 기록됩니다.

${models
      ? `## 5. OCR 모델

동봉된 \`models/\` 를 캐시에 설치합니다 (SHA-256 검증 포함).

\`\`\`
node node_modules/kordoc/dist/cli.js models --import ./models
node node_modules/kordoc/dist/cli.js models --status
\`\`\`
`
      : `## 5. OCR 모델 (미동봉)

이 번들에는 OCR 모델이 없습니다. 필요하면 인터넷이 되는 PC 에서
\`kordoc models --export <디렉토리>\` 로 내보내 반입한 뒤
\`kordoc models --import <디렉토리>\` 로 설치하십시오.
`}
`
}
