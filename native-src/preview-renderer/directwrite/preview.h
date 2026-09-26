#pragma once
#include <string>
#include <cstdint>
#include <memory>

namespace hfm_dw {
struct Request {
  std::wstring fontPath, text, outputPath;
  uint32_t faceIndex = 0, width = 720, height = 260;
  double fontSize = 44;
  std::string fontIdentity;
  uint32_t sourceGeneration = 0;
};
struct Result {
  uint32_t faceIndex = 0, glyphRuns = 0, missingGlyphs = 0;
  bool cacheHit = false;
  uint64_t fontObjectId = 0;
  std::string contentHash;
};
struct CacheStats {
  uint64_t hits = 0, misses = 0, loads = 0, evictions = 0, entries = 0, bytes = 0;
  uint64_t liveEntries = 0, liveBytes = 0, sourceReads = 0, sourceBytes = 0, privateBytes = 0, peakPrivateBytes = 0;
};
class Renderer {
  struct Impl;
  std::unique_ptr<Impl> impl;
public:
  Renderer();
  ~Renderer();
  Renderer(const Renderer&) = delete;
  Renderer& operator=(const Renderer&) = delete;
  Result render(const Request& request);
  CacheStats stats() const;
};
void probe();
Result render(const Request& request);
}
