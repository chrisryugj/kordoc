/**
 * XML 파서 — @xmldom/xmldom 의 DOMParser 와 같은 생성자·같은 DOM 모양을 낸다. 파싱은 quick-xml(Rust → wasm, rust/xml-flat)이 한다.
 *
 * 먼저 엄격 모드로 읽는다. 잘 짜인 문서는 @xmldom 과 같은 트리를 낸다: 문서 자식에 XML 선언(처리 명령)·주석·루트 앞 공백,
 * CDATA 는 따로(nodeType 4), 엔티티로 갈린 글은 한 노드, 줄바꿈은 \n, 속성 값의 탭·줄바꿈은 공백(문자 참조는 그대로),
 * 없는 속성은 null, xmlns 선언도 속성.
 * 엄격 모드가 거절한 문서(깨진 XML·DOCTYPE·선언 안 된 접두사 등)는 복구 모드로 다시 읽는다. 복구 모드는 깨진 곳을 고쳐 읽고
 * onError 로 알린다 — @xmldom 이 경고만 내던 것(따옴표 없는 속성 값 등)은 "warning", 그 밖은 "error". 루트 요소를 못 찾으면
 * "fatalError" 를 알리고 던진다. 고치는 규칙은 rust/xml-flat/src/lib.rs.
 * kordoc 이 쓰는 읽기 API 와 렌더 경로의 고치기 API(setAttribute·removeChild·appendChild·insertBefore·cloneNode·createElement)만 둔다.
 */

import { XML_FLAT_WASM } from "./xml-flat-wasm.js"
import type { ParseWarning } from "../types.js"

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Engine {
  memory: WebAssembly.Memory
  alloc(len: number): number
  dealloc(p: number, len: number): void
  parse(p: number, len: number, flags: number): number
  ops_ptr(): number
  ops_len(): number
  strs_ptr(): number
  strs_len(): number
  reset(): void
}

let compiled: WebAssembly.Module | null | undefined
let engine: Engine | null | undefined
/** wasm 메모리가 이보다 커지면(큰 입력) 다음 파싱 전에 인스턴스를 새로 만든다 — wasm 메모리는 줄지 않는다 */
const ENGINE_MEMORY_CAP = 32 * 1024 * 1024
function wasm(): Engine | null {
  if (engine === undefined) {
    try {
      // 동기 컴파일 — Chrome 은 메인 스레드에서 8MB 까지(2023-05 V8), Firefox·Safari 는 제한 없음. 이 모듈은 100KB 아래
      compiled ??= new WebAssembly.Module(Uint8Array.from(atob(XML_FLAT_WASM), c => c.charCodeAt(0)))
      engine = new WebAssembly.Instance(compiled).exports as unknown as Engine
    } catch {
      compiled = null
      engine = null
    }
  }
  return engine
}

const XMLNS_NS = "http://www.w3.org/2000/xmlns/"
const XML_NS = "http://www.w3.org/XML/1998/namespace"
const EMPTY: XNode[] = []
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** 문서 순서 자손 (자기 자신 빼고) — 반복문이라 깊은 중첩에서도 호출 스택이 넘치지 않는다 */
function* descendants(root: XNode): Generator<XNode> {
  const stack: Array<[XNode[], number]> = [[root.childNodes, 0]]
  while (stack.length) {
    const top = stack[stack.length - 1]!
    const kids = top[0]
    if (top[1] >= kids.length) { stack.pop(); continue }
    const c = kids[top[1]++]!
    yield c
    if (c.childNodes.length) stack.push([c.childNodes, 0])
  }
}

