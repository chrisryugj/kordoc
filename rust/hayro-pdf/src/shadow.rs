// 그림자 해석기 — hayro-interpret 와 같은 순서로 콘텐츠를 미리 읽어, 장치 콜백 사이에 끼울 구조 사건과
// 콜백마다 기대하는 모양(글자 다음 자리·폭, 생략된 덮는 클립)을 계획으로 만든다.
// hayro-interpret 의 interpret/mod.rs·path.rs·text.rs·state.rs·stack.rs·form.rs·image.rs·ocg.rs 를 그대로 따른다.
// 어긋나면 장치가 오류를 낸다(events.rs) — 여기서 조용히 맞추지 않는다.
use hayro_font::{Font, FontCache, FontGlyph, GlyphId, StandardFont};
use hayro_interpret::hayro_cmap::{BfString, CMap, CMapName};
use hayro_interpret::kurbo::{Affine, BezPath, PathEl, Point, Rect, Shape};
use hayro_interpret::util::Float64Ext;
use hayro_interpret::{CacheKey, Function, InterpreterSettings};
use hayro_syntax::content::ops::TypedInstruction;
use hayro_syntax::content::TypedIter;
use hayro_syntax::object::dict::keys::*;
use hayro_syntax::object::{dict_or_stream, Array, Dict, Name, Object, ObjectIdentifier, Stream};
use hayro_syntax::page::{Page, Resources};
use hayro_syntax::xref::XRef;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

const UNITS_PER_EM: f32 = 1000.0;
const MAX_NESTED: u32 = 50;
const ANNOTATION_HIDDEN: u32 = 1 << 1;
const ANNOTATION_NO_VIEW: u32 = 1 << 5;

/// 글자 하나의 계획 — 콜백 글자와 code·행렬로 맞춰 보고, 나머지는 사건에 그대로 싣는다
pub struct GlyphPlan {
    pub code: u32,
    pub gid: u32,
    /// 텍스트 공간 행렬(PositionedGlyph::transform 과 같아야 한다)
    pub t: Affine,
    /// 다음 글자 원점(텍스트 공간, full_transform * 0)
    pub next: Point,
    /// (글자 폭만, 자간·낱말 간격 포함) — 텍스트 공간
    pub aw: f32,
    pub at: f32,
    /// /Widths 값(글리프 공간 1/1000)
    pub raw: f32,
    /// ToUnicode 가 U+0000 으로 매긴 글자(type1·type3 에서 hayro 가 버리는 경우)
    pub nul: bool,
    /// pdf.js 셈의 자리 — Pj::glyph
    pub pj: [f64; PJ_LEN],
}

pub struct MaskRec<'a> {
    pub group: Stream<'a>,
    pub parent: Resources<'a>,
    pub ctm: Affine,
    pub bbox: Rect,
    /// 덮는 클립까지 교차한 bbox(예전 패치의 hayro bbox)
    pub lbbox: Rect,
    pub depth: u32,
    /// 예전 SoftMask::cache_key 와 같은 기준(사전, 자원 없는 묶음이면 부모 자원, CTM, 예전 bbox) — 같은 마스크 내용은 한 번만 낸다
    pub key: (u128, Option<u128>, u128, u128),
}

/// 클립 — hayro 가 장치에 넘기는 모양(사각형이면 사각형)과 콘텐츠가 그린 경로(장치 공간)·`re` 로 시작한 하위 경로 자리
pub struct ClipShape { pub rect: Option<Rect>, pub path: BezPath, pub even_odd: bool, pub re: Vec<usize> }

/// 칠하는 경로 — 콘텐츠가 그린 경로(사용자 공간)와 `re` 로 시작한 하위 경로의 요소 자리. 연산자 목록은 `re` 를 사각형으로,
/// m·l 로 그린 경로는 그대로 둔다(같은 사각형이라도 m·l 로 그렸으면 경로다)
pub struct PathForm { pub path: BezPath, pub re: Vec<usize> }

