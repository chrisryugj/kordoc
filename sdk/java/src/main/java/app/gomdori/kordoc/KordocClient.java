package app.gomdori.kordoc;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Stream;

/**
 * kordoc 상주 워커 클라이언트. 워커는 {@link #start(KordocConfig)} 에서 띄우고 {@link #close()} 까지 재사용한다(요청마다 프로세스를 만들지 않는다).
 *
 * <pre>{@code
 * try (KordocClient client = KordocClient.start(KordocConfig.defaults())) {
 *     ParseResult result = client.parse(Path.of("문서.hwpx"), ParseOptions.builder().tableFormat("gfm").build());
 *     System.out.println(result.markdown());
 * }
 * }</pre>
 *
 * <p>제한 시간은 대기 큐 입장부터 결과 수신까지다. 넘기거나 {@link #parseAsync} 가 돌려준 Future 를 취소하면,
 * 대기 중인 요청은 큐에서 빠지고 실행 중인 요청은 담당 워커를 종료한다. 다음 요청은 새 워커가 받는다. 자동 재시도는 하지 않는다.
 */
public final class KordocClient implements AutoCloseable {
    private final KordocConfig config;
    private final Slot[] slots;
    private final Deque<Job> queue = new ArrayDeque<>();
    private final Object lock = new Object();
    private final AtomicLong ids = new AtomicLong();
    private final ScheduledThreadPoolExecutor timer;
    private final List<Thread> dispatchers = new ArrayList<>();
    private final List<WorkerProcess> retiring = new ArrayList<>();
    private int idle;
    private boolean closed;
    private volatile Warmup warmupSpec;
    private Path tempRoot;

    private KordocClient(KordocConfig config) {
        this.config = config;
        this.slots = new Slot[config.maxWorkers];
        for (int i = 0; i < slots.length; i++) slots[i] = new Slot();
        this.timer = new ScheduledThreadPoolExecutor(1, r -> {
            Thread t = new Thread(r, "kordoc-sdk-timer");
            t.setDaemon(true);
            return t;
        });
        // 끝난 요청의 제한 시간 타이머를 바로 큐에서 뺀다 — 남으면 결과(이미지 base64 포함)를 제한 시간까지 붙잡는다
        this.timer.setRemoveOnCancelPolicy(true);
    }

    /** 워커를 띄우고 protocol handshake 까지 마친 클라이언트. 하나라도 실패하면 띄운 워커를 정리하고 던진다 */
    public static KordocClient start(KordocConfig config) {
        KordocClient c = new KordocClient(config);
        List<CompletableFuture<Void>> starts = new ArrayList<>();
        for (Slot s : c.slots) {
            starts.add(CompletableFuture.runAsync(() -> {
                WorkerProcess w = new WorkerProcess(config);
                w.start();
                s.worker = w;
            }, r -> daemon("kordoc-sdk-start", r)));
        }
        try {
            CompletableFuture.allOf(starts.toArray(CompletableFuture[]::new)).join();
        } catch (RuntimeException e) {
            for (Slot s : c.slots) if (s.worker != null) s.worker.kill();
            c.timer.shutdownNow();
            throw unwrap(e);
        }
        for (int i = 0; i < c.slots.length; i++) {
            Slot s = c.slots[i];
            c.dispatchers.add(daemon("kordoc-sdk-dispatch-" + i, () -> c.dispatch(s)));
        }
        return c;
    }

    // ─── 파싱 ───────────────────────────────────────────

    public ParseResult parse(Path file) { return parse(file, ParseOptions.defaults()); }

    /** 문서 하나를 파싱한다. 문서를 읽지 못한 것은 예외가 아니라 {@code success() == false} 결과다 */
    public ParseResult parse(Path file, ParseOptions options) {
        return await(parseAsync(file, options));
    }

    public CompletableFuture<ParseResult> parseAsync(Path file) { return parseAsync(file, ParseOptions.defaults()); }

