#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, entry, root, bootstrap } = require('./helpers/mainCompositionHarness.cjs')
const { observeOperations, observeLifecycle } = require('./helpers/mainOperationsHarness.cjs')
const fixture = require('./fixtures/main-operations-composition.fixture.json')
const expectedOperations = structuredClone(fixture.operations)
for (const name of ['managedScan','backgroundScan']) expectedOperations[name].result.committedFolders = [...expectedOperations[name].result.folders]
// Reviewed recovery wiring adds explicit resume before user scans, and captures
// the active roots before cancellation so automatic recovery stays paused.
// Keep all historical operation calls and their order; only insert these ports.
for (const name of ['managedScan', 'failedScan']) {
  assert.equal(expectedOperations[name].calls[0][0], 'createScanOrchestrator.scanFoldersManaged')
  expectedOperations[name].calls.unshift(['createRootIndexSourceRecoveryRuntime.resume', [['/fonts']]])
}
assert.equal(expectedOperations.cancelScan.result, true, 'historical cancel fixture changed')
// The old mock returned a boolean despite the domain's {cancelled,message} contract.
expectedOperations.cancelScan.result = { cancelled: true, message: 'user cancelled' }
expectedOperations.cancelScan.calls.unshift(['createScanOrchestrator.activeFontScanStatus', []])
expectedOperations.cancelScan.calls.push(
  ['createRootIndexSourceRecoveryRuntime.pause', [['/fonts']]],
  ['createRootIndexSourceRecoveryRuntime.pauseActive', []],
)
// The new probe owner starts after the existing cache initialization. Preserve
// every historical operation/shutdown receipt and migrate only this addition.
const expectedStartup = structuredClone(fixture.startup)
const cacheInit = expectedStartup.calls.findIndex(call => call[0] === 'createCacheArchitectureRuntime.initializeCacheArchitectureV2')
assert(cacheInit >= 0)
assert(!expectedStartup.calls.some(call => call[0] === 'createSharedAvailabilityProbeScheduler.start'))
expectedStartup.calls.splice(cacheInit + 1, 0, ['createSharedAvailabilityProbeScheduler.start', []])
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const compositionFile = owner => path.join(bootstrap, `main${owner}CompositionRuntime.ts`)

async function checkBindings() {
  const source = read(entry)
  const boundary = source.indexOf('feedback.bindOperations(operationsComposition.feedback);')
  assert(boundary > 0, 'explicit Operations binding disappeared')
  const h = createHarness(new Map([[entry, source.slice(0, boundary)]]))
  h.load(entry)
  assert.equal(h.payload, null, 'application registered before binding')
  assert.equal(h.timers.length, 0, 'a factory scheduled work before binding')
  const feedback = h.compositions.get('createMainCompositionFeedback')
  const ops = h.compositions.get('createMainOperationsCompositionRuntime')
  for (const action of [
    () => feedback.assertReady(),
    () => ops.startStartupTasks(),
    () => ops.lifecycle.startBackgroundTaskScheduler(),
    () => ops.lifecycle.runStartupDatabaseMaintenance(),
    () => ops.capabilities.runBackgroundTaskSchedulerOnce(),
    () => ops.capabilities.scanFoldersManaged([], []),
    () => ops.capabilities.startWatchingFolders([]),
    () => ops.capabilities.startInstallStatusRefreshIndex({}),
    () => ops.capabilities.refreshWatchedFolder('/fonts', '/fonts'),
    () => ops.capabilities.refreshInstallStatusIndex({}),
    () => ops.capabilities.runDatabaseMaintenance({}),
    () => feedback.tasks.startBackgroundTask('fixture'),
  ]) {
    h.reset()
    await assert.rejects(Promise.resolve().then(action), /not bound/)
    assert.deepEqual(h.calls, [], 'unbound start reached a domain port')
  }
  feedback.bindOperations(ops.feedback)
  feedback.assertReady()
  for (const [method, value] of [
    ['bindOperations', ops.feedback], ['bindData', {}], ['bindMutation', {}], ['bindTags', {}],
  ]) assert.throws(() => feedback[method](value), /already bound/)
  ops.startStartupTasks()
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].ms, 1500)
  assert.throws(() => ops.startStartupTasks(), /already scheduled/)
  assert.equal(h.timers.length, 1, 'startup scheduling duplicated its timer')
  const scan = h.options('createFolderWatcherRuntime')
  const maintenance = h.options('createApplicationDatabaseMaintenanceRuntime')
  const taskClose = ops.resources.closeTasksDb
  assert.equal(maintenance.closeTasksDb, taskClose, 'maintenance copied task ownership')
  h.reset()
  scan.closeRuntimeDatabases()
  assert.deepEqual(h.calls.map(call => call[0]), [
    'createPreviewDbRuntime.closePreviewDb', 'createMainBackgroundRuntime.closeTasksDb',
  ])
  const partial = createHarness().load(path.join(bootstrap, 'mainCompositionFeedback.ts')).createMainCompositionFeedback()
  partial.bindOperations(ops.feedback)
  h.reset()
  assert.throws(() => partial.tasks.startBackgroundTask('fixture'), /not bound: Data/)
  assert.deepEqual(h.calls, [], 'binding Operations alone enabled task execution')
}

