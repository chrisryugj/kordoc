# BIFF8 (Excel 97-2003 .xls) 파서 명세

> **출처**: [MS-XLS] Excel Binary File Format Specification, SheetJS BIFF 디코더, OpenOffice XLS Documentation
> **대상 버전**: BIFF8 (Excel 97/2000/XP/2003) — `.xls`
> **목적**: kordoc `src/xls/` 구현용 핵심 레코드/포맷 요약. 차트·매크로·그림은 범위 외.

---

## 1. 컨테이너 구조 (OLE2)

`.xls`는 **OLE2 (Compound File Binary) 컨테이너**. 내부 스트림 중 `"Workbook"` (또는 구버전의 `"Book"`)이 BIFF 레코드의 시퀀스를 담는다.

```
.xls (OLE2 / CFB)
├── Workbook                ← BIFF 레코드 스트림 (필수)
├── \x05DocumentSummaryInformation
├── \x05SummaryInformation
└── (선택) Ctls, _VBA_PROJECT_CUR 등
```

**kordoc 활용**: 기존 [src/hwp5/cfb-lenient.ts](../src/hwp5/cfb-lenient.ts) 의 `parseLenientCfb(buffer).findStream("/Workbook")` 으로 직접 추출 가능. 새 OLE2 파서 불필요.

**스트림 이름 우선순위**: `"Workbook"` → `"Book"` (Excel 5/95 호환). 둘 다 없으면 `"Worksheet"` 또는 `"WorkBook"` 변형 시도 후 실패.

---

## 2. 레코드 헤더

모든 BIFF 레코드는 4바이트 헤더 + 가변 데이터:

```
+--------+--------+--------+--------+
| opcode (LE u16) | length (LE u16) | data (length bytes) ...
+--------+--------+--------+--------+
```

- `opcode`: 레코드 타입 (16비트)
- `length`: 데이터 길이 (최대 8224, 보통 ≤ 8224)
- 데이터가 8224를 초과하면 `CONTINUE (0x003C)` 레코드로 분할됨

**리더 의사코드**:
```
while offset < stream.length:
  opcode = readU16LE(offset)
  length = readU16LE(offset + 2)
  data = stream[offset+4 : offset+4+length]
  yield { opcode, length, data }
  offset += 4 + length
```

---

## 3. 레코드 타입 매트릭스

### 3.1 스트림 경계

| Opcode | 이름 | 길이 | 용도 |
|--------|------|------|------|
| `0x0809` | `BOF` | 16 | 서브스트림 시작 (Globals/Worksheet/Chart) |
| `0x000A` | `EOF` | 0 | 서브스트림 종료 |

**BOF 구조** (16바이트):
- `vers` (u16, off 0): 0x0600 = BIFF8
- `dt` (u16, off 2): 서브스트림 타입 — `0x0005`=Globals, `0x0010`=Worksheet, `0x0020`=Chart, `0x0040`=Macro
- 나머지: build / year / sfo / lowestBiff (사용 안 함)

### 3.2 Globals 서브스트림 (Workbook 메타)

| Opcode | 이름 | 핵심 필드 |
|--------|------|-----------|
| `0x0085` | `BoundSheet8` | `lbPlyPos` (u32) — 시트 BOF의 스트림 절대 오프셋, `hsState` (u8) — 가시성, `dt` (u8) — 타입(0=Worksheet, 1=Chart, 2=Macro), `stName` (Unicode XLString) |
| `0x00FC` | `SST` | Shared String Table — `cstTotal` (u32), `cstUnique` (u32), 직후 unique 개수만큼 `XLUnicodeRichExtendedString` |
| `0x00FF` | `ExtSST` | SST 인덱스 (성능, 무시 가능) |
| `0x0042` | `CodePage` | `cv` (u16) — 보통 1200 (UTF-16) 또는 949 (CP949) |
| `0x0022` | `Date1904` | `f1904` (u16) — 0=1900 epoch, 1=1904 epoch (Mac) |
| `0x013D` | `RRTabId` | 시트 인덱스 |

