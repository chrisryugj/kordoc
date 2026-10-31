/**
 * HWP 5.x patch 의 문단 바이트 스테이징 — PARA_TEXT 를 [선두 비가시 control][글 코어][말미 control/문단끝]로 나눠 바뀐 자리만 고치고
 * PARA_HEADER nChars·CHAR_SHAPE 위치·LINE_SEG 를 맞춘다. 섹션 스캔·편집 매핑·스트림 재조립은 hwp5-patch.ts
 */

import { createParaTextState, appendParaText, isExtendedOnlyCtrlChar, TAG_PARA_TEXT } from "../hwp5/record.js"
import { alignedTextEdits } from "./inline-edit.js"
import { restyleInserted, type HwpInsertStyle } from "./hwp5-char-shape.js"
import type { ScanPara5, SectionScan5 } from "./hwp5-patch.js"

/**
 * PARA_TEXT를 [선두 비가시 control][순수 텍스트 코어][말미 비가시 control/문단끝]로 분해.
 * - 코어는 0x20+ 일반 문자(서로게이트 포함)와 강제 줄바꿈(0x000a)만. 탭·하이픈·NBSP 등 그 외
 *   "가시 control"이 코어 안이나 가장자리에 있으면 텍스트 재매핑이 모호하므로 null(미지원).
 * - 선두/말미에는 개체 앵커(0x0b)·필드(0x03/0x04)·자동번호 등 "비가시 control"과 문단끝(0x0d)만 허용.
 * appendParaText(record.ts)의 바이트 전진 규칙을 그대로 미러한다 — 어긋나면 한컴 변조감지.
 */
interface ParaTok { start: number; end: number; units: number; plain: boolean; visible: boolean }

/** PARA_TEXT 낱자 토큰 (바이트 범위) — appendParaText 의 바이트 전진 규칙 그대로. 데이터를 정확히 못 먹으면 null */
function tokenizeParaText(data: Buffer): ParaTok[] | null {
  const toks: ParaTok[] = []
  let i = 0
  while (i + 1 < data.length) {
    const ch = data.readUInt16LE(i)
    const start = i
    i += 2
    if (ch >= 0x20) {
      let units = 1
      if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < data.length) {
        const lo = data.readUInt16LE(i)
        if (lo >= 0xdc00 && lo <= 0xdfff) { i += 2; units = 2 }
      }
      toks.push({ start, end: i, units, plain: true, visible: true })
      continue
    }
    switch (ch) {
      case 0x00: case 0x18: case 0x19: case 0x1e: case 0x1f:
        // 줄바꿈/고정폭·비분리 공백/하이픈 — 가시(텍스트에 기여), 2바이트
        toks.push({ start, end: i, units: 1, plain: false, visible: true }); break
      case 0x09: // 탭 — 가시, 2+14바이트
        if (i + 14 <= data.length) i += 14
        toks.push({ start, end: i, units: 1, plain: false, visible: true }); break
      case 0x0d: // 문단끝 — 비가시
        toks.push({ start, end: i, units: 1, plain: false, visible: false }); break
      case 0x0a: // 강제 줄바꿈(char 2바이트) — 단, 뒤에 0x000b 수식 래퍼면 확장 처리
        if (i + 16 <= data.length && data.readUInt16LE(i) === 0x000b) {
          i += 16; toks.push({ start, end: i, units: 1, plain: false, visible: false })  // 수식 등 비가시
        } else {
          // bare 0x000a = 2바이트 줄바꿈. 14바이트 소비 금지(appendParaText와 대칭 — 어긋나면 한컴 변조감지).
          toks.push({ start, end: i, units: 1, plain: true, visible: true })            // "\n" 가시, 2바이트
        }
        break
      default: {
        const ext = isExtendedOnlyCtrlChar(ch)
        const inl = (ch >= 4 && ch <= 9) || (ch >= 19 && ch <= 20)
        if ((ext || inl) && i + 14 <= data.length) i += 14
        toks.push({ start, end: i, units: 1, plain: false, visible: false })  // 개체/필드 등 비가시
        break
      }
    }
  }
  if (i !== data.length) return null  // 토큰화가 데이터를 정확히 소비 못함 — 안전상 미지원
  return toks
}

