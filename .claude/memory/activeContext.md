# Active Context — kordoc 본체

**마지막 업데이트**: 2026-04-29
**상위 마스터**: [d:/AI_Project/kordoc-ai/.claude/memory/activeContext.md](../../../kordoc-ai/.claude/memory/activeContext.md)

---

## 현재 상태 — KorDoc Suite Phase 1 완료, Phase 2 진행

### ✅ Phase 1 완료 (kordoc v2.7.0, 커밋 `f41da76`)
- 브랜치: `feat/xls-and-print` (push 완료)
- XLS (BIFF8) 파서: `src/xls/{record,encoding,sst,cell,parser,index}.ts`
- Print Renderer: `src/print/{renderer,index}.ts` (markdown-it → puppeteer-core)
- 합성 픽스처 5건: `tests/fixtures/xls/{population,budget,facilities,roster,minutes}.xls`
- 명세 문서: `docs/biff8-spec.md`
- 318 tests pass (기존 296 + XLS 12 + Print 10)
- `package.json` v2.7.0, `CHANGELOG.md` 갱신

### 📋 npm publish 대기 (사용자 승인 필요)
```bash
cd d:/AI_Project/kordoc
npm publish  # 2.7.0 배포
```

또는 PR 생성 후 main 머지: https://github.com/chrisryugj/kordoc/pull/new/feat/xls-and-print

---

## 이전 PDF 작업 컨텍스트 (유지 — Phase 4 또는 별도 작업 시 참조)

PDF 파서 ODL 기반 업그레이드 Phase 1+2 완료, Phase 3(공백누락/목차감지/ClusterTableConsumer) 대기.
관련 파일: `src/pdf/{line-detector,parser,cluster-detector}.ts`.
테스트 PDF: 서울시메신저 20260408 중동 비상경제대책단 회의 PDF.

---

## 핵심 파일 (XLS + Print 신규)

| 파일 | 역할 |
|------|------|
| `src/xls/record.ts` | BIFF 레코드 리더, RK/MulRk 디코더 |
| `src/xls/sst.ts` | Shared String Table + CONTINUE 분할 처리 |
| `src/xls/encoding.ts` | UTF-16LE/Compressed/CP949 |
| `src/xls/cell.ts` | 셀 레코드 → RawCell |
| `src/xls/parser.ts` | Globals/Worksheet 워크플로우, IRBlock 변환 |
| `src/print/renderer.ts` | markdownToPdf, blocksToPdf, 프리셋 3종 |

## 통합 지점
- `src/types.ts:FileType` 'xls' 추가
- `src/detect.ts:detectOle2Format()` — cfb-lenient로 OLE2 컨테이너 까서 Workbook/FileHeader 분기
- `src/index.ts:parseXls()` 공개 API + `parse()` 자동 라우팅
