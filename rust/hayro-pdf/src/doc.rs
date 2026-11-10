//! kordoc 어댑터용 문서 — 쪽마다 사건열(f64 배열)과 문자열 표(\u{1} 구분), 글꼴·그림·렌더·정보 사전·링크 주석
use hayro_interpret::font::GlyphRun;
use hayro_interpret::hayro_cmap::BfString;
use hayro_interpret::kurbo::{Affine, BezPath, PathEl, Rect, Shape};
use hayro_interpret::{
    interpret_page, BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image,
    ImageDrawProps, InterpreterCache, InterpreterSettings, SoftMask,
};
use crate::shadow::{fast_bbox, path_as_rect, ClipShape, Item, MaskRec, Shadow, RUN_FILL, RUN_INVISIBLE, RUN_STROKE};
use std::rc::Rc;
use hayro_syntax::Pdf;
use hayro_syntax::object::{Array, Dict, Name, Number, Object, Stream};
use std::collections::HashMap;

/// 글꼴 정보(JSON)와 TrueType 글꼴 파일 — 문서 전체에서 글꼴 사전 객체마다 한 번
pub struct FontEntry { pub info: String, pub file: Vec<u8> }
/// 디코딩한 작은 그림 — pdfjs ImageKind(2 RGB, 3 RGBA)와 화소
pub struct ImageEntry { pub width: u32, pub height: u32, pub kind: u8, pub data: Vec<u8> }

fn json_str(v: &str) -> String {
    let mut o = String::from("\"");
    for c in v.chars() { match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)), c => o.push(c) } }
    o.push('"'); o
}

fn font_entry(fd: &Dict<'_>) -> FontEntry {
    let name_of = |d: &Dict<'_>, k: &[u8]| d.get::<Name<'_>>(k).map(|n| n.as_str().to_string()).unwrap_or_default();
    let subtype = name_of(fd, b"Subtype");
    let base = name_of(fd, b"BaseFont");
    let composite = subtype == "Type0";
    // /Differences — 코드 → 글리프 이름
    let mut diffs: Vec<(u32, String)> = Vec::new();
    if let Some(enc) = fd.get::<Dict<'_>>(b"Encoding") {
        if let Some(arr) = enc.get::<Array<'_>>(b"Differences") {
            let mut code = 0u32;
            for o in arr.iter::<Object<'_>>() {
                match o { Object::Number(n) => code = n.as_f64() as u32, Object::Name(n) => { diffs.push((code, n.as_str().to_string())); code += 1 } _ => {} }
            }
        }
    }
    // ToUnicode 표 — 코드 공간을 훑어 있는 것만
    let mut tu: Vec<(u32, String)> = Vec::new();
    if let Some(data) = fd.get::<Stream<'_>>(b"ToUnicode").and_then(|s| s.decoded().ok()) {
        if let Some(cmap) = hayro_interpret::hayro_cmap::CMap::parse(&data, |_| None) {
            let max = if composite { 0xffff } else { 0xff };
            for code in 0..=max {
                match cmap.lookup_bf_string(code) {
                    Some(BfString::Char(c)) => tu.push((code, c.to_string())),
                    Some(BfString::String(s)) => tu.push((code, s)),
                    None => {}
                }
            }
        }
    }
    // TrueType 글꼴 파일(FontFile2) — 복합 글꼴은 자손 글꼴의 서술자
    let desc_font = if composite { fd.get::<Array<'_>>(b"DescendantFonts").and_then(|a| a.iter::<Dict<'_>>().next()) } else { Some(fd.clone()) };
    let file = desc_font.as_ref().and_then(|d| d.get::<Dict<'_>>(b"FontDescriptor")).and_then(|fdesc| fdesc.get::<Stream<'_>>(b"FontFile2")).and_then(|s| s.decoded().ok()).map(|c| c.to_vec()).unwrap_or_default();
    let mut info = format!("{{\"name\":{},\"subtype\":{},\"composite\":{},\"differences\":[", json_str(&base), json_str(&subtype), composite);
    for (k, (c, n)) in diffs.iter().enumerate() { if k > 0 { info.push(',') } info.push_str(&format!("[{},{}]", c, json_str(n))) }
    info.push_str("],\"toUnicode\":[");
    for (k, (c, u)) in tu.iter().enumerate() { if k > 0 { info.push(',') } info.push_str(&format!("[{},{}]", c, json_str(u))) }
    info.push_str("]}");
    let _ = Number::ZERO;
    FontEntry { info, file }
}

pub const GLYPH: f64 = 1.0;
pub const SAVE: f64 = 2.0;
pub const RESTORE: f64 = 3.0;
pub const BEGIN_TEXT: f64 = 4.0;
pub const END_TEXT: f64 = 5.0;
pub const FONT: f64 = 6.0;
pub const XOBJECT: f64 = 7.0;
pub const MARK_BEGIN: f64 = 8.0;
pub const MARK_END: f64 = 9.0;
pub const CLIP_PUSH: f64 = 10.0;
pub const CLIP_POP: f64 = 11.0;
pub const RUN_END: f64 = 12.0;
pub const TEXT_MATRIX: f64 = 13.0;
pub const PATH: f64 = 20.0;
pub const IMAGE: f64 = 21.0;
pub const FORM_BEGIN: f64 = 22.0;
pub const FORM_END: f64 = 23.0;
pub const FONT_KEY: f64 = 24.0;
/// 소프트 마스크(ExtGState /SMask) 그룹의 내용 — pdfjs 는 gs 때 그 폼의 연산자를 그대로 끼워 넣는다. 글 추출은 이 구간을 건너뛴다
pub const SMASK_BEGIN: f64 = 25.0;
pub const SMASK_END: f64 = 26.0;
/// Tz(가로 비율, 퍼센트) — 글 추출 문턱은 pdfjs 처럼 Tz 를 빼고 잰다
pub const HSCALE: f64 = 27.0;

