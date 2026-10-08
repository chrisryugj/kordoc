package app.gomdori.kordoc;

/** Node·kordoc 엔진을 찾지 못했거나 워커가 시작 제한 시간 안에 ready 를 보내지 않음. */
public class KordocStartException extends KordocException {
    public KordocStartException(String message) { super(message); }
    public KordocStartException(String message, Throwable cause) { super(message, cause); }
}
