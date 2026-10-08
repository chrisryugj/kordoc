package app.gomdori.kordoc;

/** 대기 큐가 가득 참 ({@link KordocConfig.Builder#maxQueue(int)}). */
public class KordocQueueFullException extends KordocException {
    public KordocQueueFullException(String message) { super(message); }
}
