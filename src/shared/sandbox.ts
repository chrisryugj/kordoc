/**
 * gVisor 샌드박스 — `KORDOC_SANDBOX=gvisor` 이면 파싱 CLI·parse-worker(SDK 워커)를 gVisor(runsc) 안에서 다시 실행한다.
 *
 * 문서를 읽는 프로세스는 호스트 커널 대신 gVisor 커널을 부른다. sharp·onnxruntime·PDF 엔진 같은 네이티브 코드가
 * 악성 문서로 장악되어도 호스트의 파일과 네트워크에 직접 닿지 못한다.
 * - 네트워크: `--network=none` 으로 끊는다. KORDOC_OFFLINE 도 함께 켠다
 * - 파일: 호스트 파일은 읽기만 보인다. 쓰기는 메모리에만 남고 끝나면 사라진다. 그래서 결과를 표준 출력으로 내는 경로만 받는다
 * - 실패: Linux 에서 runsc 가 없거나 못 띄우면 오류로 멈춘다. 격리 없이 계속하지 않는다
 * - macOS·Windows: gVisor 를 돌릴 수 없는 운영체제라 경고만 내고 그대로 실행한다
 * 꺼 두면(기본) 아무것도 하지 않는다.
 */

import { spawnSync } from "child_process"

/** 샌드박스 안에서 다시 실행된 프로세스 표시 — 다시 감싸지 않는다 */
const INSIDE = "KORDOC_SANDBOX_INSIDE"

/** gVisor 안에서 다시 실행된 프로세스인가 — 파일 쓰기가 사라지는 경로를 막는 데 쓴다 */
export function insideSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INSIDE] === "1"
}

/** runsc 인자 (전역 플래그 + do + 다시 실행할 명령) */
export function runscArgs(command: string[], root: boolean): string[] {
  // rootless 는 별도 네트워크 스택을 못 써 호스트 네트워크로 바뀐다(gVisor rootless 문서) — 네트워크를 막을 수 없어 쓰지 않는다
  if (!root) throw new Error("gVisor 샌드박스는 root 로 실행해야 합니다 (rootless runsc 는 네트워크를 막지 못함). sudo 로 실행하거나 컨테이너 런타임(docker --runtime=runsc)을 쓰세요")
  return ["--network=none", "do", "--quiet", "--", ...command]
}

/**
 * `KORDOC_SANDBOX=gvisor` 이면 지금 프로세스를 runsc 안에서 다시 실행하고 그 종료 코드로 끝낸다(돌아오지 않는다).
 * 꺼져 있거나 이미 샌드박스 안이면 그냥 돌아온다.
 * @param stdoutOnly 결과를 표준 출력으로만 내는 명령인가 — 아니면 결과 파일이 사라지므로 오류로 멈춘다
 */
export function reexecInSandbox(stdoutOnly: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const mode = env.KORDOC_SANDBOX?.trim()
  if (!mode || insideSandbox(env)) return
  const fail = (message: string): never => {
    process.stderr.write(`[kordoc] ${message}\n`)
    process.exit(1)
  }
  if (mode !== "gvisor") fail(`KORDOC_SANDBOX=${mode} 은 지원하지 않습니다 (gvisor 만)`)
  // 같은 설정을 여러 운영체제에서 쓰는 경우 — 데스크톱에서는 경고만 하고 서버(Linux)에서만 강제한다
  if (process.platform !== "linux") {
    process.stderr.write(`[kordoc] KORDOC_SANDBOX=gvisor 는 Linux 에서만 동작합니다 — ${process.platform} 에서는 격리 없이 실행합니다 (docs/sandbox.md)\n`)
    return
  }
  if (!stdoutOnly) fail("KORDOC_SANDBOX=gvisor 는 결과를 표준 출력으로 내는 파싱(kordoc <파일>, parse-worker)만 지원합니다 — 샌드박스 안에서 쓴 파일은 끝나면 사라집니다. 파일을 쓰는 명령은 컨테이너 런타임(docker --runtime=runsc)으로 격리하세요 (docs/sandbox.md)")
  let args: string[] = []
  try {
    args = runscArgs([process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.getuid?.() === 0)
  } catch (e) {
    fail((e as Error).message)
  }
  const runsc = env.KORDOC_RUNSC || "runsc"
  const r = spawnSync(runsc, args, { stdio: "inherit", env: { ...env, [INSIDE]: "1", KORDOC_OFFLINE: "1" } })
  if (r.error) fail(`gVisor 샌드박스를 띄우지 못했습니다 (${runsc}: ${r.error.message}). runsc 설치: https://gvisor.dev/docs/user_guide/install/`)
  if (r.signal) process.kill(process.pid, r.signal)
  process.exit(r.status ?? 1)
}
