#pragma once
#include <string>
#include <cstdint>

namespace hfm_dw {
struct Request {
  std::wstring fontPath, text, outputPath;
  uint32_t faceIndex = 0, width = 720, height = 260;
  double fontSize = 44;
};
struct Result { uint32_t faceIndex, glyphRuns, missingGlyphs; };
void probe();
Result render(const Request& request);
}
