import {
appendGpuDiagnostics as appendGpuDiagnosticsLog,
appendGpuStartupSwitchDiagnostics as appendGpuStartupSwitchDiagnosticsLog,
configureGpuAcceleration as configureGpuAccelerationSwitches,
} from "../gpu/diagnostics";

export const GPU_ACCELERATION_SWITCHES: Array<[name: string, value?: string]> = [
  ["ignore-gpu-blocklist"],
  ["enable-gpu-rasterization"],
  ["enable-zero-copy"],
  ["use-angle", "d3d11"],
  ["force_high_performance_gpu"],
];

export const GPU_DISABLE_SWITCHES = [
  "disable-gpu",
  "disable-software-rasterizer",
  "disable-gpu-compositing",
  "disable-accelerated-2d-canvas",
  "disable-accelerated-video-decode",
];

export const mainGpuStartupRuntime = {
  gpuAccelerationSwitches: GPU_ACCELERATION_SWITCHES,
  gpuDisableSwitches: GPU_DISABLE_SWITCHES,
  configureGpuAcceleration: configureGpuAccelerationSwitches,
  appendGpuStartupSwitchDiagnostics: appendGpuStartupSwitchDiagnosticsLog,
  appendGpuDiagnostics: appendGpuDiagnosticsLog,
};
