# 암호 문서 테스트 픽스처 (#59)

셋 다 rhwp(<https://github.com/edwardkim/rhwp>, MIT) `samples/` 에서 가져왔다.
저작권은 rhwp 저작자에게 있으며, 저장소 루트 `NOTICE` 의 rhwp 항목에 고지돼 있다.

| 파일 | 용도 |
|---|---|
| `HWP3-password-123456.hwp` | HWP3 DES-ECB 복호 |
| `HWP5-password-123456.hwpx` | HWPX ODF(AES-256-CBC + PBKDF2) 복호 |
| `HWP5-nopassword-123456.hwpx` | 위 파일의 평문 대조본 — 복호 결과가 원문과 같은지 확인 |

**열기 암호는 셋 다 `123456`.** 파일명의 숫자가 그 뜻이다.

HWP5(CFB 컨테이너) 암호 문서는 2.9MB라 저장소에 넣지 않았다. rhwp 저장소가 로컬에 있으면
`KORDOC_PW_FIXTURES=~/workspace/rhwp/samples` 로 경로를 지정해 함께 검증할 수 있고,
없으면 해당 케이스만 건너뛴다(`tests/password.test.ts`).
