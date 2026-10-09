# parse-worker 프로토콜

`kordoc parse-worker` 는 프로세스를 띄워 둔 채 stdin 의 JSON 한 줄마다 stdout 에 JSON 한 줄로 답합니다(NDJSON, UTF-8).
파일마다 node 를 새로 띄우지 않으므로 엔진 초기화 비용이 한 번만 듭니다.
Java·Python SDK(`sdk/java`, `sdk/python`)는 protocol 2 를 씁니다.

| 버전 | 실행 | 용도 |
| --- | --- | --- |
| 1 | `kordoc parse-worker` (기본) | 종전 계약. 요청·응답·동작을 바꾸지 않습니다 |
| 2 | `kordoc parse-worker --protocol 2` | `ParseOptions` 전달, 이미지 파일 전송, 오류 code, 입출력 상한 |

지원하지 않는 버전을 주면 ready 줄 없이 stderr 에 사유를 쓰고 종료 코드 2 로 끝납니다.

## protocol 2

### 시작

```json
{"ready":true,"version":"4.19.2","protocol":2,"capabilities":["parse","options","transport.images.inline","transport.images.files"]}
```

호스트는 `protocol` 과 필요한 `capabilities` 를 확인합니다. 맞지 않으면 다른 실행 방식으로 대체하지 말고 오류로 끝내야 합니다.
ready 는 요청을 받을 수 있다는 뜻일 뿐, 워밍업이 끝났다는 뜻은 아닙니다.

### 요청

