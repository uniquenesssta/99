#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const h = require('./helpers/rustWorkerTransportHarness.cjs')
const fixture = require('./fixtures/rust-worker-transport.fixture.json')
const root = path.resolve(__dirname, '../..')
const transportPath = h.core + 'rustCoreWorkerTransportRuntime.ts'
const workerPath = h.core + 'rustCoreWorkerRuntime.ts'
// Git may check out CRLF on Windows; mutation anchors use canonical LF.
const transport = fs.readFileSync(path.join(root, transportPath), 'utf8').replace(/\r\n/g, '\n')
const worker = fs.readFileSync(path.join(root, workerPath), 'utf8').replace(/\r\n/g, '\n')
const clientDir = path.join(root, h.core, 'clients')
const clients = fs.existsSync(clientDir) ? fs.readdirSync(clientDir).filter(name => name.endsWith('.ts')).map(name => {
  const rel = h.core + 'clients/' + name
  return [rel, fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n')]
}) : []
const cases = new Map(fixture.cases.map(s => [s.id, s]))
const sequences = new Map(fixture.sequences.map(s => [s.name, s]))

async function checkCase(scenario, overrides) {
  const { summary } = await h.observe(scenario.method, scenario.settings, overrides)
  assert.deepEqual({ id: scenario.id, ...summary }, cases.get(scenario.id), scenario.id + ' differs from AT-5.1')
}

async function checkSequence(name, overrides) {
  const { summary } = await h.observeSequence(name, overrides)
  assert.deepEqual({ name, ...summary }, sequences.get(name), name + ' differs from AT-5.1')
}

function checkOwnership() {
  let file
  let factories = 0, scopes = 0, disposals = 0
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      assert(!['node:child_process', 'node:fs', 'node:crypto', 'node:os', 'node:path'].includes(node.moduleSpecifier.text), 'facade still owns process or file transport')
      assert(!['rustCoreSchedulerRuntime', 'rustCoreWorkerPathRuntime', 'rustCoreWorkerAutoBuildRuntime'].includes(path.posix.basename(node.moduleSpecifier.text)), 'domain still owns transport construction/diagnostics')
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(file)
      if (name === 'createRustCoreWorkerTransportRuntime') factories++
      if (name === 'createTemporaryJsonFile') scopes++
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'dispose') disposals++
      assert(!['createRustCoreSchedulerRuntime', 'createRustCoreDaemonRuntime'].includes(name), 'facade duplicated transport instances')
    }
    ts.forEachChild(node, visit)
  }
  for (const [rel, text] of [[workerPath, worker], ...clients]) {
    file = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
    visit(file)
  }
  assert.equal(factories, 1, 'facade must construct exactly one transport')
  assert.equal(scopes, 28, 'an existing temporary-file path was not migrated')
  assert.equal(disposals, scopes, 'temporary-file disposal call was dropped')
  const env = h.createHarness()
  assert.deepEqual(env.trace.map(e => e[0]), ['create.scheduler', 'create.daemon'])
  const factory = env.load(transportPath).createRustCoreWorkerTransportRuntime
  const runtime = factory({ enabled: false, required: false, appendStartupLog: () => {} })
  assert.deepEqual(Object.keys(runtime).sort(), ['diagnoseRustCoreWorker', 'rustCoreWorkerStatus', 'invalidateRustCoreSchedulerCaches', 'cancelRustCoreSchedulerScopes', 'noteRustCoreSchedulerInteractiveActivity', 'rustCoreDaemonStatus', 'stopRustCoreDaemon', 'runRustCoreScheduledCommand', 'appendPreviewCacheFailureLog', 'createTemporaryJsonFile'].sort())
}

async function checkFileScope() {
  const env = h.createHarness()
  const runtime = env.load(transportPath).createRustCoreWorkerTransportRuntime({ enabled: false, required: false, appendStartupLog: () => {} })
  const first = runtime.createTemporaryJsonFile('same-prefix')
  const second = runtime.createTemporaryJsonFile('same-prefix')
  assert.notEqual(first.path, second.path, 'concurrent same-prefix requests collided')
  await Promise.all([first.writeJson({ index: 1 }), second.writeJson({ index: 2 })])
  assert.equal(env.files.size, 2)
  assert.deepEqual(JSON.parse(await first.readText()), { index: 1 })
  assert.deepEqual(JSON.parse(await second.readText()), { index: 2 })
  await Promise.all([first.dispose(), second.dispose()])
  assert.equal(env.files.size, 0)
  await first.dispose()
  assert.equal(env.files.size, 0, 'best-effort cleanup must tolerate an absent file')
}

