#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:library-persistence-order] ${message}`)
    process.exit(1)
  }
}

const autosave = read('src/renderer/src/runtime/app/effects/useLibraryAutosaveRuntime.ts')
for (const needle of [
  'libraryShellPersistenceKey',
  'commitLibraryUpdate',
  'setSynchronizedLibrary',
  'getCurrentLibrary',
  'pendingSaveRef',
  'saveLoopRef',
  'lastPersistedKeyRef',
  'SAVE_RETRY_DELAYS_MS',
  'scheduleBackgroundRetry',
  'flushLibraryPersistence',
  "if (confirmed !== true) throw new Error('主进程未确认库状态保存成功')"
]) assert(autosave.includes(needle), `library persistence runtime missing ${needle}`)

assert(autosave.includes('const latestLibrary = currentLibraryRef.current'), 'queued saves must compare against the latest committed library')
assert(autosave.includes('requestedLibrary && requestedKey === latestKey ? requestedLibrary : latestLibrary'), 'stale save requests must promote to the latest committed shell')
assert(autosave.includes('if (pending?.key === keyToPersist) return pending'), 'equivalent pending shell saves must be coalesced')
assert(autosave.includes('if (pendingSaveRef.current?.revision === target.revision)'), 'a completed stale revision must not clear a newer pending save')
assert(autosave.includes('void saveLibraryImmediately(currentLibraryRef.current)'), 'debounced autosave must read the latest committed library at execution time')
assert(autosave.includes('onPersistenceRecoveredRef.current?.()'), 'persistence recovery must invalidate stale database-derived state')

const app = read('src/renderer/src/App.tsx')
assert(app.includes('useLibraryAutosaveRuntime({'), 'App must use the shared library persistence runtime')
assert(app.includes('const [library, setLibraryState] = useState<LibraryState>'), 'App must keep the raw React setter private to the persistence runtime')
assert(app.includes('onPersistenceRecovered: refreshDatabaseDerivedState'), 'App must refresh database-derived state after persistence recovery')
assert(app.includes('flushLibraryPersistence'), 'App must expose the persistence flush to the close lifecycle')
assert(!app.includes('window.hfm.saveLibrary(library).catch'), 'App must not keep a duplicate inline autosave implementation')

const files = [
  'src/renderer/src/runtime/library/actions/fontLibraryIndexOperationActionRuntime.ts',
  'src/renderer/src/runtime/library/actions/fontLibrarySystemScanActionRuntime.ts',
  'src/renderer/src/runtime/app/effects/useFontIndexChangedEventRuntime.ts',
  'src/renderer/src/runtime/app/effects/useFontTagStateSignalEventRuntime.ts'
]
for (const rel of files) {
  const source = read(rel)
  assert(!/let\s+\w+[^\n]*=\s*null[\s\S]{0,500}setLibrary\(\(prev\)/.test(source), `${rel} still relies on setState updater side effects`)
  assert(source.includes('commitLibraryUpdate'), `${rel} must commit through the shared library persistence runtime`)
}

const indexRuntime = read('src/renderer/src/runtime/library/actions/fontLibraryIndexOperationActionRuntime.ts')
const firstSave = indexRuntime.indexOf('await options.saveLibraryImmediately(nextLibrary)')
const firstMetricsRefresh = indexRuntime.indexOf('await sharedRuntime.finishIndexingWithoutFullInstallRefresh')
assert(firstSave >= 0 && firstMetricsRefresh >= 0 && firstSave < firstMetricsRefresh, 'index metrics refresh must happen after library persistence')

const tagSignal = read('src/renderer/src/runtime/app/effects/useFontTagStateSignalEventRuntime.ts')
assert(tagSignal.indexOf('current.refreshDatabaseDerivedState()') < tagSignal.indexOf('await current.saveLibraryImmediately(nextLibrary)'), 'tag-derived database requests must be invalidated before waiting for shell persistence')

const dialogRuntime = read('src/renderer/src/fontDialogRuntime.ts')
const renameCommit = dialogRuntime.indexOf('const nextLibrary = options.commitLibraryUpdate((prev) => replaceFolderPathInLibrary')
const renameSave = dialogRuntime.indexOf('await options.saveLibraryImmediately(nextLibrary)', renameCommit)
const renameRefresh = dialogRuntime.indexOf('await refreshIndexesAfterPhysicalMutation({', renameSave)
assert(renameCommit >= 0 && renameSave > renameCommit && renameRefresh > renameSave, 'physical folder rename must persist the new path before scheduling affected-root index refresh')
assert(dialogRuntime.includes('affectedPaths: [oldPath, newPath]'), 'physical folder rename must reconcile both the old and new paths through their watched roots')

console.log('[diagnostics:library-persistence-order] ok')
