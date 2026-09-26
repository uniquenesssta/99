#!/usr/bin/env node
/*
 * Regression checks for Node/fontkit scan fallback compatibility mode.
 * Rust full migration must not silently route unresolved parse jobs through
 * the old fontkit Worker unless HFM_NODE_FONTKIT_SCAN_FALLBACK=1 is explicit.
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

function fixture() {
  const data = readJson('build/diagnostics/fixtures/node-fontkit-scan-fallback-policy.fixture.json')
  assert(data.name === 'node-fontkit-scan-fallback-policy-fixture', 'unexpected fixture name')
  assert(data.policyGate === 'HFM_NODE_FONTKIT_SCAN_FALLBACK=1', 'policy gate changed')
  assert(Array.isArray(data.modes) && data.modes.length === 3, 'fixture should cover three policy modes')
  assert(Array.isArray(data.gatedSources) && data.gatedSources.length === 3, 'fixture should cover three gated source files')
  return data
}

function policyMode({ rustFullMigration = true, nodeFontkitScanFallback = false }) {
  return !rustFullMigration ? 'legacy-node' : nodeFontkitScanFallback ? 'explicit-compatibility' : 'disabled'
}

function fallbackAllowed(state) {
  return policyMode(state) !== 'disabled'
}

function testPolicyModes() {
  const data = fixture()
  for (const mode of data.modes) {
    assert(policyMode(mode) === mode.mode, `unexpected mode for ${JSON.stringify(mode)}`)
    assert(fallbackAllowed(mode) === mode.allowed, `unexpected allow/deny for ${JSON.stringify(mode)}`)
  }
}

function testPolicyModuleWiring() {
  assertIncludes('src/main/rust-core/nodeFontkitScanFallbackCompatibilityRuntime.ts', 'nodeFontkitScanFallbackPolicySnapshot')
  assertIncludes('src/main/rust-core/nodeFontkitScanFallbackCompatibilityRuntime.ts', 'HFM_NODE_FONTKIT_SCAN_FALLBACK=1')
  assertIncludes('src/main/rust-core/nodeFontkitScanFallbackCompatibilityRuntime.ts', 'nodeFontkitScanFallbackCompatibilityAllowed')
  assertIncludes('src/main/rust-core/nodeFontkitScanFallbackCompatibilityRuntime.ts', 'nodeFontkitScanFallbackFailureLogSuffix')
  assertIncludes('src/main/rust-core/nodeFontkitScanFallbackCompatibilityRuntime.ts', 'nodeFontkitScanFallbackDeniedMessage')
}

function testFallbackSourcesAreGated() {
  const data = fixture()
  for (const source of data.gatedSources) {
    const content = read(source.runtimeFile)
    for (const needle of source.requires || []) {
      assert(content.includes(needle), `${source.runtimeFile} missing ${needle} for ${source.name}`)
    }
  }
}

function testMigrationDiagnosticsExposePolicy() {
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'nodeFontkitScanFallbackPolicySnapshot')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'nodeFontkitScanFallbackPolicyLogLine')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'nodeFontkitScanFallbackPolicyLogLine()')
}

function testC08NetworkListingBatchRouting() {
  const listing = read('src/main/indexing/scan-orchestrator/scanListingRuntime.ts')
  assert(listing.includes("sharedIoResourceKeys([folder])"), 'C-08.1 must classify roots with the existing Shared I/O identity owner')
  assert(listing.includes('networkFolders') && listing.includes('fallbackFolders'), 'C-08.1 must partition network roots from local/fallback roots')
  assert(listing.includes('if (!network.has(folder))'), 'only local roots may use root-wide content-prefetch listing')
  assert(listing.includes('[...fallbackFolders, ...networkFolders]'), 'local results must become visible before network directory reads')
  assert(listing.includes('network.has(folder)) throw error'), 'network directory failures must not enter Node worker fallback')
  assert(listing.includes('published.has(key)'), 'fallback retries must not republish already listed files')
  assert(listing.includes('rethrowSharedIoProcessError(error)'), 'Shared I/O failures must remain fail-closed')
  assert(listing.includes('signal, undefined, publish'), 'directory batches must reach the existing early-visible consumer')
  assert(!listing.includes('snapshotSharedRootGenerations'), 'root generation ownership must remain in the Shared I/O transport')

  const indexingClient = read('src/main/rust-core/clients/rustIndexingClientRuntime.ts')
  assert(indexingClient.includes('HFM_RUST_SCAN_LISTING_TIMEOUT_MS || 10 * 60 * 1000'), 'C-08.1 must not widen the existing list-font-files timeout')
  assert(indexingClient.includes('sharedIo: { paths: [rootPath], write: false }'), 'list-font-files must enter Shared I/O as a read-only batch')

  const manualListing = read('src/main/watcher/manual-refresh/manualFolderRustListingRuntime.ts')
  assert(!manualListing.includes('profile?.isNetwork !== true'), 'manual network refresh must not skip the existing Rust list-font-files batch in auto mode')

  const watcher = read('src/main/watcher/watchedFolderIndexRuntime.ts')
  assert(watcher.includes('options.runRustWatcherPreflight({'), 'watcher batch must continue to use the existing Rust preflight command')
  assert(watcher.includes('if (rustResult) return rustResult.unchanged'), 'watcher preflight result must remain authoritative when available')

  const transport = read('src/main/rust-core/rustCoreWorkerTransportRuntime.ts')
  assert(transport.includes("if (!target!.write && !admit()) throw new SharedIoProcessError('共享根状态已变化，旧读取结果已丢弃。','unknown','stale-generation')"), 'read-only Shared I/O receipts must retain the root-generation gate')
  assert(transport.includes('timeoutMs: Math.min(30000, Math.max(100, execOptions.timeout || 30000))'), 'Shared I/O execution timeout cap changed')
  assert(transport.includes('queueTimeoutMs: 3000'), 'Shared I/O queue timeout changed')

  const sharedProcess = read('src/main/path/sharedIoProcessRuntime.ts')
  assert(sharedProcess.includes("filter(other => laneOf(other) === 'default').length >= 2"), 'Shared I/O default concurrency changed')
  assert(sharedProcess.includes("child.kill('SIGTERM')") && sharedProcess.includes("child.kill('SIGKILL')"), 'Shared I/O terminate/kill settlement changed')
  assert(sharedProcess.includes('return ![...active].some(other => rootsOverlap(job, other))'), 'Shared I/O root lock changed')
}

function testPackageScriptRegistered() {
  const pkg = JSON.parse(read('package.json'))
  assert(pkg.scripts && pkg.scripts['diagnostics:scan-fallback'], 'package.json missing diagnostics:scan-fallback')
  assert(pkg.scripts['diagnostics:scan-fallback'] === 'node build/diagnostics/check-scan-fallback-policy.cjs', 'unexpected diagnostics:scan-fallback command')
  assert(pkg.version === '3.0.0', 'package version changed')
}

const tests = [
  testPolicyModes,
  testPolicyModuleWiring,
  testFallbackSourcesAreGated,
  testMigrationDiagnosticsExposePolicy,
  testC08NetworkListingBatchRouting,
  testPackageScriptRegistered,
]

for (const test of tests) {
  test()
  console.log(`ok ${test.name}`)
}
console.log(`scan fallback policy checks passed (${tests.length})`)
