#!/usr/bin/env node
process.env.HFM_LOG_DETAIL = 'debug'
const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os'), cp = require('node:child_process')
const { loader } = require('./check-operation-chain.cjs')
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test) { const end = Date.now() + 10000; while (!test()) { assert(Date.now() < end, 'condition timed out'); await tick(10) } }
// Hold an assertion-visible promise without allowing a queue failure to become
// an unhandled rejection while the real-child admission predicate is awaited.
const tracked = promise => { void promise.catch(() => {}); return promise }
async function main() {
  assert.equal(process.platform, 'win32', 'Shared preview admission requires Windows')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-preview-shared-')), children = new Set(), logs = [], jobs = [], requests = []
  let hold = true, peak = 0, daemonCalls = 0
  const root = path.resolve(__dirname, '../..'), shared = '\\\\nas\\fonts\\a.ttf', unrelated = '\\\\other\\share\\data.bin'
  const spawn = (_file, args, options) => {
    const inputPath = args[args.indexOf('--input') + 1], input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
    const job = { id: jobs.length + 1, args, input, inputPath, closed: false }
    job.release = path.join(dir, 'release-' + job.id); jobs.push(job)
    const result = args[0] === '--shared-file-io' ? { ok: true, operation: input.operation, value: { size: 100, mtimeMs: 1, isFile: true } } : { ok: true, outputPath: input.outputPath || 'local' }
    const code = `const fs=require('node:fs');const send=()=>process.stdout.write(${JSON.stringify(JSON.stringify(result))});${hold ? `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(job.release)})){clearInterval(timer);send()}},5);` : 'send();'}`
    const child = cp.spawn(process.execPath, ['-e', code], options)
    children.add(child); peak = Math.max(peak, children.size)
    child.once('close', () => { children.delete(child); job.closed = true })
    return child
  }
  // Deliberately deny staging. This test must never invent a read-only proof;
  // the separate owned-stage regression exercises ten proven native renders.
  const load = loader({
    [path.join(root, 'src/main/rust-core/ownedPreviewStageRuntime.ts')]: { createOwnedPreviewStageRuntime: () => ({ allocate: async () => null, provesReadOnly: () => false, proofForInput: () => undefined }) },
    electron: { app: {} }, 'node:child_process': { ...cp, spawn },
    [path.join(root, 'src/main/rust-core/rustCoreDaemonRuntime.ts')]: { createRustCoreDaemonRuntime: () => ({ tryRun: async () => { daemonCalls++; return { stdout: '{"ok":true}', stderr: '' } }, stopImmediately() {}, status() {}, pollStatus() {} }), isRustCoreDaemonSubmittedError: () => false },
  })
  const transport = load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ appendStartupLog: value => logs.push(value), enabled: false, required: false })
  const pool = load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(), run = pool.run
  pool.run = request => { requests.push(request); return run(request) }
  const client = load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({ ...transport, appendStartupLog() {}, diagnoseRustCoreWorker: async () => ({ available: true, path: process.execPath, capabilities: ['preview-render-image'] }) })
  const render = (outputPath, fontPath = shared) => tracked(client.runRustPreviewRenderImage({ fontPath, outputPath, text: 'text', fontSize: 32, width: 100, height: 50 }))
  const release = job => fsp.writeFile(job.release, 'go')
  const submit = (command, input, options = {}) => tracked((async () => {
    const file = transport.createTemporaryJsonFile('hfm-preview-admission'); await file.writeJson(input)
    try { return await transport.runRustCoreScheduledCommand(process.execPath, [command, '--input', file.path], { timeout: 5000, ...options }) }
    finally { await file.dispose() }
  })())
  const other = write => submit(write ? '--test-write' : '--shared-file-io', { operation: write ? 'writeFile' : 'stat', path: unrelated }, {
    sharedIo: { paths: [unrelated], write, accesses: [{ path: unrelated, mode: write ? 'write' : 'read', scope: 'file' }] },
  })
  const assertGlobal = request => {
    assert.equal(request.write, true); assert.equal(request.accesses, undefined)
    assert(request.roots.includes('configured-root:preview-output-unverified'), 'unknown output alias lost its global barrier')
    assert.equal(request.sharedReadOnlyPreview, false); assert.equal(request.lane, 'default')
  }
  try {
    // Ten requests settle serially. Keep only one follower queued at a time so
    // the unchanged three-second queue TTL measures contention, not ten slow
    // Windows Node startups added together by the diagnostic itself.
    let pending = render(path.join(dir, 'serial-0.png')); await until(() => jobs.length === 1)
    for (let index = 1; index < 10; index++) {
      const next = render(path.join(dir, `serial-${index}.png`)); await until(() => pool.status().queued === 1)
      assert.equal(jobs.length, index); assert.equal(pool.status().activeDefault, 1); assert.equal(pool.status().activePreviewRead, 0)
      assertGlobal(requests.at(-1)); await release(jobs[index - 1]); await pending
      await until(() => jobs.length === index + 1); pending = next
    }
    await release(jobs[9]); await pending; await pool.whenIdle(); assert.equal(peak, 1)
    assert(requests.filter(request => request.label === 'preview-render-image').every(request => request.write && !request.accesses))
    assert.equal(daemonCalls, 0, 'unproven preview entered the resident daemon')

    // A real junction and an ordinary local path are both unproven output
    // aliases. Neither spelling can authorize overlap with an unrelated share.
    const target = path.join(dir, 'junction-target'), junction = path.join(dir, 'junction-output')
    await fsp.mkdir(target); await fsp.symlink(target, junction, 'junction')
    assert((await fsp.lstat(junction)).isSymbolicLink())
    for (const output of [path.join(dir, 'local.png'), path.join(junction, 'display.png')]) {
      for (const write of [false, true]) for (const previewFirst of [false, true]) {
        const at = jobs.length, requestStart = requests.length
        const first = previewFirst ? render(output) : other(write)
        await until(() => jobs.length === at + 1)
        const second = previewFirst ? other(write) : render(output)
        await until(() => pool.status().queued === 1); await tick(30)
        assert.equal(jobs.length, at + 1, 'unknown local/junction output overlapped an unrelated share')
        assertGlobal(requests.slice(requestStart).find(request => request.label === 'preview-render-image'))
        await release(jobs[at]); await first; await until(() => jobs.length === at + 2)
        assert(jobs[at].closed, 'conflicting follower started before prior physical close')
        await release(jobs[at + 1]); await second; await pool.whenIdle()
      }
    }
    assert.equal(peak, 1, 'unknown-output counterexamples were not globally exclusive')

    // The queued unrelated writer is a barrier for later preview work.
    let at = jobs.length
    const first = render(path.join(junction, 'fairness.png')); await until(() => jobs.length === at + 1)
    const writer = other(true); await until(() => pool.status().queued === 1)
    const follower = render(path.join(dir, 'after-writer.png')); await until(() => pool.status().queued === 2)
    await release(jobs[at]); await first; await until(() => jobs.length === at + 2)
    assert.equal(jobs[at + 1].args[0], '--test-write'); await tick(30); assert.equal(jobs.length, at + 2, 'preview overtook queued writer')
    await release(jobs[at + 1]); await writer; await until(() => jobs.length === at + 3); await release(jobs[at + 2]); await follower

    // Fully represented remote output writes retain precise file exclusion.
    // Two different outputs overlap; freeing a slot does not let a same-output
    // follower through while its exact output remains owned by the first child.
    at = jobs.length
    const remotePath = '\\\\nas\\fonts\\out-one.png'
    const left = render(remotePath); await until(() => jobs.length === at + 1)
    const right = render('\\\\nas\\fonts\\out-two.png'); await until(() => jobs.length === at + 2)
    assert.equal(pool.status().activeDefault, 2); assert.equal(pool.status().activePreviewRead, 0)
    for (const request of requests.slice(-2)) {
      assert(!request.roots.includes('configured-root:preview-output-unverified')); assert(request.accesses.some(access => access.mode === 'write'))
    }
    const same = render(remotePath); await until(() => pool.status().queued === 1)
    await release(jobs[at + 1]); await right; await tick(30); assert.equal(jobs.length, at + 2, 'same remote output overlapped despite exact write footprint')
    await release(jobs[at]); await left; await until(() => jobs.length === at + 3); await release(jobs[at + 2]); await same
    assert.equal(peak, 2)

    // Exercise the actual source + shared filesystem + transport + process queue.
    const files = load('src/main/path/sharedFileSystemRuntime.ts')
    files.configureSharedFileExecutor(async request => ({ result: JSON.parse((await submit('--shared-file-io', request, { timeout: 500, sharedIo: { paths: [request.path], write: false } })).stdout) }))
    at = jobs.length
    const blocking = submit('--test-write', { path: shared }); await until(() => jobs.length === at + 1); hold = false
    const begin = Date.now(); let resolverCalls = 0
    const source = tracked(load('src/main/preview/runtime/previewSourceRuntime.ts').resolvePreviewSource(shared, async () => { resolverCalls++; throw Error('legacy resolver must not read shared files') }))
    await until(() => pool.status().queued === 1); await tick(650); assert.equal(jobs.length, at + 1); await release(jobs[at]); await blocking
    const result = await source; assert.equal(result.path, shared); assert.equal(result.stat.size, 100); assert.equal(resolverCalls, 0); assert(Date.now() - begin >= 650)
    assert(logs.filter(value => value.includes('shared io started:')).at(-1).includes('lane=preview-read'))
    const kind = load('src/shared/previewFailure.ts').previewFailureKind
    assert.equal(kind({ reason: 'queue-timeout' }), 'timeout'); assert.equal(kind({ reason: 'stopping' }), 'cancelled'); assert.equal(kind({ reason: 'queue-full' }), 'unavailable')

    // Queued abort does not spawn a child. Executing fallback cancellation and
    // timeout cannot settle to their caller before real close and input disposal.
    hold = true; at = jobs.length; const signal = new AbortController()
    const hung = submit('--test-write', { path: shared }, { timeout: 150 }).catch(error => error); await until(() => jobs.length === at + 1)
    const cancelled = submit('--shared-file-io', { operation: 'stat', path: shared }, { timeout: 500, signal: signal.signal, sharedIo: { paths: [shared], write: false } }).catch(error => error)
    await until(() => pool.status().queued === 1); signal.abort(); assert.equal((await cancelled).outcome, 'not-started'); assert.equal(jobs.length, at + 1)
    const timeout = await hung; assert.equal(timeout.reason, 'timeout'); assert.equal(timeout.outcome, 'unknown'); await timeout.closed; await pool.whenIdle()
    for (const reason of ['timeout', 'cancelled']) {
      at = jobs.length; const controller = new AbortController()
      const failed = submit('--preview-render-image', { fontPath: shared, outputPath: path.join(junction, reason + '.png') }, { timeout: reason === 'timeout' ? 150 : 5000, signal: controller.signal }).catch(error => error)
      await until(() => jobs.length === at + 1); if (reason === 'cancelled') controller.abort()
      const error = await failed; assert.equal(error.reason, reason); assert.equal(error.outcome, 'unknown')
      assert(jobs[at].closed, 'fallback error escaped before physical close')
      assert(!fs.existsSync(jobs[at].inputPath), 'fallback error retained its settled input file')
      await error.closed; await pool.whenIdle(); assert.equal(pool.status().activeDefault, 0)
    }
    // Both conservative local writes and precise remote writes reject a success
    // receipt after their original font source generation is invalidated.
    const availability = load('src/main/path/startupPathAvailabilityRuntime.ts')
    const routing = load('src/main/rust-core/rustSharedIoCommandRuntime.ts')
    for (const [index, output] of [path.join(junction, 'stale.png'), '\\\\nas\\fonts\\stale.png'].entries()) {
      at = jobs.length; const fontPath = `\\\\stale-${index}\\fonts\\a.ttf`
      const stale = render(output, fontPath).catch(error => error); await until(() => jobs.length === at + 1)
      availability.markStartupPathRootUnavailable(routing.sharedIoAvailabilityRoot(fontPath), Error('fixture source changed'))
      await release(jobs[at]); const error = await stale
      assert.equal(error.reason, 'stale-generation'); assert(jobs[at].closed); assert(!fs.existsSync(jobs[at].inputPath)); assert.equal(jobs.length, at + 1, 'stale result triggered a replay')
    }
    for (const [code, expected] of [['ENOENT', 'missing'], ['EACCES', 'unavailable']]) {
      files.configureSharedFileExecutor(async request => ({ result: { ok: false, operation: request.operation, code, message: code } }))
      await assert.rejects(load('src/main/preview/runtime/previewSourceRuntime.ts').resolvePreviewSource(shared, async () => { throw Error('legacy bypass') }), error => error.message.includes('[HFM_PREVIEW:' + expected + ']'))
    }
    const invalid = await pool.run({ file: process.execPath, args: [], roots: ['a'], timeoutMs: 500, write: true, lane: 'preview-read' }).catch(error => error)
    assert.equal(invalid.reason, 'invalid-lane'); assert.equal(daemonCalls, 0)
    assert.equal(pool.status().metrics.started, pool.status().metrics.closed)
    console.log('shared preview fallback: global unknown-output serialization; local/junction vs unrelated read/write in both directions; writer fairness; precise remote overlap/exclusion; source wait; stale receipts; cancellation/timeout physical close')
  } finally {
    transport.stopRustCoreDaemon(); for (const child of children) child.kill('SIGKILL'); await pool.whenIdle(); await fsp.rm(dir, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
