package app.gomdori.kordoc;

/** 닫힌(또는 닫히는 중인) 클라이언트에 요청함. */
public class KordocClosedException extends KordocException {
    public KordocClosedException(String message) { super(message); }
    public KordocClosedException(String message, Throwable cause) { super(message, cause); }
}
