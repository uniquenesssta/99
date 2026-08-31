#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[log-regression-hardening] ${message}`)
    process.exit(1)
  }
}

const ipc = read('src/main/ipc/handlers/libraryIpcHandlers.ts')
assert(ipc.includes('selectFontFoldersDialogTask'), 'folder selection dialogs must be single-flight')
assert(ipc.includes('if (selectFontFoldersDialogTask) return selectFontFoldersDialogTask'), 'concurrent folder dialog requests must join the active dialog')

const folderAction = read('src/renderer/src/runtime/library/actions/fontLibraryFolderCacheActionRuntime.ts')
assert(folderAction.includes('if (addFolderTask) return addFolderTask'), 'rapid add-folder clicks must not create duplicate IPC requests')

const systemAction = read('src/renderer/src/runtime/library/actions/fontLibrarySystemScanActionRuntime.ts')
assert(systemAction.includes('if (scanAllFontsTask) return scanAllFontsTask'), 'scan-all must be single-flight while its folder dialog or scan is active')

const preview = read('src/main/preview/previewRuntime.ts')
assert(preview.includes('trying rust file-path fallback'), 'installed-font family render failure must continue to the Rust file-path renderer')
assert(!preview.includes('; no file fallback'), 'installed-font preview must not terminate before trying an existing font file')

const earlyVisible = read('src/main/indexing/scan-orchestrator/fontScanEarlyVisibleRuntime.ts')
assert(earlyVisible.includes('options.maxFonts || 300'), 'early-visible scans must cap placeholder upserts to protect renderer responsiveness')
assert(earlyVisible.includes('if (emitted >= maxFonts)'), 'early-visible cap must be enforced before enqueueing more placeholders')

const snapshot = read('src/main/indexing/root-index/rootIndexSnapshotRuntime.ts')
assert(snapshot.includes('const uninitialized = !activeExists && snapshots.length === 0'), 'an unbuilt shared index must be distinguished from a damaged active index')
assert(snapshot.includes('(activeExists || uninitialized)'), 'startup maintenance must not report a clean, never-built index as a failure')

console.log('[log-regression-hardening] ok')
