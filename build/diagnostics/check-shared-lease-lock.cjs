#!/usr/bin/env node
/**
 * Regression checks for NAS destructive operation shared lease locks.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertIncludes(relativePath, needle) {
  const text = readText(relativePath)
  assert(text.includes(needle), `${relativePath} missing ${needle}`)
}

function testLeaseLockRuntimeExists() {
  const text = readText('src/main/storage/runtime/sharedLeaseLockRuntime.ts')
  for (const needle of [
    'acquireSharedLeaseLock',
    'withSharedLeaseLock',
    'withSharedLeaseLocks',
    '.hfm-locks',
    'HFM_SHARED_LEASE_LOCK_TTL_MS',
    'HFM_SHARED_LEASE_LOCKS',
    "flag: 'wx'",
    'expiresAt',
    'removeExpiredLock',
    'SharedLeaseLockConflictError',
    'SharedLeaseLockConflictDetails',
    'createSharedLeaseLockConflictError',
    '锁定设备：',
    '剩余约',
    '到期：',
  ]) {
    assert(text.includes(needle), `shared lease lock runtime missing ${needle}`)
  }
}

function testDeleteUsesLeaseLock() {
  const text = readText('src/main/install/fontTrashDeleteRuntime.ts')
  for (const needle of [
    'withSharedLeaseLock',
    "operation: 'delete-font'",
    'roots: watchedFolders || []',
    'appendStartupLog: deps.appendStartupLog',
    'firstFailureMessage',
    '失败原因：${firstFailureMessage}',
  ]) {
    assert(text.includes(needle), `delete font runtime missing ${needle}`)
  }
}

function testMoveAndRenameUseLeaseLock() {
  const text = readText('src/main/folders/physicalFolders.ts')
  for (const needle of [
    'withSharedLeaseLock',
    'withSharedLeaseLocks',
    "operation: 'rename-folder'",
    "operation: 'move-font'",
    'resourcePaths: [prepared.sourcePath, target.targetFolder]',
    'destination = await uniqueDestinationPath',
    'batchFailureMessage',
    '失败原因：${batchFailureMessage}',
  ]) {
    assert(text.includes(needle), `physical folder runtime missing ${needle}`)
  }
}

function testWatcherIgnoresLocksAndDepsWired() {
  assertIncludes('src/main/cache/cachePaths.ts', "lowerName === '.hfm-locks'")
  assertIncludes('src/main/install/systemFontInstallRuntime.ts', 'appendStartupLog: (message: string) => void')
  assertIncludes('src/main/index.ts', 'appendStartupLog,')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:shared-lease-lock'] === 'node build/diagnostics/check-shared-lease-lock.cjs', 'missing diagnostics:shared-lease-lock script')
}

const tests = [
  testLeaseLockRuntimeExists,
  testDeleteUsesLeaseLock,
  testMoveAndRenameUseLeaseLock,
  testWatcherIgnoresLocksAndDepsWired,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`shared lease lock checks passed (${tests.length})`)
