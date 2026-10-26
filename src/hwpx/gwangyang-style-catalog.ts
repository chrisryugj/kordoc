/** 사용자 확정 광양시 기관 스타일: 1안 11종 + 2안 3종. variants도 개별 에셋으로 센다. */
export const GWANGYANG_STYLE_ASSETS = [
  {
    "id": "gy1-title",
    "name": "사선 파란 띠 대제목",
    "reportFrame": "gwangyang-1",
    "input": "# 제목"
  },
  {
    "id": "gy1-chapter",
    "name": "네이비 번호칸 소제목",
    "reportFrame": "gwangyang-1",
    "input": "## 소제목"
  },
  {
    "id": "gy1-attachment",
    "name": "붙임 머리표",
    "reportFrame": "gwangyang-1",
    "input": "attachment"
  },
  {
    "id": "gy1-box-white",
    "name": "흰 설명상자",
    "reportFrame": "gwangyang-1",
    "input": "box:white"
  },
  {
    "id": "gy1-box-purple",
    "name": "보라 설명상자",
    "reportFrame": "gwangyang-1",
    "input": "box:purple"
  },
  {
    "id": "gy1-table-title",
    "name": "밑줄 표 제목",
    "reportFrame": "gwangyang-1",
    "input": "table-title"
  },
  {
    "id": "gy1-table",
    "name": "열린 외곽·점선 본문표",
    "reportFrame": "gwangyang-1",
    "input": "table"
  },
  {
    "id": "gy1-staff-header",
    "name": "담당자 머리표",
    "reportFrame": "gwangyang-1",
    "input": "staff-header"
  },
  {
    "id": "gy1-cover",
    "name": "기관 표지",
    "reportFrame": "gwangyang-1",
    "input": "institution-cover"
  },
  {
    "id": "gy1-rounded-plain",
    "name": "일반 둥근 상자",
    "reportFrame": "gwangyang-1",
    "input": "rounded-box:plain"
  },
  {
    "id": "gy1-rounded-tab",
    "name": "제목 탭 둥근 상자",
    "reportFrame": "gwangyang-1",
    "input": "rounded-box:tab"
  },
  {
    "id": "gy2-title",
    "name": "네이비·터콰이즈·라임 제목 띠",
    "reportFrame": "gwangyang-2",
    "input": "# 제목"
  },
  {
    "id": "gy2-chapter",
    "name": "윤곽 번호칸 소제목",
    "reportFrame": "gwangyang-2",
    "input": "## 소제목"
  },
  {
    "id": "gy2-table",
    "name": "닫힌 외곽·실선 본문표",
    "reportFrame": "gwangyang-2",
    "input": "table"
  }
] as const

export type GwangyangStyleAssetId = typeof GWANGYANG_STYLE_ASSETS[number]["id"]