async function checkRealChildProcess() {
  const run = async (script, options, abort) => {
    const env = h.createHarness({ realChild: true })
    const transport = env.load(transportPath).createRustCoreWorkerTransportRuntime({ enabled: false, required: false, appendStartupLog: () => {} })
    const timer = abort ? setTimeout(() => env.external.abort(new Error('real child cancelled')), 40) : null
    try {
      return await transport.runRustCoreScheduledCommand(process.execPath, ['-e', script], { windowsHide: true, signal: env.external.signal, ...options })
    } finally {
      if (timer) clearTimeout(timer)
      for (const owner of ['scheduler', 'external']) assert.equal(env.trace.filter(e => e[0] === owner + '.addEventListener').length, env.trace.filter(e => e[0] === owner + '.removeEventListener').length, owner + ' abort listener leaked')
    }
  }
  assert.equal((await run('process.stdout.write("ok")', { timeout: 5000, maxBuffer: 1024 })).stdout, 'ok')
  await assert.rejects(run('setTimeout(() => {}, 5000)', { timeout: 60 }), error => error.killed === true)
  await assert.rejects(run('process.stdout.write("a".repeat(4096))', { timeout: 5000, maxBuffer: 32 }), error => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  await assert.rejects(run('setTimeout(() => {}, 5000)', { timeout: 5000 }, true), error => error.name === 'AbortError')
}

async function checkMutants() {
  const tests = [
    ['submitted fallback', 'appendDaemonCommandFailureLog(error.message, true)\n        throw error', 'appendDaemonCommandFailureLog(error.message, true)\n        return null', 'runRustFontActivationFiles/submitted'],
    ['abort fallback', "if (error instanceof Error && error.name === 'AbortError') throw error", '', 'activation/{"mode":"daemon-abort"}'],
    ['listener cleanup', 'mergedSignal.cleanup()', 'void mergedSignal', 'runRustFontParseBatch/oneshot'],
    ['cached status', 'if (cachedStatus) return cachedStatus', '', 'cached-ready'],
    ['duplicate scheduler', 'const rustCoreScheduler = createRustCoreSchedulerRuntime', 'createRustCoreSchedulerRuntime({ appendStartupLog: options.appendStartupLog });\n  const rustCoreScheduler = createRustCoreSchedulerRuntime', 'runRustFontActivationFiles/oneshot'],
    ['early file cleanup', "writeJson: value => fsp.writeFile(filePath, JSON.stringify(value), 'utf-8')", "writeJson: value => fsp.writeFile(filePath, JSON.stringify(value), 'utf-8').then(() => fsp.rm(filePath, { force: true }))", 'concurrent-files'],
    ['missing file cleanup', 'fsp.rm(filePath, { force: true }).catch(() => undefined)', 'Promise.resolve()', 'runRustFontActivationFiles/oneshot'],
    ['cleanup masks result', '.catch(() => undefined)', '', 'runRustFontActivationFiles/cleanup-fail'],
    ['throttle threshold', 'now - previous.at < 8000', 'now - previous.at < 7999', 'throttled-preview-daemon'],
    ['command options', '...execOptionsWithoutExternalSignal(execOptions)', 'timeout: 1, maxBuffer: 1', 'runRustFontActivationFiles/oneshot'],
  ]
  for (const [name, before, after, id] of tests) {
    assert(transport.includes(before), 'mutant no longer applies: ' + name)
    const overrides = new Map([[transportPath, transport.replaceAll(before, after)]])
    const scenario = h.scenarios().find(s => s.id === id)
    await assert.rejects(() => scenario ? checkCase(scenario, overrides) : checkSequence(id, overrides), 'mutant was accepted: ' + name)
  }
  return tests.length
}

async function main() {
  const scenarios = h.scenarios()
  assert.deepEqual(scenarios.map(s => s.id), fixture.cases.map(s => s.id), 'baseline scenario set changed')
  assert.deepEqual(h.sequenceNames, fixture.sequences.map(s => s.name))
  checkOwnership()
  for (const scenario of scenarios) await checkCase(scenario)
  for (const name of h.sequenceNames) await checkSequence(name)
  await checkFileScope()
  await checkRealChildProcess()
  const mutants = await checkMutants()
  const crlf = new Map([[transportPath, transport], [workerPath, worker], ...clients].map(([rel, text]) => [rel, text.replace(/\r?\n/g, '\r\n')]))
  for (const scenario of scenarios.filter(s => ['oneshot', 'submitted'].includes(s.settings.mode))) await checkCase(scenario, crlf)
  console.log(`[diagnostics:rust-worker-transport] ${scenarios.length} frozen command cases, ${h.sequenceNames.length} state/lifecycle sequences, 28 file scopes, real Node success/timeout/maxBuffer/abort, ${mutants} rejected mutants and CRLF passed`)
}
main().catch(error => { console.error('[diagnostics:rust-worker-transport]', error.stack || error); process.exitCode = 1 })