**BoundSheet8 파싱 흐름**:
1. Globals 서브스트림 읽으며 BoundSheet8 수집 → `{name, offset, type}[]`
2. SST 디코딩 → `string[]`
3. 각 시트 오프셋 점프 → Worksheet 서브스트림 파싱

### 3.3 SST (Shared String Table) — 핵심

```
SST data:
+------+------+--- strings (cstUnique 개) ---+
| cstTotal u32 | cstUnique u32 | XLUnicodeRichExtendedString[cstUnique] |
+------+------+------------------------------+
```

**XLUnicodeRichExtendedString** (가변):
```
+----+----+------+--- chars ---+--- rich runs (선택) ---+--- ext (선택) ---+
| cch u16 | flags u8 | (cRun u16) | (cbExtRst u32) | rgb |
+----+----+------+-------------+----------------------+---------------------+
```

- `cch`: 문자 수
- `flags` (1바이트):
  - bit 0 (`fHighByte`): 0=compressed (1byte/char), 1=uncompressed (2byte/char UTF-16LE)
  - bit 2 (`fExtSt`): rich text extension 존재
  - bit 3 (`fRichSt`): rich text run 존재
- `cRun` (있으면): rich format run 수 → 4바이트 × cRun 스킵
- `cbExtRst` (있으면): 확장 데이터 길이 → 그만큼 스킵
- `rgb`: 실제 문자 데이터 (compressed면 cch바이트, uncompressed면 2*cch바이트)

**CONTINUE 처리의 함정**:
- SST가 8224바이트 초과 시 CONTINUE 레코드로 분할
- **CONTINUE 경계가 문자 중간을 자를 수 있음** — 다음 CONTINUE의 첫 바이트는 새 flags 바이트로 시작 (재해석 필요)
- SheetJS 방식: 모든 CONTINUE를 먼저 합쳐 단일 버퍼 만든 후 디코딩하되, 경계마다 flags 재읽기

**구현 전략**:
1. SST + 후속 CONTINUE를 한 번에 모은다.
2. 단, CONTINUE 경계마다 첫 바이트는 새 flags로 간주하여 디코딩 재시작.

### 3.4 Worksheet 서브스트림 — 셀 레코드

| Opcode | 이름 | 의미 |
|--------|------|------|
| `0x0203` | `Number` | 숫자 셀 — row(u16), col(u16), ixfe(u16), value(double LE 8byte) |
| `0x027E` | `RK` | 압축 숫자 — row, col, ixfe, RkRec(u32, 30bit value) |
| `0x00BD` | `MulRk` | RK 다중 — row, colFirst, RkRec[colCount], colLast |
| `0x00FD` | `LabelSst` | SST 참조 셀 — row, col, ixfe, isst(u32 SST 인덱스) |
| `0x0204` | `Label` | 구형 문자열 셀 (BIFF8 거의 없음, drop 가능) |
| `0x0006` | `Formula` | 수식 셀 — row, col, ixfe, val(8byte FormulaValue), grbit, chn, formula |
| `0x0207` | `String` | Formula 결과가 문자열일 때 직후 따라옴 |
| `0x00BE` | `MulBlank` | 빈 셀 다중 (스킵 가능) |
| `0x00FE` | `Blank` | 빈 셀 (스킵 가능) |
| `0x00BF` | `BoolErr` | 불리언/에러 셀 |
| `0x000C` | `Calccount` | 무시 |
| `0x0080` | `GUTS` | 무시 |
| `0x0208` | `Row` | 행 메타 (높이 등, 무시 가능) |
| `0x00E5` | `MergeCells` | 병합 영역 — `cmcs` (u16) + `Ref8U[cmcs]` (각 8바이트: rwFirst u16, rwLast u16, colFirst u16, colLast u16) |
| `0x023E` | `Window2` | 무시 |
| `0x021E` | `PaneInfo` | 무시 |
| `0x00FB` | `Footer` | 머리글/바닥글 (선택) |
| `0x0014` | `Header` | 머리글 (선택) |