abstract class XNode {
  parentNode: XNode | null = null
  previousSibling: XNode | null = null
  nextSibling: XNode | null = null
  childNodes: XNode[] = EMPTY
  constructor(public ownerDocument: XDocument | null) {}
  abstract readonly nodeType: number
  abstract readonly nodeName: string
  get firstChild(): XNode | null { return this.childNodes[0] ?? null }
  get lastChild(): XNode | null { return this.childNodes[this.childNodes.length - 1] ?? null }
  get nodeValue(): string | null { return null }
  hasChildNodes(): boolean { return this.childNodes.length > 0 }
  get textContent(): string | null {
    let s = ""
    for (const c of descendants(this)) if (c.nodeType === 3 || c.nodeType === 4) s += (c as XCharacterData).data
    return s
  }
  /** @xmldom Node.toString 과 같은 XML 직렬화 */
  toString(): string {
    const buf: string[] = []
    serialize(this, buf, new Map())
    return buf.join("")
  }
  appendChild<T extends XNode>(node: T): T { return this.insertBefore(node, null) }
  insertBefore<T extends XNode>(node: T, ref: XNode | null): T {
    node.parentNode?.removeChild(node)
    if (this.childNodes === EMPTY) this.childNodes = []
    const at = ref ? this.childNodes.indexOf(ref) : -1
    const i = at < 0 ? this.childNodes.length : at
    this.childNodes.splice(i, 0, node)
    node.parentNode = this
    node.previousSibling = this.childNodes[i - 1] ?? null
    node.nextSibling = this.childNodes[i + 1] ?? null
    if (node.previousSibling) node.previousSibling.nextSibling = node
    if (node.nextSibling) node.nextSibling.previousSibling = node
    return node
  }
  removeChild<T extends XNode>(node: T): T {
    const i = this.childNodes.indexOf(node)
    if (i < 0) throw new Error("removeChild: 자식이 아닙니다")
    this.childNodes.splice(i, 1)
    if (node.previousSibling) node.previousSibling.nextSibling = node.nextSibling
    if (node.nextSibling) node.nextSibling.previousSibling = node.previousSibling
    node.parentNode = node.previousSibling = node.nextSibling = null
    return node
  }
  getElementsByTagName(name: string): XElement[] {
    const out: XElement[] = []
    for (const c of descendants(this)) if (c.nodeType === 1 && (name === "*" || (c as XElement).tagName === name)) out.push(c as XElement)
    return out
  }
  getElementsByTagNameNS(ns: string | null, local: string): XElement[] {
    const out: XElement[] = []
    for (const c of descendants(this)) {
      if (c.nodeType !== 1) continue
      const e = c as XElement
      if ((local === "*" || e.localName === local) && (ns === "*" || e.namespaceURI === (ns || null))) out.push(e)
    }
    return out
  }
}

abstract class XCharacterData extends XNode {
  constructor(doc: XDocument | null, public data: string) { super(doc) }
  get nodeValue(): string { return this.data }
  get textContent(): string { return this.data }
  get length(): number { return this.data.length }
}
class XText extends XCharacterData {
  get nodeType() { return 3 }
  get nodeName() { return "#text" }
  cloneNode(): XText { return new XText(this.ownerDocument, this.data) }
}
class XCData extends XCharacterData {
  get nodeType() { return 4 }
  get nodeName() { return "#cdata-section" }
  cloneNode(): XCData { return new XCData(this.ownerDocument, this.data) }
}
class XComment extends XCharacterData {
  get nodeType() { return 8 }
  get nodeName() { return "#comment" }
  get textContent(): string { return this.data }
  cloneNode(): XComment { return new XComment(this.ownerDocument, this.data) }
}
class XPI extends XCharacterData {
  constructor(doc: XDocument | null, public target: string, data: string) { super(doc, data) }
  get nodeType() { return 7 }
  get nodeName() { return this.target }
  cloneNode(): XPI { return new XPI(this.ownerDocument, this.target, this.data) }
}

class XAttr {
  constructor(public name: string, public value: string, public namespaceURI: string | null, public ownerElement: XElement) {}
  get nodeType() { return 2 }
  get nodeName() { return this.name }
  get nodeValue() { return this.value }
  get localName() { const i = this.name.indexOf(":"); return i < 0 ? this.name : this.name.slice(i + 1) }
  get prefix() { const i = this.name.indexOf(":"); return i < 0 ? null : this.name.slice(0, i) }
  get specified() { return true }
}

type NamedNodeMap = XAttr[] & { getNamedItem(name: string): XAttr | null; getNamedItemNS(ns: string | null, local: string): XAttr | null; item(i: number): XAttr | null }

