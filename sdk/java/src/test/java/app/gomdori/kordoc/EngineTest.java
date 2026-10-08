package app.gomdori.kordoc;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** 실제 엔진 — Node parse() 결과 동등성, 상주성, GFM, 이미지 전송, 바이트 입력, 워밍업, 종료 */
class EngineTest {
    @Test
    void resultsEqualNodeParse() throws Exception {
        try (KordocClient client = KordocClient.start(Support.engine().build())) {
            for (JsonNode c : Support.manifest()) {
                ParseResult r = client.parse(Support.fixtures().resolve(c.get("file").asText()), Support.optionsOf(c.get("options")));
                JsonNode want = Support.expected(c.get("name").asText());
                String name = c.get("name").asText();
                assertEquals(want.get("markdown"), r.raw().get("markdown"), name);
                assertEquals(want.get("blocks"), r.blocks(), name);
                assertEquals(want, r.raw(), name); // 쪽·메타·경고·이미지까지
            }
        }
    }

    @Test
    void asyncResultsEqualNodeParse() throws Exception {
        try (KordocClient client = KordocClient.start(Support.engine().maxWorkers(2).build())) {
            List<java.util.concurrent.CompletableFuture<ParseResult>> futures = new ArrayList<>();
            List<String> names = new ArrayList<>();
            for (JsonNode c : Support.manifest()) {
                futures.add(client.parseAsync(Support.fixtures().resolve(c.get("file").asText()), Support.optionsOf(c.get("options"))));
                names.add(c.get("name").asText());
            }
            for (int i = 0; i < futures.size(); i++) assertEquals(Support.expected(names.get(i)), futures.get(i).get().raw(), names.get(i));
            assertTrue(client.workerPids().size() <= 2);
        }
    }

    @Test
    void residentWorkerKeepsPid() throws Exception {
        try (KordocClient client = KordocClient.start(Support.engine().build())) {
            Set<Long> pids = new HashSet<>();
            for (int i = 0; i < 3; i++) {
                client.parse(Support.fixtures().resolve("이미지 문서.docx"));
                pids.addAll(client.workerPids());
            }
            assertEquals(1, pids.size());
        }
    }

    @Test
    void gfmTreeAndRowSpan() throws Exception {
        String md;
        try (KordocClient client = KordocClient.start(Support.engine().build())) {
            md = client.parse(Support.fixtures().resolve("중첩 표.hwpx"), ParseOptions.builder().tableFormat("gfm").build()).markdown();
        }
        assertFalse(md.replaceAll("(?s)<!--.*?-->", "").contains("<table"));
        Matcher m = Pattern.compile("<!-- <table id=\"(t\\d+)\"(?: parent_id=\"(t\\d+)\")? /> -->").matcher(md);
        List<String> ids = new ArrayList<>();
        while (m.find()) ids.add(m.group(1) + "<" + (m.group(2) == null ? "" : m.group(2)));
        assertEquals(List.of("t1<", "t2<t1", "t3<t2", "t4<t3"), ids);
        assertTrue(md.contains("| 인건비 | 선임 | 80 |") && md.contains("| 인건비 | 연구원 | 60 |"));
        assertTrue(md.contains("| 운영비 | 임차·위탁 |  |") && md.contains("| 운영비 | 소모품 | 5 |"));
    }

    @Test
    void optionFalseAndRejections() throws Exception {
        Path doc = Support.fixtures().resolve("이미지 문서.docx");
        try (KordocClient client = KordocClient.start(Support.engine().build())) {
            ParseResult r = client.parse(doc, ParseOptions.builder().images(false).ocr(false).build());
            assertTrue(r.success() && r.images().isEmpty());
            KordocProtocolException e = assertThrows(KordocProtocolException.class,
                    () -> client.parse(doc, ParseOptions.builder().htmlTables(true).tableFormat("gfm").build()));
            assertEquals("INVALID_OPTIONS", e.code());
            e = assertThrows(KordocProtocolException.class, () -> client.parse(doc, ParseOptions.builder().layoutTables("nope").build()));
            assertEquals("INVALID_OPTIONS", e.code());
            assertTrue(client.parse(doc).success()); // 거부 뒤에도 같은 워커가 처리
        }
    }

    @Test
    void imagesInlineAndFiles(@TempDir Path assets) throws Exception {
        Path doc = Support.fixtures().resolve("이미지 문서.docx");
        ParseResult inline, a, b;
        try (KordocClient client = KordocClient.start(Support.engine().build())) {
            inline = client.parse(doc);
            a = client.parse(doc, ParseOptions.builder().fileImageTransport(assets).build());
            b = client.parse(doc, ParseOptions.builder().fileImageTransport(assets).build());
        }
        byte[] bytes = inline.images().get(0).read();
        assertNotEquals(a.assetsDir(), b.assetsDir());
        for (ParseResult r : List.of(a, b)) {
            Image img = r.images().get(0);
            assertEquals(Support.expected("docx-image").get("images").get(0).get("filename").asText(), img.filename());
            assertArrayEquals(bytes, img.read()); // close 뒤에도 파일이 남는다
            assertEquals(inline.markdown(), r.markdown());
        }
    }

    @Test
    void parseBytesEqualsFileAndCleansTemp(@TempDir Path tmp) throws Exception {
        byte[] data = Files.readAllBytes(Support.fixtures().resolve("중첩 표.hwpx"));
        ParseResult fromBytes;
        try (KordocClient client = KordocClient.start(Support.engine().tempDir(tmp).build())) {
            fromBytes = client.parseBytes(data, ParseOptions.builder().tableFormat("gfm").build());
            assertFalse(client.parseBytes("not a document".getBytes()).success());
            try (Stream<Path> files = Files.walk(tmp)) {
                assertEquals(0, files.filter(Files::isRegularFile).count());
            }
        }
        assertEquals(Support.expected("hwpx-gfm").get("markdown").asText(), fromBytes.markdown());
        try (Stream<Path> left = Files.list(tmp)) {
            assertEquals(0, left.count());
        }
    }

    @Test
    void warmupRunsOnEveryWorker() throws Exception {
        try (KordocClient client = KordocClient.start(Support.engine().maxWorkers(2).build())) {
            WarmupReport report = client.warmup(Support.fixtures().resolve("중첩 표.hwpx"), ParseOptions.builder().tableFormat("gfm").build());
            assertTrue(report.ok());
            assertEquals(2, report.workers().size());
            assertEquals(client.workerPids(), report.workers().stream().map(WarmupReport.Worker::pid).sorted().toList());
            WarmupReport bad = client.warmup(Support.fixtures().resolve("없는 문서.hwpx"), ParseOptions.defaults());
            assertFalse(bad.ok());
        }
    }

    @Test
    void closeLeavesNoWorker() throws Exception {
        List<Long> pids;
        try (KordocClient client = KordocClient.start(Support.engine().maxWorkers(2).build())) {
            client.parse(Support.fixtures().resolve("이미지 문서.docx"));
            pids = client.workerPids();
        }
        assertEquals(2, pids.size());
        for (long pid : pids) assertFalse(Support.alive(pid), "pid " + pid);
        KordocClient closed = KordocClient.start(Support.engine().build());
        closed.close();
        assertThrows(KordocClosedException.class, () -> closed.parse(Support.fixtures().resolve("이미지 문서.docx")));
    }
}