pub enum Item<'a> {
    // 구조 사건
    Save, Restore, BeginText, EndText, TextMatrix, FormEnd,
    Font(String, f32, String),
    FontKey(Dict<'a>),
    XObject(String),
    FormBegin([f64; 6], [f32; 4]),
    HScale(f32),
    // 콜백 자리 (Clip·Pop 의 real=false 는 hayro 가 생략한 덮는 클립 — 장치가 대신 낸다)
    Run { mode: u8, glyphs: Rc<Vec<GlyphPlan>>, mask: Option<Rc<MaskRec<'a>>> },
    /// 경로 칠하기 — 둘째 값은 pdf.js 셈으로 색을 다시 낼 색 공간, 셋째는 콘텐츠가 그린 경로
    Draw(Option<Rc<MaskRec<'a>>>, Option<Rc<Pcs>>, Rc<PathForm>),
    /// `sh` — hayro 가 음영을 못 만들면 콜백이 없다. 장치가 음영 칠하기(무늬 행렬 = 그리기 행렬)로 알아본다.
    /// 칠하는 영역은 bbox 라서, 덮는 클립을 생략한 hayro bbox(nb)와 예전 bbox(lb)가 다르면 장치가 예전 것으로 다시 만든다
    Shade { mask: Option<Rc<MaskRec<'a>>>, ctm: Affine, nb: Rect, lb: Rect },
    Clip(bool, ClipShape),
    Pop(bool),
    FormClip, FormPop,
    Group(Option<Rc<MaskRec<'a>>>), GroupPop,
    Image,
    MarkBegin, MarkEnd,
}

pub const RUN_FILL: u8 = 0;
pub const RUN_STROKE: u8 = 1;
pub const RUN_INVISIBLE: u8 = 2;

#[derive(Clone)]
enum SFont<'a> { Font(Font<'a>, Option<Rc<CMap>>), Fallback(Font<'a>) }

impl<'a> SFont<'a> {
    fn font(&self) -> &Font<'a> { match self { SFont::Font(f, ..) | SFont::Fallback(f) => f } }
}

#[derive(Clone)]
struct TextSt<'a> {
    tc: f32, tw: f32, th: f32, tl: f32, fs: f32, rise: f32, mode: u8,
    font: Option<SFont<'a>>,
    tm: Affine, tlm: Affine,
    clip: BezPath,
    pj: Pj,
}

pub const PJ_LEN: usize = 15;
const IDENT: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// pdf.js carriageReturn — T*·'·" 의 줄 바꿈은 f64 TL 로
fn pj_carriage_return(cx: &mut Cx<'_>) { let l = cx.st().text.pj.tl; cx.ts().pj.next_line(0.0, -l) }

/// pdf.js Util.transform
fn pj_mul(a: &[f64; 6], b: &[f64; 6]) -> [f64; 6] {
    [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]
}

/// pdf.js getTextContent 의 글 상태(TextState) — 글 조각 자리를 pdf.js 와 같은 f64 셈으로 따로 잰다.
/// hayro 는 Tf·Tc·TJ 값을 f32 로 셈해 자리 끝자리가 달라, 틈이 문턱에 딱 걸리면(TJ 200 = −0.2em 등) 조각 끊기가 pdf.js 와 갈린다.
/// shortcut: 쪽 밖 글자(pdf.js 는 자간을 건너뛴다)·결합 부호(\p{Mn}, 폭 0)·Type3 글꼴 행렬·CFF FontMatrix 는 hayro 처럼 센다 — 이런 글자 뒤 자리가 pdf.js 와 다르면 그때 옮긴다
#[derive(Clone)]
struct Pj { tm: [f64; 6], tlm: [f64; 6], fs: f64, tc: f64, tw: f64, hs: f64, rise: f64, tl: f64, pend: Pend }

/// 아직 자간을 더하지 않은 마지막 글자 — pdf.js 는 TJ 숫자 몫(extraSpacing)을 앞 글자 묶음의 마지막 글자 자간에 더한다
#[derive(Clone, Copy)]
enum Pend { No, Glyph(Option<f64>), Lost }

impl Default for Pj {
    fn default() -> Self { Self { tm: IDENT, tlm: IDENT, fs: 0.0, tc: 0.0, tw: 0.0, hs: 1.0, rise: 0.0, tl: 0.0, pend: Pend::No } }
}

/// pdf.js 의 \s(첫 글자가 이것이면 공백 글자)
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// 유니코드 서식 문자(\p{Cf}) — pdf.js 는 자리를 옮기지 않고 건너뛴다
fn format_mark(c: char) -> bool {
    matches!(c, '\u{AD}' | '\u{600}'..='\u{605}' | '\u{61C}' | '\u{6DD}' | '\u{70F}' | '\u{890}'..='\u{891}' | '\u{8E2}' | '\u{180E}'
        | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}'
        | '\u{FFF9}'..='\u{FFFB}' | '\u{110BD}' | '\u{110CD}' | '\u{13430}'..='\u{1343F}' | '\u{1BCA0}'..='\u{1BCA3}'
        | '\u{1D173}'..='\u{1D17A}' | '\u{E0001}' | '\u{E0020}'..='\u{E007F}')
}

impl Pj {
    fn translate(&mut self, x: f64, y: f64) {
        let m = &mut self.tm;
        m[4] = m[0] * x + m[2] * y + m[4];
        m[5] = m[1] * x + m[3] * y + m[5];
    }
    fn next_line(&mut self, x: f64, y: f64) {
        let m = &mut self.tlm;
        m[4] = m[0] * x + m[2] * y + m[4];
        m[5] = m[1] * x + m[3] * y + m[5];
        self.tm = self.tlm;
    }
    fn set_matrix(&mut self, m: [f64; 6]) { self.tm = m; self.tlm = m; }
    /// getCurrentTextTransform
    fn current(&self, ctm: &[f64; 6]) -> [f64; 6] {
        pj_mul(ctm, &pj_mul(&self.tm, &[self.fs * self.hs, 0.0, 0.0, self.fs, 0.0, self.rise]))
    }
    fn space(&mut self, cs: f64, h: bool) { if h { self.translate(cs * self.hs, 0.0) } else { self.translate(0.0, -cs) } }
    /// 앞 글자의 자간 — extra 는 TJ 숫자 몫. 기다리는 글자가 없으면 숫자 몫만 옮긴다(pdf.js 의 빈 글자 묶음)
    fn settle(&mut self, extra: Option<f64>, h: bool) {
        match std::mem::replace(&mut self.pend, Pend::No) {
            Pend::No => if let Some(e) = extra { let cs = self.tc + e; if cs != 0.0 { self.space(cs, h) } },
            Pend::Lost => {}
            Pend::Glyph(ws) => {
                let cs = self.tc + extra.unwrap_or(0.0);
                match ws { Some(w) => self.space(cs + w, h), None => if cs != 0.0 { self.space(cs, h) } }
            }
        }
    }
    /// TJ 숫자
    fn number(&mut self, n: f64, h: bool) {
        if n == 0.0 { return }
        let sf = (if h { -1.0 } else { 1.0 }) * self.fs / 1000.0;
        self.settle(Some(n * sf), h)
    }
    /// 글자 하나 — [시작 행렬 6, 폭만큼 나아간 끝자리 2(폭 0·공백은 NaN), CTM a·b, Tlm a·b, 글자 크기, 폭(텍스트 공간), 폭 × Tz]
    fn glyph(&mut self, ctm: &[f64; 6], w: f64, h: bool, u: Option<&str>) -> [f64; PJ_LEN] {
        self.settle(None, h);
        let t = self.current(ctm);
        let first = u.and_then(|s| s.chars().next());
        let ws = u.is_none() || first.is_some_and(js_space);
        let cf = !ws && u.and_then(|s| s.chars().last()).is_some_and(format_mark);
        let sd = w * (0.001 * self.fs);
        let mut end = [f64::NAN; 2];
        let mut sdx = 0.0;
        if cf { self.pend = Pend::Lost }
        else if ws { self.pend = Pend::Glyph(Some(if h { sd + self.tw } else { -sd + self.tw })) }
        else {
            sdx = if h { sd * self.hs } else { sd };
            if h { self.translate(sdx, 0.0) } else { self.translate(0.0, sdx) }
            if sdx != 0.0 { let e = self.current(ctm); end = [e[4], e[5]] }
            self.pend = Pend::Glyph(None);
        }
        [t[0], t[1], t[2], t[3], t[4], t[5], end[0], end[1], ctm[0], ctm[1], self.tlm[0], self.tlm[1], self.fs, sd, sdx]
    }
}

impl TextSt<'_> {
    fn hs(&self) -> f32 { self.th / 100.0 }
    fn horizontal(&self) -> bool { self.font.as_ref().map(|f| f.font().is_horizontal()).unwrap_or(false) }
    fn temp(&self) -> Affine { Affine::new([self.fs as f64 * self.hs() as f64, 0.0, 0.0, self.fs as f64, 0.0, self.rise as f64]) }
    fn full(&self) -> Affine { self.tm * self.temp() }
    fn adjust(&mut self, adj: f32) {
        let h = self.horizontal();
        let hs = if h { self.hs() } else { 1.0 };
        let s = -adj / UNITS_PER_EM * self.fs * hs;
        let (tx, ty) = if h { (s, 0.0) } else { (0.0, s) };
        self.tm *= Affine::new([1.0, 0.0, 0.0, 1.0, tx as f64, ty as f64]);
    }
    fn advance(&mut self, code: u32, len: usize) {
        let ga = self.font.as_ref().map(|f| f.font().code_advance(code)).unwrap_or_default();
        let h = self.horizontal();
        let ws = if code == 32 && len == 1 { self.tw } else { 0.0 };
        let base = |a: f32| a / UNITS_PER_EM * self.fs + self.tc + ws;
        let tx = if h { base(ga.x as f32) * self.hs() } else { 0.0 };
        let ty = if !h { base(ga.y as f32) } else { 0.0 };
        self.tm *= Affine::new([1.0, 0.0, 0.0, 1.0, tx as f64, ty as f64]);
    }
    fn next_line(&mut self, tx: f64, ty: f64) {
        let m = self.tlm * Affine::translate((tx, ty));
        self.tlm = m;
        self.tm = m;
    }
}

impl Default for TextSt<'_> {
    fn default() -> Self {
        Self { tc: 0.0, tw: 0.0, th: 100.0, tl: 0.0, fs: 1.0, rise: 0.0, mode: 0, font: None, tm: Affine::IDENTITY, tlm: Affine::IDENTITY, clip: BezPath::new(), pj: Pj::default() }
    }
}

#[derive(Clone)]
struct GState<'a> { ctm: Affine, text: TextSt<'a>, mask: Option<Rc<MaskRec<'a>>>, saved_clips: usize,
    /// 채우기·긋기 색 공간 — pdf.js 셈이 hayro 와 다른 공간(ICCBased·DeviceCMYK 를 거치는 공간)만. 전달 함수(TR)가 있으면 셈하지 않는다
    fill_cs: Option<Rc<Pcs>>, stroke_cs: Option<Rc<Pcs>>, tr: bool }

/// 해석 문맥 하나(쪽 또는 소프트 마스크) — hayro Context 와 같은 상태
struct Cx<'a> {
    stack: Vec<GState<'a>>,
    overflow: usize,
    clips: Vec<bool>,
    bbox: Vec<Rect>,
    /// 지금 경로에서 `re` 로 시작한 하위 경로의 요소 자리
    path_re: Vec<usize>,
    /// 모든 클립(생략한 덮는 클립 포함)을 교차한 bbox — 예전 패치의 hayro bbox
    lbbox: Vec<Rect>,
    path: BezPath,
    last: Point,
    sub: Point,
    clip: Option<bool>,
    vis: Vec<bool>,
    depth: u32,
}

