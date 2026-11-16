import { defineConfig } from "tsup"
import { copyFileSync, readFileSync } from "fs"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))
const define = { __KORDOC_VERSION__: JSON.stringify(pkg.version) }
// PDF 엔진 wasm(src/pdf/hayro.ts 가 import.meta.url 옆에서 읽는다) — 청크가 모두 dist/ 바로 아래라 같은 자리에 둔다
const onSuccess = async () => copyFileSync("src/pdf/hayro-pdf.wasm", "dist/hayro-pdf.wasm")

// optional deps: 런타임 dynamic import 로만 사용. bundle 에 포함되면
// (1) dist 크기 폭증, (2) 사용자가 설치 안 했을 때 require 시도되며 즉시 실패.
const OPTIONAL_EXTERNAL = [
  "puppeteer-core",
  "onnxruntime-node",
  "@hyzyla/pdfium",
  "@huggingface/tokenizers",
  "sharp",
  "zxing-wasm",
  "libheif-js",
  "@rhwp/core",
]

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    splitting: true,
    sourcemap: true,
    clean: true,
    external: OPTIONAL_EXTERNAL,
    noExternal: ["cfb"],
    // CJS 빌드에서 import.meta.url(createRequire 용) 잔존 → require() 소비자
    // SyntaxError. shims가 CJS에선 __filename 기반으로 치환한다.
    shims: true,
    define,
    onSuccess,
  },
  {
    entry: ["src/cli.ts", "src/mcp.ts"],
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    external: OPTIONAL_EXTERNAL,
    noExternal: ["cfb"],
    define,
    onSuccess,
  },
])
