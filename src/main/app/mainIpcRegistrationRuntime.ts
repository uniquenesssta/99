import { registerIpcHandlers,type IpcHandlerRuntime } from "../ipc/ipcHandlers";

export type MainIpcRegistrationRuntimeOptions = IpcHandlerRuntime & {
  appendStartupLog: (message: string) => void;
};

export function createMainIpcRegistrar(
  options: MainIpcRegistrationRuntimeOptions,
): () => void {
  return (): void => {
    registerIpcHandlers({ ...options, appendLog: options.appendStartupLog });
  };
}
