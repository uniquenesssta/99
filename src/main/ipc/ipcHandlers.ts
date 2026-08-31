import { registerFontSystemIpcHandlers } from "./handlers/fontSystemIpcHandlers";
import { registerFontTagIpcHandlers } from "./handlers/fontTagIpcHandlers";
import { registerLibraryIpcHandlers } from "./handlers/libraryIpcHandlers";
import { registerMaintenanceIpcHandlers } from "./handlers/maintenanceIpcHandlers";
import { registerPreviewAndFolderIpcHandlers } from "./handlers/previewAndFolderIpcHandlers";
import { registerSecurityIpcHandlers } from "./handlers/securityIpcHandlers";
import type { IpcHandlerRuntime,IpcInvokeHandler } from "./ipcHandlerTypes";
import { registerTracedIpcHandler } from "./ipcTraceRuntime";

export type { IpcHandlerRuntime,RendererPerformanceEventPayload } from "./ipcHandlerTypes";

export function registerIpcHandlers(runtime: IpcHandlerRuntime): void {
  const handle = (channel: string, handler: IpcInvokeHandler): void => registerTracedIpcHandler(runtime, channel, handler);

  registerLibraryIpcHandlers(handle, runtime);
  registerMaintenanceIpcHandlers(handle, runtime);
  registerFontSystemIpcHandlers(handle, runtime);
  registerFontTagIpcHandlers(handle, runtime);
  registerPreviewAndFolderIpcHandlers(handle, runtime);
  registerSecurityIpcHandlers(handle, runtime);
}
