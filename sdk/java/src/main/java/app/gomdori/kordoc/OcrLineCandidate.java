package app.gomdori.kordoc;

/**
 * OCR 줄의 읽기 후보 하나({@link ParseResult#ocrLineCandidates()}).
 *
 * @param text 표기 후처리 전의 인식 결과
 * @param probability 그 읽기의 확률(모든 정렬의 합, 0~1) — 같은 줄의 후보끼리 견줄 수 있다. 줄의 {@code confidence}(가장 유력한 정렬에서 글자별 최고 확률의 평균)와는 다른 척도
 */
public record OcrLineCandidate(String text, double probability) {}
