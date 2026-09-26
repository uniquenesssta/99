#pragma once
#include "preview.h"
#include <windows.h>
#include <dwrite_3.h>
#include <wrl/client.h>
#include <list>
#include <atomic>

namespace hfm_dw {
struct FontAccounting { std::atomic<uint64_t> entries{0}, bytes{0}; };
struct CachedFont {
  // Each entry's isolated factory owns its hidden DirectWrite caches. Dropping
  // the whole entry really releases them instead of retaining an unbounded global cache.
  std::shared_ptr<FontAccounting> accounting;
  std::wstring path, familyName;
  std::string digest;
  uint32_t generation = 0, faceIndex = 0;
  uint64_t id = 0, charge = 0;
  Microsoft::WRL::ComPtr<IDWriteFactory3> factory;
  Microsoft::WRL::ComPtr<IDWriteFontFileLoader> loader;
  Microsoft::WRL::ComPtr<IDWriteFontFile> file;
  Microsoft::WRL::ComPtr<IDWriteFontFace3> face;
  Microsoft::WRL::ComPtr<IDWriteFontCollection1> collection;
  Microsoft::WRL::ComPtr<IDWriteFontFallback> fallback;
  DWRITE_FONT_WEIGHT weight{};
  DWRITE_FONT_STYLE style{};
  DWRITE_FONT_STRETCH stretch{};
  bool registered = false;
  explicit CachedFont(std::shared_ptr<FontAccounting> value);
  ~CachedFont();
};
struct FontLease { std::shared_ptr<CachedFont> font; bool hit; };
class FontCache {
  std::shared_ptr<FontAccounting> accounting = std::make_shared<FontAccounting>();
  std::list<std::shared_ptr<CachedFont>> entries;
  CacheStats counters;
  void evict(const std::wstring& path);
  void makeRoom(uint64_t bytes);
public:
  FontLease acquire(const Request& request);
  CacheStats stats() const;
};
}