export function splitParaText(data: Buffer):
  | { prefix: Buffer; prefixUnits: number; core: string; suffix: Buffer; suffixUnits: number }
  | null {
  const toks = tokenizeParaText(data)
  if (!toks) return null

  let firstP = -1, lastP = -1
  for (let k = 0; k < toks.length; k++) if (toks[k].plain) { if (firstP < 0) firstP = k; lastP = k }
  if (firstP < 0) {
    // 일반 텍스트가 전혀 없는 문단(빈/개체만) — 가시 control이 있으면 위치 모호로 미지원.
    // 문단끝(0x0d)부터를 suffix로 삼아 새 텍스트가 [선두 개체 뒤, 문단끝 앞]에 들어가게 한다.
    if (toks.some(t => t.visible)) return null
    let cut = data.length
    for (const t of toks) if (data.readUInt16LE(t.start) === 0x0d) { cut = t.start; break }
    return {
      prefix: data.subarray(0, cut),
      prefixUnits: cut / 2,
      core: "",
      suffix: data.subarray(cut),
      suffixUnits: (data.length - cut) / 2,
    }
  }
  for (let k = firstP; k <= lastP; k++) if (!toks[k].plain) return null            // 코어 내부에 control
  for (let k = 0; k < firstP; k++) if (toks[k].visible) return null                // 선두에 가시 control
  for (let k = lastP + 1; k < toks.length; k++) if (toks[k].visible) return null   // 말미에 가시 control

  const prefixEnd = toks[firstP].start
  const coreEnd = toks[lastP].end
  // nChars·char shape position은 WCHAR 개수 단위 — control의 확장 WCHAR(개체/필드=8 WCHAR 등)도
  // 모두 포함한다. 바이트÷2로 계산해야 한컴의 nChars(=PARA_TEXT WCHAR 총수)와 일치한다.
  const prefixUnits = prefixEnd / 2
  const suffixUnits = (data.length - coreEnd) / 2
  return {
    prefix: data.subarray(0, prefixEnd),
    prefixUnits,
    core: data.subarray(prefixEnd, coreEnd).toString("utf16le"),
    suffix: data.subarray(coreEnd),
    suffixUnits,
  }
}

/**
 * CHAR_SHAPE(글자모양 run) 레코드를 코어 시작 위치 기준으로 재구성.
 * 선두 control 영역의 run은 보존하고 코어 이후는 코어 첫 글자 서식으로 단일화한다
 * — 텍스트 길이가 바뀌어도 position이 안정 (기존 "첫 run 통일" 정책의 일반화).
 */
function rebuildCharShape(csData: Buffer, coreStartUnit: number): { buf: Buffer; count: number } {
  const pairs: Array<[number, number]> = []
  for (let o = 0; o + 8 <= csData.length; o += 8) pairs.push([csData.readUInt32LE(o), csData.readUInt32LE(o + 4)])
  if (pairs.length === 0) return { buf: Buffer.from(csData.subarray(0, 8)), count: 1 }
  let coreId = pairs[0][1]
  for (const [p, id] of pairs) if (p <= coreStartUnit) coreId = id
  const kept = pairs.filter(([p]) => p < coreStartUnit)
  if (kept.length === 0 || kept[kept.length - 1][1] !== coreId) kept.push([coreStartUnit, coreId])
  const buf = Buffer.alloc(kept.length * 8)
  kept.forEach(([p, id], k) => { buf.writeUInt32LE(p >>> 0, k * 8); buf.writeUInt32LE(id >>> 0, k * 8 + 4) })
  return { buf, count: kept.length }
}

/** CHAR_SHAPE 에서 [at, end) 글을 바로 앞 글자 모양으로 — end 뒤 글 모양은 그대로, 같은 모양이 잇단 run 은 합친다 */
function restyleSpan(csData: Buffer, at: number, end: number): { buf: Buffer; count: number } {
  const pairs: Array<[number, number]> = []
  for (let o = 0; o + 8 <= csData.length; o += 8) pairs.push([csData.readUInt32LE(o), csData.readUInt32LE(o + 4)])
  const idAt = (p: number): number => pairs.reduce((id, [q, v]) => (q <= p ? v : id), pairs[0][1])
  const out = pairs.filter(([p]) => p < at || p > end)
  out.push([at, idAt(at - 1)], [end, idAt(end)])
  out.sort((a, b) => a[0] - b[0])
  const kept = out.filter((r, k) => k === 0 || r[1] !== out[k - 1][1])
  const buf = Buffer.alloc(kept.length * 8)
  kept.forEach(([p, id], k) => { buf.writeUInt32LE(p >>> 0, k * 8); buf.writeUInt32LE(id >>> 0, k * 8 + 4) })
  return { buf, count: kept.length }
}

