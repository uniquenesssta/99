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
const plain = value => JSON.parse(JSON.stringify(value))

// Only an intentionally corrected diagnostic sentence differs from the frozen
// transport transcript. Process arguments, effects, outcomes and ordering stay exact;
// check-preview-provenance separately locks the corrected user-facing diagnostic.
function legacyDiagnosticWording(observed) {
  const trace=observed.h.trace.map(row=>row[0]==='log'?row.map((value,index)=>index===1&&typeof value==='string'?value.replace('; fallback decision deferred to preview dispatcher','; directwrite helper fallback remains active'):value):row)
  return {...observed.summary,traceHash:h.digest(trace)}
}

async function checkCase(scenario, overrides) {
  if (scenario.method === 'runRustFontIndexListWorker') return checkListingCase(scenario, overrides)
  if (scenario.method === 'runRustSharedMetadataOverlayRead') return checkMetadataOverlayCase(scenario, overrides)
  if (scenario.method === 'runRustPreviewRenderImage') return checkUnprovenPreviewCase(scenario, overrides)
  const observed = await h.observe(scenario.method, scenario.settings, overrides)
  const summary = legacyDiagnosticWording(observed)
  assert.deepEqual({ id: scenario.id, ...summary }, cases.get(scenario.id), scenario.id + ' differs from AT-5.1')
}

// Explicit AT-5.1 exception: listing now owns an unknown TEMP write effect,
// even for a lexical C: source. Do not regenerate the frozen hashes. The other
// unaffected commands and lifecycle sequences keep their original exact comparisons.
async function checkListingCase(scenario, overrides) {
  const observed = await h.observe(scenario.method, { ...scenario.settings, listTransport: true }, overrides)
  const { summary, h: env } = observed
  const mode = scenario.settings.mode || 'oneshot'
  const preAbort = !!scenario.settings.preAbort
  const invalid = ['false-oneshot', 'false-daemon', 'bad-json'].includes(mode)
  const cancelled = mode === 'external-abort'
  const readFailed = mode === 'read-fail'
  const output = '/fixture-tmp/hfm-rust-list-1-1000-id-1.json'
  let expected = cases.get('runRustFontIndexListWorker/oneshot').outcome
  if (preAbort) expected = { kind: 'error', name: 'Error', message: 'Rust listing cancelled', submitted: false }
  else if (cancelled) expected = { kind: 'error', name: 'SharedIoProcessError', message: 'fixture shared cancelled', submitted: false }
  else if (invalid) expected = { kind: 'error', name: 'SharedIoProcessError',
    message: 'Shared I/O invalid receipt: ' + (mode === 'bad-json' ? 'SyntaxError: fixture invalid JSON' : 'Error: worker returned ok=false'), submitted: false }
  else if (readFailed) expected = { kind: 'error', name: 'Error', message: 'read failed', submitted: false }
  // Daemon submitted/pre-submit/scheduler fault injection no longer affects this
  // command: it must enter the isolated Shared I/O owner exactly once.
  assert.deepEqual(summary.outcome, expected, scenario.id + ' listing outcome')
  assert.equal(summary.pendingFiles, mode === 'cleanup-fail' ? 1 : 0, scenario.id + ' listing cleanup')
  assert.equal(env.sharedRequests.length, preAbort ? 0 : 1, scenario.id + ' shared submission count')
  assert(!env.trace.some(row => row[0] === 'daemon' || row[0] === 'schedule' || (row[0] === 'exec' && row[2][0] === '--list-font-files')), scenario.id + ' escaped conservative listing owner')
  if (!preAbort) {
    assert.deepEqual(env.sharedRequests[0], {
      file: 'C:/worker.exe',
      args: ['--list-font-files', '--root', 'C:/fonts', '--extensions', 'ttf', '--max', '300000', '--output', output, '--probe-names', '--probe-scripts', '--probe-style', '--probe-family'],
      roots: ['configured-root:listing-output'], write: true, verifiedReadOnly: false, sharedReadOnlyPreview: false,
      label: 'list-font-files', lane: 'default', priority: 'normal', timeoutMs: 30000, queueTimeoutMs: 3000,
      maxBuffer: 256 * 1024, signalAborted: false, hasClose: true, admitted: true,
    }, scenario.id + ' complete legacy listing footprint')
    assert.deepEqual(plain(env.trace.filter(row => row[0] === 'rm')), [['rm', output, { force: true }]])
    assert.deepEqual(plain(env.trace.filter(row => row[0] === 'read')), invalid || cancelled ? [] : [['read', output, 'utf-8']])
  }
  const effects = env.trace.filter(row => ['uuid', 'write', 'shared', 'shared.close', 'read', 'progress', 'rm'].includes(row[0])).map(row => row[0])
  assert.deepEqual(effects, preAbort ? [] : ['uuid', 'shared', 'shared.close', ...(!invalid && !cancelled ? ['read', ...(!readFailed ? ['progress'] : [])] : []), 'rm'], scenario.id + ' listing effect order')
}

