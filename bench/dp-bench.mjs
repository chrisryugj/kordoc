#!/usr/bin/env node
// Upstage DP-Bench 예측 생성기. 실행 방법은 docs/benchmarks.md 의 DP-Bench 항목.
import { execFileSync } from "node:child_process"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parse } from "../dist/index.js"

const textCategories = { paragraph: "paragraph", heading: "heading1", list: "list" }
const htmlEntities = { "&": "&amp;", "<": "&lt;", ">": "&gt;" }
const escapeHtml = text => text.replace(/[&<>]/g, ch => htmlEntities[ch])

function plainText(text = "") {
  return text
    .replace(/(\\)?(<\/?(?:u|sup|sub)>|\\\$)/g, (_, escaped, token) => {
      if (escaped) return token
      return token === "\\$" ? "$" : ""
    })
    .replace(/\s+/gu, " ").trim()
}

function tableHtml(table) {
  const covered = Array.from({ length: table.rows }, () => new Set())
  const rows = covered.map((columns, row) => {
    const cells = []
    for (let column = 0; column < table.cols; column++) {
      if (columns.has(column)) continue
      const cell = table.cells[row]?.[column]
      if (!cell) continue

      for (let r = row; r < row + cell.rowSpan; r++) {
        for (let c = column; c < column + cell.colSpan; c++) covered[r]?.add(c)
      }
      const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ""
      const colSpan = cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ""
      const content = cell.blocks?.length ? cell.blocks.map(block => {
        if (block.table) return tableHtml(block.table)
        if (block.type === "image") return ""
        return escapeHtml(plainText(block.text))
      }).filter(Boolean).join(" ") : escapeHtml(plainText(cell.text))
      cells.push(`<td${rowSpan}${colSpan}>${content}</td>`)
    }
    return `<tr>${cells.join("")}</tr>`
  })
  return `<table>${rows.join("")}</table>`
}

function pageSize(path) {
  const info = execFileSync("pdfinfo", ["-box", path], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })
  if (!/^Pages:\s+1$/m.test(info) || !/^Page rot:\s+0$/m.test(info)) {
    throw new Error(`Expected a single unrotated page in ${path}`)
  }
  const crop = info.match(/^CropBox:\s+([^\n]+)$/m)?.[1].trim().split(/\s+/).map(Number)
  if (crop?.length !== 4 || !crop.every(Number.isFinite) || crop[2] <= crop[0] || crop[3] <= crop[1]) {
    throw new Error(`Invalid CropBox in ${path}`)
  }
  return { width: crop[2] - crop[0], height: crop[3] - crop[1] }
}

function coordinates(bbox, { width, height }) {
  // 공식 평가기는 모든 요소의 다각형을 읽는다. 상자가 없는 글은 쪽 밖 좌표를 준다.
  if (!bbox) return Array.from({ length: 4 }, () => ({ x: -1, y: -1 }))
  const left = bbox.x / width
  const top = 1 - (bbox.y + bbox.height) / height
  const right = left + bbox.width / width
  const bottom = top + bbox.height / height
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]
}

function elementsFromBlocks(blocks, size) {
  const elements = []
  function add(category, bbox, text = "", html = "") {
    elements.push({
      category,
      coordinates: coordinates(bbox, size),
      id: elements.length,
      page: 1,
      content: { text, html, markdown: "" },
    })
  }
  function visit(block) {
    if (block.table) {
      const table = block.table
      function addCaption() {
        if (table.captionBlocks?.length) table.captionBlocks.forEach(visit)
        else if (table.caption) add("caption", undefined, plainText(table.caption))
      }
      if (!table.captionBelow) addCaption()
      add("table", block.bbox, "", tableHtml(table))
      if (table.captionBelow) addCaption()
    } else if (block.type === "image") {
      add("figure", block.bbox)
    } else {
      const category = textCategories[block.type]
      const text = plainText(block.text)
      if (category && text) add(category, block.bbox, text)
    }
    if (block.footnoteBlocks?.length) block.footnoteBlocks.forEach(visit)
    else if (block.footnoteText) add("footnote", undefined, plainText(block.footnoteText))
    block.children?.forEach(visit)
  }
  blocks.forEach(visit)
  return elements
}

const [root, outputPath] = process.argv.slice(2)
if (!root || !outputPath || process.argv.length !== 4) {
  console.error("사용법: node bench/dp-bench.mjs <DP-Bench 디렉토리> <예측 JSON 경로>")
  process.exit(1)
}

const pdfDir = join(root, "dataset", "pdfs")
const reference = JSON.parse(await readFile(join(root, "dataset", "reference.json"), "utf8"))
const files = (await readdir(pdfDir)).filter(file => file.endsWith(".pdf")).sort()
if (files.length !== 200 || Object.keys(reference).length !== 200 || !files.every(file => Object.hasOwn(reference, file))) {
  throw new Error("DP-Bench requires all 200 PDFs named in dataset/reference.json")
}

const predictions = {}
for (const [index, file] of files.entries()) {
  const path = join(pdfDir, file)
  const size = pageSize(path)
  const pdf = await readFile(path)
  const start = performance.now()
  const result = await parse(pdf, { ocr: false })
  const time_sec = (performance.now() - start) / 1000
  if (!result.success) throw new Error(`${file}: ${result.error}`)
  if (result.fileType !== "pdf" || result.pageCount !== 1) throw new Error(`${file}: expected one parsed PDF page`)

  predictions[file] = { elements: elementsFromBlocks(result.blocks, size), time_sec }
  if ((index + 1) % 20 === 0) console.log(`${index + 1}/${files.length} PDF`)
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify(predictions, null, 2) + "\n")
console.log(outputPath)
