const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')

const root = path.resolve(__dirname, '../../..')
const entry = path.join(root, 'src/main/index.ts')
const bootstrap = path.join(root, 'src/main/bootstrap')

// Execute the real entry/composition code with recording domain ports. These
// stand-ins own no real windows, fonts, files, threads, database or task timers.
// Domain correctness continues to be checked by its existing dedicated gates.
function createHarness(overrides = new Map()) {
  const calls = [], constructors = new Map(), modules = new Map()
  const state = { calls, constructors, compositions: new Map(), payload: null, saveSucceeds: true, failOperations: new Set() }
  const clean = value => {
    if (typeof value === 'function') return value.fixtureOperation || '<function>'
    if (value === undefined) return '<undefined>'
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return Array.from(value, clean)
    if (value instanceof Set) return [...value].map(clean)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'env' ? '<environment>' : clean(v)]))
  }
  const record = (name, args) => calls.push([name, clean(args)])
  function operation(name, implementation = () => undefined) {
    const invoke = (...args) => {
      record(name, args)
      if (state.failOperations.has(name)) throw new Error(`fixture failure: ${name}`)
      return implementation(...args)
    }
    Object.defineProperty(invoke, 'fixtureOperation', { value: name })
    return invoke
  }
  const database = { prepare: () => ({ all: () => [{ path: '/fonts' }] }) }
  function factory(name, options) {
    if (!constructors.has(name)) constructors.set(name, [])
    constructors.get(name).push(options)
    const specific = {}
    if (name === 'createMainLoggingBootstrap') {
      specific.appendStartupLog = operation('log')
      specific.logPath = () => path.posix.join(options.logsDir(), 'launch.log')
    }
    if (name === 'createAppDataPaths') Object.assign(specific, {
      dataPath: (...parts) => path.posix.join('/application/data', ...parts),
      dataRoot: () => '/application/data', appInstallDir: () => '/application', exists: async () => true,
    })
    if (name === 'createMainLicenseBootstrap') Object.assign(specific, {
      licenseRuntime: { getStatus: operation('license.status') },
      featureGateRuntime: { assertFeatureForChannel: operation('license.assert') },
    })
    if (name === 'createMainBackgroundRuntime') specific.schedulerRuntime = { activeCount: () => 2 }
    if (name === 'createScanOrchestrator') Object.assign(specific, { isActive: () => true, activeJobId: () => 'scan-job' })
    if (name === 'createInstallStatusRefreshStarterRuntime') specific.activeInstallStatusRefreshJob = () => 'refresh-job'
    if (name === 'createStorageProfileRuntime') specific.storageProfileForPath = file => ({ type: 'ssd', path: file })
    if (name === 'createLibraryRuntime') Object.assign(specific, {
      openLibraryDb: operation('library.open', async () => database),
      getOpenLibraryDb: operation('library.get', () => database),
      saveLibrary: operation('library.save', async () => state.saveSucceeds),
    })
    if (name === 'createRootIndexCoordinator') specific.findFontItemInRootIndexes = operation('index.find', async () => ({ id: 'font' }))
    if (name === 'createMergedIndexPageRuntime') specific.checkMergedIndexExternalChanges = operation('merged.external', async () => ({ changed: true }))
    if (name === 'createMainWindowAndFontRuntime') Object.assign(specific, {
      windowsFontsDir: () => '/windows/fonts', currentUserFontsDir: () => '/user/fonts',
    })
    if (name === 'createMainPerformanceRuntime') specific.withGlobalIo = (_label, fn) => fn()
    return new Proxy(specific, { get(target, key) {
      if (typeof key !== 'string' || key === 'then') return undefined
      if (!(key in target)) target[key] = operation(`${name}.${key}`)
      return target[key]
    } })
  }
  function leaf() {
    const values = {}
    return new Proxy(values, { get(target, key) {
      if (key === '__esModule') return true
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      if (key === 'registerMainProcessRuntime') return options => { state.payload = options }
      if (key === 'normalizeWatchedFontFolders') return folders => folders
      if (key === 'normalizePathForCacheCompare') return value => value
      if (key === 'sha1') return value => require('node:crypto').createHash('sha1').update(value).digest('hex')
      target[key] = key.startsWith('create') ? options => factory(key, options) : operation(key)
      return target[key]
    } })
  }
  const actual = new Set([
    'src/main/bootstrap/mainIndexConstants.ts', 'src/main/cache/constants.ts',
    'src/main/app/appRuntimeConfig.ts', 'src/main/cache/cachePaths.ts', 'src/main/db/appDatabasePaths.ts',
  ].map(file => path.join(root, file)))
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports
    const real = file === entry || actual.has(file) || (file.startsWith(bootstrap + path.sep) && /main(?:Core|Data\w*)CompositionRuntime\.ts$|mainRuntimeRegistrationPayload\.ts$/.test(file))
    if (!real) { const exports = leaf(); modules.set(file, { exports }); return exports }
    const source = (overrides.get(file) ?? fs.readFileSync(file, 'utf8')).replace(/\r\n/g, '\n')
    const code = ts.transpileModule(source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href)), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText
    const module = { exports: {} }
    modules.set(file, module)
    const requireLocal = spec => {
      // Recorded fixture paths are portable; real Windows path policy is
      // exercised by the separate POLICY/READ/PHYSICAL diagnostics.
      if (spec === 'node:path') return path.posix
      if (spec.startsWith('node:')) return require(spec)
      const target = path.resolve(path.dirname(file), spec)
      return load(target.endsWith('.ts') ? target : target + '.ts')
    }
    const context = { exports: module.exports, module, require: requireLocal, __filename: file, __dirname: path.dirname(file),
      process: { env: {}, platform: 'win32', versions: { node: 'fixture' }, pid: 1 }, console,
      setTimeout: (_fn, ms) => { record('timer', [ms]); return { unref: () => record('timer.unref', []) } },
      setImmediate: fn => fn(), Buffer, URL,
    }
    vm.runInNewContext(code, context, { filename: file, timeout: 5000 })
    for (const [name, implementation] of Object.entries(module.exports)) {
      if (/^createMain(?:Core|Data\w*)CompositionRuntime$/.test(name)) {
        module.exports[name] = (...args) => {
          assert(!state.compositions.has(name), `${name} was constructed twice`)
          const runtime = implementation(...args)
          state.compositions.set(name, runtime)
          return runtime
        }
      }
    }
    return module.exports
  }
  state.load = load
  state.options = name => { const entries = constructors.get(name); assert.equal(entries?.length, 1, `${name} must have one owner`); return entries[0] }
  state.reset = () => { calls.length = 0 }
  state.clean = clean
  return state
}

