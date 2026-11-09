//! quick-xml 로 XML 을 읽어 평탄한 트리로 낸다 (src/xml/dom.ts 가 DOM 으로 짓는다).
//! ops(u32): 0 열기(이름, 속성 수, (키, 값)*) · 1 닫기 · 2 글 · 3 CDATA · 4 주석 · 5 처리 명령(대상, 데이터) · 6 복구 기록(수준 1 경고·2 오류, 건수, 첫 문구).
//! 문자열은 u32 두 개(시작, 길이 — UTF-16 단위)다. 길이의 맨 위 비트가 0 이면 입력 원문의 구간(JS 가 원문 문자열을 잘라 쓴다 —
//! 복사하지 않는다), 1 이면 바꾼 문자열 버퍼(STRS)의 구간이다(엔티티를 푼 글·정규화한 속성 값·복구 문구).
//! 엄격 모드(flags 에 2 가 없다): 0 성공, 그 밖은 거절 — 호출자가 복구 모드로 다시 읽는다. 잘 짜인 문서만 받는다:
//! 1 구문 · 2 DOCTYPE · 3 중복 속성 · 4 닫는 태그 불일치 · 5 모르는 엔티티 · 6 UTF-8 아님 · 7 속성 구문(따옴표 없는 값·값 없는 속성) ·
//! 8 닫히지 않고 끝남 · 9 루트 밖 글 · 10 루트 둘 이상 · 11 그 밖 · 12 속성 값 안의 '<' · 13 XML 선언이 맨 앞이 아님 ·
//! 14 XML 선언 문법 · 15 처리 명령 문법 · 16 이름(QName) 문법 · 17 속성 사이 공백 없음 · 18 주석 문법
//! 복구 모드(flags 2): 거절하지 않는다. 깨진 곳은 고쳐 읽고 op 6 으로 알린다 — 규칙은 run·settle·start·fix_eq·end_tag·lt_in_tag·bounded_tag·resync 주석
use quick_xml::errors::{Error, IllFormedError, SyntaxError};
use quick_xml::escape::{resolve_predefined_entity, unescape};
use quick_xml::events::attributes::AttrError;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

static mut OPS: Vec<u32> = Vec::new();
static mut STRS: String = String::new();

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(p, 0, len));
}

#[no_mangle]
pub unsafe extern "C" fn ops_ptr() -> *const u32 { let v: &Vec<u32> = &*std::ptr::addr_of!(OPS); v.as_ptr() }
#[no_mangle]
pub unsafe extern "C" fn ops_len() -> usize { let v: &Vec<u32> = &*std::ptr::addr_of!(OPS); v.len() }
#[no_mangle]
pub unsafe extern "C" fn strs_ptr() -> *const u8 { let s: &String = &*std::ptr::addr_of!(STRS); s.as_ptr() }
#[no_mangle]
pub unsafe extern "C" fn strs_len() -> usize { let s: &String = &*std::ptr::addr_of!(STRS); s.len() }
#[no_mangle]
pub unsafe extern "C" fn reset() {
    *std::ptr::addr_of_mut!(OPS) = Vec::new();
    *std::ptr::addr_of_mut!(STRS) = String::new();
}

const OWNED: u32 = 0x8000_0000;
/// flags 1: 입력이 모두 ASCII (JS 가 쓴 바이트 수 = 문자열 길이) — 바이트 위치가 곧 UTF-16 위치다
const ASCII: u32 = 1;
/// flags 2: 복구 모드
const RECOVER: u32 = 2;
/// 복구 기록 수준 (Out::issues 자리)
const WARN: usize = 0;
const ERR: usize = 1;

/// 엔티티로 갈린 글 조각을 한 글 노드로 모은다(@xmldom 처럼) — 이어진 원문 구간이면 복사하지 않는다
enum Pending { None, Raw(usize, usize), Owned(String) }

