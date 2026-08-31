#!/usr/bin/env node
/**
 * Regression checks for batch destructive font operations guarded by shared lease locks.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }
function readJson(relativePath) { return JSON.parse(read(relativePath)) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function includes(relativePath, needle) { assert(read(relativePath).includes(needle), `${relativePath} missing ${needle}`) }

function testBatchMoveRuntime() {
  const text = read('src/main/folders/physicalFolders.ts')
  for (const needle of [
    'moveFontFilesToFolder',
    "operation: 'move-font-batch'",
    'resourcePaths: [target.targetFolder, ...prepared.map((row) => row.sourcePath)]',
    'moveFileWithCrossDeviceFallback',
    'uniqueDestinationPath(target.targetFolder',
    'withSharedLeaseLocks',
    'batchFailureMessage',
    '失败原因：${batchFailureMessage}',
  ]) includes('src/main/folders/physicalFolders.ts', needle)
}

function testBatchMoveIpcAndPreload() {
  includes('src/main/ipc/handlers/previewAndFolderIpcHandlers.ts', 'fonts:moveFilesToFolder')
  includes('src/main/ipc/ipcHandlerTypes.ts', 'moveFontFilesToFolder?:')
  includes('src/preload/index.ts', 'moveFontFilesToFolder')
  includes('src/main/preload/runtimePreloadSource.ts', 'moveFontFilesToFolder')
}

function testRendererUsesBatchApi() {
  const text = read('src/renderer/src/fontFolderTreeRuntime.ts')
  assert(text.includes('options.hfm.moveFontFilesToFolder'), 'renderer batch assign should use moveFontFilesToFolder')
  assert(!text.includes('for (const id of uniqueIds) {\n        const font = options.library.fonts[id]'), 'renderer should not batch move by looping single IPC calls')
}

function testSharedTypesAndVersion() {
  includes('src/shared/types/installTypes.ts', 'MoveFontFilesResult')
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts['diagnostics:destructive-batch-lease-lock'] === 'node build/diagnostics/check-destructive-batch-lease-lock.cjs', 'missing diagnostics:destructive-batch-lease-lock script')
}

const tests = [testBatchMoveRuntime, testBatchMoveIpcAndPreload, testRendererUsesBatchApi, testSharedTypesAndVersion]
for (const test of tests) test()
console.log(`destructive batch lease lock checks passed (${tests.length})`)