impl<'a> Cx<'a> {
    fn new(ctm: Affine, bbox: Rect, lbbox: Rect, depth: u32) -> Self {
        Self { stack: vec![GState { ctm, text: TextSt::default(), mask: None, saved_clips: 0, fill_cs: None, stroke_cs: None, tr: false }], overflow: 0, clips: Vec::new(), bbox: vec![bbox], path_re: Vec::new(), lbbox: vec![lbbox],
            path: BezPath::new(), last: Point::ZERO, sub: Point::ZERO, clip: None, vis: Vec::new(), depth }
    }
    fn st(&self) -> &GState<'a> { self.stack.last().unwrap() }
    fn st_mut(&mut self) -> &mut GState<'a> { self.stack.last_mut().unwrap() }
    fn ts(&mut self) -> &mut TextSt<'a> { &mut self.st_mut().text }
    fn ctm(&self) -> Affine { self.st().ctm }
    fn visible(&self) -> bool { self.vis.last().copied().unwrap_or(true) }
    fn num_states(&self) -> usize { self.stack.len() + self.overflow }
    fn bbox(&self) -> Rect { self.bbox.last().copied().unwrap_or_else(|| Rect::new(0.0, 0.0, 1.0, 1.0)) }
    fn lbbox(&self) -> Rect { self.lbbox.last().copied().unwrap_or_else(|| Rect::new(0.0, 0.0, 1.0, 1.0)) }
    fn save(&mut self) {
        if self.stack.len() > u16::MAX as usize { self.overflow += 1; return }
        let mut f = self.st().clone();
        f.saved_clips = self.clips.len();
        self.stack.push(f);
    }
    fn restore(&mut self, out: &mut Vec<Item<'a>>) {
        let target = if self.overflow > 0 { Some(self.clips.len()) } else if self.stack.len() > 1 { Some(self.st().saved_clips) } else { None };
        let Some(target) = target else { return };
        while self.clips.len() > target { self.pop_clip(out) }
        if self.overflow > 0 { self.overflow -= 1; return }
        if self.stack.len() <= 1 { return }
        self.stack.pop();
    }
    fn pop_clip(&mut self, out: &mut Vec<Item<'a>>) {
        match self.clips.pop() {
            Some(true) => { out.push(Item::Pop(true)); self.bbox.pop(); self.lbbox.pop(); }
            Some(false) => { out.push(Item::Pop(false)); self.lbbox.pop(); }
            None => {}
        }
    }
    /// context.rs push_clip_path — 쪽을 덮는 사각형 클립은 hayro 가 장치에 내지 않는다(real=false)
    fn push_clip(&mut self, path: BezPath, even_odd: bool, re: Vec<usize>, out: &mut Vec<Item<'a>>) {
        let lb = self.lbbox().intersect(path_as_rect(&path).unwrap_or_else(|| path.bounding_box()));
        self.lbbox.push(lb);
        if let Some(r) = path_as_rect(&path) {
            let cur = self.bbox();
            let shape = ClipShape { rect: Some(r), path, even_odd, re };
            if cur.min_x().is_nearly_greater_or_equal(r.min_x()) && cur.min_y().is_nearly_greater_or_equal(r.min_y())
                && cur.max_x().is_nearly_less_or_equal(r.max_x()) && cur.max_y().is_nearly_less_or_equal(r.max_y()) {
                self.clips.push(false);
                out.push(Item::Clip(false, shape));
                return;
            }
            out.push(Item::Clip(true, shape));
            let b = self.bbox().intersect(r);
            self.bbox.push(b);
            self.clips.push(true);
            return;
        }
        let bb = path.bounding_box();
        out.push(Item::Clip(true, ClipShape { rect: None, path, even_odd, re }));
        let b = self.bbox().intersect(bb);
        self.bbox.push(b);
        self.clips.push(true);
    }
    fn end_path(&mut self, out: &mut Vec<Item<'a>>) {
        if let Some(eo) = self.clip.take() {
            if !self.path.elements().is_empty() {
                let p = self.ctm() * self.path.clone();
                let re = self.path_re.clone();
                self.push_clip(p, eo, re, out);
            }
        }
        self.path.truncate(0);
        self.path_re.clear();
    }
    fn close_path(&mut self) {
        if self.path.elements().last() != Some(&PathEl::ClosePath) && !self.path.is_empty() {
            self.path.close_path();
            self.last = self.sub;
        }
    }
    fn fill(&mut self, out: &mut Vec<Item<'a>>) { self.paint(false, out) }
    fn stroke(&mut self, out: &mut Vec<Item<'a>>) { self.paint(true, out) }
    fn paint(&mut self, stroke: bool, out: &mut Vec<Item<'a>>) {
        if !self.visible() { return }
        let st = self.st();
        let cs = if st.tr { None } else if stroke { st.stroke_cs.clone() } else { st.fill_cs.clone() };
        let form = Rc::new(PathForm { path: self.path.clone(), re: self.path_re.clone() });
        out.push(Item::Draw(st.mask.clone(), cs, form))
    }
}

/// context.rs path_as_rect
pub fn path_as_rect(path: &BezPath) -> Option<Rect> {
    let points = match path.elements() {
        [PathEl::MoveTo(a), PathEl::LineTo(b), PathEl::LineTo(c), PathEl::LineTo(d), PathEl::ClosePath] => [*a, *b, *c, *d, *a],
        [PathEl::MoveTo(a), PathEl::LineTo(b), PathEl::LineTo(c), PathEl::LineTo(d), PathEl::LineTo(e)]
            if a.x.is_nearly_equal(e.x) && a.y.is_nearly_equal(e.y) => [*a, *b, *c, *d, *e],
        _ => return None,
    };
    let mut prev = None;
    for e in points.windows(2) {
        let sx = e[0].x.is_nearly_equal(e[1].x);
        let sy = e[0].y.is_nearly_equal(e[1].y);
        if sx == sy || prev == Some(sx) { return None }
        prev = Some(sx);
    }
    Some(fast_bbox(path))
}

/// util.rs BezPathExt::fast_bounding_box
pub fn fast_bbox(path: &BezPath) -> Rect {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut inc = |x: f64, y: f64| { x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y); };
    for el in path.elements() {
        match *el {
            PathEl::MoveTo(p) | PathEl::LineTo(p) => inc(p.x, p.y),
            PathEl::QuadTo(a, b) => { inc(a.x, a.y); inc(b.x, b.y) }
            PathEl::CurveTo(a, b, c) => { inc(a.x, a.y); inc(b.x, b.y); inc(c.x, c.y) }
            PathEl::ClosePath => {}
        }
    }
    if x0 > x1 { Rect::ZERO } else { Rect::new(x0, y0, x1, y1) }
}

/// form.rs FormXObject::new 가 받아들이는 폼 — 디코딩한 내용, 행렬, BBox, 묶음 여부
struct Form<'a> { data: Vec<u8>, matrix: Affine, bbox: [f32; 4], group: bool, dict: Dict<'a>, resources: Option<Resources<'a>> }

fn form<'a>(s: &Stream<'a>) -> Option<Form<'a>> {
    let dict = s.dict();
    let data = s.decoded_data().ok()?.into_owned();
    let resources = dict.get::<Dict<'_>>(RESOURCES).map(Resources::new);
    let matrix = Affine::new(dict.get::<[f64; 6]>(MATRIX).unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]));
    let bbox = dict.get::<[f32; 4]>(BBOX)?;
    Some(Form { data, matrix, bbox, group: dict.get::<Dict<'_>>(GROUP).is_some(), dict: dict.clone(), resources })
}

pub struct Shadow<'a> {
    _xref: &'a XRef,
    settings: InterpreterSettings,
    fonts: FontCache<'a>,
    inactive: HashSet<ObjectIdentifier>,
    tounicode: HashMap<ObjectIdentifier, Option<Rc<CMap>>>,
}

