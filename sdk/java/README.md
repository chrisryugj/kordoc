# kordoc Java SDK

Java 에서 kordoc 으로 한국 문서(HWP·HWPX·PDF·DOCX·XLSX·PPTX …)를 파싱합니다.
상주 kordoc 엔진 워커(`kordoc parse-worker --protocol 2`)를 띄워 재사용하므로 문서마다 Node 를 새로 실행하지 않습니다.
파싱은 엔진 한 곳에서 하며 결과는 Node `parse()` 와 같습니다.

## 설치

이 라이브러리는 엔진을 설치하지 않습니다. 실행 환경에 Node.js(20 이상)와 kordoc 엔진이 따로 있어야 합니다.

```bash
npm i -g kordoc   # 엔진 (PATH 에 kordoc)
```

```xml
<dependency>
  <groupId>app.gomdori.kordoc</groupId>
  <artifactId>kordoc</artifactId>
  <version>0.1.0</version>
</dependency>
```

Java 17 이상. 의존성은 Jackson(`jackson-databind`) 하나입니다.
JVM 은 UTF-8 locale(`LANG=C.UTF-8` 등)에서 실행하세요. POSIX/ASCII locale 의 JVM 은 한국어 파일 경로로 `Path` 를 만들지 못합니다.

엔진 위치는 `KordocConfig.builder().node(...).cli(...)`, 환경변수 `KORDOC_NODE`·`KORDOC_CLI`, PATH 의 `node`·`kordoc` 순으로 찾습니다.
`cli` 에는 엔진의 `dist/cli.js`(또는 npm 이 만든 `kordoc` 링크)를 줍니다. Windows 의 `kordoc.cmd`·pnpm 셸 shim 처럼 node 로 실행할 수 없는 래퍼를 찾으면
옆의 `node_modules/kordoc/dist/cli.js` 로 바꿔 쓰고, 그것도 없으면 `dist/cli.js` 를 지정하라는 오류를 냅니다.
실행 인자는 배열로 넘기며 shell·`npx` 를 쓰지 않습니다.

폐쇄망에서는 [오프라인 번들](../../docs/offline-deployment.md)을 풀고 그 안의 엔진을 가리키면 됩니다.

```java
KordocConfig config = KordocConfig.builder()
    .node(Path.of("/opt/node/bin/node"))
    .cli(Path.of("/opt/kordoc-offline/node_modules/kordoc/dist/cli.js"))
    .env("KORDOC_OFFLINE", "1")
    .build();
```

## 사용

```java
try (KordocClient client = KordocClient.start(KordocConfig.defaults())) {
    ParseResult result = client.parse(Path.of("문서.hwpx"), ParseOptions.builder().tableFormat("gfm").build());
    if (result.success()) {
        System.out.println(result.markdown());
    } else {
        System.err.println(result.code().orElse("") + " " + result.error().orElse("")); // 문서를 읽지 못한 것은 예외가 아니다
    }
}
```

- `parse` · `parseAsync`(`CompletableFuture`) · `parseBytes` · `warmup` · `close`
- `KordocClient.start(...)` 에서 워커를 띄우고 protocol handshake 까지 마칩니다. try-with-resources 를 나가면 소유 워커를 모두 종료·회수합니다.
- `result.raw()` 는 엔진 결과 JSON 원본(`ObjectNode`, 알 수 없는 필드 포함)입니다. `markdown()`·`blocks()`·`pages()`·`metadata()`·`warnings()`·`images()` 를 꺼내 쓸 수 있습니다.
- `result.throwIfFailed()` 는 파싱 실패를 `KordocParseFailedException` 으로 바꿉니다.

### 파싱 옵션

`ParseOptions.builder()` 로 줍니다. 지정하지 않으면 엔진 기본값이고, `false` 를 주면 실제로 끕니다(`ocr(false)` 는 OCR 끔).

`tableFormat("gfm")` · `htmlTables` · `layoutTables("visual"|"keep")` · `classifyTables` · `tables` · `plain` · `scriptTags` ·
`removeHeaderFooter` · `dedupeRunningHeaders` · `keepTrailingEmptyCols` · `keepEmptyParagraphs` · `includeFieldPlaceholders` ·
`pages("1-3")`·`pages(List.of(1, 3))` · `images` · `inlineImages` · `ocr(boolean)`·`ocrForce()` · `formulaOcr` · `password` · `timeout(Duration)`

함수 값(OCR 프로바이더, 진행 콜백)과 입력 경로를 바꾸는 옵션은 받지 않습니다. 잘못된 옵션은 `KordocProtocolException`(`code() == "INVALID_OPTIONS"`)입니다.

### 이미지

| 방식 | 사용 | 동작 |
| --- | --- | --- |
| inline (기본) | `ParseOptions.defaults()` | 이미지 바이트를 결과 JSON 에 base64 로 받습니다 |
| files | `ParseOptions.builder().fileImageTransport(Path.of("/data/assets"))` | 그 디렉터리 아래 요청마다 새 디렉터리에 파일로 받습니다 |

