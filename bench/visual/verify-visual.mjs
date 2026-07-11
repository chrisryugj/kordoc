/**
 * P1 시각 오라클 하네스 — 로컬 한컴(맥) 실렌더 캡처를 지각해시로 게이트.
 *
 * 원리: markdownToHwpx 산출물을 실제 한컴이 어떻게 그리는지가 유일한 truth다
 * (XML유효·재파싱일치·kordoc렌더 셋 다 통과해도 한컴이 flat/겹침/변조경고로
 * 그린 전례 다수 — 메모리 project-kordoc-v3). 캡처에서 종이(순백) 영역만 찾아
 * 32×32 aHash로 줄여 baseline과 해밍 비교 — 레이아웃 붕괴·백지·경고 다이얼로그를
 * 잡고, 작업영역 배경(테마 따라 검정/회색)과 창 위치 변화는 페이지 검출이 흡수한다.
 * 도장 케이스(red: true)는 붉은 픽셀 질량·중심좌표도 baseline과 대조해 소형 도장
 * 소실·오배치까지 잡는다 — aHash만으로는 15mm 도장이 9비트라 임계 미달 (gate-2,
 * 수치 근거는 hash-lib.mjs 헤더).
 *
 * 요구: macOS + Hancom Office HWP.app (GUI 세션). CI 불가 — 발행 전 로컬 실행.
 * 사용:
 *   node bench/visual/verify-visual.mjs             # 관찰 (거리 출력)
 *   node bench/visual/verify-visual.mjs --update    # baseline 갱신 (후 눈으로 확인)
 *   node bench/visual/verify-visual.mjs --gate      # 이탈 시 exit 1
 *   node bench/visual/verify-visual.mjs --noise     # 같은 케이스 2회 캡처로 노이즈 측정
 *   node bench/visual/verify-visual.mjs --seal-sens # 도장 감도 실측 (없음/15/25/40mm 4캡처)
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { markdownToHwpx, placeSealHwpx } from "../../dist/index.js"
import { analyzePng, hamming, formatBaseline, parseBaseline } from "./hash-lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out")
const baseDir = join(here, "baseline")
const args = process.argv.slice(2)
const UPDATE = args.includes("--update")
const GATE = args.includes("--gate")
const NOISE = args.includes("--noise")
const CASE = (args.find(a => a.startsWith("--case=")) ?? "").split("=")[1] || null
const SEAL_SENS = args.includes("--seal-sens")

/** 해밍 거리 임계 (1024비트 중) — 페이지-crop aHash 노이즈 실측(동일 문서 2캡처 0/1024)
 *  대비 여유값. 대형 개체 소실·백지·에러 다이얼로그는 수십~수백 비트라 확실히 걸린다.
 *  소형 도장은 15mm 가 9비트로 임계 미달 — red-mass/중심좌표 게이트(red: true)가 잡는다 (gate-2). */
const HAMMING_MAX = 16

/** 도장(red) 게이트 — baseline 대비 붉은 픽셀 질량 소실/과다·중심좌표 이동 허용 폭.
 *  도장 2개 중 1개 소실이면 질량이 절반이라 0.5 하한에 걸리고, 엉뚱한 셀 배치는
 *  페이지 폭의 수 % 이상 중심이 움직인다 (colspan 오배치 실측 Δ36%). */
const RED_LOSS = 0.5
const RED_EXCESS = 2
const CENTROID_MAX = 0.05

const APP = "Hancom Office HWP"
const LOAD_WAIT_MS = 12000

