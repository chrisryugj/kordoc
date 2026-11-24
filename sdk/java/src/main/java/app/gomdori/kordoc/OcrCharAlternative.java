package app.gomdori.kordoc;

/**
 * 글자 대안({@link OcrChar#alternatives()}).
 *
 * @param text 글자 하나
 * @param confidence 고른 글자의 {@code confidence} 와 같은 시점·같은 척도의 확률
 */
public record OcrCharAlternative(String text, double confidence) {}