struct Out<'a> {
    src: &'a str,
    ascii: bool,
    ops: Vec<u32>,
    strs: String,
    /// 바꾼 문자열 버퍼의 UTF-16 길이
    strs_u16: u32,
    /// 바이트 → UTF-16 위치 커서 (앞으로만 간다 — 뒤로 가면 처음부터 다시 센다)
    cur_b: usize,
    cur_u: usize,
    text: Pending,
    /// 복구 기록 — 수준별 (건수, 첫 문구)
    issues: [(u32, &'static str); 2],
}

impl<'a> Out<'a> {
    fn u16_at(&mut self, b: usize) -> usize {
        if self.ascii { return b }
        if b < self.cur_b { self.cur_b = 0; self.cur_u = 0 }
        self.cur_u += u16_units(&self.src.as_bytes()[self.cur_b..b]);
        self.cur_b = b;
        self.cur_u
    }
    /// 원문 구간 (바이트) → 문자열 참조
    fn raw(&mut self, start: usize, end: usize) {
        let s = self.u16_at(start) as u32;
        let e = self.u16_at(end) as u32;
        self.ops.push(s); self.ops.push(e - s);
    }
    /// 원문 안의 바이트 위치 (원문을 빌린 조각이 아니면 None)
    fn offset(&self, v: &str) -> Option<usize> {
        let base = self.src.as_ptr() as usize;
        let p = v.as_ptr() as usize;
        if p >= base && p + v.len() <= base + self.src.len() { Some(p - base) } else { None }
    }
    /// 원문을 빌린 조각이면 그 구간, 아니면 바꾼 문자열로
    fn piece(&mut self, v: &str) {
        match self.offset(v) { Some(off) => self.raw(off, off + v.len()), None => self.owned(v) }
    }
    fn owned(&mut self, v: &str) {
        let n = v.encode_utf16().count() as u32;
        self.ops.push(self.strs_u16); self.ops.push(n | OWNED);
        self.strs.push_str(v);
        self.strs_u16 += n;
    }
    fn issue(&mut self, level: usize, msg: &'static str) {
        let (n, first) = &mut self.issues[level];
        if *n == 0 { *first = msg }
        *n += 1;
    }
    fn pending_non_ws(&self) -> bool {
        match &self.text {
            Pending::None => false,
            Pending::Raw(s, e) => self.src[*s..*e].chars().any(|c| !c.is_whitespace()),
            Pending::Owned(t) => t.chars().any(|c| !c.is_whitespace()),
        }
    }
    /// 원문을 빌린 글 조각을 덧붙인다
    fn push_text(&mut self, v: &str) {
        let off = self.offset(v);
        self.text = match (std::mem::replace(&mut self.text, Pending::None), off) {
            (Pending::None, Some(o)) => Pending::Raw(o, o + v.len()),
            (Pending::Raw(s, e), Some(o)) if e == o => Pending::Raw(s, o + v.len()),
            (Pending::Raw(s, e), _) => { let mut t = self.src[s..e].to_string(); t.push_str(v); Pending::Owned(t) }
            (Pending::None, None) => Pending::Owned(v.to_string()),
            (Pending::Owned(mut t), _) => { t.push_str(v); Pending::Owned(t) }
        };
    }
    /// 바꾼 글(엔티티를 푼 글자)을 덧붙인다
    fn push_owned_text(&mut self, v: &str) {
        self.text = match std::mem::replace(&mut self.text, Pending::None) {
            Pending::None => Pending::Owned(v.to_string()),
            Pending::Raw(s, e) => { let mut t = self.src[s..e].to_string(); t.push_str(v); Pending::Owned(t) }
            Pending::Owned(mut t) => { t.push_str(v); Pending::Owned(t) }
        };
    }
    fn flush(&mut self) {
        match std::mem::replace(&mut self.text, Pending::None) {
            Pending::None => {}
            Pending::Raw(s, e) => { if e > s { self.ops.push(2); self.raw(s, e) } }
            Pending::Owned(t) => { if !t.is_empty() { self.ops.push(2); self.owned(&t) } }
        }
    }
}

/// 입력은 UTF-8, 줄바꿈은 호출자가 \n 으로 정규화해 둔다
#[no_mangle]
pub unsafe extern "C" fn parse(p: *const u8, len: usize, flags: u32) -> u32 {
    let bytes = std::slice::from_raw_parts(p, len);
    // 입력은 JS TextEncoder 가 쓴 UTF-8 이라 늘 올바르다 — 다시 검증하지 않는다(큰 입력에서 한 번 더 훑는 비용)
    let xml = std::str::from_utf8_unchecked(bytes);
    let mut out = Out { src: xml, ascii: flags & ASCII != 0, ops: Vec::with_capacity(len / 16), strs: String::new(), strs_u16: 0, cur_b: 0, cur_u: 0, text: Pending::None, issues: [(0, ""); 2] };
    let recover = flags & RECOVER != 0;
    let code = run(xml, &mut out, recover);
    if recover {
        for (i, &(n, msg)) in out.issues.clone().iter().enumerate() {
            if n > 0 { out.ops.push(6); out.ops.push(i as u32 + 1); out.ops.push(n); out.owned(msg) }
        }
    }
    *std::ptr::addr_of_mut!(OPS) = std::mem::take(&mut out.ops);
    *std::ptr::addr_of_mut!(STRS) = std::mem::take(&mut out.strs);
    code
}

/// 열린 요소 — 엄격 모드는 깊이만, 복구 모드는 이름과 이름별 개수까지 둔다(짝 없는 닫는 태그를 스택을 훑지 않고 가린다)
struct Tree<'a> { depth: u32, roots: u32, open: Vec<&'a str>, counts: std::collections::HashMap<&'a str, u32>, root_closed: bool, dead: u8 }

/// 복구 모드: 끝 표지를 입력 끝까지 못 찾은 표기 (Tree::dead 비트) — 그 뒤에도 끝 표지가 없으니 다시 찾지 않는다(찾으면 입력 길이의 제곱)
const DEAD_COMMENT: u8 = 1;
const DEAD_CDATA: u8 = 2;
const DEAD_PI: u8 = 4;
const DEAD_DOCTYPE: u8 = 8;
fn dead_kind(rest: &[u8]) -> u8 {
    if rest.starts_with(b"!--") { DEAD_COMMENT } else if rest.starts_with(b"![CDATA[") { DEAD_CDATA } else if rest.starts_with(b"?") { DEAD_PI }
    else if rest.len() > 1 && rest[0] == b'!' && (rest[1] == b'D' || rest[1] == b'd') { DEAD_DOCTYPE } else { 0 }
}

/// 복구 모드: 시작 태그의 이름이 틀려 '<' 를 글자로 두고 그 뒤를 다시 읽어야 한다
const AS_TEXT: u32 = u32::MAX;

fn run<'a>(xml: &'a str, out: &mut Out<'a>, recover: bool) -> u32 {
    let mut t = Tree { depth: 0, roots: 0, open: Vec::new(), counts: std::collections::HashMap::new(), root_closed: false, dead: 0 };
    // 복구 모드는 quick-xml 이 멈춘 자리 뒤에서 리더를 새로 띄워 이어 읽는다
    let mut base = 0usize;
    'restart: loop {
        let mut r = Reader::from_str(&xml[base..]);
        let c = r.config_mut();
        c.trim_text(false);
        c.check_end_names = !recover;
        c.allow_unmatched_ends = recover;
        c.allow_dangling_amp = recover;
        loop {
            // 다음 마크업의 '<' 자리 (마크업을 글자로 돌리거나 태그를 다시 자를 때 쓴다)
            let at = base + r.buffer_position() as usize;
            if recover && xml.as_bytes().get(at) == Some(&b'<') && t.dead & dead_kind(&xml.as_bytes()[at + 1..]) != 0 {
                out.issue(ERR, "끝나지 않은 표기의 '<' 를 글자로 둠");
                out.push_text(&xml[at..at + 1]);
                base = at + 1;
                continue 'restart
            }
            // 복구 모드: 태그를 quick-xml 에 넘기기 전에 끝을 본다 — 깨진 태그는 여기서 고쳐 읽는다.
            // quick-xml 에 맡기면 멀리 있는 '>' 까지 훑고 버리기를 '<' 마다 되풀이한다(입력 길이의 제곱)
            if recover && xml.as_bytes().get(at) == Some(&b'<') && !matches!(xml.as_bytes().get(at + 1), Some(b'!' | b'?')) {
                let next = match tag_end(xml.as_bytes(), at + 1) {
                    TagEnd::Gt(_) => None,
                    TagEnd::Lt(k) => Some(Some(lt_in_tag(xml, out, &mut t, at, k))),
                    TagEnd::Open => { out.issue(ERR, "태그의 따옴표 짝이 안 맞음"); Some(bounded_tag(xml, out, &mut t, at)) }
                };
                match next { None => {} Some(Some(n)) => { base = n; continue 'restart } Some(None) => break 'restart }
            }
            let ev = match r.read_event() {
                Ok(e) => e,
                Err(e) => {
                    if !recover { return code(&e) }
                    match resync(xml, out, &mut t, &e, base + r.error_position() as usize) { Some(next) => { base = next; continue 'restart } None => break 'restart }
                }
            };
            match ev {
                Event::Start(_) | Event::Empty(_) => {
                    let empty = matches!(ev, Event::Empty(_));
                    let e = match ev { Event::Start(e) | Event::Empty(e) => e, _ => unreachable!() };
                    match start(out, &mut t, &e, empty, recover, None) {
                        0 => {}
                        AS_TEXT => { debug_assert_eq!(xml.as_bytes()[at], b'<'); out.push_text(&xml[at..at + 1]); base = at + 1; continue 'restart }
                        code => return code,
                    }
                }
                Event::End(e) => {
                    if !recover { out.flush(); out.ops.push(1); t.depth = t.depth.saturating_sub(1); continue }
                    let qn = e.name();
                    end_tag(out, &mut t, unsafe { std::str::from_utf8_unchecked(qn.as_ref()) });
                }
                Event::Text(t) => {
                    let b: &[u8] = &t;
                    out.push_text(unsafe { std::str::from_utf8_unchecked(b) })
                }
                Event::GeneralRef(g) => {
                    let resolved = match g.resolve_char_ref() {
                        Ok(Some(ch)) => { let mut buf = [0u8; 4]; out.push_owned_text(ch.encode_utf8(&mut buf)); true }
                        Ok(None) => match g.decode() {
                            Ok(name) => match resolve_predefined_entity(&name) { Some(s) => { out.push_owned_text(s); true } None => false },
                            Err(_) if !recover => return 6,
                            Err(_) => false,
                        },
                        Err(_) => false,
                    };
                    if !resolved {
                        if !recover { return 5 }
                        // 모르는 엔티티·틀린 문자 참조는 글자 그대로 둔다(@xmldom 도 그렇게 살린다)
                        out.issue(ERR, "모르는 엔티티를 글자 그대로 둠");
                        let b: &[u8] = &g;
                        let name = unsafe { std::str::from_utf8_unchecked(b) };
                        match out.offset(name) { Some(o) if o >= 1 => out.push_text(&xml[o - 1..(o + name.len() + 1).min(xml.len())]), _ => out.push_owned_text(&format!("&{};", name)) }
                    }
                }
                Event::CData(c) => {
                    if !recover { if t.depth == 0 { return 9 } } else {
                        // 루트 앞 CDATA 는 둘 곳이 없다
                        if t.open.is_empty() { out.issue(ERR, "루트 요소 밖의 CDATA 를 버림"); continue }
                        settle(out, &t);
                    }
                    out.flush();
                    let b: &[u8] = &c;
                    let s = unsafe { std::str::from_utf8_unchecked(b) };
                    out.ops.push(3); out.piece(s)
                }
                Event::Comment(c) => {
                    if !recover { if t.depth == 0 && out.pending_non_ws() { return 9 } } else { settle(out, &t) }
                    out.flush();
                    let b: &[u8] = &c;
                    let s = unsafe { std::str::from_utf8_unchecked(b) };
                    // Comment ::= '<!--' ((Char - '-') | ('-' (Char - '-')))* '-->'
                    if s.contains("--") || s.ends_with('-') || !s.chars().all(is_char) { if !recover { return 18 } out.issue(ERR, "주석 문법이 틀림") }
                    out.ops.push(4); out.piece(s)
                }
                Event::Decl(_) | Event::PI(_) => {
                    if !recover { if t.depth == 0 && out.pending_non_ws() { return 9 } } else { settle(out, &t) }
                    out.flush();
                    // XML 선언과 처리 명령은 타입만 다르고 '<?' 와 '?>' 사이 원문이다
                    let b: &[u8] = match &ev { Event::Decl(d) => d, Event::PI(p) => p, _ => unreachable!() };
                    let s = unsafe { std::str::from_utf8_unchecked(b) };
                    if let Some(code) = check_pi(out, s) {
                        if !recover { return code }
                        out.issue(ERR, "처리 명령·XML 선언을 버림");
                        continue
                    }
                    pi(out, s)
                }
                // 복구 모드: DOCTYPE 은 건너뛴다(@xmldom 은 받아들이고 알리지 않는다 — 외부 개체는 어느 쪽도 읽지 않는다)
                Event::DocType(_) => { if !recover { return 2 } }
                Event::Eof => break 'restart,
            }
        }
    }
    if !recover {
        if t.depth > 0 { return 8 }
        if out.pending_non_ws() { return 9 }
        out.flush();
        return 0
    }
    settle(out, &t);
    out.flush();
    let n = t.open.len();
    if n > 1 || (n == 1 && !t.root_closed) { out.issue(ERR, "닫히지 않은 요소를 입력 끝에서 닫음") }
    for _ in 0..n { out.ops.push(1) }
    0
}

/// 복구 모드: 마크업 앞에 쌓인 글 정리 — 루트 앞의 공백 아닌 글은 버리고(@xmldom 도 버린다), 루트를 닫은 뒤의 공백은 버린다
fn settle(out: &mut Out, t: &Tree<'_>) {
    if t.open.is_empty() {
        if out.pending_non_ws() { out.text = Pending::None; out.issue(ERR, "루트 요소 앞의 글을 버림") }
    } else if t.root_closed && t.open.len() == 1 {
        if out.pending_non_ws() { out.issue(ERR, "루트 요소를 닫은 뒤의 글을 루트에 둠") } else { out.text = Pending::None }
    }
}

/// 시작 태그. 엄격 모드는 @xmldom 이 경고·오류를 낼 것을 모두 거절 코드로, 복구 모드는 고쳐 읽고 기록한다
/// src_name: 원문을 빌린 이름 (e 가 고쳐 이은 태그라 이름이 원문 밖에 있을 때)
fn start<'a>(out: &mut Out<'a>, t: &mut Tree<'a>, e: &BytesStart, empty: bool, recover: bool, src_name: Option<&'a str>) -> u32 {
    let qn = e.name();
    let name = unsafe { std::str::from_utf8_unchecked(qn.as_ref()) };
    if !recover {
        if t.depth == 0 { t.roots += 1; if t.roots > 1 { return 10 } }
        if t.depth == 0 && out.pending_non_ws() { return 9 }
        out.flush();
        if !is_qname(name) { return 16 }
    } else {
        // 이름이 틀린 시작 태그는 '<' 를 글자로 두고 그 뒤를 다시 읽는다(@xmldom 도 그렇게 살린다)
        if !is_qname(name) { out.issue(ERR, "요소 이름이 틀려 '<' 를 글자로 둠"); return AS_TEXT }
        if t.root_closed && t.open.len() == 1 { out.issue(ERR, "루트 요소를 닫은 뒤의 요소를 루트에 둠") }
        settle(out, t);
        out.flush();
    }
    out.ops.push(0); out.piece(name);
    let at = out.ops.len(); out.ops.push(0);
    let mut c = 0;
    let mut keys: std::collections::HashSet<&[u8]> = std::collections::HashSet::new();
    // 원문 속성 구간을 한 번만 훑는다(속성마다 다시 훑으면 속성 수의 제곱)
    let raw = e.attributes_raw();
    let mut fixed: Option<BytesStart> = None;
    match loose_attrs(&raw) {
        Loose::Ok => {}
        Loose::Tight if !recover => return 17,
        Loose::Unquoted if !recover => return 7,
        // @xmldom 도 살리고 경고만 낸다. 이름 바로 뒤 따옴표 값(= 빠짐)은 이름=값으로 읽는다(@xmldom 과 같다)
        _ => {
            out.issue(WARN, "속성 값에 따옴표가 없거나 속성 사이 공백이 없음");
            if let Some(f) = fix_eq(unsafe { std::str::from_utf8_unchecked(&raw) }) { fixed = Some(BytesStart::from_content(format!("{} {}", name, f), name.len())) }
        }
    }
    // 복구 모드는 따옴표 없는 값·값 없는 속성도 읽는다
    let mut attrs = match &fixed { Some(f) => f.html_attributes(), None if recover => e.html_attributes(), None => e.attributes() };
    for a in attrs.with_checks(false) {
        let a = match a {
            Ok(a) => a,
            Err(AttrError::Duplicated(..)) if !recover => return 3,
            Err(_) if !recover => return 7,
            Err(_) => { out.issue(ERR, "속성 구문이 깨져 나머지 속성을 버림"); break }
        };
        let kb: &[u8] = a.key.into_inner();
        let k = unsafe { std::str::from_utf8_unchecked(kb) };
        if !is_qname(k) { if !recover { return 16 } out.issue(ERR, "속성 이름이 틀려 버림"); continue }
        if !keys.insert(kb) { if !recover { return 3 } out.issue(ERR, "같은 속성이 또 나와 뒤의 것을 버림"); continue }
        // 한 번 훑어 '<'(거절)와 바꿀 글자(&·탭·줄바꿈)를 함께 본다
        let (lt, special) = value_flags(&a.value);
        if lt { if !recover { return 12 } out.issue(ERR, "속성 값 안의 '<' 를 그대로 둠") }
        let vraw = unsafe { std::str::from_utf8_unchecked(&a.value) };
        out.piece(k);
        // 속성 값 정규화: 날 글의 탭·줄바꿈은 공백, 문자 참조(&#10;)는 그대로 (XML 1.0 §3.3.3) — 바꿀 게 없으면 원문 그대로
        if !special {
            out.piece(vraw);
        } else {
            let norm: String = vraw.chars().map(|c| if c == '\t' || c == '\n' || c == '\r' { ' ' } else { c }).collect();
            match unescape(&norm) {
                Ok(v) => out.owned(&v),
                Err(_) if !recover => return 5,
                Err(_) => { out.issue(ERR, "속성 값의 모르는 엔티티를 글자 그대로 둠"); let v = lenient_unescape(&norm); out.owned(&v) }
            }
        }
        c += 1;
    }
    out.ops[at] = c;
    if !recover {
        if empty { out.ops.push(1) } else { t.depth += 1 }
    } else if !empty || t.open.is_empty() {
        // 복구 모드는 루트를 입력 끝까지 열어 둔다 — 루트 뒤에 이어진 요소·글도 루트 안에 둔다
        let src = out.src;
        let nm = src_name.unwrap_or_else(|| match out.offset(name) { Some(o) => &src[o..o + name.len()], None => "" });
        t.open.push(nm);
        *t.counts.entry(nm).or_insert(0) += 1;
        if empty { t.root_closed = true }
    } else {
        out.ops.push(1)
    }
    0
}

/// 복구 모드의 닫는 태그 — 열린 조상과 맞으면 그 사이 요소를 함께 닫고, 맞는 게 없으면 버린다. 루트는 닫지 않는다
fn end_tag(out: &mut Out, t: &mut Tree<'_>, name: &str) {
    settle(out, t);
    out.flush();
    if name.is_empty() || t.counts.get(name).copied().unwrap_or(0) == 0 { out.issue(ERR, "여는 태그가 없는 닫는 태그를 버림"); return }
    // 맞는 조상이 있다 — 훑는 만큼 닫으므로 전체로는 선형
    let i = t.open.iter().rposition(|&o| o == name).unwrap();
    if t.open.len() - i > 1 { out.issue(ERR, "닫히지 않은 요소를 닫음") }
    let keep = i.max(1);
    for nm in t.open.drain(keep..) { out.ops.push(1); *t.counts.get_mut(nm).unwrap() -= 1 }
    if i == 0 { t.root_closed = true }
}

/// 복구 모드: 태그 끝 — '>' 자리, 따옴표 밖 '<' 자리, 따옴표 짝이 어긋남(값 안 '<' 뒤에 '>' 가 나와 뒤를 삼킴, 또는 입력 끝까지 닫히지 않음)
enum TagEnd { Gt(usize), Lt(usize), Open }
fn tag_end(b: &[u8], from: usize) -> TagEnd {
    let (mut q, mut lt_in_q) = (0u8, false);
    for (i, &c) in b.iter().enumerate().skip(from) {
        if q != 0 {
            if c == q { q = 0; lt_in_q = false } else if c == b'<' { lt_in_q = true } else if c == b'>' && lt_in_q { return TagEnd::Open }
        } else if c == b'"' || c == b'\'' { q = c } else if c == b'>' { return TagEnd::Gt(i) } else if c == b'<' { return TagEnd::Lt(i) }
    }
    TagEnd::Open
}

/// 복구 모드: '<'(p) 에서 시작한 태그를 따옴표를 보지 않고 다음 '>' 나 '<' 까지로 자른다. 다시 읽을 자리를 낸다 (None 이면 입력 끝)
fn bounded_tag<'a>(xml: &'a str, out: &mut Out<'a>, t: &mut Tree<'a>, p: usize) -> Option<usize> {
    let b = xml.as_bytes();
    let k = p + 1 + find_lt_gt(&b[p + 1..])?;
    if b[k] == b'<' { return Some(lt_in_tag(xml, out, t, p, k)) }
    let content = &xml[p + 1..k];
    if let Some(name) = content.strip_prefix('/') { end_tag(out, t, name.trim_end_matches(is_s)); return Some(k + 1) }
    let (content, empty) = match content.strip_suffix('/') { Some(c) => (c, true), None => (content, false) };
    let name_len = content.find(is_s).unwrap_or(content.len());
    if start(out, t, &BytesStart::from_content(content, name_len), empty, true, None) == AS_TEXT { out.push_text(&xml[p..p + 1]); return Some(p + 1) }
    Some(k + 1)
}