async function checkBaseline(overrides = new Map()) {
  assert.deepEqual(await observeOperations(overrides), expectedOperations)
  for (const scenario of Object.keys(fixture.shutdown)) {
    const actual = await observeLifecycle(scenario, overrides)
    assert.deepEqual(actual.startup, expectedStartup, `${scenario}: startup order changed`)
    assert.deepEqual(actual.shutdown, fixture.shutdown[scenario], `${scenario}: shutdown behavior changed`)
    assert.deepEqual(actual.events, fixture.events)
    assert.deepEqual(actual.processEvents, fixture.processEvents)
  }
}

async function checkMutations() {
  const lifecycle = path.join(root, 'src/main/app/mainProcessLifecycleRuntime.ts')
  const mutants = [
    ['missing binding', entry, 'feedback.bindOperations(operationsComposition.feedback);', ''],
    ['lost count invalidation', compositionFile('DataQuery'), 'if (cancelInFlight) sharedTagMetrics.invalidate();', ''],
    ['lost tag query invalidation', compositionFile('DataQuery'), 'tagFonts?.invalidate(cancelInFlight);', ''],
    ['lost index sync', compositionFile('Scan'), 'await syncMergedIndexForRootSnapshot(root, "scan-finished");', ''],
    ['lost watcher notification', compositionFile('Scan'), 'folderWatcherRuntime.sendFontIndexChanged(payload);', ''],
    ['lost activation flush', lifecycle, 'await flushActivationInstallStatusSave("before-quit");', ''],
    ['lost pending deletion flush', lifecycle, 'await flushPendingTemporaryFontDeletes("quit")', '({ remaining: 0 })'],
    ['lost shutdown outcome', lifecycle, 'markCleanShutdownSync(outcome);', 'markCleanShutdownSync();'],
    ['lost quit-abort resume', lifecycle, 'if (startupBackgroundTasksEnabled) startBackgroundTaskScheduler();', ''],
  ]
  for (const [name, file, before, after] of mutants) {
    const source = read(file)
    assert.equal(source.split(before).length, 2, `${name}: mutation anchor drifted`)
    const overrides = new Map([[file, source.replace(before, after)]])
    await assert.rejects(async () => {
      if (file === lifecycle) {
        const scenario = name === 'lost quit-abort resume' ? 'flush-return' : 'normal'
        const actual = await observeLifecycle(scenario, overrides)
        assert.deepEqual(actual.shutdown, fixture.shutdown[scenario])
      } else assert.deepEqual(await observeOperations(overrides), expectedOperations)
    }, undefined, `${name} was not detected`)
  }
  return mutants.length
}
async function checkRecoveryWiringMutations() {
  const file = compositionFile('Scan'), source = read(file)
  for (const [anchor, operation, flows] of [
    ['sourceRecovery.resume(folders);', 'resume', ['managedScan', 'failedScan']],
    ['sourceRecovery.pause(folders);', 'pause', ['cancelScan']],
    ['sourceRecovery.pauseActive();', 'pauseActive', ['cancelScan']],
  ]) {
    const name = `createRootIndexSourceRecoveryRuntime.${operation}`
    assert.equal(source.split(anchor).length - 1, 1, `${name}: mutation anchor drifted`)
    // Let loader/runtime failures escape. The mutant must complete and differ
    // only by the intended private call, never count a TypeError as detection.
    const actual = await observeOperations(new Map([[file, source.replace(anchor, '')]]))
    const withoutPort = structuredClone(expectedOperations)
    for (const flow of flows) {
      assert.equal(withoutPort[flow].calls.filter(call => call[0] === name).length, 1, `${name}: reviewed receipt missing`)
      withoutPort[flow].calls = withoutPort[flow].calls.filter(call => call[0] !== name)
    }
    assert.deepEqual(actual, withoutPort, `${name}: mutation affected unrelated behavior`)
    const label = `RECOVERY_WIRING_MISSING_${operation}`
    assert.throws(() => assert.deepEqual(actual, expectedOperations, label),
      error => error instanceof assert.AssertionError && error.message.includes(label),
      `${name}: missing private call was not detected`)
  }
}
function checkIdleCancellation() {
  const h = createHarness(); h.load(entry); h.scanActive = false; h.reset()
  const result = h.payload.cancelActiveFontScan('nothing active')
  assert.deepEqual(h.clean(result), { cancelled: false, message: 'nothing active' })
  assert.deepEqual(h.calls, [
    ['createScanOrchestrator.activeFontScanStatus', []],
    ['createScanOrchestrator.cancelActiveFontScan', ['nothing active']],
  ], 'idle cancellation must not pause recovery roots')
}
async function checkCommittedScanPublication(overrides = new Map()) {
  const h=createHarness(overrides);h.load(entry)
  const calls=[folders=>h.payload.scanFoldersManaged(folders,[]),folders=>h.options('createMainBackgroundRuntime').scanFolders(folders,[])]
  for (const call of calls) for (const mode of ['cancelled','busy','partial','closing']) {
    h.scanResult={folders:['/fonts/a','/fonts/b'],fonts:[],errors:[],committedFolders:mode==='busy'?[]:mode==='partial'?['/fonts/a']:['/fonts/a','/fonts/b'],stats:{cancelled:mode==='cancelled'}}
    h.closing=mode==='closing';h.reset();await call(['/fonts'])
    const published=h.calls.filter(row=>row[0]==='createMergedIndexPageRuntime.syncMergedIndexForRootSnapshot').map(row=>row[1][0])
    assert.deepEqual(published,mode==='partial'?['/fonts/a']:[],'COMMITTED_SCAN_PUBLICATION: retired/uncommitted root projected')
  }
}

