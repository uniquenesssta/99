#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, entry, root, bootstrap } = require('./helpers/mainCompositionHarness.cjs')
const { observeOperations, observeLifecycle } = require('./helpers/mainOperationsHarness.cjs')
const fixture = require('./fixtures/main-operations-composition.fixture.json')
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
    'createPreviewDbRuntime.closePreviewDb', 'createMainBackgroundRuntime.closeTasksDb', 'createLibraryRuntime.closeLibraryDb',
  ])
  const partial = createHarness().load(path.join(bootstrap, 'mainCompositionFeedback.ts')).createMainCompositionFeedback()
  partial.bindOperations(ops.feedback)
  h.reset()
  assert.throws(() => partial.tasks.startBackgroundTask('fixture'), /not bound: Data/)
  assert.deepEqual(h.calls, [], 'binding Operations alone enabled task execution')
}

async function checkBaseline(overrides = new Map()) {
  assert.deepEqual(await observeOperations(overrides), fixture.operations)
  for (const scenario of Object.keys(fixture.shutdown)) {
    const actual = await observeLifecycle(scenario, overrides)
    assert.deepEqual(actual.startup, fixture.startup, `${scenario}: startup order changed`)
    assert.deepEqual(actual.shutdown, fixture.shutdown[scenario], `${scenario}: shutdown behavior changed`)
    assert.deepEqual(actual.events, fixture.events)
    assert.deepEqual(actual.processEvents, fixture.processEvents)
  }
}

async function checkMutations() {
  const lifecycle = path.join(root, 'src/main/app/mainProcessLifecycleRuntime.ts')
  const mutants = [
    ['missing binding', entry, 'feedback.bindOperations(operationsComposition.feedback);', ''],
    ['lost index sync', compositionFile('Scan'), 'await syncMergedIndexForRootSnapshot(root, "scan-finished");', ''],
    ['lost watcher notification', compositionFile('Scan'), 'folderWatcherRuntime.sendFontIndexChanged(payload);', ''],
    ['lost activation flush', lifecycle, 'await flushActivationInstallStatusSave("before-quit");', ''],
    ['lost quit-abort resume', lifecycle, 'if (startupBackgroundTasksEnabled) startBackgroundTaskScheduler();', ''],
  ]
  for (const [name, file, before, after] of mutants) {
    const source = read(file)
    assert.equal(source.split(before).length, 2, `${name}: mutation anchor drifted`)
    const overrides = new Map([[file, source.replace(before, after)]])
    await assert.rejects(async () => {
      if (file === lifecycle) {
        const scenario = name === 'lost activation flush' ? 'normal' : 'flush-return'
        const actual = await observeLifecycle(scenario, overrides)
        assert.deepEqual(actual.shutdown, fixture.shutdown[scenario])
      } else assert.deepEqual(await observeOperations(overrides), fixture.operations)
    }, undefined, `${name} was not detected`)
  }
  return mutants.length
}

async function main() {
  await checkBindings()
  await checkBaseline()
  const mutants = await checkMutations()
  const crlf = new Map([entry, ...['Mutation', 'Operations', 'Maintenance', 'Scan'].map(compositionFile)]
    .map(file => [file, read(file).replace(/\n/g, '\r\n')]))
  assert.deepEqual(await observeOperations(crlf), fixture.operations)
  console.log(`[diagnostics:main-operations-composition] passed: 12 pre-bind gates, one-time binding/scheduling, ${Object.keys(fixture.operations).length} operation flows, ${Object.keys(fixture.shutdown).length} real lifecycle scenarios, ${mutants} rejected mutations, CRLF`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
