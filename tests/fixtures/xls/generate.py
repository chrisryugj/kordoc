"""
BIFF8 (.xls) 테스트 픽스처 생성기.

xlwt 라이브러리로 5건의 다양한 패턴 합성 픽스처를 만든다.
실제 공공기관 XLS 샘플 확보 전 단위/통합 테스트용.

실행:
    python -m pip install xlwt
    python tests/fixtures/xls/generate.py
"""

from __future__ import annotations
import os
import xlwt


HERE = os.path.dirname(os.path.abspath(__file__))


def make_population() -> str:
    """1) 인구통계 — 다중 시트 + 숫자 셀 + 한글 헤더."""
    wb = xlwt.Workbook(encoding="utf-8")

    ws1 = wb.add_sheet("2024년")
    headers = ["지역", "총인구", "남자", "여자", "세대수"]
    for c, h in enumerate(headers):
        ws1.write(0, c, h)
    rows = [
        ("서울특별시", 9586195, 4673933, 4912262, 4318770),
        ("부산광역시", 3293362, 1607928, 1685434, 1462384),
        ("대구광역시", 2374960, 1167082, 1207878, 1042362),
        ("인천광역시", 2967314, 1487390, 1479924, 1273821),
        ("광주광역시", 1430761, 707432, 723329, 627180),
    ]
    for r, row in enumerate(rows, start=1):
        for c, v in enumerate(row):
            ws1.write(r, c, v)

    ws2 = wb.add_sheet("2023년")
    for c, h in enumerate(headers):
        ws2.write(0, c, h)
    for r, row in enumerate(rows, start=1):
        # 2023년은 약 0.5% 적게
        adjusted = (row[0],) + tuple(int(v * 0.995) for v in row[1:])
        for c, v in enumerate(adjusted):
            ws2.write(r, c, v)

    path = os.path.join(HERE, "population.xls")
    wb.save(path)
    return path


def make_budget() -> str:
    """2) 예산서 — 병합 셀 + 음수 + 큰 숫자."""
    wb = xlwt.Workbook(encoding="utf-8")
    ws = wb.add_sheet("2025년 예산")

    # 머리글 병합 (0,0)~(0,3)
    ws.write_merge(0, 0, 0, 3, "2025년도 부서별 예산 편성")

    headers = ["부서", "본예산", "추경", "집행률(%)"]
    for c, h in enumerate(headers):
        ws.write(1, c, h)

    rows = [
        ("기획조정실", 12500000000, 500000000, 87.3),
        ("재정담당관", 8300000000, -200000000, 92.1),
        ("총무과", 5400000000, 0, 78.5),
        ("정보통신과", 9800000000, 1200000000, 65.2),
        ("감사담당관", 2100000000, -50000000, 95.8),
    ]
    for r, row in enumerate(rows, start=2):
        for c, v in enumerate(row):
            ws.write(r, c, v)

    # 합계 행 — 부서 셀 병합 안 하고 그냥 텍스트
    ws.write(7, 0, "합계")
    ws.write(7, 1, sum(r[1] for r in rows))
    ws.write(7, 2, sum(r[2] for r in rows))
    ws.write(7, 3, "")

    path = os.path.join(HERE, "budget.xls")
    wb.save(path)
    return path


def make_facilities() -> str:
    """3) 시설현황 — 다중 시트 + 빈 행/열 혼재."""
    wb = xlwt.Workbook(encoding="utf-8")

    for sheet_name in ["체육시설", "문화시설", "복지시설"]:
        ws = wb.add_sheet(sheet_name)
        ws.write(0, 0, "시설명")
        ws.write(0, 2, "주소")  # col 1 빈 칸
        ws.write(0, 3, "면적(㎡)")

        if sheet_name == "체육시설":
            data = [
                ("종합운동장", None, "서울시 송파구", 12500),
                ("실내수영장", None, "서울시 강남구", 3800),
                ("", None, "", None),  # 빈 행
                ("축구장", None, "서울시 마포구", 7200),
            ]
        elif sheet_name == "문화시설":
            data = [
                ("시립도서관", None, "서울시 종로구", 4500),
                ("미술관", None, "서울시 용산구", 2300),
            ]
        else:
            data = [
                ("노인복지관", None, "서울시 노원구", 1800),
                ("어린이집", None, "서울시 은평구", 950),
                ("장애인복지관", None, "서울시 성북구", 2100),
            ]

        for r, row in enumerate(data, start=1):
            for c, v in enumerate(row):
                if v is None or v == "":
                    continue
                ws.write(r, c, v)

    path = os.path.join(HERE, "facilities.xls")
    wb.save(path)
    return path


def make_roster() -> str:
    """4) 인사명단 — 긴 SST (CONTINUE 분할 검증용 100+ 레코드)."""
    wb = xlwt.Workbook(encoding="utf-8")
    ws = wb.add_sheet("직원명부")

    headers = ["사번", "성명", "부서", "직급", "비고"]
    for c, h in enumerate(headers):
        ws.write(0, c, h)

    surnames = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임"]
    given = ["민준", "서연", "지호", "예원", "도윤", "하은", "시우", "수아", "주원", "지유"]
    depts = ["기획조정실", "정보통신과", "총무과", "재정담당관실", "감사담당관실", "민원봉사과"]
    ranks = ["사무관", "주무관", "주사", "주사보", "서기", "서기보"]

    # CONTINUE 분할 강제용 — 200명, 비고 컬럼은 긴 텍스트
    note_template = (
        "본 직원은 정기인사이동 대상으로 분류되어 있으며 후속 절차에 따라 "
        "관련 부서와의 협의를 거쳐 최종 보직이 결정될 예정입니다."
    )

    for i in range(1, 201):
        sabun = f"2025{i:04d}"
        name = surnames[i % 10] + given[(i * 3) % 10]
        dept = depts[i % 6]
        rank = ranks[i % 6]
        note = f"{note_template} (관리번호: {sabun}-{i*7%9999:04d})"
        ws.write(i, 0, sabun)
        ws.write(i, 1, name)
        ws.write(i, 2, dept)
        ws.write(i, 3, rank)
        ws.write(i, 4, note)

    path = os.path.join(HERE, "roster.xls")
    wb.save(path)
    return path


def make_minutes() -> str:
    """5) 회의록 — 텍스트 셀 + 짧은 SST + 단일 시트."""
    wb = xlwt.Workbook(encoding="utf-8")
    ws = wb.add_sheet("회의록")

    ws.write(0, 0, "항목")
    ws.write(0, 1, "내용")

    items = [
        ("회의일시", "2025년 4월 29일(화) 14:00 ~ 16:00"),
        ("장소", "본관 3층 대회의실"),
        ("주재", "기획조정실장"),
        ("참석", "기획팀장 외 8명"),
        ("안건1", "2025년도 하반기 사업계획 검토"),
        ("결정사항1", "예산 재배분 후 5월 15일까지 최종안 제출"),
        ("안건2", "정보보호 강화 방안"),
        ("결정사항2", "전 부서 보안 점검 6월 중 실시"),
        ("기타", "다음 회의 5월 13일 동일 시간"),
    ]
    for r, (k, v) in enumerate(items, start=1):
        ws.write(r, 0, k)
        ws.write(r, 1, v)

    path = os.path.join(HERE, "minutes.xls")
    wb.save(path)
    return path


def main() -> None:
    paths = [
        make_population(),
        make_budget(),
        make_facilities(),
        make_roster(),
        make_minutes(),
    ]
    for p in paths:
        size = os.path.getsize(p)
        print(f"[OK] {os.path.basename(p)} ({size:,} bytes)")


if __name__ == "__main__":
    main()
