/**
 * XLS 문자열 인코딩 디코더.
 *
 * BIFF8의 문자열은 다음 인코딩 중 하나:
 *   - UTF-16LE (fHighByte=1)
 *   - Compressed Unicode (fHighByte=0): 1바이트/문자, 상위 바이트는 0
 *   - 구형 Label 레코드: CodePage 의존 (보통 CP949 또는 CP1200)
 *
 * 한국 공문서 .xls 우선 순위: UTF-16LE → Compressed → CP949
 *
 * 참조: docs/biff8-spec.md §3.3, §5
 */

/**
 * UTF-16LE 디코딩 (Buffer.toString('utf16le')는 LE 가정으로 안전).
 */
export function decodeUtf16Le(buf: Buffer): string {
  return buf.toString("utf16le")
}

/**
 * Compressed Unicode 디코딩.
 * 1바이트당 1문자, 각 바이트가 UTF-16 코드 포인트의 하위 바이트(상위 바이트=0).
 * 즉 ISO-8859-1 (Latin-1)과 동일.
 */
export function decodeCompressed(buf: Buffer): string {
  // Buffer.toString('latin1') == ISO-8859-1
  return buf.toString("latin1")
}

/**
 * CP949 (EUC-KR 확장) 디코딩.
 * Node.js TextDecoder가 ICU 빌드일 때만 'euc-kr' 지원.
 * 미지원 환경에서는 latin1 폴백 (한글 깨짐, 영숫자만 보존).
 */
export function decodeCp949(buf: Buffer): string {
  try {
    // Node 18+ ICU 빌드: 'euc-kr', 'cp949' 모두 지원
    return new TextDecoder("euc-kr", { fatal: false }).decode(buf)
  } catch {
    return buf.toString("latin1")
  }
}

/**
 * 코드페이지 번호로 디코딩 (CodePage 레코드 0x0042 값).
 *   1200 = UTF-16LE
 *    949 = CP949
 *   1252 = Windows-1252
 *   기타 = latin1 폴백
 */
export function decodeByCodePage(buf: Buffer, codePage: number): string {
  if (codePage === 1200) return decodeUtf16Le(buf)
  if (codePage === 949) return decodeCp949(buf)
  if (codePage === 1252 || codePage === 65001) {
    try {
      return new TextDecoder(codePage === 65001 ? "utf-8" : "windows-1252", {
        fatal: false,
      }).decode(buf)
    } catch {
      return buf.toString("latin1")
    }
  }
  return buf.toString("latin1")
}
