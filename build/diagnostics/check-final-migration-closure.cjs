#!/usr/bin/env node
/**
 * Final migration closure checks for the remaining Node bridge fallback paths.
 * These paths must be blocked by default in Rust full migration mode and only
 * run when HFM_NODE_BRIDGE_FALLBACK=1 is explicitly set.
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

function policyMode({ rustFullMigration = true, nodeBridgeFallback = false }) {
  return !rustFullMigration ? 'legacy-node' : nodeBridgeFallback ? 'explicit-compatibility' : 'disabled'
}

function fallbackAllowed(state) {
  return policyMode(state) !== 'disabled'
}

function testFixtureModes() {
  const data = readJson('build/diagnostics/fixtures/node-bridge-fallback-final-closure.fixture.json')
  assert(data.name === 'node-bridge-fallback-final-closure-fixture', 'unexpected fixture name')
  assert(data.policyGate === 'HFM_NODE_BRIDGE_FALLBACK=1', 'policy gate changed')
  for (const mode of data.modes) {
    assert(policyMode(mode) === mode.mode, `unexpected mode for ${JSON.stringify(mode)}`)
    assert(fallbackAllowed(mode) === mode.allowed, `unexpected allow/deny for ${JSON.stringify(mode)}`)
  }
}

function testPolicyRuntimeExists() {
  assertIncludes('src/main/rust-core/nodeBridgeFallbackCompatibilityRuntime.ts', 'nodeBridgeFallbackPolicySnapshot')
  assertIncludes('src/main/rust-core/nodeBridgeFallbackCompatibilityRuntime.ts', 'HFM_NODE_BRIDGE_FALLBACK=1')
  assertIncludes('src/main/rust-core/nodeBridgeFallbackCompatibilityRuntime.ts', 'nodeBridgeFallbackCompatibilityAllowed')
  assertIncludes('src/main/rust-core/nodeBridgeFallbackCompatibilityRuntime.ts', 'nodeBridgeFallbackDeniedMessage')
  assertIncludes('src/main/rust-core/nodeBridgeFallbackCompatibilityRuntime.ts', 'previewRenderFallbackRequiresExplicitCompatibility')
  assertIncludes('src/main/rust-core/nodeBridgeFallbackCompatibilityRuntime.ts', 'activationFileFallbackRequiresExplicitCompatibility')
}

function testGatedSources() {
  const data = readJson('build/diagnostics/fixtures/node-bridge-fallback-final-closure.fixture.json')
  for (const source of data.gatedSources) {
    assertIncludes(source.file, source.source)
    for (const required of source.requires) assertIncludes(source.file, required)
  }
}

function testMigrationDiagnosticsExposeFinalPolicy() {
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'nodeBridgeFallbackPolicySnapshot')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'nodeBridgeFallbackPolicyLogLine')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'legacyFallbackAuditCompletionSummary')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'legacyFallbackAudit=')
}

function testLegacyAuditHasNoPendingDeleteAfterLogsClean() {
  const text = readText('src/main/legacy/fallback/legacyFallbackAuditRuntime.ts')
  assert(text.includes('explicit-compatibility-only'), 'legacy audit missing explicit compatibility category')
  assert(!/category:\s*['"]delete-after-logs-clean['"]/.test(text), 'legacy audit still has delete-after-logs-clean category')
  assert(text.includes('legacyFallbackAuditCompletionSummary'), 'legacy audit missing completion summary')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:final-migration'], 'package.json missing diagnostics:final-migration')
  assert(pkg.scripts['diagnostics:final-migration'] === 'node build/diagnostics/check-final-migration-closure.cjs', 'unexpected diagnostics:final-migration command')
}

const tests = [
  testFixtureModes,
  testPolicyRuntimeExists,
  testGatedSources,
  testMigrationDiagnosticsExposeFinalPolicy,
  testLegacyAuditHasNoPendingDeleteAfterLogsClean,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`final migration closure checks passed (${tests.length})`)