// The legacy overlay reader may initialize/migrate its database. Deriving its
// write effect from the original descriptor now isolates local roots as well.
// Keep every unrelated frozen trace; assert this intentional route explicitly.
async function checkMetadataOverlayCase(scenario, overrides) {
  const observed = await h.observe(scenario.method, { ...scenario.settings, metadataTransport: true }, overrides)
  const { summary, h: env } = observed
  const mode = scenario.settings.mode || 'oneshot'
  const invalid = ['false-oneshot', 'false-daemon', 'bad-json'].includes(mode)
  const writeFailed = mode === 'write-fail'
  const input = '/fixture-tmp/hfm-rust-shared-metadata-overlay-read-1-1000-id-1.json'
  const expected = writeFailed ? { kind: 'null', value: null }
    : invalid ? { kind: 'error', name: 'SharedIoProcessError', message: 'Shared I/O invalid receipt: ' + (mode === 'bad-json' ? 'SyntaxError: fixture invalid JSON' : 'Error: worker returned ok=false'), submitted: false }
    : cases.get('runRustSharedMetadataOverlayRead/oneshot').outcome
  assert.deepEqual(summary.outcome, expected, scenario.id + ' isolated overlay outcome')
  assert.equal(summary.pendingFiles, mode === 'cleanup-fail' ? 1 : 0, scenario.id + ' isolated input cleanup')
  assert.equal(env.sharedRequests.length, writeFailed ? 0 : 1, scenario.id + ' shared submissions')
  assert(!env.trace.some(row => row[0] === 'daemon' || row[0] === 'schedule' || (row[0] === 'exec' && row[2][0] === '--shared-metadata-overlay-read')), scenario.id + ' mutable overlay escaped isolation')
  assert.deepEqual(plain(env.trace.filter(row => row[0] === 'write')), [['write', input, JSON.stringify({ rootPath: 'C:/fonts', dbPath: 'C:/index.db', entries: [{ key: 'k', fontId: 'f', relativePath: 'a.ttf', pathKey: 'a' }] }), 'utf-8']], scenario.id + ' serialized input')
  assert.deepEqual(plain(env.trace.filter(row => row[0] === 'rm')), [['rm', input, { force: true }]])
  if (!writeFailed) assert.deepEqual(env.sharedRequests[0], {
    file: 'C:/worker.exe', args: ['--shared-metadata-overlay-read', '--input', input],
    roots: ['local-metadata:c:/index.db|c:/|c:/fonts'], accesses: [],
    write: true, verifiedReadOnly: false, sharedReadOnlyPreview: false,
    label: 'shared-metadata-overlay-read', lane: 'default', priority: 'normal', timeoutMs: 30000, queueTimeoutMs: 3000,
    maxBuffer: 16 * 1024 * 1024, signalAborted: false, hasClose: true, admitted: true,
  }, scenario.id + ' complete isolated write effect')
  const effects = env.trace.filter(row => ['uuid', 'write', 'shared', 'shared.close', 'read', 'rm'].includes(row[0])).map(row => row[0])
  assert.deepEqual(effects, ['uuid', 'write', ...(!writeFailed ? ['shared', 'shared.close'] : []), 'rm'], scenario.id + ' lease release order')
}

