import { defineConfig } from "tsup"
import { readFileSync } from "fs"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))
const define = { __KORDOC_VERSION__: JSON.stringify(pkg.version) }

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    splitting: true,
    sourcemap: true,
    clean: true,
    external: ["pdfjs-dist"],
    noExternal: ["cfb"],
    define,
  },
  {
    entry: ["src/cli.ts", "src/mcp.ts"],
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    external: ["pdfjs-dist"],
    noExternal: ["cfb"],
    define,
  },
])
