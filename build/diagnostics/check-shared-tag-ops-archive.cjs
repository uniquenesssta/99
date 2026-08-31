#!/usr/bin/env node
/** Regression checks for orphan shared_tag_ops archive / cleanup policy. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..')
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }
function json(relativePath) { return JSON.parse(read(relativePath)) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function testArchiveSchema() {
  const text = read('src/main/indexing/shared-metadata/sharedMetadataDbRuntime.ts')
  for (const needle of [
    'shared_tag_ops_archive',
    'archive_reason',
    'payload_json',
    'idx_shared_tag_ops_archive_op',
  ]) assert(text.includes(needle), `shared metadata db schema missing ${needle}`)
}
function testRepairRuntimeArchivePolicy() {
  const text = read('src/main/indexing/shared-metadata/sharedMetadataRepairRuntime.ts')
  for (const needle of [
    'archiveOrphanTagOps',
    'purgeArchivedOrphanTagOps',
    'ensureSharedTagOpsArchiveTable',
    'INSERT OR IGNORE INTO shared_tag_ops_archive',
    'archivedOrphanTagOps',
    'purgedOrphanTagOps',
    'sharedTagOpsOrphanArchiveAt',
  ]) assert(text.includes(needle), `repair runtime missing ${needle}`)
  assert(text.includes('LEFT JOIN font_metadata meta ON meta.font_id = ops.font_id'), 'orphan detection must be based on missing font_metadata rows')
}
function testFrontendOptions() {
  for (const file of [
    'src/main/ipc/ipcHandlerTypes.ts',
    'src/main/ipc/handlers/maintenanceIpcHandlers.ts',
    'src/preload/index.ts',
  ]) {
    const text = read(file)
    assert(text.includes('archiveOrphanTagOps'), `${file} missing archiveOrphanTagOps option`)
    assert(text.includes('purgeArchivedOrphanTagOps'), `${file} missing purgeArchivedOrphanTagOps option`)
  }
}
function testMaintenanceCommand() {
  const text = read('build/maintenance/repair-shared-metadata.cjs')
  for (const needle of [
    '--archive-orphans',
    '--purge-archived-orphans',
    '--orphan-archive-reason',
    'archiveOrphans',
    'shared_tag_ops_archive',
    'archivedOrphanTagOps',
  ]) assert(text.includes(needle), `repair command missing ${needle}`)
}
function testPackageScriptAndVersion() {
  const pkg = json('package.json')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts['diagnostics:shared-tag-ops-archive'] === 'node build/diagnostics/check-shared-tag-ops-archive.cjs', 'missing diagnostics:shared-tag-ops-archive')
}
const tests = [testArchiveSchema, testRepairRuntimeArchivePolicy, testFrontendOptions, testMaintenanceCommand, testPackageScriptAndVersion]
for (const test of tests) test()
console.log(`shared tag ops archive checks passed (${tests.length})`)