**RK 디코딩**:
```
rk = u32
fInt = rk & 0x02       (1 = 정수, 0 = double)
fDiv100 = rk & 0x01    (1 = 100으로 나눔)
val30 = rk >> 2        (상위 30비트)
if fInt:
  num = val30 (signed → JS Number)
else:
  num = double((val30 << 34) as u64)  // 상위 30비트가 double의 상위 30비트
if fDiv100: num /= 100
```

**MulRk 디코딩**:
- `data` = `[row u16][colFirst u16][rkrec_0...rkrec_n][colLast u16]`
- `rkrec` = `[ixfe u16][rk u32]` = 6바이트
- 셀 수 = `(length - 6) / 6` = `colLast - colFirst + 1`

### 3.5 Formula 결과값

`0x0006 Formula` 레코드의 `val` (8바이트)이 결과 타입을 결정:
- `val[6..8] == 0xFFFF` 이고 `val[0] == 0x00`: 직후 `0x0207 String` 레코드의 텍스트가 결과
- `val[6..8] == 0xFFFF` 이고 `val[0] == 0x01`: boolean (`val[2]`)
- `val[6..8] == 0xFFFF` 이고 `val[0] == 0x02`: error
- `val[6..8] == 0xFFFF` 이고 `val[0] == 0x03`: empty
- 그 외: `val`을 double로 해석

**kordoc 정책**: 수식 텍스트는 무시, 결과값만 셀에 출력 (`includeFormulas` 옵션 미지원, v3.1+ 검토).

---

## 4. 셀 좌표 → IRTable 매핑

### 4.1 1차 패스: 시트별 셀 수집

```typescript
type RawCell = { row: number; col: number; value: string | number | boolean | null }
type RawSheet = {
  name: string
  cells: RawCell[]
  merges: { r1: number; c1: number; r2: number; c2: number }[]
}
```

### 4.2 2차 패스: IRTable 변환

- 시트당: `IRBlock` heading (시트명) + `IRTable`
- `IRTable.rows[r].cells[c]` 채움 — 빈 셀은 `{ text: "" }`
- 병합: `IRCell.colSpan` / `rowSpan`, 가려진 셀은 `merged: true` 표시 (XLSX 파서 동일 패턴)
- 행/열 범위: `max(row) + 1` × `max(col) + 1`. 빈 끝행/끝열 트리밍.

### 4.3 셀 값 포매팅

| BIFF 타입 | JS 변환 |
|-----------|---------|
| Number / RK / Formula(num) | `Number` 그대로, 정수면 정수 표시 |
| LabelSst | SST 룩업 결과 |
| BoolErr (bool) | `"TRUE"` / `"FALSE"` |
| BoolErr (error) | `"#REF!"` 등 표준 코드 |
| Date (서식 코드 분석 필요) | **v1: 무시 (숫자로 표시)**, v3.1+: XF 레코드 + 서식 마스크로 변환 |

**날짜 처리 단순화 정책 (v2.7.0)**:
- XF/Format 레코드 무시 → 모든 숫자는 raw number로 출력
- 추후 v2.8.0에서 `BIFF_FORMAT` (0x041E, 사용자 정의 서식) + `XF` (0x00E0) 처리 추가

---

## 5. 인코딩

| 케이스 | 디코딩 |
|--------|--------|
| `fHighByte=1` | UTF-16LE (Buffer.toString('utf16le')) |
| `fHighByte=0`, CodePage=1200 | UTF-16LE 의 하위 바이트만 사용 — `byte | 0x00` 으로 padding 후 utf16le |
| `fHighByte=0`, CodePage=949 | CP949 디코딩 — `iconv-lite` 또는 `TextDecoder('euc-kr')` |
| 그 외 | UTF-8 폴백 |

