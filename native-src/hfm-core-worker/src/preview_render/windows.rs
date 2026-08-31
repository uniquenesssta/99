use std::ffi::c_void;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::{ffi::OsStr, ptr};

use super::PreviewRenderRequest;

type GpStatus = i32;
type ARGB = u32;

const OK: GpStatus = 0;
const PIXEL_FORMAT_32BPP_ARGB: i32 = 0x0026_200A;
const UNIT_PIXEL: i32 = 2;
const FONT_STYLE_REGULAR: i32 = 0;
const COMPOSITING_MODE_SOURCE_COPY: i32 = 1;
const COMPOSITING_MODE_SOURCE_OVER: i32 = 0;
const INTERPOLATION_MODE_HIGH_QUALITY_BICUBIC: i32 = 7;
const SMOOTHING_MODE_HIGH_QUALITY: i32 = 4;
const PIXEL_OFFSET_MODE_HIGH_QUALITY: i32 = 2;
const TEXT_RENDERING_HINT_ANTI_ALIAS_GRID_FIT: i32 = 3;
const STRING_ALIGNMENT_CENTER: i32 = 1;
const STRING_TRIMMING_NONE: i32 = 0;
const STRING_FORMAT_FLAGS_MEASURE_TRAILING_SPACES: i32 = 0x0000_0800;
const STRING_FORMAT_FLAGS_NO_WRAP: i32 = 0x0000_1000;
const GLYPH_COLOR: ARGB = 0xFFF2_F4F8;

#[repr(C)]
#[derive(Clone, Copy)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

#[repr(C)]
struct GdiplusStartupInput {
    gdiplus_version: u32,
    debug_event_callback: *mut c_void,
    suppress_background_thread: i32,
    suppress_external_codecs: i32,
}

#[repr(C)]
struct GpRectF {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[repr(C)]
struct ImageCodecInfo {
    clsid: Guid,
    format_id: Guid,
    codec_name: *const u16,
    dll_name: *const u16,
    format_description: *const u16,
    filename_extension: *const u16,
    mime_type: *const u16,
    flags: u32,
    version: u32,
    sig_count: u32,
    sig_size: u32,
    sig_pattern: *const u8,
    sig_mask: *const u8,
}

#[link(name = "gdiplus")]
unsafe extern "system" {
    fn GdiplusStartup(token: *mut usize, input: *const GdiplusStartupInput, output: *mut c_void) -> GpStatus;
    fn GdiplusShutdown(token: usize);
    fn GdipCreateBitmapFromScan0(width: i32, height: i32, stride: i32, format: i32, scan0: *mut u8, bitmap: *mut *mut c_void) -> GpStatus;
    fn GdipDisposeImage(image: *mut c_void) -> GpStatus;
    fn GdipGetImageGraphicsContext(image: *mut c_void, graphics: *mut *mut c_void) -> GpStatus;
    fn GdipDeleteGraphics(graphics: *mut c_void) -> GpStatus;
    fn GdipGraphicsClear(graphics: *mut c_void, color: ARGB) -> GpStatus;
    fn GdipSetCompositingMode(graphics: *mut c_void, mode: i32) -> GpStatus;
    fn GdipSetInterpolationMode(graphics: *mut c_void, mode: i32) -> GpStatus;
    fn GdipSetSmoothingMode(graphics: *mut c_void, mode: i32) -> GpStatus;
    fn GdipSetPixelOffsetMode(graphics: *mut c_void, mode: i32) -> GpStatus;
    fn GdipSetTextRenderingHint(graphics: *mut c_void, mode: i32) -> GpStatus;
    fn GdipNewPrivateFontCollection(font_collection: *mut *mut c_void) -> GpStatus;
    fn GdipDeletePrivateFontCollection(font_collection: *mut *mut c_void) -> GpStatus;
    fn GdipPrivateAddFontFile(font_collection: *mut c_void, filename: *const u16) -> GpStatus;
    fn GdipGetFontCollectionFamilyCount(font_collection: *mut c_void, num_found: *mut i32) -> GpStatus;
    fn GdipGetFontCollectionFamilyList(font_collection: *mut c_void, num_sought: i32, families: *mut *mut c_void, num_found: *mut i32) -> GpStatus;
    fn GdipCreateFontFamilyFromName(name: *const u16, font_collection: *mut c_void, font_family: *mut *mut c_void) -> GpStatus;
    fn GdipDeleteFontFamily(family: *mut c_void) -> GpStatus;
    fn GdipCreateFont(family: *mut c_void, em_size: f32, style: i32, unit: i32, font: *mut *mut c_void) -> GpStatus;
    fn GdipDeleteFont(font: *mut c_void) -> GpStatus;
    fn GdipCreateStringFormat(format_attributes: i32, language: u16, format: *mut *mut c_void) -> GpStatus;
    fn GdipDeleteStringFormat(format: *mut c_void) -> GpStatus;
    fn GdipSetStringFormatAlign(format: *mut c_void, align: i32) -> GpStatus;
    fn GdipSetStringFormatLineAlign(format: *mut c_void, align: i32) -> GpStatus;
    fn GdipSetStringFormatTrimming(format: *mut c_void, trimming: i32) -> GpStatus;
    fn GdipSetStringFormatFlags(format: *mut c_void, flags: i32) -> GpStatus;
    fn GdipCreateSolidFill(color: ARGB, brush: *mut *mut c_void) -> GpStatus;
    fn GdipDeleteBrush(brush: *mut c_void) -> GpStatus;
    fn GdipDrawString(graphics: *mut c_void, string: *const u16, length: i32, font: *mut c_void, layout_rect: *const GpRectF, string_format: *mut c_void, brush: *mut c_void) -> GpStatus;
    fn GdipGetImageEncodersSize(num_encoders: *mut u32, size: *mut u32) -> GpStatus;
    fn GdipGetImageEncoders(num_encoders: u32, size: u32, encoders: *mut ImageCodecInfo) -> GpStatus;
    fn GdipSaveImageToFile(image: *mut c_void, filename: *const u16, clsid: *const Guid, encoder_params: *const c_void) -> GpStatus;
}

struct GdiplusToken(usize);
impl Drop for GdiplusToken {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { GdiplusShutdown(self.0) };
        }
    }
}

