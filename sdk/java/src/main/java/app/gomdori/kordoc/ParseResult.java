package app.gomdori.kordoc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/** 엔진 {@code parse()} 결과. {@link #raw()} 는 워커가 보낸 JSON 원본(알 수 없는 필드 포함)이다. */
public final class ParseResult {
    private final ObjectNode raw;
    private final Path assetsDir;

    ParseResult(ObjectNode raw, Path assetsDir) {
        this.raw = raw;
        this.assetsDir = assetsDir;
    }

    /** 결과 JSON 원본 */
    public ObjectNode raw() { return raw; }

    public boolean success() { return raw.path("success").asBoolean(false); }

    public String fileType() { return raw.path("fileType").asText("unknown"); }

    public String markdown() { return raw.path("markdown").asText(""); }

    /** IR 블록 배열 (JSON 그대로) */
    public JsonNode blocks() { return raw.path("blocks"); }

    /** 쪽별 Markdown 배열 — 없으면 MissingNode */
    public JsonNode pages() { return raw.path("pages"); }

    public JsonNode metadata() { return raw.path("metadata"); }

    /** 엔진 경고 배열 — 알 수 없는 code 도 그대로 */
    public JsonNode warnings() { return raw.path("warnings"); }

    public Optional<String> error() { return text("error"); }

    public Optional<String> code() { return text("code"); }

    /** transport FILES 에서 이 요청의 자산 디렉터리 */
    public Optional<Path> assetsDir() { return Optional.ofNullable(assetsDir); }

    public List<Image> images() {
        List<Image> out = new ArrayList<>();
        for (JsonNode img : raw.path("images")) out.add(new Image(img, assetsDir));
        return out;
    }

    /** 파싱 실패면 {@link KordocParseFailedException}. 성공이면 자기 자신 */
    public ParseResult throwIfFailed() {
        if (!success()) throw new KordocParseFailedException(code().orElse(null), error().orElse("파싱 실패"));
        return this;
    }

    private Optional<String> text(String key) {
        JsonNode n = raw.get(key);
        return n == null || n.isNull() ? Optional.empty() : Optional.of(n.asText());
    }
}
