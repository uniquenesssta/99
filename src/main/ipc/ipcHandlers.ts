import { createFontQueryConsumers, assertFontQueryActive } from '../library/fontQueryTaskRuntime';
import { assertApplicationOpen, applicationWorkEpoch } from '../app/shutdownCoordinatorRuntime';
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
  const consumers = createFontQueryConsumers();
  const handle = (channel: string, handler: IpcInvokeHandler): void => registerTracedIpcHandler(runtime, channel, async (event, ...args) => {
    if (channel === 'fonts:cancelQuery') return consumers.cancel(event.sender.id, args[0]);
    const execute = async () => {
      const ticket = applicationWorkEpoch();
      const closeSafe = channel === 'library:save' || channel === 'fonts:setLocalTags' || channel === 'fonts:setLocalTagsBatch' || channel.startsWith('performance:') || channel.startsWith('diagnostics:');
      if (!closeSafe) assertApplicationOpen(ticket);
      await admit(channel, args);
      assertFontQueryActive();
      if (!closeSafe) assertApplicationOpen(ticket);
      const result = await handler(event, ...args);
      assertFontQueryActive();
      if (channel === 'fonts:query' || channel === 'fonts:queryPage') await admit(channel, args);
      assertFontQueryActive();
      return result;
    };
    // Acquire ownership before admission can await a slow root availability read.
    if (channel === 'fonts:queryPage') return consumers.run(event.sender, 'page', args[1], execute);
    if (channel === 'fonts:getMetrics') return consumers.run(event.sender, 'metrics', args[0], execute);
    return execute();
  });
  handle('fonts:cancelQuery', () => undefined);
  handle('library:getSharedAvailability', () => runtime.getSharedAvailability());

  registerLibraryIpcHandlers(handle, runtime);
  registerMaintenanceIpcHandlers(handle, runtime);
  registerFontSystemIpcHandlers(handle, runtime);
  registerFontTagIpcHandlers(handle, runtime);
  registerPreviewAndFolderIpcHandlers(handle, runtime);
  registerSecurityIpcHandlers(handle, runtime);
}
