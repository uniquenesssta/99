#!/usr/bin/env node
/** Regression checks for shared root index snapshot auto maintenance. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..')
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }
function json(relativePath) { return JSON.parse(read(relativePath)) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function testAutoMaintenanceRuntime() {
  const text = read('src/main/maintenance/sharedIndexSnapshotAutoMaintenanceRuntime.ts')
  for (const needle of [
    'createSharedIndexSnapshotAutoMaintenanceRuntime',
    'runSharedIndexSnapshotAutoMaintenance',
    'HFM_SHARED_INDEX_AUTO_MAINTENANCE',
    'cleanupRootIndexSnapshotMaintenance',
    'inspectRootIndexSnapshotMaintenance',
    'staleSnapshotCount',
    'orphanSidecarCount',
    'tmpFileCount',
    'deletedFiles',
  ]) assert(text.includes(needle), `auto maintenance runtime missing ${needle}`)
}
function testDatabaseMaintenanceWiring() {
  const appText = read('src/main/maintenance/applicationDatabaseMaintenanceRuntime.ts')
  for (const needle of [
    'createSharedIndexSnapshotAutoMaintenanceRuntime',
    'rootCacheDir: (rootPath: string) => string',
    'rootIndexDbPath: (rootPath: string) => string',
    'runSharedIndexSnapshotAutoMaintenance',
  ]) assert(appText.includes(needle), `application maintenance wiring missing ${needle}`)
  const dbText = read('src/main/maintenance/databaseMaintenance.ts')
  for (const needle of [
    'runSharedIndexSnapshotAutoMaintenance',
    'sharedIndexSnapshots',
    'sharedIndexChecked',
    'sharedIndexDeleted',
  ]) assert(dbText.includes(needle), `database maintenance wiring missing ${needle}`)
}
function testSnapshotCleanupKeepsActiveAndHandlesResidue() {
  const text = read('src/main/indexing/root-index/rootIndexSnapshotRuntime.ts')
  for (const needle of [
    'rootIndexTmpRetentionMs',
    'HFM_ROOT_INDEX_TMP_RETENTION_MS',
    'removeIfOlderThan',
    'activeNormalized',
    'sqliteSidecarPaths(snapshot.path)',
    "lower.endsWith('.tmp')",
    "lower.endsWith('-wal')",
  ]) assert(text.includes(needle), `snapshot cleanup missing ${needle}`)
}
function testIndexWiringAndPackageScript() {
  const indexText = read('src/main/index.ts')
  for (const needle of [
    'inspectRootIndexSnapshotMaintenance',
    'cleanupRootIndexSnapshotMaintenance',
    'rootCacheDir,',
    'rootIndexDbPath,',
  ]) assert(indexText.includes(needle), `index wiring missing ${needle}`)
  const pkg = json('package.json')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts['diagnostics:shared-index-auto-maintenance'] === 'node build/diagnostics/check-shared-index-auto-maintenance.cjs', 'missing diagnostics:shared-index-auto-maintenance')
}
const tests = [testAutoMaintenanceRuntime, testDatabaseMaintenanceWiring, testSnapshotCleanupKeepsActiveAndHandlesResidue, testIndexWiringAndPackageScript]
for (const test of tests) test()
console.log(`shared index auto maintenance checks passed (${tests.length})`)
