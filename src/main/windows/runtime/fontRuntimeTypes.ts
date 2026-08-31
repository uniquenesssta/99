export type FontRefreshMode = 'light' | 'standard' | 'strong'

export interface TemporaryActiveFontRecord {
  fontId: string
  sourcePath: string
  installPath: string
  registryName: string
  activatedAt: string
  fileName: string
}

export interface TemporaryActiveFontsFile {
  version: 1
  records: TemporaryActiveFontRecord[]
}

export interface PendingFontRefreshRequest {
  reason: string
  mode: FontRefreshMode
  requestedAt: number
  force: boolean
}

export interface FontRefreshRuntimeStats {
  requested: number
  coalesced: number
  completed: number
  failed: number
  skippedRecent: number
  lastReason: string
  lastMode: FontRefreshMode | ''
  lastElapsedMs: number
  lastBroadcastAt: number
  pending: boolean
  inFlight: boolean
}

export interface NativeFontHelperRow {
  path?: string
  Path?: string
  ok?: boolean
  Ok?: boolean
  count?: number
  Count?: number
  message?: string
  Message?: string
}

export interface NativeFontHelperPayload {
  ok?: boolean
  count?: number
  failed?: number
  message?: string
  results?: NativeFontHelperRow[]
}

export interface WindowsFontRuntimeOptions {
  appName: string
  fontExtensions: Set<string>
  dataRoot: () => string
  dataPath: (...parts: string[]) => string
  appendStartupLog: (message: string) => void
  runRustFontResourceAdd?: (paths: string[], options?: { notify?: boolean; reason?: string; strong?: boolean }) => Promise<FontResourceBatchResult | null>
  runRustFontResourceRemove?: (paths: string[], options?: { notify?: boolean; reason?: string; strong?: boolean }) => Promise<FontResourceBatchResult | null>
  runRustFontRegistryApply?: (records: Array<{ name: string; path: string }>) => Promise<{ ok: boolean; count: number; failed: number } | null>
  runRustFontRegistryDelete?: (names: string[]) => Promise<{ ok: boolean; count: number; failed: number } | null>
  runRustFontChangeNotify?: (options?: { strong?: boolean; reason?: string }) => Promise<{ ok: boolean } | null>
}

export interface FontResourceBatchEntry {
  ok: boolean
  count: number
  message: string
}

export type FontResourceBatchResult = Record<string, FontResourceBatchEntry>
