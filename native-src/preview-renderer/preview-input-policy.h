#pragma once
#include <cmath>
#include <cstddef>
#include <limits>
#include <regex>
#include <string>

namespace preview_input {
// Mirrors previewInputPolicy.ts; checked by diagnostics:preview-input-boundary.
constexpr unsigned MIN_WIDTH = 64;
constexpr unsigned MAX_WIDTH = 4096;
constexpr unsigned MIN_HEIGHT = 32;
constexpr unsigned MAX_HEIGHT = 2048;
constexpr double MIN_FONT_SIZE = 8;
constexpr double MAX_FONT_SIZE = 320;
constexpr size_t MAX_TEXT_LENGTH = 4096;

inline bool valid(double width, double height, double fontSize, size_t textLength) {
  return std::isfinite(width) && std::isfinite(height) && std::isfinite(fontSize)
    && width >= MIN_WIDTH && width <= MAX_WIDTH && std::floor(width) == width
    && height >= MIN_HEIGHT && height <= MAX_HEIGHT && std::floor(height) == height
    && fontSize >= MIN_FONT_SIZE && fontSize <= MAX_FONT_SIZE && textLength <= MAX_TEXT_LENGTH;
}

// Locate a top-level property, skipping quoted values and nested objects.
inline size_t valueStart(const std::string& json, const char* key) {
  int depth = 0;
  for (size_t i = 0; i < json.size(); ++i) {
    if (json[i] == '{' || json[i] == '[') { ++depth; continue; }
    if (json[i] == '}' || json[i] == ']') { --depth; continue; }
    if (json[i] != '"') continue;
    size_t start = ++i;
    for (; i < json.size(); ++i) {
      if (json[i] == '\\') { ++i; continue; }
      if (json[i] == '"') break;
    }
    if (depth != 1 || json.compare(start, i - start, key) != 0) continue;
    size_t colon = json.find_first_not_of(" \t\r\n", i + 1);
    if (colon == std::string::npos || json[colon] != ':') continue;
    return json.find_first_not_of(" \t\r\n", colon + 1);
  }
  return std::string::npos;
}

inline double numberValue(const std::string& json, const char* key) {
  const double invalid = std::numeric_limits<double>::quiet_NaN();
  const size_t start = valueStart(json, key);
  if (start == std::string::npos) return invalid;
  const size_t end = json.find_first_of(",} \t\r\n", start);
  const std::string token = json.substr(start, end == std::string::npos ? end : end - start);
  if (token.size() > 64) return invalid;
  static const std::regex number("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?");
  if (!std::regex_match(token, number)) return invalid;
  try { return std::stod(token); } catch (...) { return invalid; }
}

inline bool stringValue(const std::string& json, const char* key, std::string& out) {
  size_t p = valueStart(json, key);
  out.clear();
  if (p == std::string::npos || json[p++] != '"') return false;
  auto hex4 = [&](unsigned& value) {
    value = 0;
    for (int n = 0; n < 4; ++n) {
      if (p >= json.size()) return false;
      char c = json[p++];
      unsigned digit;
      if (c >= '0' && c <= '9') digit = c - '0';
      else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
      else return false;
      value = value * 16 + digit;
    }
    return true;
  };
  while (p < json.size()) {
    unsigned char c = json[p++];
    if (c == '"') return true;
    if (c < 0x20) return false;
    if (c != '\\') { out.push_back(c); continue; }
    if (p >= json.size()) return false;
    switch (json[p++]) {
      case '"': out.push_back('"'); break;
      case '\\': out.push_back('\\'); break;
      case '/': out.push_back('/'); break;
      case 'b': out.push_back('\b'); break;
      case 'f': out.push_back('\f'); break;
      case 'n': out.push_back('\n'); break;
      case 'r': out.push_back('\r'); break;
      case 't': out.push_back('\t'); break;
      case 'u': {
        unsigned cp;
        if (!hex4(cp)) return false;
        if (cp >= 0xd800 && cp <= 0xdbff) {
          if (json.compare(p, 2, "\\u") != 0) return false;
          p += 2;
          unsigned low;
          if (!hex4(low) || low < 0xdc00 || low > 0xdfff) return false;
          cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
        } else if (cp >= 0xdc00 && cp <= 0xdfff) return false;
        if (cp < 0x80) out.push_back(static_cast<char>(cp));
        else {
          if (cp < 0x800) out.push_back(static_cast<char>(0xc0 | (cp >> 6)));
          else {
            if (cp < 0x10000) out.push_back(static_cast<char>(0xe0 | (cp >> 12)));
            else {
              out.push_back(static_cast<char>(0xf0 | (cp >> 18)));
              out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3f)));
            }
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
          }
          out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
        }
        break;
      }
      default: return false;
    }
  }
  return false;
}
}
