import { build, context } from "esbuild"
import { rollup, watch } from "rollup"
import { dts } from "rollup-plugin-dts"
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
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
  // 한글을 \uXXXX 로 풀지 않는다. 붙여 쓰기 사전(낱말 수만 개)이 두 배로 부풀었다
  charset: "utf8",
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
  // 소스맵에서 붙여 쓰기 사전 원문은 뺀다 — 수십만 낱말 문자열이라 디버깅에 쓸 데가 없고 맵마다 1MB 넘게 늘린다
  for (const name of await readdir(dist)) {
    if (!name.endsWith(".map")) continue
    const file = new URL(name, dist)
    const map = JSON.parse(await readFile(file, "utf8"))
    const i = map.sources?.findIndex(s => s.endsWith("src/pdf/wrap-dict-data.ts")) ?? -1
    if (i < 0 || !map.sourcesContent) continue
    map.sourcesContent[i] = null
    await writeFile(file, JSON.stringify(map))
  }
  const bundle = await rollup(types)
  try {
    for (const output of declarations) await bundle.write(output)
  } finally {
    await bundle.close()
  }
}