struct Image(*mut c_void);
impl Drop for Image {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { let _ = GdipDisposeImage(self.0); }
        }
    }
}

struct Graphics(*mut c_void);
impl Drop for Graphics {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { let _ = GdipDeleteGraphics(self.0); }
        }
    }
}

struct PrivateFontCollection(*mut c_void);
impl Drop for PrivateFontCollection {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { let _ = GdipDeletePrivateFontCollection(&mut self.0); }
        }
    }
}

struct SystemFontFamily(*mut c_void);
impl Drop for SystemFontFamily {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { let _ = GdipDeleteFontFamily(self.0); }
        }
    }
}

struct Font(*mut c_void);
impl Drop for Font {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { let _ = GdipDeleteFont(self.0); }
        }
    }
}

struct PreviewFont {
    font: Font,
    _private_collection: Option<PrivateFontCollection>,
    _system_family: Option<SystemFontFamily>,
}

struct StringFormat(*mut c_void);
impl Drop for StringFormat {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { let _ = GdipDeleteStringFormat(self.0); }
        }
    }
}

struct Brush(*mut c_void);
impl Drop for Brush {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { let _ = GdipDeleteBrush(self.0); }
        }
    }
}

pub fn render_preview_image(request: &PreviewRenderRequest) -> Result<(), String> {
    let _token = start_gdiplus()?;
    ensure_parent_dir(&request.output_path)?;

    let output_path = wide_null(&request.output_path);
    let text = wide_null(&request.text);

    let bitmap = create_bitmap(request.width, request.height)?;
    let graphics = create_graphics(bitmap.0)?;
    configure_graphics(graphics.0)?;

    let preview_font = create_preview_font(request)?;
    let format = create_string_format(&request.text)?;
    let brush = create_solid_brush(GLYPH_COLOR)?;

    let margin_x = ((request.width as f32) * 0.045).max(18.0);
    let margin_y = ((request.height as f32) * 0.12).max(12.0);
    let rect = GpRectF {
        x: margin_x,
        y: margin_y,
        width: ((request.width as f32) - margin_x * 2.0).max(1.0),
        height: ((request.height as f32) - margin_y * 2.0).max(1.0),
    };

    let text_len = text.len().saturating_sub(1).min(i32::MAX as usize) as i32;
    status(unsafe { GdipDrawString(graphics.0, text.as_ptr(), text_len, preview_font.font.0, &rect, format.0, brush.0) }, "GdipDrawString failed")?;
    let png_encoder = png_encoder_clsid()?;
    status(unsafe { GdipSaveImageToFile(bitmap.0, output_path.as_ptr(), &png_encoder, ptr::null()) }, "failed to save PNG")?;

    Ok(())
}

