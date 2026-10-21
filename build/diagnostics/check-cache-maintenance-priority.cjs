#!/usr/bin/env node
'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { loader } = require('./check-operation-chain.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function maintenanceOwnership() {
  const load = loader()
  const maintenance = load('src/main/maintenance/cacheMaintenanceCoordinator.ts')
  const io = load('src/main/path/sharedFileSystemRuntime.ts')
  const physical = gate(), entered = gate(), events = []
  maintenance.registerCacheMaintenanceParticipant({ pause: async () => { events.push('cancel'); await physical.promise; events.push('closed') }, resume: () => { events.push('resume') } })
  const first = maintenance.runCacheMaintenance(async () => {
    entered.resolve()
    assert(maintenance.ownsCacheMaintenance())
    assert.equal(io.currentSharedIoPriority(), maintenance.CACHE_MAINTENANCE_PRIORITY)
    await io.withSharedIoPriority('background', async () => assert.equal(io.currentSharedIoPriority(), maintenance.CACHE_MAINTENANCE_PRIORITY))
    return maintenance.runCacheMaintenance(async () => { events.push('rebuild'); return 7 })
  })
  assert(maintenance.cacheMaintenancePending(), 'admission was not raised synchronously')
  await tick(); assert.deepEqual(events, ['cancel'], 'cleanup started before physical close')
  physical.resolve(); await entered.promise
  assert.equal(await first, 7)
  assert.deepEqual(events, ['cancel', 'closed', 'rebuild', 'resume'])
  assert(!maintenance.cacheMaintenancePending()); assert(!maintenance.ownsCacheMaintenance())
  const action = gate(), order = []
  const one = maintenance.runCacheMaintenance(async () => { order.push(1); await action.promise; throw Error('controlled failure') })
  one.catch(() => {})
  const two = maintenance.runCacheMaintenance(async () => { order.push(2) })
  await tick(); assert.deepEqual(order, [1]); action.resolve()
  await assert.rejects(one, /controlled failure/); await two
  assert.deepEqual(order, [1, 2]); assert(!maintenance.cacheMaintenancePending())
}

async function scanRetirement() {
  const load = loader({}, { setInterval, clearInterval })
  const maintenance = load('src/main/maintenance/cacheMaintenanceCoordinator.ts')
  const gateScan = gate(), entered = gate()
  let signal, runs = 0
  const result = { folders: [], fonts: [], errors: [], stats: { cancelled: false } }
  const scan = load('src/main/indexing/scan-orchestrator/fontScanActiveJobRuntime.ts').createFontScanActiveJobRuntime({
    appendStartupLog() {}, emitFontIndexProgress() {}, recheckGlobalIoQueues() {}, globalIoSnapshot: () => ({}),
  }, async (_folders, _known, options) => { runs++; signal = options.signal; entered.resolve(); await gateScan.promise; return result })
  const old = scan.scanFoldersManaged(['C:\\fonts']); await entered.promise
  let cleared = false
  const clear = maintenance.runCacheMaintenance(async () => { cleared = true; assert(signal.aborted); return scan.scanFoldersManaged(['C:\\fonts']) })
  await tick(); assert(signal.aborted); assert(!cleared)
  await assert.rejects(scan.scanFoldersWhenIdle(['C:\\fonts']), /source-recovery-deferred/)
  assert((await scan.scanFoldersManaged(['C:\\fonts'])).stats.cancelled)
  assert.equal(runs, 1)
  gateScan.resolve(); assert((await old).stats.cancelled); await clear
  assert(cleared); assert.equal(runs, 2, 'maintenance owner could not start replacement scan')
}

async function schedulerPriority() {
  const children = []
  const load = loader({ 'node:child_process': { spawn: () => {
    const child = new EventEmitter(); child.pid = children.length + 1
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.stdout.setEncoding = child.stderr.setEncoding = () => {}
    child.kill = () => true
    children.push(child); return child
  } } })
  const pool = load('src/main/path/sharedIoProcessRuntime.ts').createSharedIoProcessRuntime(() => {})
  const run = priority => pool.run({ file: 'fixture', args: [], roots: ['same-root'], write: true, priority, timeoutMs: 5000, queueTimeoutMs: 5000 })
  try {
    const first = run('normal'), queued = run('background'), urgent = run(1000)
    assert.equal(children.length, 1, 'maintenance bypassed active write')
    children[0].emit('close', 0, null); await first; await tick()
    let normalFinished = false; queued.then(() => { normalFinished = true })
    assert.equal(children.length, 2)
    children[1].emit('close', 0, null); await urgent
    assert(!normalFinished, 'queued writer ran before maintenance')
    await tick(); children[2].emit('close', 0, null); await queued
  } finally { pool.stop(); for (const child of children) child.emit('close', 0, null); await pool.whenIdle() }
}

async function main() {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  await maintenanceOwnership(); await scanRetirement(); await schedulerPriority()
  console.log('PASS cache maintenance: physical drain, atomic nested rebuild, scan exclusion, failure recovery, queued priority and active write barrier')
}
const watchdog = setTimeout(() => { console.error('cache maintenance diagnostic timed out'); process.exit(1) }, 20000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(watchdog))