impl<'a> Shadow<'a> {
    pub fn new(xref: &'a XRef) -> Self {
        let mut inactive = HashSet::new();
        // ocg.rs OcgState::from_catalog
        if let Some(cat) = xref.get::<Dict<'_>>(xref.root_id()) {
            if let Some(ocp) = cat.get::<Dict<'_>>(OCPROPERTIES) {
                if let Some(cfg) = ocp.get::<Dict<'_>>(D) {
                    let off = cfg.get::<Name<'_>>(BASE_STATE).map(|b| b.as_ref() == b"OFF").unwrap_or(false);
                    if off {
                        if let Some(ocgs) = ocp.get::<Array<'_>>(OCGS) {
                            for it in ocgs.raw_iter() { if let Some(r) = it.as_obj_ref() { inactive.insert(r.into()); } }
                        }
                    }
                    if let Some(arr) = cfg.get::<Array<'_>>(ON) { for it in arr.raw_iter() { if let Some(r) = it.as_obj_ref() { inactive.remove(&r.into()); } } }
                    if let Some(arr) = cfg.get::<Array<'_>>(OFF) { for it in arr.raw_iter() { if let Some(r) = it.as_obj_ref() { inactive.insert(r.into()); } } }
                }
            }
        }
        Self { _xref: xref, settings: InterpreterSettings::default(), fonts: FontCache::new(), inactive, tounicode: HashMap::new() }
    }

    /// interpret_page — 쪽 내용과 주석 appearance
    pub fn page(&mut self, page: &Page<'a>) -> Vec<Item<'a>> {
        let mut out = Vec::new();
        let mut cx = Cx::new(Affine::IDENTITY, Rect::new(0.0, 0.0, 1.0, 1.0), Rect::new(0.0, 0.0, 1.0, 1.0), 0);
        let res = page.resources();
        self.interpret(&mut cx, page.typed_operations(), res, &mut out);
        if let Some(annots) = page.raw().get::<Array<'_>>(ANNOTS) {
            for annot in annots.iter::<Dict<'_>>() { self.annotation(&mut cx, &annot, res, &mut out) }
        }
        out
    }

    /// SoftMask::interpret — 마스크 묶음 폼을 새 문맥에서
    pub fn mask(&mut self, m: &MaskRec<'a>) -> Vec<Item<'a>> {
        let mut out = Vec::new();
        let mut cx = Cx::new(m.ctm, m.bbox, m.lbbox, m.depth);
        if let Some(f) = form(&m.group) { self.draw_form(&mut cx, &f, &m.parent, &mut out) }
        out
    }

    fn annotation(&mut self, cx: &mut Cx<'a>, annot: &Dict<'a>, res: &Resources<'a>, out: &mut Vec<Item<'a>>) {
        let flags = annot.get::<u32>(F).unwrap_or(0);
        if flags & (ANNOTATION_HIDDEN | ANNOTATION_NO_VIEW) != 0 { return }
        let ap = annot.get::<Dict<'_>>(AP).and_then(|ap| ap.get::<Object<'_>>(N)).and_then(|n| match n {
            Object::Stream(s) => Some(s),
            Object::Dict(states) => annot.get::<Name<'_>>(AS).and_then(|s| states.get::<Stream<'_>>(s)).or_else(|| states.get::<Stream<'_>>(b"Off")),
            _ => None,
        });
        let Some(apx) = ap.as_ref().and_then(form) else { return };
        let Some(rect) = annot.get::<hayro_syntax::object::Rect>(RECT) else { return };
        let ar = Rect::new(rect.x0, rect.y0, rect.x1, rect.y1);
        let tr = (apx.matrix * Rect::new(apx.bbox[0] as f64, apx.bbox[1] as f64, apx.bbox[2] as f64, apx.bbox[3] as f64).to_path(0.1)).bounding_box();
        let sx = ar.width() / tr.width();
        let sy = ar.height() / tr.height();
        let a = Affine::new([sx, 0.0, 0.0, sy, ar.x0 - sx * tr.x0, ar.y0 - sy * tr.y0]);
        cx.save();
        cx.st_mut().ctm *= a;
        self.draw_form(cx, &apx, res, out);
        cx.restore(out);
    }

    fn xobject_oc(&self, cx: &mut Cx<'a>, dict: &Dict<'_>) -> bool {
        let Some(oc) = dict.get::<Dict<'_>>(OC) else { return false };
        match dict.get_ref(OC) { Some(r) => self.begin_ocg(cx, &oc, r.into()), None => self.begin_ocmd(cx, &oc) }
        true
    }
    fn begin_ocg(&self, cx: &mut Cx<'a>, props: &Dict<'_>, id: ObjectIdentifier) {
        if props.get::<Name<'_>>(TYPE).as_deref() == Some(OCMD) { return self.begin_ocmd(cx, props) }
        let v = cx.visible() && !self.inactive.contains(&id);
        cx.vis.push(v);
    }
    fn begin_ocmd(&self, cx: &mut Cx<'a>, d: &Dict<'_>) {
        let p = d.get::<Name<'_>>(P);
        let mut ids: Vec<ObjectIdentifier> = Vec::new();
        if let Some(arr) = d.get::<Array<'_>>(OCGS) { for it in arr.raw_iter() { if let Some(r) = it.as_obj_ref() { ids.push(r.into()) } } }
        else if let Some(r) = d.get_ref(OCGS) { ids.push(r.into()) }
        let off = |id: &ObjectIdentifier| self.inactive.contains(id);
        let active = if ids.is_empty() { true } else {
            match p.as_ref().map(|n| n.as_ref()) {
                Some(b"AllOn") => ids.iter().all(|i| !off(i)),
                Some(b"AnyOff") => ids.iter().any(off),
                Some(b"AllOff") => ids.iter().all(off),
                _ => ids.iter().any(|i| !off(i)),
            }
        };
        let v = cx.visible() && active;
        cx.vis.push(v);
    }

    /// form.rs FormXObject::draw
    fn draw_form(&mut self, cx: &mut Cx<'a>, f: &Form<'a>, parent: &Resources<'a>, out: &mut Vec<Item<'a>>) {
        if !cx.visible() { return }
        if cx.depth >= MAX_NESTED { return }
        cx.depth += 1;
        let has_oc = self.xobject_oc(cx, &f.dict);
        if !cx.visible() {
            if has_oc { cx.vis.pop(); }
            cx.depth = cx.depth.saturating_sub(1);
            return;
        }
        cx.path.truncate(0);
        cx.path_re.clear();
        cx.save();
        cx.st_mut().ctm *= f.matrix;
        if f.group { let m = cx.st_mut().mask.take(); out.push(Item::Group(m)); }
        out.push(Item::FormBegin(cx.ctm().as_coeffs(), f.bbox));
        out.push(Item::FormClip);
        let res = f.resources.clone().unwrap_or_else(|| parent.clone());
        let data = f.data.clone();
        self.interpret(cx, TypedIter::new(&data), &res, out);
        out.push(Item::FormPop);
        out.push(Item::FormEnd);
        if f.group { out.push(Item::GroupPop) }
        cx.restore(out);
        if has_oc { cx.vis.pop(); }
        cx.depth = cx.depth.saturating_sub(1);
    }

    /// image.rs ImageXObject::new + draw
    fn draw_image(&mut self, cx: &mut Cx<'a>, s: &Stream<'_>, out: &mut Vec<Item<'a>>) {
        let dict = s.dict();
        let Some(w) = dict.get::<u32>(W).or_else(|| dict.get::<u32>(WIDTH)) else { return };
        let Some(h) = dict.get::<u32>(H).or_else(|| dict.get::<u32>(HEIGHT)) else { return };
        if w == 0 || h == 0 { return }
        if !cx.visible() { return }
        let has_oc = self.xobject_oc(cx, dict);
        if !cx.visible() { if has_oc { cx.vis.pop(); } return }
        cx.save();
        let mut m = cx.st_mut().mask.take();
        if dict.contains_key(SMASK_IN_DATA) || dict.contains_key(SMASK) || dict.contains_key(MASK) { m = None }
        out.push(Item::Group(m));
        out.push(Item::Image);
        out.push(Item::GroupPop);
        cx.restore(out);
        if has_oc { cx.vis.pop(); }
    }

    fn resolve_font(&mut self, fd: &Dict<'a>) -> Option<SFont<'a>> {
        match self.fonts.font(fd, &self.settings.font_resolver, &self.settings.cmap_resolver) {
            Some(f) => { let nul = self.nul_map(fd); Some(SFont::Font(f, nul)) }
            None => self.fallback(),
        }
    }
    fn fallback(&self) -> Option<SFont<'a>> { self.fonts.standard_font(StandardFont::Helvetica, &self.settings.font_resolver).map(SFont::Fallback) }

    /// type1·type3 글꼴의 ToUnicode(read_to_unicode 와 같은 읽기) — U+0000 매김을 되살릴 때만 쓴다
    fn nul_map(&mut self, fd: &Dict<'a>) -> Option<Rc<CMap>> {
        let st = fd.get::<Name<'_>>(SUBTYPE);
        if !matches!(st.as_ref().map(|n| n.as_ref()), Some(b"Type1" | b"MMType1" | b"Type3")) { return None }
        let id = fd.obj_id();
        if let Some(id) = id { if let Some(c) = self.tounicode.get(&id) { return c.clone() } }
        let r = self.settings.cmap_resolver.clone();
        let data = fd.get::<Stream<'_>>(TO_UNICODE).and_then(|s| s.decoded_data().ok()).map(|d| d.into_owned())
            .or_else(|| fd.get::<Name<'_>>(TO_UNICODE).and_then(|n| (r)(CMapName::from_bytes(n.as_ref()))).map(|d| d.to_vec()));
        let r2 = self.settings.cmap_resolver.clone();
        let cmap = data.and_then(|d| CMap::parse(&d, move |n| (r2)(n))).map(Rc::new);
        if let Some(id) = id { self.tounicode.insert(id, cmap.clone()); }
        cmap
    }

    /// text.rs append_text_string — 글자마다 다음 자리·폭을 계산해 둔다(바꾼 hayro 의 PositionedGlyph 와 같은 셈)
    fn append(&self, cx: &mut Cx<'a>, bytes: &[u8], glyphs: &mut Vec<GlyphPlan>) {
        let Some(font) = cx.st().text.font.clone() else { return };
        let show = matches!(font, SFont::Font(..)) || bytes.is_ascii();
        let f = font.font();
        let nul = match &font { SFont::Font(_, n) => n.clone(), _ => None };
        let mut i = 0;
        while i < bytes.len() {
            let (code, adv) = f.read_code(bytes, i);
            i += adv;
            let gid = f.map_code(code);
            let is_nul = nul.as_ref().map(|c| c.lookup_bf_string(code) == Some(BfString::Char('\0'))).unwrap_or(false);
            // pdf.js 셈의 자리는 보이지 않는 글자도 센다
            let pj = {
                let h = cx.st().text.horizontal();
                let ga = f.code_advance(code);
                let u = if is_nul { Some("\0".to_string()) } else {
                    let g = match f.glyph(gid, code) { FontGlyph::Outline(g) => g.as_unicode(), FontGlyph::Type3(g) => g.as_unicode() };
                    g.map(|b| match b { BfString::Char(c) => c.to_string(), BfString::String(s) => s })
                };
                let ctm = cx.ctm().as_coeffs();
                cx.ts().pj.glyph(&ctm, if h { ga.x } else { ga.y }, h, u.as_deref())
            };
            if show && cx.visible() {
                let od = f.origin_displacement(code);
                let ts = &cx.st().text;
                let t = ts.full() * Affine::scale(1.0 / UNITS_PER_EM as f64) * Affine::translate(od) * Affine::scale_non_uniform(f.glyph_stretch(gid, code), 1.0);
                let width = f.code_advance(code);
                let h = ts.horizontal();
                let w = (if h { width.x } else { width.y }) as f32 / UNITS_PER_EM * ts.fs;
                let word = if code == 32 && adv == 1 { ts.tw } else { 0.0 };
                let scale = if h { ts.hs() } else { 1.0 };
                let raw = (if h { width.x } else { width.y }) as f32;
                let (aw, at) = (w * scale, (w + ts.tc + word) * scale);
                cx.ts().advance(code, adv);
                let next = cx.st().text.full() * Point::ZERO;
                glyphs.push(GlyphPlan { code, gid: gid.to_u32(), t, next, aw, at, raw, nul: is_nul, pj });
            } else {
                cx.ts().advance(code, adv);
            }
        }
    }

    /// text.rs show_glyph_run
    fn show(&self, cx: &mut Cx<'a>, glyphs: Vec<GlyphPlan>, out: &mut Vec<Item<'a>>) {
        if glyphs.is_empty() { return }
        let mode = cx.st().text.mode;
        if mode >= 4 {
            // 글자 윤곽 클립(Tr 4~7) — ET 에서 한 번에 클립
            let font = cx.st().text.font.clone();
            let mut clip = BezPath::new();
            if let Some(font) = font {
                for g in &glyphs {
                    if let FontGlyph::Outline(o) = font.font().glyph(GlyphId::new(g.gid), g.code) {
                        let p = g.t * o.outline();
                        if p.segments().next().is_some() { clip.extend(p) }
                    }
                }
            }
            cx.ts().clip.extend(clip);
        }
        let mask = cx.st().mask.clone();
        let g = Rc::new(glyphs);
        let run = |m: u8| Item::Run { mode: m, glyphs: g.clone(), mask: mask.clone() };
        match mode {
            0 | 4 => out.push(run(RUN_FILL)),
            1 | 5 => out.push(run(RUN_STROKE)),
            2 | 6 => { out.push(run(RUN_FILL)); out.push(run(RUN_STROKE)) }
            _ => out.push(run(RUN_INVISIBLE)),
        }
    }

    fn ensure_font(&self, cx: &mut Cx<'a>) { if cx.st().text.font.is_none() { cx.ts().font = self.fallback(); } }

    fn show_string(&self, cx: &mut Cx<'a>, bytes: &[u8], out: &mut Vec<Item<'a>>) {
        let mut g = Vec::new();
        self.append(cx, bytes, &mut g);
        let h = cx.st().text.horizontal();
        cx.ts().pj.settle(None, h);
        self.show(cx, g, out);
    }

    /// interpret/mod.rs interpret
    fn interpret(&mut self, cx: &mut Cx<'a>, mut ops: TypedIter<'_>, res: &Resources<'a>, out: &mut Vec<Item<'a>>) {
        let num_states = cx.num_states();
        cx.save();
        while let Some(op) = ops.next() {
            match op {
                TypedInstruction::SaveState(_) => { out.push(Item::Save); cx.save() }
                TypedInstruction::RestoreState(_) => {
                    if cx.num_states() > num_states + 1 { cx.restore(out) }
                    out.push(Item::Restore);
                }
                TypedInstruction::Transform(t) => {
                    let a = Affine::new([t.0.as_f64(), t.1.as_f64(), t.2.as_f64(), t.3.as_f64(), t.4.as_f64(), t.5.as_f64()]);
                    cx.st_mut().ctm *= a;
                }
                TypedInstruction::RectPath(r) => {
                    let rect = Rect::new(r.0.as_f64(), r.1.as_f64(), r.0.as_f64() + r.2.as_f64(), r.1.as_f64() + r.3.as_f64());
                    cx.path_re.push(cx.path.elements().len());
                    cx.path.extend(rect.path_elements(0.1));
                    let p = Point::new(r.0.as_f64(), r.1.as_f64());
                    cx.last = p; cx.sub = p;
                }
                TypedInstruction::MoveTo(m) => {
                    let p = Point::new(m.0.as_f64(), m.1.as_f64());
                    cx.last = p; cx.sub = p;
                    cx.path.move_to(p);
                }
                TypedInstruction::LineTo(m) => {
                    if !cx.path.elements().is_empty() {
                        let lp = cx.last;
                        let mut p = Point::new(m.0.as_f64(), m.1.as_f64());
                        cx.last = p;
                        if lp == p { p.x += 0.0001; }
                        cx.path.line_to(p);
                    }
                }
                TypedInstruction::CubicTo(c) => {
                    if !cx.path.elements().is_empty() {
                        let p1 = Point::new(c.0.as_f64(), c.1.as_f64());
                        let p2 = Point::new(c.2.as_f64(), c.3.as_f64());
                        let p3 = Point::new(c.4.as_f64(), c.5.as_f64());
                        cx.last = p3;
                        cx.path.curve_to(p1, p2, p3);
                    }
                }
                TypedInstruction::CubicStartTo(c) => {
                    if !cx.path.elements().is_empty() {
                        let p1 = cx.last;
                        let p2 = Point::new(c.0.as_f64(), c.1.as_f64());
                        let p3 = Point::new(c.2.as_f64(), c.3.as_f64());
                        cx.last = p3;
                        cx.path.curve_to(p1, p2, p3);
                    }
                }
                TypedInstruction::CubicEndTo(c) => {
                    if !cx.path.elements().is_empty() {
                        let p2 = Point::new(c.0.as_f64(), c.1.as_f64());
                        let p3 = Point::new(c.2.as_f64(), c.3.as_f64());
                        cx.last = p3;
                        cx.path.curve_to(p2, p3, p3);
                    }
                }
                TypedInstruction::ClosePath(_) => cx.close_path(),
                TypedInstruction::FillPathEvenOdd(_) | TypedInstruction::FillPathNonZero(_) | TypedInstruction::FillPathNonZeroCompatibility(_) => {
                    cx.fill(out); cx.end_path(out)
                }
                TypedInstruction::FillAndStrokeEvenOdd(_) | TypedInstruction::FillAndStrokeNonZero(_) => { cx.fill(out); cx.stroke(out); cx.end_path(out) }
                TypedInstruction::CloseAndStrokePath(_) => { cx.close_path(); cx.stroke(out); cx.end_path(out) }
                TypedInstruction::CloseFillAndStrokeEvenOdd(_) | TypedInstruction::CloseFillAndStrokeNonZero(_) => { cx.close_path(); cx.fill(out); cx.stroke(out); cx.end_path(out) }
                TypedInstruction::StrokePath(_) => { cx.stroke(out); cx.end_path(out) }
                // 색 공간 — interpret/mod.rs 의 색 연산자와 같은 순서로 정한다
                TypedInstruction::NonStrokeColorDeviceGray(_) | TypedInstruction::NonStrokeColorDeviceRgb(_) => cx.st_mut().fill_cs = None,
                TypedInstruction::StrokeColorDeviceGray(_) | TypedInstruction::StrokeColorDeviceRgb(_) => cx.st_mut().stroke_cs = None,
                TypedInstruction::NonStrokeColorCmyk(_) => cx.st_mut().fill_cs = Some(Rc::new(Pcs::Cmyk)),
                TypedInstruction::StrokeColorCmyk(_) => cx.st_mut().stroke_cs = Some(Rc::new(Pcs::Cmyk)),
                TypedInstruction::ColorSpaceNonStroke(c) => cx.st_mut().fill_cs = named_cs(c.0, res),
                TypedInstruction::ColorSpaceStroke(c) => cx.st_mut().stroke_cs = named_cs(c.0, res),
                TypedInstruction::EndPath(_) => cx.end_path(out),
                TypedInstruction::ClipNonZero(_) => cx.clip = Some(false),
                TypedInstruction::ClipEvenOdd(_) => cx.clip = Some(true),
                TypedInstruction::SetGraphicsState(gs) => {
                    if let Some(gs) = res.get_ext_g_state(gs.0) { self.gs(cx, &gs, res) }
                }
                TypedInstruction::BeginMarkedContentWithProperties(bdc) => {
                    let oc = bdc.1.clone().into_name().and_then(|name| {
                        let r = res.properties.get_ref(name.as_ref())?;
                        let d = res.properties.get::<Dict<'_>>(name).unwrap_or_default();
                        Some((d, r))
                    }).or_else(|| {
                        let (props, _) = dict_or_stream(bdc.1)?;
                        let r = props.get_ref(OC)?;
                        let d = props.get::<Dict<'_>>(OC).unwrap_or_default();
                        Some((d, r))
                    });
                    match oc { Some((d, r)) => self.begin_ocg(cx, &d, r.into()), None => { let v = cx.visible(); cx.vis.push(v) } }
                    out.push(Item::MarkBegin);
                }
                TypedInstruction::EndMarkedContent(_) => { cx.vis.pop(); out.push(Item::MarkEnd) }
                TypedInstruction::BeginMarkedContent(_) => { let v = cx.visible(); cx.vis.push(v); out.push(Item::MarkBegin) }
                TypedInstruction::BeginText(_) => {
                    out.push(Item::BeginText);
                    let ts = cx.ts(); ts.tm = Affine::IDENTITY; ts.tlm = Affine::IDENTITY; ts.pj.set_matrix(IDENT);
                }
                TypedInstruction::SetTextMatrix(m) => {
                    let c = [m.0.as_f64(), m.1.as_f64(), m.2.as_f64(), m.3.as_f64(), m.4.as_f64(), m.5.as_f64()];
                    let m = Affine::new(c);
                    let ts = cx.ts(); ts.tlm = m; ts.tm = m; ts.pj.set_matrix(c);
                    out.push(Item::TextMatrix);
                }
                TypedInstruction::EndText(_) => {
                    out.push(Item::EndText);
                    if cx.st().text.clip.segments().next().is_some() {
                        let p = cx.ctm() * cx.st().text.clip.clone();
                        cx.push_clip(p, false, Vec::new(), out);
                    }
                    cx.ts().clip.truncate(0);
                }
                TypedInstruction::TextFont(t) => {
                    let name = t.0;
                    let fd = res.get_font(name);
                    let base = fd.as_ref().and_then(|d| d.get::<Name<'_>>(BASE_FONT)).map(|n| String::from_utf8_lossy(n.as_ref()).into_owned()).unwrap_or_default();
                    out.push(Item::Font(String::from_utf8_lossy(name.as_ref()).into_owned(), t.1.as_f32(), base));
                    if let Some(fd) = fd.as_ref() { out.push(Item::FontKey(fd.clone())) }
                    let font = match fd { Some(fd) => self.resolve_font(&fd), None => self.fallback() };
                    let ts = cx.ts(); ts.fs = t.1.as_f32(); ts.font = font; ts.pj.fs = t.1.as_f64();
                }
                TypedInstruction::ShowText(s) => { self.ensure_font(cx); self.show_string(cx, s.0.as_bytes(), out) }
                TypedInstruction::ShowTexts(s) => {
                    self.ensure_font(cx);
                    let mut g = Vec::new();
                    for obj in s.0.iter::<Object<'_>>() {
                        match obj {
                            Object::Number(n) => {
                                cx.ts().adjust(n.as_f32());
                                let h = cx.st().text.horizontal();
                                cx.ts().pj.number(n.as_f64(), h);
                            }
                            Object::String(text) => self.append(cx, text.as_bytes(), &mut g),
                            _ => {}
                        }
                    }
                    let h = cx.st().text.horizontal();
                    cx.ts().pj.settle(None, h);
                    self.show(cx, g, out);
                }
                TypedInstruction::HorizontalScaling(h) => { cx.ts().th = h.0.as_f32(); cx.ts().pj.hs = h.0.as_f64() / 100.0; out.push(Item::HScale(h.0.as_f32())) }
                TypedInstruction::TextLeading(tl) => { cx.ts().tl = tl.0.as_f32(); cx.ts().pj.tl = tl.0.as_f64() }
                TypedInstruction::CharacterSpacing(c) => { cx.ts().tc = c.0.as_f32(); cx.ts().pj.tc = c.0.as_f64() }
                TypedInstruction::WordSpacing(w) => { cx.ts().tw = w.0.as_f32(); cx.ts().pj.tw = w.0.as_f64() }
                TypedInstruction::NextLine(n) => { cx.ts().next_line(n.0.as_f64(), n.1.as_f64()); cx.ts().pj.next_line(n.0.as_f64(), n.1.as_f64()) }
                TypedInstruction::NextLineUsingLeading(_) => { let l = cx.st().text.tl; cx.ts().next_line(0.0, -l as f64); pj_carriage_return(cx) }
                TypedInstruction::NextLineAndShowText(n) => {
                    let l = cx.st().text.tl; cx.ts().next_line(0.0, -l as f64); pj_carriage_return(cx);
                    self.show_string(cx, n.0.as_bytes(), out)
                }
                TypedInstruction::TextRenderingMode(r) => { let m = r.0.as_i64(); cx.ts().mode = if (0..=7).contains(&m) { m as u8 } else { 0 } }
                TypedInstruction::NextLineAndSetLeading(n) => {
                    let (tx, ty) = (n.0.as_f64(), n.1.as_f64());
                    cx.ts().tl = -ty as f32;
                    cx.ts().next_line(tx, ty);
                    cx.ts().pj.tl = -ty; cx.ts().pj.next_line(tx, ty);
                }
                TypedInstruction::XObject(x) => {
                    out.push(Item::XObject(String::from_utf8_lossy(x.0.as_ref()).into_owned()));
                    if let Some(s) = res.get_x_object(x.0) {
                        match s.dict().get::<Name<'_>>(SUBTYPE).as_deref() {
                            Some(IMAGE) => self.draw_image(cx, &s, out),
                            Some(FORM) => { if let Some(f) = form(&s) { self.draw_form(cx, &f, res, out) } }
                            _ => {}
                        }
                    }
                }
                TypedInstruction::InlineImage(i) => self.draw_image(cx, i.0, out),
                TypedInstruction::TextRise(t) => { cx.ts().rise = t.0.as_f32(); cx.ts().pj.rise = t.0.as_f64() }
                TypedInstruction::Shading(s) => {
                    if !cx.visible() { continue }
                    // 음영은 hayro 가 만들 수 있을 때만 칠한다 — 만들 수 있는지는 장치에 온 콜백으로 맞춘다
                    if res.get_shading(s.0).is_some() {
                        cx.save();
                        out.push(Item::Shade { mask: cx.st().mask.clone(), ctm: cx.ctm(), nb: cx.bbox(), lb: cx.lbbox() });
                        cx.restore(out);
                    }
                }
                TypedInstruction::ShowTextWithParameters(t) => {
                    cx.ts().tw = t.0.as_f32();
                    cx.ts().tc = t.1.as_f32();
                    cx.ts().pj.tw = t.0.as_f64(); cx.ts().pj.tc = t.1.as_f64();
                    let l = cx.st().text.tl; cx.ts().next_line(0.0, -l as f64); pj_carriage_return(cx);
                    self.show_string(cx, t.2.as_bytes(), out)
                }
                _ => {}
            }
        }
        cx.path.truncate(0);
        cx.path_re.clear();
        cx.clip = None;
        while cx.num_states() > num_states { cx.restore(out) }
    }

    /// state.rs handle_gs — 콜백에 영향을 주는 SMask·Font 만
    fn gs(&mut self, cx: &mut Cx<'a>, d: &Dict<'a>, res: &Resources<'a>) {
        for key in d.keys() {
            match key.as_ref() {
                // state.rs "TR" | "TR2" — 이름이면 끄고, 함수를 읽으면 켠다(못 읽으면 그대로)
                b"TR" | b"TR2" => {
                    let o = d.get::<Object<'_>>(TR2).or_else(|| d.get::<Object<'_>>(TR));
                    let on = match o {
                        None => None,
                        Some(Object::Name(_)) => Some(false),
                        Some(Object::Array(a)) => { let mut it = a.iter::<Object<'_>>(); (0..4).all(|_| it.next().and_then(|o| Function::new(&o)).is_some()).then_some(true) }
                        Some(o) => Function::new(&o).map(|_| true),
                    };
                    if let Some(on) = on { cx.st_mut().tr = on }
                }
                b"SMask" => {
                    if let Some(n) = d.get::<Name<'_>>(SMASK) {
                        if n.as_ref() == b"None" { cx.st_mut().mask = None }
                    } else {
                        let rec = d.get::<Dict<'_>>(SMASK).and_then(|sm: Dict<'a>| {
                            let g = sm.get::<Stream<'_>>(G)?;
                            form(&g)?;
                            match sm.get::<Name<'_>>(S).as_deref() {
                                Some(LUMINOSITY) => { g.dict().get::<Dict<'_>>(GROUP)?.get::<Object<'_>>(CS)?; }
                                Some(ALPHA) => {}
                                _ => return None,
                            }
                            let pk = g.dict().get::<Dict<'_>>(RESOURCES).is_none().then(|| res.cache_key());
                            let key = (sm.cache_key(), pk, cx.ctm().cache_key(), cx.lbbox().cache_key());
                            Some(Rc::new(MaskRec { group: g, parent: res.clone(), ctm: cx.ctm(), bbox: cx.bbox(), lbbox: cx.lbbox(), depth: cx.depth + 1, key }))
                        });
                        cx.st_mut().mask = rec;
                    }
                }
                b"Font" => {
                    let Some(arr) = d.get::<Array<'_>>(FONT) else { continue };
                    let mut it = arr.iter::<Object<'_>>();
                    let Some(fd) = it.next().and_then(|o| o.into_dict()) else { continue };
                    let Some(size) = it.next().and_then(|o| o.into_number()) else { continue };
                    let font = self.resolve_font(&fd);
                    let ts = cx.ts(); ts.fs = size.as_f32(); ts.font = font;
                }
                _ => {}
            }
        }
    }
}

