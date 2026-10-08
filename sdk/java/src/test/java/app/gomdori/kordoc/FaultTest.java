package app.gomdori.kordoc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** 장애 주입 워커(sdk/fixtures/fault-worker.mjs) — 시작 실패·제한 시간·취소·워커 장애·큐 포화·stderr 다량 */
class FaultTest {
    @TempDir
    Path tmp;

    @Test
    void startFailuresAreExplicit() {
        assertThrows(KordocIncompatibleEngineException.class, () -> KordocClient.start(Support.fault("bad-protocol", Map.of()).build()));
        assertThrows(KordocIncompatibleEngineException.class, () -> KordocClient.start(Support.fault("no-capability", Map.of()).build()));
        long t = System.nanoTime();
        assertThrows(KordocStartException.class,
                () -> KordocClient.start(Support.fault("no-ready", Map.of()).startTimeout(Duration.ofSeconds(1)).build()));
        assertTrue(Duration.ofNanos(System.nanoTime() - t).toSeconds() < 10);
        assertThrows(KordocStartException.class,
                () -> KordocClient.start(KordocConfig.builder().node(Path.of("/없는/node")).cli(Path.of("/x.js")).build()));
    }

    @ParameterizedTest
    @ValueSource(strings = {"exit-on-parse", "partial-json", "wrong-id"})
    void workerFailureRaisesAndNextRequestGetsNewWorker(String mode) {
        try (KordocClient client = KordocClient.start(Support.fault(mode, Map.of()).requestTimeout(Duration.ofSeconds(20)).build())) {
            long first = client.workerPids().get(0);
            long t = System.nanoTime();
            assertThrows(KordocWorkerCrashedException.class, () -> client.parse(tmp.resolve("a.docx")));
            assertTrue(Duration.ofNanos(System.nanoTime() - t).toSeconds() < 10);
            assertFalse(Support.alive(first));
            assertThrows(KordocWorkerCrashedException.class, () -> client.parse(tmp.resolve("b.docx"))); // 새 워커, 자동 재시도 없음
        }
    }

    @Test
    void timeoutKillsRunningWorkerAndNextRequestSucceeds() {
        Path state = tmp.resolve("hung");
        try (KordocClient client = KordocClient.start(Support.fault("hang-first", Map.of("KORDOC_FAULT_STATE", state.toString())).build())) {
            long first = client.workerPids().get(0);
            assertThrows(KordocTimeoutException.class,
                    () -> client.parse(tmp.resolve("a.docx"), ParseOptions.builder().timeout(Duration.ofMillis(500)).build()));
            waitDead(first);
            ParseResult r = client.parse(tmp.resolve("b.docx"), ParseOptions.builder().timeout(Duration.ofSeconds(10)).build());
            assertTrue(r.success() && r.markdown().endsWith("b.docx"));
            assertNotEquals(first, client.workerPids().get(0));
        }
    }

    @Test
    void cancelQueuedOnlyRemovesItAndCancelRunningKillsWorker() throws Exception {
        try (KordocClient client = KordocClient.start(Support.fault("hang", Map.of()).build())) {
            long pid = client.workerPids().get(0);
            CompletableFuture<ParseResult> running = client.parseAsync(tmp.resolve("a.docx"));
            Thread.sleep(300);
            CompletableFuture<ParseResult> queued = client.parseAsync(tmp.resolve("b.docx"));
            Thread.sleep(100);
            assertTrue(queued.cancel(true));
            assertThrows(CancellationException.class, queued::join);
            assertTrue(Support.alive(pid) && !running.isDone()); // 대기 취소는 진행 중 작업을 건드리지 않는다
            assertTrue(running.cancel(true));
            waitDead(pid);
        }
    }

    @Test
    void poolSizeAndQueueFull() throws Exception {
        // 지연은 넉넉히 — 400ms 이면 CI 러너가 멈춘 사이 첫 작업이 끝나 큐가 줄어 포화 검사가 플레이크였다(afc2963 java-sdk)
        KordocConfig cfg = Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "2000")).maxWorkers(2).maxQueue(2).build();
        try (KordocClient client = KordocClient.start(cfg)) {
            List<CompletableFuture<ParseResult>> futures = new ArrayList<>();
            for (int i = 0; i < 4; i++) futures.add(client.parseAsync(tmp.resolve("d" + i + ".docx")));
            Thread.sleep(50);
            ExecutionException e = assertThrows(ExecutionException.class, () -> client.parseAsync(tmp.resolve("over.docx")).get());
            assertInstanceOf(KordocQueueFullException.class, e.getCause());
            Set<Long> pids = new HashSet<>();
            for (int i = 0; i < 4; i++) {
                ParseResult r = futures.get(i).get();
                assertEquals("ok:" + tmp.resolve("d" + i + ".docx").toAbsolutePath(), r.markdown()); // 응답 id 대응
                pids.add(r.raw().get("pid").asLong());
            }
            assertEquals(2, pids.size());
            assertEquals(2, client.workerPids().size());
        }
    }

    @Test
    void stderrFloodDoesNotDeadlock() {
        try (KordocClient client = KordocClient.start(Support.fault("stderr-flood", Map.of()).requestTimeout(Duration.ofSeconds(30)).build())) {
            for (int i = 0; i < 3; i++) assertTrue(client.parse(tmp.resolve(i + ".docx")).success());
        }
    }

    @Test
    void rssPolicyReplacesWorkerBetweenJobs() {
        try (KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).maxWorkerRssBytes(1L).build())) {
            long a = client.parse(tmp.resolve("a.docx")).raw().get("pid").asLong();
            long b = client.parse(tmp.resolve("b.docx")).raw().get("pid").asLong();
            assertNotEquals(a, b);
            waitDead(a);
        }
        try (KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).build())) {
            assertEquals(client.parse(tmp.resolve("a.docx")).raw().get("pid"), client.parse(tmp.resolve("b.docx")).raw().get("pid"));
        }
    }

    @Test
    void closeEndsQueuedAndRunning() throws Exception {
        KordocClient client = KordocClient.start(Support.fault("hang", Map.of()).closeTimeout(Duration.ofMillis(500)).build());
        long pid = client.workerPids().get(0);
        CompletableFuture<ParseResult> running = client.parseAsync(tmp.resolve("a.docx"));
        CompletableFuture<ParseResult> queued = client.parseAsync(tmp.resolve("b.docx"));
        Thread.sleep(200);
        client.close();
        for (CompletableFuture<ParseResult> f : List.of(running, queued)) {
            ExecutionException e = assertThrows(ExecutionException.class, f::get);
            assertInstanceOf(KordocClosedException.class, e.getCause());
        }
        assertFalse(Support.alive(pid));
    }

    private static void waitDead(long pid) {
        long end = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (Support.alive(pid) && System.nanoTime() < end) {
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        assertFalse(Support.alive(pid), "pid " + pid + " 가 남아 있다");
    }
}
