/**
 * XML DOM 공용 헬퍼 — hwpx(parser-shared)·hwpml(parser)·docx(equation)가 공유.
 *
 * xmldom Element를 네임스페이스 접두사 무시(localName 기준)로 다루는 최소 유틸.
 * 정본은 이 모듈 — hwpx/parser-shared.ts는 하위호환 재수출만 유지한다.
 */

/** XML DOM 재귀 최대 깊이 — 악성 파일의 스택 오버플로 방지.
 *  좌표계가 다른 hwp5 MAX_NEST_DEPTH(8, 표 중첩 단계)·filler/소스맵 16
 *  (표 중첩 단계)과 달리 이건 "XML 요소" 깊이라 표 1단이 여러 depth를
 *  소모한다 — 상수 통일 금지 (의미가 다름) */
export const MAX_XML_DEPTH = 200

/** 요소의 localName (네임스페이스 접두사 제거) */
export function localName(el: Element): string {
  return (el.tagName || el.localName || "").replace(/^[^:]+:/, "")
}

/** 자식 중 지정된 localName(접두사 제거)을 가진 첫 번째 Element 반환 */
export function findChildByLocalName(parent: Element, name: string): Element | null {
  const children = parent.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    if (localName(ch) === name) return ch
  }
  return null
}

/** 자식 중 지정된 localName을 가진 모든 Element (직계만) */
export function childrenByLocalName(parent: Element, name: string): Element[] {
  const out: Element[] = []
  const children = parent.childNodes
  if (!children) return out
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    if (localName(ch) === name) out.push(ch)
  }
  return out
}

/** 직계 자식 Element 전부 (텍스트/주석 노드 제외) */
export function elementChildren(parent: Element): Element[] {
  const out: Element[] = []
  const children = parent.childNodes
  if (!children) return out
  for (let i = 0; i < children.length; i++) {
    if (children[i].nodeType === 1) out.push(children[i] as Element)
  }
  return out
}

/** 텍스트를 담는 노드 타입 — TEXT_NODE(3)과 CDATA_SECTION_NODE(4).
 *  CDATA 를 빠뜨리면 `<hp:t><![CDATA[본문]]></hp:t>` 로 저장된 문서의 텍스트가
 *  경고 없이 통째로 사라진다 (rhwp f4c7de75 와 같은 결함). 한컴 저장본은 CDATA 를
 *  쓰지 않지만 제3자 도구 산출물·특수문자 다수 문단에서는 유효한 XML 표현이다. */
function isTextNode(node: Node): boolean {
  return node.nodeType === 3 || node.nodeType === 4
}

/** 노드 내 모든 텍스트를 재귀적으로 추출 (요소 단위 trim — hwpx 기존 시맨틱).
 *  MAX_XML_DEPTH 가드 — 악성 심층 XML 스택 오버플로 방지 */
export function extractTextFromNode(node: Node, depth: number = 0): string {
  let result = ""
  if (depth > MAX_XML_DEPTH) return result
  const children = node.childNodes
  if (!children) return result
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (isTextNode(child)) result += child.textContent || ""
    else if (child.nodeType === 1) result += extractTextFromNode(child, depth + 1)
  }
  return result.trim()
}

/** 노드 내 모든 텍스트를 공백 원형 그대로 추출 (trim 없음 — hwpml CHAR 텍스트 시맨틱) */
export function rawTextContent(node: Node, depth: number = 0): string {
  if (depth > MAX_XML_DEPTH) return ""
  const children = node.childNodes
  if (!children) return ""
  const parts: string[] = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (isTextNode(child)) parts.push(child.nodeValue || "")
    else if (child.nodeType === 1) parts.push(rawTextContent(child, depth + 1))
  }
  return parts.join("")
}
