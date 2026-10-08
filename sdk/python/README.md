# kordoc Python SDK

Python 에서 kordoc 으로 한국 문서(HWP·HWPX·PDF·DOCX·XLSX·PPTX …)를 파싱합니다.
상주 kordoc 엔진 워커(`kordoc parse-worker --protocol 2`)를 띄워 재사용하므로 문서마다 Node 를 새로 실행하지 않습니다.
파싱은 엔진 한 곳에서 하며 결과는 Node `parse()` 와 같습니다.

## 설치

이 패키지는 엔진을 설치하지 않습니다. 실행 환경에 Node.js(20 이상)와 kordoc 엔진이 따로 있어야 합니다.

```bash
npm i -g kordoc        # 엔진 (PATH 에 kordoc)
pip install kordoc     # SDK (Python 3.11 이상, 외부 의존성 없음)
```

엔진 위치는 `KordocConfig(node=..., cli=...)`, 환경변수 `KORDOC_NODE`·`KORDOC_CLI`, PATH 의 `node`·`kordoc` 순으로 찾습니다.
`cli` 에는 엔진의 `dist/cli.js`(또는 npm 이 만든 `kordoc` 링크)를 줍니다. 실행 인자는 배열로 넘기며 shell·`npx` 를 쓰지 않습니다.

폐쇄망에서는 [오프라인 번들](../../docs/offline-deployment.md)을 풀고 그 안의 엔진을 가리키면 됩니다.

```python
from kordoc import KordocClient, KordocConfig

config = KordocConfig(
    node="/opt/node/bin/node",
    cli="/opt/kordoc-offline/node_modules/kordoc/dist/cli.js",
    env={"KORDOC_OFFLINE": "1"},
)
```

## 사용

```python
from kordoc import KordocClient

with KordocClient() as client:
    result = client.parse("문서.hwpx", table_format="gfm")   # 중첩 표를 부모·자식 트리로 편 GFM
    if result.success:
        print(result.markdown)
    else:
        print(result.code, result.error)                      # 문서를 읽지 못한 것은 예외가 아니다
```

```python
import asyncio
from kordoc import AsyncKordocClient

async def main() -> None:
    async with AsyncKordocClient(max_workers=2) as client:
        results = await asyncio.gather(*(client.parse(p) for p in ["a.hwp", "b.pdf"]))

asyncio.run(main())
```

- `parse(path, **options)` · `parse_bytes(data, **options)` · `warmup(path, **options)` · `close()`(`aclose()`)
- `with` / `async with` 를 나가면 소유 워커를 모두 종료·회수합니다. 패키지 import·클라이언트 생성만으로는 프로세스를 띄우지 않습니다.
- `result.raw` 는 엔진 결과 JSON 원본입니다(알 수 없는 필드 포함). `markdown`·`blocks`·`pages`·`metadata`·`warnings`·`images` 를 꺼내 쓸 수 있습니다.
- `result.raise_for_error()` 는 파싱 실패를 `KordocParseFailed` 로 바꿉니다.

### 파싱 옵션

키워드 인자로 줍니다. 빼면 엔진 기본값이고, `False` 를 주면 실제로 끕니다(`ocr=False` 는 OCR 끔).

`table_format`(`"gfm"`) · `html_tables` · `layout_tables`(`"visual"`·`"keep"`) · `classify_tables` · `tables` · `plain` · `script_tags` ·
`remove_header_footer` · `dedupe_running_headers` · `keep_trailing_empty_cols` · `keep_empty_paragraphs` · `include_field_placeholders` ·
`pages`(`"1-3"` 또는 `[1, 3]`) · `images` · `inline_images` · `ocr`(`True`·`False`·`"force"`) · `formula_ocr` · `password`

함수 값(OCR 프로바이더, 진행 콜백)과 입력 경로를 바꾸는 옵션은 받지 않습니다. 잘못된 옵션은 `KordocProtocolError`(`code="INVALID_OPTIONS"`)입니다.

### 이미지

| 방식 | 사용 | 동작 |
| --- | --- | --- |
| inline (기본) | `parse(p)` | 이미지 바이트를 결과 JSON 에 base64 로 받습니다 |
| files | `parse(p, image_transport="files", assets_dir="/data/assets")` | `assets_dir` 아래 요청마다 새 디렉터리에 파일로 받습니다 |

`result.images[i].read()` 를 부를 때만 바이트를 해독하거나 파일을 읽습니다. `filename` 은 Markdown 이 가리키는 이름, `path` 는 files 방식의 실제 파일입니다.
files 방식의 파일은 호출자 소유이며 클라이언트를 닫아도 남습니다. 이미지가 많은 문서는 files 방식이 응답을 작게 유지합니다.
`images=False` 는 이미지 바이트 추출 자체를 생략하는 엔진 옵션으로, 전송 방식과 별개입니다.

