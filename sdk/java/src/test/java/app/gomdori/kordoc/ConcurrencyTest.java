package app.gomdori.kordoc;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** 공개 클라이언트 경계에서 실제 자식 프로세스의 소유권과 병렬 실행을 확인한다. */
class ConcurrencyTest {
    @TempDir
    Path tmp;

    @Test
    void rssReplacementReapsPreviousWorkerBeforeNextResponse() throws Exception {
        Path wrapper = tmp.resolve("lifetime-worker.mjs");
        Path previous = tmp.resolve("previous-pid");
        Path witness = tmp.resolve("startup-witness.json");
        Files.writeString(wrapper, """
                import {existsSync, readFileSync, writeFileSync} from 'node:fs';
                import {pathToFileURL} from 'node:url';
                if (existsSync(process.env.PREVIOUS_PID)) {
                  const previous = Number(readFileSync(process.env.PREVIOUS_PID, 'utf8'));
                  let alive = false;
                  try { process.kill(previous, 0); alive = true; }
                  catch (e) { if (e.code !== 'ESRCH') throw e; }
                  writeFileSync(process.env.STARTUP_WITNESS,
                    JSON.stringify({previous, replacement:process.pid, alive}));
                }
                writeFileSync(process.env.PREVIOUS_PID, String(process.pid));
                await import(pathToFileURL(process.env.FAULT_WORKER).href);
                """);
        try (KordocClient client = KordocClient.start(KordocConfig.builder().node(Support.node()).cli(wrapper)
                .env("KORDOC_FAULT", "no-quit").env("FAULT_WORKER", Support.FAULT_WORKER.toString())
                .env("PREVIOUS_PID", previous.toString()).env("STARTUP_WITNESS", witness.toString())
                .maxWorkers(1).maxWorkerRssBytes(1L).closeTimeout(Duration.ofSeconds(3)).build())) {
            long first = client.parseAsync(tmp.resolve("first.docx")).get(2, TimeUnit.SECONDS)
                    .raw().path("pid").asLong();
            // 첫 성공은 종료 유예(3초)를 기다리지 않고 전달돼야 한다.
            assertTrue(Support.alive(first), "첫 결과를 전달하기 전에 종료 유예를 기다렸다");
            long second = client.parseAsync(tmp.resolve("second.docx")).get(10, TimeUnit.SECONDS)
                    .raw().path("pid").asLong();
            assertNotEquals(first, second);
            List<Long> owned = client.workerPids();
            assertEquals(owned.size(), new java.util.HashSet<>(owned).size());
            assertFalse(owned.contains(first), "회수한 PID가 관측에 누적됐다");
            assertTrue(owned.stream().allMatch(Support::alive));
            assertEquals(List.of(second), owned);
            var startup = Json.MAPPER.readTree(witness.toFile());
            assertEquals(first, startup.path("previous").asLong());
            assertEquals(second, startup.path("replacement").asLong());
            assertFalse(startup.path("alive").asBoolean(), "교체 프로세스 시작 시 이전 PID가 살아 있었다");
        }
    }

    @Test
    void retiringLiveWorkerRemainsObservableWithItsMeasuredRss() throws Exception {
        try (KordocClient client = KordocClient.start(Support.fault("no-quit", Map.of())
                .maxWorkerRssBytes(1L).closeTimeout(Duration.ofSeconds(3)).build())) {
            long pid = client.parse(tmp.resolve("first.docx")).raw().path("pid").asLong();
            assertTrue(Support.alive(pid));
            assertEquals(List.of(pid), client.workerPids(), "종료 대기 중인 소유 PID가 누락됐다");
            assertEquals(1, client.workerRss().size(), "살아 있는 종료 대기 워커의 마지막 RSS가 누락됐다");
            assertTrue(client.workerRss().get(0) > 0);
        }
    }

