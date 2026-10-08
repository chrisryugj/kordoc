package app.gomdori.kordoc;

/** {@link ParseResult#throwIfFailed()} — 문서를 파싱하지 못함. */
public class KordocParseFailedException extends KordocException {
    private final String code;

    public KordocParseFailedException(String code, String message) {
        super(code == null ? message : code + ": " + message);
        this.code = code;
    }

    /** 엔진 오류 code (예: FILE_NOT_FOUND, ENCRYPTED). 없을 수 있다 */
    public String code() { return code; }
}