class XElement extends XNode {
  /** 속성 [이름, 값, 이름, 값, …] */
  _a: string[]
  private _ns: string | null | undefined
  private _attrs: NamedNodeMap | undefined
  constructor(doc: XDocument | null, public tagName: string, attrs: string[]) { super(doc); this._a = attrs }
  get nodeType() { return 1 }
  get nodeName() { return this.tagName }
  get localName() { const i = this.tagName.indexOf(":"); return i < 0 ? this.tagName : this.tagName.slice(i + 1) }
  get prefix() { const i = this.tagName.indexOf(":"); return i < 0 ? null : this.tagName.slice(0, i) }
  get namespaceURI(): string | null {
    if (this._ns === undefined) this._ns = lookupNamespace(this, this.prefix)
    return this._ns
  }
  getAttribute(name: string): string | null {
    const a = this._a
    for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1]!
    return null
  }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null }
  getAttributeNS(ns: string | null, local: string): string | null {
    for (const at of this.attributes) if (at.localName === local && at.namespaceURI === (ns || null)) return at.value
    return null
  }
  setAttribute(name: string, value: string): void {
    const a = this._a, v = String(value)
    for (let i = 0; i < a.length; i += 2) if (a[i] === name) { a[i + 1] = v; this._attrs = undefined; return }
    a.push(name, v); this._attrs = undefined
  }
  removeAttribute(name: string): void {
    const a = this._a
    for (let i = 0; i < a.length; i += 2) if (a[i] === name) { a.splice(i, 2); this._attrs = undefined; return }
  }
  get attributes(): NamedNodeMap {
    if (!this._attrs) {
      const list = [] as unknown as NamedNodeMap
      for (let i = 0; i < this._a.length; i += 2) {
        const name = this._a[i]!
        const ns = name === "xmlns" || name.startsWith("xmlns:") ? XMLNS_NS : name.includes(":") ? lookupNamespace(this, name.slice(0, name.indexOf(":"))) : null
        list.push(new XAttr(name, this._a[i + 1]!, ns, this))
      }
      list.getNamedItem = (n: string) => list.find(x => x.name === n) ?? null
      list.getNamedItemNS = (ns: string | null, l: string) => list.find(x => x.localName === l && x.namespaceURI === (ns || null)) ?? null
      list.item = (i: number) => list[i] ?? null
      this._attrs = list
    }
    return this._attrs
  }
  cloneNode(deep = false): XElement {
    const e = new XElement(this.ownerDocument, this.tagName, this._a.slice())
    if (!deep) return e
    // 반복문으로 — 깊은 중첩에서도 호출 스택이 넘치지 않는다
    const todo: Array<[XNode, XNode]> = [[this, e]]
    while (todo.length) {
      const [src, dst] = todo.pop()!
      for (const c of src.childNodes) {
        const copy = c.nodeType === 1 ? new XElement(c.ownerDocument, (c as XElement).tagName, (c as XElement)._a.slice()) : (c as any).cloneNode()
        dst.appendChild(copy)
        if (c.nodeType === 1 && c.childNodes.length) todo.push([c, copy])
      }
    }
    return e
  }
}

class XDocument extends XNode {
  constructor() { super(null) }
  get nodeType() { return 9 }
  get nodeName() { return "#document" }
  get textContent(): null { return null }
  get documentElement(): XElement | null { return (this.childNodes.find(c => c.nodeType === 1) as XElement | undefined) ?? null }
  get doctype(): null { return null }
  createElement(name: string): XElement { return new XElement(this, name, []) }
  createTextNode(data: string): XText { return new XText(this, data) }
  createCDATASection(data: string): XCData { return new XCData(this, data) }
  createComment(data: string): XComment { return new XComment(this, data) }
}

/** 접두사 → 네임스페이스 (조상의 xmlns 선언, 없으면 null) */
function lookupNamespace(from: XNode | null, prefix: string | null): string | null {
  if (prefix === "xml") return XML_NS
  if (prefix === "xmlns") return XMLNS_NS
  const key = prefix ? `xmlns:${prefix}` : "xmlns"
  for (let n = from; n && n.nodeType === 1; n = n.parentNode) {
    const v = (n as XElement).getAttribute(key)
    if (v !== null) return v || null
  }
  return null
}

