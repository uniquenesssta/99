#include "../../../native-src/preview-renderer/preview-input-policy.h"
#include <codecvt>
#include <iostream>
#include <locale>

int main() {
  std::string json;
  while (std::getline(std::cin, json)) {
    std::string text;
    bool ok = preview_input::stringValue(json, "text", text);
    size_t length = 0;
    try {
      length = std::wstring_convert<std::codecvt_utf8_utf16<char16_t>, char16_t>().from_bytes(text).size();
    } catch (...) { ok = false; }
    ok = ok && preview_input::valid(preview_input::numberValue(json, "width"),
      preview_input::numberValue(json, "height"), preview_input::numberValue(json, "fontSize"), length);
    if (!ok) { std::cout << "0\n"; continue; }
    if (text.empty()) text = u8"字体预览 AaBb 123";
    std::cout << "1 ";
    const char* hex = "0123456789abcdef";
    for (unsigned char c : text) std::cout << hex[c >> 4] << hex[c & 15];
    std::cout << '\n';
  }
}
