#!/usr/bin/env node
/**
 * Regression checks for shared tag conflict reports and legacy op-log backfill.
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

function testBackfillRuntimeExists() {
  const text = readText('src/main/indexing/shared-metadata/sharedTagOpsBackfillRuntime.ts')
  for (const needle of [
    'createSharedTagOpsBackfillRuntime',
    'ensureSharedTagOpsBackfilledInOpenDb',
    'readSharedTagOpsBackfillDiagnosticsInOpenDb',
    'legacy-bootstrap:',
    'sharedTagOpsBackfillAt',
    'INSERT OR IGNORE INTO shared_tag_ops',
    'missingBeforeBackfill',
  ]) {
    assert(text.includes(needle), `shared tag ops backfill runtime missing ${needle}`)
  }
}

function testReplayRuntimeReportsConflicts() {
  const text = readText('src/main/indexing/shared-metadata/sharedTagOpsReplayRuntime.ts')
  for (const needle of [
    'SharedTagOpsConflictReport',
    'readSharedTagOpsConflictReportInOpenDb',
    'latestRemovalConflicts',
    'multiMachineConflicts',
    'suggestedActions',
    'revisionTies',
  ]) {
    assert(text.includes(needle), `shared tag ops replay runtime missing conflict report ${needle}`)
  }
}

function testRuntimeWiresBackfillBeforeReplay() {
  const text = readText('src/main/indexing/shared-metadata/sharedFontMetadataRuntime.ts')
  for (const needle of [
    'createSharedTagOpsBackfillRuntime',
    'ensureSharedTagOpsBackfilledInOpenDb(db, rootPath, reason)',
    'tagOpsReplayRuntime.ensureSharedTagOpsReplayedInOpenDb',
    'readSharedTagOpsConflictReportInOpenDb',
    'readSharedTagOpsBackfillDiagnosticsInOpenDb',
  ]) {
    assert(text.includes(needle), `shared font metadata runtime missing ${needle}`)
  }
}


function testSharedTagNoopDeleteDoesNotDirtyFreshQueries() {
  const rustState = readText('native-src/hfm-core-worker/src/shared_metadata/state_machine.rs')
  assert(rustState.includes('let changed = !changed_ids.is_empty();'), 'rust removeTag no-op must not mark shared metadata dirty')

  const signalRuntime = readText('src/main/indexing/shared-metadata/sharedMetadataMutationSignalRuntime.ts')
  assert(!signalRuntime.includes("const forceDirty = kind === 'removeTag'"), 'shared metadata signal must not force dirty for removeTag no-op')
  assert(signalRuntime.includes('const sharedMetadataChanged = signal?.sharedMetadataChanged ?? hasChangedRows'), 'shared metadata signal must derive dirty state from changed rows')

  const stateSignalRuntime = readText('src/main/library/tagMutationStateSignalRuntime.ts')
  assert(stateSignalRuntime.includes('shared metadata mutation signal ignored'), 'shared metadata no-op signal should be ignored before barrier/cache invalidation')

  const writeProtocol = readText('src/main/library/tagMutationWriteProtocolRuntime.ts')
  assert(writeProtocol.includes('if (!ids.length) return'), 'tag mutation barrier should not start without affected font ids')

  const mutations = readText('src/main/library/sharedFontMetadataMutations.ts')
  assert(mutations.includes('if (updatedIds.length) {\n      await deps.syncSharedMetadataRootsToMergedIndex'), 'shared tag delete should not resync all roots when no rows changed')

  const mutationRuntime = readText('src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts')
  assert(mutationRuntime.includes('loadExistingFolderCache(root, { applySharedMetadataOverlay: false })'), 'shared tag delete should not apply overlay while only locating metadata roots')
  assert(mutationRuntime.includes('const baseState = stateFromFont(matched.font)'), 'shared metadata apply must compute the base state from indexed metadata, not the optimistic renderer item')
  assert(mutationRuntime.includes('sharedMetadataStateUnchanged(existingRow, mergeResult.state)'), 'shared metadata apply should skip no-op writes so stale queued shared-tag writes cannot create duplicate ops')
  assert(mutationRuntime.includes('rows=${rustResult.written}, requested=${preparedRows.length}'), 'shared metadata apply log should distinguish changed rows from requested rows')

  const knownTagsRuntime = readText('src/main/library/sharedKnownTagsRuntime.ts')
  assert(knownTagsRuntime.includes('allowEmptyOverwrite === false ? preserveTags : []'), 'shared known tags refresh must preserve newly added tags during set mutations')
  assert(knownTagsRuntime.includes('shared known tags empty refresh ignored after set'), 'shared known tags refresh must not wipe the visible tag list after a set mutation returns an empty read')

  const sharedMutations = readText('src/main/library/sharedFontMetadataMutations.ts')
  assert(sharedMutations.includes('preserveTags: tagNames'), 'single shared tag set must preserve requested tag names while refreshing known tags')
  assert(sharedMutations.includes('preserveTags: Array.from(new Set(items.flatMap'), 'batch shared tag set must preserve requested tag names while refreshing known tags')

  const localRustState = readText('native-src/hfm-core-worker/src/local_tags/state_machine.rs')
  assert(localRustState.includes('let changed = !changed_ids.is_empty() || catalog_changed;'), 'rust local tag signal must dirty only changed bindings or changed catalog state')

  const localRuntime = readText('src/main/library/runtime/localFontTagsRuntime.ts')
  assert(localRuntime.includes('const changed = normalizedChangedIds.length > 0 || catalogChanged'), 'local tag signal should derive dirty state from changed rows or catalog changes')

  assert(stateSignalRuntime.includes('local tags mutation signal ignored'), 'local tag no-op signal should be ignored before barrier/cache invalidation')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:shared-tag-conflicts'] === 'node build/diagnostics/check-shared-tag-conflicts.cjs', 'missing diagnostics:shared-tag-conflicts script')
}

const tests = [
  testBackfillRuntimeExists,
  testReplayRuntimeReportsConflicts,
  testRuntimeWiresBackfillBeforeReplay,
  testSharedTagNoopDeleteDoesNotDirtyFreshQueries,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`shared tag conflict checks passed (${tests.length})`)
