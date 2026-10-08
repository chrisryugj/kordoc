package app.gomdori.kordoc;

/** 요청 처리 중 워커가 끝났거나 응답이 깨짐. 그 워커는 버리고 다음 요청은 새 워커가 받는다. */
public class KordocWorkerCrashedException extends KordocException {
    private final String stderrTail;

    public KordocWorkerCrashedException(String message, String stderrTail) {
        super(stderrTail == null || stderrTail.isEmpty() ? message : message + "\n--- worker stderr (tail) ---\n" + stderrTail);
        this.stderrTail = stderrTail == null ? "" : stderrTail;
    }

    public String stderrTail() { return stderrTail; }
}
