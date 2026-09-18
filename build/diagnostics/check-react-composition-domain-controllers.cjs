#!/usr/bin/env node
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { declarations, hash } = require('./check-browse-controller.cjs')

const root = path.resolve(__dirname, '../..')
const fixture = require('./fixtures/react-composition-domain-controllers.fixture.json')
const appPath = 'src/renderer/src/App.tsx'
const libraryControllerPath = 'src/renderer/src/runtime/app/useLibraryController.ts'
const operationsControllerPath = 'src/renderer/src/runtime/app/useFontOperationsController.ts'
const developerControllerPath = 'src/renderer/src/runtime/app/useDeveloperController.ts'
const controllerPaths = [libraryControllerPath, operationsControllerPath, developerControllerPath]
const stateNames = Object.keys(fixture.states)
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')

function sourceFile(relativePath, text) {
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function callNames(relativePath, text, acceptedNames) {
  const file = sourceFile(relativePath, text)
  const result = []
  function walk(node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(file)
      if (acceptedNames.has(name)) result.push(name)
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return result
}

function returnedKeys(relativePath, text, functionName) {
  const file = sourceFile(relativePath, text)
  let target = null
  function find(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) target = node
    ts.forEachChild(node, find)
  }
  find(file)
  assert(target, `missing controller ${functionName}`)
  let largest = []
  function walk(node) {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const keys = node.expression.properties.map((property) => {
        if (ts.isShorthandPropertyAssignment(property)) return property.name.text
        if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) return property.name?.getText(file).replace(/^['"]|['"]$/g, '')
        return null
      }).filter(Boolean)
      if (keys.length > largest.length) largest = keys
    }
    ts.forEachChild(node, walk)
  }
  walk(target)
  return new Set(largest)
}

function checkBaseline() {
  const baselineApp = childProcess.execFileSync('git', ['show', `${fixture.baseline}:${appPath}`], { cwd: root, encoding: 'utf8' })
  assert.deepEqual(declarations(baselineApp), fixture.states, 'AT-6.4 immutable App state/ref baseline changed')
}

function checkStructure(overrides = new Map()) {
  const get = (relativePath) => String(overrides.get(relativePath) ?? read(relativePath)).replace(/\r\n/g, '\n')
  const app = get(appPath)
  const seen = new Set()

  for (const [relativePath, expectedNames] of Object.entries(fixture.owners)) {
    const owned = declarations(get(relativePath))
    const extra = fixture.additionalOwners?.[relativePath] || {}
    assert.deepEqual(Object.fromEntries(Object.entries(owned).filter(([name]) => Object.hasOwn(extra, name))), extra, `${relativePath} U-05 owner initialization changed`)
    assert.deepEqual(Object.keys(owned).filter(name => !Object.hasOwn(extra, name)), expectedNames, `${relativePath} state/ref ownership order changed`)
    for (const name of expectedNames) {
      assert.equal(owned[name], fixture.states[name], `${relativePath} changed frozen initializer ${name}`)
      assert(!seen.has(name), `duplicate AT-6.4 controller owner: ${name}`)
      seen.add(name)
    }
  }
  assert.equal(seen.size, 42, 'not all 42 AT-6.4 state/ref slots have one controller owner')

  const appDeclarations = declarations(app)
  for (const name of stateNames) assert(!Object.hasOwn(appDeclarations, name), `App retained duplicate AT-6.4 owner ${name}`)
  for (const relativePath of controllerPaths) {
    const hookName = path.basename(relativePath, '.ts')
    assert.equal((app.match(new RegExp(`= ${hookName}\\(`, 'g')) || []).length, 1, `${hookName} must be composed once`)
  }
  assert.deepEqual(
    callNames(appPath, app, new Set(fixture.controllerCallOrder)),
    fixture.controllerCallOrder,
    'controller composition order changed'
  )

  for (const [relativePath, expectedHash] of Object.entries(fixture.sourceHashes)) {
    assert.equal(hash(get(relativePath)), expectedHash, `frozen AT-6.4 lifecycle behavior changed: ${relativePath}`)
  }

  for (const forbidden of [
    'fontWriteQueue',
    'fontWriteFlushTimerRef',
    'fontWriteRetryTimerRef',
    'fontWriteFlushActiveRef',
    'lazyInstallQueue',
    'knownInstallStatusIds',
    'activeOperationFontIds',
    'autoInstallStatusRefreshStartedRef',
    'databaseRefreshTimerRef',
    'sharedMetadataSyncInFlightRef',
    'developerStatusRefreshInFlightRef'
  ]) assert(!new RegExp(`\\b${forbidden}\\b`).test(app), `App leaked mutable controller port ${forbidden}`)

  const library = get(libraryControllerPath)
  const operations = get(operationsControllerPath)
  const developer = get(developerControllerPath)
  const libraryReturns = returnedKeys(libraryControllerPath, library, 'useLibraryController')
  const operationsReturns = returnedKeys(operationsControllerPath, operations, 'useFontOperationsController')
  const developerReturns = returnedKeys(developerControllerPath, developer, 'useDeveloperController')
  for (const name of ['databaseRefreshTimerRef', 'initialLibraryLoadStartedRef', 'sharedMetadataSyncInFlightRef', 'lastSharedMetadataSyncCheckAtRef', 'pendingRefreshScope', 'activeFilterKindRef']) {
    assert(!libraryReturns.has(name), `Library controller exposed mutable owner ${name}`)
  }
  for (const name of fixture.owners[operationsControllerPath].filter((entry) => !entry.startsWith('['))) {
    assert(!operationsReturns.has(name), `Operations controller exposed mutable owner ${name}`)
  }
  assert(!developerReturns.has('developerStatusRefreshInFlightRef'), 'Developer controller exposed its in-flight owner')
  assert(/libraryLoadedRef: libraryLoadedRef as Readonly<\{ current: boolean \}>/.test(library), 'Library loaded state must be exported read-only')

  for (const forbidden of [
    'createRendererFontWriteQueueRuntime',
    'createFontSystemActionRuntime',
    'createFontInstallStatusRuntime',
    'createFontLibraryIndexActionRuntime',
    'useLibraryAutosaveRuntime',
    'refreshDeveloperStatusDetailsRuntime'
  ]) assert(!new RegExp(`\\b${forbidden}\\b`).test(app), `App retained ${forbidden} implementation ownership`)

  assert(library.includes('onPersistenceRecovered: refreshDatabaseDerivedState'), 'autosave recovery lost database invalidation')
  assert(library.includes('useSharedMetadataSyncForegroundRuntime({'), 'Library controller lost foreground shared metadata lifecycle')
  assert(operations.includes('scheduleDatabaseDerivedStateRefresh: options.library.scheduleDatabaseDerivedStateRefresh'), 'font writes lost the Library refresh command')
  assert(operations.indexOf('createRendererFontWriteQueueRuntime({') < operations.indexOf('useAppFlushOnUnloadRuntime({'), 'close lifecycle must bind after the write queue exists')
  assert(operations.includes('clearDatabaseRefreshTimer: options.library.clearDatabaseRefreshTimer'), 'close lifecycle leaked or lost the database timer cleanup command')
  assert.equal((developer.match(/if \(!options\.enabled\) return/g) || []).length, 2, 'Developer controller lost a production lazy guard')
  assert(developer.includes('enabled: options.enabled'), 'background diagnostics are not gated by the development flag')
}

function createHookHarness() {
  let cursor = 0
  const slots = []
  const effects = []
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useMemo(factory) { return factory() },
    useCallback(callback) { return callback },
    useEffect(effect) { effects.push(effect); effect() },
    useLayoutEffect(effect) { effects.push(effect); effect() }
  }
  return {
    hooks,
    slots,
    effects,
    render(hook, options) {
      cursor = 0
      return hook(options)
    }
  }
}

