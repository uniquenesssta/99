const assert = require('node:assert/strict')

// The immutable composition baselines predate retirement of the unread cache
// statistics state. Reconstruct only those deleted ports for their old hashes;
// current behavior and 41 live owners are checked independently.
function restoreRetiredCacheStatsPorts(file, source) {
  source = source.replace(/\r\n/g, '\n')
  const replace = (before, after) => {
    assert.equal(source.split(before).length - 1, 1, `${file}: retired cache stats migration anchor changed`)
    source = source.replace(before, after)
  }
  if (file === 'src/renderer/src/App.tsx') {
    assert(!/\b(?:setCacheStats|loadCacheStats)\b/.test(source), 'App regained unread cache statistics ports')
    replace('    setDatabaseRefreshToken,\n    libraryLoadedRef,', '    setDatabaseRefreshToken,\n    setCacheStats,\n    libraryLoadedRef,')
    replace('      setIndexingActive,\n      clearDatabaseRefreshTimer,', '      setIndexingActive,\n      setCacheStats,\n      clearDatabaseRefreshTimer,')
    replace('    deactivateFontsBatch,\n    readPhysicalFolderTree,', '    deactivateFontsBatch,\n    loadCacheStats,\n    readPhysicalFolderTree,')
    replace('    restoreFontScrollSnapshot,\n    getCurrentLibrary,\n    commitLibraryUpdate,\n    saveLibraryImmediately,', '    restoreFontScrollSnapshot,\n    getCurrentLibrary,\n    commitLibraryUpdate,\n    saveLibraryImmediately,\n    loadCacheStats,')
  } else if (file === 'src/renderer/src/runtime/app/useLibraryController.ts') {
    assert(!/\b(?:CacheStats|setCacheStats)\b/.test(source), 'Library regained unread cache statistics state')
    replace('import type { FontQueryPageResult,', 'import type { CacheStats,FontQueryPageResult,')
    replace('  const databaseRefreshTimerRef = useRef<number | null>(null)', '  const [, setCacheStats] = useState<CacheStats | null>(null)\n  const databaseRefreshTimerRef = useRef<number | null>(null)')
    replace('    libraryLoadedRef: libraryLoadedRef as Readonly<{ current: boolean }>,', '    setCacheStats,\n    libraryLoadedRef: libraryLoadedRef as Readonly<{ current: boolean }>,')
  } else if (file === 'src/renderer/src/runtime/app/useFontOperationsController.ts') {
    assert(!/\b(?:CacheStats|CacheStatsRequestState|cacheStatsRequestState|setCacheStats|loadCacheStats)\b/.test(source), 'Operations regained unread cache statistics ownership')
    replace('import type { FontItem,', 'import type { CacheStats,FontItem,')
    replace("import { createFontLibraryIndexActionRuntime }", "import type { CacheStatsRequestState } from '../library/actions/fontLibraryIndexActionTypes'\nimport { createFontLibraryIndexActionRuntime }")
    replace('  clearDatabaseRefreshTimer: () => void', '  setCacheStats: Dispatch<SetStateAction<CacheStats | null>>\n  clearDatabaseRefreshTimer: () => void')
    replace('  const libraryIndexActionRuntime = createFontLibraryIndexActionRuntime({\n', '  const cacheStatsRequestState = useRef<CacheStatsRequestState>({ active: null, requested: 0 })\n  const libraryIndexActionRuntime = createFontLibraryIndexActionRuntime({\n    cacheStatsRequestState,\n    closingLifecycle: options.closingLifecycle,\n')
    replace('    commitLibraryUpdate: options.library.commitLibraryUpdate,\n    setStatus: options.library.setStatus,', '    commitLibraryUpdate: options.library.commitLibraryUpdate,\n    setStatus: options.library.setStatus,\n    setCacheStats: options.library.setCacheStats,')
    replace('    readPhysicalFolderTree: libraryIndexActionRuntime.readPhysicalFolderTree,', '    loadCacheStats: libraryIndexActionRuntime.loadCacheStats,\n    readPhysicalFolderTree: libraryIndexActionRuntime.readPhysicalFolderTree,')
  }
  return source
}

module.exports = { restoreRetiredCacheStatsPorts }
