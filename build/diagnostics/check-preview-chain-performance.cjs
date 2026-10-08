#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
async function checkPreviewTransportLifecycle() {
  const filename = path.join(__dirname, 'lib/preview-chain-performance-runtime.cjs')
  const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
  const loadHelper = text => {
    const module = { exports: {} }, requireLocal = require('node:module').createRequire(filename)
    require('node:vm').runInNewContext('(function(require,module,exports){' + text + '\n})', { process, setTimeout, clearTimeout, console })(requireLocal, module, module.exports)
    return module.exports
  }
  async function exercise(helper) {
    function fakeFixture({ duplicateDaemon = false, nativeBusy, withholdStatus = false, finishingShutdown = false, wrongTerminalError = false } = {}) {
      const daemon = { spawnargs: ['C:/fixture-worker.exe', '--core-daemon'] }, children = new Set([daemon]), tasks = new Set()
      const observer = { children, counts: { processes: 1 } }
      if (duplicateDaemon) children.add({ spawnargs: [...daemon.spawnargs] })
      let closed = false, stopped = false, stops = 0, nativeDispatches = 0, polls = 0
      const idleState = () => ({ queued: 0, running: null, queuedJobs: [], lanes: [{ lane: 'preview', queued: 0, running: 0 }], writeBarrier: { queuedWrites: 0, runningWrites: 0 } })
      let releasedNative = false, rustState = idleState()
      const pool = { status: () => ({ closed }), whenIdle: async () => { while (tasks.size) await Promise.allSettled([...tasks]) } }
      const assertLocalShutdownWorkAllowed = () => { if (finishingShutdown) throw Error('fixture shutdown cleanup finished') }
      const transport = {
        rustCoreWorkerStatus: () => ({ path: 'C:/fixture-worker.exe' }),
        rustCoreDaemonStatus: () => {
          polls++
          const status = { pending: tasks.size, running: !stopped, rustState }
          Promise.resolve().then(() => {
            if (withholdStatus && !releasedNative) return
            rustState = { ...idleState(), ...(!releasedNative ? nativeBusy : {}) }
          })
          return status
        },
        stopRustCoreDaemon() { stops++; stopped = true; closed = true; Promise.resolve().then(() => children.delete(daemon)) },
        runRustCoreScheduledCommand: () => {
          if (stopped && wrongTerminalError) return Promise.reject(Error('unrelated terminal failure'))
          try { assertLocalShutdownWorkAllowed() } catch (error) { return Promise.reject(error) }
          if (stopped) return Promise.reject(Object.assign(Error('fixture transport stopped'), { reason: 'stopping', outcome: 'not-started' }))
          assert.equal(closed, false, 'borrowed pool was stopped')
          nativeDispatches++; observer.counts.processes++
          const child = { spawnargs: ['fixture-worker', '--preview-render-image'] }; children.add(child)
          const task = Promise.resolve().then(() => { children.delete(child); return { stdout: '{"ok":true}', stderr: '' } })
          tasks.add(task); void task.finally(() => tasks.delete(task))
          return task
        },
      }
      const load = name => {
        if (name.endsWith('rustCoreWorkerTransportRuntime.ts')) return { createRustCoreWorkerTransportRuntime: () => transport }
        if (name.endsWith('sharedIoProcessRuntime.ts')) return { applicationSharedIoProcessRuntime: () => pool }
        if (name.endsWith('shutdownCoordinatorRuntime.ts')) return { assertLocalShutdownWorkAllowed }
        throw Error('unexpected lifecycle dependency: ' + name)
      }
      return { load, observer, pool, stops: () => stops, nativeDispatches: () => nativeDispatches, polls: () => polls, releaseNative: () => { releasedNative = true } }
    }
    const fixture = fakeFixture(), owner = helper.createControlledPreviewTransportOwner({ ...fixture, appendLog() {} })
    let closedDatabases = 0
    for (const phase of ['list-cold', 'list-hot', 'grid-cold', 'grid-hot']) {
      if (phase.endsWith('cold')) await owner.transport.runRustCoreScheduledCommand('fixture-worker', ['--preview-render-image'], {})
      const close = helper.createPreviewPhaseCloser({ transportOwner: owner, borrowed: true, closeDatabases: () => { closedDatabases += 2 } })
      await Promise.all([close(), close()])
      owner.assertOpen(); assert.equal(fixture.stops(), 0)
      assert.equal(fixture.observer.children.size, 1, 'idle app-owned daemon was reaped at phase close')
    }
    assert.equal(fixture.nativeDispatches(), 2, 'grid cold did not submit fresh work after list closes')
    assert.equal(closedDatabases, 8, 'phase databases were not closed exactly once')
    assert(fixture.polls() >= 8, 'phase close did not await fresh native daemon state')
    await Promise.all([owner.close(), owner.close()])
    assert.equal(fixture.stops(), 1); assert.equal(fixture.pool.status().closed, true); assert.equal(fixture.observer.children.size, 0)
    // Recovery-chain keeps the default single-runtime ownership and terminal close.
    const single = fakeFixture(), singleOwner = helper.createControlledPreviewTransportOwner({ ...single, appendLog() {} })
    const close = helper.createPreviewPhaseCloser({ transportOwner: singleOwner, borrowed: false, closeDatabases() {} })
    await Promise.all([close(), close()]); assert.equal(single.stops(), 1); assert.equal(single.observer.children.size, 0)
    const finished = fakeFixture({ finishingShutdown: true }), finishedOwner = helper.createControlledPreviewTransportOwner({ ...finished, appendLog() {} })
    const closeFinished = helper.createPreviewPhaseCloser({ transportOwner: finishedOwner, borrowed: false, closeDatabases() {} })
    await assert.doesNotReject(closeFinished(), 'finished shutdown must retain exact terminal refusal proof')
    assert.equal(finished.stops(), 1); assert.equal(finished.pool.status().closed, true); assert.equal(finished.observer.children.size, 0); assert.equal(finished.nativeDispatches(), 0)
    for (const finishingShutdown of [false, true]) {
      const wrong = fakeFixture({ finishingShutdown, wrongTerminalError: true }), wrongOwner = helper.createControlledPreviewTransportOwner({ ...wrong, appendLog() {} })
      await assert.rejects(wrongOwner.close(), error => error.code === 'ERR_ASSERTION', 'unrelated terminal error was accepted as shutdown proof')
      assert.equal(wrong.stops(), 1); assert.equal(wrong.observer.children.size, 0); assert.equal(wrong.nativeDispatches(), 0)
    }
    // JS pending is already zero in these cases. A stale status or any native
    // queue/lane/write-barrier evidence must still prevent phase settlement.
    for (const options of [{ withholdStatus: true },
      { nativeBusy: { queued: 1, queuedJobs: [{ id: 'held' }] } },
      { nativeBusy: { running: [{ id: 'held' }] } },
      { nativeBusy: { lanes: [{ lane: 'preview', queued: 0, running: 1 }] } },
      { nativeBusy: { writeBarrier: { queuedWrites: 1, runningWrites: 0 } } },
      { nativeBusy: { writeBarrier: { queuedWrites: 0, runningWrites: 1 } } }]) {
      const busy = fakeFixture(options), busyOwner = helper.createControlledPreviewTransportOwner({ ...busy, appendLog() {} })
      let settled = false
      const draining = busyOwner.drain().then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 25))
      assert.equal(settled, false, 'phase close accepted stale or busy native status with JS pending zero')
      busy.releaseNative(); await draining; await busyOwner.close()
    }
    const duplicate = fakeFixture({ duplicateDaemon: true }), duplicateOwner = helper.createControlledPreviewTransportOwner({ ...duplicate, appendLog() {} })
    await assert.rejects(duplicateOwner.drain(), /multiple selected-worker daemons/)
  }
  assert(source.includes('close: createPreviewPhaseCloser({ transportOwner, borrowed: borrowedTransport'), 'phase lifecycle helper is not wired to the actual runtime')
  await exercise(loadHelper(source))
  const anchor = 'if (!borrowed) await transportOwner.close()'
  assert(source.includes(anchor), 'per-phase-stop mutant anchor missing')
  await assert.rejects(exercise(loadHelper(source.replace(anchor, 'if (true) await transportOwner.close()'))), /cache phase terminally stopped/, 'per-phase terminal-stop regression was accepted')
  const shutdownAnchor = 'error => shutdownBlocker'
  assert.equal(source.split(shutdownAnchor).length, 2, 'shutdown-order mutant anchor drifted')
  await assert.rejects(exercise(loadHelper(source.replace(shutdownAnchor, 'error => false'))), /finished shutdown must retain exact terminal refusal proof/, 'finished-shutdown rejection-order mutant was accepted')
  console.log('[preview transport lifecycle] borrowed cache resets, fresh grid work, idle daemon ownership, self-owned recovery close, one terminal stop, finished-shutdown refusal, wrong-error negatives and rejected lifecycle mutants')
}
async function checkManualPreviewHostIntent() {
  const filename = path.join(__dirname, 'lib/preview-chain-performance-runtime.cjs')
  const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n'), ts = require('typescript')
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const callbacks = []
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'runRustPreviewRenderImage') callbacks.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(callbacks.length, 1, 'manual native adapter callback is missing or ambiguous')
  assert(ts.isArrowFunction(callbacks[0]), 'manual native adapter shape changed')
  const callback = callbacks[0].getText(parsed)
  async function exercise(text) {
    for (const intent of [true, false, undefined]) for (const nativeFailure of [false, true]) {
      const request = { fontPath: 'C:/fonts/file.ttf', outputPath: 'C:/preview/image.png', text: 'sample', fontSize: 42, width: 240, height: 84,
        preferSystemFont: false, systemFontFamilyCandidates: ['Fixture'], layout: { version: 'grid-v1', canvasWidth: 240, canvasHeight: 84 },
        ...(intent === undefined ? {} : { foregroundBytes: intent }) }
      const before = JSON.parse(JSON.stringify(request)), expected = { ...before }; delete expected.foregroundBytes
      const writes = [], removed = [], commands = [], sourceRoot = 'C:/selected-source'
      const fakeFs = { writeFileSync(file, bytes) { writes.push({ file, input: JSON.parse(bytes) }) }, unlinkSync(file) { removed.push(file) } }
      const execute = async (file, args, options) => {
        commands.push({ file, args, options })
        assert.equal(Object.hasOwn(writes[0].input, 'foregroundBytes'), false, 'transport-only intent leaked to native input')
        assert.deepEqual(writes[0].input, expected, 'manual adapter changed a native field')
        if (nativeFailure) throw Error('injected manual native failure')
        return { stdout: '{"ok":true}', stderr: '' }
      }
      // Exercise the actual callback body without invoking SQLite, Electron or
      // a native process. Only its host ports are controlled by this regression.
      const adapter = new Function('fs', 'path', 'execFile', 'root', `let native=0; const render=(${text}); return {render,native:()=>native}`)(fakeFs, path, execute, sourceRoot)
      if (nativeFailure) await assert.rejects(adapter.render(request), /injected manual native failure/)
      else assert.deepEqual(await adapter.render(request), { ok: true, engine: 'rust-directwrite', outputPath: request.outputPath })
      assert.deepEqual(request, before, 'manual adapter mutated its caller input')
      assert.equal(adapter.native(), 1); assert.equal(writes.length, 1)
      const input = request.outputPath + '.native.json'
      assert.equal(writes[0].file, input)
      assert.deepEqual(commands, [{ file: path.join(sourceRoot, 'native-src/hfm-core-worker/target/release/hfm-core-worker.exe'), args: ['--preview-render-image', '--input', input], options: { timeout: 15000 } }])
      assert.deepEqual(removed, [input], 'manual adapter did not preserve input cleanup')
    }
  }
  await exercise(callback)
  const anchor = 'JSON.stringify(nativeInput)'
  assert.equal(callback.split(anchor).length, 2, 'manual intent-stripping mutant anchor drifted')
  await assert.rejects(exercise(callback.replace(anchor, 'JSON.stringify(request)')), /transport-only intent leaked/, 'serialize-original-request mutant was accepted')
  console.log('[manual preview adapter] true/false/absent host intent stripped; native fields, file output, cleanup and deadline preserved; original-request mutant rejected')
}

