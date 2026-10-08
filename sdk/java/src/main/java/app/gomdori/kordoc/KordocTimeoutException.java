package app.gomdori.kordoc;

/** 요청 제한 시간 초과 — 대기 큐 입장부터 결과 수신까지. 실행 중이었다면 담당 워커를 종료했다. */
public class KordocTimeoutException extends KordocException {
    public KordocTimeoutException(String message) { super(message); }
}
