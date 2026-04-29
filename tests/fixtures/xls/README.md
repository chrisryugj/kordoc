# XLS 테스트 픽스처

> **목적**: BIFF8 (.xls) 파서 검증용 실제 공공기관 XLS 샘플 5건 수집.
> **상태**: ⚠️ 수동 다운로드 필요. 라이선스(공공누리) 확인 후 본 디렉토리에 배치.

---

## 1. 수집 대상 (다양성 확보)

각 카테고리 1건씩, 한국 공공기관 실제 산출물:

| # | 카테고리 | 검증 포인트 | 파일명 (제안) |
|---|----------|-------------|---------------|
| 1 | 인구통계 | 다중 시트 + 숫자 셀 + 한글 헤더 | `population.xls` |
| 2 | 예산서 | 병합 셀 + 음수 + 천단위 콤마 | `budget.xls` |
| 3 | 시설현황 | 다중 시트 + 빈 행/열 혼재 | `facilities.xls` |
| 4 | 인사명단 | 긴 SST (CONTINUE 분할 검증) | `roster.xls` |
| 5 | 회의록 | 텍스트 셀 + 머리글/바닥글 + 짧은 SST | `minutes.xls` |

---

## 2. 다운로드 출처 (공공누리 또는 CC 라이선스)

### 추천 소스
1. **공공데이터포털** — https://www.data.go.kr
   - "구형 XLS"로 검색 (필터: 파일포맷 = XLS)
   - 광역지자체·교육청 산출물 다수
2. **국가통계포털 KOSIS** — https://kosis.kr
   - 시계열 → "엑셀" 다운로드 시 일부 파일이 .xls
3. **각 부처 공고 첨부파일** — 2010년 이전 자료는 .xls 다수
4. **arXiv 또는 GitHub 검색** — `*.xls` (정부 공개 데이터)

### 다운로드 시 체크리스트
- [ ] 파일 크기 < 5MB (테스트 효율)
- [ ] 한글 셀 포함 (인코딩 검증)
- [ ] 병합 셀 1개 이상 포함
- [ ] 다중 시트 1건 이상
- [ ] 라이선스: 공공누리 1유형 또는 CC-BY 권장 (재배포 가능 라이선스)

---

## 3. 배치 규칙

```
tests/fixtures/xls/
├── README.md              ← 본 문서
├── population.xls         ← 다운로드 후 배치
├── budget.xls
├── facilities.xls
├── roster.xls
├── minutes.xls
├── source.json            ← 출처 메타 (필수)
└── expected/              ← 변환 결과 스냅샷 (W2 D3 작성)
    ├── population.md
    ├── budget.md
    └── ...
```

### `source.json` 예시
```json
{
  "samples": [
    {
      "file": "population.xls",
      "url": "https://www.data.go.kr/data/12345/fileData.do",
      "agency": "통계청",
      "license": "공공누리 제1유형",
      "downloaded_at": "2026-04-29",
      "checksum_sha256": "..."
    }
  ]
}
```

---

## 4. 합성 픽스처 (다운로드 실패 시 임시)

실제 샘플 확보 전, 단위 테스트용 미니멀 XLS 생성 가능:

```bash
# Python (xlwt 라이브러리, BIFF8 직접 출력)
pip install xlwt
python -c "
import xlwt
wb = xlwt.Workbook(encoding='utf-8')
ws = wb.add_sheet('테스트')
ws.write(0, 0, '항목')
ws.write(0, 1, '금액')
ws.write(1, 0, '예산')
ws.write(1, 1, 1000000)
wb.save('synthetic.xls')
"
```

또는 **LibreOffice headless**로 .xlsx → .xls 변환:
```bash
soffice --headless --convert-to xls existing.xlsx
```

⚠️ 합성 픽스처는 **단위 테스트용**. 실제 공공기관 XLS의 깨진 인코딩·기형 레코드는 실제 샘플로만 검증 가능.

---

## 5. 라이선스 표기

배포 가능 라이선스(공공누리 1·2유형, CC-BY)인 경우만 git에 포함. 그 외는 `.gitignore`에 추가하고 로컬 테스트로만 사용.

`.gitignore` 추가 예시:
```
tests/fixtures/xls/*.xls
!tests/fixtures/xls/synthetic*.xls
```

---

## 6. 다음 단계

1. 위 5개 카테고리 다운로드 → 본 디렉토리에 배치
2. `source.json` 메타 작성
3. ROADMAP.md `W1 D1-2` 항목 체크
4. `W1 D3`: `src/xls/record.ts` 구현 시작
