#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHarness, root, entry, bootstrap } = require('./helpers/mainCompositionHarness.cjs')
const { observeLifecycle } = require('./helpers/mainOperationsHarness.cjs')
const groups = require('./fixtures/main-application-registration.fixture.json')
const legacy = require('./fixtures/orchestration-contracts.fixture.json')
const lifecycleFixture = require('./fixtures/main-operations-composition.fixture.json')
const application = path.join(bootstrap, 'mainApplicationRuntime.ts')
const adapter = path.join(bootstrap, 'mainRuntimeRegistrationPayload.ts')
const lifecycle = path.join(root, 'src/main/app/mainProcessLifecycleRuntime.ts')
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
function boundedClose(pending) {
  let timer
  return Promise.race([pending, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('physical-close wrapper did not settle after released owners')), 5000)
  })]).finally(() => clearTimeout(timer))
}

async function checkApplication(overrides = new Map()) {
  const h = createHarness(overrides)
  for (const file of [application, adapter, path.join(bootstrap, 'mainTagCompositionRuntime.ts')]) h.load(file)
  assert.equal(h.constructors.size, 0, 'import created a domain owner')
  assert.equal(h.compositions.size, 0, 'import constructed the application')
  assert.equal(h.payload, null, 'import registered the application')
  assert.deepEqual(h.calls, [], 'import started work')
  h.load(entry)
  const expected = {}
  for (const owner of ['Core', 'Data', 'Mutation', 'Operations']) {
    const runtime = h.compositions.get(`createMain${owner}CompositionRuntime`)
    for (const group of ['capabilities', 'lifecycle']) {
      for (const [key, value] of Object.entries(runtime[group])) {
        assert(!(key in expected), `${key} has more than one owner`)
        expected[key] = value
      }
    }
  }
  assert.deepEqual(Object.keys(expected).sort(), [...legacy.mainRegistrationKeys].sort())
  assert.deepEqual(Object.keys(h.registrationGroups).sort(), Object.keys(groups).sort())
  const seen = new Set()
  for (const [name, keys] of Object.entries(groups)) {
    assert.deepEqual(Object.keys(h.registrationGroups[name]).sort(), [...keys].sort(), `${name} keys drifted`)
    for (const key of keys) {
      assert(!seen.has(key), `${key} registered in two groups`)
      seen.add(key)
      if (key !== 'awaitFolderWatchersClosed') assert.equal(h.registrationGroups[name][key], expected[key], `${key} wired to the wrong owner`)
      else assert.equal(typeof h.registrationGroups[name][key], 'function', 'physical-close composition is missing')
    }
  }
  const app = h.compositions.get('createMainApplicationRuntime')
  assert.deepEqual(Object.keys(app), ['registration'], 'Application leaked internal owners/resources')
  assert.equal(app.registration, h.payload, 'registration output was copied or replaced')
  assert.deepEqual(Object.keys(h.payload).sort(), Object.keys(expected).sort())
  for (const key of Object.keys(expected)) {
    if (key !== 'awaitFolderWatchersClosed') assert.equal(h.payload[key], expected[key], `${key} was wrapped or replaced`)
    else assert.equal(h.payload[key], h.registrationGroups.lifecycle[key], 'physical-close wrapper identity was replaced')
  }
  // This sole reviewed wrapper joins two actual lifecycle owners without
  // publishing either private resource. Verify order and both held lifetimes.
  const operations = h.compositions.get('createMainOperationsCompositionRuntime')
  const data = h.compositions.get('createMainDataCompositionRuntime')
  // The scan owner composes clear + replacement under one maintenance request.
  // Exercise the registered entry; maintenance drain/admission is tested separately.
  const clearName = data.capabilities.clearScanCache.fixtureOperation
  h.reset()
  await h.payload.scanFoldersManaged(['/fonts'], [], { rebuild: true })
  const clearAt = h.calls.findIndex(call => call[0] === clearName)
  const scanAt = h.calls.findIndex(call => call[0] === 'createScanOrchestrator.scanFoldersManaged')
  assert.equal(h.calls.filter(call => call[0] === 'runCacheMaintenance').length, 1)
  assert(clearAt >= 0 && scanAt > clearAt, 'rebuild did not clear before replacement scan')
  h.reset()
  await h.payload.scanFoldersManaged(['/fonts'], [])
  assert(!h.calls.some(call => call[0] === clearName || call[0] === 'runCacheMaintenance'), 'ordinary scan cleared the cache')
  h.reset(); h.failOperations.add(clearName)
  try { await assert.rejects(h.payload.scanFoldersManaged(['/fonts'], [], { rebuild: true }), /fixture failure/) }
  finally { h.failOperations.delete(clearName) }
  assert(!h.calls.some(call => call[0] === 'createScanOrchestrator.scanFoldersManaged'), 'failed clear still started replacement')
  const events = []; let releaseWatcher, releaseProbe, settled = false
  const watcherClosed = new Promise(resolve => { releaseWatcher = resolve })
  const probeClosed = new Promise(resolve => { releaseProbe = resolve })
  operations.lifecycle.awaitFolderWatchersClosed = async () => { events.push('watcher-start'); await watcherClosed; events.push('watcher-closed') }
  data.resources.awaitSharedAvailabilityProbesClosed = async () => { events.push('probe-start'); await probeClosed; events.push('probe-closed') }
  const pending = boundedClose(Promise.resolve().then(() => h.payload.awaitFolderWatchersClosed()).then(() => { settled = true }))
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events, ['watcher-start'], 'probe owner started before watcher physical close')
    assert.equal(settled, false, 'shutdown wrapper skipped watcher physical close')
    releaseWatcher()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events, ['watcher-start', 'watcher-closed', 'probe-start'], 'availability owner was omitted or reordered')
    assert.equal(settled, false, 'shutdown wrapper skipped availability physical close')
    releaseProbe(); await pending
    assert.deepEqual(events, ['watcher-start', 'watcher-closed', 'probe-start', 'probe-closed'])
  } finally { releaseWatcher(); releaseProbe(); await pending }
}

