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
const parseCalls = env => env.sharedRequests.filter(row => row.args[0] === '--font-parse-batch')
const job = required => ({ jobId: 'stable-source', rootPath: 'C:/fonts', filePath: 'C:/fonts/a.ttf',
  fileSize: 12, modifiedAt: 1700000000000, createdAt: 1700000000000, cacheKey: 'a.ttf', signature: 'a.ttf|12|1700000000000',
  ...(required ? { requireSourceStability: true } : {}) })

async function requireStableAdmission(overrides = new Map()) {
  const env = h.createHarness({ parseTransport: true, capabilities: legacyCapabilities, env: { HFM_NODE_FONTKIT_SCAN_FALLBACK: '1' } }, overrides)
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

async function checkSlicesAndBudget() {
  const inputs = Array.from({ length: 65 }, (_, index) => ({ ...job(true), jobId: 'job-' + index, filePath: 'C:/fonts/' + index + '.ttf' }))
  const payloads = {}
  const settings = { parseTransport: true, capabilities: stableCapabilities, payloads,
    sharedHook: async ({ request, files }) => {
      const input = JSON.parse(files.get(request.args[2]))
      payloads['--font-parse-batch'] = { ok: true, results: input.jobs, errors: [], elapsedMs: 7 }
    } }
  const env = h.createHarness(settings)
  const result = await env.runtime.runRustFontParseBatch(inputs)
  assert.deepEqual(Array.from(result.results, row => row.jobId), inputs.map(row => row.jobId), 'slice order or results lost')
  assert.equal(result.count, 65); assert.equal(result.elapsedMs, 21)
  assert.deepEqual(env.trace.filter(row => row[0] === 'write').map(row => JSON.parse(row[2]).jobs.length), [32, 32, 1])
  assert.equal(env.files.size, 0)
  for (const request of env.sharedRequests) {
    assert.equal(request.write, false); assert.equal(request.verifiedReadOnly, true)
    assert.equal(request.accesses, undefined, 'aliases must keep conservative global read identity')
    assert.deepEqual(request.roots, ['configured-root:font-parse'])
    assert.equal(request.priority, 'background'); assert.equal(request.timeoutMs, 30000)
  }
  const effects = env.trace.filter(row => ['write', 'shared', 'shared.close', 'rm'].includes(row[0])).map(row => row[0])
  assert.deepEqual(effects, Array.from({ length: 3 }, () => ['write', 'shared', 'shared.close', 'rm']).flat())
  const partialPayloads = {}
  const partial = h.createHarness({ ...settings, payloads: partialPayloads, sharedHook: async ({ request, files }) => {
    const slice = JSON.parse(files.get(request.args[2])).jobs
    partialPayloads['--font-parse-batch'] = { ok: true, results: slice.slice(1),
      errors: [{ jobId: slice[0].jobId, path: slice[0].filePath, message: 'controlled source read failure' }], elapsedMs: 3 }
  } })
  const partialResult = await partial.runtime.runRustFontParseBatch(inputs)
  assert.deepEqual(Array.from(partialResult.errors, error => error.jobId), ['job-0', 'job-32', 'job-64'], 'cross-slice errors were lost')
  assert.deepEqual(Array.from(partialResult.results, row => row.jobId), inputs.filter((_, index) => index % 32 !== 0).map(row => row.jobId))
  assert.equal(partialResult.count, 62); assert.equal(partialResult.elapsedMs, 9); assert.equal(partial.files.size, 0)
  const controller = new AbortController()
  const cancelled = h.createHarness({ ...settings, sharedHook: async context => {
    await settings.sharedHook(context)
    setTimeout(() => controller.abort(new Error('between slices')), 0)
  } })
  await assert.rejects(() => cancelled.runtime.runRustFontParseBatch(inputs, controller.signal), error => error.name === 'OperationCancelledError')
  assert.equal(cancelled.sharedRequests.length, 1); assert.equal(cancelled.files.size, 0)
  let budget
  budget = h.createHarness({ ...settings, env: { HFM_RUST_PARSE_BATCH_TIMEOUT_MS: '5000' }, sharedHook: async context => {
    await settings.sharedHook(context); budget.setClock(6001)
  } })
  await assert.rejects(() => budget.runtime.runRustFontParseBatch(inputs), error => error.reason === 'font-parse-total-timeout')
  assert.equal(budget.sharedRequests.length, 1); assert.equal(budget.sharedRequests[0].timeoutMs, 5000)
  assert.equal(budget.files.size, 0)
  const ambient = h.createHarness(settings)
  const ambientController = new AbortController(); ambientController.abort(new Error('ambient scan cancelled'))
  const { withSharedIoSignal } = ambient.load('src/main/path/sharedFileSystemRuntime.ts')
  await assert.rejects(() => withSharedIoSignal(ambientController.signal, () => ambient.runtime.runRustFontParseBatch(inputs)), error => error.name === 'OperationCancelledError')
  assert.equal(ambient.sharedRequests.length, 0)
  const slow = h.createHarness({ ...settings, sharedFailure: 'timeout' })
  await assert.rejects(() => slow.runtime.runRustFontParseBatch(inputs), error => error.reason === 'timeout')
  assert.equal(slow.sharedRequests.length, 1); assert.equal(slow.files.size, 0)
  // Rejection may precede physical close. Neither the aggregate nor the next
  // slice can settle/start until the transport's close receipt arrives.
  let close, entered
  const closed = new Promise(resolve => { close = resolve })
  const started = new Promise(resolve => { entered = resolve })
  let failure
  const held = h.createHarness({ ...settings, sharedHook: async () => { entered(); throw failure } })
  const { SharedIoProcessError } = held.load('src/main/path/sharedIoProcessRuntime.ts')
  failure = new SharedIoProcessError('held child cancellation', 'unknown', 'cancelled'); failure.closed = closed
  let settled = false
  const pending = held.runtime.runRustFontParseBatch(inputs).finally(() => { settled = true })
  void pending.catch(() => {})
  await started; await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(settled, false); assert.equal(held.files.size, 1); assert.equal(held.sharedRequests.length, 1)
  close()
  await assert.rejects(pending, error => error === failure)
  assert.equal(held.files.size, 0)
}

async function checkParseReadProof() {
  for (const negative of [null, 'extra-flag', 'unknown-worker', 'legacy', 'rewrite', 'unowned']) {
    const env = h.createHarness({ parseTransport: true, capabilities: negative === 'legacy' ? legacyCapabilities : stableCapabilities })
    const transport = env.load(h.core + 'rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ enabled: true, required: true, appendStartupLog() {} })
    await transport.diagnoseRustCoreWorker()
    const input = transport.createTemporaryJsonFile('parse-proof')
    await input.writeJson({ jobs: [job(true)], fullHash: false })
    if (negative === 'rewrite') await input.writeJson({ jobs: [job(true)] })
    const args = ['--font-parse-batch', '--input', negative === 'unowned' ? 'C:/unknown.json' : input.path]
    if (negative === 'extra-flag') args.push('--output', 'C:/unknown.json')
    const run = () => transport.runRustCoreScheduledCommand(negative === 'unknown-worker' ? 'C:/other.exe' : 'C:/worker.exe', args, { timeout: 300000 })
    if (negative === 'rewrite' || negative === 'unowned') {
      await assert.rejects(run, error => error.reason === 'font-parse-input-unstable')
      assert.equal(env.sharedRequests.length, 0)
    } else {
      await run()
      const request = env.sharedRequests[0]
      assert.equal(request.verifiedReadOnly, negative === null); assert.equal(request.write, negative !== null)
      assert.equal(request.accesses, undefined); assert.equal(request.timeoutMs, 30000)
      assert(request.roots.includes('configured-root:font-parse'))
      await assert.rejects(() => input.writeJson({ jobs: [] }), error => error.reason === 'font-parse-input-sealed')
    }
    assert.equal(env.files.size, 1, String(negative) + ': unexpected worker filesystem effect')
    assert(env.files.has(input.path), String(negative) + ': owned input disappeared before disposal')
    assert(!env.files.has('C:/unknown.json'), 'parse CLI recognizer invented an output write')
    await input.dispose(); assert.equal(env.files.size, 0)
  }
}

async function main() {
  await checkSlicesAndBudget()
  await checkParseReadProof()
  await requireStableAdmission()
  for (const settings of [{ enabled: false }, { missing: true }, { capabilities: [capability] }]) {
    const env = h.createHarness(settings)
    await assert.rejects(() => env.runtime.runRustFontParseBatch([job(true)]),
      error => error.sharedIo === true && error.reason === 'font-parse-source-stability-unavailable')
    assert.equal(parseCalls(env).length, 0)
    assert.equal(env.trace.filter(row => row[0] === 'write').length, 0)
  }
  {
    const env = h.createHarness({ parseTransport: true, capabilities: legacyCapabilities })
    const result = await env.runtime.runRustFontParseBatch([job(false)])
    assert.equal(result.results.length, 1, 'Unmarked manual batch lost legacy compatibility')
    assert.equal(parseCalls(env).length, 1)
    assert.equal(env.files.size, 0)
  }
  {
    const env = h.createHarness({ parseTransport: true, capabilities: stableCapabilities })
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
    const env = h.createHarness({ parseTransport: true, capabilities: stableCapabilities, mode })
    await assert.rejects(() => env.runtime.runRustFontParseBatch([job(true)]),
      error => error.sharedIo === true && error.reason === (mode === 'exec-fail' ? 'font-parse-source-stability-failed' : 'invalid-receipt') && error.outcome === 'unknown')
    assert.equal(parseCalls(env).length, 1, 'Failure retried the native parse')
    assert.equal(env.files.size, 0)
    const legacy = h.createHarness({ parseTransport: true, capabilities: legacyCapabilities, mode })
    if (mode === 'exec-fail') assert.equal(await legacy.runtime.runRustFontParseBatch([job(false)]), null)
    else await assert.rejects(() => legacy.runtime.runRustFontParseBatch([job(false)]), error => error.reason === 'invalid-receipt')
  }
  {
    let original
    const env = h.createHarness({ parseTransport: true, capabilities: stableCapabilities, execHook: async () => { throw original } })
    const { SharedIoProcessError } = env.load('src/main/path/sharedIoProcessRuntime.ts')
    const closed = Promise.resolve()
    original = new SharedIoProcessError('controlled cancelled owner', 'unknown', 'cancelled')
    original.closed = closed
    await assert.rejects(() => env.runtime.runRustFontParseBatch([job(true)]), error => error === original && error.closed === closed)
    assert.equal(parseCalls(env).length, 1)
    assert.equal(env.files.size, 0)
  }
  {
    const env = h.createHarness({ parseTransport: true, capabilities: stableCapabilities })
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

