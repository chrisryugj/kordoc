import { defineConfig } from "tsup"
import { readFileSync } from "fs"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))
const define = { __KORDOC_VERSION__: JSON.stringify(pkg.version) }

// optional deps: 런타임 dynamic import 로만 사용. bundle 에 포함되면
// (1) dist 크기 폭증, (2) 사용자가 설치 안 했을 때 require 시도되며 즉시 실패.
const OPTIONAL_EXTERNAL = [
  "pdfjs-dist",
  "puppeteer-core",
  "onnxruntime-node",
  "@huggingface/transformers",
  "@hyzyla/pdfium",
  "sharp",
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
    define,
  },
  {
    entry: ["src/cli.ts", "src/mcp.ts"],
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    external: OPTIONAL_EXTERNAL,
    noExternal: ["cfb"],
    define,
  },
])