    /** 비동기 파싱. 돌려준 Future 를 취소하면 대기 요청은 빠지고 실행 중 요청은 담당 워커를 종료한다 */
    public CompletableFuture<ParseResult> parseAsync(Path file, ParseOptions options) {
        Job job = new Job(request(file, options));
        // 크기는 큐에 넣기 전에 — 워커는 상한을 넘은 줄을 해석하기 전에 거부해 응답에 id 를 붙일 수 없어, 보내고 나면 워커 장애와 구분되지 않는다
        if (job.line.length > config.maxRequestBytes) {
            return CompletableFuture.failedFuture(new KordocProtocolException("REQUEST_TOO_LARGE", "요청이 상한(" + config.maxRequestBytes + "바이트)을 넘습니다"));
        }
        synchronized (lock) {
            if (closed) return CompletableFuture.failedFuture(new KordocClosedException("닫힌 클라이언트입니다"));
            if (queue.size() >= idle + config.maxQueue) {
                return CompletableFuture.failedFuture(new KordocQueueFullException("대기 큐가 가득 찼습니다 (maxQueue=" + config.maxQueue + ")"));
            }
            queue.addLast(job);
            lock.notifyAll();
        }
        Duration limit = options.timeoutSet ? options.timeout : config.requestTimeout;
        ScheduledFuture<?> timeout = limit == null ? null
                : timer.schedule(() -> job.future.completeExceptionally(new KordocTimeoutException("요청 제한 시간(" + limit + ")을 넘었습니다")),
                        limit.toMillis(), TimeUnit.MILLISECONDS);
        job.future.whenComplete((r, e) -> {
            if (timeout != null) timeout.cancel(false);
            if (e == null) return;
            WorkerProcess running;
            synchronized (job) {
                job.abandoned = true;
                running = job.runningOn;
            }
            // 늦게 올 응답이 다음 요청에 섞이지 않게 — 그 워커가 아직 이 작업을 할 때만, 타이머 스레드를 막지 않게 따로
            if (running != null) daemon("kordoc-sdk-kill", () -> running.killIfRunning(job));
            synchronized (lock) {
                queue.remove(job);
            }
        });
        return job.future;
    }

    public ParseResult parseBytes(byte[] data) { return parseBytes(data, ParseOptions.defaults()); }