struct Events<'f, 'a> { fonts: &'f mut HashMap<String, FontEntry>, image_pages: &'f mut HashMap<String, usize>, page: usize, inline_n: usize, buf: Vec<f64>, strs: Vec<String>, last_fill: Option<(usize, f64, f64)>,
    /// 이미 내용을 낸 소프트 마스크 — pdfjs 는 같은 ExtGState 를 다시 써도 한 번만 낸다
    masks: std::collections::HashSet<(u128, Option<u128>, u128, u128)>,
    /// 그림자 해석기와 그 계획(맨 위가 지금 해석 중인 쪽 또는 소프트 마스크)
    shadow: &'f mut Shadow<'a>, plans: Vec<std::vec::IntoIter<Item<'a>>>,
    /// 콜백과 계획이 어긋난 첫 자리 — 이 쪽은 오류로 돌려준다
    err: Option<String> }

fn push_path(buf: &mut Vec<f64>, path: &BezPath) { push_path_form(buf, path, &[]) }

/// 경로 요소 — `re` 로 시작한 하위 경로(요소 자리 re)의 MoveTo 는 5 로 적는다(연산자 목록이 사각형으로 낸다)
fn push_path_form(buf: &mut Vec<f64>, path: &BezPath, re: &[usize]) {
    let n_at = buf.len(); buf.push(0.0);
    let mut n = 0.0;
    for (k, el) in path.elements().iter().enumerate() {
        match *el {
            PathEl::MoveTo(p) => buf.extend_from_slice(&[if re.contains(&k) { 5.0 } else { 0.0 }, p.x, p.y]),
            PathEl::LineTo(p) => buf.extend_from_slice(&[1.0, p.x, p.y]),
            PathEl::QuadTo(a, p) => buf.extend_from_slice(&[2.0, a.x, a.y, p.x, p.y]),
            PathEl::CurveTo(a, b, p) => buf.extend_from_slice(&[3.0, a.x, a.y, b.x, b.y, p.x, p.y]),
            PathEl::ClosePath => buf.push(4.0),
        }
        n += 1.0;
    }
    buf[n_at] = n;
}

fn paint_rgba(p: &hayro_interpret::Paint<'_>) -> [f64; 4] {
    match p {
        hayro_interpret::Paint::Color(c) => { let v = c.to_rgba().to_rgba8(); [v[0] as f64, v[1] as f64, v[2] as f64, v[3] as f64] }
        _ => [-1.0, -1.0, -1.0, 255.0],
    }
}

fn image_id(r: &hayro_interpret::RasterImage<'_>, page: usize, inline_n: &mut usize) -> String {
    let oid = r.stream().obj_id();
    if oid.obj_number > 0 { format!("g_hy_{}_{}", oid.obj_number, oid.gen_number) } else { *inline_n += 1; format!("hy_p{}_{}", page, inline_n) }
}

fn decode_raster(r: &hayro_interpret::RasterImage<'_>) -> Option<ImageEntry> {
    let mut entry: Option<ImageEntry> = None;
    r.with_rgba(|data, alpha| {
        let (iw, ih) = (data.width(), data.height());
        let n = (iw * ih) as usize;
        let rgb: Vec<u8> = match data {
            hayro_interpret::ImageData::Rgb(d) => d.data,
            hayro_interpret::ImageData::Luma(d) => d.data.iter().flat_map(|&v| [v, v, v]).collect(),
        };
        if rgb.len() != n * 3 { return }
        entry = Some(match alpha.filter(|a| a.data.len() == n && a.width == iw && a.height == ih) {
            Some(a) => { let mut o = Vec::with_capacity(n * 4); for k in 0..n { o.extend_from_slice(&rgb[k * 3..k * 3 + 3]); o.push(a.data[k]) } ImageEntry { width: iw, height: ih, kind: 3, data: o } }
            None => ImageEntry { width: iw, height: ih, kind: 2, data: rgb },
        });
    }, None);
    entry
}

/// 그림만 디코딩하는 Device — kordoc 이 그림을 요청할 때 그 쪽을 다시 해석한다
struct Decoder<'f> { images: &'f HashMap<String, ImageEntry>, got: HashMap<String, ImageEntry>, page: usize, inline_n: usize }

impl Device<'_> for Decoder<'_> {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'_>, _: &DrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'_>>, _: BlendMode, _: bool, _: bool) {}
    fn draw_glyph_run(&mut self, _: &GlyphRun<'_, '_>, _: DrawProps<'_>, _: &DrawMode) {}
    fn draw_image(&mut self, img: Image<'_, '_>, _: ImageDrawProps<'_>) {
        if let Image::Raster(r) = &img {
            let id = image_id(r, self.page, &mut self.inline_n);
            // 화소 3,600만 이하(image-extract MAX_PIXELS)
            if !self.images.contains_key(&id) && !self.got.contains_key(&id) && (r.width() as f64) * (r.height() as f64) <= 36_000_000.0 {
                if let Some(e) = decode_raster(r) { self.got.insert(id, e); }
            }
        }
    }
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}
}

