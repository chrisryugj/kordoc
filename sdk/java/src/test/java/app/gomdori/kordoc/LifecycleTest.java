package app.gomdori.kordoc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.File;
import java.io.IOException;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * 수명 관리 회귀 — 제한 시간 타이머 회수, 요청 크기 검사, 닫힌 뒤 parseBytes, 엔진 경로 탐색, kill 창·워밍업·close 경합, 콜백 스레드.
 * 경합 재현은 내부 잠금을 테스트가 먼저 쥐어(잠금 선점) 스케줄을 고정한다 — 소스에 지연을 넣지 않는다
 */
class LifecycleTest {
    @TempDir
    Path tmp;

    // ─── 헬퍼 ───────────────────────────────────────────

    private static Object field(Object o, String name) throws Exception {
        Field f = o.getClass().getDeclaredField(name);
        f.setAccessible(true);
        return f.get(o);
    }

    private static WorkerProcess worker(KordocClient client, int slot) throws Exception {
        return (WorkerProcess) field(((Object[]) field(client, "slots"))[slot], "worker");
    }

    private static boolean at(Thread t, Thread.State state, String frame) {
        return t.getState() == state && Arrays.stream(t.getStackTrace()).anyMatch(f -> (f.getClassName() + "." + f.getMethodName()).contains(frame));
    }

    /** 이름이 prefix 로 시작하고 state 상태로 frame 안에 서 있는 스레드를 millis 까지 기다린다. 없으면 null */
    private static Thread awaitThread(String prefix, Thread.State state, String frame, long millis) throws InterruptedException {
        long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(millis);
        do {
            for (Thread t : Thread.getAllStackTraces().keySet()) if (t.getName().startsWith(prefix) && at(t, state, frame)) return t;
            Thread.sleep(1);
        } while (System.nanoTime() < end);
        return null;
    }

    /** t 가 끝나거나 state 상태로 frame 안에 설 때까지 millis 까지 기다린다 */
    private static void awaitDoneOr(Thread t, Thread.State state, String frame, long millis) throws InterruptedException {
        long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(millis);
        while (t.isAlive() && !at(t, state, frame) && System.nanoTime() < end) Thread.sleep(1);
    }

