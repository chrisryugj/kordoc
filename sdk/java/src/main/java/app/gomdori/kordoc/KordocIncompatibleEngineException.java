package app.gomdori.kordoc;

/** 엔진이 parse-worker protocol 2 나 필요한 capability 를 지원하지 않음. */
public class KordocIncompatibleEngineException extends KordocStartException {
    public KordocIncompatibleEngineException(String message) { super(message); }
}