/**
 * CHAR_SHAPE 부분 수정: [start, end) 를 길이 newLen 글로 바꿀 때 run 경계를 옮긴다. start 이전 run 은 그대로(바뀐 글은
 * start 자리 run 의 모양을 받는다), 범위 안에서 시작한 마지막 run 은 바뀐 글 바로 뒤로, end 뒤 run 은 길이 차만큼 민다.
 */
function shiftCharShape(csData: Buffer, start: number, end: number, newLen: number): { buf: Buffer; count: number } {
  const pairs: Array<[number, number]> = []
  for (let o = 0; o + 8 <= csData.length; o += 8) pairs.push([csData.readUInt32LE(o), csData.readUInt32LE(o + 4)])
  if (pairs.length === 0) return { buf: Buffer.from(csData.subarray(0, 8)), count: 1 }
  const delta = newLen - (end - start)
  const out: Array<[number, number]> = []
  let inRange: number | undefined
  for (const [p, id] of pairs) {
    if (p <= start) out.push([p, id])
    else if (p <= end) inRange = id
    else {
      if (inRange !== undefined) { out.push([start + newLen, inRange]); inRange = undefined }
      out.push([p + delta, id])
    }
  }
  if (inRange !== undefined) out.push([start + newLen, inRange])
  const kept: Array<[number, number]> = []
  for (const [p, id] of out) {
    const last = kept[kept.length - 1]
    if (last && last[0] === p) last[1] = id
    else if (last && last[1] === id) continue
    else kept.push([p, id])
  }
  const buf = Buffer.alloc(kept.length * 8)
  kept.forEach(([p, id], k) => { buf.writeUInt32LE(p >>> 0, k * 8); buf.writeUInt32LE(id >>> 0, k * 8 + 4) })
  return { buf, count: kept.length }
}

/**
 * LINE_SEG(0x45, 36B/세그) 다중줄 합성 — HWP5 binary 구조 실측(kordoc 최초 파싱):
 * [textpos, vPos, lineH, textH, baseline, lineSpc, hStart, width, tag] 각 int32.
 * 실파일은 세그먼트마다 vPos만 pitch(=lineH+lineSpc)씩 증가하고 나머지 기하는 전 세그
 * 동일 → seg0을 통째 복사해 textpos·vPos만 줄마다 바꾼다. 한컴은 LINE_SEG를 재계산하지
 * 않고 그대로 렌더하므로 1세그면 줄바꿈(0x000a)을 한 줄로 씹는다(실측) — 줄 수만큼
 * 합성해야 실제로 나뉜다. pitch를 모르는 기하(전부 0 등)면 null — 호출부는 원본 유지.
 * @param startUnits 코어 시작 WCHAR 위치(선두 control 포함) — 둘째 줄부터의 textpos 기준
 */
function synthesizeLineSegs(lineSegData: Buffer, newRaw: string, startUnits: number): { buf: Buffer; count: number } | null {
  if (lineSegData.length < 36) return null
  const seg0 = lineSegData.subarray(0, 36)
  const vPos0 = seg0.readInt32LE(4)
  const pitch = seg0.readInt32LE(8) + seg0.readInt32LE(20) // lineH + lineSpc
  if (pitch <= 0) return null
  const lines = newRaw.split("\n")
  const segs: Buffer[] = []
  let pos = startUnits
  for (let k = 0; k < lines.length; k++) {
    const s = Buffer.from(seg0)
    s.writeUInt32LE((k === 0 ? 0 : pos) >>> 0, 0)   // textpos: 첫 줄은 문단 처음(prefix 포함)
    s.writeInt32LE(vPos0 + k * pitch, 4)            // vPos: 줄마다 한 줄 아래로
    segs.push(s)
    pos += lines[k].length + 1                      // 다음 줄 시작 = 이 줄 문자수 + 줄바꿈 1
  }
  return { buf: Buffer.concat(segs), count: lines.length }
}

