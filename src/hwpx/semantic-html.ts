/** 의미 구조 HTML → 공문서 생성기가 쓰는 Markdown/HTML 표 혼합 입력. CSS는 서식 근거가 아니며
 * 보고서 프리셋·서식 프로필이 HWPX 서식을 맡는다. */
import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5"
import { markdownToHwpx, type MarkdownToHwpxOptions } from "./generator.js"
import type { GongmunOptions } from "./gongmun.js"

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

const element = (node: Node): node is Element => "tagName" in node
const children = (node: Node): Node[] => "childNodes" in node ? node.childNodes : []
const attr = (node: Element, name: string): string => node.attrs.find(a => a.name === name)?.value ?? ""
const escapeMd = (text: string): string => text.replace(/([\\`*_[\]#])/g, "\\$1")

function inline(node: Node): string {
  if (node.nodeName === "#text" && "value" in node) return escapeMd(node.value.replace(/\s+/g, " "))
  if (!element(node)) return ""
  const content = children(node).map(inline).join("")
  switch (node.tagName) {
    case "br": return "  \n"
    case "strong": case "b": return `**${content.trim()}**`
    case "em": case "i": return `*${content.trim()}*`
    case "code": return `\`${content.trim()}\``
    case "img": {
      const src = attr(node, "src")
      return src ? `![${escapeMd(attr(node, "alt"))}](${src.replace(/[()]/g, encodeURIComponent)})` : escapeMd(attr(node, "alt"))
    }
    default: return content
  }
}

function list(node: Element, depth: number): string[] {
  const out: string[] = []
  const ordered = node.tagName === "ol"
  let number = Number(attr(node, "start")) || 1
  for (const item of children(node)) {
    if (!element(item) || item.tagName !== "li") continue
    const nested = children(item).filter((c): c is Element => element(c) && (c.tagName === "ul" || c.tagName === "ol"))
    const content = children(item).filter(c => !nested.includes(c as Element)).map(inline).join("").trim()
    out.push(`${"  ".repeat(depth)}${ordered ? `${number++}.` : "-"} ${content}`)
    for (const sub of nested) out.push(...list(sub, depth + 1))
  }
  return out
}

function blocks(node: Node): string[] {
  const out: string[] = []
  for (const child of children(node)) {
    if (child.nodeName === "#text") {
      const text = inline(child).trim()
      if (text) out.push(text)
      continue
    }
    if (!element(child)) continue
    const tag = child.tagName
    if (["head", "style", "script", "template", "svg"].includes(tag)) continue
    if (/^h[1-6]$/.test(tag)) out.push(`${"#".repeat(Number(tag[1]))} ${inline(child).trim()}`)
    else if (tag === "p") out.push(inline(child).trim())
    else if (tag === "table") out.push(serializeOuter(child))
    else if (tag === "ul" || tag === "ol") out.push(list(child, 0).join("\n"))
    else if (tag === "blockquote") out.push(blocks(child).flatMap(b => b.split("\n").map(line => `> ${line}`)).join("\n"))
    else if (tag === "hr") out.push("---")
    else if (tag === "img") out.push(inline(child))
    else if (children(child).some(c => element(c) && /^(?:h[1-6]|p|table|ul|ol|blockquote|hr|section|article|div|main|figure)$/.test(c.tagName))) out.push(...blocks(child))
    else {
      const text = inline(child).trim()
      if (text) out.push(text)
    }
  }
  return out.filter(Boolean)
}

/** 제목·문단·인용 요약·중첩 목록·병합/중첩 표를 문서 순서대로 보존한다. */
export function semanticHtmlToMarkdown(html: string): string {
  const document = parse(html)
  const findBody = (node: Node): Node | null => {
    if (element(node) && node.tagName === "body") return node
    for (const child of children(node)) {
      const found = findBody(child)
      if (found) return found
    }
    return null
  }
  return blocks(findBody(document) ?? document).join("\n\n")
}

/** 보고서에서 자주 쓰는 태그 선택자의 인쇄 서식만 프리셋 옵션으로 옮긴다.
 * 복잡한 CSS 선택자·외부 스타일시트는 해석하지 않는다. 명시 옵션이 항상 우선한다. */
export function withSemanticHtmlStyles(html: string, gongmun: GongmunOptions): GongmunOptions {
  const styles = new Map<string, Record<string, string>>()
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    for (const rule of style[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = Object.fromEntries(rule[2].split(";").map(part => {
        const colon = part.indexOf(":")
        return colon < 0 ? ["", ""] : [part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()]
      }).filter(([key]) => key))
      for (const selector of rule[1].split(",").map(s => s.trim().toLowerCase())) {
        if (/^(body|p|li|h1|h2|blockquote|table|th)$/.test(selector)) {
          styles.set(selector, { ...styles.get(selector), ...declarations })
        }
      }
    }
  }
  const get = (selector: string, property: string) => styles.get(selector)?.[property] ?? ""
  const pt = (value: string): number | undefined => {
    const match = /^(\d+(?:\.\d+)?)(pt|px)$/i.exec(value)
    if (!match) return undefined
    const size = Number(match[1]) * (match[2].toLowerCase() === "px" ? 0.75 : 1)
    return size >= 6 && size <= 60 ? size : undefined
  }
  const color = (value: string): string | undefined => {
    const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(value)
    if (hex) return `#${hex[1].length === 3 ? [...hex[1]].map(c => c + c).join("") : hex[1]}`.toUpperCase()
    if (/^white$/i.test(value)) return "#FFFFFF"
    if (/^black$/i.test(value)) return "#000000"
    return undefined
  }
  const bodyPt = pt(get("p", "font-size")) ?? pt(get("body", "font-size"))
  const lineHeight = get("p", "line-height") || get("body", "line-height")
  const lineSpacing = /^\d+(?:\.\d+)?$/.test(lineHeight) ? Math.round(Number(lineHeight) * 100) : undefined
  const titlePt = pt(get("h1", "font-size")) ?? (bodyPt ? bodyPt + 10 : undefined)
  const summaryPt = pt(get("blockquote", "font-size")) ?? bodyPt
  const summaryFill = color(get("blockquote", "background") || get("blockquote", "background-color"))
  const bandColor = color(get("h2", "background") || get("h2", "background-color"))
  const bandTextColor = color(get("h2", "color"))
  const tableHeaderFill = color(get("th", "background") || get("th", "background-color"))
  const chapterPt = pt(get("h2", "font-size"))
  const tablePt = pt(get("table", "font-size"))
  const inferred: GongmunOptions = {
    ...(bodyPt ? { bodyPt } : {}),
    ...(lineSpacing && lineSpacing >= 50 && lineSpacing <= 300 ? { lineSpacing } : {}),
    ...(titlePt ? { reportTitlePt: titlePt } : {}),
    ...(summaryPt ? { reportSummaryPt: summaryPt } : {}),
    ...(summaryFill ? { reportSummaryFill: summaryFill } : {}),
    ...(bandColor ? { bandColor } : {}),
    ...(bandTextColor ? { bandTextColor } : {}),
    ...(tableHeaderFill ? { tableHeaderFill } : {}),
    sizes: {
      ...(chapterPt ? { chapter: chapterPt } : {}),
      ...(tablePt ? { table: tablePt } : {}),
    },
  }
  return { ...inferred, ...gongmun, sizes: { ...inferred.sizes, ...gongmun.sizes } }
}

/** 의미 구조 HTML을 기존 공문서 프리셋·서식 프로필 경로로 HWPX 변환한다. */
export function htmlToHwpx(html: string, options?: MarkdownToHwpxOptions): Promise<ArrayBuffer> {
  return markdownToHwpx(semanticHtmlToMarkdown(html), options?.gongmun
    ? { ...options, gongmun: withSemanticHtmlStyles(html, options.gongmun) }
    : options)
}
