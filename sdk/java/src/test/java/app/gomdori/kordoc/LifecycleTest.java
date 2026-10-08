package app.gomdori.kordoc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** 수명 관리 회귀 — 제한 시간 타이머 회수, 요청 크기 검사, 닫힌 뒤 parseBytes, 엔진 경로 탐색 */
class LifecycleTest {
    @TempDir
    Path tmp;

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

    @Test
    void parseBytesAfterCloseThrowsClosed() {
        KordocClient client = KordocClient.start(Support.fault("ok", Map.of()).build());
        assertTrue(client.parseBytes(new byte[] {1}).success());
        client.close();
        assertThrows(KordocClosedException.class, () -> client.parseBytes(new byte[] {1}));
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
}
