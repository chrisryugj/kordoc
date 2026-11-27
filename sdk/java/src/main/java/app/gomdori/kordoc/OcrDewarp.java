package app.gomdori.kordoc;

import java.util.List;

/**
 * 글줄 기울기가 위아래로 달라(휴대폰 사진의 원근 등) 행마다 세로로 밀어 편 페이지의 보정({@link ParseResult#ocrDewarp()}).
 * 좌표는 편 래스터 기준이고, 입력 좌표로는 {@code x₀ = x}, {@code y₀ = y + (x − cx)·tan θ(y)}.
 * 원근에 회전이 겹친 쪽은 {@link OcrPageLines#deskewAngle()} 도 0 이 아니다. 이 펴기를 먼저 되돌리고 회전을 나중에 되돌린다.
 *
 * @param cx 세로 밀기의 기준 x(래스터 px)
 * @param knots θ(y) 의 기준점, y 오름차순 — 기준점 사이는 직선으로 잇고 바깥은 끝 기준점 각
 */
public record OcrDewarp(double cx, List<Knot> knots) {
    /**
     * 기준점 하나.
     *
     * @param y 행 y(래스터 px)
     * @param angle 그 행의 글줄 기울기 θ(°, {@link OcrPageLines#deskewAngle()} 과 같은 뜻)
     */
    public record Knot(double y, double angle) {}
}
