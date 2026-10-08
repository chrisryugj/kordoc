package app.gomdori.kordoc;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * {@link KordocClient} 설정 — Node·kordoc 엔진 위치, 풀 크기, 제한 시간, 입출력 상한.
 *
 * <pre>{@code
 * KordocConfig config = KordocConfig.builder()
 *     .node(Path.of("/usr/bin/node"))
 *     .cli(Path.of("/opt/kordoc/dist/cli.js"))
 *     .maxWorkers(2)
 *     .build();
 * }</pre>
 */
public final class KordocConfig {
    final Path node;
    final Path cli;
    final int maxWorkers;
    final int maxQueue;
    final Duration requestTimeout;
    final Duration startTimeout;
    final Duration warmupTimeout;
    final Duration closeTimeout;
    final Long maxWorkerRssBytes;
    final int maxRequestBytes;
    final int maxResponseBytes;
    final int stderrTailBytes;
    final Map<String, String> env;
    final Path tempDir;

    private KordocConfig(Builder b) {
        this.node = b.node;
        this.cli = b.cli;
        this.maxWorkers = b.maxWorkers;
        this.maxQueue = b.maxQueue;
        this.requestTimeout = b.requestTimeout;
        this.startTimeout = b.startTimeout;
        this.warmupTimeout = b.warmupTimeout;
        this.closeTimeout = b.closeTimeout;
        this.maxWorkerRssBytes = b.maxWorkerRssBytes;
        this.maxRequestBytes = b.maxRequestBytes;
        this.maxResponseBytes = b.maxResponseBytes;
        this.stderrTailBytes = b.stderrTailBytes;
        this.env = Map.copyOf(b.env);
        this.tempDir = b.tempDir;
    }

    public static Builder builder() { return new Builder(); }

    /** 기본 설정 — KORDOC_NODE/PATH 의 node, KORDOC_CLI/PATH 의 kordoc, 워커 1개 */
    public static KordocConfig defaults() { return builder().build(); }

    /** 워커 실행 인자 배열 — shell 을 거치지 않는다 */
    List<String> command() {
        String nodePath = node != null ? node.toString() : firstNonEmpty(System.getenv("KORDOC_NODE"), which("node"));
        String cliPath = cli != null ? cli.toString() : firstNonEmpty(System.getenv("KORDOC_CLI"), which("kordoc"));
        if (nodePath == null) {
            throw new KordocStartException("Node 실행 파일을 찾지 못했습니다 — KordocConfig.builder().node(...) 또는 KORDOC_NODE 를 지정하세요");
        }
        if (cliPath == null) {
            throw new KordocStartException("kordoc 엔진을 찾지 못했습니다 — `npm i -g kordoc` 후 KordocConfig.builder().cli(...) 또는 KORDOC_CLI 를 지정하세요");
        }
        // npm 전역 설치의 kordoc 은 dist/cli.js 를 가리키는 링크다. node 로 직접 실행해 shell 래퍼를 피한다
        Path resolved = Path.of(cliPath);
        try {
            resolved = resolved.toRealPath();
        } catch (java.io.IOException ignored) {
            // 없는 경로는 프로세스 시작에서 실패로 드러난다
        }
        List<String> cmd = new ArrayList<>(List.of(nodePath, resolved.toString(), "parse-worker", "--protocol", "2",
                "--max-request-bytes", Integer.toString(maxRequestBytes),
                "--max-response-bytes", Integer.toString(maxResponseBytes)));
        return cmd;
    }

    private static String firstNonEmpty(String a, String b) {
        return a != null && !a.isEmpty() ? a : b;
    }

    private static String which(String name) {
        String path = System.getenv("PATH");
        if (path == null) return null;
        boolean windows = System.getProperty("os.name", "").toLowerCase().contains("win");
        for (String dir : path.split(File.pathSeparator)) {
            for (String ext : windows ? new String[] {".exe", ".cmd", ""} : new String[] {""}) {
                Path p = Path.of(dir, name + ext);
                if (Files.isRegularFile(p) && Files.isExecutable(p)) return p.toString();
            }
        }
        return null;
    }