/** 복구 기록 (wasm op 6) — 수준별 건수와 첫 문구 */
interface Issue { level: "warning" | "error"; count: number; msg: string }
/** wasm flags: 모두 ASCII · 복구 모드 */
const ASCII = 1, RECOVER = 2

/** wasm 으로 읽어 DOM 을 짓는다. issues 가 없으면 엄격 모드 — 잘 짜인 문서가 아니면 null. 있으면 복구 모드 — 늘 문서를 내고 고친 곳을 issues 에 */
function build(w: Engine, text: string, issues?: Issue[]): XDocument | null {
  // 원문을 wasm 메모리에 바로 UTF-8 로 쓴다 (중간 사본 없이). 먼저 문자열 길이만큼만 잡고(ASCII 면 딱 맞다), 모자라면 3배로 늘려
  // 나머지를 잇는다 — UTF-16 한 단위는 UTF-8 로 3바이트를 넘지 않는다. 처음부터 3배를 잡으면 wasm 메모리가 그만큼 커졌다
  let cap = text.length
  let p = w.alloc(cap)
  let { read, written } = encoder.encodeInto(text, new Uint8Array(w.memory.buffer, p, cap))
  if (read < text.length) {
    const big = text.length * 3
    const q = w.alloc(big)
    new Uint8Array(w.memory.buffer).copyWithin(q, p, p + written)
    w.dealloc(p, cap)
    p = q; cap = big
    written += encoder.encodeInto(text.slice(read), new Uint8Array(w.memory.buffer, p + written, cap - written)).written
  }
  // 모두 ASCII 면(바이트 수 = 문자열 길이) wasm 이 UTF-16 위치를 세지 않는다
  const code = w.parse(p, written, (written === text.length ? ASCII : 0) | (issues ? RECOVER : 0))
  w.dealloc(p, cap)
  if (code !== 0) {
    w.reset()
    if (w.memory.buffer.byteLength > ENGINE_MEMORY_CAP) engine = undefined
    return null
  }
  const ops = new Uint32Array(w.memory.buffer, w.ops_ptr(), w.ops_len()).slice()
  const owned = decoder.decode(new Uint8Array(w.memory.buffer, w.strs_ptr(), w.strs_len()))
  w.reset()
  if (w.memory.buffer.byteLength > ENGINE_MEMORY_CAP) engine = undefined
  /** 문자열 참조 (시작, 길이) — 길이 맨 위 비트가 서면 바꾼 문자열 버퍼, 아니면 원문 조각(복사하지 않는다) */
  const str = (a: number, b: number): string => b & 0x80000000 ? owned.slice(a, a + (b & 0x7fffffff)) : text.slice(a, a + b)

  const doc = new XDocument()
  let cur: XNode = doc
  // 선언된 접두사 — 선언 안 된 접두사는 엄격 모드면 거절, 복구 모드면 네임스페이스 없이 두고 알린다
  let unboundSeen = false
  const bound = new Map<string, number>()
  const declared: string[][] = []
  const add = (parent: XNode, node: XNode) => {
    if (parent.childNodes === EMPTY) parent.childNodes = []
    const kids = parent.childNodes
    const last = kids[kids.length - 1]
    if (last) { last.nextSibling = node; node.previousSibling = last }
    node.parentNode = parent
    kids.push(node)
  }
  for (let i = 0; i < ops.length;) {
    const op = ops[i++]
    if (op === 0) {
      const name = str(ops[i++]!, ops[i++]!)
      const n = ops[i++]!
      const attrs: string[] = new Array(n * 2)
      const decl: string[] = []
      for (let k = 0; k < n; k++) {
        const key = str(ops[i++]!, ops[i++]!), value = str(ops[i++]!, ops[i++]!)
        attrs[2 * k] = key; attrs[2 * k + 1] = value
        if (key.startsWith("xmlns:")) { const pf = key.slice(6); decl.push(pf); bound.set(pf, (bound.get(pf) ?? 0) + 1) }
      }
      const unbound = (q: string) => { const c = q.indexOf(":"); if (c < 0) return false; const pf = q.slice(0, c); return pf !== "xml" && pf !== "xmlns" && !bound.get(pf) }
      let bad = unbound(name)
      for (let k = 0; k < n && !bad; k++) bad = unbound(attrs[2 * k]!)
      if (bad) { if (!issues) return null; unboundSeen = true }
      declared.push(decl)
      const el = new XElement(doc, name, attrs)
      add(cur, el)
      cur = el
    } else if (op === 1) {
      for (const pf of declared.pop() ?? []) bound.set(pf, bound.get(pf)! - 1)
      cur = cur.parentNode!
    } else if (op === 2) {
      const t = str(ops[i++]!, ops[i++]!)
      // @xmldom 은 루트 뒤 문서 수준 글(끝 줄바꿈)을 버린다 — 루트 앞 글은 둔다
      if (cur !== doc || !doc.documentElement) add(cur, new XText(doc, t))
    }
    else if (op === 3) add(cur, new XCData(doc, str(ops[i++]!, ops[i++]!)))
    else if (op === 4) add(cur, new XComment(doc, str(ops[i++]!, ops[i++]!)))
    else if (op === 5) { const t = str(ops[i++]!, ops[i++]!), d = str(ops[i++]!, ops[i++]!); add(cur, new XPI(doc, t, d)) }
    else if (op === 6) { const level = ops[i++] === 1 ? "warning" : "error", count = ops[i++]!; issues!.push({ level, count, msg: str(ops[i++]!, ops[i++]!) }) }
  }
  if (unboundSeen) issues!.push({ level: "error", count: 1, msg: "선언 안 된 네임스페이스 접두사" })
  return doc.documentElement || issues ? doc : null
}

