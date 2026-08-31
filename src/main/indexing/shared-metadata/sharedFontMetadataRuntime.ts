import type { FontItem } from '../../../shared/types'
import type { SharedMetadataMergePolicy } from './sharedMetadataFieldMergeRuntime'
import type { RustSharedMetadataApplyInput, RustSharedMetadataApplyResult, RustSharedMetadataMutationStateSignal, RustSharedMetadataRemoveTagInput, RustSharedMetadataRemoveTagResult, RustSharedMetadataSignatureInput, RustSharedMetadataOverlayReadInput, RustSharedMetadataOverlayReadResult, RustSharedMetadataSignatureResult } from '../../rust-core/rustCoreWorkerRuntime'
import type { FontScanCacheFile } from '../rootIndexRuntime'
import { createSharedMetadataDbRuntime } from './sharedMetadataDbRuntime'
import { createSharedMetadataLegacyImportRuntime } from './sharedMetadataLegacyImportRuntime'
import { createSharedMetadataLockRuntime } from './sharedMetadataLockRuntime'
import { createSharedMetadataMutationRuntime } from './sharedMetadataMutationRuntime'
import { createSharedMetadataOverlayRuntime } from './sharedMetadataOverlayRuntime'
import { sharedMetadataDbPathForRoot } from './sharedMetadataPathsRuntime'
import { createSharedMetadataSignatureRuntime } from './sharedMetadataSignatureRuntime'
import { createSharedTagOpsBackfillRuntime } from './sharedTagOpsBackfillRuntime'
import { createSharedTagOpsReplayRuntime } from './sharedTagOpsReplayRuntime'
import { createSharedMetadataMigrationDiagnosticsRuntime } from './sharedMetadataMigrationDiagnosticsRuntime'
import { createSharedMetadataRepairRuntime } from './sharedMetadataRepairRuntime'

export type { SharedMetadataState } from './sharedMetadataStateRuntime'

export type SharedMetadataCacheSource = {
  cache: FontScanCacheFile
  cachePath: string
  storage: 'root' | 'fallback'
}

export interface SharedFontMetadataRuntimeDeps {
  exists: (filePath: string) => Promise<boolean>
  openStableSqliteDb: (filePath: string, label: string) => any
  closeSqliteDb: (db: any) => void
  appendStartupLog: (message: string) => void
  uniqueResolvedFolders: (folders: string[]) => string[]
  findBestWatchedRootForFile: (filePath: string, folders: string[]) => string | null
  cacheKeyForRootFile: (rootPath: string, filePath: string) => string
  cacheEntryRuntimePath: (rootPath: string, entryPath: string) => string
  normalizePathForCacheCompare: (filePath: string) => string
  loadExistingFolderCache: (rootPath: string, options?: { applySharedMetadataOverlay?: boolean }) => Promise<SharedMetadataCacheSource | null>
  runRustSharedMetadataApply?: (input: RustSharedMetadataApplyInput) => Promise<RustSharedMetadataApplyResult | null>
  runRustSharedMetadataRemoveTag?: (input: RustSharedMetadataRemoveTagInput) => Promise<RustSharedMetadataRemoveTagResult | null>
  runRustSharedMetadataSignature?: (input: RustSharedMetadataSignatureInput) => Promise<RustSharedMetadataSignatureResult | null>
  runRustSharedMetadataOverlayRead?: (input: RustSharedMetadataOverlayReadInput) => Promise<RustSharedMetadataOverlayReadResult | null>
  onSharedMetadataMutationStateSignal?: (signal: RustSharedMetadataMutationStateSignal) => void
}

export interface SharedMetadataMutationOptions {
  watchedFolders: string[]
  items: FontItem[]
  emptyPathMessage: string
  outsideRootMessage: string
  missingIndexMessage: string
  missingEntryMessage: string
  mutateFont: (font: FontItem, item: FontItem) => FontItem
  mergePolicy?: SharedMetadataMergePolicy
}

