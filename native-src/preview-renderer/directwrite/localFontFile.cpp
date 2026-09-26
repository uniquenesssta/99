#include "localFontFile.h"
#include <windows.h>
#include <bcrypt.h>
#include <stdexcept>

namespace hfm_dw {
// This proof entry point accepts fixed/removable local paths only. Reject all
// reparse components before opening files; network staging belongs to DW-04.
std::wstring localPath(const std::wstring& input, bool newFile) {
  if (input.size() < 3 || input[1] != L':' || input[2] != L'\\' || input.find(L'\0') != std::wstring::npos
      || input.find(L':', 2) != std::wstring::npos) throw std::runtime_error("LOCAL_PATH_REQUIRED");
  DWORD length = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  if (!length || length > 32768) throw std::runtime_error("PATH_INVALID");
  std::wstring full(length, L'\0');
  DWORD written = GetFullPathNameW(input.c_str(), length, full.data(), nullptr);
  if (!written || written >= length) throw std::runtime_error("PATH_INVALID");
  full.resize(written);
  UINT drive = GetDriveTypeW(full.substr(0, 3).c_str());
  if (drive != DRIVE_FIXED && drive != DRIVE_REMOVABLE) throw std::runtime_error("LOCAL_PATH_REQUIRED");
  for (size_t end = 3; end <= full.size(); ++end) {
    if (end < full.size() && full[end] != L'\\') continue;
    DWORD attrs = GetFileAttributesW(full.substr(0, end).c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) {
      if (newFile && end == full.size() && GetLastError() == ERROR_FILE_NOT_FOUND) continue;
      throw std::runtime_error("PATH_UNAVAILABLE");
    }
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) throw std::runtime_error("REPARSE_NOT_SUPPORTED");
    if (newFile && end == full.size()) throw std::runtime_error("OUTPUT_EXISTS");
  }
  return full;
}

FontSnapshot readLocalFont(const std::wstring& input) {
  FontSnapshot result; result.path = localPath(input, false);
  struct File { HANDLE value; ~File() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
  File file{CreateFileW(result.path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  LARGE_INTEGER size{};
  if (file.value == INVALID_HANDLE_VALUE || !GetFileSizeEx(file.value, &size)) throw std::runtime_error("FONT_READ_FAILED");
  if (size.QuadPart <= 0 || size.QuadPart > 64*1024*1024) throw std::runtime_error("FONT_SIZE_UNSUPPORTED");
  result.bytes.resize(static_cast<size_t>(size.QuadPart));
  DWORD offset = 0;
  while (offset < result.bytes.size()) {
    DWORD read = 0;
    if (!ReadFile(file.value, result.bytes.data() + offset, static_cast<DWORD>(result.bytes.size() - offset), &read, nullptr) || !read)
      throw std::runtime_error("FONT_READ_FAILED");
    offset += read;
  }
  unsigned char digest[32];
  if (BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, result.bytes.data(), static_cast<ULONG>(result.bytes.size()), digest, sizeof(digest)) < 0)
    throw std::runtime_error("FONT_HASH_FAILED");
  const char* hex = "0123456789abcdef";
  for (auto byte : digest) { result.digest += hex[byte >> 4]; result.digest += hex[byte & 15]; }
  return result;
}
} // namespace hfm_dw