type OnError = (level: "warning" | "error" | "fatalError", msg: string) => void

/** DOMParser 옵션 — 고쳐 읽은 곳을 MALFORMED_XML 경고로 모은다. 루트가 없으면 파서가 던지므로 호출자 catch 가 알린다 */
export function warnInto(warnings: ParseWarning[] | undefined, part: string): { onError?: OnError } {
  return { onError: (level, msg) => { if (level !== "fatalError") warnings?.push({ code: "MALFORMED_XML", message: `${part} XML ${level === "warning" ? "경고" : "오류"}: ${msg}` }) } }
}

/** @xmldom DOMParser 와 같은 생성자·메서드 (mimeType 은 받기만 한다 — 늘 XML 로 읽는다) */
export class DOMParser {
  constructor(private readonly options?: { onError?: OnError }) {}
  parseFromString(source: string, _mimeType?: string): Document {
    const onError = this.options?.onError
    const w = wasm()
    if (!w) throw new Error("XML 파서(wasm)를 띄울 수 없습니다 — WebAssembly 를 쓸 수 없는 환경")
    const issues: Issue[] = []
    let text = source
    // 맨 앞 BOM 은 버린다 (@xmldom 은 루트 밖 글 오류로 알렸다)
    if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); issues.push({ level: "error", count: 1, msg: "문서 맨 앞 BOM(U+FEFF)을 버림" }) }
    if (text.includes("\ufffd")) issues.push({ level: "warning", count: 1, msg: "대체 문자(U+FFFD)가 있음 — 원본 인코딩이 깨졌을 수 있음" })
    if (text.includes("\r")) text = text.replace(/\r\n?/g, "\n")
    const doc = build(w, text) ?? build(w, text, issues)!
    for (const { level, count, msg } of issues) onError?.(level, count > 1 ? `${msg} (외 ${count - 1}건)` : msg)
    if (!doc.documentElement) {
      onError?.("fatalError", "루트 요소가 없음")
      throw new Error("XML 파싱 실패: 루트 요소가 없음")
    }
    return doc as unknown as Document
  }
}

/** @xmldom _xmlEncoder 와 같은 이스케이프 */
const encode = (c: string) => c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "\"" ? "&quot;" : `&#${c.charCodeAt(0)};`

