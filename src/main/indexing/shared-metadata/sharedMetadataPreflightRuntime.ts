import os from 'node:os'
import type { FontScanCacheFile } from '../rootIndexRuntime'
import type { RustSharedMetadataOverlayReadInput, RustSharedMetadataOverlayReadResult, RustSharedMetadataPreflight } from '../../rust-core/rustCoreWorkerContracts'
import { SharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { fontPathKey, stateFromFont } from './sharedMetadataStateRuntime'
import { planSharedTagOpsReplay } from './sharedTagOpsReplayRuntime'
import { sharedMetadataDbPathForRoot } from './sharedMetadataPathsRuntime'

export async function prepareSharedMetadataInWorker(
  run: (input: RustSharedMetadataOverlayReadInput) => Promise<RustSharedMetadataOverlayReadResult | null>,
  rootPath: string,
  cacheEntryRuntimePath: (root: string, path: string) => string,
  cache?: FontScanCacheFile,
): Promise<void> {
  const legacy = cache ? Object.entries(cache.entries || {}).flatMap(([relativePath, entry]) => {
    if (!entry.font?.id) return []
    const state = stateFromFont(entry.font)
    if (!state.tagNames.length && !state.favorite && !state.deleteProtected) return []
    return [{ fontId: entry.font.id, relativePath: relativePath.replace(/\\/g, '/'),
      pathKey: fontPathKey(entry.font, cacheEntryRuntimePath(rootPath, entry.path || relativePath)), ...state }]
  }) : undefined
  const preflight: RustSharedMetadataPreflight = { phase: 'snapshot', updatedAt: new Date().toISOString(), updatedBy: os.hostname(), writerPid: process.pid, legacy }
  const input = { rootPath, dbPath: sharedMetadataDbPathForRoot(rootPath), entries: [] }
  const result = await run({ ...input, preflight })
  const snapshot = result?.preflight?.snapshot
  if (result?.preflight?.version !== 1 || result.preflight.phase !== 'snapshot' || !snapshot?.token || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.ops) || !snapshot.meta) {
    throw new SharedIoProcessError('共享迁移快照未确认，请更新原生 worker 后重试。', 'unknown', 'invalid-receipt')
  }
  const plan = planSharedTagOpsReplay(snapshot.rows, snapshot.ops, snapshot.meta, preflight.updatedAt, 'isolated-preflight')
  const committed = await run({ ...input, preflight: { ...preflight, legacy: undefined, phase: 'commit', token: snapshot.token, plan } })
  if (committed?.preflight?.version !== 1 || committed.preflight.phase !== 'commit') {
    throw new SharedIoProcessError('共享迁移提交未确认，未重放写入。', 'unknown', 'invalid-receipt')
  }
}