    @Test
    void startingWorkerIsObservableBeforeReadyWithoutInventedRss() throws Exception {
        Path state = tmp.resolve("ready-state");
        try (KordocClient client = KordocClient.start(Support.fault("ok", Map.of(
                "KORDOC_FAULT_READY_STATE", state.toString(), "KORDOC_FAULT_READY_DELAY_MS", "3000"))
                .maxWorkerRssBytes(1L).build())) {
            long first = client.parse(tmp.resolve("first.docx")).raw().path("pid").asLong();
            CompletableFuture<ParseResult> next = client.parseAsync(tmp.resolve("next.docx"));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            long starting = -1;
            while (System.nanoTime() < deadline && !next.isDone()) {
                List<ProcessHandle> children = ProcessHandle.current().children().filter(ProcessHandle::isAlive).toList();
                for (ProcessHandle child : children) {
                    if (child.pid() != first && child.info().arguments().map(a -> List.of(a).contains(Support.FAULT_WORKER.toString())).orElse(false)) {
                        starting = child.pid();
                    }
                }
                if (starting > 0 && Support.alive(starting)) break;
                Thread.sleep(10);
            }
            assertTrue(starting > 0 && Support.alive(starting), "ready 前 프로세스가 생기지 않았다");
            assertFalse(next.isDone(), "ready 前 관측 시점을 놓쳤다");
            assertTrue(client.workerPids().contains(starting), "기동 중인 소유 PID가 누락됐다");
            assertTrue(client.workerRss().isEmpty(), "측정 전 RSS 값을 만들어 냈다");
            assertTrue(next.get(10, TimeUnit.SECONDS).success());
        }
    }

    @Test
    void warmupSendsToBothWorkersBeforeEitherResponseIsReleased() throws Exception {
        Path worker = tmp.resolve("barrier-worker.mjs");
        Path arrivals = Files.createDirectory(tmp.resolve("arrivals"));
        Path release = tmp.resolve("release");
        Files.writeString(worker, """
                import {writeFileSync, existsSync} from 'node:fs';
                import {createInterface} from 'node:readline';
                const out = x => process.stdout.write(JSON.stringify(x) + '\\n');
                out({ready:true,protocol:2,version:'test',capabilities:['parse','options']});
                const rl = createInterface({input:process.stdin});
                rl.on('line', async line => {
                  const r = JSON.parse(line);
                  if (r.cmd === 'quit') process.exit(0);
                  writeFileSync(process.env.ARRIVALS + '/' + process.pid, String(r.id));
                  while (!existsSync(process.env.RELEASE)) await new Promise(r => setTimeout(r, 10));
                  out({id:r.id,rss:123,result:{success:true,markdown:'warm',blocks:[],pid:process.pid}});
                });
                rl.on('close', () => process.exit(0));
                """);
        try (KordocClient client = KordocClient.start(KordocConfig.builder().node(Support.node()).cli(worker)
                .maxWorkers(2).env("ARRIVALS", arrivals.toString()).env("RELEASE", release.toString()).build())) {
            CompletableFuture<WarmupReport> warming = CompletableFuture.supplyAsync(
                    () -> client.warmup(tmp.resolve("warm.docx"), ParseOptions.defaults()));
            try {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                long count;
                do {
                    try (var paths = Files.list(arrivals)) { count = paths.count(); }
                    if (count == 2) break;
                    Thread.sleep(10);
                } while (System.nanoTime() < deadline);
                assertEquals(2, count, "첫 응답 해제 전에 두 워커 모두 요청을 받지 못했다");
            } finally {
                Files.writeString(release, "go");
                warming.get(10, TimeUnit.SECONDS);
            }
        }
    }
    @Test
    void retirementSurvivesWaitingRequestTimeoutCancelAndClose() throws Exception {
        KordocClient client = KordocClient.start(Support.fault("no-quit", Map.of())
                .maxWorkerRssBytes(1L).closeTimeout(Duration.ofSeconds(2)).build());
        long pid;
        try {
            pid = client.parse(tmp.resolve("first.docx")).raw().path("pid").asLong();
            CompletableFuture<ParseResult> timed = client.parseAsync(tmp.resolve("timed.docx"),
                    ParseOptions.builder().timeout(Duration.ofMillis(100)).build());
            var failure = assertThrows(java.util.concurrent.ExecutionException.class,
                    () -> timed.get(1, TimeUnit.SECONDS));
            assertInstanceOf(KordocTimeoutException.class, failure.getCause());
            assertTrue(Support.alive(pid), "대기 요청 제한 시간이 소유 종료 작업을 중단했다");
            CompletableFuture<ParseResult> cancelled = client.parseAsync(tmp.resolve("cancel.docx"));
            assertTrue(cancelled.cancel(true));
            client.close();
            assertFalse(Support.alive(pid));
            assertTrue(client.workerPids().isEmpty());
            assertTrue(client.workerRss().isEmpty());
            assertTrue(Thread.getAllStackTraces().keySet().stream()
                    .noneMatch(t -> t.isAlive() && t.getName().equals("kordoc-sdk-retire")));
        } finally {
            client.close();
        }
    }

