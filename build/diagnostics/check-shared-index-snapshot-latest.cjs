#!/usr/bin/env node
/**
 * Regression checks for shared root index snapshot/latest pointer atomic switching.
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

function testLatestRuntimeExists() {
  const text = readText('src/main/indexing/root-index/rootIndexLatestRuntime.ts')
  for (const needle of [
    'rootIndexLatestPointerPath',
    'readRootIndexLatestPointer',
    'resolveLatestRootIndexDbPath',
    'writeRootIndexLatestPointer',
    'validateRootIndexLatestPointer',
    'ROOT_INDEX_LATEST_FILE_NAME',
    'atomic-latest-pointer',
    'safeManifestDatabasePath',
    'recoverRootIndexSnapshotPath',
    'root index latest pointer recovered from immutable snapshot',
    "!/^index\\..+\\.sqlite$/i.test(name)",
  ]) {
    assert(text.includes(needle), `root index latest runtime missing ${needle}`)
  }
}

function testManifestPrefersLatestPointer() {
  const text = readText('src/main/indexing/root-index/rootIndexManifestRuntime.ts')
  for (const needle of [
    'createRootIndexLatestRuntime',
    'resolveLatestRootIndexDbPath',
    'writeRootIndexLatestPointer',
    'latestPointer',
    'validateRootIndexLatestPointer',
  ]) {
    assert(text.includes(needle), `root index manifest runtime missing ${needle}`)
  }
  assert(text.indexOf('resolveLatestRootIndexDbPath') < text.indexOf('readRootCacheManifest'), 'active DB resolver should try latest pointer before manifest fallback')
}

function testIncrementalWritesUseSnapshotSwitch() {
  const text = readText('src/main/indexing/rootIndexRuntime.ts')
  for (const needle of [
    'saveRootIndexSqliteChangesAtomicSnapshot',
    'HFM_ROOT_INDEX_INCREMENTAL_SNAPSHOT',
    'incremental_snapshot_switch',
    'root index incremental snapshot switched',
    'resolveActiveRootIndexDbPath(cacheDir, filePath)',
    'saveRootIndexSqliteFileAtomicSnapshot',
  ]) {
    assert(text.includes(needle), `root index runtime missing ${needle}`)
  }
}

function testConstantsAndIgnorePolicy() {
  const constants = readText('src/main/cache/constants.ts')
  assert(constants.includes("ROOT_INDEX_LATEST_FILE_NAME = 'index.latest.json'"), 'missing root index latest file constant')
  const cachePaths = readText('src/main/cache/cachePaths.ts')
  assert(cachePaths.includes("leaf.endsWith('.sqlite')"), 'sqlite snapshot files must remain ignored by watcher')
}


function testRootIdentityRecoversFromManifest() {
  const text = readText('src/main/indexing/root-index/sharedRootIdentityRuntime.ts')
  for (const needle of [
    'readManifestIdentity',
    'rootCacheManifestPath(cacheDir)',
    'manifestIdentity?.rootId',
    "manifestIdentity?.rootId ? 'recovered' : 'created'",
  ]) {
    assert(text.includes(needle), `shared root identity recovery missing ${needle}`)
  }
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:shared-index-snapshot'] === 'node build/diagnostics/check-shared-index-snapshot-latest.cjs', 'missing diagnostics:shared-index-snapshot script')
}

const tests = [
  testLatestRuntimeExists,
  testManifestPrefersLatestPointer,
  testIncrementalWritesUseSnapshotSwitch,
  testConstantsAndIgnorePolicy,
  testRootIdentityRecoversFromManifest,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`shared index snapshot/latest checks passed (${tests.length})`)