/// 색 공간 — 예전 패치(pdf.js 색)의 hayro 색 공간을 그대로 옮겼다. ICCBased 는 Alternate(성분 수가 맞을 때)나 N 의 장치 공간,
/// DeviceCMYK 는 Adobe 다항식. Other 는 CalGray·CalRGB·Lab·Pattern(성분 수) — 여기서 셈하지 않는다
pub enum Pcs { Gray, Rgb, Cmyk, Indexed(Rc<Pcs>, u8, Vec<Vec<u8>>), Sep(Rc<Pcs>, Function), DevN(Rc<Pcs>, u8, Function), Other(u8) }

/// interpret/mod.rs cs·CS — 이름 공간, 아니면 자원의 색 공간, 못 읽으면 DeviceGray. pdf.js 셈이 hayro 와 같으면 None
fn named_cs(name: &Name<'_>, res: &Resources<'_>) -> Option<Rc<Pcs>> {
    let p = match cs_from_name(name.as_ref()) { Some(p) => Some(p), None => res.get_color_space(name).and_then(|o| parse_cs(o, 0)) };
    p.filter(|(_, changed)| *changed).map(|(p, _)| Rc::new(p))
}

/// color/mod.rs new_from_name — (공간, pdf.js 셈이 다른가)
fn cs_from_name(n: &[u8]) -> Option<(Pcs, bool)> {
    match n {
        b"DeviceRGB" | b"RGB" => Some((Pcs::Rgb, false)),
        b"DeviceGray" | b"G" => Some((Pcs::Gray, false)),
        b"DeviceCMYK" | b"CMYK" | b"CalCMYK" => Some((Pcs::Cmyk, true)),
        b"Pattern" => Some((Pcs::Other(3), false)),
        _ => None,
    }
}