/// 속성 이름 바로 뒤(공백은 건너뜀)에 '=' 없이 따옴표 값이 오면 '=' 를 넣는다 — 고친 게 없으면 None.
/// 이름은 공백 뒤에서 시작해야 한다(닫는 따옴표에 붙은 글자는 따옴표 짝이 어긋난 값의 조각일 수 있다)
fn fix_eq(raw: &str) -> Option<String> {
    let name_ch = |c: u8| c.is_ascii_alphanumeric() || c >= 0x80 || matches!(c, b'_' | b'-' | b'.' | b':');
    let (mut s, mut last, mut q, mut in_name) = (String::new(), 0, 0u8, false);
    let b = raw.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        if q != 0 { if c == q { q = 0 } continue }
        if name_ch(c) {
            // 이름 시작: 맨 앞이거나 공백 뒤
            if i == 0 || b[i - 1].is_ascii_whitespace() { in_name = true } else if !name_ch(b[i - 1]) { in_name = false }
            continue
        }
        if c == b'"' || c == b'\'' {
            if in_name { s.push_str(&raw[last..i]); s.push('='); last = i }
            q = c;
        }
        if !c.is_ascii_whitespace() { in_name = false }
    }
    if last == 0 { return None }
    s.push_str(&raw[last..]);
    Some(s)
}

