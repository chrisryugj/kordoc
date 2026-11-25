/** HWPX 도형의 이미지 참조·설명·자손 탐색 — 구조를 변경하지 않는 DOM 조회. */
import { extractTextFromNode, findChildByLocalName, MAX_XML_DEPTH } from "../shared/xml.js"

/** 텍스트 pass가 나중 구조 pass에 삭제 여부를 전달할 개체. */
export const DELETABLE_OBJECT_TAGS = new Set(["tbl", "pic", "shape", "drawingObject", "drawText", "caption",
  "rect", "ellipse", "polygon", "line", "arc", "curve", "connectLine", "container"])

/** 삭제된 묶음 개체의 모든 그림 참조 — BinData 스윕이 삭제 그림을 되살리지 않도록 전달한다. */
export function collectImageRefs(el: Element, refs: Set<string>, depth = 0): void {
  if (depth > MAX_XML_DEPTH) return
  const tag = (el.tagName || el.localName || "").replace(/^[^:]+:/, "")
  const ref = el.getAttribute("binaryItemIDRef") || (["img", "imgRect", "imgClip"].includes(tag) ? el.getAttribute("href") : "")
  if (ref) refs.add(ref)
  const children = el.childNodes
  for (let i = 0; i < (children?.length ?? 0); i++) {
    const child = children[i] as Element
    if (child.nodeType === 1) collectImageRefs(child, refs, depth + 1)
  }
}

/** 같은 Id 의 deleteEnd 가 섹션 어디에도 없는 deleteBegin. 깨진 파일에서 그 뒤 본문 전체를 지운 글로 버리지 않게 깊이 셈에서 뺀다.
 *  Id 가 없는 표시는 종전대로 센다 */
export function orphanDeleteBegins(root: Element): WeakSet<Element> {
  const all = (name: string): Element[] => ["hp:" + name, name].flatMap(n => Array.from(root.getElementsByTagName(n) as unknown as ArrayLike<Element>))
  const ends = new Set(all("deleteEnd").map(e => e.getAttribute("Id")).filter(Boolean))
  const orphans = new WeakSet<Element>()
  for (const b of all("deleteBegin")) { const id = b.getAttribute("Id"); if (id && !ends.has(id)) orphans.add(b) }
  return orphans
}

/** 삭제 개체만 표시하는 선순회 — 본문 텍스트·경고·번호·주석 상태는 해석하지 않는다. */
export function markDeletedObjects(node: Node, deletedObjects: WeakSet<Element>, refs: Set<string>, orphans?: WeakSet<Element>): void {
  let deleteDepth = 0
  const walk = (parent: Node, depth: number) => {
    if (depth > MAX_XML_DEPTH) return
    const children = parent.childNodes
    for (let i = 0; i < (children?.length ?? 0); i++) {
      const child = children[i] as Element
      if (child.nodeType !== 1) continue
      const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
      if (tag === "deleteBegin") { if (!orphans?.has(child)) deleteDepth++; continue }
      if (tag === "deleteEnd") { if (deleteDepth > 0) deleteDepth--; continue }
      if (deleteDepth > 0 && DELETABLE_OBJECT_TAGS.has(tag)) {
        deletedObjects.add(child)
        collectImageRefs(child, refs)
        continue
      }
      if (tag === "switch") {
        const branch = findChildByLocalName(child, "case") ?? findChildByLocalName(child, "default")
        if (branch) walk(branch, depth + 1)
      } else if (tag !== "hiddenComment" && tag !== "shapeComment" && tag !== "parameters") walk(child, depth + 1)
    }
  }
  walk(node, 0)
}

/** 살아있는 캡션·글상자 story의 삭제 구간은 host 문단 종료 상태와 독립이며 번호·주석 상태는 공유한다. */
export function inIndependentDeletionStory<T>(track: { deleteDepth: number }, extract: () => T): T {
  const hostDeleteDepth = track.deleteDepth
  track.deleteDepth = 0
  try {
    return extract()
  } finally {
    track.deleteDepth = hostDeleteDepth
  }
}

/** pic/shape 요소에서 이미지 참조 경로 추출 (binaryItemIDRef 또는 href) — MAX_XML_DEPTH 가드 */
export function extractImageRef(el: Element, depth: number = 0, deletedObjects?: WeakSet<Element>): string | null {
  if (depth > MAX_XML_DEPTH) return null
  // HWPX: <hp:imgRect> 또는 <hp:img> 내 binaryItemIDRef 속성
  // 또는 하위에서 img 관련 속성 탐색
  const children = el.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Element
    if (child.nodeType !== 1 || deletedObjects?.has(child)) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag === "imgRect" || tag === "img" || tag === "imgClip") {
      const ref = child.getAttribute("binaryItemIDRef") || child.getAttribute("href") || ""
      if (ref) return ref
    }
    // lineShape > imgRect 같은 중첩 구조
    const nested = extractImageRef(child, depth + 1, deletedObjects)
    if (nested) return nested
  }
  // 직접 속성 체크
  const directRef = el.getAttribute("binaryItemIDRef") || ""
  if (directRef) return directRef
  return null
}

/** 도형의 사용자 입력 그림 설명 — 한컴 자동생성 대체텍스트("그림입니다." 등)는 제외 */
export function userShapeComment(el: Element): string | undefined {
  const commentEl = findChildByLocalName(el, "shapeComment")
  if (!commentEl) return undefined
  const text = extractTextFromNode(commentEl)
  if (!text) return undefined
  if (/^그림입니다/.test(text)) return undefined
  if (/^(?:모서리가 둥근 |둥근 )?[^\n]{1,20}입니다\.?$/.test(text)) return undefined
  return text
}

/** 자손에서 특정 태그명의 첫 번째 요소 탐색 (최대 깊이 5) */
export function findDescendant(node: Node, targetTag: string, depth = 0, deletedObjects?: WeakSet<Element>): Element | null {
  if (depth > 5) return null
  const children = node.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Element
    if (child.nodeType !== 1 || deletedObjects?.has(child)) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag === targetTag) return child
    const found = findDescendant(child, targetTag, depth + 1, deletedObjects)
    if (found) return found
  }
  return null
}

/** 노드 하위의 최상위 tbl 수집 — tbl 내부 미진입 (셀 안 중첩표는 표 워커가 처리) */
export function findTopLevelTbls(el: Node, out: Element[], deletedObjects: WeakSet<Element>, depth = 0): void {
  if (depth > MAX_XML_DEPTH) return
  const kids = el.childNodes
  if (!kids) return
  for (let i = 0; i < kids.length; i++) {
    const ch = kids[i] as Element
    if (ch.nodeType !== 1 || deletedObjects.has(ch)) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag === "tbl") { out.push(ch); continue }
    findTopLevelTbls(ch, out, deletedObjects, depth + 1)
  }
}
