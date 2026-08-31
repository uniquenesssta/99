#!/usr/bin/env node
/**
 * Regression checks for shared_tag_ops replay, diagnostics, and signature participation.
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

function testReplayRuntimeExists() {
  const text = readText('src/main/indexing/shared-metadata/sharedTagOpsReplayRuntime.ts')
  for (const needle of [
    'createSharedTagOpsReplayRuntime',
    'ensureSharedTagOpsReplayedInOpenDb',
    'readSharedTagOpsDiagnosticsInOpenDb',
    'sharedTagOpsReplayMaxRowId',
    'SharedTagOpsReplayConflict',
    'revisionTies',
    'latestRemovals',
  ]) {
    assert(text.includes(needle), `shared tag ops replay runtime missing ${needle}`)
  }
}

function testOverlayRunsReplayBeforeRead() {
  const text = readText('src/main/indexing/shared-metadata/sharedMetadataOverlayRuntime.ts')
  for (const needle of [
    'ensureSharedTagOpsReplayedInOpenDb?.(legacyDb, rootPath, \'overlay-rust-preflight\')',
    'ensureSharedTagOpsReplayedInOpenDb?.(db, rootPath, \'overlay-read\')',
    'ensureSharedTagOpsReplayedInOpenDb?.(db, rootPath, \'merged-row-overlay\')',
  ]) {
    assert(text.includes(needle), `shared metadata overlay missing replay hook ${needle}`)
  }
}

function testRuntimeExportsReplay() {
  const text = readText('src/main/indexing/shared-metadata/sharedFontMetadataRuntime.ts')
  for (const needle of [
    'createSharedTagOpsReplayRuntime',
    'ensureSharedTagOpsReplayedInOpenDb',
    'readSharedTagOpsDiagnosticsInOpenDb',
  ]) {
    assert(text.includes(needle), `shared metadata runtime missing ${needle}`)
  }
}

function testSignatureIncludesOps() {
  const ts = readText('src/main/indexing/shared-metadata/sharedMetadataSignatureRuntime.ts')
  const rust = readText('native-src/hfm-core-worker/src/shared_metadata/signature.rs')
  for (const needle of ['metadata-v2', 'shared_tag_ops', 'max_op_rowid']) {
    assert(ts.includes(needle), `node shared metadata signature missing ${needle}`)
    assert(rust.includes(needle), `rust shared metadata signature missing ${needle}`)
  }
}

function testSchemaVersionAndPackageScript() {
  const nodeSchema = readText('src/main/indexing/shared-metadata/sharedMetadataDbRuntime.ts')
  const rustSchema = readText('native-src/hfm-core-worker/src/shared_metadata/schema.rs')
  const pkg = readJson('package.json')
  assert(nodeSchema.includes("schemaVersion', '3"), 'node shared metadata schema version not bumped to 3')
  assert(rustSchema.includes('schemaVersion", "3'), 'rust shared metadata schema version not bumped to 3')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:shared-tag-ops-replay'] === 'node build/diagnostics/check-shared-tag-ops-replay.cjs', 'missing diagnostics:shared-tag-ops-replay script')
}

const tests = [
  testReplayRuntimeExists,
  testOverlayRunsReplayBeforeRead,
  testRuntimeExportsReplay,
  testSignatureIncludesOps,
  testSchemaVersionAndPackageScript,
]

for (const test of tests) test()
console.log(`shared tag ops replay checks passed (${tests.length})`)
