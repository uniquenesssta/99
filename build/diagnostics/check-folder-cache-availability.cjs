#!/usr/bin/env node
/**
 * Regression checks for folder-cache root availability gating.
 * library:loadShell and fonts:getMetrics must not bypass startupPathAvailabilityRuntime
 * and spend 20s+ opening cache/index data under an unavailable UNC/NAS root.
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

function testFixtureDescribesRemainingStartupStall() {
  const data = readJson('build/diagnostics/fixtures/folder-cache-availability.fixture.json')
  assert(data.name === 'folder-cache-availability-fixture', 'unexpected fixture name')
  assert(data.symptoms.startupSchemaAuditElapsedMs <= 2500, 'fixture should show startup audit deadline worked')
  assert(data.symptoms.libraryLoadShellDurationMs >= 20000, 'fixture no longer captures library:loadShell stall')
  assert(data.symptoms.fontMetricsDurationMs >= 20000, 'fixture no longer captures fonts:getMetrics stall')
  assert(data.expectedPolicy.libraryShellSkipsUnavailableRoots === true, 'library shell must skip unavailable roots')
}

function testFolderCacheAvailabilityRuntimeExists() {
  assertIncludes('src/main/folders/folderCacheRootAvailabilityRuntime.ts', 'filterFolderCacheAvailableRoots')
  assertIncludes('src/main/folders/folderCacheRootAvailabilityRuntime.ts', 'filterStartupAvailableRoots')
  assertIncludes('src/main/folders/folderCacheRootAvailabilityRuntime.ts', 'folder cache unavailable roots skipped')
}

function testLoadFolderCacheSkipsUnavailableRootsBeforeCacheOpen() {
  const text = readText('src/main/folders/folderCacheRuntime.ts')
  const availabilityIndex = text.indexOf('filterFolderCacheAvailableRoots(\n      normalizedFolders')
  const loopIndex = text.indexOf('for (const folder of availableFoldersResult.folders)')
  const loadIndex = text.indexOf('const cacheSource = await loadExistingFolderCache(folder)')
  assert(availabilityIndex >= 0, 'loadFolderCache missing availability filter')
  assert(loopIndex >= 0, 'loadFolderCache missing available folder loop')
  assert(loadIndex >= 0, 'loadFolderCache missing cache load')
  assert(availabilityIndex < loadIndex, 'loadFolderCache still opens cache before availability filter')
  assert(loopIndex < loadIndex, 'loadFolderCache cache open is not scoped to available folders')
}

function testSharedFontLoadAndCountSkipUnavailableRoots() {
  const text = readText('src/main/folders/folderCacheRuntime.ts')
  assert(text.includes('"shared-font-cache-load"'), 'shared font load missing availability reason')
  assert(text.includes('"shared-font-cache-count"'), 'shared font count missing availability reason')
  assert(text.includes('for (const folder of availableFoldersResult.folders)'), 'shared font paths are not restricted to available folders')
}

function testLibraryShellAndMetricsUseFolderCacheRuntime() {
  assertIncludes('src/main/library/runtime/libraryLoadRuntime.ts', 'countSharedFontsForFolders(shell.folders || [])')
  assertIncludes('src/main/library/fontMetricsRuntime.ts', 'options.loadSharedFontsForFolders(folders)')
  assertIncludes('src/main/index.ts', 'countSharedFontsForFolders')
  assertIncludes('src/main/index.ts', 'loadSharedFontsForFolders')
}

function testStartupMaintenanceDefaultIsTwoSeconds() {
  const text = readText('src/main/app/appRuntimeConfig.ts')
  assert(text.includes('HFM_STARTUP_MAINTENANCE_IDLE_DELAY_MS || 2000'), 'startup maintenance default is not 2000ms')
  assert(text.includes('Math.max(\n  1000,'), 'startup maintenance minimum should allow 2s default')
}


function testMissingSharedIndexHydratesPhysicalFolderTree() {
  const text = readText('src/renderer/src/runtime/library/actions/fontLibraryFolderCacheActionRuntime.ts')
  assert(text.includes('hydratePhysicalTree || (result.missingCacheFolders?.length || 0) > 0'), 'missing shared cache roots must hydrate the physical folder tree before metrics refresh')
  assert(text.includes('await sharedRuntime.readPhysicalFolderTree'), 'folder cache action must read the physical folder tree when hydrating a newly added root')
  assert(text.includes('loadSharedCacheForFolders(mergedFolders, false, true)'), 'newly added roots must request physical tree hydration immediately')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:folder-cache-availability'] === 'node build/diagnostics/check-folder-cache-availability.cjs', 'missing diagnostics:folder-cache-availability script')
}

const tests = [
  testFixtureDescribesRemainingStartupStall,
  testFolderCacheAvailabilityRuntimeExists,
  testLoadFolderCacheSkipsUnavailableRootsBeforeCacheOpen,
  testSharedFontLoadAndCountSkipUnavailableRoots,
  testLibraryShellAndMetricsUseFolderCacheRuntime,
  testStartupMaintenanceDefaultIsTwoSeconds,
  testMissingSharedIndexHydratesPhysicalFolderTree,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`folder cache availability checks passed (${tests.length})`)