/**
 * 문단 텍스트 교체를 섹션 repl 맵에 스테이징.
 * PARA_TEXT 치환 + PARA_HEADER nChars + CHAR_SHAPE/LINE_SEG 정합화.
 * 개체 앵커·필드 등 비가시 control이 문단 가장자리에 있어도 그 블록은 보존하고 코어만 교체한다.
 */
export function stageParaPatch(
  scan: SectionScan5, para: ScanPara5, newPlain: string,
  skip: (reason: string) => number,
  /** 줄 나눔 정보(LINE_SEG)를 지우지 않고 원본 기준으로 맞춘다 (PatchOptions.keepLineseg) */
  keepLineseg: boolean,
  /** 문단의 IR 평문: 주면 바뀐 자리만 고친다(원문 균등 띄어쓰기·글자 모양 run 유지). 못 맞대면 코어 통째 교체 */
  origPlain?: string,
  /** 바뀐 자리 새 글을 마크다운 서식대로 (글자 모양 구간을 서식만 다른 짝으로) */
  style?: HwpInsertStyle,
): number {
  if (!scan.safe) return skip("섹션 레코드 재직렬화 불일치 — 안전을 위해 이 섹션은 미지원")
  if (para.textIdx === -2) return skip("복수 PARA_TEXT 레코드 문단 — 미지원 (v1)")
  // 컨트롤 문자(개체 앵커/필드 등)는 splitParaText에서 가장자리 보존 가능 여부를 판정한다.
  if (para.rangeTagCount > 0) return skip("범위 태그(형광펜/교정부호) 문단 — 미지원 (v1)")
  // LINE_SEG 없는 문단(patch 가 지운 문단·한컴이 다시 짤 문단)도 고친다 — 다시 짜는 건 한컴 몫
  if (para.charShapeIdx < 0) return skip("문단 레코드 구성 비정형 — 미지원")
  if (scan.repl.has(para.headerIdx)) return skip("동일 문단 중복 수정 — 첫 수정만 적용")
  // \n(0x000a, 강제 줄바꿈)은 허용 — 코어에 2바이트 char 컨트롤로 기록해 다중줄 값을 지원한다.
  // 그 외 제어문자(탭·필드·특수공백 등)는 재매핑이 모호하므로 거부.
  if (/[\u0000-\u0009\u000b-\u001f]/.test(newPlain)) return skip("새 텍스트에 제어문자 포함 — 미지원")

  const records = scan.records
  const headerRec = records[para.headerIdx]
  const charShapeRec = records[para.charShapeIdx]
  if (charShapeRec.data.length < 8) {
    return skip("CHAR_SHAPE 레코드 비정형 — 미지원")
  }

  // PARA_TEXT 레코드가 없는 빈 문단(한컴 생략 저장형) — PARA_HEADER 직후에 신규 삽입.
  // 원본 nChars(하위 31비트)가 1이면 문단끝 1자를 계상한 것이므로 0x0d를 붙여 정합 유지.
  if (para.textIdx === -1) {
    const nCharsLow = para.nCharsRaw & 0x7fffffff
    if (nCharsLow > 1) return skip("PARA_TEXT 없는 문단의 nChars 비정형 — 미지원")
    const paraEnd = nCharsLow === 1 ? Buffer.from([0x0d, 0x00]) : Buffer.alloc(0)
    const at = para.headerIdx + 1
    const list = scan.inserts.get(at) ?? []
    list.push({ tagId: TAG_PARA_TEXT, level: headerRec.level + 1, data: Buffer.concat([Buffer.from(newPlain, "utf16le"), paraEnd]) })
    scan.inserts.set(at, list)

    const newHeader = Buffer.from(headerRec.data)
    newHeader.writeUInt32LE(((para.nCharsRaw & 0x80000000) | (newPlain.length + nCharsLow)) >>> 0, 0)
    const cs = rebuildCharShape(charShapeRec.data, 0)
    scan.repl.set(para.charShapeIdx, cs.buf)
    newHeader.writeUInt16LE(cs.count, 12)
    stageLineSegs(scan, para, newHeader, newPlain, 0, newPlain.length + nCharsLow, keepLineseg)
    scan.repl.set(para.headerIdx, newHeader)
    return 1
  }

  // 미기입 누름틀 안내문이 든 문단 — 안내문을 뺀 보이는 글로 맞대 바뀐 자리만 고치고, 누름틀 자리에 쓴 값은 누름틀에 채운다
  if (para.guides.length) {
    return stageInlineEdit(scan, para, newPlain, origPlain ?? para.rawText.trim(), keepLineseg, style)
      ? 1 : skip("미기입 누름틀 문단 — 편집이 누름틀·제어 문자에 걸쳐 미지원")
  }

  const textRec = records[para.textIdx]

  // PARA_TEXT를 [선두 control][텍스트 코어][말미 control/문단끝]로 분해
  const seg = splitParaText(textRec.data)
  if (!seg) {
    if (origPlain !== undefined && stageInlineEdit(scan, para, newPlain, origPlain, keepLineseg, style)) return 1
    return skip(para.ctrlMask !== 0
      ? "컨트롤 문자(탭/필드/특수공백 등 텍스트 중간) 포함 문단 — 미지원 (v1)"
      : "PARA_TEXT 재구성 불일치 — 원문 보존 불가로 미지원")
  }
  // 코어가 추출 텍스트(rawText)와 일치해야 안전 (가시 control 없음 보장)
  if (seg.core !== para.rawText) return skip("PARA_TEXT 재구성 불일치 — 원문 보존 불가로 미지원")

  // 바뀐 자리만 고친다: IR 평문은 공백을 접어 보이므로("대    상" → "대 상") 통째 교체는 균등 띄어쓰기를 접고
  // 글자 모양을 첫 글자 하나로 합친다. 원문 코어와 IR 평문을 맞대어 diff 범위만 바꾸고 CHAR_SHAPE run 은 위치만 민다.
  // 강제 줄바꿈(0x000a)은 코어와 IR 양쪽에 "\n" 한 글자라 그대로 맞댄다
  // 고친 자리는 낱말 덩어리마다 — 뒤에서부터 적용하면 앞 자리 좌표가 그대로다
  const edits = origPlain !== undefined ? alignedTextEdits(para.rawText, origPlain, newPlain) : null
  const desc = edits?.length ? [...edits].sort((x, y) => y.start - x.start) : undefined
  // 원문 leading/trailing 공백 보존 (IR은 트림된 텍스트)
  const lead = para.rawText.match(/^\s*/)![0]
  const trail = para.rawText.match(/\s*$/)![0]
  const newRaw = desc ? desc.reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), para.rawText)
    : para.rawText.trim() === para.rawText ? newPlain : lead + newPlain + trail

  // PARA_TEXT = 선두 control + 새 텍스트 + 말미 control/문단끝 (control 블록 바이트 보존)
  const newText = Buffer.concat([seg.prefix, Buffer.from(newRaw, "utf16le"), seg.suffix])
  scan.repl.set(para.textIdx, newText)

  // PARA_HEADER — nChars(상위 플래그 비트 보존) + charShapeCount/lineSegCount
  const newHeader = Buffer.from(headerRec.data)
  const nChars = seg.prefixUnits + newRaw.length + seg.suffixUnits
  newHeader.writeUInt32LE(((para.nCharsRaw & 0x80000000) | nChars) >>> 0, 0)

  // CHAR_SHAPE: 부분 수정이면 run 위치만 민다(뒤 자리부터), 통째 교체면 선두 control run 보존 + 코어는 첫 글자 서식으로 단일화
  let cs = desc
    ? desc.reduce((c, e) => shiftCharShape(c.buf, seg.prefixUnits + e.start, seg.prefixUnits + e.end, e.text.length), { buf: charShapeRec.data, count: 0 })
    : rebuildCharShape(charShapeRec.data, seg.prefixUnits)
  // 새 글 글자 모양 — 앞 자리부터 새 좌표(앞 편집들의 길이 차를 더한 자리)로. 문단 끝에 붙인 글은 끝 표시 말고 마지막 글자 것을
  // 받고(끝 표시만 위첨자인 문단), 마크다운 서식이 다르면 서식만 다른 짝으로
  let delta = 0
  for (const e of desc ? [...desc].reverse() : []) {
    const at = e.start + delta
    if (e.text) {
      const landing = e.start === e.end && e.start === para.rawText.length && at > 0 ? at - 1 : at
      const toEnd = e.end === para.rawText.length && seg.suffix.length === 2 && seg.suffix.readUInt16LE(0) === 0x0d
      cs = restyleInserted(cs.buf, seg.prefixUnits + at, e.text, e.at ?? 0, style, seg.prefixUnits + landing, toEnd) ?? cs
    }
    delta += e.text.length - (e.end - e.start)
  }
  scan.repl.set(para.charShapeIdx, cs.buf)
  newHeader.writeUInt16LE(cs.count, 12)

  stageLineSegs(scan, para, newHeader, newRaw, seg.prefixUnits, nChars, keepLineseg)

  scan.repl.set(para.headerIdx, newHeader)
  return 1
}

