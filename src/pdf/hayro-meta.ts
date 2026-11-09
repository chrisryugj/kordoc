/**
 * hayro 가 준 정보 사전·링크 주석 재료를 판정 모듈이 읽는 모양으로 — 글 디코딩(PDFDocEncoding·UTF-16·UTF-8 BOM)과
 * 링크 주소 고르기(/URI·Launch·GoToR·JavaScript, 절대 주소·허용 스킴)는 pdf.js 4.10 과 같다(Apache-2.0 — NOTICE)
 */

import type { HayroDoc, HayroLink } from "./hayro.js"
import type { PdfAnnotation } from "./links.js"

/** PDFDocEncoding 0x18–0x1f·0x80–0xad 자리의 유니코드 */
const PDF_DOC_ENCODING: Record<number, number> = {
  0x18: 0x2d8, 0x19: 0x2c7, 0x1a: 0x2c6, 0x1b: 0x2d9, 0x1c: 0x2dd, 0x1d: 0x2db, 0x1e: 0x2da, 0x1f: 0x2dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x192, 0x87: 0x2044, 0x88: 0x2039,
  0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018, 0x90: 0x2019, 0x91: 0x201a,
  0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x141, 0x96: 0x152, 0x97: 0x160, 0x98: 0x178, 0x99: 0x17d, 0x9a: 0x131,
  0x9b: 0x142, 0x9c: 0x153, 0x9d: 0x161, 0x9e: 0x17e, 0xa0: 0x20ac,
}

/** PDF 글 바이트(한 글자 = 한 바이트) → 글 — BOM 이 있으면 UTF-16·UTF-8, 아니면 PDFDocEncoding. ESC 로 감싼 언어 표지는 뺀다 */
export function pdfString(str: string): string {
  if (str[0]! >= "\xEF") {
    let encoding: string | undefined
    if (str[0] === "\xFE" && str[1] === "\xFF") { encoding = "utf-16be"; if (str.length % 2 === 1) str = str.slice(0, -1) }
    else if (str[0] === "\xFF" && str[1] === "\xFE") { encoding = "utf-16le"; if (str.length % 2 === 1) str = str.slice(0, -1) }
    else if (str[0] === "\xEF" && str[1] === "\xBB" && str[2] === "\xBF") encoding = "utf-8"
    if (encoding) {
      try {
        const decoded = new TextDecoder(encoding, { fatal: true }).decode(Uint8Array.from(str, c => c.charCodeAt(0) & 0xff))
        return decoded.includes("\x1b") ? decoded.replaceAll(/\x1b[^\x1b]*(?:\x1b|$)/g, "") : decoded
      } catch { /* 아래 PDFDocEncoding 으로 */ }
    }
  }
  let out = ""
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code === 0x1b) { while (++i < str.length && str.charCodeAt(i) !== 0x1b) { /* 언어 표지 건너뛰기 */ } continue }
    const mapped = PDF_DOC_ENCODING[code]
    out += mapped ? String.fromCharCode(mapped) : str.charAt(i)
  }
  return out
}

/** 정보 사전 — 판정·메타데이터가 쓰는 글 항목(Title·Author·Subject·Keywords·Creator·Producer·CreationDate·ModDate) */
export function pdfInfo(doc: HayroDoc): Record<string, string> {
  const raw = doc.info(), info: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) info[k] = pdfString(v)
  return info
}

/** 절대 주소로 바꿔 http·https·ftp·mailto·tel 만 받는다 — "www." 로 시작하면 http://, UTF-8 바이트면 글로 */
function validAbsoluteUrl(url: string): string | undefined {
  if (!url) return undefined
  try {
    if (url.startsWith("www.") && (url.match(/\./g)?.length ?? 0) >= 2) url = `http://${url}`
    try { url = decodeURIComponent(escape(url)) } catch { /* UTF-8 이 아니면 그대로 */ }
    const u = new URL(url)
    if (["http:", "https:", "ftp:", "mailto:", "tel:"].includes(u.protocol)) return u.href
  } catch { /* 주소가 아니다 */ }
  return undefined
}

/** 자바스크립트 동작의 주소 — app.launchURL·window.open·xfa.host.gotoURL("…") */
function jsUrl(js: string): string | undefined {
  return /^\s*(app\.launchURL|window\.open|xfa\.host\.gotoURL)\((?:'|")([^'"]*)(?:'|")(?:,\s*(\w+)\)|\))/i.exec(js)?.[2] || undefined
}

/** 쪽(0부터)의 링크 주석 — 주소를 고르지 못한 링크는 url 이 없다 */
export function pdfLinkAnnotations(doc: HayroDoc, page: number): PdfAnnotation[] {
  return doc.links(page).map((l: HayroLink) => {
    let url: string | undefined
    if (l.uri !== undefined) url = l.uri
    else if (l.file !== undefined || l.filespec !== undefined) {
      // 파일 지정 사전의 이름은 글로 풀고 경로 구분자를 / 로
      const file = l.file ?? pdfString(l.filespec!).replaceAll("\\\\", "\\").replaceAll("\\/", "/").replaceAll("\\", "/")
      url = l.dest !== undefined ? file.split("#", 1)[0] + "#" + pdfString(l.dest) : file
    }
    else if (l.js !== undefined) url = jsUrl(pdfString(l.js))
    return { subtype: "Link", rect: l.rect, url: url === undefined ? undefined : validAbsoluteUrl(url) }
  })
}
