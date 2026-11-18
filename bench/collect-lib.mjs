// 코퍼스 수집기 공용 검사 — collect-opengov·collect-korea-kr·collect-korea-kr-pairs

const OLE = Buffer.from("d0cf11e0a1b11ae1", "hex")

/**
 * 받은 첨부가 이름의 확장자와 맞는 실제 문서인지 파일 머리로 확인한다. 응답 200 이어도
 * 오류·로그인·차단 안내 HTML 이 올 수 있어, 그것을 .pdf/.hwp 이름으로 저장하지 않으려는 검사다.
 */
export function isDocBytes(buf, name) {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  const zip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  const ole = buf.subarray(0, 8).equals(OLE)
  switch (ext) {
    case "pdf": return buf.subarray(0, 1024).includes("%PDF-")
    case "hwp": return ole || buf.subarray(0, 17).toString("latin1") === "HWP Document File" // 5.x(OLE)·3.x
    case "hwpx": case "docx": case "xlsx": return zip
    case "xls": return ole
    case "hml": return buf.subarray(0, 1024).includes("<HWPML") || buf.subarray(0, 2048).includes(Buffer.from("<HWPML", "utf16le"))
    default: return false
  }
}

/**
 * Content-Disposition 의 파일 이름. % 인코딩이면 풀고, 헤더에 날 UTF-8 바이트로 온 이름
 * (fetch 가 한 바이트씩 latin1 글자로 읽는다)만 UTF-8 로 다시 읽는다. 이미 풀린 한글 이름을 다시 읽으면 깨진다.
 */
export function dispositionName(cd, fallback) {
  let name = cd.match(/filename=["']?([^"';]+)/)?.[1]
  if (!name) return fallback
  try { name = decodeURIComponent(name) } catch {} // 잘못된 % 시퀀스는 원문 유지
  if (/^[\x00-\xff]*$/.test(name) && /[\x80-\xff]/.test(name)) {
    const utf8 = Buffer.from(name, "latin1").toString("utf8")
    if (!utf8.includes("�")) name = utf8
  }
  return name
}