fn start_gdiplus() -> Result<GdiplusToken, String> {
    let input = GdiplusStartupInput {
        gdiplus_version: 1,
        debug_event_callback: ptr::null_mut(),
        suppress_background_thread: 0,
        suppress_external_codecs: 0,
    };
    let mut token = 0usize;
    status(unsafe { GdiplusStartup(&mut token, &input, ptr::null_mut()) }, "GdiplusStartup failed")?;
    Ok(GdiplusToken(token))
}

fn create_preview_font(request: &PreviewRenderRequest) -> Result<PreviewFont, String> {
    let mut last_system_error: Option<String> = None;

    if request.prefer_system_font {
        for family_name in &request.system_font_family_candidates {
            match create_system_font_family(family_name).and_then(|family| {
                let font = create_font(family.0, request.font_size)?;
                Ok(PreviewFont {
                    font,
                    _private_collection: None,
                    _system_family: Some(family),
                })
            }) {
                Ok(font) => return Ok(font),
                Err(error) => last_system_error = Some(format!("{}: {}", family_name, error)),
            }
        }
    }

    if !request.font_path.trim().is_empty() {
        let font_path = wide_null(&request.font_path);
        let collection = create_private_font_collection(&font_path)?;
        let family = first_font_family(collection.0)?;
        let font = create_font(family, request.font_size)?;
        return Ok(PreviewFont {
            font,
            _private_collection: Some(collection),
            _system_family: None,
        });
    }

    Err(last_system_error.unwrap_or_else(|| "fontPath is empty".to_string()))
}

fn create_system_font_family(family_name: &str) -> Result<SystemFontFamily, String> {
    let name = wide_null(family_name);
    let mut family = ptr::null_mut();
    status(unsafe { GdipCreateFontFamilyFromName(name.as_ptr(), ptr::null_mut(), &mut family) }, "failed to create installed font family")?;
    if family.is_null() {
        return Err("installed font family not found".to_string());
    }
    Ok(SystemFontFamily(family))
}

fn create_private_font_collection(font_path: &[u16]) -> Result<PrivateFontCollection, String> {
    let mut collection = ptr::null_mut();
    status(unsafe { GdipNewPrivateFontCollection(&mut collection) }, "GdipNewPrivateFontCollection failed")?;
    status(unsafe { GdipPrivateAddFontFile(collection, font_path.as_ptr()) }, "PrivateFontCollection.AddFontFile failed")?;
    Ok(PrivateFontCollection(collection))
}

fn first_font_family(collection: *mut c_void) -> Result<*mut c_void, String> {
    let mut count = 0i32;
    status(unsafe { GdipGetFontCollectionFamilyCount(collection, &mut count) }, "GdipGetFontCollectionFamilyCount failed")?;
    if count < 1 {
        return Err("font file contains no loadable family".to_string());
    }
    let mut families = vec![ptr::null_mut(); count as usize];
    let mut found = 0i32;
    status(unsafe { GdipGetFontCollectionFamilyList(collection, count, families.as_mut_ptr(), &mut found) }, "GdipGetFontCollectionFamilyList failed")?;
    families.into_iter().find(|family| !family.is_null()).ok_or_else(|| "font file contains no loadable family".to_string())
}

fn create_bitmap(width: u32, height: u32) -> Result<Image, String> {
    let mut bitmap = ptr::null_mut();
    status(unsafe { GdipCreateBitmapFromScan0(width as i32, height as i32, 0, PIXEL_FORMAT_32BPP_ARGB, ptr::null_mut(), &mut bitmap) }, "failed to create output bitmap")?;
    Ok(Image(bitmap))
}

fn create_graphics(image: *mut c_void) -> Result<Graphics, String> {
    let mut graphics = ptr::null_mut();
    status(unsafe { GdipGetImageGraphicsContext(image, &mut graphics) }, "failed to create output graphics")?;
    Ok(Graphics(graphics))
}

