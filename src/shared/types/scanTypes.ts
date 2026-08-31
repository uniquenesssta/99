import type { FontItem } from './fontTypes'
import type { FolderCacheRepairStatus } from './libraryTypes'

export interface ScanResult {
  folders: string[]
  fonts: FontItem[]
  errors: Array<{ path: string; message: string }>
  stats?: ScanStats
  cacheOnly?: boolean
  cacheFolders?: string[]
  missingCacheFolders?: string[]
}

export interface ScanStats {
  totalFiles: number
  parsed: number
  fromCache: number
  reusedKnown?: number
  skippedBad: number
  errors: number
  durationMs: number
  cancelled?: boolean
  workerCount?: number
  queuedForWorkers?: number
}

export interface CacheStats {
  entries: number
  goodEntries: number
  badEntries: number
  sizeBytes: number
}

export interface WatchedFolderRefreshResult {
  ok: boolean
  folder: string
  rootPath: string
  mode: 'background' | 'cache-read' | 'incremental' | 'repair-rebuild'
  cacheRepairs: FolderCacheRepairStatus[]
  upserts: number
  deletes: number
  errors: number
  totalFiles: number
  parsed: number
  fromCache: number
  skippedBad: number
  workerCount?: number
  elapsedMs: number
  message: string
  jobId?: string
}

export interface FontIndexChangePayload {
  folder: string
  at: string
  upserts: FontItem[]
  deletes: Array<{ path: string; relativePath: string; id?: string }>
  errors?: Array<{ path: string; message: string }>
  source?: 'watcher' | 'scan-stream' | 'shared-metadata'
  jobId?: string
}


export interface FontTagMutationStateSignalPayload {
  scope: 'local' | 'shared'
  mutationKind: string
  changedIds: string[]
  updatedAt: string
  source: 'rust-daemon' | 'rust-worker' | 'node-fallback'
  localRevision?: number
  sharedRevision?: number
  knownTags?: string[]
  dirty?: {
    cache?: boolean
    pageQuery?: boolean
    metrics?: boolean
    mergedIndex?: boolean
  }
}

export interface FontIndexProgressPayload {
  jobId: string
  stage: 'start' | 'listing' | 'evaluating' | 'parsing' | 'writing' | 'done' | 'cancelled' | 'error'
  message: string
  at: string
  folders?: string[]
  totalFiles?: number
  listedFiles?: number
  stattedFiles?: number
  parsedFiles?: number
  fromCache?: number
  reusedKnown?: number
  skippedBad?: number
  workerCount?: number
  durationMs?: number
  errors?: number
}
