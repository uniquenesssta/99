#!/usr/bin/env node
/**
 * Regression checks for startup NAS deadline policy.
 * Unavailable UNC/NAS roots must not block window creation through startup
 * schema audit, shared known tags refresh, or folder watcher stat probes.
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

function assertIncludes(relativePath, needle) {
  const text = readText(relativePath)
  assert(text.includes(needle), `${relativePath} missing ${needle}`)
}

function testFixtureDescribesStartupRegression() {
  const data = readJson('build/diagnostics/fixtures/startup-nas-deadline-policy.fixture.json')
  assert(data.name === 'startup-nas-deadline-policy-fixture', 'unexpected fixture name')
  assert(data.symptoms.startupAuditElapsedMs >= 39000, 'fixture no longer captures 39s startup audit stall')
  assert(data.symptoms.sharedKnownTagsElapsedMs >= 39000, 'fixture no longer captures 39s shared known tags stall')
  assert(data.expectedPolicy.schemaAuditBlocksWindow === false, 'startup audit must remain non-blocking')
}

function testGenericStartupRootAvailabilityRuntimeExists() {
  assertIncludes('src/main/path/startupPathAvailabilityRuntime.ts', 'ensureStartupPathRootAvailable')
  assertIncludes('src/main/path/startupPathAvailabilityRuntime.ts', 'filterStartupAvailableRoots')
  assertIncludes('src/main/path/startupPathAvailabilityRuntime.ts', 'isUncLikePath')
  assertIncludes('src/main/path/startupPathAvailabilityRuntime.ts', 'withIoDeadlineResult(`startup-root-probe:${rootPath}`')
  assertIncludes('src/main/path/startupPathAvailabilityRuntime.ts', 'startup path root unavailable')
}

function testIoDeadlineHasSharedMetadataBudget() {
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'DEFAULT_SHARED_METADATA_QUERY_TIMEOUT_MS = 500')
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'HFM_SHARED_METADATA_QUERY_TIMEOUT_MS')
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'sharedMetadataQueryTimeoutMs')
}

function testStartupAuditNoLongerBlocksWindowAndSkipsUnavailableRoots() {
  const lifecycle = readText('src/main/app/mainProcessLifecycleRuntime.ts')
  assert(lifecycle.includes('startup critical schema audit scheduled: non-blocking delayMs=1000'), 'startup schema audit is not scheduled as non-blocking')
  assert(!lifecycle.includes('await runStartupCriticalSchemaAudit().catch'), 'startup schema audit still blocks app-ready flow')
  assertIncludes('src/main/diagnostics/startupSchemaAudit.ts', 'filterStartupAvailableRoots')
  assertIncludes('src/main/diagnostics/startupSchemaAudit.ts', "'startup-schema-audit'")
  assertIncludes('src/main/diagnostics/startupSchemaAudit.ts', 'skippedUnavailable')
}

function testSharedKnownTagsRefreshIsDelayedAndDeadlineBound() {
  assertIncludes('src/main/index.ts', 'shared known tags startup refresh scheduled: non-blocking delayMs=1500')
  assertIncludes('src/main/library/sharedKnownTagsRuntime.ts', 'filterStartupAvailableRoots')
  assertIncludes('src/main/library/sharedKnownTagsRuntime.ts', "'shared-metadata-known-tags'")
  assertIncludes('src/main/library/sharedKnownTagsRuntime.ts', 'sharedMetadataQueryTimeoutMs()')
  assertIncludes('src/main/library/sharedKnownTagsRuntime.ts', 'shared known tags unavailable roots skipped')
  assertIncludes('src/main/library/sharedKnownTagsRuntime.ts', 'readPersistedSharedTags()')
}

function testFolderWatcherSkipsUnavailableUncBeforeStat() {
  const text = readText('src/main/watcher/folderWatcherRuntime.ts')
  const availabilityIndex = text.indexOf('ensureStartupPathRootAvailable(')
  const statIndex = text.indexOf('fsp.stat(folder)')
  assert(availabilityIndex >= 0, 'folder watcher missing startup path availability probe')
  assert(statIndex >= 0, 'folder watcher missing stat call')
  assert(availabilityIndex < statIndex, 'folder watcher still stats before availability deadline')
  assert(text.includes('folder watcher skipped unavailable root'), 'folder watcher missing unavailable root short-circuit log')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:startup-nas-deadline'] === 'node build/diagnostics/check-startup-nas-deadline-policy.cjs', 'missing diagnostics:startup-nas-deadline script')
}

const tests = [
  testFixtureDescribesStartupRegression,
  testGenericStartupRootAvailabilityRuntimeExists,
  testIoDeadlineHasSharedMetadataBudget,
  testStartupAuditNoLongerBlocksWindowAndSkipsUnavailableRoots,
  testSharedKnownTagsRefreshIsDelayedAndDeadlineBound,
  testFolderWatcherSkipsUnavailableUncBeforeStat,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`startup NAS deadline policy checks passed (${tests.length})`)