/// color/mod.rs ColorSpaceType::new(_inner) — pdf.js 색 모드(ICCBased → Alternate·장치 공간)
fn parse_cs(o: Object<'_>, depth: u8) -> Option<(Pcs, bool)> {
    if depth >= 32 { return None }
    let a = match o { Object::Name(n) => return cs_from_name(n.as_ref()), Object::Array(a) => a, _ => return None };
    let mut it = a.flex_iter();
    let name = it.next::<Name<'_>>()?;
    match name.as_ref() {
        b"ICCBased" => {
            let s = it.next::<Stream<'_>>()?;
            let n = s.dict().get::<usize>(N)?;
            let alt = s.dict().get::<Object<'_>>(ALTERNATE).and_then(|o| parse_cs(o, depth + 1)).filter(|(p, _)| p.n() as usize == n);
            alt.map(|(p, _)| p).or_else(|| match n { 1 => Some(Pcs::Gray), 3 => Some(Pcs::Rgb), 4 => Some(Pcs::Cmyk), _ => None }).map(|p| (p, true))
        }
        b"CalCMYK" | b"DeviceCMYK" | b"CMYK" => Some((Pcs::Cmyk, true)),
        b"DeviceRGB" | b"RGB" => Some((Pcs::Rgb, false)),
        b"DeviceGray" | b"G" => Some((Pcs::Gray, false)),
        b"CalGray" => { it.next::<Dict<'_>>()?; Some((Pcs::Other(1), false)) }
        b"CalRGB" | b"Lab" => { it.next::<Dict<'_>>()?; Some((Pcs::Other(3), false)) }
        b"Indexed" | b"I" => {
            let (base, ch) = parse_cs(it.next::<Object<'_>>()?, depth + 1)?;
            let hival = it.next::<u32>()?.min(u8::MAX as u32) as u8;
            let data = it.next::<Stream<'_>>().and_then(|s| s.decoded_data().ok()).map(|d| d.into_owned()).or_else(|| it.next::<hayro_syntax::object::String<'_>>().map(|s| s.to_vec()))?;
            let bn = base.n() as usize;
            let mut bytes = data.iter().copied();
            let mut values = Vec::with_capacity(hival as usize + 1);
            for _ in 0..=hival { let mut v = Vec::with_capacity(bn); for _ in 0..bn { v.push(bytes.next()?) } values.push(v) }
            Some((Pcs::Indexed(Rc::new(base), hival, values), ch))
        }
        b"Separation" => {
            it.next::<Name<'_>>()?;
            let (alt, ch) = parse_cs(it.next::<Object<'_>>()?, depth + 1)?;
            let f = Function::new(&it.next::<Object<'_>>()?)?;
            Some((Pcs::Sep(Rc::new(alt), f), ch))
        }
        b"DeviceN" => {
            let n = u8::try_from(it.next::<Array<'_>>()?.iter::<Name<'_>>().count()).ok()?;
            let (alt, ch) = parse_cs(it.next::<Object<'_>>()?, depth + 1)?;
            let f = Function::new(&it.next::<Object<'_>>()?)?;
            if n == 0 || n as usize > 32 { return None }
            Some((Pcs::DevN(Rc::new(alt), n, f), ch))
        }
        b"Pattern" => {
            let inner = it.next::<Object<'_>>().and_then(|o| parse_cs(o, depth + 1)).map(|(p, _)| p.n()).unwrap_or(3);
            Some((Pcs::Other(inner), false))
        }
        _ => None,
    }
}

impl Pcs {
    fn n(&self) -> u8 { match self { Pcs::Gray | Pcs::Indexed(..) | Pcs::Sep(..) => 1, Pcs::Rgb => 3, Pcs::Cmyk => 4, Pcs::DevN(_, n, _) => *n, Pcs::Other(n) => *n } }
    fn initial(&self) -> Vec<f32> {
        match self { Pcs::Cmyk => vec![0.0, 0.0, 0.0, 1.0], Pcs::Sep(..) => vec![1.0], Pcs::DevN(_, n, _) => vec![1.0; *n as usize], p => vec![0.0; p.n() as usize] }
    }
    /// color/mod.rs encode_values
    fn encode(&self, input: &[f32]) -> Vec<u8> {
        let n = self.n() as usize;
        let mut v: Vec<f32> = input[..input.len().min(n)].to_vec();
        if v.len() < n { let init = self.initial(); v.extend_from_slice(&init[v.len()..]) }
        match self {
            Pcs::Indexed(_, hival, _) => v.iter().map(|x| (*x + 0.5).clamp(0.0, *hival as f32) as u8).collect(),
            _ => v.iter().map(|x| (*x * 255.0 + 0.5) as u8).collect(),
        }
    }
    /// 화소 하나(ToRgb::convert) — Other 는 셈하지 않는다
    fn px(&self, i: &[u8]) -> Option<[u8; 3]> {
        Some(match self {
            Pcs::Gray => [i[0]; 3],
            Pcs::Rgb => [i[0], i[1], i[2]],
            Pcs::Cmyk => adobe_cmyk(i[0], i[1], i[2], i[3]),
            Pcs::Indexed(base, hival, values) => base.px(&values[i[0].min(*hival) as usize])?,
            Pcs::Sep(alt, f) | Pcs::DevN(alt, _, f) => {
                let x: Vec<f32> = i.iter().map(|v| *v as f32 * (1.0 / 255.0)).collect();
                let mut out = vec![0.0; f.num_outputs()];
                let enc = if f.eval(&x, &mut out).is_some() { alt.encode(&out) } else { alt.encode(&alt.initial()) };
                alt.px(&enc)?
            }
            Pcs::Other(_) => return None,
        })
    }
    /// 성분(sc·scn·k 값) → RGB. ColorSpace::to_rgba 와 같은 셈
    pub fn rgb(&self, comps: &[f32]) -> Option<[u8; 3]> { self.px(&self.encode(comps)) }
}

/// pdf.js DeviceCmykCS (Apache-2.0) — Adobe CMYK → sRGB 다항식, Uint8ClampedArray 처럼 반올림(동점은 짝수)
fn adobe_cmyk(c: u8, m: u8, y: u8, k: u8) -> [u8; 3] {
    let s = 1.0 / 255.0;
    let (c, m, y, k) = (c as f32 * s, m as f32 * s, y as f32 * s, k as f32 * s);
    let r = 255.0 + c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k + -285.2331026137004)
        + m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366)
        + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813)
        + k * (-21.86122147463605 * k - 189.48180835922747);
    let g = 255.0 + c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k + -79.2970844816548)
        + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951)
        + y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878)
        + k * (-20.737325471181034 * k - 187.80453709719578);
    let b = 255.0 + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k + -14.183576799673286)
        + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248)
        + y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505)
        + k * (-22.33816807309886 * k - 180.12613974708367);
    [r.clamp(0.0, 255.0).round_ties_even() as u8, g.clamp(0.0, 255.0).round_ties_even() as u8, b.clamp(0.0, 255.0).round_ties_even() as u8]
}
