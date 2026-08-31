#!/usr/bin/env node
/** Regression checks for shared metadata repair command/runtime. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..')
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }
function json(relativePath) { return JSON.parse(read(relativePath)) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function testRepairRuntime() {
  const text = read('src/main/indexing/shared-metadata/sharedMetadataRepairRuntime.ts')
  for (const needle of [
    'SharedMetadataRepairReport',
    'repairSharedMetadataInOpenDb',
    'invalidTagJsonRows',
    'repairedInvalidTagJsonRows',
    'invalidTagOps',
    'purgedInvalidTagOps',
    'orphanTagOps',
    'archivedOrphanTagOps',
    'purgedOrphanTagOps',
    'archiveOrphanTagOps',
    'sharedMetadataRepairAt',
    'repair_invalid_tag_json',
  ]) assert(text.includes(needle), `shared metadata repair runtime missing ${needle}`)
}
function testSharedRuntimeExportsRepair() {
  const text = read('src/main/indexing/shared-metadata/sharedFontMetadataRuntime.ts')
  for (const needle of [
    'createSharedMetadataRepairRuntime',
    'repairSharedMetadataInOpenDb',
  ]) assert(text.includes(needle), `shared font metadata runtime missing ${needle}`)
}
function testMaintenanceCommand() {
  const text = read('build/maintenance/repair-shared-metadata.cjs')
  for (const needle of [
    '--root',
    '--db',
    '--apply',
    'dry-run',
    'invalidTagJsonRows',
    'invalidTagOps',
    '--archive-orphans',
    '--purge-archived-orphans',
    'orphanTagOps',
    'better-sqlite3',
  ]) assert(text.includes(needle), `repair command missing ${needle}`)
}
function testPackageScripts() {
  const pkg = json('package.json')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts['diagnostics:shared-metadata-repair'] === 'node build/diagnostics/check-shared-metadata-repair.cjs', 'missing diagnostics:shared-metadata-repair')
  assert(pkg.scripts['maintenance:repair-shared-metadata'] === 'node build/maintenance/repair-shared-metadata.cjs', 'missing maintenance:repair-shared-metadata')
}
const tests = [testRepairRuntime, testSharedRuntimeExportsRepair, testMaintenanceCommand, testPackageScripts]
for (const test of tests) test()
console.log(`shared metadata repair checks passed (${tests.length})`)
