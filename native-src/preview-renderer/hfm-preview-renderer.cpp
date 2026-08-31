// HanFontManager native preview renderer helper.
// Protocol: hfm-preview-renderer.exe --input <request.json>
// Output: writes PNG to request.outputPath and prints JSON to stdout.
//
// Notes:
// - DirectWrite is still the preferred future engine, but a plain DirectWrite
//   system font collection cannot reliably see arbitrary private font files.
// - This helper therefore renders through a private GDI+ font collection first.
//   That keeps the helper independent from Chromium and avoids returning a
//   successful PNG rendered with a fallback system font.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <gdiplus.h>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <iostream>
#include <algorithm>
#include <cmath>
#include <memory>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")

struct Request {
  std::wstring fontPath;
  std::wstring text;
  std::wstring outputPath;
  float fontSize = 72.0f;
  UINT width = 900;
  UINT height = 260;
};

static std::wstring widenUtf8(const std::string& value) {
  if (value.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), (int)value.size(), nullptr, 0);
  if (len <= 0) return L"";
  std::wstring out((size_t)len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), (int)value.size(), out.data(), len);
  return out;
}

static std::string narrowUtf8(const std::wstring& value) {
  if (value.empty()) return "";
  int len = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), (int)value.size(), nullptr, 0, nullptr, nullptr);
  if (len <= 0) return "";
  std::string out((size_t)len, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), (int)value.size(), out.data(), len, nullptr, nullptr);
  return out;
}

static std::string jsonEscape(const std::string& value) {
  std::string out;
  for (char c : value) {
    if (c == '\\') out += "\\\\";
    else if (c == '"') out += "\\\"";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else out.push_back(c);
  }
  return out;
}

static std::string readFileUtf8(const std::wstring& path) {
  std::ifstream file(path, std::ios::binary);
  std::ostringstream ss;
  ss << file.rdbuf();
  return ss.str();
}

static std::string jsonStringValue(const std::string& json, const char* key) {
  std::string needle = std::string("\"") + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return "";
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return "";
  p = json.find('"', p + 1);
  if (p == std::string::npos) return "";
  std::string out;
  bool escape = false;
  for (size_t i = p + 1; i < json.size(); ++i) {
    char c = json[i];
    if (escape) {
      if (c == 'n') out.push_back('\n');
      else if (c == 'r') out.push_back('\r');
      else if (c == 't') out.push_back('\t');
      else out.push_back(c);
      escape = false;
      continue;
    }
    if (c == '\\') { escape = true; continue; }
    if (c == '"') break;
    out.push_back(c);
  }
  return out;
}

static double jsonNumberValue(const std::string& json, const char* key, double fallback) {
  std::string needle = std::string("\"") + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return fallback;
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return fallback;
  size_t start = json.find_first_of("-0123456789", p + 1);
  if (start == std::string::npos) return fallback;
  size_t end = json.find_first_not_of("0123456789.-", start);
  try {
    return std::stod(json.substr(start, end == std::string::npos ? std::string::npos : end - start));
  } catch (...) {
    return fallback;
  }
}

static bool parseRequest(const std::wstring& inputPath, Request& request, std::wstring& error) {
  std::string json = readFileUtf8(inputPath);
  request.fontPath = widenUtf8(jsonStringValue(json, "fontPath"));
  request.text = widenUtf8(jsonStringValue(json, "text"));
  request.outputPath = widenUtf8(jsonStringValue(json, "outputPath"));
  request.fontSize = (float)jsonNumberValue(json, "fontSize", 72.0);
  request.width = (UINT)jsonNumberValue(json, "width", 900.0);
  request.height = (UINT)jsonNumberValue(json, "height", 260.0);

  if (request.fontPath.empty()) { error = L"fontPath is empty"; return false; }
  if (request.outputPath.empty()) { error = L"outputPath is empty"; return false; }
  if (request.text.empty()) request.text = L"字体预览 AaBb 123";
  if (request.width < 64) request.width = 64;
  if (request.height < 32) request.height = 32;
  if (request.fontSize < 8.0f) request.fontSize = 8.0f;
  return true;
}

