/**
 * HWP3 그리기 개체 트리 — **글상자 텍스트 회수 전용** 워커.
 *
 * ch=11(그림) 제어 문자의 확장 블록(`n_ext` 바이트)은 `pic_type`(info[74])이 3 이면
 * 그림이 아니라 **그리기 개체 트리**다. 표지 제목·순서도 라벨처럼 눈에 잘 띄는 본문이
 * 이 안 글상자에 들어간다. 종전에는 이 블록을 통째로 건너뛰어 그 텍스트가 통째로
 * 사라졌다 (hwp3-sample16 실측 618자, #73).
 *
 * 트리는 프레임 헤더 뒤에 도형 레코드가 이어지고, 각 레코드의 `connection_info`
 * bit0=형제·bit1=자식으로 연결된다. 여기서는 **소비할 바이트 수 계산에 필요한 만큼만**
 * 읽고 기하·채우기 속성은 버린다 — 목적이 텍스트 추출이라서다.
 *
 * 호출자는 이 함수를 `n_ext` 슬라이스에만 적용한다. 본 스트림은 이미 그 길이만큼
 * 전진했으므로, 여기서 어떤 실패가 나도 **본문 스트림 동기는 깨지지 않는다.**
 *
 * 출처: rhwp/src/parser/hwp3/drawing.rs (MIT). 구조 정의와 표 78 회수 규칙 동일.
 */

import { Reader } from "./reader.js"

/** 자식 체인 재귀 상한. `has_child` 는 파일에서 온 값이라 상한이 없으면 중첩 컨테이너
 *  하나로 스택을 고갈시킬 수 있다 (rhwp #4285 — 최소 92바이트 레코드로 수만 겹 가능). */
const MAX_DEPTH = 256
/** 도형 개수 상한 — 형제 체인이 손상된 파일에서 무한히 도는 것을 막는다. */
const MAX_OBJECTS = 4096
/** 선언 길이와 플래그 유도 소비량이 어긋날 때 전진을 허용하는 상한 (rhwp #5141). */
const MAX_HEADER_SKIP = 64 * 1024
/** 프레임 헤더 고정부: z_order(4) + object_count(4) + bounds(16). 선언이 이보다 크면
 *  하이퍼텍스트 정보가 뒤따른다. */
const FRAME_FIXED_LENGTH = 24
/** 하이퍼텍스트 정보 = 길이(4) + 파일명 256 + 책갈피 32 + 매크로 325 + 종류 1 + 예약 3.
 *  책갈피는 hchar array[16] = 32바이트다 — 16으로 읽으면 이후 전체가 밀린다 (rhwp #2831). */
const HYPERTEXT_INFO_SIZE = 621
/** 공통 헤더 basic_attr 중 options 앞까지: line_style~pattern_color(8×4) + textbox_margin(2×4) */
const BASIC_ATTR_BEFORE_OPTIONS = 40
/** 공통 헤더에서 object_type/connection_info 뒤 좌표부: relative_pos+object_size+absolute_pos+bounds */
const HEADER_GEOMETRY = 40

const OPT_GRADIENT = 1 << 16
const OPT_ROTATION = 1 << 17
const OPT_BITMAP_PATTERN = 1 << 18

const TYPE_CONTAINER = 0
const TYPE_TEXTBOX = 6

/**
 * 그리기 개체 트리를 훑어 글상자 문단 리스트 조각들을 순서대로 모은다.
 * 각 조각은 본문과 같은 형식의 paragraph list 바이트라 호출자가 그대로 파싱하면 된다.
 */
export function collectDrawingTextBoxLists(ext: Buffer): Buffer[] {
  const reader = new Reader(ext)
  const out: Buffer[] = []

  // 프레임 헤더 — 선언 길이가 고정부보다 크면 하이퍼텍스트 정보가 붙어 있다.
  const frameHeaderLength = reader.readU32()
  reader.skip(4) // z_order
  const objectCount = reader.readU32()
  reader.skip(16) // bounds
  if (frameHeaderLength > FRAME_FIXED_LENGTH) reader.skip(HYPERTEXT_INFO_SIZE)
  // 개체가 0 이면 트리가 없다 — 뒤 바이트를 도형으로 읽으면 쓰레기가 나온다 (rhwp 도 여기서 멈춘다)
  if (objectCount === 0) return []

  const budget = { objects: MAX_OBJECTS }
  walkShapeList(reader, out, 0, budget)
  return out
}

