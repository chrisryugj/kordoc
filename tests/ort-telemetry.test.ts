import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

let fixture: string
const engineUrl = new URL("../src/ocr/engine.ts", import.meta.url).href
const formulaUrl = new URL("../src/pdf/formula/pipeline.ts", import.meta.url).href
const cwd = fileURLToPath(new URL("..", import.meta.url))

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), "kordoc-ort-telemetry-"))
  await mkdir(join(fixture, "ppocr"))
  await mkdir(join(fixture, "pix2text"))
  await writeFile(join(fixture, "ppocr", "rec_korean.yml"), "character_dict:\n- A\n")
  await writeFile(join(fixture, "pix2text", "tokenizer.json"), "{}")
  const checked = (name: string) => `
    import assert from "node:assert/strict";
    assert.equal(process.env.ORT_DISABLE_TELEMETRY, "1", ${JSON.stringify(name + " evaluated before telemetry was disabled")});
    (globalThis.loadedRuntimeModules ??= []).push(${JSON.stringify(name)});
  `
  const modules = {
    "onnxruntime-node": checked("onnxruntime-node") + `
      export const InferenceSession = { async create() {
        assert.equal(process.env.ORT_DISABLE_TELEMETRY, "1");
        globalThis.createdSessions = (globalThis.createdSessions ?? 0) + 1;
        return { async release() {} };
      } };
    `,
    "@huggingface/tokenizers": checked("@huggingface/tokenizers") + "export class Tokenizer {}",
    "sharp": "export default function sharp() { throw new Error('unexpected image inference'); }",
  }
  await writeFile(join(fixture, "loader.mjs"), `
    const modules = ${JSON.stringify(modules)};
    export async function resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(modules, specifier)) return { url: "data:text/javascript," + encodeURIComponent(modules[specifier]), shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `)
  await writeFile(join(fixture, "register.mjs"), "import {register} from 'node:module'; register(new URL('./loader.mjs', import.meta.url));")
})
after(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }) })

function child(script: string, original: string | undefined): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, KORDOC_MODEL_CACHE: fixture }
  if (original === undefined) delete env.ORT_DISABLE_TELEMETRY
  else env.ORT_DISABLE_TELEMETRY = original
  return spawnSync(process.execPath, ["--import", "tsx", "--import", join(fixture, "register.mjs"), "--input-type=module", "--eval", script], {
    cwd, env, encoding: "utf8", timeout: 15_000,
  })
}

describe("OCR runtime telemetry suppression before optional native imports", () => {
  it("does not require a Node process global when preparing a browser environment", () => {
    const helperUrl = new URL("../src/ocr/runtime-env.ts", import.meta.url).href
    const result = child(`
      import assert from "node:assert/strict";
      const {disableOrtTelemetry} = await import(${JSON.stringify(helperUrl)});
      const originalProcess = globalThis.process;
      globalThis.process = undefined;
      try { disableOrtTelemetry(); } finally { globalThis.process = originalProcess; }
      assert.equal(process.env.ORT_DISABLE_TELEMETRY, "0");
    `, "0")
    assert.equal(result.status, 0, String(result.stderr))
  })
  for (const original of [undefined, "0"]) {
    it(`preserves ${original ?? "unset"} environment when merely importing both engines`, () => {
      const result = child(`
        import assert from "node:assert/strict";
        await import(${JSON.stringify(engineUrl)}); await import(${JSON.stringify(formulaUrl)});
        assert.equal(process.env.ORT_DISABLE_TELEMETRY, ${JSON.stringify(original) ?? "undefined"});
        assert.equal(globalThis.loadedRuntimeModules, undefined);
      `, original)
      assert.equal(result.status, 0, String(result.stderr))
    })
    for (const kind of ["ocr", "formula"]) {
      it(`disables telemetry from ${original ?? "unset"} before ${kind} module evaluation and session initialization`, () => {
        const url = kind === "ocr" ? engineUrl : formulaUrl
        const className = kind === "ocr" ? "OcrEngine" : "FormulaPipeline"
        const expected = kind === "ocr" ? ["onnxruntime-node"] : ["@huggingface/tokenizers", "onnxruntime-node"]
        const result = child(`
          import assert from "node:assert/strict";
          const {${className}} = await import(${JSON.stringify(url)});
          const engine = await ${className}.create();
          assert.deepEqual(globalThis.loadedRuntimeModules.sort(), ${JSON.stringify(expected)});
          assert.equal(globalThis.createdSessions, ${kind === "ocr" ? 2 : 3});
          assert.equal(process.env.ORT_DISABLE_TELEMETRY, "1");
          await engine.destroy();
        `, original)
        assert.equal(result.status, 0, String(result.stderr))
      })
    }
  }
})