async function observeBootstrap(overrides = new Map()) {
  const h = createHarness(overrides)
  h.load(entry)
  const p = h.payload
  assert(p, 'entry did not register the application')
  const observations = {
    registrations: Object.keys(p).sort(),
    owners: [...h.constructors].map(([name, instances]) => [name, instances.length]).sort(),
    construction: h.clean(h.calls),
    paths: {}, flows: {},
  }
  const pathOptions = h.options('createSqliteRuntime')
  observations.paths.backups = pathOptions.backupsRootPath()
  observations.paths.corrupt = pathOptions.corruptDatabasesRootPath()
  const previewOptions = h.options('createPreviewRuntime')
  observations.paths.preview = previewOptions.previewSqlitePath()
  observations.paths.previewImages = previewOptions.localPreviewImageDir()
  observations.paths.log = p.logPath()
  observations.paths.library = h.options('createLibraryRuntime').librarySqlitePath()
  for (const [name, action] of Object.entries({
    saveSuccess: async () => { h.saveSucceeds = true; return p.saveLibrary({ folders: ['/fonts'] }) },
    saveFailure: async () => { h.saveSucceeds = false; return p.saveLibrary({ folders: ['/fonts'] }) },
    externalChange: () => p.checkSharedMetadataUpdates('poll'),
    mergedCommit: () => h.options('createMergedIndexPageRuntime').onMergedIndexCommitted({ reason: 'fixture', sequence: 1, revision: 2 }),
    authorization: async () => {
      const options = h.options('createMainWindowAndFontRuntime')
      return [await options.loadWatchedFontRoots(), await options.isMainProcessIndexedFont({ comparePath: '/fonts/font.ttf' })]
    },
    activity: () => {
      const options = h.options('createMainPerformanceRuntime')
      return [options.isIndexingActive(), options.activeScanJobId(), options.isInstallStatusRefreshActive(), options.activeBackgroundTaskCount(), options.storageProfileForPath('/fonts')]
    },
    daemonSignal: () => h.options('createRustCoreWorkerRuntime').onDaemonDomainEvent({ event: 'fixture' }),
    localSignal: () => h.options('createLibraryRuntime').onLocalTagsMutationStateSignal({ changedIds: ['font'] }),
    sharedSignal: () => h.options('createSharedFontMetadataRuntime').onSharedMetadataMutationStateSignal({ changedIds: ['font'] }),
    previewTasks: async () => {
      for (const [key, args] of Object.entries({
        previewTaskKey: ['task'], completeBackgroundTask: ['task', 'done'],
        skipBackgroundTask: ['task', 'skipped'],
        upsertBackgroundTask: ['task', 'preview', 1, '{}', 'pending', 'queued', { maxAttempts: 3 }],
        startBackgroundTask: ['task', 'started'],
        heartbeatBackgroundTask: ['task', 1, 'heartbeat'], failBackgroundTask: ['task', 'failure', 'fixture stack'],
      })) {
        await previewOptions[key](...args)
      }
    },
    schemaAudit: () => p.runStartupCriticalSchemaAudit(),
    lifecycle: async () => {
      for (const key of ['ensureDataRootSync', 'beginStartupSessionSync', 'migrateLegacyUserDataIfNeeded', 'initializeCacheArchitecture', 'diagnoseRustCoreWorker', 'registerFontProtocol', 'startPerformanceLogSampler', 'createWindow', 'stopBackgroundTaskScheduler', 'flushActivationInstallStatusSave', 'stopFolderWatchers', 'stopPerformanceLogSampler', 'flushPerformanceLogs', 'flushStartupLogAsync', 'stopRustCoreDaemon', 'dbQueryWorkerShutdown', 'markCleanShutdownSync', 'flushStartupLogSync']) await p[key]('fixture')
    },
    closeDatabases: () => h.options('createFolderWatcherRuntime').closeRuntimeDatabases(),
    closeAfterPreviewFailure: () => {
      h.failOperations.add('createPreviewDbRuntime.closePreviewDb')
      try { h.options('createFolderWatcherRuntime').closeRuntimeDatabases() }
      finally { h.failOperations.clear() }
    },
  })) {
    h.reset()
    const result = await action()
    observations.flows[name] = { result: h.clean(result), calls: h.clean(h.calls) }
  }
  return observations
}

module.exports = { createHarness, observeBootstrap, root, entry, bootstrap }
