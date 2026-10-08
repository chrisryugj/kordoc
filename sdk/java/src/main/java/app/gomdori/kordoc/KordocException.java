package app.gomdori.kordoc;

/** kordoc SDK 예외의 기반 클래스. 문서 파싱 실패는 예외가 아니라 {@link ParseResult#success()} false 다. */
public class KordocException extends RuntimeException {
    public KordocException(String message) { super(message); }
    public KordocException(String message, Throwable cause) { super(message, cause); }
}