    /**
     * 바이트를 SDK 소유 임시 파일에 써서 파싱한다(NDJSON 에 다시 싣지 않는다). 성공·실패·취소와 관계없이 끝나면 지운다.
     * 원본 경로가 필요한 DRM 대체 경로는 파일 입력과 같게 동작하지 않을 수 있다.
     */
    public ParseResult parseBytes(byte[] data, ParseOptions options) {
        checkOpen(); // 닫힌 뒤 지운 임시 루트에 쓰려다 UncheckedIOException 이 나던 것
        Path dir;
        Path file;
        try {
            dir = Files.createTempDirectory(tempRoot(), "in-");
            file = Files.write(dir.resolve("input"), data, java.nio.file.StandardOpenOption.CREATE_NEW);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        try {
            return parse(file, options);
        } finally {
            deleteTree(dir);
        }
    }

    /**
     * 대표 문서를 모든 워커에서 실제로 파싱한다. 교체 워커도 요청을 받기 전에 같은 문서로 워밍업한다.
     * 처리 경로를 한 번 지나게 할 뿐 JIT 최적화 완료를 보장하지 않는다. 실패도 예외 대신 결과로 돌려준다.
     */
    public WarmupReport warmup(Path file, ParseOptions options) {
        checkOpen();
        if (request(file, options).size() > config.maxRequestBytes) {  // 검증만
            throw new KordocProtocolException("REQUEST_TOO_LARGE", "요청이 상한(" + config.maxRequestBytes + "바이트)을 넘습니다");
        }
        warmupSpec = new Warmup(file.toAbsolutePath(), options);
        List<WarmupReport.Worker> out = new ArrayList<>();
        for (Slot s : slots) {
            s.lock.lock();
            try {
                if (s.worker == null || !s.worker.alive()) {
                    s.worker = spawn();
                } else {
                    warm(s.worker);
                }
                if (s.worker != null && s.worker.warmup != null) out.add(s.worker.warmup);
            } finally {
                s.lock.unlock();
            }
        }
        return new WarmupReport(List.copyOf(out));
    }

    /** 살아 있는 소유 워커의 PID */
    public List<Long> workerPids() {
        return Stream.of(slots).map(s -> s.worker).filter(w -> w != null && w.alive()).map(WorkerProcess::pid)
                .sorted(Comparator.naturalOrder()).toList();
    }

    /** 워커별 마지막 rss(바이트). 풀 메모리는 합으로 본다 */
    public List<Long> workerRss() {
        return Stream.of(slots).map(s -> s.worker).filter(w -> w != null && w.alive() && w.lastRss != null).map(w -> w.lastRss).toList();
    }

    /**
     * 새 요청을 막고, 대기 요청은 KordocClosedException 으로 끝내고, 진행 요청은 closeTimeout 까지 기다린 뒤 워커를 종료·회수한다.
     */
    @Override
    public void close() {
        List<Job> pending;
        synchronized (lock) {
            if (closed) return;
            closed = true;
            pending = new ArrayList<>(queue);
            queue.clear();
            lock.notifyAll();
        }
        for (Job j : pending) j.future.completeExceptionally(new KordocClosedException("클라이언트가 닫혔습니다"));
        long deadline = System.nanoTime() + config.closeTimeout.toNanos();
        for (Slot s : slots) {
            boolean got = false;
            try {
                got = s.lock.tryLock(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            WorkerProcess w = s.worker;
            if (!got) {
                if (w != null) w.kill(); // 진행 중 요청은 KordocClosedException 으로 끝난다
                continue;
            }
            try {
                if (w != null) w.quit(Math.max(100, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())));
            } finally {
                s.lock.unlock();
            }
        }
        for (Slot s : slots) if (s.worker != null) s.worker.kill();
        synchronized (retiring) {
            for (WorkerProcess w : retiring) w.kill();
            retiring.clear();
        }
        for (Thread t : dispatchers) t.interrupt();
        for (Thread t : dispatchers) {
            try {
                t.join(config.closeTimeout.toMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        timer.shutdownNow();
        if (tempRoot != null) deleteTree(tempRoot);
    }

    // ─── 내부 ───────────────────────────────────────────

    private Request request(Path file, ParseOptions options) {
        ObjectNode msg = Json.MAPPER.createObjectNode();
        msg.put("id", ids.incrementAndGet());
        msg.put("cmd", "parse");
        msg.put("file", file.toAbsolutePath().toString());
        if (!options.wire.isEmpty()) msg.set("options", options.wire.deepCopy());
        if (options.imageTransport == ParseOptions.ImageTransport.FILES) {
            ObjectNode t = msg.putObject("transport");
            t.put("images", "files");
            t.put("assetsDir", options.assetsDir.toString());
        }
        return new Request(msg);
    }

    private void dispatch(Slot slot) {
        while (true) {
            Job job;
            synchronized (lock) {
                idle++;
                try {
                    while (queue.isEmpty() && !closed) lock.wait();
                } catch (InterruptedException e) {
                    idle--;
                    return;
                }
                idle--;
                if (closed) return;
                job = queue.pollFirst();
            }
            if (job == null || job.future.isDone()) continue;
            slot.lock.lock();
            try {
                run(slot, job);
            } finally {
                slot.lock.unlock();
            }
        }
    }

    private void run(Slot slot, Job job) {
        try {
            if (slot.worker == null || !slot.worker.alive()) slot.worker = spawn();
        } catch (RuntimeException e) {
            slot.worker = null; // 자리는 남겨 다음 요청이 다시 띄운다
            job.future.completeExceptionally(e);
            return;
        }
        WorkerProcess w = slot.worker;
        synchronized (job) {
            if (job.abandoned) return;
            job.runningOn = w;
        }
        try {
            ObjectNode resp = w.request(job.msg, job.line, job);
            Path assets = resp.hasNonNull("assetsDir") ? Path.of(resp.get("assetsDir").asText()) : null;
            job.future.complete(new ParseResult((ObjectNode) resp.get("result"), assets));
            Long limit = config.maxWorkerRssBytes;
            if (limit != null && w.lastRss != null && w.lastRss > limit) retire(slot); // 작업 사이에서만 교체
        } catch (KordocProtocolException e) {
            job.future.completeExceptionally(e); // 요청 거부 — 워커는 멀쩡하다
        } catch (RuntimeException e) {
            w.kill();
            slot.worker = null;
            boolean isClosed;
            synchronized (lock) {
                isClosed = closed;
            }
            job.future.completeExceptionally(isClosed ? new KordocClosedException("클라이언트가 닫히며 진행 중 요청을 끝냈습니다", e) : e);
        } finally {
            synchronized (job) {
                job.runningOn = null;
            }
        }
    }

    private void retire(Slot slot) {
        WorkerProcess old = slot.worker;
        slot.worker = null;
        synchronized (retiring) {
            retiring.add(old);
        }
        daemon("kordoc-sdk-retire", () -> {
            old.quit(config.closeTimeout.toMillis());
            synchronized (retiring) {
                retiring.remove(old);
            }
        });
    }

    private WorkerProcess spawn() {
        WorkerProcess w = new WorkerProcess(config);
        w.start();
        if (warmupSpec != null) {
            warm(w);
            if (!w.alive()) throw new KordocException("교체 워커 워밍업 실패: " + (w.warmup != null ? w.warmup.error() : ""));
        }
        return w;
    }

    private void warm(WorkerProcess w) {
        Warmup spec = warmupSpec;
        Request req = request(spec.file, spec.options);
        var killer = timer.schedule(w::kill, config.warmupTimeout.toMillis(), TimeUnit.MILLISECONDS);
        try {
            ObjectNode r = (ObjectNode) w.request(req.msg, req.line, null).get("result");
            w.warmup = new WarmupReport.Worker(w.pid(), r.path("success").asBoolean(false), r.path("warnings"),
                    r.hasNonNull("error") ? r.get("error").asText() : null);
        } catch (KordocProtocolException e) {
            w.warmup = new WarmupReport.Worker(w.pid(), false, Json.MAPPER.createArrayNode(), e.getMessage());
        } catch (KordocWorkerCrashedException e) {
            w.warmup = new WarmupReport.Worker(w.pid(), false, Json.MAPPER.createArrayNode(),
                    killer.isDone() ? "워밍업 제한 시간(" + config.warmupTimeout + ") 초과" : e.getMessage());
            w.kill();
        } finally {
            killer.cancel(false);
        }
    }

    private void checkOpen() {
        synchronized (lock) {
            if (closed) throw new KordocClosedException("닫힌 클라이언트입니다");
        }
    }

    private synchronized Path tempRoot() throws IOException {
        if (tempRoot == null) {
            Path base = config.tempDir != null ? config.tempDir : Path.of(System.getProperty("java.io.tmpdir"));
            tempRoot = Files.createTempDirectory(base, "kordoc-sdk-");
        }
        return tempRoot;
    }

    private static <T> T await(CompletableFuture<T> f) {
        try {
            return f.get();
        } catch (InterruptedException e) {
            f.cancel(true);
            Thread.currentThread().interrupt();
            throw new KordocException("요청을 기다리다 중단됐습니다", e);
        } catch (CancellationException e) {
            throw e;
        } catch (ExecutionException e) {
            throw unwrap(e.getCause());
        }
    }

    private static RuntimeException unwrap(Throwable e) {
        while ((e instanceof java.util.concurrent.CompletionException || e instanceof ExecutionException) && e.getCause() != null) {
            e = e.getCause();
        }
        return e instanceof RuntimeException re ? re : new KordocException(e.getMessage(), e);
    }

    private static void deleteTree(Path root) {
        try (Stream<Path> walk = Files.walk(root)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // 남은 파일은 다음 정리에서
                }
            });
        } catch (IOException ignored) {
            // 이미 없음
        }
    }

    private static Thread daemon(String name, Runnable r) {
        Thread t = new Thread(r, name);
        t.setDaemon(true);
        t.start();
        return t;
    }

    private static final class Slot {
        final ReentrantLock lock = new ReentrantLock();
        volatile WorkerProcess worker;
    }

    /** 요청 한 줄 — 크기를 보내기 전에 잰다 */
    private static final class Request {
        final ObjectNode msg;
        final byte[] line;

        Request(ObjectNode msg) {
            this.msg = msg;
            try {
                this.line = Json.MAPPER.writeValueAsBytes(msg);
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                throw new KordocException("요청을 직렬화하지 못했습니다: " + e.getMessage(), e);
            }
        }

        int size() { return line.length + 1; }
    }

    private static final class Job {
        final ObjectNode msg;
        final byte[] line;
        final CompletableFuture<ParseResult> future = new CompletableFuture<>();
        WorkerProcess runningOn;
        boolean abandoned;

        Job(Request r) { this.msg = r.msg; this.line = r.line; }
    }

    private record Warmup(Path file, ParseOptions options) {}
}