static bool getPngEncoderClsid(CLSID& clsid) {
  UINT count = 0;
  UINT size = 0;
  if (Gdiplus::GetImageEncodersSize(&count, &size) != Gdiplus::Ok || size == 0) return false;
  std::vector<BYTE> buffer(size);
  Gdiplus::ImageCodecInfo* codecs = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buffer.data());
  if (Gdiplus::GetImageEncoders(count, size, codecs) != Gdiplus::Ok) return false;
  for (UINT i = 0; i < count; ++i) {
    if (wcscmp(codecs[i].MimeType, L"image/png") == 0) {
      clsid = codecs[i].Clsid;
      return true;
    }
  }
  return false;
}

static Gdiplus::FontFamily* loadPrivateFontFamily(
  Gdiplus::PrivateFontCollection& collection,
  const std::wstring& fontPath,
  std::wstring& error
) {
  Gdiplus::Status addStatus = collection.AddFontFile(fontPath.c_str());
  if (addStatus != Gdiplus::Ok) {
    error = L"PrivateFontCollection.AddFontFile failed";
    return nullptr;
  }

  INT count = collection.GetFamilyCount();
  if (count < 1) {
    error = L"font file contains no loadable family";
    return nullptr;
  }

  std::vector<Gdiplus::FontFamily> families((size_t)count);
  INT found = 0;
  if (collection.GetFamilies(count, families.data(), &found) != Gdiplus::Ok || found < 1) {
    error = L"PrivateFontCollection.GetFamilies failed";
    return nullptr;
  }

  return families[0].Clone();
}

static bool textHasLineBreak(const std::wstring& text) {
  return text.find(L'\n') != std::wstring::npos || text.find(L'\r') != std::wstring::npos;
}


struct InkBounds {
  int left = 0;
  int top = 0;
  int right = -1;
  int bottom = -1;
  bool hasInk = false;

  int width() const { return hasInk ? (right - left + 1) : 0; }
  int height() const { return hasInk ? (bottom - top + 1) : 0; }
};

struct RenderedTextBitmap {
  std::unique_ptr<Gdiplus::Bitmap> bitmap;
  InkBounds bounds;
  float fontSize = 0.0f;
};

static int biggerInt(int a, int b) { return a > b ? a : b; }
static InkBounds scanInkBounds(Gdiplus::Bitmap& bitmap, BYTE alphaThreshold = 8) {
  InkBounds bounds;
  const int width = (int)bitmap.GetWidth();
  const int height = (int)bitmap.GetHeight();
  if (width <= 0 || height <= 0) return bounds;

  Gdiplus::Rect lockRect(0, 0, width, height);
  Gdiplus::BitmapData data;
  if (bitmap.LockBits(&lockRect, Gdiplus::ImageLockModeRead, PixelFormat32bppARGB, &data) != Gdiplus::Ok) {
    return bounds;
  }

  const BYTE* base = static_cast<const BYTE*>(data.Scan0);
  const int stride = data.Stride;
  for (int y = 0; y < height; ++y) {
    const BYTE* row = stride >= 0
      ? base + y * stride
      : base + (height - 1 - y) * (-stride);
    for (int x = 0; x < width; ++x) {
      const BYTE alpha = row[x * 4 + 3];
      if (alpha <= alphaThreshold) continue;
      if (!bounds.hasInk) {
        bounds.left = bounds.right = x;
        bounds.top = bounds.bottom = y;
        bounds.hasInk = true;
      } else {
        if (x < bounds.left) bounds.left = x;
        if (x > bounds.right) bounds.right = x;
        if (y < bounds.top) bounds.top = y;
        if (y > bounds.bottom) bounds.bottom = y;
      }
    }
  }

  bitmap.UnlockBits(&data);
  return bounds;
}

