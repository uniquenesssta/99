#!/usr/bin/env node
/*
 * Regression checks for Rust state-command failure handling.
 * When these Rust commands fail, Node fallback must be explicit-policy gated,
 * and logs must not imply an ungated fallback path remains active.
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
  const data = readJson('build/diagnostics/fixtures/rust-state-fallback-failure-protocol.fixture.json')
  assert(data.name === 'rust-state-fallback-failure-protocol-fixture', 'unexpected fixture name')
  assert(data.policyGate === 'HFM_NODE_STATE_FALLBACK=1', 'policy gate changed')
  assert(Array.isArray(data.scenarios) && data.scenarios.length === 10, 'fixture should cover ten Rust state failure scenarios')
  return data
}

function testProtocolModuleListsEveryFixtureCommand() {
  const data = fixture()
  const source = read('src/main/rust-core/rustStateFallbackFailureProtocolRuntime.ts')
  assert(source.includes('rustStateFallbackFailureProtocolSnapshot'), 'protocol snapshot missing')
  assert(source.includes('Node fallback is policy-gated by'), 'policy-gated log suffix missing')
  for (const scenario of data.scenarios) {
    assert(source.includes(`'${scenario.command}'`), `protocol module missing ${scenario.command}`)
  }
}

function testRustWorkerFailureLogsArePolicyGated() {
  const data = fixture()
  const worker = read('src/main/rust-core/rustCoreWorkerRuntime.ts')
  assert(worker.includes('rustStateFallbackFailureLogSuffix'), 'rust worker does not use policy-gated log helper')
  for (const scenario of data.scenarios) {
    assert(worker.includes(`rustStateFallbackFailureLogSuffix('${scenario.command}')`), `rust worker failure log is not policy-gated for ${scenario.command}`)
  }
}

function testFallbackCallersStillGateNodePaths() {
  const data = fixture()
  for (const scenario of data.scenarios) {
    const source = read(scenario.runtimeFile)
    assert(source.includes(`source: '${scenario.fallbackSource}'`), `${scenario.runtimeFile} missing fallback source ${scenario.fallbackSource}`)
    for (const needle of scenario.requires || []) {
      assert(source.includes(needle), `${scenario.runtimeFile} missing ${needle} for ${scenario.name}`)
    }
    assert(source.includes('logNodeStateFallbackUsed'), `${scenario.runtimeFile} should log explicit compatibility fallback usage for ${scenario.name}`)
  }
}

function testMigrationDiagnosticsExposeProtocol() {
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'rustStateFallbackFailureProtocolSnapshot')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'rustStateFallbackFailureProtocol')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'commands policy-gated')
}

function testPackageScriptRegistered() {
  const pkg = JSON.parse(read('package.json'))
  assert(pkg.scripts && pkg.scripts['diagnostics:rust-state-fallback'], 'package.json missing diagnostics:rust-state-fallback')
  assert(pkg.scripts['diagnostics:rust-state-fallback'] === 'node build/diagnostics/check-rust-state-fallback-failure-protocol.cjs', 'unexpected diagnostics:rust-state-fallback command')
  assert(pkg.version === '3.0.0', 'package version changed')
}

const tests = [
  testProtocolModuleListsEveryFixtureCommand,
  testRustWorkerFailureLogsArePolicyGated,
  testFallbackCallersStillGateNodePaths,
  testMigrationDiagnosticsExposeProtocol,
  testPackageScriptRegistered,
]

for (const test of tests) {
  test()
  console.log(`ok ${test.name}`)
}
console.log(`rust state fallback failure protocol checks passed (${tests.length})`)