    /** 이름 붙은 스레드에서 돌려 결과나 던진 예외를 돌려준다 */
    private static CompletableFuture<Object> onThread(String name, Supplier<Object> body) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return body.get();
            } catch (RuntimeException e) {
                return e;
            }
        }, r -> new Thread(r, name).start());
    }

    /** 이 JVM 이 띄운 살아 있는 프로세스(워커) */
    private static Set<Long> children() {
        return ProcessHandle.current().children().filter(ProcessHandle::isAlive).map(ProcessHandle::pid).collect(Collectors.toSet());
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ─── 타이머·요청 크기·임시 디렉터리·엔진 경로 ───────────

    private static int pendingTimers(KordocClient client) throws Exception {
        Field f = KordocClient.class.getDeclaredField("timer");
        f.setAccessible(true);
        return ((ScheduledThreadPoolExecutor) f.get(client)).getQueue().size();
    }

    @Test
    void finishedRequestsDoNotKeepTheirTimeoutTimers() throws Exception {
        // 종전: 끝난 요청의 제한 시간 타이머가 남아 결과(이미지 base64 포함)를 제한 시간까지 붙잡았다
        try (KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).requestTimeout(Duration.ofMinutes(10)).build())) {
            for (int i = 0; i < 20; i++) assertTrue(client.parse(tmp.resolve("a.docx")).success());
            assertEquals(0, pendingTimers(client));
        }
    }

    @Test
    void completionThreadsDoNotKeepFinishedResults() throws Exception {
        // 완료 스레드는 재사용된다 — 끝난 요청의 결과(이미지 base64 포함)를 붙잡지 않는지 회수로 본다
        try (KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).build())) {
            WeakReference<ParseResult> last = new WeakReference<>(client.parse(tmp.resolve("a.docx")));
            for (int i = 0; i < 40 && last.get() != null; i++) {
                System.gc();
                Thread.sleep(50);
            }
            assertNull(last.get(), "끝난 요청의 결과를 완료 스레드가 붙잡고 있다");
        }
    }

    @Test
    void oversizedRequestIsRejectedBeforeReachingAWorker() {
        try (KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).maxRequestBytes(4096).build())) {
            List<Long> pids = client.workerPids();
            KordocProtocolException e = assertThrows(KordocProtocolException.class,
                    () -> client.parse(tmp.resolve("a.docx"), ParseOptions.builder().password("x".repeat(10000)).build()));
            assertEquals("REQUEST_TOO_LARGE", e.code());
            assertEquals(pids, client.workerPids());
            assertTrue(client.parse(tmp.resolve("a.docx")).success());
        }
    }

    private static int lineLength(KordocClient client, Path file, ParseOptions options) throws Exception {
        Method m = KordocClient.class.getDeclaredMethod("request", Path.class, ParseOptions.class);
        m.setAccessible(true);
        return ((byte[]) field(m.invoke(client, file, options), "line")).length;
    }

    @Test
    void warmupSizeLimitMatchesParse() throws Exception {
        // 종전: warmup 은 개행까지 세어, parse 가 받는 경계(요청 줄 = 상한)의 문서를 REQUEST_TOO_LARGE 로 거부했다.
        // 요청 id 가 한 자리인 동안(1~9)만 재므로 줄 길이가 호출마다 같다
        int max = 4096;
        try (KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).maxRequestBytes(max).build())) {
            Path file = tmp.resolve("a.docx");
            int base = lineLength(client, file, ParseOptions.builder().password("").build());
            ParseOptions atLimit = ParseOptions.builder().password("p".repeat(max - base)).build();
            ParseOptions over = ParseOptions.builder().password("p".repeat(max - base + 1)).build();
            assertEquals(max, lineLength(client, file, atLimit));
            assertTrue(client.parse(file, atLimit).success(), "parse 는 상한과 같은 줄을 보낸다");
            assertTrue(client.warmup(file, atLimit).ok(), "warmup 도 같은 경계를 써야 한다");
            assertEquals("REQUEST_TOO_LARGE", assertThrows(KordocProtocolException.class, () -> client.parse(file, over)).code());
            assertEquals("REQUEST_TOO_LARGE", assertThrows(KordocProtocolException.class, () -> client.warmup(file, over)).code());
        }
    }

    @Test
    void parseBytesAfterCloseThrowsClosed() {
        KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).build());
        assertTrue(client.parseBytes(new byte[] {1}).success());
        client.close();
        assertThrows(KordocClosedException.class, () -> client.parseBytes(new byte[] {1}));
    }

    @Test
    void parseBytesRacingCloseLeavesNoTempRoot() throws Exception {
        // close 와 겹친 parseBytes 는 처리되거나 KordocClosedException 으로 끝나고 kordoc-sdk-* 루트를 남기지 않는다. 창을 고정하지 않고 시점만 흩뜨린다
        Path temp = Files.createDirectories(tmp.resolve("temp"));
        KordocConfig cfg = Support.fault("ok", Map.of()).tempDir(temp).build();
        for (int i = 0; i < 20; i++) {
            KordocClient c = KordocClient.start(cfg);
            CompletableFuture<Object> b = onThread("test-bytes-" + i, () -> c.parseBytes(new byte[] {1}));
            sleep(i % 4);
            c.close();
            Object out = b.get(10, TimeUnit.SECONDS);
            assertTrue(out instanceof ParseResult || out instanceof KordocClosedException, "parseBytes 결과: " + out);
        }
        try (Stream<Path> left = Files.list(temp)) {
            assertEquals(List.of(), left.toList());
        }
    }

    /** KordocClient.deleteTree 를 불러 "ok" 나 던진 예외를 돌려준다 */
    private static Object deleteTree(Path p) {
        try {
            Method m = KordocClient.class.getDeclaredMethod("deleteTree", Path.class);
            m.setAccessible(true);
            m.invoke(null, p);
            return "ok";
        } catch (InvocationTargetException e) {
            return e.getCause();
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void tempTreeDeletionToleratesConcurrentDeletion() throws Exception {
        // 종전: close 의 루트 삭제가 parseBytes 가 지우던 입력 디렉터리를 만나면 UncheckedIOException 으로 끝나고 삭제를 멈췄다.
        // 그 창을 고정할 잠금이 없어 두 삭제를 직접 겹친다
        for (int round = 0; round < 20; round++) {
            Path root = Files.createDirectories(tmp.resolve("root-" + round));
            List<Path> inputs = new ArrayList<>();
            for (int i = 0; i < 200; i++) {
                Path d = Files.createDirectories(root.resolve("in-" + i));
                Files.write(d.resolve("input"), new byte[] {1});
                inputs.add(d);
            }
            CountDownLatch go = new CountDownLatch(1);
            CompletableFuture<Object> byInputs = onThread("test-delete-inputs", () -> {
                try {
                    go.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                Object r = "ok";
                for (Path d : inputs) {
                    Object one = deleteTree(d);
                    if (!"ok".equals(one)) r = one;
                }
                return r;
            });
            go.countDown();
            Object byRoot = deleteTree(root);
            assertEquals("ok", byRoot, "루트 삭제 (" + round + "회째)");
            assertEquals("ok", byInputs.get(10, TimeUnit.SECONDS), "입력 디렉터리 삭제 (" + round + "회째)");
            assertFalse(Files.exists(root), "루트가 남았다 (" + round + "회째)");
        }
    }

    @Test
    void shellShimCliResolvesToDistCliJs() throws Exception {
        // Windows kordoc.cmd·pnpm 셸 shim 은 node 로 실행할 수 없다 — 옆의 node_modules/kordoc/dist/cli.js 로, 없으면 분명한 오류
        Path shim = Files.writeString(tmp.resolve("kordoc.cmd"), "@ECHO off\r\n");
        Path cli = tmp.resolve("node_modules/kordoc/dist/cli.js");
        Files.createDirectories(cli.getParent());
        Files.writeString(cli, "#!/usr/bin/env node\n");
        assertEquals(cli.toRealPath().toString(), KordocConfig.builder().node(Path.of("node")).cli(shim).build().command().get(1));
        Path bare = Files.writeString(Files.createDirectories(tmp.resolve("other")).resolve("kordoc"), "#!/bin/sh\nexec node x.js\n");
        KordocStartException e = assertThrows(KordocStartException.class,
                () -> KordocConfig.builder().node(Path.of("node")).cli(bare).build().command());
        assertTrue(e.getMessage().contains("dist/cli.js"));
    }

    private static Path executable(Path p, String body) throws IOException {
        Files.createDirectories(p.getParent());
        Files.writeString(p, body);
        if (!System.getProperty("os.name", "").toLowerCase().contains("win")) Files.setPosixFilePermissions(p, PosixFilePermissions.fromString("rwxr-xr-x"));
        return p;
    }

    @Test
    void whichFindsWindowsCmdShim() throws IOException {
        // Windows 에서 PATH 의 kordoc 은 npm 이 만든 kordoc.cmd 다 — 확장자를 붙여서도 찾는다
        Path bin = Files.createDirectories(tmp.resolve("npm"));
        Path shim = executable(bin.resolve("kordoc.cmd"), "@ECHO off\r\n");
        Path node = executable(bin.resolve("node.exe"), "MZ");
        String path = tmp.resolve("empty") + File.pathSeparator + bin;
        assertEquals(shim.toString(), KordocConfig.which("kordoc", path, true));
        assertEquals(node.toString(), KordocConfig.which("node", path, true));
        assertNull(KordocConfig.which("kordoc", path, false), "Windows 가 아니면 확장자를 붙이지 않는다");
        assertNull(KordocConfig.which("kordoc", null, true));
    }

    // ─── 제한 시간·취소 kill 창 ─────────────────────────

    @Test
    void cancelInsideTheKillWindowStillKillsTheWorker() throws Exception {
        // 종전: runningOn 을 정한 뒤 워커의 current 를 정하기 전에 취소가 오면 kill 이 건너뛰어져, 멈춘 워커가 자리를 영구히 점유했다.
        // 워커의 currentLock 을 선점해 디스패처를 그 자리에 세우고, 다른 스레드에서 취소한 뒤 놓는다
        KordocConfig cfg = Support.fault("by-file", Map.of()).closeTimeout(Duration.ofMillis(500)).build();
        for (int i = 0; i < 3; i++) {
            try (KordocClient client = KordocClient.start(cfg)) {
                Object currentLock = field(worker(client, 0), "currentLock");
                Thread canceller;
                synchronized (currentLock) {
                    CompletableFuture<ParseResult> f = client.parseAsync(tmp.resolve("hang.docx"));
                    assertNotNull(awaitThread("kordoc-sdk-dispatch-0", Thread.State.BLOCKED, "WorkerProcess.", 5000), "디스패처가 워커 잠금 앞에 서지 않았다");
                    canceller = new Thread(() -> f.cancel(true), "test-cancel");
                    canceller.start();
                    awaitDoneOr(canceller, Thread.State.BLOCKED, "KordocClient", 3000);
                    if (!canceller.isAlive()) awaitThread("kordoc-sdk-kill", Thread.State.BLOCKED, "WorkerProcess.", 3000);
                }
                canceller.join(5000);
                ParseResult r = client.parse(tmp.resolve("b.docx"), ParseOptions.builder().timeout(Duration.ofSeconds(5)).build());
                assertTrue(r.success() && r.markdown().endsWith("b.docx"), "취소한 요청의 워커가 자리를 점유한다 (" + i + "회째)");
            }
        }
    }

    /** 디스패처가 작업 없이 대기 큐를 기다린다 */
    private static boolean idle(Thread dispatcher) {
        return dispatcher.getState() == Thread.State.WAITING && Arrays.stream(dispatcher.getStackTrace())
                .filter(f -> !f.getClassName().startsWith("java.")).findFirst().map(f -> f.getMethodName().equals("dispatch")).orElse(false);
    }

    @Test
    void cancelStillCancelsWhenTheKilledWorkerFailsFirst() throws Exception {
        // 종전: 취소가 건 워커 종료의 장애가 취소보다 먼저 Future 를 끝내, cancel 이 false 를 돌려주고 KordocWorkerCrashedException 으로 끝났다.
        // 취소 정리의 마지막 단계(대기 큐 제거)에서 클라이언트 잠금을 놓고 디스패처가 그 장애를 다 처리할 때까지 세운다
        try (KordocClient client = KordocClient.start(Support.fault("by-file", Map.of()).closeTimeout(Duration.ofMillis(500)).build())) {
            Object lock = field(client, "lock");
            Object completionLock = field(client, "completionLock");
            Field completions = KordocClient.class.getDeclaredField("completions");
            completions.setAccessible(true);
            Thread[] dispatcher = new Thread[1];
            ArrayDeque<Object> gate = new ArrayDeque<>() {
                @Override
                public boolean remove(Object job) {
                    long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                    try {
                        CompletableFuture<?> f = (CompletableFuture<?>) field(job, "future");
                        while (!f.isDone() && System.nanoTime() < end) {
                            synchronized (completionLock) {
                                if (idle(dispatcher[0]) && completions.getInt(client) == 0) break;
                            }
                            lock.wait(5);
                        }
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                    return super.remove(job);
                }
            };
            Field queue = KordocClient.class.getDeclaredField("queue");
            queue.setAccessible(true);
            queue.set(client, gate);
            CompletableFuture<ParseResult> f = client.parseAsync(tmp.resolve("hang.docx"));
            dispatcher[0] = awaitThread("kordoc-sdk-dispatch-0", Thread.State.WAITING, "WorkerProcess.exchange", 5000);
            assertNotNull(dispatcher[0], "요청이 워커에 가지 않았다");
            boolean cancelled = f.cancel(true);
            assertTrue(cancelled && f.isCancelled(), "취소한 요청이 " + f.handle((r, e) -> e).getNow(null) + " 로 끝났다");
        }
    }

    // ─── 워밍업 ─────────────────────────────────────────

    @Test
    void warmupDocumentThatKillsTheWorkerDoesNotBreakLaterRequests() throws Exception {
        // 종전: 워밍업 문서가 워커를 죽이면 이후 교체 워커마다 그 문서로 워밍업하다 죽어, 모든 요청이 "교체 워커 워밍업 실패" 로 끝났다.
        // 워커가 뜰 때마다 pid 를 적어(--require 선행 스크립트) 띄운 수로 본다
        Path starts = tmp.resolve("starts");
        Path preload = Files.writeString(tmp.resolve("count-start.cjs"), "require('fs').appendFileSync(process.env.KORDOC_TEST_STARTS, process.pid + '\\n')\n");
        KordocConfig cfg = Support.fault("by-file", Map.of("KORDOC_TEST_STARTS", starts.toString(), "NODE_OPTIONS", "--require \"" + preload + "\"")).build();
        try (KordocClient client = KordocClient.start(cfg)) {
            assertTrue(client.parse(tmp.resolve("good.docx")).success());
            WarmupReport report = client.warmup(tmp.resolve("crash.docx"), ParseOptions.defaults());
            assertFalse(report.ok());
            for (int i = 0; i < 3; i++) assertTrue(client.parse(tmp.resolve("good-" + i + ".docx")).success(), "워밍업 실패 뒤 " + i + "번째 요청");
            assertEquals(2, Files.readAllLines(starts).size(), "처음 워커와 교체 워커 하나만 떠야 한다 — 실패한 워밍업 문서로 교체 워커를 워밍업했다");
        }
    }

    @Test
    void replacementWarmupFailureDoesNotFailTheRequest() throws Exception {
        // 종전: 교체 워커의 워밍업이 워커를 죽이면 그 요청이 KordocException("교체 워커 워밍업 실패") 으로 끝났다.
        // 처음 워밍업은 성공하고(상태 파일 없음), 상태 파일을 만든 뒤에는 같은 워밍업 문서가 워커를 죽인다
        Path state = tmp.resolve("crash-on");
        try (KordocClient client = KordocClient.start(Support.fault("by-file", Map.of("KORDOC_FAULT_STATE", state.toString())).build())) {
            assertTrue(client.warmup(tmp.resolve("crash-warm.docx"), ParseOptions.defaults()).ok());
            Files.writeString(state, "");
            assertThrows(KordocWorkerCrashedException.class, () -> client.parse(tmp.resolve("crash-now.docx")));
            for (int i = 0; i < 2; i++) {
                ParseResult r = client.parse(tmp.resolve("good-" + i + ".docx"));
                assertTrue(r.success() && r.markdown().endsWith("good-" + i + ".docx"));
            }
        }
    }

    @Test
    void warmupKillerDoesNotKillAWorkerThatAnswered() throws Exception {
        // 종전: 워밍업 킬러가 타이머 스레드에서 조건 없이 kill 해, 응답을 받은 뒤 기한이 지나면 성공으로 보고한 워커가 죽어 있었다.
        // 응답(300ms)은 기한(800ms) 전에 오지만, 응답 대기 중에 currentLock 을 선점해 SDK 가 응답을 마무리하기 전에 기한이 지나게 한다
        KordocConfig cfg = Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "300")).warmupTimeout(Duration.ofMillis(800)).build();
        try (KordocClient client = KordocClient.start(cfg)) {
            WorkerProcess w = worker(client, 0);
            CompletableFuture<Object> report = onThread("test-warmup", () -> client.warmup(tmp.resolve("w.docx"), ParseOptions.defaults()));
            assertNotNull(awaitThread("test-warmup", Thread.State.WAITING, "WorkerProcess.exchange", 5000), "워밍업 요청을 보내지 않았다");
            synchronized (field(w, "currentLock")) {
                Thread.sleep(1300); // 응답 도착(300ms)과 기한(800ms)이 모두 지나도록
            }
            Object r = report.get(10, TimeUnit.SECONDS);
            WarmupReport.Worker one = assertInstanceOf(WarmupReport.class, r, "warmup 결과: " + r).workers().get(0);
            Thread.sleep(300); // 따로 도는 kill 이 끝나도록
            assertEquals(one.success(), w.alive(), "보고(" + one + ")와 워커 생존이 다르다");
        }
    }

    @Test
    void warmupTimeoutKillsAHungWorker() throws Exception {
        // 답하지 않는 워커를 기한에 죽이지 못하면 warmup 이 돌아오지 않는다
        KordocConfig cfg = Support.fault("by-file", Map.of()).warmupTimeout(Duration.ofMillis(500)).closeTimeout(Duration.ofMillis(500)).build();
        try (KordocClient client = KordocClient.start(cfg)) {
            Object r = onThread("test-warmup", () -> client.warmup(tmp.resolve("hang.docx"), ParseOptions.defaults())).get(5, TimeUnit.SECONDS);
            WarmupReport.Worker one = assertInstanceOf(WarmupReport.class, r, "warmup 결과: " + r).workers().get(0);
            assertTrue(!one.success() && one.error().contains("제한 시간"), "보고: " + one);
            assertTrue(client.parse(tmp.resolve("good.docx")).success());
        }
    }

    @Test
    void interruptedWarmupStopsWithoutKillingWorkers() {
        // 종전: interrupt 상태 스레드에서 부른 warmup 이 워커마다 응답 대기에서 깨어나 풀의 워커를 모두 죽이고 실패를 결과로 보고했다
        try (KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).maxWorkers(3).build())) {
            List<Long> pids = client.workerPids();
            Thread.currentThread().interrupt();
            try {
                assertThrows(KordocException.class, () -> client.warmup(tmp.resolve("w.docx"), ParseOptions.defaults()));
                assertTrue(Thread.currentThread().isInterrupted(), "interrupt 상태를 지웠다");
            } finally {
                Thread.interrupted();
            }
            assertEquals(pids, client.workerPids());
            for (long pid : pids) assertTrue(Support.alive(pid), "pid " + pid);
            assertTrue(client.parse(tmp.resolve("a.docx")).success());
        }
    }

    @Test
    void warmupInterruptedOnTheLastWorkerThrows() throws Exception {
        // 종전: 마지막 자리를 워밍업하는 도중 interrupt 되면 던지지 않고 그 워커를 죽인 실패 보고를 정상 반환했다(워밍업 문서까지 등록).
        // 워커가 하나면 첫 자리가 곧 마지막 자리다 — 응답 대기에 선 것을 본 뒤 interrupt 한다
        try (KordocClient client = KordocClient.start(Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "600")).build())) {
            CompletableFuture<Object> out = new CompletableFuture<>();
            CompletableFuture<Boolean> stillInterrupted = new CompletableFuture<>();
            Thread t = new Thread(() -> {
                try {
                    out.complete(client.warmup(tmp.resolve("w.docx"), ParseOptions.defaults()));
                } catch (RuntimeException e) {
                    out.complete(e);
                }
                stillInterrupted.complete(Thread.currentThread().isInterrupted());
            }, "test-warmup");
            t.start();
            assertNotNull(awaitThread("test-warmup", Thread.State.WAITING, "WorkerProcess.exchange", 5000), "워밍업 요청을 보내지 않았다");
            t.interrupt();
            Object r = out.get(10, TimeUnit.SECONDS);
            assertInstanceOf(KordocException.class, r, "interrupt 된 warmup 결과: " + r);
            assertTrue(stillInterrupted.get(10, TimeUnit.SECONDS), "interrupt 상태를 지웠다");
            assertNull(field(client, "warmupSpec"), "중단된 워밍업의 문서를 교체 워커용으로 등록했다");
            assertTrue(client.parse(tmp.resolve("a.docx")).success());
        }
    }

    @Test
    void killOnAnInterruptedThreadStillReapsTheWorker() throws Exception {
        // 종전: interrupt 된 스레드(중단된 warmup)의 kill 은 회수를 기다리지 않고 돌아와, alive() 가 참인 죽어 가는 워커에
        // 다음 요청이 써서 KordocWorkerCrashedException("워커에 요청을 쓰지 못했습니다") 으로 끝났다
        try (KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).build())) {
            WorkerProcess w = worker(client, 0);
            Thread.currentThread().interrupt();
            boolean alive;
            try {
                w.kill();
                alive = w.alive();
            } finally {
                assertTrue(Thread.interrupted(), "kill 이 interrupt 상태를 지웠다");
            }
            assertFalse(alive, "kill 이 돌아왔는데 워커가 살아 있다");
            assertTrue(client.parse(tmp.resolve("a.docx")).success());
        }
    }

    @Test
    void killBeforeStartLeavesNoProcess() {
        // 종전: 띄우는 중인 워커(slot.starting)를 close 가 프로세스가 생기기 전에 kill 하면 아무것도 하지 않아, 그 뒤 start 가 워커를 띄웠다.
        // 설치 직전 closed 재확인 하나에만 기대던 창이다 — 그 확인을 지나치면 닫힌 클라이언트의 워커가 남는다
        WorkerProcess w = new WorkerProcess(Support.fault("ok", Map.of()).build());
        w.kill();
        assertThrows(KordocStartException.class, w::start, "kill 한 워커가 시작됐다");
        long pid = w.pid();
        assertFalse(w.alive(), "kill 한 뒤 시작한 워커가 살아 있다");
        if (pid > 0) assertFalse(Support.alive(pid), "kill 한 뒤 시작한 워커가 살아 있다 (pid " + pid + ")");
    }

    @Test
    void workerStartedAcrossCloseIsNotInstalled() throws Exception {
        // close 가 자리의 worker 를 읽은 뒤 starting 을 읽기 전에 spawn 이 설치를 마치면 close 는 그 워커를 보지 못한다 — 설치 직전에 closed 를 다시 본다.
        // 클라이언트 잠금을 선점해 spawn 을 설치 앞에 세우고, 그 사이에 closed 만 세운다
        Path readyState = tmp.resolve("ready-state");
        KordocConfig cfg = Support.fault("ok", Map.of("KORDOC_FAULT_READY_DELAY_MS", "500", "KORDOC_FAULT_READY_STATE", readyState.toString())).build();
        KordocClient client = KordocClient.start(cfg); // 처음 워커는 바로, 교체 워커는 500ms 늦게 ready
        worker(client, 0).kill();
        Object lock = field(client, "lock");
        Field closed = KordocClient.class.getDeclaredField("closed");
        closed.setAccessible(true);
        CompletableFuture<Object> warm = onThread("test-warmup", () -> client.warmup(tmp.resolve("w.docx"), ParseOptions.defaults()));
        assertNotNull(awaitThread("test-warmup", Thread.State.TIMED_WAITING, "WorkerProcess.handshake", 5000), "warmup 이 새 워커를 띄우지 않았다");
        synchronized (lock) {
            assertNotNull(awaitThread("test-warmup", Thread.State.BLOCKED, "KordocClient.spawn", 5000), "spawn 이 설치 앞에 서지 않았다");
            closed.setBoolean(client, true);
        }
        Object r = warm.get(10, TimeUnit.SECONDS);
        WorkerProcess installed = worker(client, 0);
        boolean leaked = installed != null && installed.alive();
        synchronized (lock) {
            closed.setBoolean(client, false); // 정리는 진짜 close 로
        }
        client.close();
        assertInstanceOf(KordocClosedException.class, r, "warmup 결과: " + r);
        assertFalse(leaked, "닫기 시작한 뒤 handshake 를 마친 워커를 자리에 설치했다");
    }

    @Test
    void warmupRacingCloseLeavesNoWorker() throws Exception {
        // 종전: close 와 겹친 warmup 이 닫힌 클라이언트에 새 워커를 띄우고 RejectedExecutionException 을 던졌다(워커는 JVM 이 끝날 때까지 남음)
        Set<Long> before = children();
        for (int i = 0; i < 2; i++) {
            KordocConfig cfg = Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "800")).maxWorkers(2).closeTimeout(Duration.ofMillis(200)).build();
            KordocClient client = KordocClient.start(cfg);
            CompletableFuture<Object> w = onThread("test-warmup", () -> client.warmup(tmp.resolve("w.docx"), ParseOptions.defaults()));
            Thread.sleep(100);
            client.close();
            Object r = w.get(20, TimeUnit.SECONDS);
            assertTrue(r instanceof WarmupReport || r instanceof KordocClosedException, "warmup 결과: " + r);
            Set<Long> left = new HashSet<>();
            for (int t = 0; t < 100; t++) {
                left = children();
                left.removeAll(before);
                if (left.isEmpty()) break;
                Thread.sleep(50);
            }
            assertEquals(Set.of(), left, "닫힌 클라이언트의 워커가 남았다 (" + i + "회째)");
        }
    }

    @Test
    void closeKillsAWorkerStillStarting() throws Exception {
        // handshake 중인 워커는 아직 자리에 없다 — close 가 그 워커를 직접 죽여야 돌아올 때 프로세스가 남지 않는다
        Path readyState = tmp.resolve("ready-state");
        KordocConfig cfg = Support.fault("ok", Map.of("KORDOC_FAULT_READY_DELAY_MS", "3000", "KORDOC_FAULT_READY_STATE", readyState.toString()))
                .closeTimeout(Duration.ofMillis(300)).build();
        Set<Long> before = children();
        KordocClient client = KordocClient.start(cfg); // 처음 워커는 바로, 교체 워커는 3초 늦게 ready
        worker(client, 0).kill();
        CompletableFuture<Object> warm = onThread("test-warmup", () -> client.warmup(tmp.resolve("w.docx"), ParseOptions.defaults()));
        assertNotNull(awaitThread("test-warmup", Thread.State.TIMED_WAITING, "WorkerProcess.handshake", 5000), "warmup 이 새 워커를 띄우지 않았다");
        client.close();
        Set<Long> left = children();
        left.removeAll(before);
        assertEquals(Set.of(), left, "close 가 띄우는 중인 워커를 남기고 돌아왔다");
        Object r = warm.get(10, TimeUnit.SECONDS);
        assertInstanceOf(KordocClosedException.class, r, "warmup 결과: " + r);
    }

    // ─── 콜백 스레드 ────────────────────────────────────

    @Test
    void completionCallbacksDoNotHoldTheSlot() throws Exception {
        // 종전: parseAsync 완료 콜백이 자리 잠금을 쥔 디스패처 스레드에서 돌아, 콜백 안의 동기 parse 가 그 자리를 기다리며 영원히 멈췄고
        // 느린 콜백만으로도 다음 요청이 그만큼 늦었다
        try (KordocClient client = KordocClient.start(Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "200")).closeTimeout(Duration.ofSeconds(1)).build())) {
            CompletableFuture<String> nested = client.parseAsync(tmp.resolve("a.docx")).thenApply(r -> client.parse(tmp.resolve("b.docx")).markdown());
            assertEquals("ok:" + tmp.resolve("b.docx").toAbsolutePath(), nested.get(5, TimeUnit.SECONDS));

            CountDownLatch inCallback = new CountDownLatch(1);
            client.parseAsync(tmp.resolve("c.docx")).thenAccept(r -> {
                inCallback.countDown();
                sleep(2000);
            });
            assertTrue(inCallback.await(5, TimeUnit.SECONDS));
            long t = System.nanoTime();
            assertTrue(client.parse(tmp.resolve("d.docx")).success());
            long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t);
            assertTrue(ms < 1500, "느린 완료 콜백이 다음 요청을 " + ms + "ms 붙잡았다");
        }
    }

    @Test
    void timeoutCallbacksDoNotDelayOtherTimeouts() throws Exception {
        // 종전: 제한 시간 완료가 하나뿐인 타이머 스레드에서 사용자 콜백을 돌려, 느린 콜백이 다른 요청의 제한 시간을 늦췄고
        // 콜백 안에서 동기로 다시 parse 하면 그 요청의 제한 시간도 걸리지 않아 멈췄다
        ParseOptions t300 = ParseOptions.builder().timeout(Duration.ofMillis(300)).build();
        try (KordocClient client = KordocClient.start(Support.fault("hang", Map.of()).maxWorkers(2).closeTimeout(Duration.ofSeconds(1)).build())) {
            CountDownLatch inCallback = new CountDownLatch(1);
            client.parseAsync(tmp.resolve("a.docx"), t300).exceptionally(e -> {
                inCallback.countDown();
                sleep(3000);
                return null;
            });
            assertTrue(inCallback.await(5, TimeUnit.SECONDS));
            long t = System.nanoTime();
            ExecutionException e = assertThrows(ExecutionException.class, () -> client.parseAsync(tmp.resolve("d.docx"), t300).get(10, TimeUnit.SECONDS));
            long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t);
            assertInstanceOf(KordocTimeoutException.class, e.getCause());
            assertTrue(ms < 1500, "300ms 제한 시간이 " + ms + "ms 뒤에야 걸렸다");
        }
        try (KordocClient client = KordocClient.start(Support.fault("hang", Map.of()).closeTimeout(Duration.ofSeconds(1)).build())) {
            CompletableFuture<Object> retry = client.parseAsync(tmp.resolve("a.docx"), t300).<Object>thenApply(r -> r)
                    .exceptionally(e -> client.parse(tmp.resolve("b.docx"), t300));
            assertEquals("done", retry.handle((r, e) -> "done").get(5, TimeUnit.SECONDS), "제한 시간 콜백 안의 parse 가 멈췄다");
        }
    }

    @Test
    void retryInsideAFailureCallbackDoesNotWaitForTheAbandonedWorker() throws Exception {
        // 실패 콜백은 SDK 정리(대기 큐 제거·워커 종료)보다 나중에 돈다 — 콜백 안에서 제한 시간 없이 다시 parse 해도 멈춘 워커를 기다리지 않는다.
        // 취소 콜백은 cancel 을 부른 스레드에서, 제한 시간 콜백은 SDK 완료 스레드에서 돈다
        try (KordocClient client = KordocClient.start(Support.fault("by-file", Map.of()).closeTimeout(Duration.ofMillis(500)).build())) {
            for (String how : List.of("cancel", "timeout")) {
                ParseOptions options = how.equals("cancel") ? ParseOptions.defaults() : ParseOptions.builder().timeout(Duration.ofMillis(300)).build();
                CompletableFuture<ParseResult> hung = client.parseAsync(tmp.resolve("hang.docx"), options);
                CompletableFuture<String> retry = hung.thenApply(ParseResult::markdown).exceptionally(e -> client.parse(tmp.resolve("b.docx")).markdown());
                if (how.equals("cancel")) {
                    assertNotNull(awaitThread("kordoc-sdk-dispatch-0", Thread.State.WAITING, "WorkerProcess.exchange", 5000), "요청이 워커에 가지 않았다");
                    onThread("test-cancel", () -> hung.cancel(true));
                }
                assertEquals("ok:" + tmp.resolve("b.docx").toAbsolutePath(), retry.get(5, TimeUnit.SECONDS), how + " 콜백 안의 parse");
            }
        }
    }

    // ─── close 경합 ─────────────────────────────────────

    @Test
    void parseAsyncRacingCloseFailsWithClosed() throws Exception {
        // 종전: 큐에 넣고 잠금을 푼 뒤 제한 시간 타이머를 걸어, 그 사이 close 가 타이머를 내리면 RejectedExecutionException 이 호출자에게 샜다.
        // 타이머를 첫 schedule 에서 멈추는 것으로 바꿔 그 사이에 close 를 돌린다
        KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).requestTimeout(Duration.ofSeconds(30)).build());
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ScheduledThreadPoolExecutor gate = new ScheduledThreadPoolExecutor(1) {
            private void hold() {
                entered.countDown();
                try {
                    release.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }

            @Override
            public ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
                hold();
                return super.schedule(command, delay, unit);
            }

            @Override
            public <V> ScheduledFuture<V> schedule(Callable<V> command, long delay, TimeUnit unit) {
                hold(); // Callable 로 걸어도 멈추게
                return super.schedule(command, delay, unit);
            }
        };
        Field timer = KordocClient.class.getDeclaredField("timer");
        timer.setAccessible(true);
        ((ScheduledThreadPoolExecutor) timer.get(client)).shutdownNow();
        timer.set(client, gate);
        CompletableFuture<Object> call = onThread("test-parse", () -> client.parseAsync(tmp.resolve("a.docx")));
        assertTrue(entered.await(5, TimeUnit.SECONDS), () -> "타이머를 걸지 않았다: " + call.getNow(null));
        Thread closer = new Thread(client::close, "test-close");
        closer.start();
        awaitDoneOr(closer, Thread.State.BLOCKED, "KordocClient.close", 3000); // 타이머를 잠금 밖에서 걸면 close 가 끝까지 돈다
        release.countDown();
        closer.join(10_000);
        Object r = call.get(10, TimeUnit.SECONDS);
        CompletableFuture<?> f = assertInstanceOf(CompletableFuture.class, r, "parseAsync 가 던졌다: " + r);
        try {
            f.get(5, TimeUnit.SECONDS); // 닫히기 전에 처리됐으면 성공
        } catch (ExecutionException e) {
            assertInstanceOf(KordocClosedException.class, e.getCause());
        }
    }

    @Test
    void closeInsideACompletionCallbackDoesNotWaitForItself() throws Exception {
        // 종전: 완료 콜백 안에서 부른 첫 close 가 자기 자신이 돌고 있는 완료 스레드의 종료를 closeTimeout 내내 기다렸고,
        // 그 사이 다른 스레드의 close 도 같이 막혔다. 다른 완료 콜백은 여전히 끝날 때까지 기다려야 한다
        KordocConfig cfg = Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "200")).maxWorkers(2).closeTimeout(Duration.ofSeconds(4)).build();
        KordocClient client = KordocClient.start(cfg);
        CountDownLatch otherStarted = new CountDownLatch(1);
        CountDownLatch otherDone = new CountDownLatch(1);
        client.parseAsync(tmp.resolve("a.docx")).thenRun(() -> {
            otherStarted.countDown();
            sleep(800);
            otherDone.countDown();
        });
        CountDownLatch closing = new CountDownLatch(1);
        CompletableFuture<long[]> inCallback = client.parseAsync(tmp.resolve("b.docx")).thenApply(r -> {
            try {
                otherStarted.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            closing.countDown();
            long t = System.nanoTime();
            client.close();
            return new long[] {TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t), otherDone.getCount()};
        });
        assertTrue(closing.await(5, TimeUnit.SECONDS), "완료 콜백이 돌지 않았다");
        long t = System.nanoTime();
        client.close(); // 콜백 안의 첫 close 를 기다린다
        long second = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t);
        long[] first = inCallback.get(10, TimeUnit.SECONDS);
        assertTrue(first[0] < 2500, "콜백 안의 close 가 " + first[0] + "ms 걸렸다(closeTimeout 4s)");
        assertEquals(0, first[1], "콜백 안의 close 가 다른 완료 콜백이 끝나기 전에 돌아왔다");
        assertTrue(second < 2500, "다른 스레드의 두 번째 close 가 " + second + "ms 걸렸다");
        assertThrows(KordocClosedException.class, () -> client.parse(tmp.resolve("c.docx")));
    }

    @Test
    void secondCloseWaitsForTheFirst() throws Exception {
        // 종전: 두 번째 close() 가 정리를 기다리지 않고 바로 돌아와, 돌아온 뒤에도 진행 요청과 워커가 남아 있었다
        KordocClient client = KordocClient.start(Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "1500")).closeTimeout(Duration.ofSeconds(5)).build());
        long pid = client.workerPids().get(0);
        CompletableFuture<ParseResult> running = client.parseAsync(tmp.resolve("a.docx"));
        Thread.sleep(200);
        Thread first = new Thread(client::close, "test-close-1");
        first.start();
        assertNotNull(awaitThread("test-close-1", Thread.State.TIMED_WAITING, "KordocClient.close", 5000), "첫 close 가 진행 요청을 기다리지 않는다");
        client.close();
        assertTrue(running.isDone(), "두 번째 close 가 진행 요청이 끝나기 전에 돌아왔다");
        assertFalse(Support.alive(pid), "두 번째 close 가 워커를 회수하기 전에 돌아왔다");
        first.join(10_000);
        assertTrue(running.get().success());
    }

    /** t 가 close 정리(shutdown)에서 직접 JDK 대기 jdkFrame 에 서 있는가 — 워커 quit 의 Process.waitFor 도 안에서 Object.wait 을 쓴다 */
    private static boolean inCloseWait(Thread t, String jdkFrame) {
        if (t.getState() != Thread.State.TIMED_WAITING) return false;
        StackTraceElement[] st = t.getStackTrace();
        for (int i = 0; i < st.length; i++) {
            if (!(st[i].getClassName() + "." + st[i].getMethodName()).equals(jdkFrame)) continue;
            for (int k = i + 1; k < st.length; k++) {
                if (st[k].getClassName().startsWith("java.")) continue;
                return st[k].getClassName().equals(KordocClient.class.getName()) && st[k].getMethodName().equals("shutdown");
            }
        }
        return false;
    }

    private static void awaitCloseWait(Thread t, String jdkFrame) throws InterruptedException {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!inCloseWait(t, jdkFrame) && t.isAlive() && System.nanoTime() < end) Thread.sleep(1);
        assertTrue(inCloseWait(t, jdkFrame), "close 가 " + jdkFrame + " 에서 기다리지 않는다");
    }

    @Test
    void interruptedCloseStillWaitsForInFlightRequests() throws Exception {
        // 종전: interrupt 상태에서 부르거나 기다리는 중 interrupt 된 close 가 진행 요청의 워커를 closeTimeout 유예 없이 죽이고,
        // 그 Future·완료 콜백이 끝나기 전에 돌아왔다
        KordocConfig cfg = Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "1000")).closeTimeout(Duration.ofSeconds(5)).build();
        for (String when : List.of("부르기 전 interrupt", "자리 잠금 대기 중 interrupt", "완료 콜백 대기 중 interrupt")) {
            KordocClient client = KordocClient.start(cfg);
            long pid = client.workerPids().get(0);
            CountDownLatch callbackDone = new CountDownLatch(1);
            CompletableFuture<ParseResult> running = client.parseAsync(tmp.resolve("a.docx"));
            running.whenComplete((r, e) -> {
                sleep(800);
                callbackDone.countDown();
            });
            CompletableFuture<ParseResult> queued = client.parseAsync(tmp.resolve("b.docx"));
            assertNotNull(awaitThread("kordoc-sdk-dispatch-0", Thread.State.WAITING, "WorkerProcess.exchange", 5000), "진행 요청이 워커에 가지 않았다");
            CompletableFuture<boolean[]> atReturn = new CompletableFuture<>();
            Thread closer = new Thread(() -> {
                if (when.startsWith("부르기 전")) Thread.currentThread().interrupt();
                client.close();
                atReturn.complete(new boolean[] {Thread.currentThread().isInterrupted(), running.isDone(), queued.isDone(),
                        callbackDone.getCount() == 0, Support.alive(pid)});
            }, "test-close");
            closer.start();
            if (when.startsWith("자리 잠금")) {
                assertNotNull(awaitThread("test-close", Thread.State.TIMED_WAITING, "ReentrantLock.tryLock", 5000), when + ": close 가 진행 요청을 기다리지 않는다");
                closer.interrupt();
            } else if (when.startsWith("완료 콜백")) {
                awaitCloseWait(closer, "java.lang.Object.wait");
                closer.interrupt();
            }
            boolean[] s = atReturn.get(15, TimeUnit.SECONDS);
            assertTrue(s[0], when + ": close 가 interrupt 상태를 지웠다");
            assertTrue(s[1] && s[2], when + ": close 가 요청 Future 가 끝나기 전에 돌아왔다");
            assertTrue(s[3], when + ": close 가 완료 콜백이 끝나기 전에 돌아왔다");
            assertFalse(s[4], when + ": close 가 워커를 회수하기 전에 돌아왔다");
            assertTrue(running.get().success(), when + ": 진행 요청을 closeTimeout 안에 기다리지 않고 끝냈다");
            ExecutionException e = assertThrows(ExecutionException.class, queued::get);
            assertInstanceOf(KordocClosedException.class, e.getCause());
        }
    }

    @Test
    void interruptedCloseStillWaitsForADispatcherFinishingItsRequest() throws Exception {
        // 종전: 디스패처 종료를 기다리던 close 가 interrupt 되면 바로 넘어가, 진행 요청의 Future 가 끝나기 전에 돌아왔다.
        // 작업 잠금을 선점해 응답을 받은 디스패처를 마무리 앞에 세우고, close 가 디스패처를 기다릴 때 interrupt 한다
        KordocConfig cfg = Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "300")).closeTimeout(Duration.ofMillis(1000)).build();
        KordocClient client = KordocClient.start(cfg);
        CompletableFuture<ParseResult> running = client.parseAsync(tmp.resolve("a.docx"));
        assertNotNull(awaitThread("kordoc-sdk-dispatch-0", Thread.State.WAITING, "WorkerProcess.exchange", 5000), "진행 요청이 워커에 가지 않았다");
        Object job = field(worker(client, 0), "current");
        assertNotNull(job);
        CompletableFuture<boolean[]> atReturn = new CompletableFuture<>();
        Thread closer = new Thread(() -> {
            client.close();
            atReturn.complete(new boolean[] {Thread.currentThread().isInterrupted(), running.isDone()});
        }, "test-close");
        synchronized (job) {
            assertNotNull(awaitThread("kordoc-sdk-dispatch-0", Thread.State.BLOCKED, "KordocClient.run", 5000), "디스패처가 작업 잠금 앞에 서지 않았다");
            closer.start();
            awaitCloseWait(closer, "java.lang.Thread.join");
            closer.interrupt();
            Thread.sleep(200);
        }
        boolean[] s = atReturn.get(15, TimeUnit.SECONDS);
        assertTrue(s[0], "close 가 interrupt 상태를 지웠다");
        assertTrue(s[1], "close 가 디스패처를 기다리지 않아 진행 요청 Future 가 끝나기 전에 돌아왔다");
        assertTrue(running.get().success());
    }

    @Test
    void interruptedCloseStillWaitsForAnIdleWorkerToQuit() throws Exception {
        // 종전: quit 를 보내고 워커가 끝나기를 기다리던 close 가 interrupt 되면 closeTimeout 유예 없이 그 워커를 죽였다
        KordocClient client = KordocClient.start(Support.fault("no-quit", Map.of()).closeTimeout(Duration.ofSeconds(2)).build());
        long pid = client.workerPids().get(0);
        CompletableFuture<long[]> atReturn = new CompletableFuture<>();
        Thread closer = new Thread(() -> {
            long t = System.nanoTime();
            client.close();
            atReturn.complete(new long[] {TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t), Thread.currentThread().isInterrupted() ? 1 : 0});
        }, "test-close");
        closer.start();
        assertNotNull(awaitThread("test-close", Thread.State.TIMED_WAITING, "WorkerProcess.quit", 5000), "close 가 워커 종료를 기다리지 않는다");
        closer.interrupt();
        long[] s = atReturn.get(15, TimeUnit.SECONDS);
        assertTrue(s[0] >= 1500, "quit 대기 중 interrupt 된 close 가 " + s[0] + "ms 만에 워커를 죽였다(closeTimeout 2s)");
        assertEquals(1, s[1], "close 가 interrupt 상태를 지웠다");
        assertFalse(Support.alive(pid), "close 가 워커를 회수하기 전에 돌아왔다");
    }

    @Test
    void interruptedSecondCloseStillWaitsForTheFirst() throws Exception {
        // 종전: interrupt 상태에서 부르거나 기다리는 중 interrupt 된 두 번째 close 가 첫 close 의 정리를 기다리지 않고 바로 돌아왔다
        for (boolean interruptFirst : new boolean[] {true, false}) {
            String when = interruptFirst ? "부르기 전 interrupt" : "기다리는 중 interrupt";
            KordocClient client = KordocClient.start(Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "1500")).closeTimeout(Duration.ofSeconds(5)).build());
            long pid = client.workerPids().get(0);
            CompletableFuture<ParseResult> running = client.parseAsync(tmp.resolve("a.docx"));
            assertNotNull(awaitThread("kordoc-sdk-dispatch-0", Thread.State.WAITING, "WorkerProcess.exchange", 5000), "진행 요청이 워커에 가지 않았다");
            Thread first = new Thread(client::close, "test-close-1");
            first.start();
            assertNotNull(awaitThread("test-close-1", Thread.State.TIMED_WAITING, "KordocClient.shutdown", 5000), "첫 close 가 진행 요청을 기다리지 않는다");
            CompletableFuture<boolean[]> atReturn = new CompletableFuture<>();
            Thread second = new Thread(() -> {
                if (interruptFirst) Thread.currentThread().interrupt();
                client.close();
                atReturn.complete(new boolean[] {Thread.currentThread().isInterrupted(), running.isDone(), Support.alive(pid)});
            }, "test-close-2");
            second.start();
            if (!interruptFirst) {
                assertNotNull(awaitThread("test-close-2", Thread.State.WAITING, "KordocClient.close", 5000), "두 번째 close 가 첫 close 를 기다리지 않는다");
                second.interrupt();
            }
            boolean[] s = atReturn.get(15, TimeUnit.SECONDS);
            assertTrue(s[0], when + ": 두 번째 close 가 interrupt 상태를 지웠다");
            assertTrue(s[1], when + ": 두 번째 close 가 진행 요청이 끝나기 전에 돌아왔다");
            assertFalse(s[2], when + ": 두 번째 close 가 워커를 회수하기 전에 돌아왔다");
            first.join(10_000);
            assertTrue(running.get().success());
        }
    }

    @Test
    void closeInsideACallbackOfTheFirstCloseReturnsAtOnce() throws Exception {
        // 첫 close 가 끝낸 대기 Future 의 완료 콜백에서 다시 부른 close 는 기다리지 않는다 — 기다리면 서로 closeTimeout 까지 멈춘다
        KordocClient client = KordocClient.start(Support.fault("slow", Map.of("KORDOC_FAULT_DELAY_MS", "1000")).closeTimeout(Duration.ofSeconds(3)).build());
        CompletableFuture<ParseResult> running = client.parseAsync(tmp.resolve("a.docx"));
        CompletableFuture<Long> inCallback = new CompletableFuture<>();
        client.parseAsync(tmp.resolve("b.docx")).whenComplete((r, e) -> {
            long t = System.nanoTime();
            client.close();
            inCallback.complete(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t));
        });
        assertNotNull(awaitThread("kordoc-sdk-dispatch-0", Thread.State.WAITING, "WorkerProcess.exchange", 5000), "진행 요청이 워커에 가지 않았다");
        long t = System.nanoTime();
        client.close();
        long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t);
        assertTrue(inCallback.isDone(), "첫 close 가 완료 콜백이 끝나기 전에 돌아왔다");
        assertTrue(inCallback.get() < 500, "콜백 안의 close 가 " + inCallback.get() + "ms 기다렸다");
        assertTrue(running.get().success(), "첫 close 가 진행 요청을 기다리지 않았다");
        assertTrue(ms < 2500, "첫 close 가 " + ms + "ms 걸렸다(closeTimeout 3s)");
    }
}