/// 끼어든 태그 뒤에 남은 속성 조각인가 — 따옴표 값 하나(앞 속성 이름=의 값)로 시작하거나 속성으로 시작하고, 그 뒤는 속성(이름="값")만 ('/' 로 끝나도 된다)
fn attr_tail(s: &str) -> bool {
    let s = s.trim_end_matches('/').trim();
    let b = s.as_bytes();
    let (mut i, mut any) = (0, false);
    let quoted = |i: usize| -> Option<usize> { let q = *b.get(i)?; if q != b'"' && q != b'\'' { return None } Some(i + 2 + b[i + 1..].iter().position(|&c| c == q)?) };
    if let Some(j) = quoted(0) { i = j; any = true }
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() { i += 1 }
        if i >= b.len() { return any }
        let n = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' { i += 1 }
        if i == n || !is_qname(&s[n..i]) { return false }
        while i < b.len() && b[i].is_ascii_whitespace() { i += 1 }
        if b.get(i) != Some(&b'=') { return false }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() { i += 1 }
        i = match quoted(i) { Some(j) => j, None => return false };
        any = true;
    }
}

/// 복구 모드: '<'(p) 뒤 '>' 보다 먼저 '<'(k) 가 나왔다. 다시 읽을 자리를 낸다
/// - 속성(=)이 없으면 태그가 아니라 글 속 '<' 다 — p..k 를 글로 둔다(@xmldom 도 글로 살린다)
/// - 열린 요소의 닫는 태그면 '>' 만 빠진 것이다 — 닫는다
/// - k 의 태그 뒤 조각이 속성 꼴로 '>' 로 끝나면 태그 안에 다른 태그가 끼어든 것이다 — 끼어든 태그를 버리고 앞뒤 속성을 한 태그로 잇는다
/// - 그 밖은 '>' 가 빠진 태그다 — k 앞에서 끝난 것으로 본다
fn lt_in_tag<'a>(xml: &'a str, out: &mut Out<'a>, t: &mut Tree<'a>, p: usize, k: usize) -> usize {
    let b = xml.as_bytes();
    let content = &xml[p + 1..k];
    if let Some(name) = content.strip_prefix('/') {
        let name = name.trim_end_matches(is_s);
        if t.counts.get(name).copied().unwrap_or(0) > 0 { out.issue(ERR, "닫는 태그의 '>' 가 빠짐"); end_tag(out, t, name); return k }
    }
    let name_len = content.find(is_s).unwrap_or(content.len());
    let name = &content[..name_len];
    if content.starts_with('/') || !is_qname(name) || !content.contains('=') {
        out.issue(ERR, "'>' 없는 '<' 를 글자로 둠");
        out.push_text(&xml[p..k]);
        return k
    }
    if let TagEnd::Gt(e) = tag_end(b, k + 1) {
        let r_end = e + 1 + find_byte(&b[e + 1..], b'<').unwrap_or(b.len() - e - 1);
        let rest = &xml[e + 1..r_end];
        if let Some(gt) = rest.find('>') {
            let tail = rest[..gt].trim();
            if attr_tail(tail) {
                let (tail, empty) = match tail.strip_suffix('/') { Some(x) => (x, true), None => (tail, false) };
                let merged = format!("{} {}", content.trim_end_matches('/').trim_end(), tail);
                out.issue(ERR, "태그 안에 끼어든 태그를 버림");
                start(out, t, &BytesStart::from_content(merged.as_str(), name_len), empty, true, Some(&xml[p + 1..p + 1 + name_len]));
                return e + 1 + gt + 1
            }
        }
    }
    out.issue(ERR, "태그의 '>' 가 빠짐");
    let (c, empty) = match content.trim_end().strip_suffix('/') { Some(c) => (c, true), None => (content, false) };
    start(out, t, &BytesStart::from_content(c, name_len), empty, true, None);
    k
}

