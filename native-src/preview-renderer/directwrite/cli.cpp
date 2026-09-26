#include "preview.h"
#include "resident.h"
#include "fontStaging.h"
#include <iostream>
#include <stdexcept>
#include <cmath>
#include <chrono>

static double number(const wchar_t* input) {
  size_t end = 0;
  const std::wstring text(input);
  double value = std::stod(text, &end);
  if (end != text.size() || !std::isfinite(value)) throw std::runtime_error("INPUT_INVALID");
  return value;
}
static uint32_t integer(const wchar_t* input) {
  double value = number(input);
  if (value < 0 || value > UINT32_MAX || std::floor(value) != value) throw std::runtime_error("INPUT_INVALID");
  return static_cast<uint32_t>(value);
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 7 && std::wstring(argv[1]) == L"--stage-font") {
      hfm_dw::watchParent(integer(argv[6]));
      return hfm_dw::stageFont(argv[2], argv[3], argv[4], argv[5]);
    }
    if (argc == 4 && std::wstring(argv[1]) == L"--prepare-font-store") {
      hfm_dw::watchParent(integer(argv[3]));
      return hfm_dw::prepareFontStore(argv[2]);
    }
    if (argc == 4 && std::wstring(argv[1]) == L"--serve") {
      return hfm_dw::serve(integer(argv[2]), integer(argv[3]));
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--probe") {
      hfm_dw::probe();
      std::cout << "{\"ok\":true,\"protocolVersion\":1,\"engine\":\"directwrite\",\"minimumWindows\":10,\"resident\":false,\"variableFonts\":false}\n";
      return 0;
    }
    if (argc != 9 || std::wstring(argv[1]) != L"--render") throw std::runtime_error("INPUT_INVALID");
    hfm_dw::Request request{argv[2], argv[4], argv[8], integer(argv[3]), integer(argv[6]), integer(argv[7]), number(argv[5])};
    auto start = std::chrono::steady_clock::now();
    auto result = hfm_dw::render(request);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
    std::cout << "{\"ok\":true,\"protocolVersion\":1,\"engine\":\"directwrite\",\"faceIndex\":" << result.faceIndex
      << ",\"glyphRuns\":" << result.glyphRuns << ",\"missingGlyphs\":" << result.missingGlyphs << ",\"elapsedMs\":" << ms << "}\n";
    return 0;
  } catch (const std::runtime_error& error) {
    // Engine errors are fixed codes, never paths or arbitrary font strings.
    std::cout << "{\"ok\":false,\"engine\":\"directwrite\",\"reason\":\"" << error.what() << "\"}\n";
  } catch (...) {
    std::cout << "{\"ok\":false,\"engine\":\"directwrite\",\"reason\":\"INPUT_INVALID\"}\n";
  }
  return 1;
}
