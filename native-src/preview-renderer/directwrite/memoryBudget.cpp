#include "memoryBudget.h"
#include <psapi.h>
#include <stdexcept>
namespace hfm_dw {
MemoryBudget::MemoryBudget() {
  job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  limits.ProcessMemoryLimit = static_cast<SIZE_T>(processMemoryLimit);
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))
      || !AssignProcessToJobObject(job, GetCurrentProcess())) {
    if (job) CloseHandle(job); job = nullptr;
    throw std::runtime_error("MEMORY_LIMIT_UNAVAILABLE");
  }
}
MemoryBudget::~MemoryBudget() { if (job) CloseHandle(job); }
ProcessMemory processMemory() {
  PROCESS_MEMORY_COUNTERS_EX counters{}; counters.cb = sizeof(counters);
  if (!GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters), sizeof(counters)))
    throw std::runtime_error("MEMORY_METRICS_UNAVAILABLE");
  if (counters.PrivateUsage > processMemoryLimit) throw std::runtime_error("MEMORY_LIMIT_EXCEEDED");
  return {static_cast<uint64_t>(counters.PrivateUsage), static_cast<uint64_t>(counters.PeakPagefileUsage)};
}
}