/// `sh` 칠하기 — 음영 무늬 행렬이 항등에 그때 CTM(root transform)만 곱한 것이라 그리기 행렬과 같다
fn is_shade(props: &DrawProps<'_>) -> bool {
    matches!(&props.paint, hayro_interpret::Paint::Pattern(p) if matches!(p.as_ref(), hayro_interpret::pattern::Pattern::Shading(sp) if sp.matrix == props.transform))
}

fn same_path(a: &BezPath, b: &BezPath) -> bool { a.elements() == b.elements() }

/// path.rs fill_path_impl 의 그리기 — (사건 코드, 선 굵기, 사각형, 경로). 넓이가 거의 0 이면 대각선 긋기
fn fill_shape(t: &Affine, path: &BezPath) -> (f64, f64, Option<Rect>, BezPath) {
    use hayro_interpret::util::Float32Ext;
    let bb = fast_bbox(path);
    let (xa, ya) = hayro_interpret::util::x_y_advances(t);
    if !((bb.width() * xa.length()) as f32).is_nearly_zero() && !((bb.height() * ya.length()) as f32).is_nearly_zero() {
        return match path_as_rect(path) { Some(r) => (1.0, -1.0, Some(r), BezPath::new()), None => (1.0, -1.0, None, path.clone()) };
    }
    let mut p = BezPath::new();
    p.move_to((bb.x0, bb.y0));
    p.line_to((bb.x1, bb.y1));
    let scale = xa.length().max(ya.length()) as f32;
    let lw: f32 = if scale > 0.0 { 1.0 / scale } else { 0.001 };
    (3.0, lw as f64, None, p)
}

