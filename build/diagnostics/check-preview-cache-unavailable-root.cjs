#!/usr/bin/env node
/**
 * Regression checks for unavailable NAS/shared preview cache roots.
 * The log showed many concurrent fonts:getCachedPreviewImages calls waiting on
 * the same unreachable shared root; shared preview cache access must now be
 * short-circuited by a root availability circuit breaker.
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

function testFixtureDescribesLoggedRegression() {
  const data = readJson('build/diagnostics/fixtures/preview-cache-unavailable-root.fixture.json')
  assert(data.name === 'preview-cache-unavailable-root-fixture', 'unexpected fixture name')
  assert(data.symptoms.slowChannel === 'fonts:getCachedPreviewImages', 'fixture slow channel changed')
  assert(data.symptoms.slowCallCount >= 40, 'fixture no longer represents the concurrent slow-call regression')
}

function testRootAvailabilityRuntimeExists() {
  assertIncludes('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts', 'createPreviewCacheRootAvailabilityRuntime')
  assertIncludes('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts', 'ensureRootPreviewCacheAvailable')
  assertIncludes('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts', 'markRootPreviewCacheUnavailable')
  assertIncludes('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts', 'promise?: Promise<boolean>')
  assertIncludes('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts', 'shared preview cache access is short-circuited')
}

function testPreviewCacheStorageShortCircuitsUnavailableRoot() {
  const text = readText('src/main/preview/runtime/previewCacheStorageRuntime.ts')
  assert(/import \{ createPreviewCacheRootAvailabilityRuntime \} from [\"']\.\/previewCacheRootAvailabilityRuntime[\"']/.test(text), 'storage runtime missing root availability import')
  assert(text.includes('const rootAvailability = createPreviewCacheRootAvailabilityRuntime'), 'storage runtime missing root availability instance')
  assert(text.includes('await rootAvailability.ensureRootPreviewCacheAvailable(root)'), 'root write path missing availability preflight')
  assert(text.includes('storage.storage === \"root\"') && text.includes('rootAvailability.ensureRootPreviewCacheAvailable(\n        storage.rootPath'), 'root read/write paths missing availability short-circuit')
  assert(text.includes('for (const row of group.rows) result[row.id] = false'), 'status batch does not return deterministic misses for unavailable root')
}

function testWatchedFolderCanonicalFailuresAreThrottled() {
  assertIncludes('src/main/path/watchedFolderCanonicalRuntime.ts', 'FAILED_CANONICAL_PATH_TTL_MS')
  assertIncludes('src/main/path/watchedFolderCanonicalRuntime.ts', 'failedCanonicalPathCache')
  assertIncludes('src/main/path/watchedFolderCanonicalRuntime.ts', 'cachedFailure && cachedFailure.expiresAt > Date.now()')
  assertIncludes('src/main/path/watchedFolderCanonicalRuntime.ts', 'suppressed for ${FAILED_CANONICAL_PATH_TTL_MS}ms')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-root'], 'package.json missing diagnostics:preview-cache-root')
  assert(pkg.scripts['diagnostics:preview-cache-root'] === 'node build/diagnostics/check-preview-cache-unavailable-root.cjs', 'unexpected diagnostics:preview-cache-root command')
}

const tests = [
  testFixtureDescribesLoggedRegression,
  testRootAvailabilityRuntimeExists,
  testPreviewCacheStorageShortCircuitsUnavailableRoot,
  testWatchedFolderCanonicalFailuresAreThrottled,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache unavailable root checks passed (${tests.length})`)