function createLoader({ hooks, mocks = {}, globals = {} }) {
  const modules = new Map()
  function load(relativePath) {
    if (modules.has(relativePath)) return modules.get(relativePath)
    const exports = {}
    modules.set(relativePath, exports)
    const code = ts.transpileModule(read(relativePath), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const localRequire = (id) => {
      const scoped = `${relativePath}::${id}`
      if (Object.hasOwn(mocks, scoped)) return mocks[scoped]
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id === 'react') return hooks
      if (id.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), id))
        return load(path.posix.extname(resolved) ? resolved : `${resolved}.ts`)
      }
      return {}
    }
    const context = vm.createContext({ console, Promise, Set, Map, Date, Math, ...globals })
    vm.runInContext(`(function(require,exports){${code}\n})`, context)(localRequire, exports)
    return exports
  }
  return load
}

async function checkLibraryBehavior() {
  const harness = createHookHarness()
  const calls = {}
  const cleared = []
  const database = {
    setDatabasePageResult() {},
    setDatabaseQueryResult() {},
    setDatabaseFontMetrics() {},
    databasePageRequestSeqRef: { current: 4 },
    fontMetricsRequestSeqRef: { current: 7 }
  }
  const mocks = {
    '../../appRuntime': {
      createEmptyLibrary: () => ({ folders: [], folderAliases: {}, folderNodes: [], collections: [], tags: [], localCollections: [], localTags: [], fonts: {}, previewText: '', previewMode: 'sample' }),
      normalizeFontMetricsResult: (value) => value,
      requestIdleWindow: (callback) => { callback(); return 1 }
    },
    '../../databaseDerivedStateRuntime': {
      refreshDatabaseDerivedStateRuntime: (options) => { calls.refresh = options },
      scheduleDatabaseDerivedStateRefreshRuntime: (options) => { calls.schedule = options }
    },
    '../../sharedMetadataSyncRuntime': { runSharedMetadataSyncCheckRuntime: (options) => { calls.shared = options; return Promise.resolve() } },
    '../lease-lock/leaseLockConflictNoticeRuntime': {
      parseLeaseLockConflictNotice: (status) => status === 'conflict' ? { title: 'conflict' } : null
    },
    './effects/useInitialLibraryShellRuntime': { useInitialLibraryShellRuntime: (options) => { calls.initial = options } },
    './effects/useLibraryAutosaveRuntime': {
      libraryShellPersistenceKey: () => 'shell-key',
      useLibraryAutosaveRuntime: (options) => ({
        setLibrary: options.setLibrary,
        getCurrentLibrary: () => options.library,
        commitLibraryUpdate: (update) => typeof update === 'function' ? update(options.library) : update,
        saveLibraryImmediately: async () => true,
        flushLibraryPersistence: async () => true
      })
    },
    './effects/useSharedMetadataSyncForegroundRuntime': { useSharedMetadataSyncForegroundRuntime: (options) => { calls.foreground = options } }
  }
  const load = createLoader({
    hooks: harness.hooks,
    mocks,
    globals: { window: { clearTimeout: (id) => cleared.push(id), setTimeout: () => 1 } }
  })
  const useLibraryController = load(libraryControllerPath).useLibraryController
  const options = { hfm: {}, database, rendererUserActive: () => false, appendDeveloperStatus() {} }
  let controller = harness.render(useLibraryController, options)
  assert.equal(harness.slots.length, 14)
  controller.refreshDatabaseDerivedState()
  assert.equal(calls.refresh.databasePageRequestSeqRef, database.databasePageRequestSeqRef)
  assert.equal(calls.refresh.fontMetricsRequestSeqRef, database.fontMetricsRequestSeqRef)
  controller.scheduleDatabaseDerivedStateRefresh(88)
  assert.equal(calls.schedule.delay, 88)
  assert.equal(calls.schedule.rendererUserActive, options.rendererUserActive)
  calls.schedule.timerRef.current = 33
  controller.clearDatabaseRefreshTimer()
  assert.deepEqual(cleared, [33])
  assert(calls.initial.libraryLoadedRef && typeof calls.initial.libraryLoadedRef.current === 'boolean')
  assert.equal(calls.foreground.enabled, false)
  controller.setStatus('conflict')
  controller = harness.render(useLibraryController, options)
  controller = harness.render(useLibraryController, options)
  assert.equal(controller.leaseLockConflictNotice.title, 'conflict')
  const pending = [], metricWrites = []
  database.setDatabaseFontMetrics = value => metricWrites.push(value)
  options.hfm.getFontMetrics = () => new Promise(resolve => pending.push(resolve))
  controller.refreshDatabaseMetricsNow()
  controller.refreshDatabaseMetricsNow()
  pending[0]({ activeCount: 99 }); await Promise.resolve(); await Promise.resolve()
  assert.equal(metricWrites.length, 0, 'direct metrics refresh accepted older request')
  load('src/renderer/src/fontUserIntentRuntime.ts').markActiveIntent({ id: 'a', active: false })
  pending[1]({ activeCount: 88 }); await Promise.resolve(); await Promise.resolve()
  assert.equal(metricWrites.length, 0, 'direct metrics refresh overwrote newer operation')
  controller.refreshDatabaseMetricsNow()
  pending[2]({ activeCount: 0 }); await Promise.resolve(); await Promise.resolve()
  assert.equal(metricWrites[0].activeCount, 0)

}

