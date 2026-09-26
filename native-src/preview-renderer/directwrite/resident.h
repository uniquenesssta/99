#pragma once
#include <cstdint>
namespace hfm_dw { int serve(uint32_t generation, uint32_t parentPid); }

namespace hfm_dw { void watchParent(uint32_t parentPid); }
