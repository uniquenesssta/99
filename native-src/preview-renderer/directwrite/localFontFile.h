#pragma once
#include <string>
#include <vector>
namespace hfm_dw {
std::wstring localPath(const std::wstring& input, bool newFile);
struct FontSnapshot { std::wstring path; std::string digest; std::vector<unsigned char> bytes; };
FontSnapshot readLocalFont(const std::wstring& input);
}
