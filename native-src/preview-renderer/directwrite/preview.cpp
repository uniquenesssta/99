#include "preview.h"
#include "../preview-input-policy.h"
#include <windows.h>
#include <dwrite_3.h>
#include <d2d1.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <algorithm>
#include <vector>
#include <stdexcept>
#include <cstring>

using Microsoft::WRL::ComPtr;
namespace hfm_dw {
namespace {
void check(HRESULT hr, const char* code) { if (FAILED(hr)) throw std::runtime_error(code); }
struct Apartment {
  Apartment() { check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM_UNAVAILABLE"); }
  ~Apartment() { CoUninitialize(); }
};
struct Handle {
  HANDLE value;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
ComPtr<IDWriteFactory3> factory() {
  ComPtr<IDWriteFactory3> value;
  check(DWriteCreateFactory(DWRITE_FACTORY_TYPE_ISOLATED, __uuidof(IDWriteFactory3),
    reinterpret_cast<IUnknown**>(value.GetAddressOf())), "DIRECTWRITE_UNAVAILABLE");
  return value;
}

// This proof entry point accepts fixed/removable local paths only. Reject all
// reparse components before opening files; network staging belongs to DW-04.
std::wstring localPath(const std::wstring& input, bool newFile) {
  if (input.size() < 3 || input[1] != L':' || input[2] != L'\\' || input.find(L'\0') != std::wstring::npos
      || input.find(L':', 2) != std::wstring::npos) throw std::runtime_error("LOCAL_PATH_REQUIRED");
  DWORD length = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  if (!length || length > 32768) throw std::runtime_error("PATH_INVALID");
  std::wstring full(length, L'\0');
  DWORD written = GetFullPathNameW(input.c_str(), length, full.data(), nullptr);
  if (!written || written >= length) throw std::runtime_error("PATH_INVALID");
  full.resize(written);
  UINT drive = GetDriveTypeW(full.substr(0, 3).c_str());
  if (drive != DRIVE_FIXED && drive != DRIVE_REMOVABLE) throw std::runtime_error("LOCAL_PATH_REQUIRED");
  for (size_t end = 3; end <= full.size(); ++end) {
    if (end < full.size() && full[end] != L'\\') continue;
    DWORD attrs = GetFileAttributesW(full.substr(0, end).c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) {
      if (newFile && end == full.size() && GetLastError() == ERROR_FILE_NOT_FOUND) continue;
      throw std::runtime_error("PATH_UNAVAILABLE");
    }
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) throw std::runtime_error("REPARSE_NOT_SUPPORTED");
    if (newFile && end == full.size()) throw std::runtime_error("OUTPUT_EXISTS");
  }
  return full;
}
bool validUtf16(const std::wstring& text) {
  for (size_t i = 0; i < text.size(); ++i) {
    unsigned c = text[i];
    if (c >= 0xd800 && c <= 0xdbff) {
      if (++i == text.size() || text[i] < 0xdc00 || text[i] > 0xdfff) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

// DirectWrite performs shaping and bidi layout. Capture its exact private-face
// outlines so fitting uses real ink bounds, including accents and overhangs.
class Outlines final : public IDWriteTextRenderer {
  ULONG refs = 1;
  ComPtr<ID2D1Factory> d2d;
  ComPtr<IDWriteFontFile> expectedFile;
  UINT32 expectedIndex;
public:
  std::vector<ComPtr<ID2D1TransformedGeometry>> shapes;
  D2D1_RECT_F bounds{};
  UINT32 runs = 0, missing = 0;
  Outlines(ID2D1Factory* factory, IDWriteFontFile* file, UINT32 index)
    : d2d(factory), expectedFile(file), expectedIndex(index) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (id != __uuidof(IUnknown) && id != __uuidof(IDWritePixelSnapping) && id != __uuidof(IDWriteTextRenderer)) return E_NOINTERFACE;
    *out = static_cast<IDWriteTextRenderer*>(this); AddRef(); return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override { ULONG n = --refs; if (!n) delete this; return n; }
  HRESULT STDMETHODCALLTYPE IsPixelSnappingDisabled(void*, BOOL* out) override { *out = TRUE; return S_OK; }
  HRESULT STDMETHODCALLTYPE GetCurrentTransform(void*, DWRITE_MATRIX* out) override { *out = {1,0,0,1,0,0}; return S_OK; }
  HRESULT STDMETHODCALLTYPE GetPixelsPerDip(void*, FLOAT* out) override { *out = 1; return S_OK; }
  HRESULT STDMETHODCALLTYPE DrawUnderline(void*, FLOAT, FLOAT, const DWRITE_UNDERLINE*, IUnknown*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE DrawStrikethrough(void*, FLOAT, FLOAT, const DWRITE_STRIKETHROUGH*, IUnknown*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE DrawInlineObject(void*, FLOAT, FLOAT, IDWriteInlineObject*, BOOL, BOOL, IUnknown*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE DrawGlyphRun(void*, FLOAT x, FLOAT y, DWRITE_MEASURING_MODE,
      const DWRITE_GLYPH_RUN* run, const DWRITE_GLYPH_RUN_DESCRIPTION*, IUnknown*) override {
    try {
      if (run->fontFace->GetIndex() != expectedIndex) return E_FAIL;
      UINT32 count = 0;
      check(run->fontFace->GetFiles(&count, nullptr), "FACE_MISMATCH");
      if (count != 1) return E_FAIL;
      ComPtr<IDWriteFontFile> file;
      check(run->fontFace->GetFiles(&count, file.GetAddressOf()), "FACE_MISMATCH");
      const void *a = nullptr, *b = nullptr; UINT32 an = 0, bn = 0;
      check(file->GetReferenceKey(&a, &an), "FACE_MISMATCH");
      check(expectedFile->GetReferenceKey(&b, &bn), "FACE_MISMATCH");
      ComPtr<IDWriteFontFileLoader> al, bl;
      check(file->GetLoader(&al), "FACE_MISMATCH");
      check(expectedFile->GetLoader(&bl), "FACE_MISMATCH");
      if (an != bn || std::memcmp(a, b, an) != 0 || al.Get() != bl.Get()) return E_FAIL;
      ++runs;
      for (UINT32 i = 0; i < run->glyphCount; ++i) if (run->glyphIndices[i] == 0) ++missing;
      ComPtr<ID2D1PathGeometry> path;
      check(d2d->CreatePathGeometry(&path), "GEOMETRY_FAILED");
      ComPtr<ID2D1GeometrySink> sink;
      check(path->Open(&sink), "GEOMETRY_FAILED");
      check(run->fontFace->GetGlyphRunOutline(run->fontEmSize, run->glyphIndices, run->glyphAdvances,
        run->glyphOffsets, run->glyphCount, run->isSideways, run->bidiLevel % 2 != 0, sink.Get()), "OUTLINE_FAILED");
      check(sink->Close(), "GEOMETRY_FAILED");
      ComPtr<ID2D1TransformedGeometry> shape;
      auto move = D2D1::Matrix3x2F::Translation(x, y);
      check(d2d->CreateTransformedGeometry(path.Get(), &move, &shape), "GEOMETRY_FAILED");
      D2D1_RECT_F rect;
      check(shape->GetBounds(nullptr, &rect), "GEOMETRY_FAILED");
      if (rect.right <= rect.left || rect.bottom <= rect.top) return S_OK;
      if (shapes.empty()) bounds = rect;
      else { bounds.left = std::min(bounds.left, rect.left); bounds.top = std::min(bounds.top, rect.top);
        bounds.right = std::max(bounds.right, rect.right); bounds.bottom = std::max(bounds.bottom, rect.bottom); }
      shapes.push_back(shape);
      return S_OK;
    } catch (...) { return E_FAIL; } // Never unwind through a COM callback.
  }
};

void writePng(IWICImagingFactory* wic, IWICBitmap* bitmap, const std::wstring& output) {
  ComPtr<IStream> stream;
  check(CreateStreamOnHGlobal(nullptr, TRUE, &stream), "ENCODE_FAILED");
  ComPtr<IWICBitmapEncoder> encoder;
  check(wic->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder), "ENCODE_FAILED");
  check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache), "ENCODE_FAILED");
  ComPtr<IWICBitmapFrameEncode> frame;
  check(encoder->CreateNewFrame(&frame, nullptr), "ENCODE_FAILED");
  check(frame->Initialize(nullptr), "ENCODE_FAILED");
  UINT width, height; check(bitmap->GetSize(&width, &height), "ENCODE_FAILED");
  check(frame->SetSize(width, height), "ENCODE_FAILED");
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  check(frame->SetPixelFormat(&format), "ENCODE_FAILED");
  if (format != GUID_WICPixelFormat32bppBGRA) throw std::runtime_error("PNG_FORMAT_UNSUPPORTED");
  ComPtr<IWICFormatConverter> converter;
  check(wic->CreateFormatConverter(&converter), "ENCODE_FAILED");
  check(converter->Initialize(bitmap, format, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom), "ENCODE_FAILED");
  check(frame->WriteSource(converter.Get(), nullptr), "ENCODE_FAILED");
  check(frame->Commit(), "ENCODE_FAILED"); check(encoder->Commit(), "ENCODE_FAILED");
  STATSTG stat{}; check(stream->Stat(&stat, STATFLAG_NONAME), "ENCODE_FAILED");
  if (stat.cbSize.QuadPart > 64*1024*1024) throw std::runtime_error("PNG_TOO_LARGE");
  HGLOBAL memory; check(GetHGlobalFromStream(stream.Get(), &memory), "ENCODE_FAILED");
  const void* bytes = GlobalLock(memory);
  if (!bytes) throw std::runtime_error("ENCODE_FAILED");
  Handle file{CreateFileW(output.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
  if (file.value == INVALID_HANDLE_VALUE) { GlobalUnlock(memory); throw std::runtime_error("OUTPUT_CREATE_FAILED"); }
  DWORD written = 0;
  bool ok = WriteFile(file.value, bytes, stat.cbSize.LowPart, &written, nullptr) && written == stat.cbSize.LowPart && FlushFileBuffers(file.value);
  GlobalUnlock(memory);
  if (!ok) { CloseHandle(file.value); file.value = INVALID_HANDLE_VALUE; DeleteFileW(output.c_str()); throw std::runtime_error("OUTPUT_WRITE_FAILED"); }
}
} // namespace

void probe() { Apartment apartment; auto dw = factory(); }
Result render(const Request& request) {
  if (!preview_input::valid(request.width, request.height, request.fontSize, request.text.size()) || !validUtf16(request.text))
    throw std::runtime_error("INPUT_INVALID");
  auto source = localPath(request.fontPath, false), output = localPath(request.outputPath, true);
  Handle pinned{CreateFileW(source.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  LARGE_INTEGER size{};
  if (pinned.value == INVALID_HANDLE_VALUE || !GetFileSizeEx(pinned.value, &size)) throw std::runtime_error("FONT_READ_FAILED");
  if (size.QuadPart <= 0 || size.QuadPart > 64*1024*1024) throw std::runtime_error("FONT_SIZE_UNSUPPORTED");
  Apartment apartment;
  auto dw = factory();
  ComPtr<IDWriteFontFile> file;
  check(dw->CreateFontFileReference(source.c_str(), nullptr, &file), "FONT_READ_FAILED");
  BOOL supported = FALSE; DWRITE_FONT_FILE_TYPE type; DWRITE_FONT_FACE_TYPE faceType; UINT32 count = 0;
  check(file->Analyze(&supported, &type, &faceType, &count), "FONT_UNSUPPORTED");
  if (!supported || request.faceIndex >= count) throw std::runtime_error("FACE_UNSUPPORTED");
  ComPtr<IDWriteFontFaceReference> reference;
  check(dw->CreateFontFaceReference(file.Get(), request.faceIndex, DWRITE_FONT_SIMULATIONS_NONE, &reference), "FACE_UNSUPPORTED");
  ComPtr<IDWriteFontFace3> face;
  check(reference->CreateFontFace(&face), "FACE_UNSUPPORTED");
  const void* table = nullptr; UINT32 tableSize = 0; void* context = nullptr; BOOL exists = FALSE;
  check(face->TryGetFontTable(DWRITE_MAKE_OPENTYPE_TAG('f','v','a','r'), &table, &tableSize, &context, &exists), "FONT_UNSUPPORTED");
  if (context) face->ReleaseFontTable(context);
  if (exists) throw std::runtime_error("VARIABLE_FONT_UNSUPPORTED");
  ComPtr<IDWriteFontSetBuilder> builder;
  check(dw->CreateFontSetBuilder(&builder), "FONT_SET_FAILED");
  check(builder->AddFontFaceReference(reference.Get()), "FONT_SET_FAILED");
  ComPtr<IDWriteFontSet> set; check(builder->CreateFontSet(&set), "FONT_SET_FAILED");
  ComPtr<IDWriteFontCollection1> collection;
  check(dw->CreateFontCollectionFromFontSet(set.Get(), &collection), "FONT_SET_FAILED");
  ComPtr<IDWriteFontFamily> family; check(static_cast<IDWriteFontCollection*>(collection.Get())->GetFontFamily(0, &family), "FONT_SET_FAILED");
  ComPtr<IDWriteLocalizedStrings> names; check(family->GetFamilyNames(&names), "FONT_SET_FAILED");
  UINT32 length; check(names->GetStringLength(0, &length), "FONT_SET_FAILED");
  std::wstring name(length + 1, L'\0'); check(names->GetString(0, name.data(), length + 1), "FONT_SET_FAILED");
  ComPtr<IDWriteFont> font; check(family->GetFont(0, &font), "FONT_SET_FAILED");
  ComPtr<IDWriteTextFormat> format;
  check(dw->CreateTextFormat(name.c_str(), collection.Get(), font->GetWeight(), font->GetStyle(), font->GetStretch(),
    static_cast<FLOAT>(request.fontSize), L"en-us", &format), "LAYOUT_FAILED");
  auto text = request.text.empty() ? std::wstring(L"字体预览 AaBb 123") : request.text;
  check(format->SetWordWrapping(text.find_first_of(L"\r\n") == std::wstring::npos ? DWRITE_WORD_WRAPPING_NO_WRAP : DWRITE_WORD_WRAPPING_WRAP), "LAYOUT_FAILED");
  ComPtr<IDWriteTextLayout> layout;
  check(dw->CreateTextLayout(text.c_str(), static_cast<UINT32>(text.size()), format.Get(), static_cast<FLOAT>(request.width), static_cast<FLOAT>(request.height), &layout), "LAYOUT_FAILED");
  ComPtr<IDWriteFontFallbackBuilder> fallbackBuilder;
  check(dw->CreateFontFallbackBuilder(&fallbackBuilder), "LAYOUT_FAILED");
  ComPtr<IDWriteFontFallback> fallback; check(fallbackBuilder->CreateFontFallback(&fallback), "LAYOUT_FAILED");
  ComPtr<IDWriteTextLayout2> layout2; check(layout.As(&layout2), "LAYOUT_FAILED");
  check(layout2->SetFontFallback(fallback.Get()), "LAYOUT_FAILED");
  ComPtr<ID2D1Factory> d2d; check(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, d2d.GetAddressOf()), "D2D_UNAVAILABLE");
  ComPtr<Outlines> outlines; outlines.Attach(new Outlines(d2d.Get(), file.Get(), request.faceIndex));
  check(layout->Draw(nullptr, outlines.Get(), 0, 0), "GLYPH_RUN_REJECTED");
  ComPtr<IWICImagingFactory> wic;
  check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic)), "WIC_UNAVAILABLE");
  ComPtr<IWICBitmap> bitmap;
  check(wic->CreateBitmap(request.width, request.height, GUID_WICPixelFormat32bppPBGRA, WICBitmapCacheOnLoad, &bitmap), "BITMAP_FAILED");
  ComPtr<ID2D1RenderTarget> target;
  auto properties = D2D1::RenderTargetProperties(D2D1_RENDER_TARGET_TYPE_SOFTWARE,
    D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED), 96, 96);
  check(d2d->CreateWicBitmapRenderTarget(bitmap.Get(), properties, &target), "BITMAP_FAILED");
  ComPtr<ID2D1SolidColorBrush> brush;
  check(target->CreateSolidColorBrush(D2D1::ColorF(242/255.f, 244/255.f, 248/255.f, 1), &brush), "BITMAP_FAILED");
  target->BeginDraw(); target->Clear(D2D1::ColorF(0, 0));
  if (!outlines->shapes.empty()) {
    auto b = outlines->bounds; FLOAT w = b.right-b.left, h = b.bottom-b.top;
    FLOAT scale = std::min(1.f, std::min((request.width-8.f)/w, (request.height-8.f)/h));
    target->SetTransform(D2D1::Matrix3x2F(scale,0,0,scale, (request.width-w*scale)/2-b.left*scale, (request.height-h*scale)/2-b.top*scale));
    for (auto& shape : outlines->shapes) target->FillGeometry(shape.Get(), brush.Get());
  }
  check(target->EndDraw(), "DRAW_FAILED");
  writePng(wic.Get(), bitmap.Get(), output);
  return {request.faceIndex, outlines->runs, outlines->missing};
}
} // namespace hfm_dw