impl<'a> Events<'_, 'a> {
    fn fail(&mut self, msg: String) { if self.err.is_none() { self.err = Some(msg) } }
    fn s(&mut self, v: String) -> f64 { self.strs.push(v); (self.strs.len() - 1) as f64 }

    /// 클립 — 콘텐츠가 그린 경로(장치 공간)와 채우기 규칙 그대로
    fn emit_clip(&mut self, c: &ClipShape) {
        self.buf.extend_from_slice(&[CLIP_PUSH, if c.even_odd { 1.0 } else { 0.0 }]);
        push_path_form(&mut self.buf, &c.path, &c.re);
    }

    /// 구조 사건과 hayro 가 생략한 덮는 클립은 여기서 낸다. 콜백 자리면 그대로 돌려준다
    fn structural(&mut self, it: Item<'a>) -> Option<Item<'a>> {
        match it {
            Item::Save => self.buf.push(SAVE),
            Item::Restore => self.buf.push(RESTORE),
            Item::BeginText => self.buf.push(BEGIN_TEXT),
            Item::EndText => self.buf.push(END_TEXT),
            Item::TextMatrix => self.buf.push(TEXT_MATRIX),
            Item::FormEnd => self.buf.push(FORM_END),
            Item::Font(n, size, b) => { let n = self.s(n); let b = self.s(b); self.buf.extend_from_slice(&[FONT, n, size as f64, b]) }
            Item::FontKey(fd) => {
                let key = fd.obj_id().map(|id| format!("hy_{}_{}", id.obj_number, id.gen_number)).unwrap_or_default();
                if !key.is_empty() {
                    if !self.fonts.contains_key(&key) { let e = font_entry(&fd); self.fonts.insert(key.clone(), e); }
                    let k = self.s(key);
                    self.buf.extend_from_slice(&[FONT_KEY, k]);
                }
            }
            Item::XObject(n) => { let n = self.s(n); self.buf.extend_from_slice(&[XOBJECT, n]) }
            Item::FormBegin(m, b) => self.buf.extend_from_slice(&[FORM_BEGIN, m[0], m[1], m[2], m[3], m[4], m[5], b[0] as f64, b[1] as f64, b[2] as f64, b[3] as f64]),
            Item::HScale(h) => self.buf.extend_from_slice(&[HSCALE, h as f64]),
            Item::Clip(false, c) => self.emit_clip(&c),
            Item::Pop(false) => self.buf.push(CLIP_POP),
            other => return Some(other),
        }
        None
    }

    /// 다음 콜백 자리. `sh` 자리는 콜백이 음영 칠하기일 때만 맞고, 아니면 hayro 가 음영을 못 만든 것으로 보고 건너뛴다
    fn next(&mut self, what: &str, shade: bool) -> Option<Item<'a>> {
        if self.err.is_some() { return None }
        loop {
            let Some(it) = self.plans.last_mut().and_then(|p| p.next()) else { self.fail(format!("p{}: callback {} past the end of the plan", self.page, what)); return None };
            match self.structural(it) {
                None => continue,
                Some(Item::Shade { .. }) if !shade => continue,
                Some(it) => return Some(it),
            }
        }
    }

    fn mismatch(&mut self, what: &str, it: &Item<'a>) {
        let exp = match it { Item::Run { .. } => "Run", Item::Draw(..) => "Draw", Item::Shade { .. } => "Shade", Item::Clip(..) => "Clip", Item::Pop(_) => "Pop", Item::FormClip => "FormClip", Item::FormPop => "FormPop",
            Item::Group(_) => "Group", Item::GroupPop => "GroupPop", Item::Image => "Image", Item::MarkBegin => "MarkBegin", Item::MarkEnd => "MarkEnd", _ => "?" };
        self.fail(format!("p{}: callback {} but plan expects {}", self.page, what, exp));
    }

    /// 계획 끝 — 남은 구조 사건·생략 클립을 내고, 콜백 자리가 남았으면 오류
    fn finish(&mut self) {
        let Some(p) = self.plans.pop() else { return };
        for it in p {
            if self.err.is_some() { return }
            match self.structural(it) {
                None | Some(Item::Shade { .. }) => {}
                Some(it) => self.mismatch("<none>", &it),
            }
        }
    }

    /// 소프트 마스크 그룹 폼의 내용을 사건열에 낸다(처음 볼 때 한 번)
    fn mask(&mut self, m: Option<&SoftMask<'a>>, rec: Option<&Rc<MaskRec<'a>>>) {
        let Some(m) = m else { return };
        let Some(rec) = rec.cloned() else { self.fail(format!("p{}: soft mask without a shadow record", self.page)); return };
        if !self.masks.insert(rec.key) { return }
        let plan = self.shadow.mask(&rec);
        self.buf.push(SMASK_BEGIN);
        self.plans.push(plan.into_iter());
        m.interpret(self);
        self.finish();
        self.buf.push(SMASK_END);
    }

    fn draw(&mut self, rect: Option<&Rect>, path: Option<&BezPath>, props: &DrawProps<'a>, mode: &DrawMode) {
        let Some(it) = self.next("draw", is_shade(props)) else { return };
        let (rec, legacy, cs, form) = match it {
            Item::Draw(m, cs, form) => (m, None, cs, Some(form)),
            // 예전 bbox 와 다르면 음영 영역을 예전 bbox 로 다시 만든다 — hayro 가 지금 bbox 로 그린 것과 같은지 먼저 확인한다
            Item::Shade { mask, ctm, nb, lb } => {
                let legacy = (nb != lb).then(|| {
                    let (ec, _, er, ep) = fill_shape(&props.transform, &(ctm.inverse() * nb.to_path(0.1)));
                    let code = if matches!(mode, DrawMode::Stroke(_)) { 3.0 } else { 1.0 };
                    let same = ec == code && match (rect, path, er) { (Some(r), _, Some(e)) => *r == e, (_, Some(p), None) => same_path(p, &ep), _ => false };
                    same.then(|| fill_shape(&props.transform, &(ctm.inverse() * lb.to_path(0.1))))
                }).flatten();
                (mask, legacy, None, None)
            }
            it => return self.mismatch("draw", &it)
        };
        if let Some((code, lw, r, p)) = legacy {
            self.mask(props.soft_mask.as_ref(), rec.as_ref());
            let c = paint_rgba(&props.paint);
            let t = props.transform.as_coeffs();
            self.buf.extend_from_slice(&[PATH, code, c[0], c[1], c[2], c[3], lw, t[0], t[1], t[2], t[3], t[4], t[5]]);
            match r { Some(r) => self.buf.extend_from_slice(&[-1.0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0]), None => push_path(&mut self.buf, &p) }
            return;
        }
        let (code, lw) = match mode {
            DrawMode::Fill(r) => (if matches!(r, hayro_interpret::FillRule::EvenOdd) { 2.0 } else { 1.0 }, -1.0),
            DrawMode::Stroke(sp) => (3.0, sp.line_width as f64),
            DrawMode::FillAndStroke(r, sp) => (if matches!(r, hayro_interpret::FillRule::EvenOdd) { 5.0 } else { 4.0 }, sp.line_width as f64),
            DrawMode::Invisible => return,
        };
        self.mask(props.soft_mask.as_ref(), rec.as_ref());
        let mut c = paint_rgba(&props.paint);
        // ICCBased·DeviceCMYK 를 거치는 색은 pdf.js 셈(Alternate·Adobe 다항식)으로 — hayro 는 ICC 프로파일로 바꾼다
        if let (Some(cs), hayro_interpret::Paint::Color(col)) = (cs, &props.paint) {
            if let Some(v) = cs.rgb(col.components()) { c[0] = v[0] as f64; c[1] = v[1] as f64; c[2] = v[2] as f64 }
        }
        let t = props.transform.as_coeffs();
        self.buf.extend_from_slice(&[PATH, code, c[0], c[1], c[2], c[3], lw, t[0], t[1], t[2], t[3], t[4], t[5]]);
        // 콘텐츠가 그린 경로 그대로(hayro 는 사각형 모양이면 사각형으로 준다). 넓이 없는 채움을 hayro 가 대각선 긋기로 바꾼 것은 hayro 모양
        let form = form.filter(|f| match (rect, path) { (Some(r), _) => path_as_rect(&f.path) == Some(*r), (_, Some(p)) => same_path(p, &f.path), _ => false });
        if let Some(f) = form { push_path_form(&mut self.buf, &f.path, &f.re) }
        else if let Some(r) = rect { self.buf.extend_from_slice(&[-1.0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0]) }
        else if let Some(p) = path { push_path(&mut self.buf, p) }
    }
}