async function main() {
  await checkApplication()
  const mutants = [
    ['missing capability', application, '      moveFontFilesToFolder: mutation.capabilities.moveFontFilesToFolder,', ''],
    ['wrong activation route', application, 'activateFontSession: mutation.capabilities.activateFontSession', 'activateFontSession: mutation.capabilities.deactivateFontSession'],
    ['duplicate grouped capability', application, '    query: {', '    query: {\n      appName: core.capabilities.appName,'],
    ['dropped preview group', adapter, '    ...groups.preview,', ''],
    ['duplicate registration', entry, 'registerMainProcessRuntime(application.registration);', 'registerMainProcessRuntime(application.registration);\nregisterMainProcessRuntime(application.registration);'],
    ['duplicate startup timer', entry, 'operationsComposition.startStartupTasks();', 'operationsComposition.startStartupTasks();\noperationsComposition.startStartupTasks();'],
    ['duplicate scheduler start', lifecycle, '      startBackgroundTaskScheduler();', '      startBackgroundTaskScheduler();\n      startBackgroundTaskScheduler();'],
    ['missing watcher physical-close wait', lifecycle, '      await awaitFolderWatchersClosed();', ''],
    ['duplicate watcher stop', lifecycle, '      stopFolderWatchers();', '      stopFolderWatchers();\n      stopFolderWatchers();'],
    ['unawaited watcher owner', application, 'await operations.lifecycle.awaitFolderWatchersClosed();', 'void operations.lifecycle.awaitFolderWatchersClosed();', /probe owner started before watcher physical close/],
    ['unawaited probe owner', application, 'await data.resources.awaitSharedAvailabilityProbesClosed();', 'void data.resources.awaitSharedAvailabilityProbesClosed();', /shutdown wrapper skipped availability physical close/],
    ['omitted probe owner', application, 'await data.resources.awaitSharedAvailabilityProbesClosed();', '', /availability owner was omitted or reordered/],
  ]
  for (const [name, file, before, after, expectedFailure] of mutants) {
    const source = read(file)
    assert.equal(source.split(before).length, 2, `${name}: mutation anchor drifted`)
    const overrides = new Map([[file, source.replace(before, after)]])
    await assert.rejects(async () => {
      if (file !== lifecycle) await checkApplication(overrides)
      else {
        const actual = await observeLifecycle('normal', overrides)
        assert.deepEqual(actual.startup, lifecycleFixture.startup)
        assert.deepEqual(actual.shutdown, lifecycleFixture.shutdown.normal)
      }
    }, expectedFailure, `${name} escaped the behavior checks`)
  }
  const crlf = new Map([entry, application, adapter, path.join(bootstrap, 'mainTagCompositionRuntime.ts')]
    .map(file => [file, read(file).replace(/\n/g, '\r\n')]))
  await checkApplication(crlf)
  console.log(`[diagnostics:main-application-runtime] passed: ${Object.keys(groups).length} groups, ${legacy.mainRegistrationKeys.length - 1} direct capability identities, one ordered physical-close wrapper, side-effect-free imports, ${mutants.length} rejected wiring/duplicate start-stop mutations, CRLF`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
