#!/usr/bin/env node
/**
 * Regression checks for shared metadata migration diagnostics.
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

function testMigrationDiagnosticsRuntimeExists() {
  const text = readText('src/main/indexing/shared-metadata/sharedMetadataMigrationDiagnosticsRuntime.ts')
  for (const needle of [
    'createSharedMetadataMigrationDiagnosticsRuntime',
    'readSharedMetadataMigrationDiagnosticsInOpenDb',
    'requiredTablesMissing',
    'requiredColumnsMissing',
    'invalidTagJsonRows',
    'missingTagOps',
    'legacyRootIndexMetadataImportedAt',
    'sharedTagOpsBackfillAt',
    'suggestedActions',
  ]) {
    assert(text.includes(needle), `shared metadata migration diagnostics runtime missing ${needle}`)
  }
}

function testRuntimeExportsMigrationDiagnostics() {
  const text = readText('src/main/indexing/shared-metadata/sharedFontMetadataRuntime.ts')
  for (const needle of [
    'createSharedMetadataMigrationDiagnosticsRuntime',
    'readSharedMetadataMigrationDiagnosticsInOpenDb',
  ]) {
    assert(text.includes(needle), `shared font metadata runtime missing migration diagnostics ${needle}`)
  }
}

function testMigrationDiagnosticsProtectsSchemaVersion() {
  const schema = readText('src/main/indexing/shared-metadata/sharedMetadataDbRuntime.ts')
  const diagnostics = readText('src/main/indexing/shared-metadata/sharedMetadataMigrationDiagnosticsRuntime.ts')
  assert(schema.includes("schemaVersion', '3"), 'shared metadata schema version should remain 3')
  for (const needle of ['font_metadata', 'tag_names_json', 'shared_tag_ops', 'next_revision', 'tombstone']) {
    assert(diagnostics.includes(needle), `migration diagnostics missing required schema token ${needle}`)
  }
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:shared-metadata-migration'] === 'node build/diagnostics/check-shared-metadata-migration.cjs', 'missing diagnostics:shared-metadata-migration script')
}

const tests = [
  testMigrationDiagnosticsRuntimeExists,
  testRuntimeExportsMigrationDiagnostics,
  testMigrationDiagnosticsProtectsSchemaVersion,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`shared metadata migration checks passed (${tests.length})`)
