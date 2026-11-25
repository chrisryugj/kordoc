package app.gomdori.kordoc;

import java.util.List;

/**
 * OCR 줄의 글자 하나({@link ParseResult#ocrChars()}).
 *
 * @param text 글자 하나(코드 포인트 하나, 공백 포함)
 * @param box 글자 상자(래스터 px) — 세로는 줄 상자 그대로, 가로는 인식 시점으로 나눈 근사
 * @param confidence 이 글자를 고른 CTC 시점의 확률(0~1)
 * @param alternatives 같은 시점에서 다음으로 확률 높은 글자, 확률 내림차순({@code ocrChars(n)} 일 때, 없으면 빈 목록)
 */
public record OcrChar(String text, OcrPageLines.Box box, double confidence, List<OcrCharAlternative> alternatives) {}