    private KordocConfig barrierConfig() throws Exception {
        Path worker = tmp.resolve("exclusive-worker.mjs");
        Files.createDirectories(tmp.resolve("received"));
        Files.writeString(worker, """
                import {existsSync, writeFileSync} from 'node:fs';
                import {createInterface} from 'node:readline';
                const out = x => process.stdout.write(JSON.stringify(x) + '\\n');
                let busy = false;
                out({ready:true,protocol:2,version:'test',capabilities:['parse','options']});
                const rl = createInterface({input:process.stdin});
                rl.on('line', async line => {
                  const r = JSON.parse(line);
                  if (r.cmd === 'quit') process.exit(0);
                  if (busy) writeFileSync(process.env.ROOT + '/overlap', 'overlap');
                  busy = true;
                  writeFileSync(process.env.ROOT + '/received/' + process.pid + '-' + r.id, r.file);
                  if (r.file.includes('hold')) {
                    while (!existsSync(process.env.ROOT + '/release')) await new Promise(r => setTimeout(r, 10));
                  }
                  busy = false;
                  out({id:r.id,rss:123,result:{success:true,markdown:r.file,blocks:[],pid:process.pid}});
                });
                rl.on('close', () => process.exit(0));
                """);
        return KordocConfig.builder().node(Support.node()).cli(worker).maxWorkers(2)
                .env("ROOT", tmp.toString()).closeTimeout(Duration.ofMillis(200)).build();
    }

