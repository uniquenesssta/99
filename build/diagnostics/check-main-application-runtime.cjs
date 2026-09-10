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

function checkApplication(overrides = new Map()) {
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
      assert.equal(h.registrationGroups[name][key], expected[key], `${key} wired to the wrong owner`)
    }
  }
  const app = h.compositions.get('createMainApplicationRuntime')
  assert.deepEqual(Object.keys(app), ['registration'], 'Application leaked internal owners/resources')
  assert.equal(app.registration, h.payload, 'registration output was copied or replaced')
  assert.deepEqual(Object.keys(h.payload).sort(), Object.keys(expected).sort())
  for (const key of Object.keys(expected)) assert.equal(h.payload[key], expected[key], `${key} was wrapped or replaced`)
}

async function main() {
  checkApplication()
  const mutants = [
    ['missing capability', application, '      moveFontFilesToFolder: mutation.capabilities.moveFontFilesToFolder,', ''],
    ['wrong activation route', application, 'activateFontSession: mutation.capabilities.activateFontSession', 'activateFontSession: mutation.capabilities.deactivateFontSession'],
    ['duplicate grouped capability', application, '    query: {', '    query: {\n      appName: core.capabilities.appName,'],
    ['dropped preview group', adapter, '    ...groups.preview,', ''],
    ['duplicate registration', entry, 'registerMainProcessRuntime(application.registration);', 'registerMainProcessRuntime(application.registration);\nregisterMainProcessRuntime(application.registration);'],
    ['duplicate startup timer', entry, 'operationsComposition.startStartupTasks();', 'operationsComposition.startStartupTasks();\noperationsComposition.startStartupTasks();'],
    ['duplicate scheduler start', lifecycle, '      startBackgroundTaskScheduler();', '      startBackgroundTaskScheduler();\n      startBackgroundTaskScheduler();'],
    ['duplicate watcher stop', lifecycle, '      stopFolderWatchers();', '      stopFolderWatchers();\n      stopFolderWatchers();'],
  ]
  for (const [name, file, before, after] of mutants) {
    const source = read(file)
    assert.equal(source.split(before).length, 2, `${name}: mutation anchor drifted`)
    const overrides = new Map([[file, source.replace(before, after)]])
    await assert.rejects(async () => {
      if (file !== lifecycle) checkApplication(overrides)
      else {
        const actual = await observeLifecycle('normal', overrides)
        assert.deepEqual(actual.startup, lifecycleFixture.startup)
        assert.deepEqual(actual.shutdown, lifecycleFixture.shutdown.normal)
      }
    }, undefined, `${name} escaped the behavior checks`)
  }
  const crlf = new Map([entry, application, adapter, path.join(bootstrap, 'mainTagCompositionRuntime.ts')]
    .map(file => [file, read(file).replace(/\n/g, '\r\n')]))
  checkApplication(crlf)
  console.log('[diagnostics:main-application-runtime] passed: 5 groups, 115 capability identities, side-effect-free imports, 8 rejected wiring/duplicate start-stop mutations, CRLF')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