/** 형제 체인을 따라가며 자식이 있으면 내려간다 (rhwp parse_shape_list). */
function walkShapeList(reader: Reader, out: Buffer[], depth: number, budget: { objects: number }): void {
  if (depth > MAX_DEPTH) throw new Error(`HWP3 그리기 개체 중첩이 ${MAX_DEPTH} 단계를 넘음`)
  for (;;) {
    if (budget.objects-- <= 0) throw new Error(`HWP3 그리기 개체가 ${MAX_OBJECTS}개를 넘음`)
    const connectionInfo = readObject(reader, out)
    if ((connectionInfo & 0x02) !== 0) walkShapeList(reader, out, depth + 1, budget)
    if ((connectionInfo & 0x01) === 0) return
  }
}

/** 도형 레코드 하나를 소비하고 connection_info 를 돌려준다. 글상자 문단 리스트는 out 에 모은다. */
function readObject(reader: Reader, out: Buffer[]): number {
  const headerStart = reader.position()
  const headerLength = reader.readU32()
  const objectType = reader.readU16()
  const connectionInfo = reader.readU16()
  reader.skip(HEADER_GEOMETRY)
  reader.skip(BASIC_ATTR_BEFORE_OPTIONS)
  const options = reader.readU32()
  if (options & OPT_ROTATION) reader.skip(32) // center(2×4) + 평행사변형(6×4)
  if (options & OPT_GRADIENT) reader.skip(28) // 7×4
  if (options & OPT_BITMAP_PATTERN) reader.skip(278) // 좌표(4×4) + 파일명 261 + 옵션 1

  // [rhwp #5141/#5558] 빈티지 파일의 공통 헤더에는 이 파서가 모르는 확장 필드가 붙을 수
  // 있고 전체 길이는 header_length(자기 4바이트 제외)로 선언된다. 그 잉여 구간의 실체는
  // 대부분 스펙 11.3 의 optional 글상자 정보(표 78: [정보1 길이][정보2 길이][문단 리스트])라,
  // 잉여 길이가 표 78 과 정확히 맞아떨어지면 문단 리스트를 회수하고 아니면 건너뛴다.
  // 글상자(type 6)는 세부 정보 경로가 같은 구조를 읽으므로 제외한다.
  const consumedEnd = reader.position()
  const declaredEnd = headerStart + 4 + headerLength
  if (declaredEnd > consumedEnd && declaredEnd - consumedEnd <= MAX_HEADER_SKIP && declaredEnd <= reader.length()) {
    const surplus = declaredEnd - consumedEnd
    let recovered = false
    if (objectType !== TYPE_TEXTBOX && surplus >= 8) {
      const info1Len = reader.readU32()
      const info2Len = reader.readU32()
      if (info1Len + info2Len === surplus - 8 && info2Len > 0) {
        reader.skip(info1Len)
        out.push(reader.readBytes(info2Len))
        recovered = true
      }
    }
    if (!recovered) reader.seek(declaredEnd)
  }

  switch (objectType) {
    case TYPE_CONTAINER:
    case 2: // 사각형
    case 3: // 타원
      // 세부 정보가 없어도 길이 8바이트(정보1·정보2 = 0)가 자리를 차지한다.
      // 컨테이너에서 이를 빠뜨리면 첫 자식이 8바이트 밀려 묶음 전체가 소실된다 (rhwp #5141).
      reader.skip(8)
      break
    case 1: // 선
    case 4: // 호
      reader.skip(12)
      break
    case 5: // 다각형
    case 7: // 곡선
      skipPoints(reader, false)
      break
    case TYPE_TEXTBOX: {
      reader.skip(4) // 정보1 길이 — rhwp 도 내용을 소비하지 않는다
      const info2Len = reader.readU32()
      if (info2Len > 0) out.push(reader.readBytes(info2Len))
      break
    }
    case 8: // 수정된 타원
      reader.skip(24) // 정보1 길이 + 호 bounds(4×4) + 정보2 길이
      break
    case 9: // 수정된 호 — 회전 속성만으로 그리므로 세부 정보가 없다
      break
    case 10: // 확장된 곡선
    case 11: // 닫힌 다각형
      skipPoints(reader, true)
      break
    default: {
      const info1Len = reader.readU32()
      reader.skip(info1Len)
      const info2Len = reader.readU32()
      reader.skip(info2Len)
      break
    }
  }
  return connectionInfo
}

/** 점 배열을 가진 도형의 세부 정보를 소비한다. withLineAttrs 면 점마다 1바이트 속성이 뒤따른다. */
function skipPoints(reader: Reader, withLineAttrs: boolean): void {
  reader.skip(4) // 정보1 길이
  const pointCount = reader.readU32()
  reader.skip(4) // 정보2 길이
  const bytes = pointCount * 8 + (withLineAttrs ? pointCount : 0)
  // 손상된 개수로 거대 skip 을 시도하지 않는다 — Reader 가 던지긴 하지만 의도를 남긴다.
  if (bytes > reader.remaining()) throw new Error(`HWP3 그리기 개체 점 개수 비정상 (${pointCount})`)
  reader.skip(bytes)
}
