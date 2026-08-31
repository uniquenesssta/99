import { type IpcHandlerRuntime } from "../ipc/ipcHandlers";
import { mainGpuStartupRuntime } from "./mainGpuStartupRuntime";
import { createMainIpcRegistrar } from "./mainIpcRegistrationRuntime";
import {
registerMainProcessLifecycleRuntime,
type MainProcessLifecycleRuntimeOptions,
} from "./mainProcessLifecycleRuntime";

type LifecycleOptionsFromMain = Omit<
  MainProcessLifecycleRuntimeOptions,
  | "appendLog"
  | "gpuAccelerationSwitches"
  | "gpuDisableSwitches"
  | "configureGpuAcceleration"
  | "appendGpuStartupSwitchDiagnostics"
  | "appendGpuDiagnostics"
  | "registerIpc"
>;

export type MainProcessRuntimeRegistrationOptions = LifecycleOptionsFromMain &
  IpcHandlerRuntime & {
    appendStartupLog: (message: string) => void;
  };

export function registerMainProcessRuntime(
  options: MainProcessRuntimeRegistrationOptions,
): void {
  registerMainProcessLifecycleRuntime({
    ...options,
    appendLog: options.appendStartupLog,
    ...mainGpuStartupRuntime,
    registerIpc: createMainIpcRegistrar(options),
  });
}
