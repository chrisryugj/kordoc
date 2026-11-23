package app.gomdori.kordoc;

/**
 * 엔진의 OCR 경로가 읽은 페이지 래스터({@link ParseResult#pageImages()}). {@link OcrPageLines} 좌표가 가리키는 이미지다.
 *
 * @param width 래스터 폭 (px)
 * @param height 래스터 높이 (px)
 * @param image 파일 이름·MIME·바이트 ({@link Image#read()})
 */
public record PageImage(int pageNumber, int width, int height, Image image) {}