fn configure_graphics(graphics: *mut c_void) -> Result<(), String> {
    status(unsafe { GdipSetCompositingMode(graphics, COMPOSITING_MODE_SOURCE_COPY) }, "failed to configure graphics compositing")?;
    status(unsafe { GdipGraphicsClear(graphics, 0x0000_0000) }, "failed to clear output bitmap")?;
    status(unsafe { GdipSetCompositingMode(graphics, COMPOSITING_MODE_SOURCE_OVER) }, "failed to configure graphics compositing")?;
    let _ = unsafe { GdipSetInterpolationMode(graphics, INTERPOLATION_MODE_HIGH_QUALITY_BICUBIC) };
    let _ = unsafe { GdipSetSmoothingMode(graphics, SMOOTHING_MODE_HIGH_QUALITY) };
    let _ = unsafe { GdipSetPixelOffsetMode(graphics, PIXEL_OFFSET_MODE_HIGH_QUALITY) };
    let _ = unsafe { GdipSetTextRenderingHint(graphics, TEXT_RENDERING_HINT_ANTI_ALIAS_GRID_FIT) };
    Ok(())
}

fn create_font(family: *mut c_void, font_size: f32) -> Result<Font, String> {
    let mut font = ptr::null_mut();
    status(unsafe { GdipCreateFont(family, font_size, FONT_STYLE_REGULAR, UNIT_PIXEL, &mut font) }, "failed to create private font")?;
    Ok(Font(font))
}

fn create_string_format(text: &str) -> Result<StringFormat, String> {
    let mut format = ptr::null_mut();
    status(unsafe { GdipCreateStringFormat(0, 0, &mut format) }, "failed to create string format")?;
    status(unsafe { GdipSetStringFormatAlign(format, STRING_ALIGNMENT_CENTER) }, "failed to set string alignment")?;
    status(unsafe { GdipSetStringFormatLineAlign(format, STRING_ALIGNMENT_CENTER) }, "failed to set string line alignment")?;
    let _ = unsafe { GdipSetStringFormatTrimming(format, STRING_TRIMMING_NONE) };
    let mut flags = STRING_FORMAT_FLAGS_MEASURE_TRAILING_SPACES;
    if !text.contains('\n') && !text.contains('\r') {
        flags |= STRING_FORMAT_FLAGS_NO_WRAP;
    }
    let _ = unsafe { GdipSetStringFormatFlags(format, flags) };
    Ok(StringFormat(format))
}

fn create_solid_brush(color: ARGB) -> Result<Brush, String> {
    let mut brush = ptr::null_mut();
    status(unsafe { GdipCreateSolidFill(color, &mut brush) }, "failed to create preview brush")?;
    Ok(Brush(brush))
}

fn png_encoder_clsid() -> Result<Guid, String> {
    let mut count = 0u32;
    let mut size = 0u32;
    status(unsafe { GdipGetImageEncodersSize(&mut count, &mut size) }, "GdipGetImageEncodersSize failed")?;
    if count == 0 || size == 0 {
        return Err("PNG encoder not found".to_string());
    }
    let mut bytes = vec![0u8; size as usize];
    status(unsafe { GdipGetImageEncoders(count, size, bytes.as_mut_ptr() as *mut ImageCodecInfo) }, "GdipGetImageEncoders failed")?;
    let encoders = unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const ImageCodecInfo, count as usize) };
    encoders
        .iter()
        .find(|encoder| wide_ptr_equals(encoder.mime_type, "image/png"))
        .map(|encoder| encoder.clsid)
        .ok_or_else(|| "PNG encoder not found".to_string())
}

fn wide_ptr_equals(ptr: *const u16, expected: &str) -> bool {
    if ptr.is_null() {
        return false;
    }
    let mut len = 0usize;
    unsafe {
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len)).eq_ignore_ascii_case(expected)
    }
}

fn ensure_parent_dir(output_path: &str) -> Result<(), String> {
    let parent: Option<PathBuf> = Path::new(output_path).parent().map(|path| path.to_path_buf());
    if let Some(parent) = parent {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(&parent).map_err(|error| format!("failed to create preview output directory: {}", error))?;
        }
    }
    Ok(())
}

fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

fn status(status: GpStatus, message: &str) -> Result<(), String> {
    if status == OK {
        Ok(())
    } else {
        Err(format!("{} (status={})", message, status))
    }
}