function checkRecoverySessionOwnership() {
  const filename = path.join(__dirname, 'lib/recovery-chain-electron.cjs'), source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
  const loadHelper = text => {
    const module = { exports: {} }, requireLocal = require('node:module').createRequire(filename)
    new Function('require', 'module', 'exports', text)(requireLocal, module, module.exports)
    return module.exports
  }
  function exercise(helper) {
    const target = [], collector = helper.createRecoverySessionLogCollector(target)
    const make = name => {
      const logs = [], chain = { runtime: { query: () => name + ':query' }, appendLog: line => logs.push(line) }
      const preview = { runtime: { render: () => name + ':preview' } }
      collector.retain(logs)
      return { chain, preview, logs, ports: helper.createRecoverySessionPorts(chain, preview) }
    }
    const event = value => ({ kind: 'operation-chain', details: { event: value } })
    const old = make('old'); let activeChain = old.chain, activePreview = old.preview
    assert.deepEqual(old.ports.runtime.reportPerformanceEvent(event('old-before-close')), { ok: true })
    collector.flush(); assert.deepEqual(target, ['operation-chain: old-before-close'], 'session trace ownership changed')
    activeChain = undefined; activePreview = undefined
    old.ports.runtime.reportPerformanceEvent(event('old-no-window'))
    assert.equal(old.ports.runtime.render(), 'old:preview')
    const current = make('new'); activeChain = current.chain; activePreview = current.preview
    current.ports.runtime.reportPerformanceEvent(event('new-active'))
    old.ports.runtime.reportPerformanceEvent(event('old-after-reopen'))
    old.ports.appendLog('renderer: old late error')
    assert.equal(old.ports.runtime.query(), 'old:query'); assert.equal(old.ports.runtime.render(), 'old:preview')
    assert.equal(current.ports.runtime.query(), 'new:query'); assert.equal(current.ports.runtime.render(), 'new:preview')
    assert.equal(activeChain, current.chain); assert.equal(activePreview, current.preview)
    collector.flush(); collector.retain(old.logs); collector.flush()
    assert.deepEqual(target, ['operation-chain: old-before-close', 'operation-chain: old-no-window', 'operation-chain: old-after-reopen', 'renderer: old late error', 'operation-chain: new-active'], 'retained session traces changed or duplicated')
    old.ports.appendLog('renderer: old after first teardown flush'); current.ports.appendLog('renderer: new late error')
    collector.flush(); collector.flush()
    assert.deepEqual(target.slice(-2), ['renderer: old after first teardown flush', 'renderer: new late error'])
    assert.equal(target.length, 7, 'late session log collection lost or duplicated entries')
    const loggerFailure = Error('logger must propagate'), previewFailure = Error('preview must propagate')
    const broken = helper.createRecoverySessionPorts({ runtime: {}, appendLog() { throw loggerFailure } }, { runtime: { render() { throw previewFailure } } })
    assert.throws(() => broken.runtime.reportPerformanceEvent(event('failure')), error => error === loggerFailure)
    assert.throws(() => broken.runtime.render(), error => error === previewFailure)
    assert.throws(() => old.ports.runtime.missing(), /unexpected production port missing/)
  }
  assert(source.includes('createRecoverySessionPorts(sessionChain,sessionPreview)') && source.includes('sessionLogs.retain(sessionChain.logs)'), 'actual recovery session is not wired to captured owners and retained logs')
  exercise(loadHelper(source))
  for (const [label, before, after] of [
    ['dropped late trace', 'const appendLog=value=>sessionChain.appendLog(value)', 'const appendLog=value=>undefined'],
    ['repeated session copy', 'target.push(...logs.slice(offset))', 'target.push(...logs)'],
  ]) {
    assert.equal(source.split(before).length, 2, label + ' mutant anchor drifted')
    assert.throws(() => exercise(loadHelper(source.replace(before, after))), /session trace ownership changed|retained session traces changed or duplicated/, label + ' mutant was accepted')
  }
  console.log('[recovery session ownership] no-window/reopen callbacks retain old owners; late traces/errors collected once; callback errors and causal mutants preserved')
}