**한국 공문서 XLS 우선 순위**: UTF-16LE → CP949 → UTF-8.

`TextDecoder('euc-kr')`는 Node 18+에서 ICU 빌드일 때 동작. fallback으로 `iconv-lite` 의존성 추가 검토.

---

## 6. 에러 케이스

| 케이스 | 처리 |
|--------|------|
| OLE2 매직 불일치 | `kordoc` 일반 `detect()` 가 .xlsx로 오인 → cfb-lenient에서 실패 시 명확한 에러 throw |
| Workbook/Book 스트림 부재 | `Error("XLS: Workbook stream not found")` |
| BIFF 버전 < 0x0600 | `Error("XLS: BIFF5/7 unsupported (Excel 95)")` — v3.1+ 검토 |
| 암호화 (FilePass 0x002F) | `decryptable: false`, 빈 결과 반환 |
| SST CONTINUE 깨짐 | 디코딩 실패 시 부분 결과 + 경고 로그 |
| 잘린 레코드 | 짧으면 스킵하고 계속 (lenient) |

---

## 7. 모듈 분할 계획

```
src/xls/
├── record.ts        ─ BIFF 레코드 리더 + opcode 상수 + 단순 디코더 (RK, MulRk)
├── sst.ts           ─ Shared String Table 디코더 (CONTINUE 처리 포함)
├── encoding.ts      ─ CP949 / UTF-16LE / Compressed Unicode 분기
├── cell.ts          ─ Cell 레코드 → RawCell 변환
├── parser.ts        ─ Globals/Worksheet 서브스트림 워크플로우, IRBlock 생성
└── index.ts         ─ parseXls() 공개 API
```

---

## 8. 참고 레퍼런스

- [MS-XLS] — https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls
- SheetJS source — https://github.com/SheetJS/sheetjs (Apache-2.0, 디코더 로직 학습용)
- OpenOffice 문서 — http://www.openoffice.org/sc/excelfileformat.pdf
- kordoc 기존 OLE2 처리: [src/hwp5/cfb-lenient.ts](../src/hwp5/cfb-lenient.ts)
- kordoc 기존 XLSX 패턴: [src/xlsx/parser.ts](../src/xlsx/parser.ts) — IRTable 변환 참고

---

## 9. 단계별 구현 체크리스트 (Phase 1 W1 D3 ~ W2 D3)

### W1 D3: record.ts
- [ ] `Opcode` 상수 enum
- [ ] `readRecord(stream, offset)` → `{ opcode, length, data }`
- [ ] CONTINUE 자동 결합 옵션
- [ ] RK / MulRk 디코더 단위 함수
- [ ] BOF / EOF 인식

### W1 D4: sst.ts + encoding.ts
- [ ] `decodeSST(records)` → `string[]`
- [ ] CONTINUE 경계 flags 재해석
- [ ] CP949 / UTF-16LE 디코더

### W1 D5: cell.ts
- [ ] Number / LabelSst / Formula(+String) / BoolErr → RawCell
- [ ] MergeCells → 병합 배열

### W2 D1: parser.ts (시트 워크플로우)
- [ ] Globals 서브스트림 → BoundSheet8 수집 + SST 디코딩
- [ ] 시트별 lbPlyPos 점프 → Worksheet 서브스트림 셀 수집

### W2 D2: parser.ts (IRBlock 변환)
- [ ] RawSheet → IRTable (병합 적용)
- [ ] 시트별 heading + table 블록 생성
- [ ] meta.format = 'xls', meta.sheets = [...]

### W2 D3: 통합 + 샘플 검증
- [ ] `src/types.ts` FileType 'xls' 추가
- [ ] `src/detect.ts` OLE2 + Workbook 스트림 분기
- [ ] `src/index.ts` parse() 분기
- [ ] 5건 샘플 변환 결과 시각 검증
