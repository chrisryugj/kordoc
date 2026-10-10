package app.gomdori.kordoc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** 상주 워커 프로세스 하나 — 한 번에 요청 하나만 보낸다. stdout·stderr 는 전용 스레드가 계속 읽는다. */
final class WorkerProcess {
    private static final Object EOF = new Object();
    private static final Object TOO_LARGE = new Object();
    private static final List<String> REQUIRED_CAPABILITIES = List.of("parse", "options");

    private final KordocConfig config;
    private final BlockingQueue<Object> lines = new LinkedBlockingQueue<>();
    private final byte[] stderrTail;
    private int stderrLen;
    /** kill 은 다른 스레드(close·취소)에서도 부른다 — 시작 중에 부르면 띄운 뒤의 값을 봐야 한다 */
    private volatile Process proc;
    /** kill 을 불렀다 — 프로세스가 생기기 전에 불렀으면 start 가 띄운 직후 이것을 보고 종료한다 */
    private volatile boolean killed;
    private OutputStream stdin;
    private Thread stdoutThread;
    private Thread stderrThread;
    String version;
    volatile Long lastRss;

    WorkerProcess(KordocConfig config) {
        this.config = config;
        this.stderrTail = new byte[Math.max(0, config.stderrTailBytes)];
    }

    long pid() { return proc == null ? -1 : proc.pid(); }

    boolean alive() { return proc != null && proc.isAlive(); }

    synchronized String stderrTail() {
        return new String(stderrTail, 0, stderrLen, StandardCharsets.UTF_8);
    }

    void start() {
        List<String> cmd = config.command();
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().putAll(config.env);
        try {
            proc = pb.start();
        } catch (IOException e) {
            throw new KordocStartException("워커를 띄우지 못했습니다: " + cmd.get(0) + " " + cmd.get(1) + " — " + e.getMessage(), e);
        }
        stdin = proc.getOutputStream();
        stdoutThread = daemon("kordoc-worker-stdout-" + proc.pid(), this::readStdout);
        stderrThread = daemon("kordoc-worker-stderr-" + proc.pid(), this::readStderr);
        try {
            if (killed) throw new KordocStartException("워커를 띄우는 중에 종료 요청을 받았습니다");
            handshake();
        } catch (RuntimeException e) {
            kill();
            throw e;
        }
    }