```json
{"id":1,"cmd":"parse","file":"/abs/문서.hwpx","options":{"tableFormat":"gfm","ocr":false},"transport":{"images":"inline"}}
{"cmd":"quit"}
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `id` | O | 양의 안전한 정수. 워커 수명 동안 다시 쓰면 `DUPLICATE_ID` |
| `cmd` | O | `"parse"` 또는 `"quit"` |
| `file` | O | 입력 파일의 절대 경로 |
| `options` | | 아래 허용 목록의 `ParseOptions` |
| `transport` | | `{"images": "inline" \| "files", "assetsDir": "/abs/dir"}` |

요청은 한 번에 하나씩 순서대로 처리합니다. 동시에 처리하려면 워커를 여러 개 띄웁니다.
`{"cmd":"quit"}` 이나 stdin EOF 를 받으면 마지막 응답까지 다 쓴 뒤 종료 코드 0 으로 끝납니다.
stdout 이 닫히면(EPIPE) 남은 요청을 버리고, stdin EOF 를 기다리지 않은 채 종료 코드 0 으로 끝납니다.
워커는 stdout 이 닫힌 것을 다음 응답을 쓸 때 알아챕니다. 그 밖의 쓰기 오류는 0 이 아닌 코드로 끝납니다.

### options 허용 목록

| 묶음 | 키 |
| --- | --- |
| 표·구조 | `tableFormat`(`"gfm"`), `htmlTables`, `layoutTables`(`"visual"`·`"keep"`), `classifyTables`, `tables` |
| 텍스트·서식 | `plain`, `scriptTags`, `removeHeaderFooter`, `dedupeRunningHeaders` |
| 빈 내용·입력란 | `keepTrailingEmptyCols`, `keepEmptyParagraphs`, `includeFieldPlaceholders` |
| 범위·이미지 | `pages`(문자열 또는 양의 정수 배열), `images`, `inlineImages` |
| OCR·암호 | `ocr`(`true`·`false`·`"force"`), `formulaOcr`, `password` |

- 키를 빼면 엔진 기본값입니다. `false` 를 주면 실제로 `false` 를 넘깁니다(예: `ocr: false` 는 OCR 끔).
- 목록에 없는 키, 잘못된 타입, `htmlTables` 와 `tableFormat` 동시 지정은 `INVALID_OPTIONS` 입니다.
- 함수 값(`ocr` 프로바이더, `onProgress`)은 받지 않습니다. `filePath` 는 워커가 `file` 로 정하며 요청으로 바꿀 수 없습니다.
- protocol 1 의 `ocr: "off" | "auto"` 문자열은 protocol 2 에서 쓰지 않습니다.

### 응답

```json
{"id":1,"rss":123456789,"result":{"success":true,"fileType":"hwpx","markdown":"…","blocks":[…]}}
{"id":2,"rss":123456789,"result":{"success":false,"fileType":"unknown","error":"…","code":"FILE_NOT_FOUND"}}
{"id":3,"error":{"code":"INVALID_OPTIONS","message":"options: Unrecognized key(s) in object: 'filePath'"}}
```

- `result` 는 `kordoc 문서 --format json` 과 같은 `ParseResult` 입니다. 문서를 읽지 못한 것도 `success: false` 결과로 옵니다.
- `error` 는 요청이나 전송이 잘못된 경우입니다. 요청에 올바른 `id` 가 있으면 함께 돌려줍니다.
- `rss` 는 응답 직전의 워커 RSS(바이트)입니다. 처리 중 최댓값이 아닙니다. 호스트가 워커 교체 시점을 정하는 데 씁니다.

| error.code | 뜻 |
| --- | --- |
| `INVALID_JSON` | JSON 이 아닌 줄 |
| `INVALID_REQUEST` | 객체가 아님, `id`·`cmd`·`file`·`transport` 가 잘못됨, 모르는 최상위 필드 |
| `INVALID_OPTIONS` | `options` 허용 목록·타입 위반, 함께 쓸 수 없는 옵션 |
| `UNSUPPORTED_COMMAND` | 모르는 `cmd` |
| `DUPLICATE_ID` | 이미 쓴 `id` |
| `REQUEST_TOO_LARGE` | 요청 줄이 상한을 넘음(기본 1MiB, `--max-request-bytes`) |
| `RESPONSE_TOO_LARGE` | 응답 줄이 상한을 넘음(기본 256MiB, `--max-response-bytes`). 잘린 결과를 보내지 않습니다 |
| `ASSET_WRITE_FAILED` | `files` 전송에서 이미지 파일을 쓰지 못함 |

### 이미지 전송

| `transport.images` | 동작 |
| --- | --- |
| `"inline"` (기본) | 이미지 바이트를 base64 문자열로 결과에 싣습니다(`--format json` 과 같음) |
| `"files"` | `assetsDir` 아래 요청마다 새 디렉터리(`kordoc-<id>-XXXXXX`)를 만들어 바이트를 쓰고, 그 경로를 응답 `assetsDir` 로 줍니다 |

`files` 에서는 `result.images[]` 와 블록의 `imageData`(목록 children·표 칸 blocks·captionBlocks 포함)에서 `data` 대신 `dataRef` 를 보냅니다.

```json
{"filename":"image_001.png","mimeType":"image/png","source":"word/media/image1.png","dataRef":{"path":"image_001.png","byteLength":14}}
```

- `dataRef.path` 는 응답 `assetsDir` 기준 파일 이름입니다. Markdown·IR 의 이미지 이름(`filename`)은 그대로입니다.
- 같은 바이트는 한 파일을 함께 가리킵니다. 이름이 같아도 바이트가 다르면 다른 파일로 씁니다.
- 파일은 새로 만들기만 하고 기존 파일이나 링크를 덮어쓰지 않습니다. `assetsDir` 가 링크면 실제 경로 아래에 만듭니다.
- `assetsDir` 와 그 안의 파일은 호출자 소유입니다. 워커는 응답을 보낸 뒤 지우지 않습니다. 응답을 보내지 못한 요청의 디렉터리만 지웁니다.
- 이미지가 없으면 디렉터리를 만들지 않고 응답에 `assetsDir` 를 넣지 않습니다.
- `options.inlineImages`(Markdown 안 data URI)와 `options.images: false`(바이트 추출 생략)는 전송 모드와 따로 동작합니다.

### stdout·stderr

stdout 에는 NDJSON 만 씁니다. 엔진 로그와 PDF 라이브러리 경고는 stderr 로 갑니다. 호스트는 stderr 를 계속 읽어 비워야 워커가 막히지 않습니다.

## protocol 1

```text
시작 {"ready":true,"version":"4.18.8","protocol":1}
요청 {"id":1,"file":"a.hwpx","images":false,"ocr":"off","formulaOcr":false,"password":null}
응답 {"id":1,"rss":123456789,"result":{…}}
     {"id":1,"error":"…"}   요청 자체가 잘못됐을 때
종료 {"cmd":"quit"} 또는 stdin 닫힘
```

`ocr` 은 `"off"`(기본, 엔진 기본값) · `"auto"`(OCR 이 필요한 쪽만) · `"force"`(전 쪽)입니다.