/// 복구 모드: quick-xml 이 '<'(p) 에서 낸 오류 뒤 다시 읽을 자리 (None 이면 입력 끝)
fn resync<'a>(xml: &'a str, out: &mut Out<'a>, t: &mut Tree<'a>, e: &Error, p: usize) -> Option<usize> {
    if p >= xml.len() { return None }
    if let Error::Syntax(SyntaxError::UnclosedTag) = e {
        // 따옴표 짝이 안 맞아 입력 끝까지 '>' 를 못 찾았거나, 입력이 태그 중간에서 끝났다
        out.issue(ERR, "태그가 닫히지 않음");
        return bounded_tag(xml, out, t, p)
    }
    // '<!' 뒤가 알 수 없는 표기이거나 주석·CDATA·처리 명령·DOCTYPE 이 끝나지 않았다 — '<' 를 글자로 두고 그 뒤를 다시 읽는다
    if let Error::Syntax(SyntaxError::UnclosedComment | SyntaxError::UnclosedCData | SyntaxError::UnclosedPIOrXmlDecl | SyntaxError::UnclosedDoctype) = e {
        t.dead |= dead_kind(&xml.as_bytes()[p + 1..]);
    }
    out.issue(ERR, "끝나지 않은 표기의 '<' 를 글자로 둠");
    out.push_text(&xml[p..p + 1]);
    Some(p + 1)
}