// ─── 케이스 (P1이 잡아온 결함 계열 대표) ─────────────────────────
const CASES = [
  {
    name: "table-growth",
    md: [
      "# 표 성장",
      "",
      "| 항목 | 내용 |",
      "| --- | --- |",
      "| 개요 | 서울특별시 도시기반시설 관리 실태 전수조사 결과에 따라 노후 시설물의 안전등급 재산정과 보수보강 우선순위 조정이 필요하며 연차별 투자계획을 수립하여 시행한다. |",
      "",
      "표 뒤 문단은 표 아래에 렌더되어야 한다.",
    ].join("\n"),
  },
  {
    name: "heading-list",
    md: "# 제목\n\n본문 문단입니다.\n\n- 목록 하나\n- 목록 둘\n  - 하위 항목\n\n마지막 문단.",
  },
  {
    name: "equation",
    md: "수식 검증\n\n$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$\n\n수식 아래 문단.",
  },
  {
    name: "gongmun-report",
    md: "# 추진 계획\n\n- **개요**: 시각 오라클 하네스 검증\n  - 세부 항목 하나\n  - 세부 항목 둘\n- **일정**: 2026년 7월",
    options: { gongmun: { preset: "보고서" } },
  },
  {
    // P6 도장 부유 배치 — 본문·표셀 앵커 각 1개. 검증 포인트: 도장이 "(인)" 옆/위에
    // 붉게 찍히고, 표/페이지가 커지지 않고, 변조 경고가 없어야 한다.
    name: "seal",
    red: true,
    md: "# 참가 신청서\n\n신청인: 홍길동 (인)\n\n| 결재 | 담당자 (인) |\n| --- | --- |\n\n표 아래 문단.",
    post: async (buf) => (await placeSealHwpx(buf, [
      { anchor: "(인)", occurrence: 0, image: new Uint8Array(SEAL_PNG) },
      { anchor: "(인)", occurrence: 1, image: new Uint8Array(SEAL_PNG) },
    ])).buffer,
  },
  {
    // seal-1 colspan — 가로 병합 제목행 아래 데이터행 앵커. 도장이 col2 안에 찍혀야 하고
    // 병합폭 이중계상으로 표 밖(오른쪽)으로 밀리면 안 된다.
    name: "seal-colspan",
    red: true,
    md: `<table><tr><td colspan="2">결재 구분</td><td>비고</td></tr><tr><td>담당자</td><td>과장</td><td>국장 (인)</td></tr></table>`,
    post: async (buf) => (await placeSealHwpx(buf, [{ anchor: "(인)", occurrence: 0, image: new Uint8Array(SEAL_PNG) }])).buffer,
  },
  {
    // seal-2 중첩표 — 바깥 넓은 좌측 셀 + 우측 셀 안 중첩표. 도장이 '서명 (인)' 옆(우측 셀)에
    // 찍혀야 하고, 바깥 셀 오프셋 미가산으로 왼쪽 셀로 밀리면 안 된다.
    name: "seal-nested",
    red: true,
    md: `<table><tr><td>왼쪽 바깥 셀 내용을 길게 채워 폭을 넓힌다 상당히</td><td><table><tr><td>서명 (인)</td></tr></table></td></tr></table>`,
    post: async (buf) => (await placeSealHwpx(buf, [{ anchor: "(인)", occurrence: 0, image: new Uint8Array(SEAL_PNG) }])).buffer,
  },
  {
    // P5 차트 — 막대 2계열. 검증 포인트: 한컴이 차트 개체를 실제로 그려야 한다
    // (chartSpace 파트 오류·미지원 구조면 빈 틀/에러 다이얼로그).
    name: "chart",
    md: "# 분기별 현황\n\n```chart\ntype: column\ncat: 1분기, 2분기, 3분기\n예산: 100, 120, 110\n집행: 80, 95, 105\n```\n\n차트 아래 문단.",
  },
]

