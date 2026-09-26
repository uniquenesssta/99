#include "resident.h"
#include "preview.h"
#include <windows.h>
#include <tlhelp32.h>
#include <iostream>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <vector>
#include <cstring>
#include <stdexcept>
#include <chrono>

namespace hfm_dw {
namespace {
constexpr uint32_t protocolVersion = 1, maxFrame = 65536;
[[noreturn]] void stop(UINT code) { TerminateProcess(GetCurrentProcess(), code); std::terminate(); }
void require(bool ok) { if (!ok) throw std::runtime_error("PROTOCOL_INVALID"); }

// Bind to the actual parent object before advertising readiness. Creation time
// guards PID reuse between process creation, the snapshot and OpenProcess.
HANDLE openParent(uint32_t pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  require(snapshot != INVALID_HANDLE_VALUE);
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  bool matched = false;
  if (Process32FirstW(snapshot, &entry)) do {
    if (entry.th32ProcessID == GetCurrentProcessId()) {
      matched = entry.th32ParentProcessID == pid; break;
    }
  } while (Process32NextW(snapshot, &entry));
  CloseHandle(snapshot);
  require(matched && pid != 0);
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  require(parent != nullptr);
  FILETIME parentCreated{}, selfCreated{}, exit{}, kernel{}, user{};
  bool valid = GetProcessTimes(parent, &parentCreated, &exit, &kernel, &user)
    && GetProcessTimes(GetCurrentProcess(), &selfCreated, &exit, &kernel, &user)
    && CompareFileTime(&parentCreated, &selfCreated) <= 0
    && WaitForSingleObject(parent, 0) == WAIT_TIMEOUT;
  if (!valid) { CloseHandle(parent); throw std::runtime_error("PARENT_UNAVAILABLE"); }
  return parent;
}
void readExact(void* target, DWORD size) {
  auto bytes = static_cast<unsigned char*>(target);
  while (size) {
    DWORD read = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes, size, &read, nullptr) || !read) stop(0);
    size -= read; bytes += read;
  }
}
struct Decoder {
  const std::vector<unsigned char>& bytes; size_t offset = 0;
  template<class T> T take() {
    require(offset + sizeof(T) <= bytes.size()); T value;
    std::memcpy(&value, bytes.data() + offset, sizeof(T)); offset += sizeof(T); return value;
  }
  std::wstring wide(uint32_t limit) {
    uint32_t count = take<uint32_t>(); require(count <= limit && offset + count * 2 <= bytes.size());
    std::wstring value(count, L'\0');
    std::memcpy(value.data(), bytes.data() + offset, count * 2); offset += count * 2;
    require(value.find(L'\0') == std::wstring::npos); return value;
  }
  std::string token(size_t count) {
    require(offset + count <= bytes.size());
    std::string value(reinterpret_cast<const char*>(bytes.data() + offset), count); offset += count;
    require(value.find_first_not_of("0123456789abcdef") == std::string::npos); return value;
  }
};
}

int serve(uint32_t generation, uint32_t parentPid) {
  require(generation != 0);
  HANDLE parent = openParent(parentPid);
  std::thread([parent] {
    WaitForSingleObject(parent, INFINITE);
    // Independent of DirectWrite and stdin: a hung draw cannot orphan us.
    stop(2);
  }).detach();
  std::mutex mutex; std::condition_variable ready;
  std::vector<unsigned char> pending;
  // The reader continues observing EOF even while the rendering thread is busy.
  std::thread([&] {
    for (;;) {
      uint32_t length; readExact(&length, sizeof(length));
      if (!length || length > maxFrame) stop(3);
      std::vector<unsigned char> frame(length); readExact(frame.data(), length);
      std::lock_guard<std::mutex> lock(mutex);
      if (!pending.empty()) stop(3);
      pending = std::move(frame); ready.notify_one();
    }
  }).detach();
  // Once threads refer to the stack, all exits must terminate the process.
  try {
    probe();
    std::cout << "{\"type\":\"ready\",\"protocolVersion\":1,\"renderVersion\":1,\"engine\":\"directwrite\",\"resident\":true,\"serviceGeneration\":"
      << generation << ",\"parentPid\":" << parentPid << ",\"variableFonts\":false}\n" << std::flush;
    uint32_t lastId = 0;
    for (;;) {
      std::vector<unsigned char> bytes;
      { std::unique_lock<std::mutex> lock(mutex); ready.wait(lock, [&] { return !pending.empty(); }); bytes.swap(pending); }
      Decoder frame{bytes};
      require(frame.take<uint32_t>() == protocolVersion);
      require(frame.take<uint32_t>() == generation);
      uint32_t id = frame.take<uint32_t>(); require(id > lastId); lastId = id;
      uint32_t sourceGeneration = frame.take<uint32_t>();
      require(frame.take<uint32_t>() == 1); // Fixed DW-01 rendering semantics.
      Request request;
      request.faceIndex = frame.take<uint32_t>(); request.width = frame.take<uint32_t>(); request.height = frame.take<uint32_t>();
      request.fontSize = frame.take<double>();
      auto fontIdentity = frame.token(64), outputIdentity = frame.token(32);
      request.fontPath = frame.wide(8192); request.text = frame.wide(4096); request.outputPath = frame.wide(8192);
      require(frame.offset == bytes.size());
      auto start = std::chrono::steady_clock::now();
      Result result{}; std::string reason;
      try { result = render(request); } catch (const std::runtime_error& error) { reason = error.what(); }
      catch (...) { reason = "RENDER_FAILED"; }
      // Never interpolate arbitrary error text into the receipt.
      if (reason.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789") != std::string::npos) reason = "RENDER_FAILED";
      auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
      std::cout << "{\"type\":\"result\",\"protocolVersion\":1,\"renderVersion\":1,\"engine\":\"directwrite\",\"serviceGeneration\":" << generation
        << ",\"requestId\":" << id << ",\"sourceGeneration\":" << sourceGeneration << ",\"fontIdentity\":\"" << fontIdentity
        << "\",\"outputIdentity\":\"" << outputIdentity << "\",\"faceIndex\":" << request.faceIndex
        << ",\"ok\":" << (reason.empty() ? "true" : "false") << ",\"reason\":\"" << reason
        << "\",\"glyphRuns\":" << result.glyphRuns << ",\"missingGlyphs\":" << result.missingGlyphs << ",\"elapsedMs\":" << ms << "}\n" << std::flush;
      if (!std::cout) stop(4);
    }
  } catch (...) { stop(3); }
}
}