static std::unique_ptr<Gdiplus::StringFormat> createPreviewStringFormat(const std::wstring& text, bool noClip) {
  std::unique_ptr<Gdiplus::StringFormat> format(Gdiplus::StringFormat::GenericTypographic()->Clone());
  if (!format) return nullptr;

  format->SetAlignment(Gdiplus::StringAlignmentCenter);
  format->SetLineAlignment(Gdiplus::StringAlignmentCenter);
  format->SetTrimming(Gdiplus::StringTrimmingNone);

  INT flags = Gdiplus::StringFormatFlagsMeasureTrailingSpaces;
  if (text.find(L'\n') == std::wstring::npos && text.find(L'\r') == std::wstring::npos) {
    flags |= Gdiplus::StringFormatFlagsNoWrap;
  }
  if (noClip) {
    flags |= Gdiplus::StringFormatFlagsNoClip;
  }
  format->SetFormatFlags(flags);
  return format;
}

static bool renderScratchBitmap(
  Gdiplus::FontFamily& family,
  const std::wstring& text,
  float fontSize,
  int scratchWidth,
  int scratchHeight,
  const Gdiplus::Color& glyphColor,
  RenderedTextBitmap& rendered,
  std::wstring& error
) {
  rendered = RenderedTextBitmap();
  rendered.fontSize = fontSize;
  rendered.bitmap.reset(new Gdiplus::Bitmap(scratchWidth, scratchHeight, PixelFormat32bppARGB));
  if (!rendered.bitmap || rendered.bitmap->GetLastStatus() != Gdiplus::Ok) {
    error = L"failed to create scratch bitmap";
    return false;
  }

  Gdiplus::Graphics graphics(rendered.bitmap.get());
  if (graphics.GetLastStatus() != Gdiplus::Ok) {
    error = L"failed to create scratch graphics";
    return false;
  }

  graphics.SetCompositingMode(Gdiplus::CompositingModeSourceCopy);
  graphics.Clear(Gdiplus::Color(0, 0, 0, 0));
  graphics.SetCompositingMode(Gdiplus::CompositingModeSourceOver);
  graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);
  graphics.SetSmoothingMode(Gdiplus::SmoothingModeHighQuality);
  graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);

  std::unique_ptr<Gdiplus::StringFormat> format = createPreviewStringFormat(text, true);
  if (!format) {
    error = L"failed to create scratch string format";
    return false;
  }

  Gdiplus::Font font(&family, fontSize, Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  if (font.GetLastStatus() != Gdiplus::Ok) {
    error = L"failed to create scratch private font";
    return false;
  }

  Gdiplus::SolidBrush brush(glyphColor);
  Gdiplus::RectF scratchRect(0.0f, 0.0f, (float)scratchWidth, (float)scratchHeight);
  Gdiplus::Status drawStatus = graphics.DrawString(text.c_str(), (INT)text.size(), &font, scratchRect, format.get(), &brush);
  if (drawStatus != Gdiplus::Ok) {
    error = L"DrawString on scratch bitmap failed";
    return false;
  }

  rendered.bounds = scanInkBounds(*rendered.bitmap);
  return true;
}

