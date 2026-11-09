//! hayro(Rust PDF 해석기)로 kordoc 이 쓰는 PDF 재료를 낸다 — 쪽 사건열(글자·경로·클립·그림·구조), 글꼴·그림 화소, 쪽 렌더,
//! 쪽 상자·회전, 정보 사전, 링크 주석. src/pdf/hayro.ts 가 이 wasm 을 부른다.
//!
//! 인스턴스 하나가 문서 하나를 연다(JS 가 문서마다 인스턴스를 만든다). 결과는 두 버퍼에 담는다: F64(수 배열)·BYTES(바이트·UTF-8 글).
//! JS 는 f64_ptr·f64_len·bytes_ptr·bytes_len 으로 읽는다. 오류는 음수를 돌려주고 BYTES 에 문구를 담는다.
mod doc;
mod shadow;

use doc::Doc;

static mut DOC: Option<Doc> = None;
static mut F64: Vec<f64> = Vec::new();
static mut BYTES: Vec<u8> = Vec::new();

#[allow(static_mut_refs)]
fn state() -> (&'static mut Option<Doc>, &'static mut Vec<f64>, &'static mut Vec<u8>) {
    // 단일 스레드 wasm — 한 번에 한 호출만 돈다
    unsafe { (&mut *std::ptr::addr_of_mut!(DOC), &mut *std::ptr::addr_of_mut!(F64), &mut *std::ptr::addr_of_mut!(BYTES)) }
}

fn put_bytes(v: Vec<u8>) -> i32 { let (_, _, b) = state(); *b = v; b.len() as i32 }
fn put_f64(v: Vec<f64>) -> i32 { let (_, f, _) = state(); *f = v; f.len() as i32 }
fn doc() -> Option<&'static mut Doc> { state().0.as_mut() }
unsafe fn arg(p: *const u8, len: usize) -> &'static str { std::str::from_utf8(std::slice::from_raw_parts(p, len)).unwrap_or("") }

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, len: usize) { drop(Vec::from_raw_parts(p, 0, len)) }

#[no_mangle]
pub extern "C" fn f64_ptr() -> *const f64 { state().1.as_ptr() }
#[no_mangle]
pub extern "C" fn bytes_ptr() -> *const u8 { state().2.as_ptr() }
#[no_mangle]
pub extern "C" fn f64_len() -> usize { state().1.len() }
#[no_mangle]
pub extern "C" fn bytes_len() -> usize { state().2.len() }

/// 입력 바이트(alloc 으로 받은 자리, 소유권을 넘긴다)로 문서를 연다 — 0 성공, 1 읽을 수 없음, 2 암호 필요, 3 그 밖의 암호화 오류
#[no_mangle]
pub unsafe extern "C" fn open(p: *mut u8, len: usize) -> i32 {
    let data = Vec::from_raw_parts(p, len, len);
    match Doc::new(data) {
        Ok(d) => { *state().0 = Some(d); 0 }
        Err(hayro_syntax::LoadPdfError::Invalid) => 1,
        Err(hayro_syntax::LoadPdfError::Decryption(hayro_syntax::DecryptionError::PasswordProtected)) => 2,
        Err(_) => 3,
    }
}

#[no_mangle]
pub extern "C" fn page_count() -> i32 { doc().map(|d| d.page_count() as i32).unwrap_or(0) }

/// 쪽(0부터) 사건열 → F64, 문자열 표(\u{1} 구분) → BYTES. 콜백과 사전 해석이 어긋나면 −1(BYTES 에 문구)
#[no_mangle]
pub extern "C" fn events(index: usize) -> i32 {
    let Some(d) = doc() else { return 0 };
    match d.events(index) {
        Ok(ev) => { let s = d.strings().as_bytes().to_vec(); put_bytes(s); put_f64(ev) }
        Err(e) => { put_bytes(e.into_bytes()); -1 }
    }
}

/// 쪽 보기 상자 [x0,y0,x1,y1] → F64
#[no_mangle]
pub extern "C" fn page_view(index: usize) -> i32 { let v = doc().map(|d| d.page_view(index)).unwrap_or_default(); put_f64(v) }
/// 쪽 회전(도)
#[no_mangle]
pub extern "C" fn page_rotate(index: usize) -> i32 { doc().map(|d| d.page_rotate(index)).unwrap_or(0) }
/// 렌더 크기 [가로, 세로](pt, 회전·CropBox 반영) → F64
#[no_mangle]
pub extern "C" fn page_size(index: usize) -> i32 { let v = doc().map(|d| d.page_size(index).into_iter().map(f64::from).collect()).unwrap_or_default(); put_f64(v) }
/// 쪽을 배율 scale 로 흰 바탕에 그린 RGBA → BYTES, [가로, 세로] → F64
#[no_mangle]
pub extern "C" fn render(index: usize, scale: f32) -> i32 {
    let Some(d) = doc() else { return 0 };
    let rgba = d.render(index, scale);
    let (w, h) = d.rendered_size();
    put_f64(vec![w as f64, h as f64]);
    put_bytes(rgba)
}
/// 글꼴 열쇠의 정보 JSON → BYTES
#[no_mangle]
pub unsafe extern "C" fn font_info(p: *const u8, len: usize) -> i32 { let v = doc().map(|d| d.font_info(arg(p, len)).into_bytes()).unwrap_or_default(); put_bytes(v) }
/// 글꼴 열쇠의 TrueType 글꼴 파일 → BYTES
#[no_mangle]
pub unsafe extern "C" fn font_file(p: *const u8, len: usize) -> i32 { let v = doc().map(|d| d.font_file(arg(p, len))).unwrap_or_default(); put_bytes(v) }
/// 그림 [가로, 세로, kind] → F64, 화소 → BYTES (못 그린 그림은 0)
#[no_mangle]
pub unsafe extern "C" fn image(p: *const u8, len: usize) -> i32 {
    let Some(d) = doc() else { return 0 };
    match d.image(arg(p, len)) {
        Some((w, h, kind, data)) => { put_bytes(data); put_f64(vec![w as f64, h as f64, kind as f64]) }
        None => put_f64(Vec::new()),
    }
}
/// 문서 정보 사전 JSON → BYTES
#[no_mangle]
pub extern "C" fn info() -> i32 { let v = doc().map(|d| d.info().into_bytes()).unwrap_or_default(); put_bytes(v) }
/// 쪽 링크 주석 JSON → BYTES
#[no_mangle]
pub extern "C" fn links(index: usize) -> i32 { let v = doc().map(|d| d.links(index).into_bytes()).unwrap_or_default(); put_bytes(v) }