    private void handshake() {
        Object first;
        try {
            first = lines.poll(config.startTimeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new KordocStartException("워커 시작을 기다리다 중단됐습니다");
        }
        if (first == null) {
            throw new KordocStartException("워커가 " + config.startTimeout.toSeconds() + "초 안에 ready 를 보내지 않았습니다\n" + stderrTail());
        }
        if (!(first instanceof byte[] line)) {
            reap();
            throw new KordocStartException("워커가 ready 전에 끝났습니다 (code " + exitCode() + ")\n" + stderrTail());
        }
        JsonNode ready;
        try {
            ready = Json.MAPPER.readTree(line);
        } catch (IOException e) {
            throw new KordocIncompatibleEngineException("ready 줄이 JSON 이 아닙니다: " + preview(line));
        }
        if (!ready.path("ready").asBoolean(false) || ready.path("protocol").asInt(-1) != 2) {
            throw new KordocIncompatibleEngineException("parse-worker protocol 2 를 지원하지 않는 엔진입니다: " + ready);
        }
        for (String cap : REQUIRED_CAPABILITIES) {
            boolean has = false;
            for (JsonNode c : ready.path("capabilities")) has |= cap.equals(c.asText());
            if (!has) throw new KordocIncompatibleEngineException("엔진에 필요한 기능이 없습니다: " + cap + " (version " + ready.path("version").asText() + ")");
        }
        version = ready.path("version").asText(null);
    }

    /** 지금 이 워커가 처리 중인 작업 (killIfRunning 이 다른 작업을 받은 워커를 죽이지 않게). stderr 꼬리와 다른 잠금 —
     *  kill 이 stderr 스레드를 기다리는 동안 그 스레드가 this 잠금(appendTail)에서 막히지 않게 */
    private final Object currentLock = new Object();
    private Object current;
    /** killIfRunning 으로 이 워커를 죽인 작업 — 응답이 이미 와 있어도 그 작업의 결과로 쓰지 않는다 */
    private Object killedFor;

    /**
     * 이 워커가 job 을 맡는다고 표시한다. {@link #request} 전에, 취소·제한 시간이 이 워커를 찾을 수 있게 되는 시점과 같은 잠금 안에서
     * 부른다 — 그 사이에 온 취소가 "아직 이 작업을 하지 않는다"로 보고 kill 을 건너뛰지 않게
     */
    void assign(Object job) {
        synchronized (currentLock) {
            current = job;
        }
    }

    /**
     * 요청 하나(requestLine — 미리 직렬화한 msg)를 보내고 같은 id 의 응답을 돌려준다. job 은 {@link #assign} 으로 맡긴 작업이다.
     * 워커가 거부하면 KordocProtocolException(워커는 멀쩡하다). 워커가 끝났거나 응답이 깨졌거나 이 작업 때문에
     * {@link #killIfRunning} 으로 종료됐으면 KordocWorkerCrashedException — 이 워커는 더 쓰지 않는다.
     */
    ObjectNode request(ObjectNode msg, byte[] requestLine, Object job) {
        ObjectNode resp;
        boolean killedForJob;
        try {
            resp = exchange(msg, requestLine);
        } finally {
            synchronized (currentLock) {
                killedForJob = killedFor == job;
                current = null;
            }
        }
        if (killedForJob) throw new KordocWorkerCrashedException("취소·제한 시간으로 워커를 종료했습니다", stderrTail());
        return resp;
    }

    /** 이 워커가 아직 job 을 처리 중일 때만 죽인다 — 늦은 응답과 겹쳐 이미 다음 작업을 받은 워커를 죽이지 않는다 */
    void killIfRunning(Object job) {
        synchronized (currentLock) {
            if (current != job) return;
            killedFor = job;
            kill();
        }
    }

    private ObjectNode exchange(ObjectNode msg, byte[] requestLine) {
        try {
            stdin.write(requestLine);
            stdin.write('\n');
            stdin.flush();
        } catch (IOException e) {
            throw new KordocWorkerCrashedException("워커에 요청을 쓰지 못했습니다: " + e.getMessage(), stderrTail());
        }
        Object next;
        try {
            next = lines.take();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            kill();
            throw new KordocWorkerCrashedException("응답을 기다리다 중단됐습니다", stderrTail());
        }
        if (next == TOO_LARGE) {
            throw new KordocWorkerCrashedException("응답이 SDK 상한(" + config.maxResponseBytes + "바이트)을 넘습니다", stderrTail());
        }
        if (next == EOF) {
            reap();
            throw new KordocWorkerCrashedException("응답 전에 워커가 끝났습니다 (code " + exitCode() + ")", stderrTail());
        }
        if (next instanceof Partial p) {
            reap();
            throw new KordocWorkerCrashedException("응답이 중간에 끊겼습니다 (code " + exitCode() + "): " + preview(p.bytes), stderrTail());
        }
        byte[] line = (byte[]) next;
        JsonNode resp;
        try {
            resp = Json.MAPPER.readTree(line);
        } catch (IOException e) {
            throw new KordocWorkerCrashedException("응답이 JSON 이 아닙니다: " + preview(line), stderrTail());
        }
        if (!(resp instanceof ObjectNode obj)) {
            throw new KordocWorkerCrashedException("응답이 객체가 아닙니다: " + preview(line), stderrTail());
        }
        if (!obj.path("id").isIntegralNumber() || obj.path("id").asLong() != msg.path("id").asLong()) {
            throw new KordocWorkerCrashedException("응답 id 가 요청과 다릅니다 (요청 " + msg.path("id") + ", 응답 " + obj.path("id") + ")", stderrTail());
        }
        if (obj.path("rss").isIntegralNumber()) lastRss = obj.path("rss").asLong();
        JsonNode err = obj.get("error");
        if (err != null && !err.isNull()) {
            throw new KordocProtocolException(err.path("code").asText("UNKNOWN"), err.path("message").asText(""));
        }
        if (!obj.path("result").isObject()) {
            throw new KordocWorkerCrashedException("응답에 result 가 없습니다", stderrTail());
        }
        return obj;
    }

    /** 즉시 종료하고 회수한다. 어느 스레드에서 불러도 된다 */
    void kill() {
        killed = true;
        Process p = proc;
        if (p == null) return;
        p.destroyForcibly();
        // interrupt 된 스레드(중단된 warmup·parse)에서 불러도 끝까지 회수한다 — 돌아온 뒤 alive() 가 참이면 다음 요청이 죽어 가는 워커에 쓴다
        boolean interrupted = Thread.interrupted();
        while (true) {
            try {
                p.waitFor();
                break;
            } catch (InterruptedException e) {
                interrupted = true;
            }
        }
        joinQuietly(stdoutThread);
        joinQuietly(stderrThread);
        if (interrupted) Thread.currentThread().interrupt();
    }

    /** quit 를 보내고 끝나기를 기다린다. 제한 시간을 넘기면 강제 종료 */
    void quit(long timeoutMillis) {
        Process p = proc;
        if (p == null) return;
        if (p.isAlive()) {
            try {
                stdin.write("{\"cmd\":\"quit\"}\n".getBytes(StandardCharsets.UTF_8));
                stdin.flush();
                stdin.close();
            } catch (IOException ignored) {
                // 이미 끝난 워커
            }
            // interrupt 돼도 남은 시간까지 기다린다 — close 는 interrupt 와 관계없이 closeTimeout 을 유예한다
            boolean interrupted = Thread.interrupted();
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(Math.max(1, timeoutMillis));
            for (long left; (left = deadline - System.nanoTime()) > 0; ) {
                try {
                    if (p.waitFor(left, TimeUnit.NANOSECONDS)) break;
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
            if (interrupted) Thread.currentThread().interrupt();
        }
        kill();
    }

    private void readStdout() {
        long limit = (long) config.maxResponseBytes + 64 * 1024;
        try (InputStream in = proc.getInputStream()) {
            ByteArrayOutputStream cur = new ByteArrayOutputStream();
            boolean discarding = false;
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                int start = 0;
                for (int i = 0; i < n; i++) {
                    if (buf[i] != '\n') continue;
                    if (!discarding) {
                        cur.write(buf, start, i - start);
                        lines.add(stripCr(cur.toByteArray()));
                    }
                    cur.reset();
                    discarding = false;
                    start = i + 1;
                }
                if (!discarding) {
                    cur.write(buf, start, n - start);
                    if (cur.size() > limit) {
                        // 상한을 넘은 줄은 모으지 않는다 — 잘린 성공으로 쓰지 않고 이 워커를 버린다
                        cur.reset();
                        discarding = true;
                        lines.add(TOO_LARGE);
                    }
                }
            }
            if (!discarding && cur.size() > 0) lines.add(new Partial(cur.toByteArray()));
        } catch (IOException ignored) {
            // 종료로 파이프가 닫힘
        } finally {
            lines.add(EOF);
        }
    }

    private void readStderr() {
        try (InputStream in = proc.getErrorStream()) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) appendTail(buf, n);
        } catch (IOException ignored) {
            // 종료로 파이프가 닫힘
        }
    }