/// 모르는 엔티티·틀린 문자 참조는 글자 그대로 두고 푼다 (속성 값)
fn lenient_unescape(raw: &str) -> String {
    let mut s = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(i) = rest.find('&') {
        s.push_str(&rest[..i]);
        let tail = &rest[i..];
        let j = match tail.find(';') { Some(j) => j, None => { s.push_str(tail); return s } };
        let ent = &tail[1..j];
        let rep = if let Some(n) = ent.strip_prefix("#x") { u32::from_str_radix(n, 16).ok().and_then(char::from_u32) }
            else if let Some(n) = ent.strip_prefix('#') { n.parse::<u32>().ok().and_then(char::from_u32) }
            else { None };
        match (rep, resolve_predefined_entity(ent)) {
            (Some(c), _) => s.push(c),
            (None, Some(v)) => s.push_str(v),
            (None, None) => s.push_str(&tail[..=j]),
        }
        rest = &tail[j + 1..];
    }
    s.push_str(rest);
    s
}

enum Loose { Ok, Unquoted, Tight }

/// 원문 속성 구간 훑기 — 따옴표 없는 값·값 없는 속성(@xmldom 은 살리고 경고), 따옴표로 닫힌 값 바로 뒤에 공백 없이 붙은 속성
/// (@xmldom 경고 "attribute space is required")을 찾는다. 먼저 나온 쪽을 낸다
fn loose_attrs(raw: &[u8]) -> Loose {
    let n = raw.len();
    let mut i = 0;
    let ws = |c: u8| c == b' ' || c == b'\t' || c == b'\n' || c == b'\r';
    while i < n {
        while i < n && ws(raw[i]) { i += 1 }
        if i >= n || raw[i] == b'/' { break }
        let ks = i;
        while i < n && !ws(raw[i]) && raw[i] != b'=' && raw[i] != b'/' { i += 1 }
        let mut j = i;
        while j < n && ws(raw[j]) { j += 1 }
        if j < n && raw[j] == b'=' {
            j += 1;
            while j < n && ws(raw[j]) { j += 1 }
            if j < n && (raw[j] == b'"' || raw[j] == b'\'') {
                let q = raw[j]; j += 1;
                j = match find_byte(&raw[j..], q) { Some(k) => j + k, None => n };
                i = j + 1;
                if i < n && !ws(raw[i]) && raw[i] != b'/' { return Loose::Tight }
            } else {
                return Loose::Unquoted
            }
        } else {
            if i == ks { i += 1; continue }
            return Loose::Unquoted
        }
    }
    Loose::Ok
}