/** @xmldom serializeToString 을 따른다 — 그 직렬화 안에서 선언되지 않은 네임스페이스는 요소에 선언을 보탠다(조상 선언은 보지 않는다).
 *  반복문으로 — 깊은 중첩에서도 호출 스택이 넘치지 않는다 */
function serialize(root: XNode, buf: string[], visible: Map<string, string>): void {
  // 요소의 실제 네임스페이스 — 내려가며 선언을 이어 받는다(요소마다 조상을 거슬러 찾으면 깊이의 제곱)
  const top = new Map<string, string>()
  for (let n = root.parentNode; n && n.nodeType === 1; n = n.parentNode) {
    const a = (n as XElement)._a
    for (let i = 0; i < a.length; i += 2) {
      const pf = a[i] === "xmlns" ? "" : a[i]!.startsWith("xmlns:") ? a[i]!.slice(6) : null
      if (pf !== null && !top.has(pf)) top.set(pf, a[i + 1]!)
    }
  }
  // 할 일: 노드 열기(보이는 선언·실제 네임스페이스와 함께) 또는 닫는 태그
  type Task = { node: XNode; scope: Map<string, string>; ns: Map<string, string> }
  const todo: Array<Task | string> = [{ node: root, scope: visible, ns: top }]
  while (todo.length) {
    const task = todo.pop()!
    if (typeof task === "string") { buf.push(task); continue }
    const { node, scope: outer, ns: outerNs } = task
    switch (node.nodeType) {
      case 9: for (let i = node.childNodes.length - 1; i >= 0; i--) todo.push({ node: node.childNodes[i]!, scope: outer, ns: outerNs }); continue
      case 3: buf.push((node as XText).data.replace(/[<&>]/g, encode)); continue
      case 4: buf.push("<![CDATA[", (node as XCData).data, "]]>"); continue
      case 8: buf.push("<!--", (node as XComment).data, "-->"); continue
      case 7: { const pi = node as XPI; buf.push("<?", pi.target, pi.data ? " " + pi.data : "", "?>"); continue }
    }
    const el = node as XElement
    // 선언이 있는 요소만 지도를 새로 만든다 — 지도는 자식들이 함께 쓴다
    let scope = outer, ns = outerNs
    const a = el._a
    for (let i = 0; i < a.length; i += 2) {
      const pf = a[i] === "xmlns" ? "" : a[i]!.startsWith("xmlns:") ? a[i]!.slice(6) : null
      if (pf === null) continue
      if (scope === outer) { scope = new Map(outer); ns = new Map(outerNs) }
      scope.set(pf, a[i + 1]!); ns.set(pf, a[i + 1]!)
    }
    const resolve = (pf: string | null): string | null => pf === "xml" ? XML_NS : pf === "xmlns" ? XMLNS_NS : ns.get(pf ?? "") || null
    const need = (pf: string, uri: string | null) => {
      if (!uri || pf === "xml" || pf === "xmlns" || scope.get(pf) === uri) return
      buf.push(pf ? ` xmlns:${pf}="` : ` xmlns="`, uri.replace(/[<>&"\t\n\r]/g, encode), "\"")
      if (scope === outer) scope = new Map(outer)
      scope.set(pf, uri)
    }
    buf.push("<", el.tagName)
    // 접두사 붙은 속성의 선언은 그 속성 바로 앞, 요소 자신의 선언은 속성 뒤 (@xmldom 순서)
    for (let i = 0; i < a.length; i += 2) {
      const k = a[i]!, c = k.indexOf(":"), pf = c < 0 ? null : k.slice(0, c)
      if (pf && pf !== "xmlns") need(pf, resolve(pf))
      buf.push(" ", k, "=\"", a[i + 1]!.replace(/[<>&"\t\n\r]/g, encode), "\"")
    }
    need(el.prefix ?? "", resolve(el.prefix))
    if (!el.childNodes.length) { buf.push("/>"); continue }
    buf.push(">")
    todo.push(`</${el.tagName}>`)
    for (let i = el.childNodes.length - 1; i >= 0; i--) todo.push({ node: el.childNodes[i]!, scope, ns })
  }
}
