const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { createHarness, entry, root } = require('./mainCompositionHarness.cjs')
const drain = () => new Promise(resolve => setImmediate(resolve))

async function observeOperations(overrides = new Map()) {
  const h = createHarness(overrides)
  h.load(entry)
  const p = h.payload, flows = {}
  for (const [name, action] of Object.entries({
    managedScan: () => p.scanFoldersManaged(['/fonts'], []),
    backgroundScan: () => h.options('createMainBackgroundRuntime').scanFolders(['/fonts'], []),
    failedScan: async () => {
      h.failOperations.add('createScanOrchestrator.scanFoldersManaged')
      try { await p.scanFoldersManaged(['/fonts'], []) }
      catch (error) { return error.message }
      finally { h.failOperations.clear() }
    },
    cancelScan: () => p.cancelActiveFontScan('user cancelled'),
    scanNotification: () => h.options('createScanOrchestrator').sendFontIndexChanged({ reason: 'scan' }),
    watcherScanStatus: () => h.options('createFolderWatcherRuntime').isScanActive(),
    manualNotification: () => h.options('createManualFolderRefreshRuntime').sendFontIndexChanged({ reason: 'manual-refresh' }),
    sharedNotification: () => h.options('createSharedMetadataMergedIndexSyncRuntime').sendFontIndexChanged({ reason: 'tags' }),
    physicalReconciliation: () => h.options('createPhysicalFolderActions').reconcileWatchedRoot('/fonts'),
    moveReconciliation: () => h.options('createFontMoveTransactionRuntime').reconcileWatchedRoot('/fonts'),
    refreshInvalidation: () => h.options('createInstallStatusRefreshRuntime').clearFontQueryCaches(),
    refreshStart: () => p.startInstallStatusRefreshIndex({ force: true, incremental: true }),
    schedulerPauseResume: async () => {
      p.stopBackgroundTaskScheduler()
      p.startBackgroundTaskScheduler()
      await p.runBackgroundTaskSchedulerOnce()
    },
    sharedTagsStartup: async () => {
      const timer = h.timers.find(timer => timer.ms === 1500)
      if (!timer) throw new Error('shared tag startup timer missing')
      timer.fn()
      await drain()
    },
  })) {
    h.reset()
    const result = await action()
    flows[name] = { result: h.clean(result), calls: h.clean(h.calls) }
  }
  return flows
}

// Execute the unchanged real Electron lifecycle with the actual composition
// hooks. Only Electron/process, clock, OS work and user dialog choices are fake.
async function observeLifecycle(scenario, overrides = new Map()) {
  const h = createHarness(overrides)
  h.load(entry)
  const p = h.payload, events = new Map(), processEvents = new Map(), timers = []
  const trace = [], record = (...args) => trace.push(args)
  let ready, windows = [], finished = false
  const window = {
    isDestroyed: () => false, isMinimized: () => false, isVisible: () => true,
    hide: () => record('window.hide'), focus: () => record('window.focus'),
    restore: () => record('window.restore'), show: () => record('window.show'),
  }
  const app = {
    isPackaged: false, setName: () => undefined, setAppUserModelId: () => undefined,
    getVersion: () => 'fixture', getPath: () => '/app/exe', getAppPath: () => '/app',
    requestSingleInstanceLock: () => true,
    on: (name, callback) => events.set(name, callback),
    whenReady: () => ({ then: callback => (ready = Promise.resolve().then(callback)) }),
    quit: () => {
      record('app.quit')
      let prevented = false
      events.get('before-quit')?.({ preventDefault: () => { prevented = true } })
      if (!prevented) { events.get('will-quit')?.(); finished = true }
    },
  }
  const electron = {
    app, BrowserWindow: { getAllWindows: () => windows },
    Menu: { buildFromTemplate: value => value, setApplicationMenu: () => undefined },
    shell: { showItemInFolder: () => undefined },
    dialog: {
      showErrorBox: title => record('dialog.error', title),
      showMessageBox: async () => { record('dialog.choice', scenario); return { response: scenario === 'flush-force-quit' ? 1 : 0 } },
    },
  }
  const file = path.join(root, 'src/main/app/mainProcessLifecycleRuntime.ts')
  const source = overrides.get(file) ?? fs.readFileSync(file, 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: spec => {
      if (spec === 'electron') return electron
      if (spec.endsWith('appSecurityRuntime')) return { registerPackagedSessionSecurity: () => record('session.security') }
      if (spec.endsWith('appDataRootPolicyRuntime')) return { configureElectronUserDataRoot: () => '/app/userdata' }
      if (spec.endsWith('appIntegrityRuntime')) return { verifyPackagedAppIntegrity: () => ({ ok: true }) }
      throw new Error(`unexpected lifecycle import ${spec}`)
    },
    process: { argv: [], env: {}, platform: 'win32', arch: 'x64', pid: 1, versions: {}, resourcesPath: '/app/resources', cwd: () => '/app', on: (name, callback) => processEvents.set(name, callback) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); record('lifecycle.timer', ms); return { unref: () => undefined } },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-01-01T00:00:00Z'])) } },
  }, { filename: file })
  const options = {
    ...p, appendLog: message => record('log', String(message).split('\n')[0]),
    gpuAccelerationSwitches: [], gpuDisableSwitches: [], configureGpuAcceleration: () => undefined,
    appendGpuStartupSwitchDiagnostics: () => undefined, appendGpuDiagnostics: async () => undefined,
    registerIpc: () => record('ipc.register'), startupBackgroundTasksEnabled: true,
    scanTuningLogLine: 'fixture scan tuning',
    createWindow: () => { p.createWindow(); windows = [window] },
    requestRendererWindowsCloseForQuit: async () => {
      p.requestRendererWindowsCloseForQuit()
      if (scenario === 'renderer-error') throw new Error('renderer flush failed')
      if (scenario === 'renderer-cancel') return false
      windows = []
      return true
    },
    cleanupTemporaryActiveFontsUntilEmpty: async (reason, ...args) => {
      p.cleanupTemporaryActiveFontsUntilEmpty(reason, ...args)
      if (reason === 'quit' && scenario === 'cleanup-error') throw new Error('cleanup failed')
      return { remaining: reason === 'quit' && scenario === 'cleanup-remains' ? 1 : 0 }
    },
    flushActivationInstallStatusSave: async reason => {
      p.flushActivationInstallStatusSave(reason)
      if (scenario === 'flush-return' || scenario === 'flush-force-quit') throw new Error('activation flush failed')
    },
  }
  for (const key of ['diagnoseRustCoreWorker', 'setCacheKvs', 'runStartupCriticalSchemaAudit', 'runStartupDatabaseMaintenance']) {
    options[key] = async (...args) => p[key](...args)
  }
  h.reset()
  module.exports.registerMainProcessLifecycleRuntime(options)
  await ready
  for (const timer of timers) { timer.fn(); await drain() }
  const startup = { trace: h.clean(trace), calls: h.clean(h.calls) }
  trace.length = 0; h.reset()
  if (scenario === 'exception') processEvents.get('uncaughtException')(new Error('fixture exception'))
  else if (scenario === 'rejection') processEvents.get('unhandledRejection')('fixture rejection')
  else {
    app.quit()
    await drain()
  }
  return { startup, shutdown: { trace: h.clean(trace), calls: h.clean(h.calls), finished, windows: windows.length }, events: [...events.keys()].sort(), processEvents: [...processEvents.keys()].sort() }
}
module.exports = { observeOperations, observeLifecycle }
