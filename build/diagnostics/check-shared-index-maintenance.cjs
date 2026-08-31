#!/usr/bin/env node
/** Regression checks for shared root index snapshot maintenance diagnostics. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..')
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }
function json(relativePath) { return JSON.parse(read(relativePath)) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function testSnapshotRuntimeMaintenance() {
  const text = read('src/main/indexing/root-index/rootIndexSnapshotRuntime.ts')
  for (const needle of [
    'RootIndexSnapshotMaintenanceReport',
    'inspectRootIndexSnapshotMaintenance',
    'cleanupRootIndexSnapshotMaintenance',
    'staleSnapshotCount',
    'orphanSidecarCount',
    'tmpFileCount',
    'deletedFiles',
    'ROOT_INDEX_SNAPSHOT_KEEP_COUNT',
    'sqliteSidecarPaths(snapshot.path)',
  ]) assert(text.includes(needle), `root index snapshot maintenance missing ${needle}`)
}
function testRootIndexRuntimeExportsMaintenance() {
  const text = read('src/main/indexing/rootIndexRuntime.ts')
  for (const needle of [
    'inspectRootIndexSnapshotMaintenance',
    'cleanupRootIndexSnapshotMaintenance',
  ]) assert(text.includes(needle), `root index runtime should expose ${needle}`)
}
function testPackageScript() {
  const pkg = json('package.json')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts['diagnostics:shared-index-maintenance'] === 'node build/diagnostics/check-shared-index-maintenance.cjs', 'missing diagnostics:shared-index-maintenance')
}
const tests = [testSnapshotRuntimeMaintenance, testRootIndexRuntimeExportsMaintenance, testPackageScript]
for (const test of tests) test()
console.log(`shared index maintenance checks passed (${tests.length})`)
