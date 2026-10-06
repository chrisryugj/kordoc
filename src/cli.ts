/** kordoc CLI — 모두 파싱해버리겠다 (하위 명령은 cli/ 아래 명령군 모듈) */

import { Command } from "commander"
import { VERSION, sanitizeError, routeConsoleToStderr } from "./utils.js"
import { convertFiles } from "./cli/convert.js"
import { assertDistinctStems, convertParallel, registerBatchWorker } from "./cli/batch.js"
import { registerDocCommands } from "./cli/commands-docs.js"
import { registerGenerateCommands } from "./cli/commands-generate.js"
import { registerRenderCommands } from "./cli/commands-render.js"
import { registerSystemCommands } from "./cli/commands-system.js"
import { registerWorkerCommands } from "./cli/commands-worker.js"

const program = new Command()

program
  .name("kordoc")
  .description("모두 파싱해버리겠다 — HWP, HWPX, PDF, XLSX, DOCX, 이미지(PNG/JPG/WebP) → Markdown")
  .version(VERSION)
  .argument("<files...>", "변환할 파일 경로 (HWP, HWPX, PDF, XLSX, DOCX, PNG/JPG/WebP — 이미지는 OCR 자동 적용)")
  .option("-o, --output <path>", "출력 파일 경로 (단일 파일 시)")
  .option("--jobs <count>", "병렬 변환 프로세스 수 (기본 1, 다중 파일은 -d 필요)", "1")
  .option("-d, --out-dir <dir>", "출력 디렉토리 (다중 파일 시)")
  .option("-p, --pages <range>", "페이지 범위 (예: 1-3, 1,3,5) — 한컴 저장본은 실제 페이지, 조판 캐시 없으면 섹션 근사")
  .option("--format <type>", "출력 형식: markdown (기본), json, chunks (RAG용 구조 청크 JSON — 헤딩·개조식 위계 breadcrumb + 표 독립 청크)", "markdown")
  .option("--no-header-footer", "PDF 머리글/바닥글 자동 제거 끄기 (기본: 제거함)")
  .option("--no-tables", "PDF 표 감지 끄기 — 테두리 박스를 표로 오인해 읽기 순서가 뒤집히는 문서(2단 시험지 등)에서 자연 읽기순 텍스트만 뽑는다 (#64)")
  .option("--formula-ocr", "PDF 수식 OCR 활성화 (MFD+MFR ONNX, 첫 사용 시 모델 ~155MB 자동 다운로드)")
  .option("--ocr", "스캔/이미지 PDF 텍스트 OCR (내장 PP-OCRv5 korean, 첫 사용 시 모델 ~18MB 자동 다운로드 — OCR 필요 페이지만 인식)")
  .option("--ocr-force", "전 페이지 강제 OCR (텍스트층이 있어도 무시하고 재인식)")
  .option("--dedupe-headers", "HWP5 레이아웃 표 페이지 반복 러닝 헤더 중복 제거 (기본 off — 붙임별 재번호 오삭제 주의)")
  .option("--keep-empty-cols", "표 오른쪽 끝 빈 열(서식 입력란) 보존 (#47, 기본 off: 후행 빈 열 트림)")
  .option("--keep-empty-paragraphs", "빈 문단 보존 — 본문은 빈 paragraph 블록, 표 셀은 빈 줄로 (#57, 기본 off: 빈 문단 제거)")
  .option("--include-field-placeholders", "미기입 누름틀 안내문도 출력 — 빈 서식의 칸 용도 보존 (#92, 기본 off: 인쇄되지 않는 안내문 제외)")
  .option("--inline-images", "이미지를 base64 data URI 로 마크다운에 인라인 (BMP→PNG 압축, HWP5 전용 — 인라인된 경우만 파일 미저장, 그 외 포맷은 저장 유지)")
  .option("--image-refs", "--format json 에서 이미지 바이트를 인라인하지 않고 파일 참조(images/<문서 이름>/<파일명>)만 남김 (#65 — 이미지가 수백 장인 문서의 직렬화 한계 회피, -o/-d 와 함께 사용)")
  .option("--password <pw>", "암호로 보호된 문서의 열기 암호 (#59, HWPX·HWP3·HWP5. 한컴 DRM 문서는 해당 없음)")
  .option("--html-tables", "모든 표를 HTML 로 — 파이프 표도 HTML 표로, 태그마다 한 줄씩 들여써 냄")
  .option("--table-format <format>", "표 출력 형식: gfm — 모든 표를 HTML 없이 GFM 파이프 표로, 셀 안 표는 부모 뒤 독립 표 + 관계 표지(<!-- <table … /> -->) (RAG 색인용, --html-tables 와 함께 못 씀)")
  .option("--keep-layout-tables", "테두리가 안 보이는 틀 표도 원본 표 구조 그대로 (기본: 보이는 대로 — 틀은 글, 칸으로 조립한 분수는 수식). patch 로 되돌릴 편집본은 이 옵션으로 뽑는다")
  .option("--script-tags", "위·아래첨자를 <sup>·<sub> 로 표기 — PDF 는 기본 끔(논문·수식 PDF 에 권장), HWPX·HWP·DOCX 는 기본 켬")
  .option("--no-script-tags", "첨자 표기 끄기 — 모든 형식에서 평문(\"104 m2\")")
  .option("--plain", "평문 Markdown — 그림 자리 표시·링크 URL·밑줄/굵게 표기를 빼고 글만 (제목·목록·표 구조는 유지, 색인·RAG 용)")
  .option("--no-images", "이미지 바이트를 추출·출력하지 않음: 글자만 필요할 때 (그림 자리 표시는 남김, PDF 는 PNG 인코딩을 건너뜀)")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (files: string[], opts) => {
    const validFormats = ["markdown", "json", "chunks"]
    if (!validFormats.includes(opts.format)) {
      process.stderr.write(`[kordoc] 지원하지 않는 형식: ${opts.format} (markdown, json, chunks)\n`)
      process.exit(1)
    }
    if (opts.tableFormat !== undefined && opts.tableFormat !== "gfm") {
      process.stderr.write(`[kordoc] 지원하지 않는 표 형식: ${opts.tableFormat} (gfm)\n`)
      process.exit(1)
    }
    if (opts.tableFormat && opts.htmlTables) {
      process.stderr.write(`[kordoc] --table-format 과 --html-tables 는 함께 쓸 수 없습니다\n`)
      process.exit(1)
    }
    // -o는 단일 파일 전용 — 다중 파일에서 무음 무시되지 않게 경고
    if (opts.output && files.length > 1) {
      process.stderr.write(`[kordoc] ⚠️ -o/--output 은 단일 파일 전용이라 무시됩니다 — 다중 파일은 -d/--out-dir 를 사용하세요\n`)
    }
    const jobs = Number(opts.jobs)
    if (!/^\d+$/.test(opts.jobs) || !Number.isSafeInteger(jobs) || jobs < 1) {
      program.error("--jobs must be a positive integer")
    }
    if (jobs > 1 && files.length > 1) {
      if (!opts.outDir) program.error("--jobs > 1 requires --out-dir for multiple files")
      try {
        if (!await convertParallel(files, opts, jobs)) process.exitCode = 1
      } catch (err) {
        program.error(sanitizeError(err))
      }
    } else {
      if (opts.outDir && files.length > 1) {
        try { assertDistinctStems(files) } catch (err) { program.error(sanitizeError(err)) }
      }
      if (!await convertFiles(files, opts)) process.exitCode = 1
    }
  })

registerDocCommands(program)
registerGenerateCommands(program)
registerRenderCommands(program)
registerSystemCommands(program)
registerWorkerCommands(program)
registerBatchWorker(program)

// stdout 은 마크다운·JSON·생성 바이너리 채널 — pdfjs 등이 console 로 찍는 경고가 섞이지 않게 stderr 로
// (parse-worker·MCP 와 같은 처리). setup 은 사람이 보는 설치 화면이라 그대로 둔다
program.hook("preAction", (_program, action) => {
  if (action.name() !== "setup") routeConsoleToStderr()
})

// 출처를 node 로 고정 — 정하지 않으면 commander 가 process.versions.electron 을 보고 Electron 앱 방식(argv[1]부터)으로
// 읽어, Electron 을 node 로 띄운(ELECTRON_RUN_AS_NODE) 데스크톱 앱에서 cli.js 자신이 입력 파일로 잡힌다
program.parse(process.argv, { from: "node" })
