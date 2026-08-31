#!/usr/bin/env node
/**
 * Regression checks for shared metadata field-level merge and tag operation log.
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

function testNodeMergeRuntimeExists() {
  const text = readText('src/main/indexing/shared-metadata/sharedMetadataFieldMergeRuntime.ts')
  for (const needle of [
    'SharedMetadataMergePolicy',
    "'tags'",
    "'favorite'",
    "'deleteProtected'",
    'mergeSharedMetadataState',
    'insertSharedTagOps',
    'shared_tag_ops',
  ]) {
    assert(text.includes(needle), `shared metadata field merge runtime missing ${needle}`)
  }
}

function testNodeMutationUsesFieldMerge() {
  const text = readText('src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts')
  for (const needle of [
    'mergeSharedMetadataState',
    'insertSharedTagOps',
    'baseTagNamesJson',
    'mergePolicy: options.mergePolicy',
    'SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision',
  ]) {
    assert(text.includes(needle), `shared metadata mutation runtime missing ${needle}`)
  }
}

function testHighLevelMutationsDeclarePolicies() {
  const text = readText('src/main/library/sharedFontMetadataMutations.ts')
  for (const needle of [
    "mergePolicy: 'tags'",
    "mergePolicy: 'favorite'",
    "mergePolicy: 'deleteProtected'",
  ]) {
    assert(text.includes(needle), `shared metadata high-level mutations missing ${needle}`)
  }
}

function testRustWorkerCarriesMergePolicy() {
  const ts = readText('src/main/rust-core/rustCoreWorkerRuntime.ts')
  const types = readText('native-src/hfm-core-worker/src/shared_metadata/types.rs')
  const stateMachine = readText('native-src/hfm-core-worker/src/shared_metadata/state_machine.rs')
  const schema = readText('native-src/hfm-core-worker/src/shared_metadata/schema.rs')
  for (const needle of ['baseTagNamesJson', 'mergePolicy']) {
    assert(ts.includes(needle), `rust worker TS type missing ${needle}`)
  }
  for (const needle of ['base_tag_names_json', 'merge_policy', 'default_merge_policy']) {
    assert(types.includes(needle), `rust shared metadata payload missing ${needle}`)
  }
  for (const needle of ['merge_metadata_state', 'ExistingMetadataState', 'insert_tag_ops', 'shared_tag_ops']) {
    assert(stateMachine.includes(needle), `rust shared metadata state machine missing ${needle}`)
  }
  assert(schema.includes('CREATE TABLE IF NOT EXISTS shared_tag_ops'), 'rust shared metadata schema missing shared_tag_ops')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:shared-metadata-field-merge'] === 'node build/diagnostics/check-shared-metadata-field-merge.cjs', 'missing diagnostics:shared-metadata-field-merge script')
}

const tests = [
  testNodeMergeRuntimeExists,
  testNodeMutationUsesFieldMerge,
  testHighLevelMutationsDeclarePolicies,
  testRustWorkerCarriesMergePolicy,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`shared metadata field merge checks passed (${tests.length})`)