export function createSharedFontMetadataRuntime(deps: SharedFontMetadataRuntimeDeps) {
  const { openSharedMetadataDb, readMeta, writeMeta } = createSharedMetadataDbRuntime(deps)
  const { withSharedMetadataWriteLock } = createSharedMetadataLockRuntime({
    appendStartupLog: deps.appendStartupLog,
  })
  const { ensureSharedTagOpsBackfilledInOpenDb, readSharedTagOpsBackfillDiagnosticsInOpenDb } = createSharedTagOpsBackfillRuntime({
    readMeta,
    writeMeta,
    appendStartupLog: deps.appendStartupLog,
  })
  const tagOpsReplayRuntime = createSharedTagOpsReplayRuntime({
    readMeta,
    writeMeta,
    appendStartupLog: deps.appendStartupLog,
  })
  function ensureSharedTagOpsReplayedInOpenDb(db: any, rootPath: string, reason = 'read') {
    ensureSharedTagOpsBackfilledInOpenDb(db, rootPath, reason)
    return tagOpsReplayRuntime.ensureSharedTagOpsReplayedInOpenDb(db, rootPath, reason)
  }
  const { readSharedTagOpsDiagnosticsInOpenDb, readSharedTagOpsConflictReportInOpenDb } = tagOpsReplayRuntime
  const { readSharedMetadataMigrationDiagnosticsInOpenDb } = createSharedMetadataMigrationDiagnosticsRuntime({
    readMeta,
  })
  const { repairSharedMetadataInOpenDb } = createSharedMetadataRepairRuntime({
    writeMeta,
    appendStartupLog: deps.appendStartupLog,
  })
  const { migrateLegacyMetadataFromCacheInOpenDb, ensureLegacyMetadataImported } = createSharedMetadataLegacyImportRuntime({
    runtimeDeps: deps,
    openSharedMetadataDb,
    readMeta,
    writeMeta,
  })
  const { applySharedMetadataOverlay, applySharedMetadataToMergedRows } = createSharedMetadataOverlayRuntime({
    exists: deps.exists,
    closeSqliteDb: deps.closeSqliteDb,
    appendStartupLog: deps.appendStartupLog,
    cacheEntryRuntimePath: deps.cacheEntryRuntimePath,
    openSharedMetadataDb,
    migrateLegacyMetadataFromCacheInOpenDb,
    ensureSharedTagOpsReplayedInOpenDb,
    runRustSharedMetadataOverlayRead: deps.runRustSharedMetadataOverlayRead,
  })
  const { updateSharedFontMetadataEntries, renameSharedTagInMetadataIndexes, removeSharedTagFromMetadataIndexes } = createSharedMetadataMutationRuntime({
    runtimeDeps: deps,
    openSharedMetadataDb,
    writeMeta,
    withSharedMetadataWriteLock,
    ensureLegacyMetadataImported,
  })
  const { sharedMetadataSignatureForRoot } = createSharedMetadataSignatureRuntime({
    runtimeDeps: deps,
    openSharedMetadataDb,
    readMeta,
  })

  return {
    sharedMetadataDbPathForRoot,
    openSharedMetadataDb,
    applySharedMetadataOverlay,
    applySharedMetadataToMergedRows,
    updateSharedFontMetadataEntries,
    renameSharedTagInMetadataIndexes,
    removeSharedTagFromMetadataIndexes,
    sharedMetadataSignatureForRoot,
    ensureSharedTagOpsReplayedInOpenDb,
    ensureSharedTagOpsBackfilledInOpenDb,
    readSharedTagOpsDiagnosticsInOpenDb,
    readSharedTagOpsConflictReportInOpenDb,
    readSharedTagOpsBackfillDiagnosticsInOpenDb,
    readSharedMetadataMigrationDiagnosticsInOpenDb,
    repairSharedMetadataInOpenDb,
  }
}

export type SharedFontMetadataRuntime = ReturnType<typeof createSharedFontMetadataRuntime>