async function checkUnprovenPreviewCase(scenario, overrides) {
  const observed = await h.observe(scenario.method, { ...scenario.settings, previewTransport: true }, overrides)
  const { summary, h: env } = observed
  const mode = scenario.settings.mode || 'oneshot', writeFailed = mode === 'write-fail'
  const invalid = ['false-oneshot', 'false-daemon', 'bad-json'].includes(mode)
  const input = '/fixture-tmp/hfm-rust-preview-render-1-1000-id-1.json'
  const expected = writeFailed ? { kind: 'null', value: null }
    : invalid ? { kind: 'error', name: 'SharedIoProcessError', message: 'Shared I/O invalid receipt: ' + (mode === 'bad-json' ? 'SyntaxError: fixture invalid JSON' : 'Error: worker returned ok=false'), submitted: false }
    : cases.get('runRustPreviewRenderImage/oneshot').outcome
  assert.deepEqual(summary.outcome, expected, scenario.id + ' isolated preview outcome')
  assert.equal(summary.pendingFiles, mode === 'cleanup-fail' ? 1 : 0)
  assert.equal(env.sharedRequests.length, writeFailed ? 0 : 1)
  assert(!env.trace.some(row => row[0] === 'daemon' || row[0] === 'schedule' || (row[0] === 'exec' && row[2][0] === '--preview-render-image')), 'unproved preview output escaped isolation')
  assert.deepEqual(plain(env.trace.filter(row => row[0] === 'write')), [['write', input, JSON.stringify(h.argsFor(scenario.method, env)[0]), 'utf-8']])
  assert.deepEqual(plain(env.trace.filter(row => row[0] === 'rm')), [['rm', input, { force: true }]])
  if (!writeFailed) assert.deepEqual(env.sharedRequests[0], {
    file: 'C:/worker.exe', args: ['--preview-render-image', '--input', input], roots: ['configured-root:preview-output-unverified'],
    write: true, verifiedReadOnly: false, sharedReadOnlyPreview: false,
    label: 'preview-render-image', lane: 'default', priority: 'normal', timeoutMs: 30000, queueTimeoutMs: 3000,
    maxBuffer: 1024 * 1024, signalAborted: false, hasClose: true, admitted: true,
  }, 'complete unproven preview write barrier')
  assert.deepEqual(env.trace.filter(row => ['uuid', 'write', 'shared', 'shared.close', 'read', 'rm'].includes(row[0])).map(row => row[0]), ['uuid', 'write', ...(!writeFailed ? ['shared', 'shared.close'] : []), 'rm'])
}

async function checkIsolatedMetadataFailure() {
  for (const sharedFailure of ['timeout', 'cancelled', 'spawn-failed']) {
    const observed = await h.observe('runRustSharedMetadataOverlayRead', { metadataTransport: true, sharedFailure })
    assert.deepEqual(observed.summary.outcome, { kind: 'error', name: 'SharedIoProcessError', message: 'fixture shared ' + sharedFailure, submitted: false })
    assert.equal(observed.summary.pendingFiles, 0, 'isolated rejection leaked its input lease')
    assert.equal(observed.h.sharedRequests.length, 1, 'isolated failure retried an overlay write')
    assert(!observed.h.trace.some(row => row[0] === 'daemon' || row[0] === 'schedule'), 'isolated failure downgraded into fallback')
    assert.equal(observed.h.trace.filter(row => row[0] === 'shared.close').length, 1)
    assert.equal(observed.h.trace.filter(row => row[0] === 'rm').length, 1)
  }
}

