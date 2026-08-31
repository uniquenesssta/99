#!/usr/bin/env node
/*
 * Regression checks for explicit Node state fallback compatibility mode.
 * This is dependency-free: it validates the TypeScript wiring and the IPC fixture
 * without starting Electron or requiring native SQLite.
 */
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertIncludes(relativePath, needle) {
  const content = read(relativePath)
  assert(content.includes(needle), `${relativePath} missing ${needle}`)
}

function policyMode({ rustFullMigration = true, nodeStateFallback = false }) {
  return !rustFullMigration ? 'legacy-node' : nodeStateFallback ? 'explicit-compatibility' : 'disabled'
}

function fallbackAllowed(state) {
  return policyMode(state) !== 'disabled'
}

function fixtureChannels() {
  const fixture = readJson('build/diagnostics/fixtures/ipc-font-tag-state-fallback.fixture.json')
  assert(fixture.name === 'font-tag-ipc-state-fallback-fixture', 'unexpected fixture name')
  assert(Array.isArray(fixture.channels) && fixture.channels.length === 6, 'fixture should cover six tag IPC channels')
  return fixture.channels
}

function testPolicyModes() {
  assert(policyMode({ rustFullMigration: true, nodeStateFallback: false }) === 'disabled', 'default Rust full migration should disable Node state fallback')
  assert(policyMode({ rustFullMigration: true, nodeStateFallback: true }) === 'explicit-compatibility', 'explicit env should enable compatibility mode')
  assert(policyMode({ rustFullMigration: false, nodeStateFallback: false }) === 'legacy-node', 'legacy mode should allow Node state fallback')
  assert(!fallbackAllowed({ rustFullMigration: true, nodeStateFallback: false }), 'default policy unexpectedly allowed fallback')
  assert(fallbackAllowed({ rustFullMigration: true, nodeStateFallback: true }), 'explicit compatibility unexpectedly denied fallback')
}

function testPolicyModuleWiring() {
  assertIncludes('src/main/rust-core/nodeStateFallbackCompatibilityRuntime.ts', 'nodeStateFallbackPolicySnapshot')
  assertIncludes('src/main/rust-core/nodeStateFallbackCompatibilityRuntime.ts', 'HFM_NODE_STATE_FALLBACK=1')
  assertIncludes('src/main/rust-core/nodeStateFallbackCompatibilityRuntime.ts', 'nodeStateFallbackDeniedMessage')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'nodeStateFallbackPolicySnapshot')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'nodeStateFallbackPolicyLogLine')
}

function testLocalAndSharedStateFallbacksAreGated() {
  for (const relativePath of [
    'src/main/library/runtime/localFontTagsRuntime.ts',
    'src/main/library/sharedKnownTagsRuntime.ts',
    'src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts',
    'src/main/indexing/shared-metadata/sharedMetadataOverlayRuntime.ts',
  ]) {
    assertIncludes(relativePath, 'nodeStateFallbackCompatibilityAllowed')
    assertIncludes(relativePath, 'logNodeStateFallbackDisabled')
  }
  assertIncludes('src/main/library/runtime/localFontTagsRuntime.ts', "source: 'local-tags-write'")
  assertIncludes('src/main/library/runtime/localFontTagsRuntime.ts', "source: 'local-tags-read'")
  assertIncludes('src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts', "source: 'shared-metadata-apply'")
  assertIncludes('src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts', "source: 'shared-metadata-remove-tag'")
  assertIncludes('src/main/indexing/shared-metadata/sharedMetadataOverlayRuntime.ts', "source: 'shared-metadata-overlay-read'")
}

function testIndexAndInstallFallbacksAreGated() {
  for (const relativePath of [
    'src/main/indexing/rootIndexRuntime.ts',
    'src/main/install/status/installStatusReadRuntime.ts',
    'src/main/install/status/installStatusWriteRuntime.ts',
  ]) {
    assertIncludes(relativePath, 'nodeStateFallbackCompatibilityAllowed')
    assertIncludes(relativePath, 'logNodeStateFallbackDisabled')
  }
  assertIncludes('src/main/indexing/rootIndexRuntime.ts', "source: 'root-index-write'")
  assertIncludes('src/main/install/status/installStatusReadRuntime.ts', "source: 'install-status-read'")
  assertIncludes('src/main/install/status/installStatusWriteRuntime.ts', "source: 'install-status-write'")
}

function testRealFontTagIpcFixture() {
  const handlerSource = read('src/main/ipc/handlers/fontTagIpcHandlers.ts')
  const fontSystemSource = read('src/main/ipc/handlers/fontSystemIpcHandlers.ts')
  const channels = fixtureChannels()
  const seen = new Set()
  for (const entry of channels) {
    assert(entry.channel && entry.runtimeMethod, 'fixture entry missing channel/runtimeMethod')
    assert(!seen.has(entry.channel), `duplicate fixture channel ${entry.channel}`)
    seen.add(entry.channel)
    assert(handlerSource.includes(`"${entry.channel}"`), `fontTagIpcHandlers missing ${entry.channel}`)
    assert(handlerSource.includes(`runtime.${entry.runtimeMethod}`), `fontTagIpcHandlers missing runtime.${entry.runtimeMethod}`)
    assert(!fontSystemSource.includes(entry.channel), `${entry.channel} leaked back into fontSystemIpcHandlers`)
  }
}

const tests = [
  testPolicyModes,
  testPolicyModuleWiring,
  testLocalAndSharedStateFallbacksAreGated,
  testIndexAndInstallFallbacksAreGated,
  testRealFontTagIpcFixture,
]

for (const test of tests) {
  test()
  console.log(`ok ${test.name}`)
}
console.log(`state fallback policy checks passed (${tests.length})`)
