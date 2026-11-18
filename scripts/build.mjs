import { build, context } from "esbuild"
import { rollup, watch } from "rollup"
import { dts } from "rollup-plugin-dts"
import { copyFile, mkdir, readFile, rm } from "node:fs/promises"
import { watchFile } from "node:fs"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url)
const dist = new URL("dist/", root)
const wasm = new URL("src/pdf/hayro-pdf.wasm", root)
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const external = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).filter(name => name !== "cfb")
const common = {
  absWorkingDir: fileURLToPath(root), outdir: fileURLToPath(dist),
  platform: "node", target: "node20", bundle: true, sourcemap: true, external,
  define: { __KORDOC_VERSION__: JSON.stringify(pkg.version) },
}
const builds = [
  { ...common, entryPoints: ["src/index.ts", "src/cli.ts", "src/mcp.ts"], format: "esm", splitting: true },
  {
    ...common, entryPoints: ["src/index.ts"], format: "cjs", outExtension: { ".js": ".cjs" },
    // 템플릿과 WASM은 배포 파일을 기준으로 찾는다.
    define: { ...common.define, "import.meta.url": "kordocModuleUrl" },
    banner: { js: 'var kordocModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  },
]
const types = {
  input: fileURLToPath(new URL("src/index.ts", root)),
  plugins: [dts({ tsconfig: fileURLToPath(new URL("tsconfig.json", root)) })],
}
const declarations = ["index.d.ts", "index.d.cts"].map(name => ({ file: fileURLToPath(new URL(name, dist)), format: "es" }))

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
const copyWasm = () => copyFile(wasm, new URL("hayro-pdf.wasm", dist))
await copyWasm()
if (process.argv.includes("--watch")) {
  for (const options of builds) await (await context(options)).watch()
  const watcher = watch({ ...types, output: declarations })
  watcher.on("event", event => {
    if (event.code === "ERROR") console.error(event.error)
    if (event.result) void event.result.close()
  })
  watchFile(wasm, () => { void copyWasm().catch(console.error) })
} else {
  await Promise.all(builds.map(options => build(options)))
  const bundle = await rollup(types)
  try {
    for (const output of declarations) await bundle.write(output)
  } finally {
    await bundle.close()
  }
}
