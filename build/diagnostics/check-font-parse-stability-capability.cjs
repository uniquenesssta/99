#!/usr/bin/env node
'use strict'
// Production client and fast-path admission; only worker/transport ports are
// supplied by the existing harness. Execute with the Windows diagnostic suite.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers/rustWorkerTransportHarness.cjs')
const capability = 'font-parse-batch-source-stability-v1'
const legacyCapabilities = [...new Set(h.commands.flatMap(command => command.capabilities))].filter(value => value !== capability)
const stableCapabilities = [...legacyCapabilities, capability]
const clientPath = h.core + 'clients/rustIndexingClientRuntime.ts'
const parseCalls = env => env.trace.filter(row => row[0] === 'exec' && row[2][0] === '--font-parse-batch')
const job = required => ({ jobId: 'stable-source', rootPath: 'C:/fonts', filePath: 'C:/fonts/a.ttf',
  fileSize: 12, modifiedAt: 1700000000000, createdAt: 1700000000000, cacheKey: 'a.ttf', signature: 'a.ttf|12|1700000000000',
  ...(required ? { requireSourceStability: true } : {}) })

async function requireStableAdmission(overrides = new Map()) {
  const env = h.createHarness({ capabilities: legacyCapabilities, env: { HFM_NODE_FONTKIT_SCAN_FALLBACK: '1' } }, overrides)
  const consume = env.load('src/main/indexing/scan-orchestrator/rustParseBatchFastPathRuntime.ts').consumeRustFontParseBatchFastPath
  let accepted = 0
  await assert.rejects(() => consume({ jobs: [job(true)], scriptDetectionVersion: 2,
    runRustFontParseBatch: env.runtime.runRustFontParseBatch, processResult: async () => { accepted++ },
    appendStartupLog() {}, logPrefix: 'capability diagnostic' }),
  error => error.sharedIo === true && error.outcome === 'not-started' && error.reason === 'font-parse-source-stability-unavailable')
  assert.equal(accepted, 0)
  assert.equal(parseCalls(env).length, 0, 'Old worker received a stability-required job')
  assert.equal(env.trace.filter(row => row[0] === 'write').length, 0, 'Denied job created a temporary payload')
  assert.equal(env.files.size, 0)
}

async function main() {
  await requireStableAdmission()
  for (const settings of [{ enabled: false }, { missing: true }, { capabilities: [capability] }]) {
    const env = h.createHarness(settings)
    await assert.rejects(() => env.runtime.runRustFontParseBatch([job(true)]),
      error => error.sharedIo === true && error.reason === 'font-parse-source-stability-unavailable')
    assert.equal(parseCalls(env).length, 0)
    assert.equal(env.trace.filter(row => row[0] === 'write').length, 0)
  }
  {
    const env = h.createHarness({ capabilities: legacyCapabilities })
    const result = await env.runtime.runRustFontParseBatch([job(false)])
    assert.equal(result.results.length, 1, 'Unmarked manual batch lost legacy compatibility')
    assert.equal(parseCalls(env).length, 1)
    assert.equal(env.files.size, 0)
  }
  {
    const env = h.createHarness({ capabilities: stableCapabilities })
    const input = job(true)
    const result = await env.runtime.runRustFontParseBatch([input])
    assert.equal(result.results.length, 1)
    assert.equal(parseCalls(env).length, 1, 'Capable worker was skipped or submitted twice')
    const writes = env.trace.filter(row => row[0] === 'write')
    assert.equal(writes.length, 1)
    assert.deepEqual(JSON.parse(writes[0][2]).jobs, [input], 'Stability requirement was lost before native submission')
    assert.equal(env.files.size, 0)
  }
  for (const mode of ['bad-json', 'false-oneshot', 'exec-fail']) {
    const env = h.createHarness({ capabilities: stableCapabilities, mode })
    await assert.rejects(() => env.runtime.runRustFontParseBatch([job(true)]),
      error => error.sharedIo === true && error.reason === 'font-parse-source-stability-failed' && error.outcome === 'unknown')
    assert.equal(parseCalls(env).length, 1, 'Failure retried the native parse')
    assert.equal(env.files.size, 0)
    const legacy = h.createHarness({ capabilities: legacyCapabilities, mode })
    assert.equal(await legacy.runtime.runRustFontParseBatch([job(false)]), null, 'Unmarked failure behavior changed')
  }
  {
    let original
    const env = h.createHarness({ capabilities: stableCapabilities, execHook: async () => { throw original } })
    const { SharedIoProcessError } = env.load('src/main/path/sharedIoProcessRuntime.ts')
    const closed = Promise.resolve()
    original = new SharedIoProcessError('controlled cancelled owner', 'unknown', 'cancelled')
    original.closed = closed
    await assert.rejects(() => env.runtime.runRustFontParseBatch([job(true)]), error => error === original && error.closed === closed)
    assert.equal(parseCalls(env).length, 1)
    assert.equal(env.files.size, 0)
  }
  {
    const env = h.createHarness({ capabilities: stableCapabilities })
    const controller = new AbortController(); controller.abort()
    await assert.rejects(() => env.runtime.runRustFontParseBatch([job(true)], controller.signal), error => error.name === 'OperationCancelledError')
    assert.equal(parseCalls(env).length, 0)
    assert.equal(env.trace.filter(row => row[0] === 'write').length, 0)
  }
  // Removing only the new feature admission must make the causal refusal test
  // fail, while the legacy feature remains present and the transport can submit.
  const source = fs.readFileSync(path.resolve(__dirname, '../..', clientPath), 'utf8')
  const gate = "!hasCapability(status, 'font-parse-batch-source-stability-v1')"
  assert(source.includes(gate), 'Capability mutation target missing')
  await assert.rejects(() => requireStableAdmission(new Map([[clientPath, source.replace(gate, 'false')]])),
    error => error.name === 'AssertionError')
  console.log('[diagnostics:font-parse-stability-capability] legacy refusal, capable submission, manual compatibility, failure/cancel ownership and admission mutant passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
