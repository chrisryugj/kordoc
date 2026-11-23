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

    /** OCR 대조 문서(모델이 캐시에 있을 때만 manifest 에 있다) — 타입으로 꺼낸 줄이 결과 JSON 과 같다 */
    @Test
    void ocrLinesTypedMatchRaw() throws Exception {
        try (KordocClient client = KordocClient.start(Support.engine().build())) {
            for (JsonNode c : Support.manifest()) {
                if (!c.get("options").has("ocrLines")) continue;
                ParseResult r = client.parse(Support.fixtures().resolve(c.get("file").asText()), Support.optionsOf(c.get("options")));
                List<OcrPageLines> pages = r.ocrLines().orElseThrow();
                JsonNode raw = r.raw().get("ocrLines");
                assertEquals(raw.size(), pages.size());
                for (int i = 0; i < pages.size(); i++) {
                    assertEquals(raw.get(i).get("lines").size(), pages.get(i).lines().size());
                    assertEquals(raw.get(i).get("lines").get(0).get("text").asText(), pages.get(i).lines().get(0).text());
                }
                assertTrue(pages.get(0).lines().stream().anyMatch(l -> l.text().contains("대한민국")), c.get("name").asText());
                // 읽기 후보(ocrLineCandidates) — 줄과 같은 자리, 옵션을 안 준 문서는 줄마다 빈 목록
                int want = c.get("options").path("ocrLineCandidates").asInt(0);
                for (int i = 0; i < pages.size(); i++) {
                    for (int k = 0; k < pages.get(i).lines().size(); k++) {
                        JsonNode rawCandidates = raw.get(i).get("lines").get(k).path("candidates");
                        List<OcrLineCandidate> candidates = r.ocrLineCandidates().get(i).get(k);
                        assertEquals(rawCandidates.size(), candidates.size(), c.get("name").asText());
                        for (int m = 0; m < candidates.size(); m++) {
                            assertEquals(new OcrLineCandidate(rawCandidates.get(m).get("text").asText(), rawCandidates.get(m).get("probability").asDouble()), candidates.get(m));
                        }
                        assertTrue(want == 0 ? candidates.isEmpty() : candidates.size() >= 1 && candidates.size() <= want, c.get("name").asText());
                    }
                }
            }
        }
    }

    /** 페이지 이미지 대조 문서(sharp·pdfium 이 있을 때만 manifest 에 있다) — INLINE·FILES 전송 모두 포맷에 맞는 바이트를 읽는다 */
    @Test
    void pageImagesInlineAndFiles(@TempDir Path assets) throws Exception {
        try (KordocClient client = KordocClient.start(Support.engine().build())) {
            Path first = null;
            for (JsonNode c : Support.manifest()) {
                JsonNode opt = c.get("options").get("pageImages");
                if (opt == null) continue;
                Path doc = Support.fixtures().resolve(c.get("file").asText());
                if (first == null) first = doc;
                String ext = "webp".equals(opt.asText()) ? "webp" : "png";
                ParseResult inline = client.parse(doc, Support.optionsOf(c.get("options")));
                ParseResult files = client.parse(doc, ParseOptions.builder().ocr(false).fileImageTransport(assets).pageImages(ext).build());
                JsonNode raw = inline.raw().get("pageImages");
                assertTrue(raw.size() > 0, c.get("name").asText());
                assertEquals(raw.size(), inline.pageImages().size());
                assertEquals(raw.size(), files.pageImages().size());
                for (int i = 0; i < raw.size(); i++) {
                    PageImage a = inline.pageImages().get(i), b = files.pageImages().get(i);
                    assertEquals(List.of(raw.get(i).get("pageNumber").asInt(), raw.get(i).get("width").asInt(), raw.get(i).get("height").asInt()),
                            List.of(a.pageNumber(), a.width(), a.height()));
                    assertEquals("image/" + ext, a.image().mimeType());
                    assertEquals(String.format("page_%03d.%s", a.pageNumber(), ext), b.image().filename());
                    assertTrue(a.image().path().isEmpty());
                    // FILES 의 파일 이름은 dataRef 가 정한다 — 원본 페이지 이미지(images)와 바이트가 같으면 그 파일을 함께 가리킨다
                    assertEquals(files.assetsDir().orElseThrow(), b.image().path().orElseThrow().getParent());
                    byte[] bytes = a.image().read();
                    assertArrayEquals(bytes, b.image().read());
                    String magic = new String(bytes, 0, 12, java.nio.charset.StandardCharsets.ISO_8859_1);
                    assertTrue(ext.equals("png") ? magic.startsWith("\u0089PNG") : magic.startsWith("RIFF") && magic.endsWith("WEBP"), c.get("name").asText());
                }
            }
            if (first == null) return; // sharp·pdfium 이 없어 페이지 이미지 대조 문서가 없다
            // 모르는 포맷은 워커가 거부한다(PNG 로 바꿔 내지 않는다)
            Path doc = first;
            KordocProtocolException e = assertThrows(KordocProtocolException.class, () -> client.parse(doc, ParseOptions.builder().pageImages("gif").build()));
            assertEquals("INVALID_OPTIONS", e.code());
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
