#pragma once
#include <string>
namespace hfm_dw {
int stageFont(const std::wstring& source, const std::wstring& authorized, const std::wstring& target, const std::wstring& knownDigest);
int fontPathInfo(const std::wstring& path);
int prepareFontStore(const std::wstring& parent);
}