async function checkStdoutListing(overrides) {
  const capabilities = ['list-font-files', 'list-font-files-stdout-v1']
  const rootPath = '\\\\server\\share\\fonts'
  const args = ['--list-font-files', '--root', rootPath, '--extensions', 'ttf', '--max', '300000']
  const expectedResult = JSON.parse(JSON.stringify(cases.get('runRustFontIndexListWorker/oneshot').outcome))
  expectedResult.value.files[0].rootPath = rootPath
  const observed = await h.observe('runRustFontIndexListWorker', {
    listTransport: true, capabilities, listFolders: [rootPath],
    stderrLines: ['not progress', 'hfm-scan-progress: {"files":0,"foldersScanned":0}', 'hfm-scan-progress: {"files":-1,"foldersScanned":0}', 'hfm-scan-progress: {broken'],
  }, overrides)
  assert.deepEqual(observed.summary.outcome, expectedResult)
  assert.equal(observed.summary.pendingFiles, 0)
  assert.deepEqual(observed.h.sharedRequests, [{
    file: 'C:/worker.exe', args, roots: ['\\\\server\\share'],
    accesses: [{ path: rootPath, mode: 'read', scope: 'tree', root: '\\\\server\\share' }],
    write: false, verifiedReadOnly: true, sharedReadOnlyPreview: false,
    label: 'list-font-files', lane: 'default', priority: 'normal', timeoutMs: 600000, queueTimeoutMs: 3000,
    maxBuffer: 32 * 1024 * 1024 + 256 * 1024, signalAborted: false, hasClose: true, admitted: true,
  }], 'stdout capability must produce the complete pinned read description')
  assert(!observed.h.trace.some(row => ['uuid', 'write', 'read', 'rm', 'daemon', 'schedule'].includes(row[0])), 'stdout listing touched TEMP or a daemon lane')
  assert.deepEqual(plain(observed.h.trace.filter(row => row[0] === 'progress')), [['progress', { files: 0, foldersScanned: 0 }], ['progress', { files: 1, foldersScanned: 1 }]])
  const local = await h.observe('runRustFontIndexListWorker', { listTransport: true, capabilities }, overrides)
  assert.deepEqual(local.summary.outcome, cases.get('runRustFontIndexListWorker/oneshot').outcome)
  assert.equal(local.h.sharedRequests.length, 0, 'proven local stdout unnecessarily acquired the global write barrier')
  const localExec = local.h.trace.filter(row => row[0] === 'exec' && row[2][0] === '--list-font-files')
  assert.equal(localExec.length, 1)
  assert.deepEqual(plain(localExec[0][2]), ['--list-font-files', '--root', 'C:/fonts', '--extensions', 'ttf', '--max', '300000'])
  assert.equal(localExec[0][3].maxBuffer, 32 * 1024 * 1024 + 256 * 1024)
  assert(!local.h.trace.some(row => ['uuid', 'write', 'read', 'rm'].includes(row[0])), 'local stdout listing allocated a transfer file')

  const localRoot = 'C:/fonts'
  const readTarget = () => ({ paths: [localRoot], write: false, accesses: [{ path: localRoot, mode: 'read', scope: 'tree' }] })
  const localArgs = ['--list-font-files', '--root', localRoot, '--extensions', 'ttf', '--max', '300000']
  // These are independent invalid proofs, rather than a snapshot of current
  // implementation output. Every one must retain a global, unnarrowed writer.
  const negatives = [
    { name: 'old worker without stdout capability', capabilities: ['list-font-files'] },
    { name: 'no cached worker handshake', diagnose: false },
    { name: 'different worker executable', worker: 'C:/other-worker.exe' },
    { name: 'legacy output', args: [...localArgs, '--output', '\\\\temp\\share\\out.json'] },
    { name: 'equals-style output', args: [...localArgs, '--output=\\\\temp\\share\\out.json'] },
    { name: 'second command', args: [...localArgs, '--shared-file-io'] },
    { name: 'unknown option', args: [...localArgs, '--unexpected'] },
    { name: 'extra positional value', args: [...localArgs, 'unapproved'] },
    { name: 'duplicate root', args: [...localArgs, '--root', 'C:/other'] },
    { name: 'duplicate probe', args: [...localArgs, '--probe-names', '--probe-names'] },
    { name: 'missing max', args: localArgs.slice(0, -2) },
    { name: 'missing max value', args: localArgs.slice(0, -1) },
    { name: 'zero max', args: [...localArgs.slice(0, -1), '0'] },
    { name: 'noninteger max', args: [...localArgs.slice(0, -1), '1.5'] },
    { name: 'wrong root footprint', target: { paths: ['C:/other'], write: false, accesses: [{ path: 'C:/other', mode: 'read', scope: 'tree' }] } },
    { name: 'extra root footprint', target: { paths: [localRoot, 'C:/other'], write: false, accesses: [{ path: localRoot, mode: 'read', scope: 'tree' }, { path: 'C:/other', mode: 'read', scope: 'tree' }] } },
    { name: 'file-only footprint', target: { paths: [localRoot], write: false, accesses: [{ path: localRoot, mode: 'read', scope: 'file' }] } },
    { name: 'write access in read declaration', target: { paths: [localRoot], write: false, accesses: [{ path: localRoot, mode: 'write', scope: 'tree' }] } },
    { name: 'missing access footprint', target: { paths: [localRoot], write: false } },
    { name: 'undeclared effects', target: null },
  ]
  for (const negative of negatives) {
    const env = h.createHarness({ listTransport: true, capabilities: negative.capabilities || capabilities }, overrides)
    const module = env.load(transportPath)
    assert.equal(module.FONT_SCAN_LISTING_STDOUT_MAX_BYTES, 32 * 1024 * 1024)
    const runtime = module.createRustCoreWorkerTransportRuntime({ enabled: true, required: false, appendStartupLog() {} })
    if (negative.diagnose !== false) await runtime.diagnoseRustCoreWorker()
    const requestArgs = negative.args || localArgs
    await runtime.runRustCoreScheduledCommand(negative.worker || 'C:/worker.exe', requestArgs, {
      timeout: 600000, maxBuffer: 1024 * 1024, sharedIo: negative.target === null ? undefined : negative.target || readTarget(),
    })
    assert.equal(env.sharedRequests.length, 1, negative.name + ' avoided isolated submission')
    const request = env.sharedRequests[0]
    assert.equal(request.write, true, negative.name + ' claimed read effects')
    assert.equal(request.verifiedReadOnly, false, negative.name + ' obtained a read proof')
    assert.equal(request.accesses, undefined, negative.name + ' narrowed its unknown writes')
    assert(request.roots.includes('configured-root:listing-output'), negative.name + ' omitted the global barrier')
    if (negative.name.includes('output')) assert(request.roots.includes('\\\\temp\\share'), negative.name + ' omitted the actual output share')
    assert.equal(request.timeoutMs, 30000, negative.name + ' borrowed the long read-only timeout')
    assert.equal(request.lane, 'default'); assert.equal(request.sharedReadOnlyPreview, false)
    assert(!env.trace.some(row => row[0] === 'daemon' || row[0] === 'schedule' || (row[0] === 'exec' && row[2][0] === '--list-font-files')), negative.name + ' fell back outside Shared I/O')
  }
  // Explicit overflow/failure does not become an empty successful scan or retry.
  for (const sharedFailure of ['max-buffer', 'timeout']) {
    const failed = await h.observe('runRustFontIndexListWorker', { listTransport: true, capabilities, listFolders: [rootPath], sharedFailure }, overrides)
    assert.deepEqual(failed.summary.outcome, { kind: 'error', name: 'SharedIoProcessError', message: 'fixture shared ' + sharedFailure, submitted: false })
    assert.equal(failed.h.sharedRequests.length, 1); assert.equal(failed.summary.pendingFiles, 0)
    assert(!failed.h.trace.some(row => row[0] === 'progress' || row[0] === 'daemon' || row[0] === 'schedule'))
  }
  const incomplete = await h.observe('runRustFontIndexListWorker', { listTransport: true, capabilities, listFolders: [rootPath], payloads: { '--list-font-files': { ok: true, files: [] } } }, overrides)
  assert.deepEqual(incomplete.summary.outcome, { kind: 'error', name: 'Error', message: 'rust stdout listing receipt incomplete', submitted: false })
  assert.equal(incomplete.h.sharedRequests.length, 1); assert.equal(incomplete.summary.pendingFiles, 0)
  return negatives.length
}

