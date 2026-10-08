package app.gomdori.kordoc;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

/**
 * 요청 하나의 파싱 옵션·이미지 전송·제한 시간. 지정하지 않은 옵션은 엔진 기본값이고, {@code false} 는 실제로 false 를 넘긴다.
 *
 * <pre>{@code
 * ParseOptions.builder().tableFormat("gfm").ocr(false).build()
 * }</pre>
 */
public final class ParseOptions {
    /** 이미지 전송 — INLINE: 결과 JSON 에 base64, FILES: assetsDir 아래 요청별 디렉터리에 파일 */
    public enum ImageTransport { INLINE, FILES }

    private static final ParseOptions DEFAULTS = builder().build();

    final ObjectNode wire;
    final ImageTransport imageTransport;
    final Path assetsDir;
    final Duration timeout;
    final boolean timeoutSet;

    private ParseOptions(Builder b) {
        this.wire = b.wire.deepCopy();
        this.imageTransport = b.imageTransport;
        this.assetsDir = b.assetsDir;
        this.timeout = b.timeout;
        this.timeoutSet = b.timeoutSet;
    }

    public static ParseOptions defaults() { return DEFAULTS; }

    public static Builder builder() { return new Builder(); }

    /** wire options 사본 (camelCase) */
    public ObjectNode wireOptions() { return wire.deepCopy(); }

    public static final class Builder {
        private final ObjectNode wire = Json.MAPPER.createObjectNode();
        private ImageTransport imageTransport = ImageTransport.INLINE;
        private Path assetsDir;
        private Duration timeout;
        private boolean timeoutSet;

        private Builder() {}

        private Builder put(String key, boolean v) { wire.put(key, v); return this; }

        /** "gfm": 모든 표를 GFM 파이프 표로 — 중첩 표는 부모·자식 트리로 펼치고 관계 표지를 남긴다 */
        public Builder tableFormat(String format) { wire.put("tableFormat", format); return this; }
        public Builder htmlTables(boolean v) { return put("htmlTables", v); }
        /** "visual"(기본) | "keep" */
        public Builder layoutTables(String mode) { wire.put("layoutTables", mode); return this; }
        public Builder classifyTables(boolean v) { return put("classifyTables", v); }
        public Builder tables(boolean v) { return put("tables", v); }
        public Builder plain(boolean v) { return put("plain", v); }
        public Builder scriptTags(boolean v) { return put("scriptTags", v); }
        public Builder removeHeaderFooter(boolean v) { return put("removeHeaderFooter", v); }
        public Builder dedupeRunningHeaders(boolean v) { return put("dedupeRunningHeaders", v); }
        public Builder keepTrailingEmptyCols(boolean v) { return put("keepTrailingEmptyCols", v); }
        public Builder keepEmptyParagraphs(boolean v) { return put("keepEmptyParagraphs", v); }
        public Builder includeFieldPlaceholders(boolean v) { return put("includeFieldPlaceholders", v); }
        /** 쪽 범위 "1-3,5" */
        public Builder pages(String range) { wire.put("pages", range); return this; }
        /** 쪽 번호 목록 (1부터) */
        public Builder pages(List<Integer> pages) {
            ArrayNode arr = wire.putArray("pages");
            pages.forEach(arr::add);
            return this;
        }
        /** false 면 이미지 바이트 추출을 생략한다 (전송 방식과 별개) */
        public Builder images(boolean v) { return put("images", v); }
        public Builder inlineImages(boolean v) { return put("inlineImages", v); }
        /** true: 필요한 쪽만 OCR, false: 끔 */
        public Builder ocr(boolean v) { return put("ocr", v); }
        /** 전 쪽 강제 OCR */
        public Builder ocrForce() { wire.put("ocr", "force"); return this; }
        public Builder formulaOcr(boolean v) { return put("formulaOcr", v); }
        public Builder password(String v) { wire.put("password", v); return this; }

        /** 이미지를 결과 JSON 에 base64 로 싣는다(기본) */
        public Builder inlineImageTransport() {
            this.imageTransport = ImageTransport.INLINE;
            this.assetsDir = null;
            return this;
        }

        /** 이미지를 assetsDir(있는 디렉터리) 아래 요청별 디렉터리에 파일로 받는다. 파일은 호출자 소유로 close 뒤에도 남는다 */
        public Builder fileImageTransport(Path assetsDir) {
            this.imageTransport = ImageTransport.FILES;
            this.assetsDir = assetsDir.toAbsolutePath();
            return this;
        }

        /** 이 요청의 제한 시간(대기 포함). null 이면 무제한. 지정하지 않으면 클라이언트 기본값 */
        public Builder timeout(Duration d) {
            this.timeout = d;
            this.timeoutSet = true;
            return this;
        }

        public ParseOptions build() { return new ParseOptions(this); }
    }
}
