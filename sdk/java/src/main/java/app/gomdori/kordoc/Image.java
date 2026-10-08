package app.gomdori.kordoc;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Optional;

/** 결과 이미지. 바이트는 {@link #read()} 를 부를 때만 해독(INLINE)하거나 파일에서 읽는다(FILES). */
public final class Image {
    private final String filename;
    private final String mimeType;
    private final String source;
    private final String base64;
    private final Path path;
    private final Long byteLength;

    Image(JsonNode raw, Path assetsDir) {
        this.filename = textOrNull(raw, "filename");
        this.mimeType = textOrNull(raw, "mimeType");
        this.source = textOrNull(raw, "source");
        JsonNode data = raw.get("data");
        this.base64 = data != null && data.isTextual() ? data.asText() : null;
        JsonNode ref = raw.get("dataRef");
        if (ref != null && assetsDir != null) {
            this.path = assetsDir.resolve(ref.path("path").asText());
            this.byteLength = ref.path("byteLength").asLong();
        } else {
            this.path = null;
            this.byteLength = null;
        }
    }

    /** Markdown 이 가리키는 이름 (예: image_001.png) */
    public String filename() { return filename; }

    public String mimeType() { return mimeType; }

    /** 원본 컨테이너 안 항목명 — 없을 수 있다 */
    public Optional<String> source() { return Optional.ofNullable(source); }

    /** FILES 전송의 파일 경로 */
    public Optional<Path> path() { return Optional.ofNullable(path); }

    public Optional<Long> byteLength() { return Optional.ofNullable(byteLength); }

    /** 이미지 바이트 */
    public byte[] read() {
        if (path != null) {
            try {
                return Files.readAllBytes(path);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
        if (base64 != null) return Base64.getDecoder().decode(base64);
        throw new IllegalStateException("이미지 바이트가 결과에 없습니다 (images(false))");
    }

    private static String textOrNull(JsonNode n, String key) {
        JsonNode v = n.get(key);
        return v == null || v.isNull() ? null : v.asText();
    }

    @Override
    public String toString() {
        return "Image{filename=" + filename + ", mimeType=" + mimeType + (path != null ? ", path=" + path : ", inline") + "}";
    }
}
