/**
 * 괘선 없는 표(cluster-detector) 칸 글 — 칸 아이템을 글줄로 묶고(clusterCellLines) 글줄을 잇는다(joinClusterCellLines).
 */

import { spaceGapThreshold } from "./cell-text.js"
import { isCjkLatinAutospace } from "./text-line.js"
import { cellLineWraps, startsNewItem, wrapJoiner, type WrapLexicon } from "./line-wrap.js"
import type { ClusterItem } from "./cluster-detector.js"

/** 칸 글줄 — 잇기 판정 재료(왼끝·오른끝·첫 글자 폭·줄 끝 공백 글리프) */
export interface ClusterCellLine { text: string; left: number; right: number; fontSize: number; firstCharW: number; spaceAfter?: boolean }

/**
 * 칸 아이템 → 글줄. 글자를 한 자씩 따로 긋는 제작기(지자체 예산 시스템 — 부천 세출예산사업명세서 굴림체, 글자마다
 * 0~1pt 간격)는 칸 아이템이 글자 하나씩이라 종전처럼 공백으로 이으면 "2 0 , 7 7 5 , 6 6 1"·"활 성 화" 가 된다.
 * 선 표 칸(cellTextToString)과 같게 간격이 낱말 공백 임계(spaceGapThreshold)를 넘거나 pdfjs 공백 힌트가 있을 때만 띄운다.
 * 한 행에 합쳐진 여러 줄(mergeMultiLineRows)은 세로로 겹치는 아이템끼리 한 줄로 묶어 위→아래로 세운다 — x 로만
 * 세우면 글자 단위 칸에서 두 줄의 글자가 번갈아 섞인다. 첨자(각주 부호·원문자)는 본문 줄과 세로로 겹쳐 같은 줄에 든다
 */
export function clusterCellLines(items: ClusterItem[]): ClusterCellLine[] {
  const hOf = (i: ClusterItem) => (i.h > 0 ? i.h : i.fontSize)
  const lines: { bottom: number; top: number; items: ClusterItem[] }[] = []
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const bottom = it.y, top = it.y + hOf(it)
    const line = lines.find(l => Math.min(l.top, top) - Math.max(l.bottom, bottom) >= Math.min(l.top - l.bottom, top - bottom) * 0.5)
    if (line) { line.items.push(it); line.bottom = Math.min(line.bottom, bottom); line.top = Math.max(line.top, top) }
    else lines.push({ bottom, top, items: [it] })
  }
  return lines.sort((a, b) => b.top - a.top).map(({ items: line }) => {
    line.sort((a, b) => a.x - b.x)
    let s = line[0].text
    for (let i = 1; i < line.length; i++) {
      const gap = line[i].x - (line[i - 1].x + line[i - 1].w)
      const fs = (line[i].fontSize + line[i - 1].fontSize) / 2
      s += (!isCjkLatinAutospace(line[i - 1].text, line[i].text, gap, fs) && ((line[i].hasSpaceBefore && gap >= fs * 0.05) || gap > spaceGapThreshold(fs)) ? " " : "") + line[i].text
    }
    const last = line.reduce((a, b) => (b.x + b.w > a.x + a.w ? b : a))
    return { text: s, left: line[0].x, right: last.x + last.w, fontSize: line[0].fontSize, spaceAfter: last.spaceAfter,
      firstCharW: line[0].w / Math.max(1, [...line[0].text.replace(/<\/?u>|~~/g, "")].length) }
  })
}

/**
 * 칸 글줄 잇기 — 종전엔 늘 공백으로 이어 어절 가운데서 꺾인 줄("남⏎편이"·"보았더⏎니")이 띄워졌다(SO-SUEOP 쪽마다 둘러친 틀 표 —
 * 괘선 없는 표는 PDF 줄 하나가 행 하나라 이어지는 줄을 앞 행 칸에 붙인다). 칸 상자를 모르니 열 글줄들의 왼끝·오른끝(box)을 칸 안쪽으로
 * 보고, 오른끝까지 차서 꺾인(cellLineWraps) 줄을 선 표 칸(cellTextToString)·본문과 같은 어절 판정(wrapJoiner)으로 붙인다.
 * 줄 끝에 공백 글리프가 찍힌(spaceAfter) 꺾임은 어절 경계라 띄운다. 두 줄 다 열 왼끝 가까이(WRAP_INDENT_MAX 글자 안 — 들여쓰기·내어쓰기)에서
 * 시작해야 한 문단의 꺾임이다 — 가운데 맞춘 "부      칙" 의 "칙" 도 열 오른끝에 닿아 아래 "이 규칙은" 과 붙었다(제약산업 시행규칙 별첨).
 * 꺾인 낱말은 밑줄도 이어진다 — 밑줄 친 개정 글 끝 "…계약의 체" 와 밑줄 없는 다음 줄 "결" 은 원문에서도 다른 글상자다(신구조문 대비표)
 */
const WRAP_INDENT_MAX = 3

export function joinClusterCellLines(lines: ClusterCellLine[], box: { x1: number; x2: number }, lex?: WrapLexicon): string {
  let out = lines[0]?.text ?? ""
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i]
    const join = !a.spaceAfter && cellLineWraps(box, box.x1, a.right, a.fontSize, b.firstCharW) &&
      a.left - box.x1 <= WRAP_INDENT_MAX * a.fontSize && b.left - box.x1 <= WRAP_INDENT_MAX * b.fontSize &&
      /<\/u>$/.test(a.text) === /^<u>/.test(b.text) &&
      !startsNewItem(out, b.text) && wrapJoiner(out, b.text, lex, false) === ""
    out += (join ? "" : " ") + b.text
  }
  return out
}