/** P6 도장 픽스처 — 100×100 붉은 '인' PNG (투명 배경, base64 내장) */
const SEAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAEK0lEQVR42u2dX4gVVRzHP3daVhBaT/gHVNR9iDZBj/YQjkEp6otE/57aUtQHhQqSrU1ffAnyIZFQX8pSESKinloJIgmJtOAE6uIoKigVtBQUmwNSJirrw52N6+muO3Pv3JlZ+H5gHs65c89czmd/58z5sxwQQogpQy3rF5yxY6q2bIRxVMtdiEQUI6YmEdUSE0hG8dyvXgPJqJaUQDKqJaWr028NqvRsf9y1LAVIRGfENNZroKio1lgkUN9RregJFB3VipJA1VQtJERChIRIiJAQCRESIiGiaLrQtMUD3mj6jiKkPBl9wO3Gyxk7X0KEhKgPydaUdAGPA2uARcAc4EFgFPgTuAicCOPosoR0VsQ84E1gKzAjxf2/APuAw2Ec/aMmKz8RgTN2F/ATMJhGRkIvcAD42Rn7rITkI2MGcBzYDUyb4LY7wPX7FDMHOOaM3eeMrUlI6zKmAceAdd5HY8AQ8DIwH+gO46gH6AYeAV4Bvm9S5ACwV31I63wArPLyhoFNYRxd4P9LoLeAK8n1oTN2LXAUWNBw26Az9lIYR0cUIdmiYyWwxcv+EljZTAbN16hPAI8BkffRu87YhyQkG3u4d19YBPSHcXSTbBsHRoGnk1ficWYBOyUkfXQsAJ70sl9v9dU1jKMR4B0vu19C0vO8lz4TxtHJNsv8CLjR+ErsjF0uIelY3qTvoM09TzeAb73sJRKSjrle+kpO5frlzJOQdMz00nFO5f41yXMkZAJGvfSsDon+Q0LS8VuH2vpHvfTvEpKOc176hRxepXuA1V72WQlJxxfU56vGedgZ+1KbZb5Bfa5rnEtTcb0kKGlb/gjwnZf9XjJgbCU6ljUZmX+igWE2dnhRMhc47oztzShjKfAVML0h+1dgv4Rki5LTwPte9mJg2Bm7zRnbPYmI6c7YQeBHb7wxBmyfqiuIZU+/DwALgWca8kwyDfK2M3YoadpGqC9QmWSVcDXw3ATjjLfCOBoCrYe0EiW3nbEvAoeADU1G2a8lVxpuATvDONoPWjFsaw4qjKONwOY2BnLngSemuoxK7csK4+hj6lt+Xk1WDSf7j+CbwDdJc7cs6ZPQNqB8pfwLHAQOOmNnAk8lkmZT35d1jfq+rMvAD8kML9qXVYyc0WQAibaSCgkREqI+JOVUyGdAX0PW3jCOPpWQ8ujj3jX32WqyhCKkJP4Gvm4y4JSQEtdl1qvJEhIiIUJCJERIiMYh5dPrjF1R8DOvJtP/EkLzjRADBT+zH/hcTZaQEPUhk7Md6Cn5NwxLCP/NL51SkyUkREiIhAgJkRAhIRIiJERChIQICZEQISESIooWojNyKewo70Bn3lKpM3KDTh3ULlqrv1orX1Yk5SfCr8uuTtoWOXXqioDyzlcP1CxV67D7QH1FdWRM2Kmr3yheRGYhEtNZEUKINNwFfT5DTyesQggAAAAASUVORK5CYII=",
  "base64",
)

// ─── 한컴 캡처 ────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const osa = (script, quiet = false) => execFileSync("osascript", ["-e", script], {
  encoding: "utf8",
  ...(quiet && { stdio: ["ignore", "pipe", "ignore"] }),
}).trim()