async function checkOperationsBehavior() {
  const harness = createHookHarness()
  const calls = {}
  const protectionWrites = []
  let liveLibrary = { folders: ['root'], fonts: { a: { id: 'a', deleteProtected: false } } }
  const noOp = () => {}
  const asyncNoOp = async () => {}
  const queueRuntime = {
    clearTimer: noOp,
    queueLocalTagsWrite: noOp,
    queueSharedTagsWrite: noOp,
    queueFavoriteWrite: noOp,
    queueProtectionWrite: (font, protect) => protectionWrites.push([font.id, protect]),
    flush: async () => true
  }
  const systemRuntime = {
    updateFont: noOp,
    toggleFontFavorite: asyncNoOp,
    fontsForTag: () => [],
    installFontByCard: asyncNoOp,
    removeFontByCard: asyncNoOp,
    deleteFontsBatch: asyncNoOp,
    uninstallFontsBatch: asyncNoOp,
    activateFontByCard: asyncNoOp,
    activateFontsBatch: asyncNoOp,
    deactivateFontByCard: asyncNoOp,
    deactivateFontsBatch: asyncNoOp
  }
  const installRuntime = {
    refreshInstallStatus: async () => 0,
    startBackgroundInstallStatusRefresh: asyncNoOp,
    stopLazyInstallStatusDetect: noOp
  }
  const indexRuntime = {
    loadCacheStats: asyncNoOp,
    readPhysicalFolderTree: async () => ({}),
    clearAllCacheAction: asyncNoOp,
    addFolder: asyncNoOp,
    cancelIndexing: asyncNoOp,
    rescan: asyncNoOp,
    rebuildScanCache: asyncNoOp,
    refreshFolderTarget: asyncNoOp
  }
  const mocks = {
    '../../appRuntime': {
      createEmptyQueuedFontWriteState: () => ({ localTags: new Map(), sharedTags: new Map(), favorite: new Map(), protection: new Map() }),
      rendererMemoryPressure: () => 'normal',
      USER_ACTIVITY_IDLE_WINDOW_MS: 900,
      USER_ACTIVITY_REPORT_INTERVAL_MS: 100,
      WRITE_BEHIND_DELAY_MS: 1,
      WRITE_BEHIND_MAX_BUFFER_BYTES: 2,
      WRITE_BEHIND_MAX_ITEMS: 3
    },
    '../../fontWriteQueueRuntime': { createRendererFontWriteQueueRuntime: (options) => { calls.queue = options; return queueRuntime } },
    '../../rendererActivityRuntime': { isRendererUserActive: () => false, reportRendererUserActivity: (options) => { calls.activityReport = options } },
    '../library/fontLibraryIndexActionRuntime': { createFontLibraryIndexActionRuntime: (options) => { calls.index = options; return indexRuntime } },
    '../system/fontInstallStatusRuntime': { createFontInstallStatusRuntime: (options) => { calls.install = options; return installRuntime } },
    '../system/fontSystemActionRuntime': { createFontSystemActionRuntime: (options) => { calls.system = options; return systemRuntime } },
    './effects/useAppFlushOnUnloadRuntime': { useAppFlushOnUnloadRuntime: (options) => { calls.close = options } },
    './effects/useInstallStatusProgressEventRuntime': { useInstallStatusProgressEventRuntime: (options) => { calls.progress = options } },
    './effects/useRendererActivityRuntime': { useRendererActivityRuntime: (options) => { calls.activity = options } },
    './useAutoInstallStatusRefreshRuntime': { useAutoInstallStatusRefreshRuntime: (options) => { calls.auto = options } },
    './effects/useIndexOperationRunRuntime': { useIndexOperationRunRuntime: () => ({ nextIndexOperationRunId: () => 1, isCurrentIndexOperation: () => true }) }
  }
  const load = createLoader({ hooks: harness.hooks, mocks, globals: { window: { setTimeout: () => 1, clearTimeout() {} } } })
  const useFontOperationsController = load(operationsControllerPath).useFontOperationsController
  const setLibrary = (update) => { liveLibrary = typeof update === 'function' ? update(liveLibrary) : update }
  const controller = harness.render(useFontOperationsController, {
    hfm: {},
    library: {
      library: liveLibrary,
      getCurrentLibrary: () => liveLibrary,
      setLibrary,
      commitLibraryUpdate: (update) => { setLibrary(update); return liveLibrary },
      saveLibraryImmediately: async () => true,
      flushLibraryPersistence: async () => true,
      setStatus: noOp,
      selectedFolderId: '',
      setSelectedFolderId: noOp,
      indexingActive: false,
      setIndexingActive: noOp,
      setCacheStats: noOp,
      clearDatabaseRefreshTimer: noOp,
      refreshDatabaseDerivedState: noOp,
      scheduleDatabaseDerivedStateRefresh: noOp,
      refreshDatabaseMetricsNow: noOp
    },
    database: {
      databaseFontMetrics: null,
      setDatabasePageResult: noOp,
      setDatabaseQueryResult: noOp,
      setDatabaseFontMetrics: noOp,
      setDatabaseRefreshToken: noOp
    },
    selection: {
      selectedFontId: '',
      getCurrentSelectedFontId: () => '',
      setSelectedFontIds: noOp,
      setSelectedFontId: noOp,
      setDetailVisible: noOp,
      setContextMenu: noOp
    },
    index: {
      captureFontScrollSnapshot: () => ({}),
      restoreFontScrollSnapshot: noOp,
      resetPreviewRuntimeState: noOp,
      isBadFontRecord: () => false
    },
    sidebarPage: 'library',
    clearFontListScrollIdleTimer: noOp,
    appendDeveloperStatus: noOp
  })
  assert.equal(harness.slots.length, 22)
  assert.equal(calls.queue.scheduleDatabaseDerivedStateRefresh, noOp)
  assert.equal(calls.install.knownInstallStatusIds, calls.index.knownInstallStatusIds)
  assert.equal(calls.index.autoInstallStatusRefreshStartedRef, calls.progress.autoInstallStatusRefreshStartedRef)
  assert.equal(calls.index.autoInstallStatusRefreshStartedRef, calls.auto.startedRef)
  assert.equal(calls.close.flushFontWriteQueue, queueRuntime.flush)
  assert.equal(calls.close.flushLibraryPersistence instanceof Function, true)
  await controller.toggleFontDeleteProtection(['a'], true)
  assert.equal(liveLibrary.fonts.a.deleteProtected, true)
  assert.deepEqual(protectionWrites, [['a', true]])
  const other = { ...liveLibrary.fonts.a, id: 'b', favorite: true, tagNames: ['shared'], localTagNames: ['local'] }
  liveLibrary = { ...liveLibrary, __partialFonts: true }
  await controller.toggleFontDeleteProtection(['a', 'b', 'b'], false, [other])
  assert.equal(liveLibrary.fonts.b.deleteProtected, false)
  assert.equal(liveLibrary.fonts.b.favorite, true)
  assert.deepEqual(liveLibrary.fonts.b.tagNames, ['shared'])
  assert.deepEqual(liveLibrary.fonts.b.localTagNames, ['local'])
  assert.deepEqual(protectionWrites, [['a', true], ['a', false], ['b', false]])
  await controller.toggleFontDeleteProtection(['a', 'missing'], true)
  assert.equal(protectionWrites.length, 3, 'missing targets must block the whole protection command')
  assert.equal(liveLibrary.fonts.a.deleteProtected, false)
  liveLibrary = { ...liveLibrary, __partialFonts: false }
  await controller.toggleFontDeleteProtection(['removed'], true, [{ ...other, id: 'removed' }])
  assert.equal(protectionWrites.length, 3, 'a complete authoritative library must not resurrect deleted rows')
  assert.equal(liveLibrary.fonts.removed, undefined)

  calls.install.lazyInstallQueue.current = [{ id: 'a' }, { id: 'b' }]
  calls.install.queuedLazyInstallIds.current.add('a')
  calls.install.queuedLazyInstallIds.current.add('b')
  calls.install.seenLazyInstallIds.current.add('a')
  calls.install.seenLazyInstallIds.current.add('b')
  controller.removeFontIds(new Set(['a']))
  assert.deepEqual(calls.install.lazyInstallQueue.current.map((font) => font.id), ['b'])
  assert.deepEqual(Array.from(calls.install.queuedLazyInstallIds.current), ['b'])
  assert.deepEqual(Array.from(calls.install.seenLazyInstallIds.current), ['b'])
}

