package app.gomdori.kordoc;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
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
 *
 * <p>{@link #parseAsync} 의 Future 는 SDK 소유 스레드({@code kordoc-sdk-complete-*})에서 완료된다.
 * {@code thenApply} 같은 콜백 안에서 동기 {@link #parse} 를 불러도 된다. 단 {@link CompletableFuture#cancel} 로 끝낸 Future 의 콜백과
 * 이미 끝난 Future 에 붙인 콜백은 그것을 부른 스레드에서 돈다.
 */
public final class KordocClient implements AutoCloseable {
    private final KordocConfig config;
    private final Slot[] slots;
    private final Deque<Job> queue = new ArrayDeque<>();
    private final Object lock = new Object();
    private final AtomicLong ids = new AtomicLong();
    private final ScheduledThreadPoolExecutor timer;
    /** Future 완료(사용자 콜백)를 돌리는 스레드 — 콜백이 자리 잠금을 쥔 디스패처나 하나뿐인 타이머를 붙잡지 않게 */
    private final ExecutorService completer;
    /** completer 에서 완료를 돌리는 중인가 — 거기서 부른 close 는 자기 완료를 기다리지 않는다 */
    private final ThreadLocal<Boolean> completing = ThreadLocal.withInitial(() -> false);
    private final Object completionLock = new Object();
    /** completer 에 넘겨 아직 끝나지 않은 완료 수 — close 가 기다린다 */
    private int completions;
    private final List<Thread> dispatchers = new ArrayList<>();
    private final List<WorkerProcess> retiring = new ArrayList<>();
    /** 작업을 꺼내 실행 중인 디스패처 수 — 빈 자리 = 워커 수 - busy (대기 루프 진입 여부와 무관해 start 직후에도 맞다) */
    private int busy;
    private boolean closed;
    /** 정리까지 끝난 close — 두 번째 close 가 기다린다 */
    private boolean closeDone;
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
        AtomicLong n = new AtomicLong();
        this.completer = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "kordoc-sdk-complete-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
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
            c.completer.shutdownNow();
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
        Duration limit = options.timeoutSet ? options.timeout : config.requestTimeout;
        ScheduledFuture<?> timeout;
        synchronized (lock) {
            if (closed) return CompletableFuture.failedFuture(new KordocClosedException("닫힌 클라이언트입니다"));
            if (queue.size() >= slots.length - busy + config.maxQueue) {
                return CompletableFuture.failedFuture(new KordocQueueFullException("대기 큐가 가득 찼습니다 (maxQueue=" + config.maxQueue + ")"));
            }
            timeout = limit == null ? null
                    : schedule(() -> completeLater(() -> job.future.completeExceptionally(new KordocTimeoutException("요청 제한 시간(" + limit + ")을 넘었습니다"))), limit);
            queue.addLast(job);
            lock.notifyAll();
        }
        if (timeout != null) job.future.whenComplete((r, e) -> timeout.cancel(false));
        return job.future;
    }

    /**
     * 실패·취소·제한 시간으로 끝나는 작업 정리. 대기 중이면 큐에서 빼고, 실행 중이면 늦게 올 응답이 다음 요청에 섞이지 않게
     * 그 워커가 아직 이 작업을 할 때만 따로 종료한다
     */
    private void abandon(Job job) {
        WorkerProcess running;
        synchronized (job) {
            if (job.abandoned) return;
            job.abandoned = true;
            running = job.runningOn;
        }
        if (running != null) daemon("kordoc-sdk-kill", () -> running.killIfRunning(job));
        synchronized (lock) {
            queue.remove(job);
        }
    }

    /** completer 에서 완료한다(닫힌 뒤 거부되면 그 자리에서) */
    private void completeLater(Runnable completion) {
        synchronized (completionLock) {
            completions++; // 넘기기 전에 센다 — 스레드가 아직 돌기 전이어도 close 가 기다린다
        }
        try {
            completer.execute(() -> {
                completing.set(true);
                try {
                    completion.run();
                } finally {
                    completing.set(false);
                    completionDone();
                }
            });
        } catch (RejectedExecutionException e) {
            completionDone();
            completion.run();
        }
    }

    private void completionDone() {
        synchronized (completionLock) {
            completions--;
            completionLock.notifyAll();
        }
    }

    public ParseResult parseBytes(byte[] data) { return parseBytes(data, ParseOptions.defaults()); }

    /**
     * 바이트를 SDK 소유 임시 파일에 써서 파싱한다(NDJSON 에 다시 싣지 않는다). 성공·실패·취소와 관계없이 끝나면 지운다.
     * 원본 경로가 필요한 DRM 대체 경로는 파일 입력과 같게 동작하지 않을 수 있다.
     */
    public ParseResult parseBytes(byte[] data, ParseOptions options) {
        Path dir = inputDir();
        try {
            Path file;
            try {
                file = Files.write(dir.resolve("input"), data, java.nio.file.StandardOpenOption.CREATE_NEW);
            } catch (IOException e) {
                if (isClosed()) throw new KordocClosedException("클라이언트가 닫혀 입력을 쓰지 못했습니다", e); // close 가 루트를 지웠다
                throw new UncheckedIOException(e);
            }
            return parse(file, options);
        } finally {
            deleteTree(dir);
            // close 의 루트 삭제가 아직 쓰던 이 디렉터리 때문에 실패했을 수 있다 — 닫힌 뒤 마지막으로 끝나는 쪽이 빈 루트를 지운다
            if (isClosed()) deleteQuietly(dir.getParent());
        }
    }

    /**
     * 대표 문서를 모든 워커에서 실제로 파싱한다. 한 워커에서라도 성공하면 교체 워커도 요청을 받기 전에 같은 문서로 워밍업한다.
     * 교체 워커의 워밍업이 워커를 끝내면 그 요청은 워밍업 없는 새 워커가 받는다.
     * 처리 경로를 한 번 지나게 할 뿐 JIT 최적화 완료를 보장하지 않는다. 문서 파싱 실패도 예외 대신 결과로 돌려준다.
     * 부른 스레드가 interrupt 되면 응답을 기다리던 워커만 종료하고 {@link KordocException} 을 던진다(워밍업 문서는 등록하지 않는다).
     */
    public WarmupReport warmup(Path file, ParseOptions options) {
        checkOpen();
        Warmup spec = new Warmup(file.toAbsolutePath(), options);
        if (request(spec.file, spec.options).line.length > config.maxRequestBytes) {  // 검증만 — parseAsync 와 같은 경계(개행 제외)
            throw new KordocProtocolException("REQUEST_TOO_LARGE", "요청이 상한(" + config.maxRequestBytes + "바이트)을 넘습니다");
        }
        List<WarmupReport.Worker> out = new ArrayList<>();
        for (Slot s : slots) {
            try {
                s.lock.lockInterruptibly();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new KordocException("워밍업을 기다리다 중단됐습니다", e);
            }
            try {
                WorkerProcess w = s.worker;
                if (w == null || !w.alive()) w = spawn(s, false);
                out.add(warm(w, spec));
            } finally {
                s.lock.unlock();
            }
            // 응답 대기 중 interrupt 는 warm 이 그 워커를 종료하고 결과로 바꾼다 — 마지막 자리여도 보고·등록 대신 던진다
            if (Thread.currentThread().isInterrupted()) throw new KordocException("워밍업을 기다리다 중단됐습니다");
        }
        warmupSpec = out.stream().anyMatch(WarmupReport.Worker::success) ? spec : null;
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
     * 닫기 시작한 뒤에는 새 워커를 띄우지 않는다. 돌아올 때 요청 Future 는 끝나 있고, 완료 콜백도 closeTimeout 까지 기다린다
     * (완료 콜백 안에서 부르면 자기 콜백은 빼고). 다른 스레드에서 다시 부르면 첫 close 가 끝날 때까지 기다린다 — 단 SDK 완료 스레드의
     * 콜백 안에서 다시 부르면 바로 돌아온다. interrupt 돼도 똑같이 기다리며 interrupt 상태는 유지한다.
     */
    @Override
    public void close() {
        // 정리는 interrupt 와 관계없이 마친다(shutdownNow 로 중단된 작업의 try-with-resources) — 상태는 돌아갈 때 되살린다
        boolean interrupted = Thread.interrupted();
        try {
            List<Job> pending;
            synchronized (lock) {
                if (closed) {
                    // 첫 close 가 끝낸 Future 의 콜백(completer)에서 다시 부르면 기다리지 않는다 — 첫 close 가 그 콜백을 기다린다
                    while (!closeDone && !completing.get()) {
                        try {
                            lock.wait();
                        } catch (InterruptedException e) {
                            interrupted = true;
                        }
                    }
                    return;
                }
                closed = true;
                pending = new ArrayList<>(queue);
                queue.clear();
                lock.notifyAll();
            }
            try {
                interrupted |= shutdown(pending);
            } finally {
                synchronized (lock) {
                    closeDone = true;
                    lock.notifyAll();
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    /** 닫기 정리. interrupt 상태를 지운 채 불리고, 도중에 interrupt 돼도 기다림을 이어 간다 — 그동안 interrupt 됐는지 돌려준다 */
    private boolean shutdown(List<Job> pending) {
        boolean interrupted = false;
        for (Job j : pending) completeLater(() -> j.future.completeExceptionally(new KordocClosedException("클라이언트가 닫혔습니다")));
        long deadline = System.nanoTime() + config.closeTimeout.toNanos();
        for (Slot s : slots) {
            boolean got;
            while (true) {
                try {
                    got = s.lock.tryLock(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                    break;
                } catch (InterruptedException e) {
                    interrupted = true;
                }
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
        for (Slot s : slots) {
            WorkerProcess w = s.worker;
            if (w != null) w.kill();
            WorkerProcess st = s.starting;
            if (st != null) st.kill();
        }
        synchronized (retiring) {
            for (WorkerProcess w : retiring) w.kill();
            retiring.clear();
        }
        for (Thread t : dispatchers) t.interrupt();
        for (Thread t : dispatchers) {
            long joinUntil = System.nanoTime() + config.closeTimeout.toNanos();
            for (long left; t.isAlive() && (left = joinUntil - System.nanoTime()) > 0; ) {
                try {
                    TimeUnit.NANOSECONDS.timedJoin(t, left);
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
        }
        timer.shutdownNow();
        completer.shutdown(); // 이미 넘긴 완료는 마저 돌고, 돌아오기 전에 끝나게 기다린다
        // 완료 콜백 안에서 부른 close 면 자기 완료는 빼고 센다 — 자기를 기다리면 closeTimeout 내내 멈춘다
        int self = completing.get() ? 1 : 0;
        long waitUntil = System.nanoTime() + config.closeTimeout.toNanos();
        synchronized (completionLock) {
            for (long left; completions > self && (left = waitUntil - System.nanoTime()) > 0; ) {
                try {
                    TimeUnit.NANOSECONDS.timedWait(completionLock, left);
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
        }
        Path root;
        synchronized (lock) {
            root = tempRoot; // closed 뒤라 더 만들어지지 않는다
        }
        if (root != null) deleteTree(root);
        return interrupted;
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
                try {
                    while (queue.isEmpty() && !closed) lock.wait();
                } catch (InterruptedException e) {
                    return;
                }
                if (closed) return;
                job = queue.pollFirst();
                if (job == null || job.future.isDone()) continue;
                busy++;
            }
            Runnable done;
            slot.lock.lock();
            try {
                done = run(slot, job);
            } finally {
                slot.lock.unlock();
                synchronized (lock) {
                    busy--;
                }
            }
            // 자리를 놓은 뒤 완료한다 — 콜백이 자리를 쥔 이 스레드에서 돌면 콜백 안의 동기 parse 가 이 자리를 기다리며 멈춘다
            completeLater(done);
        }
    }

    /** 작업 하나를 처리하고, 자리를 놓은 뒤 돌릴 완료를 돌려준다 */
    private Runnable run(Slot slot, Job job) {
        WorkerProcess w = slot.worker;
        try {
            if (w == null || !w.alive()) w = spawn(slot, true);
        } catch (RuntimeException e) {
            slot.worker = null; // 자리는 남겨 다음 요청이 다시 띄운다
            return () -> job.future.completeExceptionally(e);
        }
        synchronized (job) {
            if (job.abandoned) return () -> {};
            job.runningOn = w;
            w.assign(job); // runningOn 과 같은 잠금 안에서 — 그 사이에 온 취소가 kill 을 건너뛰지 않게
        }
        try {
            ObjectNode resp = w.request(job.msg, job.line, job);
            Path assets = resp.hasNonNull("assetsDir") ? Path.of(resp.get("assetsDir").asText()) : null;
            ParseResult result = new ParseResult((ObjectNode) resp.get("result"), assets);
            Long limit = config.maxWorkerRssBytes;
            if (limit != null && w.lastRss != null && w.lastRss > limit) retire(slot); // 작업 사이에서만 교체
            return () -> job.future.complete(result);
        } catch (KordocProtocolException e) {
            return () -> job.future.completeExceptionally(e); // 요청 거부 — 워커는 멀쩡하다
        } catch (RuntimeException e) {
            w.kill();
            slot.worker = null;
            synchronized (job) {
                if (job.abandoned) return () -> {}; // 취소·제한 시간이 이 워커를 죽였다 — 그쪽이 Future 를 끝낸다
            }
            RuntimeException err = isClosed() ? new KordocClosedException("클라이언트가 닫히며 진행 중 요청을 끝냈습니다", e) : e;
            return () -> job.future.completeExceptionally(err);
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

    /**
     * 자리에 새 워커를 띄워 넣는다(자리 잠금을 쥐고 부른다). warm 이면 등록된 워밍업 문서로 먼저 워밍업하고, 그 워밍업이 워커를 끝내면
     * 워밍업 없는 새 워커로 바꾼다 — 워밍업 실패로 요청을 막지 않는다. 닫혔으면 넣지 않고 죽인 뒤 KordocClosedException 을 던진다.
     */
    private WorkerProcess spawn(Slot slot, boolean warm) {
        WorkerProcess w = newWorker(slot);
        try {
            w.start();
            Warmup spec = warm ? warmupSpec : null;
            if (spec != null && !warm(w, spec).success() && !w.alive()) {
                w = newWorker(slot);
                w.start();
            }
            synchronized (lock) {
                if (closed) throw new KordocClosedException("클라이언트가 닫혀 새 워커를 쓰지 않습니다");
                slot.worker = w;
                slot.starting = null;
            }
            return w;
        } catch (RuntimeException e) {
            w.kill();
            boolean isClosed;
            synchronized (lock) {
                slot.starting = null;
                isClosed = closed;
            }
            throw isClosed && !(e instanceof KordocClosedException) ? new KordocClosedException("클라이언트가 닫혀 워커 시작을 멈췄습니다", e) : e;
        }
    }

    private WorkerProcess newWorker(Slot slot) {
        WorkerProcess w = new WorkerProcess(config);
        synchronized (lock) {
            if (closed) throw new KordocClosedException("닫힌 클라이언트입니다");
            slot.starting = w;
        }
        return w;
    }

    /**
     * 워밍업 문서 한 건. 기한이 지나면 그 워커가 아직 이 워밍업을 할 때만, 타이머 스레드 밖에서 종료한다 — 응답을 받은 뒤 기한이 지나도
     * 성공으로 보고한 워커를 죽이지 않는다. 종료했으면 실패로 보고한다
     */
    private WarmupReport.Worker warm(WorkerProcess w, Warmup spec) {
        Request req = request(spec.file, spec.options);
        Object token = new Object();
        AtomicBoolean expired = new AtomicBoolean();
        w.assign(token); // 킬러를 걸기 전에 — 기한이 아주 짧아도 kill 을 건너뛰지 않게
        var killer = schedule(() -> {
            expired.set(true);
            daemon("kordoc-sdk-kill", () -> w.killIfRunning(token));
        }, config.warmupTimeout);
        try {
            ObjectNode r = (ObjectNode) w.request(req.msg, req.line, token).get("result");
            return new WarmupReport.Worker(w.pid(), r.path("success").asBoolean(false), r.path("warnings"),
                    r.hasNonNull("error") ? r.get("error").asText() : null);
        } catch (KordocProtocolException e) {
            return new WarmupReport.Worker(w.pid(), false, Json.MAPPER.createArrayNode(), e.getMessage());
        } catch (KordocWorkerCrashedException e) {
            w.kill();
            return new WarmupReport.Worker(w.pid(), false, Json.MAPPER.createArrayNode(),
                    expired.get() ? "워밍업 제한 시간(" + config.warmupTimeout + ") 초과" : e.getMessage());
        } finally {
            killer.cancel(false);
        }
    }

    /** 닫히지 않았을 때만 타이머를 건다 — close 는 closed 를 세운 뒤 타이머를 내리므로 같은 잠금 안에서는 거부되지 않는다 */
    private ScheduledFuture<?> schedule(Runnable task, Duration delay) {
        synchronized (lock) {
            if (closed) throw new KordocClosedException("닫힌 클라이언트입니다");
            return timer.schedule(task, delay.toMillis(), TimeUnit.MILLISECONDS);
        }
    }

    private void checkOpen() {
        synchronized (lock) {
            if (closed) throw new KordocClosedException("닫힌 클라이언트입니다");
        }
    }

    private boolean isClosed() {
        synchronized (lock) {
            return closed;
        }
    }

    /** parseBytes 입력 디렉터리. closed 확인·루트 생성을 close 와 같은 잠금 안에서 한다 — 닫힌 뒤 루트를 만들어 남기지 않게 */
    private Path inputDir() {
        synchronized (lock) {
            if (closed) throw new KordocClosedException("닫힌 클라이언트입니다");
            try {
                if (tempRoot == null) {
                    Path base = config.tempDir != null ? config.tempDir : Path.of(System.getProperty("java.io.tmpdir"));
                    tempRoot = Files.createTempDirectory(base, "kordoc-sdk-");
                }
                return Files.createTempDirectory(tempRoot, "in-");
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
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

    /**
     * 트리를 지운다. close 의 루트 삭제와 끝나 가는 parseBytes 의 입력 디렉터리 삭제가 같은 항목을 동시에 지울 수 있다 — 사라진 항목은
     * 건너뛰고 나머지를 마저 지운다(Files.walk 는 순회 중 사라진 항목에서 UncheckedIOException 을 던지고 멈춘다)
     */
    private static void deleteTree(Path root) {
        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    deleteQuietly(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException e) {
                    return FileVisitResult.CONTINUE; // 이미 없음
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException e) {
                    deleteQuietly(dir); // 비어 있지 않으면 남는다 — 남은 파일을 쓰던 쪽이 지운다
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException ignored) {
            // 방문자가 던지지 않는다
        }
    }

    private static void deleteQuietly(Path p) {
        try {
            Files.deleteIfExists(p);
        } catch (IOException ignored) {
            // 비어 있지 않음 — 나머지를 쓰던 쪽이 지운다
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
        /** 띄우는 중이라 아직 worker 가 아닌 워커 — close 가 죽인다 */
        volatile WorkerProcess starting;
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
    }

    private final class Job {
        final ObjectNode msg;
        final byte[] line;
        /** 끝내기 전에 abandon 한다 — whenComplete 로 걸면 나중에 붙은 사용자 콜백이 먼저 돌아, 콜백 안의 동기 parse 가 아직 안 죽인 워커를 기다린다 */
        final CompletableFuture<ParseResult> future = new CompletableFuture<>() {
            @Override
            public boolean cancel(boolean mayInterruptIfRunning) {
                if (!isDone()) abandon(Job.this);
                return super.cancel(mayInterruptIfRunning);
            }

            @Override
            public boolean completeExceptionally(Throwable ex) {
                if (!isDone()) abandon(Job.this);
                return super.completeExceptionally(ex);
            }
        };
        WorkerProcess runningOn;
        boolean abandoned;

        Job(Request r) { this.msg = r.msg; this.line = r.line; }
    }

    private record Warmup(Path file, ParseOptions options) {}
}
