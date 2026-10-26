/** 지역기관의 공개 문서에서 확인한 서식 후보. 생성 데이터와 분리해 재생성 시 보존한다. */
import type { AgencyStyle } from "./agency-styles.js"

/** 근거와 선택 이유: docs/gwangyang-agency.md. 공식 지정 서식이 아닌 보고서 기본값 후보. */
export const LOCAL_AGENCY_STYLES: Record<string, AgencyStyle> = {
  "광양시": {
    report: {
      // 정확한 HWPX 스타일을 확인한 문서 수. PDF 조사 91건을 실측 HWPX 수로 세지 않는다.
      docs: 1,
      levels: [
        { font: "HY헤드라인M", pt: 16 },
        { font: "휴먼명조", pt: 15 },
        { font: "휴먼명조", pt: 15 },
      ],
      note: { font: "한양중고딕", pt: 13 },
      ref: { font: "한양중고딕", pt: 13 },
      p: { font: "휴먼명조", pt: 15 },
      bullet2: "○",
      table: { font: "한양중고딕", pt: 13, fill: "#DFE6F7" },
    },
    // 보도자료 표본은 조사하지 않았다. 공통값 사용 시 경고한다.
    press: null,
    // 원문에서 반복 관찰한 파랑 계열을 기존 장 띠에 적용하는 선택값(색 실측 최빈값 아님).
    band: { fill: "#245A81", text: "#FFFFFF" },
  },
}