static int renderPngWithPrivateGdi(const Request& request, std::wstring& error) {
  Gdiplus::PrivateFontCollection collection;
  std::unique_ptr<Gdiplus::FontFamily> family(loadPrivateFontFamily(collection, request.fontPath, error));
  if (!family) return 20;

  Gdiplus::Bitmap bitmap((INT)request.width, (INT)request.height, PixelFormat32bppARGB);
  if (bitmap.GetLastStatus() != Gdiplus::Ok) {
    error = L"failed to create output bitmap";
    return 21;
  }

  Gdiplus::Graphics outputGraphics(&bitmap);
  if (outputGraphics.GetLastStatus() != Gdiplus::Ok) {
    error = L"failed to create GDI+ output graphics";
    return 22;
  }

  outputGraphics.SetCompositingMode(Gdiplus::CompositingModeSourceCopy);
  outputGraphics.Clear(Gdiplus::Color(0, 0, 0, 0));
  outputGraphics.SetCompositingMode(Gdiplus::CompositingModeSourceOver);
  outputGraphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
  outputGraphics.SetSmoothingMode(Gdiplus::SmoothingModeHighQuality);
  outputGraphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);

  const float marginXCandidate = (float)request.width * 0.045f;
  const float marginX = marginXCandidate < 18.0f ? 18.0f : marginXCandidate;
  const float marginYCandidate = (float)request.height * 0.12f;
  const float marginY = marginYCandidate < 12.0f ? 12.0f : marginYCandidate;
  Gdiplus::RectF safeRect(marginX, marginY, (float)request.width - marginX * 2.0f, (float)request.height - marginY * 2.0f);

  // Native preview images keep the existing frontend contract: light glyphs on a transparent background.
  // In light theme, the renderer CSS inverts native PNG previews to dark text; in dark theme they stay light.
  const Gdiplus::Color glyphColor(255, 242, 244, 248);

  const int scratchWidthCandidate = (int)request.width * 3;
  const int scratchHeightCandidate = (int)request.height * 3;
  const int scratchWidth = biggerInt(scratchWidthCandidate, (int)request.width + 720);
  const int scratchHeight = biggerInt(scratchHeightCandidate, (int)request.height + 360);

  RenderedTextBitmap rendered;
  if (!renderScratchBitmap(*family, request.text, request.fontSize, scratchWidth, scratchHeight, glyphColor, rendered, error)) {
    return 24;
  }

  if (!rendered.bounds.hasInk) {
    error = L"no visible glyph pixels rendered";
    return 24;
  }

  const int inkWidth = rendered.bounds.width();
  const int inkHeight = rendered.bounds.height();
  if (inkWidth <= 0 || inkHeight <= 0) {
    error = L"invalid glyph ink bounds";
    return 24;
  }

  int destWidth = inkWidth;
  int destHeight = inkHeight;
  if (destWidth < 1) destWidth = 1;
  if (destHeight < 1) destHeight = 1;

  const int destX = (int)std::round(safeRect.X + (safeRect.Width - (float)destWidth) * 0.5f);
  const int destY = (int)std::round(safeRect.Y + (safeRect.Height - (float)destHeight) * 0.5f);
  Gdiplus::Rect destRect(destX, destY, destWidth, destHeight);

  Gdiplus::Status drawImageStatus = outputGraphics.DrawImage(
    rendered.bitmap.get(),
    destRect,
    rendered.bounds.left,
    rendered.bounds.top,
    inkWidth,
    inkHeight,
    Gdiplus::UnitPixel
  );
  if (drawImageStatus != Gdiplus::Ok) {
    error = L"failed to composite glyph ink";
    return 24;
  }

  CLSID pngClsid;
  if (!getPngEncoderClsid(pngClsid)) {
    error = L"PNG encoder not found";
    return 25;
  }

  Gdiplus::Status saveStatus = bitmap.Save(request.outputPath.c_str(), &pngClsid, nullptr);
  if (saveStatus != Gdiplus::Ok) {
    error = L"failed to save PNG";
    return 26;
  }

  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 3 || std::wstring(argv[1]) != L"--input") {
    std::cout << "{\"ok\":false,\"message\":\"usage: hfm-preview-renderer.exe --input <request.json>\"}";
    return 2;
  }

  ULONG_PTR gdiplusToken = 0;
  Gdiplus::GdiplusStartupInput gdiplusInput;
  Gdiplus::Status startupStatus = Gdiplus::GdiplusStartup(&gdiplusToken, &gdiplusInput, nullptr);
  if (startupStatus != Gdiplus::Ok) {
    std::cout << "{\"ok\":false,\"message\":\"GdiplusStartup failed\"}";
    return 1;
  }

  Request request;
  std::wstring error;
  if (!parseRequest(argv[2], request, error)) {
    std::cout << "{\"ok\":false,\"message\":\"" << jsonEscape(narrowUtf8(error)) << "\"}";
    if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
    return 3;
  }

  int code = renderPngWithPrivateGdi(request, error);
  if (code != 0) {
    std::cout << "{\"ok\":false,\"engine\":\"private-gdi\",\"message\":\"" << jsonEscape(narrowUtf8(error)) << "\"}";
    if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
    return code;
  }

  std::cout << "{\"ok\":true,\"engine\":\"private-gdi\",\"outputPath\":\"" << jsonEscape(narrowUtf8(request.outputPath)) << "\"}";
  if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
  return 0;
}