fn code(e: &Error) -> u32 {
    match e {
        Error::Syntax(_) => 1,
        Error::IllFormed(IllFormedError::MismatchedEndTag { .. }) | Error::IllFormed(IllFormedError::UnmatchedEndTag(_)) => 4,
        Error::IllFormed(IllFormedError::MissingEndTag(_)) => 8,
        Error::InvalidAttr(AttrError::Duplicated(..)) => 3,
        Error::InvalidAttr(_) => 7,
        Error::Escape(_) => 5,
        Error::Encoding(_) => 6,
        _ => 11,
    }
}

const LO: u64 = 0x0101_0101_0101_0101;
const HI8: u64 = 0x8080_8080_8080_8080;
/// 8바이트 중 c 와 같은 바이트가 있는가 (SWAR — 큰 속성 값·글을 8바이트씩 훑는다)
#[inline]
fn has_byte(x: u64, c: u8) -> bool { let y = x ^ (LO * c as u64); y.wrapping_sub(LO) & !y & HI8 != 0 }
/// b[i..i+8] 을 한 번에 읽는다 (호출자가 i + 8 <= b.len() 을 지킨다)
#[inline]
fn word(b: &[u8], i: usize) -> u64 { debug_assert!(i + 8 <= b.len()); unsafe { (b.as_ptr().add(i) as *const u64).read_unaligned() } }
/// 8바이트 중 n 보다 작은 바이트가 있는가 (n <= 128)
#[inline]
fn has_less(x: u64, n: u8) -> bool { x.wrapping_sub(LO * n as u64) & !x & HI8 != 0 }
/// hay 에서 c 의 첫 자리
fn find_byte(hay: &[u8], c: u8) -> Option<usize> {
    let mut i = 0;
    while i + 8 <= hay.len() { if has_byte(word(hay, i), c) { break } i += 8 }
    hay[i..].iter().position(|&b| b == c).map(|p| p + i)
}
/// hay 에서 '<' 나 '>' 의 첫 자리
fn find_lt_gt(hay: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + 8 <= hay.len() { let x = word(hay, i); if has_byte(x, b'<') || has_byte(x, b'>') { break } i += 8 }
    hay[i..].iter().position(|&b| b == b'<' || b == b'>').map(|p| p + i)
}
/// 속성 값 훑기: (값 안에 '<' 가 있는가, 바꿀 글자 &·탭·줄바꿈이 있는가)
fn value_flags(v: &[u8]) -> (bool, bool) {
    let mut special = false;
    let mut i = 0;
    while i + 8 <= v.len() {
        let x = word(v, i);
        // '<' & 탭 \n \r 은 모두 0x40 아래 — 그런 바이트가 없는 8바이트는 한 번에 넘긴다
        if has_less(x, 0x40) {
            if has_byte(x, b'<') { return (true, special) }
            if !special && (has_byte(x, b'&') || has_byte(x, b'\t') || has_byte(x, b'\n') || has_byte(x, b'\r')) { special = true }
        }
        i += 8;
    }
    for &b in &v[i..] { if b == b'<' { return (true, special) } if b == b'&' || b == b'\t' || b == b'\n' || b == b'\r' { special = true } }
    (false, special)
}