async function checkSequence(name, overrides) {
  const observed = await h.observeSequence(name, overrides)
  if (name === 'concurrent-files') {
    // Local activation keeps its old transport; unproven preview output now
    // owns a shared writer. Keep frozen results and assert both file lifetimes.
    assert.deepEqual(observed.summary.results, sequences.get(name).results)
    assert.equal(observed.summary.pendingFiles, 0)
    const trace=observed.h.trace, writes=trace.filter(row=>row[0]==='write'), removals=trace.filter(row=>row[0]==='rm')
    assert.equal(writes.length,2);assert.equal(new Set(writes.map(row=>row[1])).size,2)
    assert.deepEqual(removals.map(row=>row[1]).sort(),writes.map(row=>row[1]).sort())
    assert.equal(observed.h.sharedRequests.length,1)
    const preview=observed.h.sharedRequests[0]
    assert.equal(preview.label,'preview-render-image');assert.equal(preview.write,true);assert.equal(preview.accesses,undefined)
    assert.deepEqual(preview.roots,['configured-root:preview-output-unverified'])
    const previewInput=preview.args[preview.args.indexOf('--input')+1]
    assert(trace.findIndex(row=>row[0]==='rm'&&row[1]===previewInput)>trace.findIndex(row=>row[0]==='shared.close'),'preview input removed before isolated close')
    assert.equal(trace.filter(row=>row[0]==='exec'&&row[2][0]==='--font-activation-files').length,1)
    return
  }
  const summary = legacyDiagnosticWording(observed)
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
    ['early file cleanup', "writeJson: value => fsp.writeFile(filePath, JSON.stringify(traceRustInput(value)), 'utf-8')", "writeJson: value => fsp.writeFile(filePath, JSON.stringify(traceRustInput(value)), 'utf-8').then(() => fsp.rm(filePath, { force: true }))", 'concurrent-files'],
    ['missing file cleanup', 'fsp.rm(filePath, { force: true }).catch(() => undefined)', 'Promise.resolve()', 'runRustFontActivationFiles/oneshot'],
    ['cleanup masks result', '.catch(() => undefined)', '', 'runRustFontActivationFiles/cleanup-fail'],
    ['throttle threshold', 'now - previous.at < 8000', 'now - previous.at < 7999', 'throttled-preview-daemon'],
    ['command options', '...execOptionsWithoutExternalSignal(execOptions)', 'timeout: 1, maxBuffer: 1', 'runRustFontActivationFiles/oneshot'],
    ['listing capability proof', "hasCapability(cachedStatus, 'list-font-files-stdout-v1') && isStdoutFontListingArgs(args)", 'true && isStdoutFontListingArgs(args)', 'stdout-listing'],
    ['listing worker proof', 'const verifiedListing = completeReadFootprint && cachedStatus?.path === workerPath', 'const verifiedListing = completeReadFootprint', 'stdout-listing'],
    ['listing CLI proof', '&& isStdoutFontListingArgs(args)', '', 'stdout-listing'],
    ['listing conservative barrier', "const conservativeListing = args[0] === '--list-font-files' && !verifiedListing", "const conservativeListing = args[0] === '--list-font-files' && args.includes('--output')", 'stdout-listing'],
    ['listing stdout bound', 'FONT_SCAN_LISTING_STDOUT_MAX_BYTES = 32 * 1024 * 1024', 'FONT_SCAN_LISTING_STDOUT_MAX_BYTES = 64 * 1024 * 1024', 'stdout-listing'],
    ['original metadata write effects', 'if (target?.accesses?.length && !sharedReadOnlyPreview)', 'if (target && accesses?.length && !sharedReadOnlyPreview)', 'runRustSharedMetadataOverlayRead/oneshot'],
    ['isolated metadata close lease', 'signal: execOptions.signal, onClose, admit', 'signal: execOptions.signal, admit', 'runRustSharedMetadataOverlayRead/oneshot'],
    ['unproved preview output barrier', "const conservativePreviewOutput = args[0] === '--preview-render-image' && !sharedReadOnlyPreview && !completePreviewWriteFootprint", 'const conservativePreviewOutput = false', 'runRustPreviewRenderImage/oneshot'],
  ]
  for (const [name, before, after, id] of tests) {
    assert(transport.includes(before), 'mutant no longer applies: ' + name)
    const overrides = new Map([[transportPath, transport.replaceAll(before, after)]])
    const scenario = h.scenarios().find(s => s.id === id)
    await assert.rejects(() => id === 'stdout-listing' ? checkStdoutListing(overrides) : scenario ? checkCase(scenario, overrides) : checkSequence(id, overrides), 'mutant was accepted: ' + name)
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
  const listingNegatives = await checkStdoutListing()
  await checkIsolatedMetadataFailure()
  await checkFileScope()
  await checkRealChildProcess()
  const mutants = await checkMutants()
  const crlf = new Map([[transportPath, transport], [workerPath, worker], ...clients].map(([rel, text]) => [rel, text.replace(/\r?\n/g, '\r\n')]))
  for (const scenario of scenarios.filter(s => ['oneshot', 'submitted'].includes(s.settings.mode))) await checkCase(scenario, crlf)
  console.log(`[diagnostics:rust-worker-transport] ${scenarios.filter(s => !['runRustFontIndexListWorker', 'runRustSharedMetadataOverlayRead', 'runRustPreviewRenderImage'].includes(s.method)).length} frozen unaffected command cases, ${scenarios.filter(s => s.method === 'runRustFontIndexListWorker').length} explicit migrated list cases, ${scenarios.filter(s => s.method === 'runRustSharedMetadataOverlayRead').length} isolated overlay cases, ${scenarios.filter(s => s.method === 'runRustPreviewRenderImage').length} isolated unproven preview cases, ${listingNegatives} rejected listing read proofs, ${h.sequenceNames.length} state/lifecycle sequences, 28 file scopes, real Node success/timeout/maxBuffer/abort, ${mutants} rejected mutants and CRLF passed`)
}
main().catch(error => { console.error('[diagnostics:rust-worker-transport]', error.stack || error); process.exitCode = 1 })