## 워커 수명

| 설정 (`KordocConfig`) | 기본 | 동작 |
| --- | --- | --- |
| `max_workers` | 1 | 상주 워커 수. 워커 하나는 한 번에 요청 하나만 처리합니다. 코어 수로 자동으로 늘리지 않습니다 |
| `max_queue` | 64 | 워커를 기다리는 요청 수 상한. 넘으면 `KordocQueueFull` |
| `request_timeout` | 없음 | 요청 제한 시간(초). 대기 큐 입장부터 결과 수신까지 |
| `start_timeout` | 30 | 워커가 ready 를 보낼 때까지 |
| `warmup_timeout` | 300 | 워밍업 문서 한 건 |
| `close_timeout` | 10 | 닫을 때 진행 중 요청을 기다리는 시간 |
| `max_worker_rss_bytes` | 끔 | 응답의 rss 가 넘으면 그 워커를 다음 작업 전에 새 워커로 바꿉니다 |

- **제한 시간·취소**: 대기 중인 요청은 큐에서만 빠집니다. 실행 중인 요청은 담당 워커를 즉시 종료·회수합니다(엔진 파싱은 중간에 멈출 수 없어서입니다). 다음 요청은 새 워커가 받습니다. 늦게 온 응답이 다른 요청에 섞이지 않습니다. 비동기에서는 Task 취소가 같은 규칙을 따릅니다.
- **장애**: 워커가 끝나거나 응답이 깨지면 그 요청은 `KordocWorkerCrashed` 로 끝나고 자동 재시도하지 않습니다. 다음 요청에서 새 워커를 띄웁니다.
- **RSS 교체**: `max_worker_rss_bytes` 를 켜면 작업이 끝난 뒤 응답의 rss(완료 시점 값, 처리 중 최댓값 아님)를 보고 교체합니다. N 건마다 재시작하지 않습니다. 풀 메모리는 `worker_info()` 의 rss 합으로 봅니다. Node heap 상한은 별도로 `env={"NODE_OPTIONS": "--max-old-space-size=4096"}` 처럼 정합니다.
- **워밍업**: `warmup(대표 문서, **options)` 은 모든 워커에서 그 문서를 실제로 파싱하고, 교체된 워커도 요청을 받기 전에 같은 문서로 워밍업합니다. 결과(`WarmupReport`)의 경고는 그대로 전달합니다. OCR 을 건너뛴 경고가 있으면 OCR 준비가 된 것이 아닙니다. 워밍업은 처리 경로를 한 번 지나게 할 뿐 최적화 완료를 보장하지 않습니다.
- **닫기**: 새 요청을 막고, 대기 요청은 `KordocClosed` 로 끝내고, 진행 요청은 `close_timeout` 까지 기다린 뒤 워커를 종료합니다.

## 바이트 입력

`parse_bytes(data)` 는 바이트를 SDK 소유 임시 디렉터리(`temp_dir`, 기본 시스템 임시 폴더 아래 `kordoc-sdk-*`)에 파일로 쓴 뒤 파싱합니다.
큰 입력을 NDJSON 에 다시 싣지 않기 위해서이며 임시 파일 I/O 가 생깁니다. 성공·실패·취소와 관계없이 끝나면 지우고, 닫을 때 디렉터리도 지웁니다.
원본 파일 경로가 필요한 DRM 문서 대체 경로는 바이트 입력에서 파일 입력과 같게 동작하지 않을 수 있습니다.

## 그 밖에

- 워커 환경은 현재 환경을 물려받고 `env` 를 덧붙입니다(`KORDOC_OFFLINE`, `KORDOC_MODEL_CACHE` 등). SDK 는 요청 본문·암호를 로그에 남기지 않습니다.
- `KORDOC_ROOT` 는 MCP 서버의 접근 제한입니다. SDK 는 같은 샌드박스를 제공하지 않으며, 넘긴 경로를 그대로 읽습니다.
- 워커 프로토콜: [docs/parse-worker-protocol.md](../../docs/parse-worker-protocol.md)

## 개발

```bash
npm ci && npm run build                     # 저장소 루트 — 엔진(dist/cli.js)
cd sdk/python
python -m venv .venv && . .venv/bin/activate
python -m pip install -e '.[test]'
python -m pytest                            # 실제 엔진 + 합성 문서(tests/fixtures/sdk-docs.ts) + 장애 주입 워커
python -m build
```
