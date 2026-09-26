#pragma once
#include <windows.h>
#include <cstdint>
namespace hfm_dw {
constexpr uint64_t processMemoryLimit = 512ull * 1024 * 1024;
struct ProcessMemory { uint64_t current, peak; };
ProcessMemory processMemory();
class MemoryBudget {
  HANDLE job = nullptr;
public:
  MemoryBudget();
  ~MemoryBudget();
  MemoryBudget(const MemoryBudget&) = delete;
  MemoryBudget& operator=(const MemoryBudget&) = delete;
};
}