    public static final class Builder {
        private Path node;
        private Path cli;
        private int maxWorkers = 1;
        private int maxQueue = 64;
        private Duration requestTimeout;
        private Duration startTimeout = Duration.ofSeconds(30);
        private Duration warmupTimeout = Duration.ofMinutes(5);
        private Duration closeTimeout = Duration.ofSeconds(10);
        private Long maxWorkerRssBytes;
        private int maxRequestBytes = 1024 * 1024;
        private int maxResponseBytes = 256 * 1024 * 1024;
        private int stderrTailBytes = 64 * 1024;
        private final Map<String, String> env = new HashMap<>();
        private Path tempDir;

        private Builder() {}

        /** Node 실행 파일. 없으면 KORDOC_NODE → PATH 의 node */
        public Builder node(Path node) { this.node = node; return this; }

        /** kordoc 엔진 진입점(dist/cli.js 또는 npm 의 kordoc 링크). 없으면 KORDOC_CLI → PATH 의 kordoc */
        public Builder cli(Path cli) { this.cli = cli; return this; }

        /** 상주 워커 수(기본 1). 코어 수로 자동으로 늘리지 않는다 */
        public Builder maxWorkers(int n) {
            if (n < 1) throw new IllegalArgumentException("maxWorkers 는 1 이상이어야 합니다");
            this.maxWorkers = n;
            return this;
        }

        /** 워커를 기다리는 요청 수 상한(기본 64). 넘으면 {@link KordocQueueFullException} */
        public Builder maxQueue(int n) {
            if (n < 0) throw new IllegalArgumentException("maxQueue 는 0 이상이어야 합니다");
            this.maxQueue = n;
            return this;
        }

        /** 요청 기본 제한 시간(대기 포함). null 이면 무제한 */
        public Builder requestTimeout(Duration d) { this.requestTimeout = d; return this; }

        /** 워커 시작(ready)까지 제한 시간 */
        public Builder startTimeout(Duration d) { this.startTimeout = Objects.requireNonNull(d); return this; }

        /** 워밍업 문서 한 건 제한 시간 */
        public Builder warmupTimeout(Duration d) { this.warmupTimeout = Objects.requireNonNull(d); return this; }

        /** close 때 진행 중 요청을 기다리는 시간. 넘으면 워커를 강제 종료한다 */
        public Builder closeTimeout(Duration d) { this.closeTimeout = Objects.requireNonNull(d); return this; }

        /** 응답 rss 가 이 값을 넘으면 그 워커를 작업 사이에 새 워커로 바꾼다. null 이면 끔(기본) */
        public Builder maxWorkerRssBytes(Long bytes) { this.maxWorkerRssBytes = bytes; return this; }

        /** 워커 요청 한 줄 상한 */
        public Builder maxRequestBytes(int n) { this.maxRequestBytes = n; return this; }

        /** 워커 응답 한 줄 상한 — SDK 읽기 상한도 같다 */
        public Builder maxResponseBytes(int n) { this.maxResponseBytes = n; return this; }

        /** 예외에 붙일 워커 stderr 끝부분 크기 */
        public Builder stderrTailBytes(int n) { this.stderrTailBytes = n; return this; }

        /** 워커 환경에 덧붙일 변수(KORDOC_OFFLINE, KORDOC_MODEL_CACHE 등). 나머지는 현재 환경을 물려받는다 */
        public Builder env(String name, String value) { this.env.put(name, value); return this; }

        /** parseBytes 임시 파일 위치(기본: java.io.tmpdir) */
        public Builder tempDir(Path dir) { this.tempDir = dir; return this; }

        public KordocConfig build() { return new KordocConfig(this); }
    }
}