/// @xmldom grammar.js 의 NameStartChar (XML 1.1, 정규식 범위 그대로)
fn name_start(c: char) -> bool {
    matches!(c, ':' | '_' | 'a'..='z' | 'A'..='Z' | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}' | '\u{F8}'..='\u{2FF}' | '\u{370}'..='\u{1FFF}'
        | '\u{200C}'..='\u{200D}' | '\u{2070}'..='\u{218F}' | '\u{2C00}'..='\u{2FEF}' | '\u{3001}'..='\u{D7FF}' | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')
}
fn name_char(c: char) -> bool { name_start(c) || matches!(c, '-' | '.' | '0'..='9' | '\u{B7}' | '\u{300}'..='\u{36F}' | '\u{203F}'..='\u{2040}') }
fn is_name(s: &str) -> bool { let mut it = s.chars(); match it.next() { Some(c) if name_start(c) => it.all(name_char), _ => false } }
fn is_ncname(s: &str) -> bool { !s.contains(':') && is_name(s) }
/// QName = NCName (':' NCName)? — @xmldom 이 태그·속성 이름에 쓴다
fn is_qname(s: &str) -> bool { match s.split_once(':') { Some((a, b)) => is_ncname(a) && is_ncname(b), None => is_ncname(s) } }
/// XML Char (@xmldom grammar.js Char)
fn is_char(c: char) -> bool { matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}') }
fn is_s(c: char) -> bool { matches!(c, ' ' | '\t' | '\n' | '\r') }

/// XMLDecl ::= '<?xml' VersionInfo EncodingDecl? SDDecl? S? '?>' — body 는 '<?' 와 '?>' 사이 ("xml ...")
fn xml_decl_ok(body: &str) -> bool {
    let rest = match body.strip_prefix("xml") { Some(r) => r, None => return false };
    let b = rest.as_bytes();
    let ws = |b: &[u8], mut i: usize| { while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') { i += 1 } i };
    // (S 이름 Eq 따옴표 값) 하나 — 값 검사 함수
    let field = |b: &[u8], i: usize, name: &str, ok: &dyn Fn(&str) -> bool| -> Option<usize> {
        let j = ws(b, i);
        if j == i || !b[j..].starts_with(name.as_bytes()) { return None }
        let mut k = ws(b, j + name.len());
        if k >= b.len() || b[k] != b'=' { return None }
        k = ws(b, k + 1);
        if k >= b.len() || (b[k] != b'"' && b[k] != b'\'') { return None }
        let q = b[k];
        let end = b[k + 1..].iter().position(|&c| c == q)? + k + 1;
        let v = std::str::from_utf8(&b[k + 1..end]).ok()?;
        if !ok(v) { return None }
        Some(end + 1)
    };
    let ver = |v: &str| v.len() > 2 && v.starts_with("1.") && v[2..].bytes().all(|c| c.is_ascii_digit());
    let enc = |v: &str| { let mut it = v.bytes(); matches!(it.next(), Some(c) if c.is_ascii_alphabetic()) && it.all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-') };
    let sd = |v: &str| v == "yes" || v == "no";
    let mut i = match field(b, 0, "version", &ver) { Some(n) => n, None => return false };
    if let Some(n) = field(b, i, "encoding", &enc) { i = n }
    if let Some(n) = field(b, i, "standalone", &sd) { i = n }
    ws(b, i) == b.len()
}

/// UTF-8 바이트의 UTF-16 단위 수 — 8바이트씩 센다(이어지는 바이트 10xxxxxx 는 빼고, 4바이트 글자의 첫 바이트는 하나 더)
fn u16_units(b: &[u8]) -> usize {
    let mut n = 0usize;
    let mut chunks = b.chunks_exact(8);
    for c in &mut chunks {
        let x = word(c, 0);
        if x & HI8 == 0 { n += 8; continue }
        let cont = (x & !(x << 1) & HI8).count_ones() as usize;
        let four = (x & (x << 1) & (x << 2) & (x << 3) & HI8).count_ones() as usize;
        n += 8 - cont + four;
    }
    for &c in chunks.remainder() { if c & 0xC0 != 0x80 { n += 1; if c >= 0xF0 { n += 1 } } }
    n
}

/// 처리 명령·XML 선언 — @xmldom parseProcessingInstruction 과 같은 순서로 본다
/// PI ::= '<?' Name (S Char*)? '?>' · 대상이 xml 이면 맨 앞이어야 하고 XMLDecl 문법을 따라야 한다
fn check_pi(out: &Out, s: &str) -> Option<u32> {
    let (target, data) = match s.find(is_s) { Some(i) => (&s[..i], &s[i..]), None => (s, "") };
    if !is_name(target) || !data.chars().all(is_char) { return Some(15) }
    if target.eq_ignore_ascii_case("xml") {
        // 맨 앞이면 조각이 원문 2바이트 자리('<?' 뒤)에서 시작한다
        if out.offset(s) != Some(2) { return Some(13) }
        if !xml_decl_ok(s) { return Some(14) }
    }
    None
}

/// "대상 데이터" → 처리 명령 (@xmldom: 대상 뒤 공백을 떼고 데이터) — 둘 다 원문 구간
fn pi(out: &mut Out, s: &str) {
    let (target, data) = match s.find(|c: char| c.is_whitespace()) { Some(i) => (&s[..i], s[i..].trim_start()), None => (s, "") };
    out.ops.push(5); out.piece(target); out.piece(data);
}