async function run() {
  assert.equal(process.platform, 'win32', 'actual preview chain requires Windows')
  await checkPreviewTransportLifecycle()
  await checkManualPreviewHostIntent()
  checkRecoverySessionOwnership()
  if (process.argv.includes('--lifecycle')) return
  if (process.argv.includes('--recovery-chain')) return runRecoveryChain()
  if (process.argv.includes('--work-comparison')) return require('./lib/operation-work-performance-runner.cjs').run()
  const directory = path.join(root, 'artifacts/list-preview/chain'), html = path.join(directory, 'index.html'), preload = path.join(directory, 'preload.cjs')
  fs.mkdirSync(directory, { recursive: true })
  await require('esbuild').build({ entryPoints: [path.join(__dirname, 'lib/preview-chain-performance-dom.ts')], bundle: true,
    outfile: path.join(directory, 'renderer.js'), platform: 'browser', format: 'iife', define: { 'import.meta.env': '{}' }, tsconfig: path.join(root, 'tsconfig.json') })
  fs.writeFileSync(html, '<!doctype html><html><meta charset="utf-8"><body><script src="renderer.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = cp.spawnSync(require('electron'), [path.join(__dirname, 'lib/preview-chain-performance-electron.cjs'), directory, html, preload], { cwd: root, env, stdio: 'inherit', timeout: 150000 })
  assert.equal(result.status, 0, String(result.error || 'preview chain failed'))
}
async function runRecoveryChain() {
  const directory=path.join(root,'artifacts/list-preview/recovery-chain'),html=path.join(directory,'index.html'),preload=path.join(directory,'preload.cjs')
  fs.mkdirSync(directory,{recursive:true})
  const {selectFonts,hash}=require('./lib/operation-work-performance.cjs')
  const workerPath=path.join(root,'native-src/hfm-core-worker/target/release/hfm-core-worker.exe')
  const config={mode:'recovery-chain',sourceRoot:root,sourceSha:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fixtureDirectory:path.join(directory,'fixture'),manifest:selectFonts(directory),workerPath,workerSha256:hash(fs.readFileSync(workerPath))}
  const configPath=path.join(directory,'config.json');fs.writeFileSync(configPath,JSON.stringify(config))
  await require('esbuild').build({entryPoints:[path.join(__dirname,'lib/recovery-chain-dom.tsx')],bundle:true,outfile:path.join(directory,'renderer.js'),platform:'browser',format:'iife',define:{'import.meta.env':'{}'},tsconfig:path.join(root,'tsconfig.json')})
  const css=require('./lib/font-view-layout-harness.cjs').css()
  fs.writeFileSync(html,'<!doctype html><html data-theme="light"><meta charset="utf-8"><style>'+css+' body{display:block;overflow:auto;padding:16px}main{width:100%;display:block}.f14-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.f14-list{display:block}.context-menu{position:fixed;z-index:9999}dialog{background:white}</style><body><script src="renderer.js"></script></body></html>')
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const result=cp.spawnSync(require('electron'),[path.join(__dirname,'lib/preview-chain-performance-electron.cjs'),directory,html,preload,configPath],{cwd:root,env,stdio:'inherit',timeout:210000})
  assert.equal(result.status,0,String(result.error||'recovery chain failed'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'report.json'),'utf8')).passed,true)
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { run, checkPreviewTransportLifecycle }