    private void awaitArrivals(int count) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        long actual;
        do {
            try (var paths = Files.list(tmp.resolve("received"))) { actual = paths.count(); }
            if (actual >= count) return;
            Thread.sleep(10);
        } while (System.nanoTime() < deadline);
        fail("요청 장벽에 도착하지 않았다: " + actual + "/" + count);
    }

    @Test
    void overlappingWarmupsAndParseKeepSlotOrderAndWorkerExclusivity() throws Exception {
        try (KordocClient client = KordocClient.start(barrierConfig())) {
            List<Long> slotPids = slotPids(client);
            WarmupReport initial = client.warmup(tmp.resolve("initial.docx"), ParseOptions.defaults());
            assertEquals(slotPids, initial.workers().stream().map(WarmupReport.Worker::pid).toList());
            var first = CompletableFuture.supplyAsync(() -> client.warmup(tmp.resolve("hold.docx"), ParseOptions.defaults()));
            CompletableFuture<WarmupReport> second = null;
            CompletableFuture<ParseResult> parse = null;
            try {
                awaitArrivals(4);
                second = CompletableFuture.supplyAsync(() -> client.warmup(tmp.resolve("second.docx"), ParseOptions.defaults()));
                parse = client.parseAsync(tmp.resolve("parse.docx"));
            } finally {
                Files.writeString(tmp.resolve("release"), "go");
                var report = first.get(10, TimeUnit.SECONDS);
                assertEquals(slotPids,
                        report.workers().stream().map(WarmupReport.Worker::pid).toList());
                if (second != null) assertEquals(slotPids,
                        second.get(10, TimeUnit.SECONDS).workers().stream().map(WarmupReport.Worker::pid).toList());
                if (parse != null) assertTrue(parse.get(10, TimeUnit.SECONDS).success());
            }
            assertFalse(Files.exists(tmp.resolve("overlap")), "같은 워커에 요청이 겹쳤다");
        }
    }

    @Test
    void interruptedParallelWarmupJoinsActualChildrenAndReapsWorkers() throws Exception {
        try (KordocClient client = KordocClient.start(barrierConfig())) {
            List<Long> pids = client.workerPids();
            CompletableFuture<Throwable> outcome = new CompletableFuture<>();
            Thread caller = new Thread(() -> {
                try {
                    client.warmup(tmp.resolve("hold.docx"), ParseOptions.defaults());
                    outcome.complete(null);
                } catch (Throwable e) {
                    outcome.complete(e);
                }
            }, "test-parallel-warmup");
            caller.start();
            try {
                awaitArrivals(2);
                List<Thread> children = Thread.getAllStackTraces().keySet().stream()
                        .filter(t -> t.isAlive() && t.getName().startsWith("kordoc-sdk-warmup-")).toList();
                assertEquals(2, children.size());
                caller.interrupt();
                caller.join(10_000);
                assertFalse(caller.isAlive());
                assertInstanceOf(KordocException.class, outcome.get(1, TimeUnit.SECONDS));
                assertTrue(caller.isInterrupted());
                assertTrue(children.stream().noneMatch(Thread::isAlive), "Future 완료가 아닌 실제 형제 스레드 종료가 필요하다");
                assertTrue(pids.stream().noneMatch(Support::alive));
            } finally {
                Files.writeString(tmp.resolve("release"), "go");
                caller.interrupt();
                caller.join(10_000);
            }
        }
    }

    @Test
    void closeRacingParallelWarmupLeavesNoWorkerOrChild() throws Exception {
        KordocClient client = KordocClient.start(barrierConfig());
        List<Long> pids = client.workerPids();
        CompletableFuture<Object> result = CompletableFuture.supplyAsync(() -> {
            try { return client.warmup(tmp.resolve("hold.docx"), ParseOptions.defaults()); }
            catch (KordocException e) { return e; }
        });
        try {
            awaitArrivals(2);
            List<Thread> children = Thread.getAllStackTraces().keySet().stream()
                    .filter(t -> t.isAlive() && t.getName().startsWith("kordoc-sdk-warmup-")).toList();
            client.close();
            Object report = result.get(10, TimeUnit.SECONDS);
            assertTrue(report instanceof WarmupReport || report instanceof KordocClosedException);
            assertTrue(children.stream().noneMatch(Thread::isAlive));
            assertTrue(pids.stream().noneMatch(Support::alive));
            assertTrue(client.workerPids().isEmpty());
        } finally {
            Files.writeString(tmp.resolve("release"), "go");
            client.close();
            result.get(10, TimeUnit.SECONDS);
        }
    }

    private static List<Long> slotPids(KordocClient client) throws Exception {
        var slotsField = KordocClient.class.getDeclaredField("slots");
        slotsField.setAccessible(true);
        Object[] slots = (Object[]) slotsField.get(client);
        List<Long> pids = new java.util.ArrayList<>();
        for (Object slot : slots) {
            var workerField = slot.getClass().getDeclaredField("worker");
            workerField.setAccessible(true);
            pids.add(((WorkerProcess) workerField.get(slot)).pid());
        }
        return List.copyOf(pids);
    }

    @Test
    void failedStartupSignalsBlockedSiblingAndJoinsChildrenBeforeThrowing() throws Exception {
        Path worker = tmp.resolve("failed-start-worker.mjs");
        Files.writeString(worker, """
                import {existsSync, writeFileSync} from 'node:fs';
                import {createInterface} from 'node:readline';
                const root = process.env.ROOT;
                const out = x => process.stdout.write(JSON.stringify(x) + '\\n');
                if (existsSync(root + '/replace')) {
                  writeFileSync(root + '/replacement-pid', String(process.pid));
                  while (!existsSync(root + '/sibling-arrived') || !existsSync(root + '/fail-now'))
                    await new Promise(r => setTimeout(r, 10));
                  out({ready:true,protocol:1,capabilities:['parse','options']});
                } else {
                  out({ready:true,protocol:2,capabilities:['parse','options']});
                }
                const rl = createInterface({input:process.stdin});
                rl.on('line', line => {
                  const r = JSON.parse(line);
                  if (r.cmd === 'quit') process.exit(0);
                  writeFileSync(root + '/sibling-arrived', String(process.pid));
                });
                rl.on('close', () => process.exit(0));
                """);
        try (KordocClient client = KordocClient.start(KordocConfig.builder().node(Support.node()).cli(worker)
                .maxWorkers(2).env("ROOT", tmp.toString()).build())) {
            List<Long> pids = slotPids(client);
            ProcessHandle old = ProcessHandle.of(pids.get(0)).orElseThrow();
            old.destroyForcibly();
            old.onExit().get(5, TimeUnit.SECONDS);
            Files.writeString(tmp.resolve("replace"), "go");
            var children = new java.util.concurrent.atomic.AtomicReference<List<Thread>>(List.of());
            var failedPid = new java.util.concurrent.atomic.AtomicLong(-1);
            var settledAtThrow = new java.util.concurrent.atomic.AtomicBoolean();
            CompletableFuture<Throwable> outcome = new CompletableFuture<>();
            Thread caller = new Thread(() -> {
                try {
                    client.warmup(tmp.resolve("blocked.docx"), ParseOptions.defaults());
                    outcome.complete(null);
                } catch (Throwable e) {
                    settledAtThrow.set(children.get().size() == 2 && children.get().stream().noneMatch(Thread::isAlive)
                            && !Support.alive(failedPid.get()) && pids.stream().noneMatch(Support::alive));
                    outcome.complete(e);
                }
            }, "test-failed-start-warmup");
            caller.start();
            try {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                while ((!Files.exists(tmp.resolve("replacement-pid")) || !Files.exists(tmp.resolve("sibling-arrived")))
                        && System.nanoTime() < deadline) Thread.sleep(10);
                assertTrue(Files.exists(tmp.resolve("sibling-arrived")), "형제가 실제 요청을 받기 전에 실패했다");
                failedPid.set(Long.parseLong(Files.readString(tmp.resolve("replacement-pid"))));
                children.set(Thread.getAllStackTraces().keySet().stream()
                        .filter(t -> t.isAlive() && t.getName().startsWith("kordoc-sdk-warmup-")).toList());
                assertEquals(2, children.get().size());
                // 실패 워커의 정리는 이 장벽을 기다리지 않는다. startup 자체만 해제한다.
                Files.writeString(tmp.resolve("fail-now"), "go");
                caller.join(10_000);
                assertFalse(caller.isAlive());
                assertInstanceOf(KordocIncompatibleEngineException.class, outcome.get(1, TimeUnit.SECONDS));
                assertTrue(settledAtThrow.get(), "예외 전달 전에 실제 자식 종료와 두 프로세스 회수를 마쳐야 한다");
                assertTrue(client.workerPids().isEmpty());
                assertTrue(client.workerRss().isEmpty());
            } finally {
                Files.writeString(tmp.resolve("fail-now"), "go");
                caller.interrupt();
                caller.join(10_000);
            }
        }
    }

}