async function captureHancom(hwpxPath, pngPath) {
  // 같은 basename의 사용자 창이 이미 열려 있어도 다른 문서를 잡지 않도록 캡처 전용
  // 고유 파일명으로 복제한다. 캡처 후 이 창만 닫고 원래 열려 있던 한컴 창은 유지한다.
  const stem = basename(hwpxPath).replace(/\.hwpx$/i, "")
  const openPath = join(outDir, `${stem}.visual-${process.pid}-${Date.now()}.hwpx`)
  const windowName = basename(openPath).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  copyFileSync(hwpxPath, openPath)
  try {
    execFileSync("open", ["-a", APP, openPath])
    await sleep(LOAD_WAIT_MS)
    // 콜드 스타트 대비 — 창이 잡힐 때까지 재시도 (최대 +20s)
    let bounds = null
    for (let i = 0; i < 10 && !bounds; i++) {
      try {
        const b = osa(
          `tell application "System Events" to tell process "${APP}"\n` +
          `  set w to first window whose name is "${windowName}"\n` +
          `  set frontmost to true\n` +
          `  perform action "AXRaise" of w\n` +
          `  return (position of w as list) & (size of w as list)\nend tell`,
        ).split(", ").map(Number)
        if (b.length === 4 && b.every(Number.isFinite)) bounds = b
      } catch { /* 프로세스/창 미준비 */ }
      if (!bounds) await sleep(2000)
    }
    if (!bounds) throw new Error("한컴 창을 못 잡음 — GUI 세션·손상 다이얼로그 확인")
    // -R은 z-order 무관 영역 캡처라, 한컴이 front가 아니면 앞 창(브라우저 등)이 찍힌다
    osa(`tell application "${APP}" to activate`)
    await sleep(700)
    const front = osa('tell application "System Events" to name of first process whose frontmost is true')
    if (front !== APP) throw new Error(`한컴이 front가 아님 (front=${front}) — 다른 창이 캡처를 가림`)
    osa('tell application "System Events" to key code 115 using command down') // Cmd+Home 스크롤 리셋
    await sleep(800)
    // 툴바·찾기필드·상태바 등 UI 크롬 제거용 대강 크롭 — 종이(순백) 경계는
    // hash-lib pageRect 가 픽셀에서 다시 찾으므로 여기 비율은 크롬만 잘라내면 된다
    const [wx, wy, ww, wh] = bounds
    const crop = [wx + ww * 0.04, wy + wh * 0.2, ww * 0.92, wh * 0.72].map(Math.round)
    execFileSync("screencapture", ["-x", `-R${crop.join(",")}`, pngPath])
  } finally {
    // 성공·실패와 무관하게 캡처용 고유 창과 파일만 정리한다.
    try {
      // 한컴 창은 AXClose 액션이 없다(실측: AXRaise뿐) — 표준대로 닫기 버튼(AXCloseButton)을 누른다
      osa(
        `tell application "System Events" to tell process "${APP}"\n` +
        `  set matchedWindows to every window whose name is "${windowName}"\n` +
        `  if (count of matchedWindows) > 0 then click (first button of item 1 of matchedWindows whose subrole is "AXCloseButton")\nend tell`,
        true,
      )
    } catch { /* 창이 아직 없거나 이미 닫힘 — best-effort */ }
    try { unlinkSync(openPath) } catch { /* best-effort */ }
    await sleep(1500)
  }
}

// ─── 메인 ────────────────────────────────────────────
mkdirSync(outDir, { recursive: true })
mkdirSync(baseDir, { recursive: true })

if (NOISE) {
  // 동일 케이스 2회 캡처 → 노이즈 해밍 거리 (임계 산정용)
  const c = CASES[0]
  const hwpx = join(outDir, `${c.name}.hwpx`)
  writeFileSync(hwpx, Buffer.from(await markdownToHwpx(c.md, c.options)))
  const h = []
  for (const k of [1, 2]) {
    const png = join(outDir, `${c.name}.noise${k}.png`)
    await captureHancom(hwpx, png)
    h.push(analyzePng(png).bits)
  }
  console.log(`노이즈 해밍 거리 (동일 파일 2회): ${hamming(h[0], h[1])} / 1024`)
  process.exit(0)
}

if (SEAL_SENS) {
  // gate-2 감도 실측 — seal 케이스를 도장 없음/15/25/40mm 로 4회 캡처해 오라클 반응 확인.
  // 기대: 해밍은 크기에 비례해 증가, red 는 없음 0px ↔ 있음 수천 px 로 완전 분리.
  const c = CASES.find((x) => x.name === "seal")
  const base = await markdownToHwpx(c.md, c.options)
  writeFileSync(join(outDir, "seal-none.hwpx"), Buffer.from(base))
  await captureHancom(join(outDir, "seal-none.hwpx"), join(outDir, "seal-none.png"))
  const r0 = analyzePng(join(outDir, "seal-none.png"))
  console.log(`도장 없음: red ${r0.red}px`)
  for (const sz of [15, 25, 40]) {
    const withSeal = (await placeSealHwpx(base, [
      { anchor: "(인)", occurrence: 0, image: new Uint8Array(SEAL_PNG), sizeMm: sz },
      { anchor: "(인)", occurrence: 1, image: new Uint8Array(SEAL_PNG), sizeMm: sz },
    ])).buffer
    writeFileSync(join(outDir, `seal-${sz}.hwpx`), Buffer.from(withSeal))
    await captureHancom(join(outDir, `seal-${sz}.hwpx`), join(outDir, `seal-${sz}.png`))
    const r = analyzePng(join(outDir, `seal-${sz}.png`))
    console.log(`sizeMm=${sz}: 해밍 ${hamming(r0.bits, r.bits)} / 1024 · red ${r.red}px · 중심 (${(100 * r.cx).toFixed(1)}%, ${(100 * r.cy).toFixed(1)}%)`)
  }
  process.exit(0)
}