/**
 * 글 가운데 탭·필드·특수 공백 같은 제어 문자가 든 문단 — 바뀐 자리가 일반 글자만 덮으면 그 바이트만 바꾼다. 제어 문자는 바이트째
 * 그대로 두고, CHAR_SHAPE run 은 위치만 민다. 편집이 제어 문자에 걸치거나 원문과 못 맞대면 false
 */
function stageInlineEdit(scan: SectionScan5, para: ScanPara5, newPlain: string, origPlain: string, keepLineseg: boolean, style?: HwpInsertStyle): boolean {
  if (origPlain.includes("\n") || newPlain.includes("\n")) return false
  const data = scan.records[para.textIdx].data
  const toks = tokenizeParaText(data)
  if (!toks) return false
  // 낱자마다 글 기여(탭 "\t"·NBSP·고정폭 빈칸, 그 밖 제어 문자는 없음)를 추출 규칙 그대로 얻는다. 미기입 누름틀 안내문 낱자는
  // rawText 에서 빠졌으니 글 기여 없이 숨긴다(편집이 건드리면 안 된다)
  const spans: Array<{ from: number; to: number; tok: ParaTok; hidden: boolean }> = []
  /** 누름틀 안내문마다 보이는 글 위치와 바이트 범위 */
  const guideAt = new Map<number, { vis: number; byteStart: number; byteEnd: number }>()
  let text = "", full = 0
  for (const tok of toks) {
    const st = createParaTextState()
    appendParaText(st, data.subarray(tok.start, tok.end))
    const g = st.text.length > 0 ? para.guides.findIndex(x => full >= x.start && full + st.text.length <= x.end) : -1
    const hidden = g >= 0
    if (hidden) {
      const at = guideAt.get(g)
      if (at) at.byteEnd = tok.end
      else guideAt.set(g, { vis: text.length, byteStart: tok.start, byteEnd: tok.end })
    }
    const part = hidden ? "" : st.text
    spans.push({ from: text.length, to: text.length + part.length, tok, hidden })
    text += part
    full += st.text.length
  }
  if (text !== para.rawText) return false
  // 보이는 글이 비었으면(누름틀만 든 칸 등) 맨 앞에 넣는 편집 — alignedTextEdits 는 빈 글을 맞대지 않는다
  const found = !origPlain && !text.trim() ? [{ start: 0, end: 0, text: newPlain, at: 0 }] : alignedTextEdits(text, origPlain, newPlain)
  if (!found?.length) return false
  /** 보이는 글 편집 → PARA_TEXT 바이트 범위. 넣기는 이웃 글자 경계, 바꾸기는 일반 글자만 덮을 때(사이에 제어 문자·안내문 없음) */
  const byteRange = (e: { start: number; end: number }): { byteStart: number; byteEnd: number; landing?: number } | null => {
    if (e.start === e.end) {
      const at = spans.find(x => x.from === e.start && x.to > x.from) ?? spans.find(x => x.to === e.start && x.to > x.from)
      if (!at) return null
      const b = at.from === e.start ? at.tok.start : at.tok.end
      // 뒤에 글자가 없는 자리(문단 끝)에 넣은 글은 앞 글자 모양 — 끝 표시 모양을 받지 않게
      return { byteStart: b, byteEnd: b, landing: at.from !== e.start ? b / 2 - 1 : undefined }
    }
    const hit = spans.filter(x => x.from < e.end && x.to > e.start)
    if (!hit.length || hit.some(x => !x.tok.plain || x.from < e.start || x.to > e.end)) return null
    const byteStart = hit[0].tok.start, byteEnd = hit[hit.length - 1].tok.end
    // 덮은 낱자 사이에 끼인 제어 문자·누름틀 안내문(글 기여 0)이 있으면 지우지 않는다
    if (toks.some(t => t.start >= byteStart && t.end <= byteEnd && !t.plain)) return null
    if (spans.some(x => x.hidden && x.tok.start >= byteStart && x.tok.end <= byteEnd)) return null
    return { byteStart, byteEnd }
  }
  const visibleAfter = (list: Array<{ start: number; end: number; text: string }>): string =>
    [...list].sort((x, y) => y.start - x.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text)
  // 낱말 덩어리 여럿 — 덩어리마다 일반 글자만 덮으면 따로 고친다(사이 글·run 그대로). 하나라도 제어 문자에 걸치면 처음~끝 한
  // 덩어리로 (누름틀 채우기도 한 자리 기준)
  if (found.length > 1) {
    const ranges = found.map(byteRange)
    if (ranges.every(r => r)) {
      return stageTextBytes(scan, para, found.map((h, k) => ({ ...ranges[k]!, text: h.text, at: h.at ?? 0 })), visibleAfter(found), keepLineseg, false, style)
    }
  }
  const last = found[found.length - 1]
  const e = found.length === 1 ? found[0]
    : { start: found[0].start, end: last.end, text: newPlain.slice(found[0].at ?? 0, (last.at ?? 0) + last.text.length), at: found[0].at }
  // 값을 미기입 누름틀 자리에 넣었으면(넣은 자리와 누름틀 사이가 공백뿐) 안내문 대신 누름틀 안에 넣고 수정 표시(속성 bit 15)를
  // 켠다 — 한글에서 누름틀을 눌러 입력한 것과 같다(HWPX 누름틀 채우기의 dirty="1" 과 같은 규칙). 앞에 공백이 있으면 값의
  // 앞 공백은 뗀다
  const fillGuide = e.start === e.end && e.text.trim()
    ? [...guideAt].find(([, at]) => !text.slice(Math.min(e.start, at.vis), Math.max(e.start, at.vis)).trim()) : undefined
  if (fillGuide) {
    const [g, at] = fillGuide
    const value = /\s$/.test(text.slice(0, at.vis)) ? e.text.trimStart() : e.text
    const ctrl = Buffer.from(scan.records[para.guides[g].ctrl].data)
    ctrl.writeUInt32LE((ctrl.readUInt32LE(4) | (1 << 15)) >>> 0, 4)
    scan.repl.set(para.guides[g].ctrl, ctrl)
    return stageTextBytes(scan, para, [{ byteStart: at.byteStart, byteEnd: at.byteEnd, text: value, at: 0 }],
      text.slice(0, at.vis) + value + text.slice(at.vis), keepLineseg, true)
  }
  const range = byteRange(e)
  if (!range) return false
  return stageTextBytes(scan, para, [{ ...range, text: e.text, at: e.at ?? 0 }], visibleAfter([e]), keepLineseg, false, style)
}

