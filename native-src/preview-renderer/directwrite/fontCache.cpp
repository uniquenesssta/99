#include "fontCache.h"
#include "localFontFile.h"
#include <vector>
#include <cstring>
#include <stdexcept>
#include <algorithm>

using Microsoft::WRL::ComPtr;
namespace hfm_dw {
namespace {
constexpr size_t maxEntries = 128;
constexpr uint64_t maxBytes = 256ull * 1024 * 1024;
void check(HRESULT hr, const char* code) { if (FAILED(hr)) throw std::runtime_error(code); }
struct FontBytes {
  std::shared_ptr<FontAccounting> accounting;
  std::vector<unsigned char> data;
  FontBytes(std::shared_ptr<FontAccounting> owner, std::vector<unsigned char> value) : accounting(std::move(owner)), data(std::move(value)) {
    accounting->bytes += data.capacity();
  }
  ~FontBytes() { accounting->bytes -= data.capacity(); }
};
class MemoryStream final : public IDWriteFontFileStream {
  std::atomic<ULONG> refs{1};
  std::shared_ptr<FontBytes> bytes;
public:
  explicit MemoryStream(std::shared_ptr<FontBytes> value) : bytes(std::move(value)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
    if (!out) return E_POINTER; *out = nullptr;
    if (id != __uuidof(IUnknown) && id != __uuidof(IDWriteFontFileStream)) return E_NOINTERFACE;
    *out = static_cast<IDWriteFontFileStream*>(this); AddRef(); return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override { auto value = --refs; if (!value) delete this; return value; }
  HRESULT STDMETHODCALLTYPE ReadFileFragment(const void** start, UINT64 offset, UINT64 size, void** context) override {
    if (!start || !context) return E_POINTER;
    *start = nullptr; *context = nullptr;
    if (offset > bytes->data.size() || size > bytes->data.size() - offset) return E_FAIL;
    *start = bytes->data.data() + static_cast<size_t>(offset); return S_OK;
  }
  void STDMETHODCALLTYPE ReleaseFileFragment(void*) override {}
  HRESULT STDMETHODCALLTYPE GetFileSize(UINT64* out) override { if (!out) return E_POINTER; *out = bytes->data.size(); return S_OK; }
  HRESULT STDMETHODCALLTYPE GetLastWriteTime(UINT64* out) override { if (!out) return E_POINTER; *out = 0; return S_OK; }
};
class MemoryLoader final : public IDWriteFontFileLoader {
  std::atomic<ULONG> refs{1};
  std::shared_ptr<FontBytes> bytes;
public:
  explicit MemoryLoader(std::shared_ptr<FontBytes> value) : bytes(std::move(value)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
    if (!out) return E_POINTER; *out = nullptr;
    if (id != __uuidof(IUnknown) && id != __uuidof(IDWriteFontFileLoader)) return E_NOINTERFACE;
    *out = static_cast<IDWriteFontFileLoader*>(this); AddRef(); return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override { auto value = --refs; if (!value) delete this; return value; }
  HRESULT STDMETHODCALLTYPE CreateStreamFromKey(const void* key, UINT32 size, IDWriteFontFileStream** out) override {
    if (!out) return E_POINTER; *out = nullptr;
    if (!key || size != sizeof(uint32_t) || std::memcmp(key, "HFM3", sizeof(uint32_t))) return E_INVALIDARG;
    try { *out = new MemoryStream(bytes); return S_OK; } catch (...) { return E_OUTOFMEMORY; }
  }
};
void initialize(CachedFont& font, FontSnapshot snapshot, const Request& request) {
  font.path = std::move(snapshot.path); font.digest = std::move(snapshot.digest);
  font.generation = request.sourceGeneration; font.faceIndex = request.faceIndex;
  auto data = std::make_shared<FontBytes>(font.accounting, std::move(snapshot.bytes));
  font.loader.Attach(new MemoryLoader(data));
  check(DWriteCreateFactory(DWRITE_FACTORY_TYPE_ISOLATED, __uuidof(IDWriteFactory3),
    reinterpret_cast<IUnknown**>(font.factory.GetAddressOf())), "DIRECTWRITE_UNAVAILABLE");
  check(font.factory->RegisterFontFileLoader(font.loader.Get()), "FONT_LOADER_FAILED"); font.registered = true;
  check(font.factory->CreateCustomFontFileReference("HFM3", 4, font.loader.Get(), &font.file), "FONT_READ_FAILED");
  BOOL supported = FALSE; DWRITE_FONT_FILE_TYPE type; DWRITE_FONT_FACE_TYPE faceType; UINT32 count = 0;
  check(font.file->Analyze(&supported, &type, &faceType, &count), "FONT_UNSUPPORTED");
  if (!supported || request.faceIndex >= count) throw std::runtime_error("FACE_UNSUPPORTED");
  ComPtr<IDWriteFontFaceReference> reference;
  check(font.factory->CreateFontFaceReference(font.file.Get(), request.faceIndex, DWRITE_FONT_SIMULATIONS_NONE, &reference), "FACE_UNSUPPORTED");
  check(reference->CreateFontFace(&font.face), "FACE_UNSUPPORTED");
  const void* table = nullptr; UINT32 tableSize = 0; void* context = nullptr; BOOL exists = FALSE;
  check(font.face->TryGetFontTable(DWRITE_MAKE_OPENTYPE_TAG('f','v','a','r'), &table, &tableSize, &context, &exists), "FONT_UNSUPPORTED");
  if (context) font.face->ReleaseFontTable(context);
  if (exists) throw std::runtime_error("VARIABLE_FONT_UNSUPPORTED");
  ComPtr<IDWriteFontSetBuilder> builder; check(font.factory->CreateFontSetBuilder(&builder), "FONT_SET_FAILED");
  check(builder->AddFontFaceReference(reference.Get()), "FONT_SET_FAILED");
  ComPtr<IDWriteFontSet> set; check(builder->CreateFontSet(&set), "FONT_SET_FAILED");
  check(font.factory->CreateFontCollectionFromFontSet(set.Get(), &font.collection), "FONT_SET_FAILED");
  ComPtr<IDWriteFontFamily> family; check(static_cast<IDWriteFontCollection*>(font.collection.Get())->GetFontFamily(0, &family), "FONT_SET_FAILED");
  ComPtr<IDWriteLocalizedStrings> names; check(family->GetFamilyNames(&names), "FONT_SET_FAILED");
  UINT32 length; check(names->GetStringLength(0, &length), "FONT_SET_FAILED");
  if (length > 4096) throw std::runtime_error("FONT_SET_FAILED");
  font.familyName.resize(length + 1);
  check(names->GetString(0, font.familyName.data(), length + 1), "FONT_SET_FAILED");
  ComPtr<IDWriteFont> style; check(family->GetFont(0, &style), "FONT_SET_FAILED");
  font.weight = style->GetWeight(); font.style = style->GetStyle(); font.stretch = style->GetStretch();
  ComPtr<IDWriteFontFallbackBuilder> fallback; check(font.factory->CreateFontFallbackBuilder(&fallback), "LAYOUT_FAILED");
  check(fallback->CreateFontFallback(&font.fallback), "LAYOUT_FAILED");
  font.charge = data->data.capacity() + sizeof(CachedFont) + sizeof(FontBytes) + sizeof(MemoryLoader) + sizeof(MemoryStream)
    + (font.path.capacity() + font.familyName.capacity()) * sizeof(wchar_t) + font.digest.capacity() + 128;
}
}
CachedFont::CachedFont(std::shared_ptr<FontAccounting> value) : accounting(std::move(value)) { ++accounting->entries; }
CachedFont::~CachedFont() {
  fallback.Reset(); collection.Reset(); face.Reset(); file.Reset();
  if (registered) factory->UnregisterFontFileLoader(loader.Get());
  factory.Reset(); loader.Reset(); --accounting->entries;
}
void FontCache::evict(const std::wstring& path) {
  for (auto it = entries.begin(); it != entries.end();) {
    if ((*it)->path == path && it->use_count() == 1) { counters.bytes -= (*it)->charge; it = entries.erase(it); ++counters.evictions; }
    else ++it;
  }
}
void FontCache::makeRoom(uint64_t bytes) {
  while (entries.size() >= maxEntries || counters.bytes + bytes > maxBytes) {
    auto it = std::find_if(entries.rbegin(), entries.rend(), [](const auto& entry) { return entry.use_count() == 1; });
    if (it == entries.rend()) throw std::runtime_error("FONT_CACHE_BUSY");
    counters.bytes -= (*it)->charge; entries.erase(std::next(it).base()); ++counters.evictions;
  }
}
FontLease FontCache::acquire(const Request& request) {
  FontSnapshot snapshot;
  try { snapshot = readLocalFont(request.fontPath); }
  catch (...) { evict(request.fontPath); throw; }
  ++counters.sourceReads; counters.sourceBytes += snapshot.bytes.size();
  if (!request.fontIdentity.empty() && request.fontIdentity != snapshot.digest) {
    evict(snapshot.path); throw std::runtime_error("FONT_IDENTITY_MISMATCH");
  }
  for (auto it = entries.begin(); it != entries.end(); ++it) {
    auto& font = *it;
    if (font->path == snapshot.path && font->digest == snapshot.digest
        && font->generation == request.sourceGeneration && font->faceIndex == request.faceIndex) {
      auto lease = font; entries.splice(entries.begin(), entries, it); ++counters.hits; return {std::move(lease), true};
    }
  }
  // Remove prior contents/generations of this path, but keep other TTC faces.
  for (auto it = entries.begin(); it != entries.end();) {
    const auto& font = *it;
    if (font->path == snapshot.path && (font->digest != snapshot.digest || font->generation != request.sourceGeneration) && font.use_count() == 1) {
      counters.bytes -= font->charge; it = entries.erase(it); ++counters.evictions;
    } else ++it;
  }
  ++counters.misses;
  // Reserve bounded metadata space before parsing; exact accounted charge is
  // checked again after initialization. A live lease is never evicted.
  makeRoom(snapshot.bytes.capacity() + 64 * 1024);
  auto font = std::make_shared<CachedFont>(accounting);
  initialize(*font, std::move(snapshot), request);
  makeRoom(font->charge);
  font->id = ++counters.loads; counters.bytes += font->charge;
  entries.push_front(font); return {std::move(font), false};
}
CacheStats FontCache::stats() const {
  auto result = counters; result.entries = entries.size();
  result.liveEntries = accounting->entries.load(); result.liveBytes = accounting->bytes.load(); return result;
}
}
