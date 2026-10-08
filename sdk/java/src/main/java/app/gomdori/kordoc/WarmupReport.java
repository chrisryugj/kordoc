package app.gomdori.kordoc;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** 워밍업 결과 — 워커마다 대표 문서를 실제로 파싱했는지. 경고(예: OCR 을 건너뛴 경고)는 OCR 준비 완료가 아니다. */
public record WarmupReport(List<Worker> workers) {
    /** 워커 하나의 워밍업 결과 */
    public record Worker(long pid, boolean success, JsonNode warnings, String error) {}

    /** 모든 워커에서 워밍업 문서를 파싱했는가 (경고 유무와 별개) */
    public boolean ok() {
        return workers.stream().allMatch(Worker::success);
    }
}
