package app.gomdori.kordoc;

/** 워커가 요청을 거부함(예: {@code INVALID_OPTIONS}). 워커는 계속 쓸 수 있다. */
public class KordocProtocolException extends KordocException {
    private final String code;

    public KordocProtocolException(String code, String message) {
        super(code + ": " + message);
        this.code = code;
    }

    /** 워커 오류 code (docs/parse-worker-protocol.md). 알 수 없는 code 도 그대로 둔다 */
    public String code() { return code; }
}
