#!/usr/bin/env node
/**
 * Regression checks for UNC/NAS I/O deadline policy.
 * Unreachable SMB paths must be treated as unavailable quickly instead of
 * allowing many preview-cache IPC calls to wait on Windows network I/O.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
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

function testFixtureStillDescribesRegression() {
  const data = readJson('build/diagnostics/fixtures/io-deadline-policy.fixture.json')
  assert(data.name === 'io-deadline-policy-fixture', 'unexpected fixture name')
  assert(data.symptoms.slowChannel === 'fonts:getCachedPreviewImages', 'fixture slow channel changed')
  assert(data.symptoms.slowCallCount >= 40, 'fixture no longer represents the concurrent slow-call regression')
}

function testDeadlineRuntimeExists() {
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'DEFAULT_UNC_ROOT_PROBE_TIMEOUT_MS = 500')
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'HFM_UNC_ROOT_PROBE_TIMEOUT_MS')
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'DEFAULT_ROOT_PROBE_QUEUE_TIMEOUT_MS = 3000')
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'HFM_ROOT_PROBE_QUEUE_TIMEOUT_MS')
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'HFM_PREVIEW_CACHE_QUERY_TIMEOUT_MS')
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'HFM_FILE_EXISTS_TIMEOUT_MS')
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'withIoDeadlineResult')
  assertIncludes('src/main/path/ioDeadlineRuntime.ts', 'fileExistsWithDeadline')
}

function testRootAvailabilityUsesDeadline() {
  assertIncludes('src/main/path/sharedPathProbeRuntime.ts', "lane: 'root-probe'")
  assertIncludes('src/main/path/sharedPathProbeRuntime.ts', 'rootProbeQueueTimeoutMs()')
  assertIncludes('src/main/path/startupPathAvailabilityRuntime.ts', 'lastProbeQueuedMs')
  assertIncludes('src/main/path/startupPathAvailabilityRuntime.ts', 'lastProbeExecutionMs')
  assertIncludes('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts', 'ensureStartupPathRootAvailable')
  assertIncludes('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts', 'getStartupPathRootState')
  assertIncludes('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts', 'unavailableRootTtlMs')
}

function testPreviewCacheQueriesUseDeadlineAndDropTimeouts() {
  const text = readText('src/main/preview/runtime/previewBatchReadRuntime.ts')
  assert(readText('src/main/preview/runtime/previewStorageIoRuntime.ts').includes('previewCacheQueryTimeoutMs'), 'preview cache storage missing query timeout import')
  assert(text.includes('runStoragePreviewCacheIo'), 'preview cache storage missing storage-level deadline wrapper')
  assert(text.includes('preview-cache-batch:'), 'preview cache batch is not deadline-labeled')
  assert(text.includes('preview-cache-query:'), 'preview cache query is not deadline-labeled')
  assert(text.includes('if (!batchResult.ok) {\n          for (const row of group.rows) result[row.id] = false'), 'status batch timeout does not return deterministic misses')
  assert(text.includes('preview cache image read deadline dropped'), 'preview image read timeout is not logged/dropped')
}

function testSyncUncCanonicalProbeSkipped() {
  assertIncludes('src/main/path/watchedFolderCanonicalRuntime.ts', 'shouldSkipSyncUncCanonicalProbe')
  let probes = 0
  const load = require('./check-operation-chain.cjs').loader({
    'node:path': path.win32,
    'node:fs': { statSync() { probes++; throw new Error('synchronous network stat'); }, realpathSync: { native() { probes++; throw new Error('synchronous realpath'); } } },
    [path.resolve(__dirname, '../../src/main/path/pathCanonicalizer.ts')]: { normalizePathCompareText: value => value.toLowerCase(), canonicalizeWatchedFolderPathText: value => value, normalizeNativePathText: value => value.replaceAll('/', '\\') },
  }, { process: { ...process, platform: 'win32', env: { ...process.env, HFM_CANONICAL_SYNC_UNC_PROBE: '1' } } })
  const canonical = load('src/main/path/watchedFolderCanonicalRuntime.ts')
  canonical.canonicalWatchedFolderPath('//nas/share')
  canonical.canonicalWatchedFolderPath('O:/fonts')
  assert(probes === 0, 'UNC/mapped path reached synchronous filesystem')
  assertIncludes('src/main/path/watchedFolderCanonicalRuntime.ts', 'sync UNC canonical probe skipped')
}

function testPreviewFileIoUsesDeadline() {
  assertIncludes('src/main/preview/previewRuntime.ts', 'preview-font-stat:')
  assertIncludes('src/main/preview/previewRuntime.ts', 'fileExistsWithDeadline(outputPath)')
  assertIncludes('src/main/preview/runtime/previewFontDataRuntime.ts', 'preview-font-data-stat:')
  assertIncludes('src/main/preview/runtime/previewFontDataRuntime.ts', 'preview-font-data-read:')
  assertIncludes('src/main/preview/runtime/previewCachedImageReadBatchRuntime.ts', 'preview-cache-image-read:')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:io-deadline'] === 'node build/diagnostics/check-io-deadline-policy.cjs', 'missing diagnostics:io-deadline script')
}

const tests = [
  testFixtureStillDescribesRegression,
  testDeadlineRuntimeExists,
  testRootAvailabilityUsesDeadline,
  testPreviewCacheQueriesUseDeadlineAndDropTimeouts,
  testSyncUncCanonicalProbeSkipped,
  testPreviewFileIoUsesDeadline,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`io deadline policy checks passed (${tests.length})`)
