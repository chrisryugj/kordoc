# Architecture Decisions

## 2026-04-08: PDF 파서 자체 개선 (pdfplumber 교체 아님)

**결정**: kordoc PDF 파서를 ODL 알고리즘 기반으로 업그레이드. pdfplumber 교체 안 함.

**근거**:
- pdfplumber(pdfminer.six)도 균등배분/CJK 공백 문제가 동일
- kordoc만 한국 공문서 특화 기능 보유 (균등배분 감지, 마커 헤딩, 특수 테이블)
- Node.js 단일 스택 유지
- Python 의존성 추가 불필요

**접근**:
- ODL의 Vertex 기반 동적 tolerance를 clean-room 재구현 (GPLv3 veraPDF 코드 직접 복사 안 함)
- pdfjs의 한계(TextItem 합치기)는 `normalizeItems`에서 균등배분 TextItem 분해로 우회
- 좌표 기반 처리를 주 경로로, 문자열 정규식은 안전망으로만

## 2026-04-08: 균등배분 처리 전략

**결정**: 3단계 파이프라인

1. `normalizeItems` → `splitEvenSpacedItem`: pdfjs가 합친 "홍 보 담 당 관" TextItem을 개별 글자로 분해
2. `mergeLineSimple`/`cellTextToString` → `detectEvenSpacedItems`: 좌표 기반으로 1자 한글 연속 구간 감지 후 합침
3. `cleanPdfText` → `collapseEvenSpacing`: 위 두 단계로 못 잡은 잔여분 문자열 후처리 (1자 기준 정규식)
