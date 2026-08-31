#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:physical-mutation-index] ${message}`)
    process.exit(1)
  }
}

const runtimeSource = read('src/renderer/src/runtime/library/fontPhysicalMutationIndexRuntime.ts')
for (const needle of [
  'affectedWatchedRootsForPaths',
  'refreshIndexesAfterPhysicalMutation',
  'physicalMutationIndexRefreshSuffix',
  "await args.hfm.refreshWatchedFolder(root, root)",
  'path === root || path.startsWith(`${root}\\\\`)'
]) assert(runtimeSource.includes(needle), `physical mutation reconciliation runtime missing ${needle}`)

const folderRuntime = read('src/renderer/src/fontFolderTreeRuntime.ts')
assert(folderRuntime.includes('affectedPaths: [result.oldPath || font.path, result.newPath || font.path]'), 'single-font move must refresh roots containing both source and destination paths')
assert(folderRuntime.includes('movedUpdates.flatMap((update) => [update.result.oldPath'), 'batch move must collect all moved source and destination paths')
assert(folderRuntime.includes('physicalMutationIndexRefreshSuffix(refreshReport)'), 'move status must expose index refresh scheduling failures')

const mutationRuntime = read('src/renderer/src/fontFolderMutationRuntime.ts')
assert(mutationRuntime.includes('delete nextFontFolderIds[fontId]'), 'single-font physical move must remove stale explicit folder assignments')
assert(mutationRuntime.includes('delete nextFontFolderIds[update.id]'), 'batch physical move must remove stale explicit folder assignments')
assert(!mutationRuntime.includes('Array.from(new Set([...current, folderId]))'), 'physical moves must not accumulate historical folder assignments')

const normalizeRuntime = read('src/renderer/src/library-normalize/libraryNormalizeStateRuntime.ts')
assert(normalizeRuntime.includes('!isPhysicalFolderId(id) || fontInsideRootFolder(font, id)'), 'folder assignment pruning must remove physical assignments that no longer match the font path')

const dialogRuntime = read('src/renderer/src/fontDialogRuntime.ts')
assert(dialogRuntime.includes('affectedPaths: [oldPath, newPath]'), 'folder rename must reconcile both old and new paths')
assert(!dialogRuntime.includes('await options.refreshFolderTarget({'), 'folder rename must not refresh only the renamed child directory')

const deleteRuntime = read('src/renderer/src/runtime/system/actions/fontDeleteActionRuntime.ts')
assert(deleteRuntime.includes('const currentLibrary = options.getCurrentLibrary()'), 'physical delete must use the latest watched roots')
assert(deleteRuntime.includes('affectedPaths: deletedPaths'), 'physical delete must refresh roots containing deleted files')
assert(deleteRuntime.includes('options.getCurrentSelectedFontId()'), 'physical delete must not clear a newer selection through a stale async closure')
assert(!deleteRuntime.includes('options.refreshDatabaseDerivedState()'), 'physical delete must not query the stale merged index before root reconciliation')

function loadRuntime() {
  const output = ts.transpileModule(runtimeSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} }
  const localRequire = (id) => {
    if (id === '../../libraryNormalize') {
      return {
        normalizeFolderPathForCompare(value) {
          return String(value || '').replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
        }
      }
    }
    return require(id)
  }
  new Function('exports', 'require', 'module', output)(module.exports, localRequire, module)
  return module.exports
}

async function runBehaviorChecks() {
  const runtime = loadRuntime()
  const roots = runtime.affectedWatchedRootsForPaths(
    ['D:/Fonts/Clients/A.ttf', 'Z:/Shared/B.otf'],
    ['D:/Fonts', 'D:/Fonts/Clients', 'Z:/Shared', 'X:/Other']
  )
  assert(roots.length === 3, 'behavior: every containing watched root must be reconciled, including overlapping roots')
  assert(roots.includes('D:/Fonts') && roots.includes('D:/Fonts/Clients') && roots.includes('Z:/Shared'), 'behavior: affected root set is incomplete')

  const calls = []
  const report = await runtime.refreshIndexesAfterPhysicalMutation({
    hfm: {
      async refreshWatchedFolder(folder, root) {
        calls.push([folder, root])
        if (root === 'Z:/Shared') throw new Error('NAS offline')
        return { mode: 'background' }
      }
    },
    watchedFolders: ['D:/Fonts', 'D:/Fonts/Clients', 'Z:/Shared'],
    affectedPaths: ['D:/Fonts/Clients/A.ttf', 'Z:/Shared/B.otf']
  })
  assert(calls.length === 3, 'behavior: each affected root must receive one refresh request')
  assert(report.scheduled === 2 && report.failed.length === 1, 'behavior: partial refresh scheduling failures must be reported precisely')
}

runBehaviorChecks()
  .then(() => console.log('[diagnostics:physical-mutation-index] ok'))
  .catch((error) => {
    console.error(`[diagnostics:physical-mutation-index] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