/** PARA_TEXT 바이트 편집 — at 은 새 평문(style.flags) 좌표, landing 은 새 글이 받을 글자 자리(원문 WCHAR 좌표) */
interface ByteEdit { byteStart: number; byteEnd: number; text: string; at: number; landing?: number }

/**
 * PARA_TEXT 의 [byteStart, byteEnd) 들을 새 글로 바꾸고 nChars·CHAR_SHAPE 위치·LINE_SEG 를 맞춘다(뒤 자리부터 바꾸고, 새 글 모양은
 * 앞 자리부터 새 좌표로). restyle 이면 새 글은 바로 앞 글자 모양을 받는다 — 누름틀 안내문에는 한글이 빨간 기울임 모양을 따로
 * 걸어 두는데, 한글이 직접 채운 누름틀의 값은 앞 글 모양이다. 아니면 새 글을 마크다운 서식대로(restyleInserted)
 */
function stageTextBytes(
  scan: SectionScan5, para: ScanPara5, edits: ByteEdit[], newVisible: string, keepLineseg: boolean, restyle = false, style?: HwpInsertStyle,
): boolean {
  const data = scan.records[para.textIdx].data
  const records = scan.records
  const newHeader = Buffer.from(records[para.headerIdx].data)
  const desc = [...edits].sort((x, y) => y.byteStart - x.byteStart)
  let out = data
  let cs = { buf: records[para.charShapeIdx].data, count: 0 }
  for (const e of desc) {
    const rep = Buffer.from(e.text, "utf16le")
    out = Buffer.concat([out.subarray(0, e.byteStart), rep, out.subarray(e.byteEnd)])
    cs = shiftCharShape(cs.buf, e.byteStart / 2, e.byteEnd / 2, rep.length / 2)
  }
  const nChars = out.length / 2
  newHeader.writeUInt32LE(((para.nCharsRaw & 0x80000000) | nChars) >>> 0, 0)
  let delta = 0
  for (const e of [...desc].reverse()) {
    const at = e.byteStart / 2 + delta
    if (restyle) cs = restyleSpan(cs.buf, at, at + e.text.length)
    else if (e.text) {
      const toEnd = data.length - e.byteEnd === 2 && data.readUInt16LE(e.byteEnd) === 0x0d
      cs = restyleInserted(cs.buf, at, e.text, e.at, style, e.landing !== undefined ? e.landing + delta : at, toEnd) ?? cs
    }
    delta += e.text.length - (e.byteEnd - e.byteStart) / 2
  }
  scan.repl.set(para.textIdx, out)
  scan.repl.set(para.charShapeIdx, cs.buf)
  newHeader.writeUInt16LE(cs.count, 12)
  stageLineSegs(scan, para, newHeader, newVisible, 0, nChars, keepLineseg)
  scan.repl.set(para.headerIdx, newHeader)
  return true
}

