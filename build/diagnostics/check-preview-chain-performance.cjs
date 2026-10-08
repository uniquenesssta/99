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
    function fakeFixture({ duplicateDaemon = false, nativeBusy, withholdStatus = false } = {}) {
      const daemon = { spawnargs: ['C:/fixture-worker.exe', '--core-daemon'] }, children = new Set([daemon]), tasks = new Set()
      const observer = { children, counts: { processes: 1 } }
      if (duplicateDaemon) children.add({ spawnargs: [...daemon.spawnargs] })
      let closed = false, stopped = false, stops = 0, nativeDispatches = 0, polls = 0
      const idleState = () => ({ queued: 0, running: null, queuedJobs: [], lanes: [{ lane: 'preview', queued: 0, running: 0 }], writeBarrier: { queuedWrites: 0, runningWrites: 0 } })
      let releasedNative = false, rustState = idleState()
      const pool = { status: () => ({ closed }), whenIdle: async () => { while (tasks.size) await Promise.allSettled([...tasks]) } }
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
          if (stopped) return Promise.reject(Object.assign(Error('fixture transport stopped'), { reason: 'stopping' }))
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
  console.log('[preview transport lifecycle] borrowed cache resets, fresh grid work, idle daemon ownership, self-owned recovery close, one terminal stop and rejected per-phase-stop mutant')
}
async function run() {
  assert.equal(process.platform, 'win32', 'actual preview chain requires Windows')
  await checkPreviewTransportLifecycle()
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