`result.images().get(i).read()` 를 부를 때만 바이트를 해독하거나 파일을 읽습니다. `filename()` 은 Markdown 이 가리키는 이름, `path()` 는 files 방식의 실제 파일입니다.
files 방식의 파일은 호출자 소유이며 클라이언트를 닫아도 남습니다. 이미지가 많은 문서는 files 방식이 응답을 작게 유지합니다.
제한 시간·취소로 실행 중인 워커를 종료하면 그 요청이 쓰던 `assetsDir/kordoc-<id>-*` 디렉터리가 남을 수 있습니다 — 정리는 호출자가 합니다.
`images(false)` 는 이미지 바이트 추출 자체를 생략하는 엔진 옵션으로, 전송 방식과 별개입니다.

## 워커 수명

| 설정 (`KordocConfig.builder()`) | 기본 | 동작 |
| --- | --- | --- |
| `maxWorkers` | 1 | 상주 워커 수. 워커 하나는 한 번에 요청 하나만 처리합니다. 코어 수로 자동으로 늘리지 않습니다 |
| `maxQueue` | 64 | 워커를 기다리는 요청 수 상한. 넘으면 `KordocQueueFullException` |
| `requestTimeout` | 없음 | 요청 제한 시간. 대기 큐 입장부터 결과 수신까지 |
| `startTimeout` | 30초 | 워커가 ready 를 보낼 때까지 |
| `warmupTimeout` | 5분 | 워밍업 문서 한 건 |
| `closeTimeout` | 10초 | 닫을 때 진행 중 요청을 기다리는 시간 |
| `maxWorkerRssBytes` | 끔 | 응답의 rss 가 넘으면 그 워커를 다음 작업 전에 새 워커로 바꿉니다 |

- **제한 시간·취소**: `parseAsync` 가 돌려준 Future 를 취소하거나 제한 시간을 넘기면, 대기 중인 요청은 큐에서만 빠지고 실행 중인 요청은 담당 워커를 즉시 종료·회수합니다(엔진 파싱은 중간에 멈출 수 없어서입니다). 다음 요청은 새 워커가 받습니다. 늦게 온 응답이 다른 요청에 섞이지 않습니다. 동기 `parse` 를 기다리던 스레드가 interrupt 되어도 같습니다.
- **장애**: 워커가 끝나거나 응답이 깨지면 그 요청은 `KordocWorkerCrashedException` 으로 끝나고 자동 재시도하지 않습니다. 다음 요청에서 새 워커를 띄웁니다.
- **RSS 교체**: `maxWorkerRssBytes` 를 켜면 작업이 끝난 뒤 응답의 rss(완료 시점 값, 처리 중 최댓값 아님)를 보고 교체합니다. N 건마다 재시작하지 않습니다. 풀 메모리는 `workerRss()` 의 합으로 봅니다. Node heap 상한은 별도로 `.env("NODE_OPTIONS", "--max-old-space-size=4096")` 처럼 정합니다.
- **워밍업**: `warmup(대표 문서, options)` 은 모든 워커에서 그 문서를 실제로 파싱하고, 교체된 워커도 요청을 받기 전에 같은 문서로 워밍업합니다. 결과(`WarmupReport`)의 경고는 그대로 전달합니다. OCR 을 건너뛴 경고가 있으면 OCR 준비가 된 것이 아닙니다. 워밍업은 처리 경로를 한 번 지나게 할 뿐 최적화 완료를 보장하지 않습니다.
- **닫기**: 새 요청을 막고, 대기 요청은 `KordocClosedException` 으로 끝내고, 진행 요청은 `closeTimeout` 까지 기다린 뒤 워커를 종료합니다.

## 바이트 입력

`parseBytes(data, options)` 는 바이트를 SDK 소유 임시 디렉터리(`tempDir`, 기본 `java.io.tmpdir` 아래 `kordoc-sdk-*`)에 파일로 쓴 뒤 파싱합니다.
큰 입력을 NDJSON 에 다시 싣지 않기 위해서이며 임시 파일 I/O 가 생깁니다. 성공·실패·취소와 관계없이 끝나면 지우고, 닫을 때 디렉터리도 지웁니다.
원본 파일 경로가 필요한 DRM 문서 대체 경로는 바이트 입력에서 파일 입력과 같게 동작하지 않을 수 있습니다.

## 그 밖에

- 워커 환경은 현재 환경을 물려받고 `env(...)` 를 덧붙입니다(`KORDOC_OFFLINE`, `KORDOC_MODEL_CACHE` 등). SDK 는 요청 본문·암호를 로그에 남기지 않습니다.
- `KORDOC_ROOT` 는 MCP 서버의 접근 제한입니다. SDK 는 같은 샌드박스를 제공하지 않으며, 넘긴 경로를 그대로 읽습니다.
- 워커 프로토콜: [docs/parse-worker-protocol.md](../../docs/parse-worker-protocol.md)

## 개발

```bash
npm ci && npm run build                    # 저장소 루트 — 엔진(dist/cli.js)
mvn -f sdk/java/pom.xml verify             # 실제 엔진 + 합성 문서(tests/fixtures/sdk-docs.ts) + 장애 주입 워커, JAR·sources JAR
```

### 소비 예제

```bash
mvn -f sdk/java/pom.xml install
mvn -f sdk/java/examples/consumer/pom.xml compile exec:java -Dexec.args="'문서.hwpx' --gfm"
```
