package app.gomdori.kordoc;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * 테스트 공통 — 실제 엔진(빌드한 dist/cli.js)과 합성 문서·Node parse() 기대 결과, 장애 주입 워커.
 * KORDOC_CLI(기본 저장소 dist/cli.js), KORDOC_NODE(기본 PATH 의 node), KORDOC_SDK_FIXTURES(없으면 tests/fixtures/sdk-docs.ts 로 생성)
 */
final class Support {
    static final Path REPO = Path.of(System.getProperty("user.dir")).resolve("../..").normalize();
    static final Path FAULT_WORKER = REPO.resolve("sdk/fixtures/fault-worker.mjs");
    static final Path PROTOCOL_FIXTURE = REPO.resolve("sdk/fixtures/protocol-v2.json");
    private static Path fixtures;

    private Support() {}

    static Path node() {
        String env = System.getenv("KORDOC_NODE");
        if (env != null && !env.isEmpty()) return Path.of(env);
        for (String dir : System.getenv("PATH").split(java.io.File.pathSeparator)) {
            Path p = Path.of(dir, "node");
            if (Files.isExecutable(p)) return p;
        }
        throw new IllegalStateException("node 가 없습니다");
    }

    static Path cli() {
        String env = System.getenv("KORDOC_CLI");
        Path p = env != null && !env.isEmpty() ? Path.of(env) : REPO.resolve("dist/cli.js");
        if (!Files.exists(p)) throw new IllegalStateException("엔진이 없습니다: " + p + " — 저장소에서 `npm run build` 하거나 KORDOC_CLI 를 지정하세요");
        return p;
    }

    static KordocConfig.Builder engine() {
        return KordocConfig.builder().node(node()).cli(cli());
    }

    static KordocConfig.Builder fault(String mode, Map<String, String> env) {
        KordocConfig.Builder b = KordocConfig.builder().node(node()).cli(FAULT_WORKER).env("KORDOC_FAULT", mode);
        env.forEach(b::env);
        return b;
    }

    static synchronized Path fixtures() throws IOException, InterruptedException {
        if (fixtures != null) return fixtures;
        String env = System.getenv("KORDOC_SDK_FIXTURES");
        if (env != null && !env.isEmpty()) return fixtures = Path.of(env);
        Path out = Files.createTempDirectory("kordoc-sdk-fixtures-");
        Process p = new ProcessBuilder(node().toString(), "--import", "tsx", REPO.resolve("tests/fixtures/sdk-docs.ts").toString(), out.toString())
                .directory(REPO.toFile()).inheritIO().start();
        if (p.waitFor() != 0) throw new IllegalStateException("sdk-docs.ts 실패");
        return fixtures = out;
    }

    static JsonNode expected(String name) throws IOException, InterruptedException {
        return Json.MAPPER.readTree(fixtures().resolve("expected").resolve(name + ".json").toFile());
    }

    static JsonNode manifest() throws IOException, InterruptedException {
        return Json.MAPPER.readTree(fixtures().resolve("manifest.json").toFile());
    }

    /** manifest 의 wire options → ParseOptions (계약 fixture 와 같은 camelCase 키) */
    static ParseOptions optionsOf(JsonNode wire) {
        ParseOptions.Builder b = ParseOptions.builder();
        wire.fields().forEachRemaining(e -> {
            JsonNode v = e.getValue();
            switch (e.getKey()) {
                case "tableFormat" -> b.tableFormat(v.asText());
                case "images" -> b.images(v.asBoolean());
                case "ocr" -> b.ocr(v.asBoolean());
                default -> throw new IllegalArgumentException("테스트가 모르는 옵션: " + e.getKey());
            }
        });
        return b.build();
    }

    static boolean alive(long pid) {
        return ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
    }
}
