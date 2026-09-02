#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
const baselineObserve = process.argv.includes('--baseline-observe')
const correctnessCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length) || ''

if (baselineObserve === Boolean(correctnessCase) || (correctnessCase && correctnessCase !== 'A1')) {
  console.error('[diagnostics:font-activation-transaction] use either --baseline-observe or --case=A1')
  process.exit(1)
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function fail(caseId, message) {
  throw new Error(`${caseId}: ${message}`)
}

function assert(caseId, condition, message) {
  if (!condition) fail(caseId, message)
}

function loadTypeScriptModule(rel, localRequire = require) {
  const output = ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  new Function('exports', 'require', 'module', '__filename', '__dirname', output)(
    module.exports,
    localRequire,
    module,
    path.join(root, rel),
    path.dirname(path.join(root, rel)),
  )
  return module.exports
}

function uniqueFontItems(items) {
  const result = []
  const ids = new Set()
  for (const item of items || []) {
    if (!item?.id || ids.has(item.id)) continue
    ids.add(item.id)
    result.push(item)
  }
  return result
}

function fontItem(id) {
  return {
    id,
    fileName: `${id}.ttf`,
    path: `D:/Source/${id}.ttf`,
    format: 'ttf',
  }
}

const sessionFsStub = {
  __esModule: true,
  default: { existsSync: () => false },
  promises: {
    access: async () => undefined,
    mkdir: async () => undefined,
  },
}

const sessionModule = loadTypeScriptModule(
  'src/main/activation/runtime/fontActivationSessionRuntime.ts',
  (id) => (id === 'node:fs' ? sessionFsStub : require(id)),
)

function createSessionHarness(failureStage) {
  const effects = {
    copiedFiles: new Set(),
    registryNames: new Set(),
    resourcePaths: new Set(),
    savedSessionStates: [],
    savedInstallStatuses: [],
    cleanupCalls: [],
    refreshCalls: [],
  }
  const currentState = { version: 1, records: [] }

  const deps = {
    ensureWindows: () => undefined,
    currentUserFontsDir: () => 'C:/Users/Test/AppData/Local/Microsoft/Windows/Fonts',
    loadTemporaryActiveFonts: async () => ({ version: 1, records: currentState.records.slice() }),
    saveTemporaryActiveFonts: async (state) => {
      if (failureStage === 'save-state') throw new Error('injected session state failure')
      effects.savedSessionStates.push(state)
      currentState.records = state.records.slice()
    },
    safeTemporaryActiveFontName: (item) => `HFM_ACTIVE_${item.id}.ttf`,
    temporaryActiveRegistryNameFor: (item) => `HFM_ACTIVE_${item.id} (TrueType)`,
    removeFontResourceSession: async (fontPath) => {
      effects.cleanupCalls.push(`resource:${fontPath}`)
      if (failureStage === 'compensation-fails') throw new Error('injected resource compensation failure')
      effects.resourcePaths.delete(fontPath)
    },
    addFontResourceSession: async (fontPath) => {
      if (failureStage === 'add-resource' || failureStage === 'compensation-fails') {
        throw new Error('injected resource add failure')
      }
      effects.resourcePaths.add(fontPath)
      return 1
    },
    writeFontRegistryValuesHKCUBatch: async (records) => {
      if (failureStage === 'write-registry') throw new Error('injected registry write failure')
      for (const record of records) effects.registryNames.add(record.name)
    },
    deleteRegistryValueHKCU: async (name) => {
      effects.cleanupCalls.push(`registry:${name}`)
      if (failureStage === 'compensation-fails') throw new Error('injected registry compensation failure')
      effects.registryNames.delete(name)
    },
    requestFontRefresh: (...args) => effects.refreshCalls.push(args),
    scheduleBackgroundFontRefreshTail: () => undefined,
  }

  const traceRuntime = {
    activationTraceStep: async (_step, _fontId, task) => task(),
  }
  const verifyRuntime = {
    quickTemporaryActiveRecordMessage: () => '',
    quickInstalledActivationMessage: () => '',
  }
  const statusRuntime = {
    compareActivationInstallStatus: async () => ({ installed: false, by: 'none', matches: [] }),
    saveActivationInstallStatus: async (item, result) => effects.savedInstallStatuses.push([item.id, result]),
    temporaryActiveRecordToInstalledRecord: (record) => ({ path: record.installPath }),
  }
  const cleanupRuntime = {
    removeTemporaryActiveRecord: async () => true,
  }
  const copyRuntime = {
    copyTemporaryActiveFontWithTrace: async (_item, dest) => {
      if (failureStage === 'copy') throw new Error('injected copy failure')
      effects.copiedFiles.add(dest)
      return 'copied'
    },
  }

  const runtime = sessionModule.createFontActivationSessionRuntime(
    deps,
    traceRuntime,
    verifyRuntime,
    statusRuntime,
    cleanupRuntime,
    copyRuntime,
  )
  return { runtime, effects, currentState }
}

async function expectReject(caseId, task, messagePart) {
  let error = null
  try {
    await task()
  } catch (caught) {
    error = caught
  }
  assert(caseId, error instanceof Error, 'expected operation to reject')
  assert(caseId, error.message.includes(messagePart), `unexpected rejection: ${error.message}`)
  return error
}

async function caseA1() {
  const module = loadTypeScriptModule('src/main/windows/runtime/fontResourceSessionRuntime.ts')
  const rustStats = { lastBroadcastAt: 0 }
  let rustNativeCalls = 0
  const rustFailureRuntime = module.createFontResourceSessionRuntime({
    appendStartupLog: () => undefined,
    fontRefreshRuntimeStats: rustStats,
    runNativeFontHelper: async () => {
      rustNativeCalls += 1
      return null
    },
    nativeFontHelperBatchResult: () => null,
    runRustFontResourceRemove: async (paths) => ({
      [paths[0]]: { ok: false, count: 0, message: 'injected remove failure' },
    }),
  })
  await expectReject(
    'A1',
    () => rustFailureRuntime.removeFontResourceSession('C:/Fonts/A.ttf', { notify: true }),
    'injected remove failure',
  )
  assert('A1', rustNativeCalls === 0, 'Rust ok=false incorrectly attempted native fallback')
  assert('A1', rustStats.lastBroadcastAt === 0, 'Rust ok=false updated the notify timestamp')

  let registryDeletes = 0
  let queuedDeletes = 0
  let sessionStateSaves = 0
  let installStatusSaves = 0
  const cleanupModule = loadTypeScriptModule(
    'src/main/activation/runtime/fontActivationCleanupRuntime.ts',
    (id) => {
      if (id === '../temporaryFontDeleteQueue') {
        return {
          createTemporaryFontDeleteQueue: () => ({
            isSafeTemporaryActiveFontPath: () => true,
            queueTemporaryFontFileDeletes: async () => { queuedDeletes += 1 },
            flushPendingTemporaryFontDeletes: async () => undefined,
          }),
        }
      }
      if (id === '../../rust-core/nodeBridgeFallbackCompatibilityRuntime') {
        return {
          logNodeBridgeFallbackDisabled: () => undefined,
          logNodeBridgeFallbackUsed: () => undefined,
          nodeBridgeFallbackCompatibilityAllowed: () => false,
          nodeBridgeFallbackDeniedMessage: () => 'fallback denied',
        }
      }
      return require(id)
    },
  )
  const cleanupRuntime = cleanupModule.createFontActivationCleanupRuntime(
    {
      appName: 'HFM',
      dataPath: () => 'C:/Data',
      dataRoot: () => 'C:/Data',
      currentUserFontsDir: () => 'C:/Fonts',
      removeFontResourceSession: rustFailureRuntime.removeFontResourceSession,
      deleteRegistryValueHKCU: async () => { registryDeletes += 1 },
      advancedFontRefresh: async () => undefined,
      clearInstalledFontsMemoryCache: () => undefined,
      saveTemporaryActiveFonts: async () => undefined,
      loadTemporaryActiveFonts: async () => ({ version: 1, records: [] }),
      withGlobalIo: async (_label, task) => task(),
      delayToEventLoop: async () => undefined,
      appendStartupLog: () => undefined,
    },
    { temporaryActiveRecordStillVisible: async () => false },
  )
  const item = fontItem('font-a1-state')
  const record = {
    fontId: item.id,
    sourcePath: item.path,
    installPath: 'C:/Fonts/A.ttf',
    registryName: 'HFM_A1',
    activatedAt: '2026-09-01T00:00:00.000Z',
    fileName: 'A.ttf',
  }
  const sessionRuntime = sessionModule.createFontActivationSessionRuntime(
    {
      ensureWindows: () => undefined,
      loadTemporaryActiveFonts: async () => ({ version: 1, records: [record] }),
      saveTemporaryActiveFonts: async () => { sessionStateSaves += 1 },
      scheduleBackgroundFontRefreshTail: () => undefined,
    },
    { activationTraceStep: async (_step, _fontId, task) => task() },
    {},
    { saveActivationInstallStatus: async () => { installStatusSaves += 1 } },
    cleanupRuntime,
    {},
  )
  await expectReject(
    'A1',
    () => sessionRuntime.deactivateFontSession(item),
    'injected remove failure',
  )
  assert('A1', registryDeletes === 0 && queuedDeletes === 0, 'failed resource remove advanced to registry or file cleanup')
  assert('A1', sessionStateSaves === 0 && installStatusSaves === 0, 'failed resource remove discarded persistent activation state')

  const nativeStats = { lastBroadcastAt: 0 }
  let nativeCalls = 0
  const nativeFailureRuntime = module.createFontResourceSessionRuntime({
    appendStartupLog: () => undefined,
    fontRefreshRuntimeStats: nativeStats,
    runNativeFontHelper: async () => {
      nativeCalls += 1
      return { ok: false, results: [] }
    },
    nativeFontHelperBatchResult: () => ({
      'C:/Fonts/B.ttf': { ok: false, count: 0, message: 'injected native remove failure' },
    }),
    runRustFontResourceRemove: async () => null,
  })
  await expectReject(
    'A1',
    () => nativeFailureRuntime.removeFontResourceSession('C:/Fonts/B.ttf', { notify: true }),
    'injected native remove failure',
  )
  assert('A1', nativeCalls === 1, 'Rust unavailable did not attempt native helper exactly once')
  assert('A1', nativeStats.lastBroadcastAt === 0, 'native ok=false updated the notify timestamp')

  const nativePayloadFailureRuntime = module.createFontResourceSessionRuntime({
    appendStartupLog: () => undefined,
    fontRefreshRuntimeStats: { lastBroadcastAt: 0 },
    runNativeFontHelper: async () => ({ ok: false, message: 'injected native payload failure' }),
    nativeFontHelperBatchResult: () => null,
    runRustFontResourceRemove: async () => null,
  })
  await expectReject(
    'A1',
    () => nativePayloadFailureRuntime.removeFontResourceSession('C:/Fonts/Payload.ttf'),
    'injected native payload failure',
  )

  let missingResultNativeCalls = 0
  const missingResultRuntime = module.createFontResourceSessionRuntime({
    appendStartupLog: () => undefined,
    fontRefreshRuntimeStats: { lastBroadcastAt: 0 },
    runNativeFontHelper: async () => {
      missingResultNativeCalls += 1
      return null
    },
    nativeFontHelperBatchResult: () => null,
    runRustFontResourceRemove: async () => ({}),
  })
  await expectReject(
    'A1',
    () => missingResultRuntime.removeFontResourceSession('C:/Fonts/Missing.ttf'),
    'returned no result',
  )
  assert('A1', missingResultNativeCalls === 0, 'malformed Rust result incorrectly attempted native fallback')

  const unavailableRuntime = module.createFontResourceSessionRuntime({
    appendStartupLog: () => undefined,
    fontRefreshRuntimeStats: { lastBroadcastAt: 0 },
    runNativeFontHelper: async () => null,
    nativeFontHelperBatchResult: () => null,
    runRustFontResourceRemove: async () => null,
  })
  await expectReject(
    'A1',
    () => unavailableRuntime.removeFontResourceSession('C:/Fonts/Unavailable.ttf'),
    'RemoveFontResourceEx has no safe cmd.exe fallback',
  )

  const successStats = { lastBroadcastAt: 0 }
  let successNativeCalls = 0
  const successRuntime = module.createFontResourceSessionRuntime({
    appendStartupLog: () => undefined,
    fontRefreshRuntimeStats: successStats,
    runNativeFontHelper: async () => {
      successNativeCalls += 1
      return null
    },
    nativeFontHelperBatchResult: () => null,
    runRustFontResourceRemove: async (paths) => ({
      [paths[0]]: { ok: true, count: 1, message: '' },
    }),
  })
  await successRuntime.removeFontResourceSession('C:/Fonts/Success.ttf', { notify: true })
  assert('A1', successNativeCalls === 0, 'successful Rust remove attempted native fallback')
  assert('A1', successStats.lastBroadcastAt > 0, 'successful notified remove did not update the notify timestamp')

  let addNativeCalls = 0
  const addFailureRuntime = module.createFontResourceSessionRuntime({
    appendStartupLog: () => undefined,
    fontRefreshRuntimeStats: { lastBroadcastAt: 0 },
    runNativeFontHelper: async () => {
      addNativeCalls += 1
      return null
    },
    nativeFontHelperBatchResult: () => null,
    runRustFontResourceAdd: async (paths) => ({
      [paths[0]]: { ok: false, count: 0, message: 'injected add failure' },
    }),
  })
  await expectReject(
    'A1',
    () => addFailureRuntime.addFontResourceSession('C:/Fonts/C.ttf'),
    'injected add failure',
  )
  assert('A1', addNativeCalls === 0, 'Rust add ok=false incorrectly attempted native fallback')

  return 'single add/remove failures reject with the helper reason and never trigger duplicate fallback'
}

async function caseA2() {
  const module = loadTypeScriptModule(
    'src/main/activation/runtime/fontDeactivationBatchRuntime.ts',
    (id) => {
      if (id === './fontActivationInstallStatusRuntime') return { uniqueFontItems }
      return require(id)
    },
  )
  const items = [fontItem('font-a'), fontItem('font-b')]
  const records = items.map((item) => ({
    fontId: item.id,
    sourcePath: item.path,
    installPath: `C:/Managed/${item.id}.ttf`,
    registryName: `HFM_${item.id}`,
    activatedAt: '2026-09-01T00:00:00.000Z',
    fileName: item.fileName,
  }))
  let savedState = null
  let queued = []
  const runtime = module.createFontDeactivationBatchRuntime(
    {
      ensureWindows: () => undefined,
      loadTemporaryActiveFonts: async () => ({ version: 1, records }),
      saveTemporaryActiveFonts: async (state) => { savedState = state },
      removeFontResourceSessionBatch: async () => ({
        [records[0].installPath]: { ok: true, count: 1 },
        [records[1].installPath]: { ok: false, count: 0, message: 'injected batch remove failure' },
      }),
      deleteFontRegistryValuesHKCUBatch: async () => undefined,
      scheduleActivationInstallStatusSave: () => undefined,
      scheduleBackgroundFontRefreshTail: () => undefined,
      appendStartupLog: () => undefined,
    },
    {
      queueTemporaryFontFileDeletes: async (targets) => { queued = targets.slice() },
    },
  )
  const result = await runtime.deactivateFontSessionsBatch(items)
  assert('A2', result.ok === true && result.failed === 0 && result.deactivated === 2, 'known defect changed: partial remove failure is no longer reported as full success')
  assert('A2', savedState?.records?.length === 0, 'known defect changed: failed target state is no longer discarded')
  assert('A2', queued.length === 2, 'known defect changed: failed target is no longer queued for deletion')
  return 'batch remove partial failure reports 2/0 success and discards both records'
}

async function caseA3() {
  const { runtime, effects } = createSessionHarness('copy')
  await expectReject('A3', () => runtime.activateFontSession(fontItem('font-copy')), 'injected copy failure')
  assert('A3', effects.copiedFiles.size === 0, 'copy failure left a copied file in the harness')
  assert('A3', effects.registryNames.size === 0 && effects.resourcePaths.size === 0, 'copy failure reached registry or resource side effects')
  assert('A3', effects.savedSessionStates.length === 0, 'copy failure committed session state')
  return 'copy failure currently stops before registry/resource/state side effects'
}

async function caseA4() {
  const { runtime, effects } = createSessionHarness('write-registry')
  await expectReject('A4', () => runtime.activateFontSession(fontItem('font-registry')), 'injected registry write failure')
  assert('A4', effects.copiedFiles.size === 1, 'known defect changed: copied file no longer remains after registry failure')
  assert('A4', effects.cleanupCalls.length === 0, 'known defect changed: compensation unexpectedly ran')
  assert('A4', effects.savedSessionStates.length === 0, 'registry failure committed session state')
  return 'registry write failure leaves the copied file without compensation'
}

async function caseA5() {
  const { runtime, effects } = createSessionHarness('add-resource')
  await expectReject('A5', () => runtime.activateFontSession(fontItem('font-resource')), 'injected resource add failure')
  assert('A5', effects.copiedFiles.size === 1 && effects.registryNames.size === 1, 'known defect changed: pre-resource side effects no longer remain')
  assert('A5', effects.cleanupCalls.length === 0, 'known defect changed: rollback unexpectedly ran')
  assert('A5', effects.savedSessionStates.length === 0, 'resource add failure committed session state')
  return 'resource add failure leaves copied file and registry value'
}

async function caseA6() {
  const { runtime, effects } = createSessionHarness('save-state')
  await expectReject('A6', () => runtime.activateFontSession(fontItem('font-state')), 'injected session state failure')
  assert('A6', effects.copiedFiles.size === 1 && effects.registryNames.size === 1 && effects.resourcePaths.size === 1, 'known defect changed: activated side effects no longer remain after state save failure')
  assert('A6', effects.cleanupCalls.length === 0, 'known defect changed: state-save rollback unexpectedly ran')
  assert('A6', effects.savedInstallStatuses.length === 0, 'install status should not be committed after session state failure')
  return 'session state failure leaves file, registry, and active resource orphaned'
}

async function caseA7() {
  const { runtime, effects } = createSessionHarness('compensation-fails')
  const error = await expectReject('A7', () => runtime.activateFontSession(fontItem('font-compensation')), 'injected resource add failure')
  assert('A7', effects.cleanupCalls.length === 0, 'known defect changed: compensation hooks unexpectedly ran')
  assert('A7', !error.message.includes('compensation'), 'known defect changed: error unexpectedly includes compensation outcome')
  return 'no compensation attempt or durable cleanup record exists for compensation failure'
}

async function caseA8() {
  const batchFsStub = {
    __esModule: true,
    default: { existsSync: () => false },
    promises: {
      access: async () => undefined,
      mkdir: async () => undefined,
      rm: async () => undefined,
    },
  }
  const module = loadTypeScriptModule(
    'src/main/activation/runtime/fontActivationBatchRuntime.ts',
    (id) => {
      if (id === 'node:fs') return batchFsStub
      if (id === './fontActivationInstallStatusRuntime') return { uniqueFontItems }
      if (id === './fontDeactivationBatchRuntime') {
        return { createFontDeactivationBatchRuntime: () => ({ deactivateFontSessionsBatch: async () => ({}) }) }
      }
      return require(id)
    },
  )
  const items = [fontItem('font-cancel-a'), fontItem('font-cancel-b')]
  let savedState = null
  const copied = []
  const deps = {
    ensureWindows: () => undefined,
    currentUserFontsDir: () => 'C:/Managed',
    loadTemporaryActiveFonts: async () => ({ version: 1, records: [] }),
    saveTemporaryActiveFonts: async (state) => { savedState = state },
    safeTemporaryActiveFontName: (item) => `${item.id}.ttf`,
    temporaryActiveRegistryNameFor: (item) => `HFM_${item.id}`,
    removeFontResourceSessionBatch: async () => ({}),
    addFontResourceSessionBatch: async (paths) => Object.fromEntries(paths.map((fontPath) => [fontPath, { ok: true, count: 1 }])),
    writeFontRegistryValuesHKCUBatch: async () => undefined,
    deleteFontRegistryValuesHKCUBatch: async () => undefined,
    scheduleActivationInstallStatusSave: () => undefined,
    requestFontRefresh: () => undefined,
    withGlobalIo: async (_label, task) => task(),
    appendStartupLog: () => undefined,
  }
  const runtime = module.createFontActivationBatchRuntime(
    deps,
    { activationTraceStep: async (_step, _fontId, task) => task() },
    {
      readActivationInstallStatusBatch: async () => Object.fromEntries(items.map((item) => [item.id, { installed: false, by: 'none', matches: [] }])),
      temporaryActiveRecordToInstalledRecord: (record) => ({ path: record.installPath }),
    },
    {},
    {
      copyTemporaryActiveFontWithTrace: async (item) => {
        copied.push(item.id)
        return 'copied'
      },
    },
  )
  const controller = new AbortController()
  controller.abort('baseline-cancel')
  const result = await runtime.activateFontSessionsBatch(items, { signal: controller.signal })
  assert('A8', result.activated === 2 && result.failed === 0, 'known defect changed: an already-aborted request no longer processes the entire batch')
  assert('A8', copied.length === 2 && savedState?.records?.length === 2, 'known defect changed: cancelled batch no longer commits every item')
  return 'already-aborted signal is ignored and the full batch is committed'
}

async function main() {
  const cases = [
    ['A1', 'CORRECTNESS_LOCK', caseA1],
    ['A2', 'KNOWN_DEFECT', caseA2],
    ['A3', 'BEHAVIOR_LOCK', caseA3],
    ['A4', 'KNOWN_DEFECT', caseA4],
    ['A5', 'KNOWN_DEFECT', caseA5],
    ['A6', 'KNOWN_DEFECT', caseA6],
    ['A7', 'KNOWN_DEFECT', caseA7],
    ['A8', 'KNOWN_DEFECT', caseA8],
  ]
  const selectedCases = correctnessCase ? cases.filter(([caseId]) => caseId === correctnessCase) : cases
  let defects = 0
  let locks = 0
  for (const [caseId, kind, run] of selectedCases) {
    const message = await run()
    if (kind === 'KNOWN_DEFECT') defects += 1
    else locks += 1
    console.log(`[diagnostics:font-activation-transaction] ${kind} ${caseId}: ${message}`)
  }
  if (baselineObserve) {
    console.log(`[diagnostics:font-activation-transaction] baseline observed: knownDefects=${defects}, behaviorLocks=${locks}, cases=${selectedCases.length}`)
  } else {
    console.log(`[diagnostics:font-activation-transaction] correctness passed: cases=${selectedCases.length}`)
  }
}

main().catch((error) => {
  console.error(`[diagnostics:font-activation-transaction] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