async function main() {
  await checkBindings()
  await checkBaseline()
  checkIdleCancellation()
  await checkRecoveryWiringMutations()
  await checkCommittedScanPublication()
  for (const owner of ['Scan','Operations']) {
    const file=compositionFile(owner),source=read(file),guard='if (result.stats?.cancelled || isApplicationClosing()) return result;'
    assert.equal(source.split(guard).length-1,1)
    await assert.rejects(()=>checkCommittedScanPublication(new Map([[file,source.replace(guard,'')]])),error=>error instanceof assert.AssertionError && /COMMITTED_SCAN_PUBLICATION/.test(error.message))
    await assert.rejects(()=>checkCommittedScanPublication(new Map([[file,source.replace('for (const root of result.committedFolders || []) {','for (const root of result.folders || []) {')]])),error=>error instanceof assert.AssertionError && /COMMITTED_SCAN_PUBLICATION/.test(error.message))
  }
  const mutants = await checkMutations()
  const crlf = new Map([entry, ...['Mutation', 'Operations', 'Maintenance', 'Scan'].map(compositionFile)]
    .map(file => [file, read(file).replace(/\n/g, '\r\n')]))
  assert.deepEqual(await observeOperations(crlf), expectedOperations)
  console.log(`[diagnostics:main-operations-composition] passed: 12 pre-bind gates, one-time binding/scheduling, ${Object.keys(fixture.operations).length} operation flows, ${Object.keys(fixture.shutdown).length} real lifecycle scenarios, ${mutants} rejected mutations, CRLF`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
