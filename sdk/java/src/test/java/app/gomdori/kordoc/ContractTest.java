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
    }

    @Test
    void allAllowlistOptionsHaveBuilders() {
        ObjectNode all = ParseOptions.builder().tableFormat("gfm").htmlTables(false).layoutTables("keep").classifyTables(true)
                .tables(false).plain(true).scriptTags(false).removeHeaderFooter(false).dedupeRunningHeaders(true)
                .keepTrailingEmptyCols(true).keepEmptyParagraphs(true).includeFieldPlaceholders(true).pages("1-2")
                .images(false).inlineImages(true).ocr(true).formulaOcr(false).password("pw").build().wireOptions();
        assertEquals(18, all.size());
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
    }
}