async function checkCloseFlushBehavior() {
  const order = []
  let closeRequest
  let beforeUnload
  const hooks = {
    useRef: (value) => ({ current: value }),
    useEffect: (effect) => { effect() }
  }
  const windowObject = {
    addEventListener(type, handler) { if (type === 'beforeunload') beforeUnload = handler },
    removeEventListener() {}
  }
  const hfm = {
    onWindowFlushBeforeClose(handler) { closeRequest = handler; return () => {} },
    completeWindowCloseFlush(requestId, saved) { order.push(`complete:${requestId}:${saved}`) }
  }
  const load = createLoader({ hooks, globals: { window: windowObject } })
  load('src/renderer/src/runtime/app/effects/useAppFlushOnUnloadRuntime.ts').useAppFlushOnUnloadRuntime({
    hfm,
    clearDatabaseRefreshTimer: () => order.push('clear-database'),
    clearFontListScrollIdleTimer: () => order.push('clear-preview'),
    clearQueuedFontWriteTimer: () => order.push('clear-write'),
    flushFontWriteQueue: async () => { order.push('flush-write'); return true },
    flushLibraryPersistence: async () => { order.push('flush-library'); return true }
  })
  assert.equal(typeof beforeUnload, 'function')
  closeRequest({ requestId: 'r1' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['clear-write', 'clear-database', 'clear-preview', 'flush-write', 'flush-library', 'complete:r1:true'])
}

async function checkDeveloperLazyBehavior() {
  const disabledHarness = createHookHarness()
  let refreshCalls = 0
  let backgroundOptions
  const mocks = {
    '../../rendererDeveloperStatusRuntime': {
      appendDeveloperStatusEntry: (prev, source) => [{ source }, ...prev],
      refreshDeveloperStatusDetailsRuntime: () => { refreshCalls += 1; return Promise.resolve() }
    },
    './effects/useBackgroundTaskEventsRuntime': { useBackgroundTaskEventsRuntime: (options) => { backgroundOptions = options } },
    './effects/useRendererDeveloperStatusLogRuntime': { useRendererDeveloperStatusLogRuntime() {} }
  }
  let load = createLoader({ hooks: disabledHarness.hooks, mocks })
  let controller = disabledHarness.render(load(developerControllerPath).useDeveloperController, { enabled: false, hfm: {}, status: 'ready' })
  controller.appendDeveloperStatus('status', 'hidden')
  await controller.refreshDeveloperStatusDetails()
  assert.equal(refreshCalls, 0)
  assert.equal(disabledHarness.slots[0].length, 0)
  assert.equal(backgroundOptions.enabled, false)

  const enabledHarness = createHookHarness()
  let resolveRefresh
  const pending = new Promise((resolve) => { resolveRefresh = resolve })
  mocks['../../rendererDeveloperStatusRuntime'].refreshDeveloperStatusDetailsRuntime = () => { refreshCalls += 1; return pending }
  load = createLoader({ hooks: enabledHarness.hooks, mocks })
  controller = enabledHarness.render(load(developerControllerPath).useDeveloperController, { enabled: true, hfm: {}, status: 'ready' })
  const first = controller.refreshDeveloperStatusDetails()
  const second = controller.refreshDeveloperStatusDetails()
  assert.equal(first, second)
  assert.equal(refreshCalls, 1)
  resolveRefresh()
  await first
}

async function main() {
  checkBaseline()
  checkStructure()
  await checkLibraryBehavior()
  await checkOperationsBehavior()
  await checkCloseFlushBehavior()
  await checkDeveloperLazyBehavior()

  const operations = read(operationsControllerPath)
  assert.throws(() => checkStructure(new Map([[
    operationsControllerPath,
    operations.replace('const [cacheMenuOpen, setCacheMenuOpen] = useState(false)', 'const [cacheMenuOpen, setCacheMenuOpen] = useState(true)')
  ]])), 'changed Operations default escaped ownership gate')
  const app = read(appPath)
  assert.throws(() => checkStructure(new Map([[appPath, `${app}\nfontWriteQueue.current = null\n`]])), 'raw write queue leak escaped port gate')
  const developer = read(developerControllerPath)
  assert.throws(() => checkStructure(new Map([[
    developerControllerPath,
    developer.replace('if (!options.enabled) return\n', '')
  ]])), 'production developer eager path escaped guard gate')
  checkStructure(new Map(controllerPaths.map((relativePath) => [relativePath, read(relativePath).replace(/\n/g, '\r\n')])))
  console.log('[diagnostics:react-composition-domain-controllers] 42 state/ref owners, write refresh, close flush, protection/lazy cleanup, developer laziness, narrow ports, mutations and CRLF passed')
}

main().catch((error) => {
  console.error(`[diagnostics:react-composition-domain-controllers] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
