//! 쪽 래스터(OCR·수식) — hayro 로 그리고, OCR 뒤 단계가 맞춰 온 래스터(PDFium)와 어긋나는 두 가지를 맞춘다
//! - 픽셀 크기: floor(floor(쪽 pt) × 배율). hayro::render 는 (pt × 배율) 을 버려 A4 216dpi 가 2525행, PDFium 은 2523행이었다.
//!   쪽 상자를 이 크기에 꽉 채운다(가로세로 배율이 조금 다를 수 있다)
//! - 사각형 채우기: PDFium 은 축 정렬 단색 사각형 채우기를 안티앨리어싱 없이 정수 픽셀로 칠한다. hayro 는 가장자리를 섞어 얇은 표
//!   테두리(워드식 사각형 괘선)가 옆 칸 바탕에 묻혀 래스터 괘선 감지가 놓쳤다(ODL 146 표가 사라짐). 짧은 변이 RECT_SNAP_MAX px
//!   이하인 것만 PDFium 규칙(바깥 정수 사각형에서 남는 한 픽셀을 덜 덮인 쪽에서 깎는다)으로 다시 칠한다 — 큰 채우기는 위에 그린
//!   글을 덮으므로 건드리지 않는다
use hayro_interpret::font::GlyphRun;
use hayro_interpret::kurbo::{Affine, BezPath, Rect, Shape};
use hayro_interpret::{interpret_page, BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, InterpreterCache, InterpreterSettings, Paint, SoftMask, TransformExt};
use hayro_syntax::page::Page;
use hayro_syntax::Pdf;
use hayro::vello_cpu::{color::palette::css::WHITE, Pixmap, RasterizerSettings, RenderContext, Resources, TargetInit};

/// 다시 칠할 사각형의 짧은 변 상한(px) — 216dpi 에서 1.3pt. 표 테두리(0.5~1pt)는 들고 칸 바탕은 빠진다
const RECT_SNAP_MAX: f64 = 4.0;

/// 그리지 않고 얇은 축 정렬 단색 불투명 사각형 채우기(장치 좌표)와 그때의 클립 상자만 모은다
struct ThinRects { found: Vec<(Rect, Rect, [u8; 4])>, clips: Vec<Rect>, groups: Vec<bool> }

impl<'a> Device<'a> for ThinRects {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}
    fn draw_rect(&mut self, rect: &Rect, props: DrawProps<'a>, mode: &DrawMode) {
        let [_, b, c, _, _, _] = props.transform.as_coeffs();
        if !matches!(mode, DrawMode::Fill(_)) || b != 0.0 || c != 0.0 || props.soft_mask.is_some()
            || !matches!(props.blend_mode, BlendMode::Normal) || self.groups.contains(&false) { return }
        let Paint::Color(color) = &props.paint else { return };
        let rgba = color.to_rgba().to_rgba8();
        let r = props.transform.transform_rect_bbox(*rect);
        if rgba[3] == 255 && r.width().min(r.height()) <= RECT_SNAP_MAX { self.found.push((r, *self.clips.last().unwrap(), rgba)) }
    }
    fn push_clip_path(&mut self, clip: &ClipPath) { let top = *self.clips.last().unwrap(); self.clips.push(top.intersect(clip.path.bounding_box())) }
    fn push_transparency_group(&mut self, opacity: f32, mask: Option<SoftMask<'a>>, blend: BlendMode, _: bool, _: bool) {
        self.groups.push(opacity >= 1.0 && mask.is_none() && matches!(blend, BlendMode::Normal))
    }
    fn draw_glyph_run(&mut self, _: &GlyphRun<'_, 'a>, _: DrawProps<'a>, _: &DrawMode) {}
    fn draw_image(&mut self, _: Image<'a, '_>, _: ImageDrawProps<'a>) {}
    fn pop_clip(&mut self) { if self.clips.len() > 1 { self.clips.pop(); } }
    fn pop_transparency_group(&mut self) { self.groups.pop(); }
}

/// PDFium 의 사각형 빠른 길: 바깥 정수 사각형 [l, r)×[t, b) 에서 폭·높이가 한 픽셀 넘게 남으면 덜 덮인 쪽을 깎는다
fn snap(r: Rect) -> (i64, i64, i64, i64) {
    let (mut l, mut rt, mut t, mut b) = (r.x0.floor() as i64, r.x1.ceil() as i64, r.y0.floor() as i64, r.y1.ceil() as i64);
    let w = ((r.x1 - r.x0).ceil() as i64).max(1);
    if l == rt { rt += 1 }
    if rt - l >= w + 1 { if r.x0 - l as f64 > rt as f64 - r.x1 { l += 1 } else { rt -= 1 } }
    let h = ((r.y1 - r.y0).ceil() as i64).max(1);
    if t == b { b += 1 }
    if b - t >= h + 1 { if r.y0 - t as f64 > b as f64 - r.y1 { t += 1 } else { b -= 1 } }
    (l, rt, t, b)
}

/// 쪽을 배율 scale 로 흰 바탕에 그린 RGBA 와 [가로, 세로]
pub fn render(pdf: &Pdf, page: &Page<'_>, scale: f32) -> (Vec<u8>, u32, u32) {
    let (pw, ph) = page.render_dimensions();
    let (w, h) = ((pw.floor() * scale).floor() as u16, (ph.floor() * scale).floor() as u16);
    let transform = Affine::scale_non_uniform(w as f64 / pw as f64, h as f64 / ph as f64) * page.initial_transform(true).to_kurbo();
    let cache = hayro::RenderCache::new();
    let mut ctx = RenderContext::new(w, h);
    hayro::render_into(page, &cache, &InterpreterSettings::default(), &hayro::RenderSettings::default(), &mut ctx, transform);
    ctx.flush();
    let mut pixmap = Pixmap::new(w, h);
    ctx.render_with(&mut pixmap, &mut Resources::default(), RasterizerSettings { target_init: TargetInit::Clear(WHITE), ..Default::default() });
    let mut px = pixmap.data_as_u8_slice().to_vec();

    let full = Rect::new(0.0, 0.0, w as f64, h as f64);
    let icache = InterpreterCache::new();
    let mut ictx = Context::new(transform, full, &icache, pdf.xref(), InterpreterSettings::default());
    let mut thin = ThinRects { found: Vec::new(), clips: vec![full], groups: Vec::new() };
    interpret_page(page, &mut ictx, &mut thin);
    for (r, clip, rgba) in &thin.found {
        let (l, rt, t, b) = snap(*r);
        let (x0, x1) = (l.max(clip.x0.floor() as i64).max(0), rt.min(clip.x1.ceil() as i64).min(w as i64));
        for y in t.max(clip.y0.floor() as i64).max(0)..b.min(clip.y1.ceil() as i64).min(h as i64) {
            for x in x0..x1 { let i = (y as usize * w as usize + x as usize) * 4; px[i..i + 4].copy_from_slice(rgba) }
        }
    }
    (px, w as u32, h as u32)
}
