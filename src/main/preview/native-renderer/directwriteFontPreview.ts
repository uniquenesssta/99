import type { DirectwriteInput } from './directwriteProtocol';
import type { DirectwriteService } from './directwriteService';
import type { DirectwriteFontStore, FontAdmission } from './directwriteFontStore';

// Explicit trial composition, called by the DW-05 backend selector. This is also
// the real integration-test entry point; the renderer never sees a NAS path.
export async function renderStagedDirectwrite(service: DirectwriteService, store: DirectwriteFontStore,
  sourcePath: string, input: Omit<DirectwriteInput, 'fontPath' | 'fontIdentity' | 'sourceGeneration'>, admission: FontAdmission) {
  const lease = await store.acquire(sourcePath, admission);
  try {
    const result = await service.render({ ...input, fontPath: lease.fontPath, fontIdentity: lease.fontIdentity,
      sourceGeneration: lease.sourceGeneration }, { signal: admission.signal, isCurrent: lease.current });
    if (!lease.current()) throw new Error('DW_STALE');
    return result;
  } finally {
    await service.whenCurrentExecutionClosed();
    await lease.release();
  }
}