    /** stderr 를 계속 비운다(안 비우면 워커가 쓰다 막힌다). 끝부분만 진단용으로 남긴다 */
    private synchronized void appendTail(byte[] buf, int n) {
        int cap = stderrTail.length;
        if (cap == 0) return;
        if (n >= cap) {
            System.arraycopy(buf, n - cap, stderrTail, 0, cap);
            stderrLen = cap;
            return;
        }
        int keep = Math.min(stderrLen, cap - n);
        System.arraycopy(stderrTail, stderrLen - keep, stderrTail, 0, keep);
        System.arraycopy(buf, 0, stderrTail, keep, n);
        stderrLen = keep + n;
    }

    private void reap() {
        try {
            proc.waitFor(1, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private String exitCode() {
        return proc.isAlive() ? "실행 중" : Integer.toString(proc.exitValue());
    }

    private static byte[] stripCr(byte[] b) {
        return b.length > 0 && b[b.length - 1] == '\r' ? java.util.Arrays.copyOf(b, b.length - 1) : b;
    }

    private static String preview(byte[] b) {
        String s = new String(b, 0, Math.min(b.length, 200), StandardCharsets.UTF_8);
        return b.length > 200 ? s + "…" : s;
    }

    private static Thread daemon(String name, Runnable r) {
        Thread t = new Thread(r, name);
        t.setDaemon(true);
        t.start();
        return t;
    }

    private static void joinQuietly(Thread t) {
        if (t == null) return;
        try {
            t.join(2000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private record Partial(byte[] bytes) {}
}
