import { createSharedActionAdmission } from './sharedActionAdmissionRuntime';
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
  const admit = createSharedActionAdmission(runtime.getSharedAvailability);
  const handle = (channel: string, handler: IpcInvokeHandler): void => registerTracedIpcHandler(runtime, channel, async (event, ...args) => {
    await admit(channel, args);
    const result = await handler(event, ...args);
    if (channel === 'fonts:query' || channel === 'fonts:queryPage') await admit(channel, args);
    return result;
  });
  handle('library:getSharedAvailability', () => runtime.getSharedAvailability());

  registerLibraryIpcHandlers(handle, runtime);
  registerMaintenanceIpcHandlers(handle, runtime);
  registerFontSystemIpcHandlers(handle, runtime);
  registerFontTagIpcHandlers(handle, runtime);
  registerPreviewAndFolderIpcHandlers(handle, runtime);
  registerSecurityIpcHandlers(handle, runtime);
}
