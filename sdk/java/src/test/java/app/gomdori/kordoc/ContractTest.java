package app.gomdori.kordoc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/** 공유 wire fixture(sdk/fixtures/protocol-v2.json) — 옵션 인코딩·응답 해독. 엔진 없이 돈다 */
class ContractTest {
    private static JsonNode fixture() throws IOException {
        return Json.MAPPER.readTree(Support.PROTOCOL_FIXTURE.toFile());
    }

    @Test
    void optionsEncodeLikeFixture() throws IOException {
        JsonNode reqs = fixture().get("requests");
        assertEquals(reqs.get(1).get("options"), ParseOptions.builder().tableFormat("gfm").ocr(false).build().wireOptions());
        assertTrue(ParseOptions.defaults().wireOptions().isEmpty(), "지정하지 않으면 키가 없다(엔진 기본값)");
        assertEquals("[1,3]", ParseOptions.builder().pages(List.of(1, 3)).build().wireOptions().get("pages").toString());
        assertEquals("force", ParseOptions.builder().ocrForce().build().wireOptions().get("ocr").asText());
        assertEquals(reqs.get(3).get("options"), ParseOptions.builder().ocr(true).ocrLinesAll().ocrDet("server").ocrDetLongSide(1920)
                .ocrRec(new OcrModelFile(Path.of("/abs/models/rec.onnx"), "a".repeat(64))).build().wireOptions());
        // 손글씨 rec 프리셋은 문자열 그대로(경로로 바꾸지 않는다)
        assertEquals(reqs.get(4).get("options"), ParseOptions.builder().ocr(true).ocrRec("handwriting").build().wireOptions());
    }

    @Test
    void ocrModelFilesBecomeAbsolutePaths() {
        String sha = "b".repeat(64);
        ObjectNode w = ParseOptions.builder().ocrDet(new OcrModelFile(Path.of("det.onnx"), sha))
                .ocrRecDict(new OcrModelFile(Path.of("/m/dict.yml"), sha)).ocrLines(true).build().wireOptions();
        assertEquals(Path.of("det.onnx").toAbsolutePath().toString(), w.get("ocrDet").get("path").asText());
        assertEquals(sha, w.get("ocrDet").get("sha256").asText());
        assertEquals("/m/dict.yml", w.get("ocrRecDict").get("path").asText());
        assertTrue(w.get("ocrLines").asBoolean());
        assertEquals("mobile", ParseOptions.builder().ocrDet("mobile").build().wireOptions().get("ocrDet").asText());
        assertThrows(NullPointerException.class, () -> new OcrModelFile(Path.of("/m/rec.onnx"), null));
    }

    @Test
    void allAllowlistOptionsHaveBuilders() {
        ObjectNode all = ParseOptions.builder().tableFormat("gfm").htmlTables(false).layoutTables("keep").classifyTables(true)
                .tables(false).plain(true).scriptTags(false).removeHeaderFooter(false).dedupeRunningHeaders(true)
                .keepTrailingEmptyCols(true).keepEmptyParagraphs(true).includeFieldPlaceholders(true).pages("1-2")
                .images(false).inlineImages(true).qrCodes(true).imageFormat("webp").ocr(true).formulaOcr(false).password("pw")
                .ocrLines(true).ocrDet("server").ocrDetLongSide(1920).ocrRec(new OcrModelFile(Path.of("/m/rec.onnx"), "a".repeat(64)))
                .ocrRecDict(new OcrModelFile(Path.of("/m/rec.yml"), "a".repeat(64))).build().wireOptions();
        assertEquals(25, all.size());
    }

    @Test
    void decodeResponsesKeepUnknownFields() throws IOException {
        JsonNode res = fixture().get("responses");
        ParseResult ok = new ParseResult((ObjectNode) res.get(0).get("result"), null);
        assertTrue(ok.success());
        assertEquals("# 제목", ok.markdown());
        assertTrue(ok.raw().get("futureField").get("kept").asBoolean());

        ParseResult failed = new ParseResult((ObjectNode) res.get(1).get("result"), null);
        assertFalse(failed.success());
        assertEquals("FILE_NOT_FOUND", failed.code().orElseThrow());
        KordocParseFailedException e = assertThrows(KordocParseFailedException.class, failed::throwIfFailed);
        assertEquals("FILE_NOT_FOUND", e.code());

        JsonNode files = res.get(2);
        ParseResult withFiles = new ParseResult((ObjectNode) files.get("result"), Path.of(files.get("assetsDir").asText()));
        Image img = withFiles.images().get(0);
        assertEquals("image_001.png", img.filename());
        assertEquals(14L, img.byteLength().orElseThrow());
        assertEquals(Path.of("/abs/assets/kordoc-3-AbC123/image_001.png"), img.path().orElseThrow());
        assertTrue(ok.ocrLines().isEmpty(), "옵션을 안 준 결과");
    }

    @Test
    void decodeOcrLinesTyped() throws IOException {
        ParseResult r = new ParseResult((ObjectNode) fixture().get("responses").get(5).get("result"), null);
        List<OcrPageLines> pages = r.ocrLines().orElseThrow();
        assertEquals(2, pages.size());
        assertEquals(new OcrPageLines(1, 1260, 390, 3, 0, false, List.of(
                new OcrPageLines.Line("대한민국 정부 2026", new OcrPageLines.Box(118, 105, 640, 60), 0.9987, false),
                new OcrPageLines.Line("잡음", new OcrPageLines.Box(900, 300, 40, 20), 0.31, true))), pages.get(0));
        OcrPageLines region = pages.get(1);
        assertTrue(region.regionsOnly());
        assertEquals(0.42, region.deskewAngle());
        assertEquals(new OcrPageLines.Box(200.5, 1000, 300, 40.5), region.lines().get(0).box());
        ObjectNode empty = Json.MAPPER.createObjectNode().put("success", true);
        empty.putArray("ocrLines");
        assertEquals(List.of(), new ParseResult(empty, null).ocrLines().orElseThrow());
    }
}