impl<'a> Device<'a> for Events<'_, 'a> {
    fn draw_path(&mut self, path: &BezPath, props: DrawProps<'a>, mode: &DrawMode) { self.draw(None, Some(path), &props, mode) }
    fn draw_rect(&mut self, rect: &Rect, props: DrawProps<'a>, mode: &DrawMode) { self.draw(Some(rect), None, &props, mode) }
    fn push_clip_path(&mut self, cp: &ClipPath) {
        let Some(it) = self.next("push_clip_path", false) else { return };
        match it {
            // 폼 bbox 클립 — pdfjs 연산자 목록에 없으므로 내지 않는다
            Item::FormClip => {}
            Item::Clip(true, c) if c.rect.is_none() => {
                let rule = matches!(cp.fill, hayro_interpret::FillRule::EvenOdd);
                if !same_path(&c.path, &cp.path) || c.even_odd != rule { return self.fail(format!("p{}: clip path differs from the plan", self.page)) }
                self.emit_clip(&c);
            }
            it => self.mismatch("push_clip_path", &it),
        }
    }
    fn push_clip_rect(&mut self, r: &Rect) {
        let Some(it) = self.next("push_clip_rect", false) else { return };
        match it {
            Item::Clip(true, c) if c.rect.is_some() => {
                if c.rect != Some(*r) { return self.fail(format!("p{}: clip rect differs from the plan", self.page)) }
                self.emit_clip(&c);
            }
            it => self.mismatch("push_clip_rect", &it),
        }
    }
    fn push_transparency_group(&mut self, _: f32, m: Option<SoftMask<'a>>, _: BlendMode, _: bool, _: bool) {
        let Some(it) = self.next("push_transparency_group", false) else { return };
        match it { Item::Group(rec) => self.mask(m.as_ref(), rec.as_ref()), it => self.mismatch("push_transparency_group", &it) }
    }
    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, mode: &DrawMode) {
        let Some(it) = self.next("draw_glyph_run", false) else { return };
        let (pm, plan, rec) = match it { Item::Run { mode, glyphs, mask } => (mode, glyphs, mask), it => return self.mismatch("draw_glyph_run", &it) };
        let m = match mode { DrawMode::Fill(_) => RUN_FILL, DrawMode::Stroke(_) => RUN_STROKE, DrawMode::Invisible => RUN_INVISIBLE, DrawMode::FillAndStroke(..) => 9 };
        let gs = run.glyphs();
        if m != pm || gs.len() != plan.len() { return self.fail(format!("p{}: glyph run differs from the plan (mode {}/{}, {} glyphs vs {})", self.page, m, pm, gs.len(), plan.len())) }
        for (g, p) in gs.iter().zip(plan.iter()) {
            if g.char_code() != p.code || g.transform() != p.t { return self.fail(format!("p{}: glyph code {} differs from the plan code {} (or its transform)", self.page, g.char_code(), p.code)) }
        }
        self.mask(props.soft_mask.as_ref(), rec.as_ref());
        // 채우고 긋기(Tr 2)는 같은 묶음이 채우기·긋기로 두 번 온다 — 글은 한 번만 낸다(pdfjs 와 같게)
        let sig = gs.first().map(|g| { let p = (props.transform * g.transform()).as_coeffs(); (gs.len(), p[4], p[5]) });
        if matches!(mode, DrawMode::Stroke(_)) && sig.is_some() && sig == self.last_fill { self.last_fill = None; return }
        self.last_fill = if matches!(mode, DrawMode::Fill(_)) { sig } else { None };
        let invisible = if matches!(mode, DrawMode::Invisible) { 1.0 } else { 0.0 };
        for (g, p) in gs.iter().zip(plan.iter()) {
            let t: Affine = props.transform * g.transform();
            let c = t.as_coeffs();
            let cp = if p.nul { 1114112.0 } else {
                match g.as_unicode().or_else(|| p.uni.clone()) {
                    Some(BfString::Char(ch)) => if ch == '\0' { 1114112.0 } else { ch as u32 as f64 },
                    Some(BfString::String(s)) => -(self.s(s) + 1.0),
                    None => 0.0,
                }
            };
            let n = props.transform * p.next;
            self.buf.extend_from_slice(&[GLYPH, cp, g.char_code() as f64, c[0], c[1], c[2], c[3], c[4], c[5], n.x, n.y, p.aw as f64, p.at as f64, invisible, p.gid as f64, p.raw as f64]);
            self.buf.extend_from_slice(&p.pj);
        }
        self.buf.push(RUN_END);
    }
    fn draw_image(&mut self, img: Image<'a, '_>, props: ImageDrawProps<'a>) {
        let Some(it) = self.next("draw_image", false) else { return };
        if !matches!(it, Item::Image) { return self.mismatch("draw_image", &it) }
        // 그림 그리기 속성의 마스크는 늘 비어 있다(image.rs) — 마스크는 앞 push_transparency_group 에서 냈다
        if props.soft_mask.is_some() { return self.fail(format!("p{}: image draw with a soft mask", self.page)) }
        let t = props.transform.as_coeffs();
        let (w, h, mask) = match &img { Image::Raster(r) => (r.width() as f64, r.height() as f64, 0.0), Image::Stencil(s) => (s.width() as f64, s.height() as f64, 1.0) };
        let mut id = String::new();
        if let Image::Raster(r) = &img {
            id = image_id(r, self.page, &mut self.inline_n);
            self.image_pages.entry(id.clone()).or_insert(self.page);
        }
        let k = self.s(id);
        self.buf.extend_from_slice(&[IMAGE, w, h, t[0], t[1], t[2], t[3], t[4], t[5], mask, k]);
    }
    fn pop_clip(&mut self) {
        let Some(it) = self.next("pop_clip", false) else { return };
        match it { Item::Pop(true) => self.buf.push(CLIP_POP), Item::FormPop => {}, it => self.mismatch("pop_clip", &it) }
    }
    fn pop_transparency_group(&mut self) {
        let Some(it) = self.next("pop_transparency_group", false) else { return };
        if !matches!(it, Item::GroupPop) { self.mismatch("pop_transparency_group", &it) }
    }
    fn begin_marked_content(&mut self, tag: &[u8], props: Option<&hayro_syntax::object::Dict<'_>>) {
        let Some(it) = self.next("begin_marked_content", false) else { return };
        if !matches!(it, Item::MarkBegin) { return self.mismatch("begin_marked_content", &it) }
        let mcid = props.and_then(|d| d.get::<i32>(b"MCID".as_ref())).map(|v| v as f64).unwrap_or(-1.0);
        let t = self.s(String::from_utf8_lossy(tag).into_owned());
        self.buf.extend_from_slice(&[MARK_BEGIN, t, mcid]);
    }
    fn end_marked_content(&mut self) {
        let Some(it) = self.next("end_marked_content", false) else { return };
        if !matches!(it, Item::MarkEnd) { return self.mismatch("end_marked_content", &it) }
        self.buf.push(MARK_END)
    }
}

/// 디코딩한 그림을 쥐는 상한(바이트) — 넘으면 앞 쪽들의 그림부터 놓는다(다시 물으면 그 쪽을 다시 해석한다). 방금 디코딩한 쪽은 모두 둔다
const IMAGE_BUDGET: usize = 128 << 20;

pub struct Doc {
    /// 문서는 인스턴스와 수명이 같다(JS 가 문서마다 인스턴스를 만들고 버린다) — 'static 로 두어 해석 캐시·사전 해석기를 쪽 사이에 쥔다
    pdf: &'static Pdf, cache: InterpreterCache<'static>, shadow: Shadow<'static>, strs: String, fonts: HashMap<String, FontEntry>, images: HashMap<String, ImageEntry>, image_pages: HashMap<String, usize>,
    /// 화소를 쥔 그림의 디코딩 순서와 그 바이트 합
    held: std::collections::VecDeque<String>, held_bytes: usize,
    rendered: (u32, u32) }

impl Doc {
    pub fn new(data: Vec<u8>) -> Result<Doc, hayro_syntax::LoadPdfError> {
        let pdf: &'static Pdf = Box::leak(Box::new(Pdf::new(data)?));
        Ok(Doc { pdf, cache: InterpreterCache::new(), shadow: Shadow::new(pdf.xref()), strs: String::new(), fonts: HashMap::new(), images: HashMap::new(), image_pages: HashMap::new(), held: Default::default(), held_bytes: 0, rendered: (0, 0) })
    }
    /// 쪽(0부터)의 사건열. 문자열 표는 이어서 strings() 로 받는다. 쪽마다 그때 해석한다 — 글꼴·자원 캐시는 문서 하나로 쪽 사이에 쥔다
    pub fn events(&mut self, index: usize) -> Result<Vec<f64>, String> {
        let Some(page) = self.pdf.pages().get(index) else { return Ok(Vec::new()) };
        let plan = self.shadow.page(page);
        let mut ctx = Context::new(Affine::IDENTITY, Rect::new(0.0, 0.0, 1.0, 1.0), &self.cache, self.pdf.xref(), InterpreterSettings::default());
        let mut ev = Events { fonts: &mut self.fonts, image_pages: &mut self.image_pages, page: index, inline_n: 0, buf: Vec::with_capacity(4096), strs: Vec::new(), last_fill: None,
            masks: std::collections::HashSet::new(), shadow: &mut self.shadow, plans: vec![plan.into_iter()], err: None };
        interpret_page(page, &mut ctx, &mut ev);
        ev.finish();
        match ev.err {
            None => { self.strs = ev.strs.join("\u{1}"); Ok(ev.buf) }
            Some(e) => Err(format!("hayro event alignment: {}", e)),
        }
    }
    pub fn strings(&self) -> &str { &self.strs }
    fn ensure_image(&mut self, id: &str) {
        if self.images.contains_key(id) { return }
        let Some(&page) = self.image_pages.get(id) else { return };
        let pages = self.pdf.pages();
        let Some(p) = pages.get(page) else { return };
        let mut ctx = Context::new(Affine::IDENTITY, Rect::new(0.0, 0.0, 1.0, 1.0), &self.cache, self.pdf.xref(), InterpreterSettings::default());
        let mut dec = Decoder { images: &self.images, got: HashMap::new(), page, inline_n: 0 };
        interpret_page(p, &mut ctx, &mut dec);
        let got = dec.got;
        // 상한을 넘으면 앞서 디코딩한 쪽들의 그림부터 놓는다
        let new_bytes: usize = got.iter().map(|(_, e)| e.data.len()).sum();
        while self.held_bytes + new_bytes > IMAGE_BUDGET {
            let Some(k) = self.held.pop_front() else { break };
            if let Some(e) = self.images.remove(&k) { self.held_bytes -= e.data.len() }
        }
        for (k, e) in got { self.held_bytes += e.data.len(); self.held.push_back(k.clone()); self.images.insert(k, e); }
        // 이 쪽 그림을 다시 해석하지 않게, 못 그린 그림도 빈 자리로 기록
        let ids: Vec<String> = self.image_pages.iter().filter(|(_, &pg)| pg == page).map(|(k, _)| k.clone()).collect();
        for k in ids { self.images.entry(k).or_insert(ImageEntry { width: 0, height: 0, kind: 0, data: Vec::new() }); }
    }
    /// 쪽 보기 상자 [x0,y0,x1,y1] — CropBox∩MediaBox, 겹침이 비면 MediaBox. 상자는 Parent 를 따라 물려받고, 없거나 넓이가 0 이면
    /// MediaBox 는 레터(612×792), CropBox 는 MediaBox. 글 추출이 쪽 밖 글자를 거르고 표·머리글 기하가 쓰는 쪽 크기다
    pub fn page_view(&self, index: usize) -> Vec<f64> {
        let Some(p) = self.pdf.pages().get(index) else { return vec![] };
        let media = bounding_box(p.raw(), b"MediaBox").unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop = bounding_box(p.raw(), b"CropBox").unwrap_or(media);
        if crop != media {
            let b = [crop[0].max(media[0]), crop[1].max(media[1]), crop[2].min(media[2]), crop[3].min(media[3])];
            if b[0] <= b[2] && b[1] <= b[3] && b[2] - b[0] > 0.0 && b[3] - b[1] > 0.0 { return b.to_vec() }
        }
        media.to_vec()
    }
    /// 쪽 회전(0·90·180·270) — 물려받는 /Rotate, 90 의 배수가 아니면 0
    pub fn page_rotate(&self, index: usize) -> i32 {
        let Some(p) = self.pdf.pages().get(index) else { return 0 };
        let r = inherited(p.raw(), b"Rotate").and_then(|o| match o { Object::Number(n) => Some(n.as_f64()), _ => None }).unwrap_or(0.0);
        if r % 90.0 != 0.0 { 0 } else { (((r % 360.0) + 360.0) % 360.0) as i32 }
    }
    /// 문서 정보 사전 JSON — 글은 바이트를 그대로 한 글자씩(라틴1), 날짜는 "D:YYYYMMDDHHmmSS"
    pub fn info(&self) -> String {
        let m = self.pdf.metadata();
        let mut o = String::from("{");
        let mut put = |k: &str, v: String| { if o.len() > 1 { o.push(',') } o.push_str(&json_str(k)); o.push(':'); o.push_str(&json_str(&v)) };
        let latin1 = |b: &[u8]| b.iter().map(|&c| c as char).collect::<String>();
        for (k, v) in [("Title", &m.title), ("Author", &m.author), ("Subject", &m.subject), ("Keywords", &m.keywords), ("Creator", &m.creator), ("Producer", &m.producer)] {
            if let Some(v) = v { put(k, latin1(v)) }
        }
        for (k, d) in [("CreationDate", &m.creation_date), ("ModDate", &m.modification_date)] {
            if let Some(d) = d { put(k, format!("D:{:04}{:02}{:02}{:02}{:02}{:02}", d.year, d.month, d.day, d.hour, d.minute, d.second)) }
        }
        o.push('}');
        o
    }
    /// 쪽의 링크 주석 JSON — 숨김·보기 없음 표시가 없는 /Link 의 Rect 와 동작 재료(URI·파일·자바스크립트, 글은 라틴1)
    pub fn links(&self, index: usize) -> String {
        let Some(p) = self.pdf.pages().get(index) else { return "[]".into() };
        let mut o = String::from("[");
        let Some(annots) = p.raw().get::<Array<'_>>(b"Annots") else { return "[]".into() };
        let latin1 = |b: &[u8]| b.iter().map(|&c| c as char).collect::<String>();
        for a in annots.iter::<Dict<'_>>() {
            if a.get::<Name<'_>>(b"Subtype").map(|n| n.as_ref() != b"Link").unwrap_or(true) { continue }
            let flags = a.get::<i64>(b"F").unwrap_or(0);
            if flags & (2 | 32) != 0 { continue }
            let rect = a.get::<Array<'_>>(b"Rect").map(|r| r.iter::<f64>().collect::<Vec<_>>()).filter(|r| r.len() == 4)
                .map(|r| [r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3])]).unwrap_or([0.0; 4]);
            // pdf.js parseDestDictionary 와 같은 동작 고르기 — /A, 없으면 /Dest(링크 아님), 없으면 /AA 의 D·U
            let action = a.get::<Dict<'_>>(b"A").or_else(|| if a.contains_key(b"Dest") { None } else {
                a.get::<Dict<'_>>(b"AA").and_then(|aa| if aa.contains_key(b"D") { aa.get::<Dict<'_>>(b"D") } else { aa.get::<Dict<'_>>(b"U") }) });
            let Some(action) = action else { continue };
            let mut entry = format!("{{\"rect\":[{},{},{},{}]", rect[0], rect[1], rect[2], rect[3]);
            match action.get::<Name<'_>>(b"S").as_ref().map(|n| n.as_ref()) {
                Some(b"URI") => match action.get::<Object<'_>>(b"URI") {
                    Some(Object::String(s)) => entry.push_str(&format!(",\"uri\":{}", json_str(&latin1(s.as_bytes())))),
                    Some(Object::Name(n)) => entry.push_str(&format!(",\"uri\":{}", json_str(&format!("/{}", n.as_str())))),
                    _ => continue,
                },
                Some(b"Launch") | Some(b"GoToR") => {
                    // 글이면 그대로, 파일 지정 사전이면 UF·F·Unix·Mac·DOS 가운데 처음 것(글 디코딩은 JS 가 한다)
                    let (key, f) = match action.get::<Object<'_>>(b"F") {
                        Some(Object::String(s)) => ("file", latin1(s.as_bytes())),
                        Some(Object::Dict(d)) => match [b"UF".as_ref(), b"F", b"Unix", b"Mac", b"DOS"].iter().find(|k| d.contains_key(k)).and_then(|k| d.get::<hayro_syntax::object::String<'_>>(k)) {
                            Some(s) => ("filespec", latin1(s.as_bytes())),
                            None => continue,
                        },
                        _ => continue,
                    };
                    entry.push_str(&format!(",\"{}\":{}", key, json_str(&f)));
                    match action.get::<Object<'_>>(b"D") {
                        Some(Object::Name(n)) => entry.push_str(&format!(",\"dest\":{}", json_str(n.as_str()))),
                        Some(Object::String(s)) => entry.push_str(&format!(",\"dest\":{}", json_str(&latin1(s.as_bytes())))),
                        _ => {}
                    }
                }
                Some(b"JavaScript") => {
                    let js = match action.get::<Object<'_>>(b"JS") {
                        Some(Object::String(s)) => latin1(s.as_bytes()),
                        Some(Object::Stream(s)) => s.decoded().map(|d| latin1(&d)).unwrap_or_default(),
                        _ => continue,
                    };
                    entry.push_str(&format!(",\"js\":{}", json_str(&js)));
                }
                _ => continue,
            }
            entry.push('}');
            if o.len() > 1 { o.push(',') }
            o.push_str(&entry);
        }
        o.push(']');
        o
    }
    pub fn page_size(&self, index: usize) -> Vec<f32> {
        self.pdf.pages().get(index).map(|p| { let (w, h) = p.render_dimensions(); vec![w, h] }).unwrap_or_default()
    }
    /// 쪽을 배율 scale 로 흰 바탕에 그린 RGBA(raster.rs). 크기는 이어서 renderedSize() 로 받는다
    pub fn render(&mut self, index: usize, scale: f32) -> Vec<u8> {
        let pages = self.pdf.pages();
        let Some(page) = pages.get(index) else { return Vec::new() };
        let (px, w, h) = crate::raster::render(&self.pdf, page, scale);
        self.rendered = (w, h);
        px
    }
    pub fn rendered_size(&self) -> (u32, u32) { self.rendered }
    /// 글꼴 열쇠(FONT_KEY 사건의 문자열)의 정보 JSON
    pub fn font_info(&self, key: &str) -> String { self.fonts.get(key).map(|e| e.info.clone()).unwrap_or_default() }
    pub fn page_count(&self) -> usize { self.pdf.pages().len() }
    /// 디코딩한 그림 (가로, 세로, kind, 화소) — 못 그린 그림은 None
    pub fn image(&mut self, id: &str) -> Option<(u32, u32, u8, Vec<u8>)> {
        self.ensure_image(id);
        self.images.get(id).filter(|e| e.kind > 0).map(|e| (e.width, e.height, e.kind, e.data.clone()))
    }
    /// 글꼴 열쇠의 TrueType 글꼴 파일(없으면 빈 배열)
    pub fn font_file(&self, key: &str) -> Vec<u8> { self.fonts.get(key).map(|e| e.file.clone()).unwrap_or_default() }
}


/// 쪽 사전에서 Parent 를 따라 올라가며 키를 찾는다(물려받는 속성)
fn inherited<'a>(d: &Dict<'a>, key: &[u8]) -> Option<Object<'a>> {
    let mut cur = d.clone();
    for _ in 0..100 {
        if let Some(v) = cur.get::<Object<'_>>(key) { return Some(v) }
        cur = cur.get::<Dict<'_>>(b"Parent")?;
    }
    None
}

/// 물려받는 상자 — 수 네 개 배열을 정규화하고, 넓이가 0 이면 없는 것으로
fn bounding_box(d: &Dict<'_>, key: &[u8]) -> Option<[f64; 4]> {
    let Object::Array(a) = inherited(d, key)? else { return None };
    let v: Vec<f64> = a.iter::<Object<'_>>().map(|o| match o { Object::Number(n) => n.as_f64(), _ => f64::NAN }).collect();
    if v.len() != 4 || v.iter().any(|x| x.is_nan()) { return None }
    let b = [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])];
    (b[2] - b[0] > 0.0 && b[3] - b[1] > 0.0).then_some(b)
}