let fail = 0
const targets = CASES.filter(c => !CASE || c.name === CASE)
if (CASE && targets.length === 0) {
  // --case= 오타/무매치 — 0건 통과를 '전체 통과'로 오인시키지 않게 명시 실패 (gate-4)
  console.error(`❌ --case=${CASE} 에 해당하는 케이스가 없습니다 (유효: ${CASES.map(c => c.name).join(", ")})`)
  process.exit(1)
}
for (const c of targets) {
  const hwpx = join(outDir, `${c.name}.hwpx`)
  let buf = await markdownToHwpx(c.md, c.options)
  if (c.post) buf = await c.post(buf)
  writeFileSync(hwpx, Buffer.from(buf))
  const png = join(outDir, `${c.name}.png`)
  await captureHancom(hwpx, png)
  const res = analyzePng(png)
  const basePath = join(baseDir, `${c.name}.hash`)
  // 도장 케이스인데 붉은 픽셀이 아예 없으면 캡처 자체가 도장 소실 — 박제 전에 알린다
  const redNote = c.red ? ` · red ${res.red}px${res.red === 0 ? " ⚠️ 도장이 안 보임!" : ""}` : ""

  if (UPDATE) {
    writeFileSync(basePath, formatBaseline(res))
    console.log(`📌 ${c.name}: baseline 갱신${redNote} (out/${c.name}.png 눈으로 확인할 것)`)
    continue
  }
  if (!existsSync(basePath)) {
    // 게이트 모드에서 baseline 부재는 실패 — 깨진 첫 캡처를 truth 로 박제하지 않는다.
    // 신규 케이스는 --update 로 명시 박제 후 눈으로 확인해야 통과한다 (gate-1).
    if (GATE) { fail++; console.error(`❌ ${c.name}: baseline 부재 — --update 로 박제 후 눈으로 확인할 것`); continue }
    writeFileSync(basePath, formatBaseline(res))
    console.log(`📌 ${c.name}: baseline 신규 생성${redNote} (out/${c.name}.png 눈으로 확인할 것)`)
    continue
  }
  const base = parseBaseline(readFileSync(basePath, "utf8"))
  if (base.red == null) {
    // 구 포맷(창 전체 aHash) baseline — 오라클 개편으로 비교 불능. 조용한 통과 금지 (gate-1 정신)
    fail++
    console.error(`❌ ${c.name}: 구 포맷 baseline — 페이지-crop 오라클로 개편됨, --update 로 재박제 후 눈으로 확인할 것`)
    continue
  }
  const d = hamming(base.bits, res.bits)
  const problems = []
  if (d > HAMMING_MAX) problems.push(`해밍 ${d} > 임계 ${HAMMING_MAX}`)
  if (c.red) {
    if (res.red < base.red * RED_LOSS) problems.push(`도장 소실/축소 — red ${res.red}px < 기준 ${base.red}px의 ${RED_LOSS * 100}%`)
    else if (res.red > base.red * RED_EXCESS) problems.push(`red 과다 — ${res.red}px > 기준 ${base.red}px의 ${RED_EXCESS}배`)
    else if (base.cx != null && res.cx != null && (Math.abs(res.cx - base.cx) > CENTROID_MAX || Math.abs(res.cy - base.cy) > CENTROID_MAX))
      problems.push(`도장 위치 이동 — 중심 Δ(${(100 * (res.cx - base.cx)).toFixed(1)}%, ${(100 * (res.cy - base.cy)).toFixed(1)}%)`)
  }
  const ok = problems.length === 0
  if (!ok) fail++
  const redInfo = c.red ? ` · red ${res.red}px(기준 ${base.red})` : ""
  console.log(`${ok ? "✅" : "❌"} ${c.name}: 해밍 ${d}${redInfo}${ok ? "" : " — " + problems.join("; ")} — out/${c.name}.png`)
}

if (fail) {
  console.error(`\n❌ 시각 게이트: ${fail}건 이탈 — out/*.png를 baseline과 눈으로 대조 후, 의도된 변경이면 --update`)
  if (GATE) process.exit(1)
} else {
  console.log(`\n✅ 시각 게이트 통과 (${targets.length}건)`)
}
