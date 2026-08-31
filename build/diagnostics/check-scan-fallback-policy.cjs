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
  testPackageScriptRegistered,
]

for (const test of tests) {
  test()
  console.log(`ok ${test.name}`)
}
console.log(`scan fallback policy checks passed (${tests.length})`)