/**
 * 글이 바뀐 문단의 줄 나눔 정보(LINE_SEG) 정리. 한컴은 LINE_SEG 가 있으면 다시 짜지 않고 그 줄 위치대로 그려서, 원본 줄
 * 위치가 남으면 새 글이 엉뚱한 자리에서 끊긴다(띄어쓰기 앞에서 끊겨 다음 줄이 빈칸으로 시작하는 들여쓰기 모양·줄 첫 글자
 * 마침표, #167). 그래서 기본은 레코드를 빼고 PARA_HEADER lineSegCount 를 0 으로 둔다 — 한컴이 경고 없이 다시 짠다(한글 11
 * 실기기, #167 제보자 확인). HWPX 의 changedLinesegRemovalSplices 와 같은 규칙: 손대지 않은 문단의 줄 나눔은 그대로 둔다.
 *
 * keepLineseg 면 종전 방식 — 강제 줄바꿈(0x000a)이 있으면 줄 수만큼 합성하고(1세그면 한컴이 줄바꿈을 씹는다), 없으면
 * 새 nChars 밖을 가리키는 꼬리 세그먼트만 잘라 낸다(남기면 한컴 무결성 검사가 "손상/변조"로 판정, #71).
 */
function stageLineSegs(
  scan: SectionScan5, para: ScanPara5, newHeader: Buffer, newRaw: string, startUnits: number, nChars: number, keepLineseg: boolean,
): void {
  if (para.lineSegIdx < 0) return
  const lineSegData = scan.records[para.lineSegIdx].data
  if (!keepLineseg) {
    scan.repl.set(para.lineSegIdx, null)
    newHeader.writeUInt16LE(0, 16)                    // lineSegCount
  } else if (newRaw.includes("\n")) {
    // pitch 를 모르는 기하(전부 0)면 원본 유지 — 값은 들어가고 렌더만 한 줄 폴백
    const synth = synthesizeLineSegs(lineSegData, newRaw, startUnits)
    if (synth) {
      scan.repl.set(para.lineSegIdx, synth.buf)
      newHeader.writeUInt16LE(synth.count, 16)        // lineSegCount
    }
  } else {
    const segCount = Math.floor(lineSegData.length / 36)
    let keep = 1
    while (keep < segCount && lineSegData.readUInt32LE(keep * 36) < nChars) keep++
    if (keep < segCount) {
      scan.repl.set(para.lineSegIdx, Buffer.from(lineSegData.subarray(0, keep * 36)))
      newHeader.writeUInt16LE(keep, 16)               // lineSegCount
    }
  }
}
