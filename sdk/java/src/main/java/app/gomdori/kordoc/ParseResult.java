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

    /** 내장 OCR 이 읽은 쪽별 줄 ({@code ocrLines(true)}·{@code ocrLinesAll()} 일 때). 옵션을 안 줬거나 PDF·이미지가 아니면 empty, OCR 을 돌린 쪽이 없으면 빈 목록 */
    public Optional<List<OcrPageLines>> ocrLines() {
        JsonNode n = raw.get("ocrLines");
        if (n == null || !n.isArray()) return Optional.empty();
        List<OcrPageLines> out = new ArrayList<>();
        for (JsonNode p : n) out.add(OcrPageLines.fromJson(p));
        return Optional.of(List.copyOf(out));
    }

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

    /**
     * ocrLines 의 연장 — 줄마다 인식 모델의 읽기 후보(확률 내림차순, {@code ocrLineCandidates(n)}). {@code get(p).get(i)} 가
     * {@code ocrLines().get(p).lines().get(i)} 의 후보이고, 옵션을 안 줬거나 후보가 없는 줄은 빈 목록
     */
    public List<List<List<OcrLineCandidate>>> ocrLineCandidates() {
        List<List<List<OcrLineCandidate>>> pages = new ArrayList<>();
        for (JsonNode p : raw.path("ocrLines")) {
            List<List<OcrLineCandidate>> lines = new ArrayList<>();
            for (JsonNode l : p.path("lines")) {
                List<OcrLineCandidate> candidates = new ArrayList<>();
                for (JsonNode c : l.path("candidates")) candidates.add(new OcrLineCandidate(c.path("text").asText(), c.path("probability").asDouble()));
                lines.add(List.copyOf(candidates));
            }
            pages.add(List.copyOf(lines));
        }
        return List.copyOf(pages);
    }

    /**
     * ocrLines 의 연장 — 줄마다 글자별 신뢰도·상자({@code ocrChars(true)}·{@code ocrChars(n)}). {@code get(p).get(i)} 가
     * {@code ocrLines().get(p).lines().get(i)} 의 글자이고, 옵션을 안 줬거나 글자가 없는 줄(표기 후처리로 글이 바뀐 줄 등)은 빈 목록
     */
    public List<List<List<OcrChar>>> ocrChars() {
        List<List<List<OcrChar>>> pages = new ArrayList<>();
        for (JsonNode p : raw.path("ocrLines")) {
            List<List<OcrChar>> lines = new ArrayList<>();
            for (JsonNode l : p.path("lines")) {
                List<OcrChar> chars = new ArrayList<>();
                for (JsonNode c : l.path("chars")) {
                    List<OcrCharAlternative> alts = new ArrayList<>();
                    for (JsonNode a : c.path("alternatives")) alts.add(new OcrCharAlternative(a.path("text").asText(), a.path("confidence").asDouble()));
                    JsonNode b = c.path("box");
                    chars.add(new OcrChar(c.path("text").asText(), new OcrPageLines.Box(b.path("x").asDouble(), b.path("y").asDouble(), b.path("w").asDouble(), b.path("h").asDouble()),
                            c.path("confidence").asDouble(), List.copyOf(alts)));
                }
                lines.add(List.copyOf(chars));
            }
            pages.add(List.copyOf(lines));
        }
        return List.copyOf(pages);
    }

    /**
     * ocrLines 의 연장 — 페이지마다 행별 기울기 보정. {@code get(p)} 가 {@code ocrLines().get(p)} 의 보정이고,
     * 행마다 펴지 않은 페이지는 empty, ocrLines 가 없으면 빈 목록
     */
    public List<Optional<OcrDewarp>> ocrDewarp() {
        List<Optional<OcrDewarp>> pages = new ArrayList<>();
        for (JsonNode p : raw.path("ocrLines")) {
            JsonNode d = p.get("dewarp");
            if (d == null || d.isNull()) { pages.add(Optional.empty()); continue; }
            List<OcrDewarp.Knot> knots = new ArrayList<>();
            for (JsonNode k : d.path("knots")) knots.add(new OcrDewarp.Knot(k.path(0).asDouble(), k.path(1).asDouble()));
            pages.add(Optional.of(new OcrDewarp(d.path("cx").asDouble(), List.copyOf(knots))));
        }
        return List.copyOf(pages);
    }

    /** OCR 경로가 읽은 페이지 래스터 ({@code pageImages(true)}·{@code pageImages("webp")}, PDF·이미지 입력). 쪽 번호 순, 옵션을 안 줬으면 빈 목록 */
    public List<PageImage> pageImages() {
        List<PageImage> out = new ArrayList<>();
        for (JsonNode p : raw.path("pageImages")) out.add(new PageImage(p.path("pageNumber").asInt(), p.path("width").asInt(), p.path("height").asInt(), new Image(p, assetsDir)));
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
