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


function replaceOnce(text, current, previous, label) {
  assert.equal(text.split(current).length, 2, `status migration anchor ${label}`)
  return text.replace(current, previous)
}

function legacyStatusOwners(text) {
  const added = [
    '  const statusRef = useRef(status)\n',
    '  const [actionStatus, setActionStatus] = useState<string | null>(null)\n',
    "  const actionStatusSourceRef = useRef<'operation' | 'load' | 'save' | 'write' | 'query' | null>(null)\n"
  ]
  for (const declaration of added) text = replaceOnce(text, declaration, '', declaration)
  return replaceOnce(text, "const [status, setStatusState] = useState('准备就绪')", "const [status, setStatus] = useState('准备就绪')", 'status setter')
}

// Only the explicit feedback extension is reversed. The original queue algorithm,
// retry order, persistence receipt and every historical token hash stay frozen.
function legacyWriteFeedback(text) {
  const additions = [
    "// Feedback recovery follows the same queue across renders. Unexpected exceptions\n// have no confirmed pending-write receipt and remain visible until dismissed.\nconst failedFieldsByQueue = new WeakMap<QueueRef, Map<WriteField, 'retry' | 'uncertain'>>()\n",
    '  reportError?: (status: string) => void\n  onRecovered?: () => void\n',
    "  let failedFields = failedFieldsByQueue.get(options.queueRef)\n  if (!failedFields) {\n    failedFields = new Map()\n    failedFieldsByQueue.set(options.queueRef, failedFields)\n  }\n  const feedbackFailures = failedFields\n",
    '    let confirmedWrites = 0\n',
    '        confirmedWrites += result.wroteCount\n',
    "          if (feedbackFailures.get(field) !== 'uncertain') feedbackFailures.set(field, 'retry')\n",
    "      if (confirmedWrites > 0 && feedbackFailures.get(field) === 'retry') feedbackFailures.delete(field)\n",
    "      feedbackFailures.set(field, 'uncertain')\n",
    '      if (reportRecovery && confirmedWrites > 0 && !feedbackFailures.size && !fieldTasks.size && !queuedFontWriteCount(options.queueRef.current)) options.onRecovered?.()\n',
    '        if (changedFields.size && !feedbackFailures.size && !queuedFontWriteCount(options.queueRef.current) && !fieldTasks.size) options.onRecovered?.()\n'
  ]
  for (const addition of additions) text = replaceOnce(text, addition, '', addition)
  text = replaceOnce(text, "refresh: RendererFontWriteQueueRuntimeOptions['scheduleDatabaseDerivedStateRefresh'] = options.scheduleDatabaseDerivedStateRefresh, reportRecovery = true", "refresh: RendererFontWriteQueueRuntimeOptions['scheduleDatabaseDerivedStateRefresh'] = options.scheduleDatabaseDerivedStateRefresh", 'field recovery owner')
  text = replaceOnce(text, 'flushField(field, reason, refresh, reportRecovery)', 'flushField(field, reason, refresh)', 'recursive field recovery')
  text = replaceOnce(text, 'flushField(field, reason, collectRefresh, false)', 'flushField(field, reason, collectRefresh)', 'full drain recovery')
  const fullError = "    })().catch((error) => {\n      // The merged refresh follows all field writes; only its success can\n      // retire earlier failure feedback for this complete drain.\n      for (const field of WRITE_FIELDS) feedbackFailures.set(field, 'uncertain')\n      ;(options.reportError || options.setStatus)(`后台写入队列异常：${error instanceof Error ? error.message : String(error)}；将继续重试。`)\n      throw error\n    }).finally(() => {\n      options.activeRef.current = false"
  text = replaceOnce(text, fullError, '    })().finally(() => {\n      options.activeRef.current = false', 'full drain failure feedback')
  assert.equal(text.split(';(options.reportError || options.setStatus)').length, 3, 'two field write-error feedback sites')
  return text.replaceAll(';(options.reportError || options.setStatus)', 'options.setStatus')
}

function checkStructure(overrides = new Map()) {
  const get = (relativePath) => String(overrides.get(relativePath) ?? read(relativePath)).replace(/\r\n/g, '\n')
  const app = get(appPath)
  const seen = new Set()

  // Keep the historical 42-slot fixture immutable, but retire the one state
  // whose value had no reader, plus its newer single-flight request owner.
  const retiredState = '[, setCacheStats]'
  assert(Object.hasOwn(fixture.states, retiredState), 'retired owner missing from historical baseline')
  for (const [relativePath, frozenNames] of Object.entries(fixture.owners)) {
    const expectedNames = frozenNames.filter(name => name !== retiredState)
    const owned = declarations(relativePath === libraryControllerPath ? legacyStatusOwners(get(relativePath)) : get(relativePath))
    const extra = Object.fromEntries(Object.entries(fixture.additionalOwners?.[relativePath] || {}).filter(([name]) => name !== 'cacheStatsRequestState'))
    assert(!Object.hasOwn(owned, retiredState) && !Object.hasOwn(owned, 'cacheStatsRequestState'), 'unread cache statistics owner returned')
    assert.deepEqual(Object.fromEntries(Object.entries(owned).filter(([name]) => Object.hasOwn(extra, name))), extra, `${relativePath} U-05 owner initialization changed`)
    assert.deepEqual(Object.keys(owned).filter(name => !Object.hasOwn(extra, name)), expectedNames, `${relativePath} state/ref ownership order changed`)
    for (const name of expectedNames) {
      assert.equal(owned[name], fixture.states[name], `${relativePath} changed frozen initializer ${name}`)
      assert(!seen.has(name), `duplicate AT-6.4 controller owner: ${name}`)
      seen.add(name)
    }
  }
  assert.equal(seen.size, 41, 'the remaining 41 AT-6.4 state/ref slots must have one controller owner')

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
    assert.equal(hash(relativePath === 'src/renderer/src/fontWriteQueueRuntime.ts' ? legacyWriteFeedback(get(relativePath)) : get(relativePath)), expectedHash, `frozen AT-6.4 lifecycle behavior changed: ${relativePath}`)
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
  for (const name of ['databaseRefreshTimerRef', 'initialLibraryLoadStartedRef', 'sharedMetadataSyncInFlightRef', 'lastSharedMetadataSyncCheckAtRef', 'pendingRefreshScope', 'activeFilterKindRef', 'statusRef', 'actionStatusSourceRef']) {
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

  assert(library.includes("onPersistenceRecovered: () => { clearFeedback('save'); refreshDatabaseDerivedState() }"), 'autosave recovery lost database invalidation')
  assert(library.includes('useSharedMetadataSyncForegroundRuntime({'), 'Library controller lost foreground shared metadata lifecycle')
  assert(operations.includes('scheduleDatabaseDerivedStateRefresh: options.library.scheduleDatabaseDerivedStateRefresh'), 'font writes lost the Library refresh command')
  assert(operations.indexOf('createRendererFontWriteQueueRuntime({') < operations.indexOf('useAppFlushOnUnloadRuntime({'), 'close lifecycle must bind after the write queue exists')
  assert(operations.includes('clearDatabaseRefreshTimer: options.library.clearDatabaseRefreshTimer'), 'close lifecycle leaked or lost the database timer cleanup command')
  assert.equal((developer.match(/if \(!options\.enabled \|\| options\.closingLifecycle\.isClosing\(\)\) return/g) || []).length, 2, 'Developer controller lost explicit closing admission')
  assert(developer.includes('if (!options.enabled || options.closingLifecycle.isClosing()) return Promise.resolve()'), 'Developer detail refresh lost explicit closing admission')
  assert(developer.includes('isClosing: options.closingLifecycle.isClosing'), 'Developer detail runtime lost in-flight closing guard')
  assert(developer.includes('closingLifecycle: options.closingLifecycle'), 'Background diagnostics lost shared closing lifecycle')
  assert(developer.includes('enabled: options.enabled'), 'background diagnostics are not gated by the development flag')
}

function createHookHarness() {
  let cursor = 0
  let callbackCursor = 0
  const callbacks = []
  const setters = []
  const slots = []
  const effects = []
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      if (!setters[index]) setters[index] = (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }
      return [slots[index], setters[index]]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useMemo(factory) { return factory() },
    useCallback(callback, dependencies) {
      const index = callbackCursor++, previous = callbacks[index]
      if (!previous || dependencies.length !== previous.dependencies.length || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) callbacks[index] = { callback, dependencies }
      return callbacks[index].callback
    },
    useEffect(effect) { effects.push(effect); effect() },
    useLayoutEffect(effect) { effects.push(effect); effect() }
  }
  return {
    hooks,
    slots,
    effects,
    render(hook, options) {
      cursor = 0
      callbackCursor = 0
      return hook(options)
    }
  }
}

function createLoader({ hooks, mocks = {}, globals = {}, overrides = new Map() }) {
  const modules = new Map()
  function load(relativePath) {
    if (modules.has(relativePath)) return modules.get(relativePath)
    const exports = {}
    modules.set(relativePath, exports)
    const code = ts.transpileModule(overrides.get(relativePath) ?? read(relativePath), {
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

async function checkLibraryBehavior(overrides = new Map()) {
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
      useLibraryAutosaveRuntime: (options) => (calls.autosave = options, {
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
    mocks, overrides,
    globals: { window: { clearTimeout: (id) => cleared.push(id), setTimeout: () => 1 } }
  })
  const useLibraryController = load(libraryControllerPath).useLibraryController
  let libraryClosing = false
  const closingLifecycle = { isClosing: () => libraryClosing, beginClosing() { libraryClosing = true }, resume() { libraryClosing = false }, subscribe: () => () => {} }
  const options = { hfm: {}, database, rendererUserActive: () => false, appendDeveloperStatus() {}, closingLifecycle }
  let controller = harness.render(useLibraryController, options)
  assert.equal(harness.slots.length, 16)
  assert(!Object.hasOwn(controller, 'setCacheStats'), 'library re-exposed unread state setter')
  const render = () => (controller = harness.render(useLibraryController, options))
  const stable = ['setStatus', 'reportActionStatus', 'reportWriteError', 'clearWriteError', 'reportQueryError', 'clearQueryError', 'dismissActionStatus']
  const initialCallbacks = Object.fromEntries(stable.map(key => [key, controller[key]]))
  for (let i = 0; i < 100; i++) controller.setStatus(`background ${i}`)
  render(); assert.equal(controller.actionStatus, null, 'DIAGNOSTIC_NOTICE: background status became an operation notice')
  controller.reportActionStatus('manual failure'); render()
  assert.equal(controller.actionStatus, 'manual failure', 'ACTION_NOTICE: operation failure was hidden')
  controller.setStatus('background progressing'); render()
  assert.equal(controller.actionStatus, 'manual failure', 'DIAGNOSTIC_REPLACED_NOTICE')
  controller.reportActionStatus(previous => previous + ': operation complete'); render()
  assert.equal(controller.actionStatus, 'background progressing: operation complete')
  controller.dismissActionStatus(); render(); assert.equal(controller.actionStatus, null)
  for (const [fail, recover, label] of [
    [() => calls.initial.reportError('load failed'), () => calls.initial.onRecovered(), 'load'],
    [() => calls.autosave.setStatus('save failed'), () => calls.autosave.onPersistenceRecovered(), 'save'],
    [() => controller.reportWriteError('write failed'), () => controller.clearWriteError(), 'write'],
    [() => controller.reportQueryError('query failed'), () => controller.clearQueryError(), 'query']
  ]) {
    fail(); render(); assert.equal(controller.actionStatus, `${label} failed`, 'ERROR_NOTICE: ' + label)
    recover(); render(); assert.equal(controller.actionStatus, null, 'RECOVERED_NOTICE: ' + label)
    if (label === 'save') assert(calls.refresh, 'save recovery lost original database invalidation')
    fail(); render(); controller.reportActionStatus('new manual result'); render()
    recover(); render(); assert.equal(controller.actionStatus, 'new manual result', 'SCOPED_RECOVERY: ' + label)
    controller.dismissActionStatus(); render()
  }
  for (const key of stable) assert.equal(controller[key], initialCallbacks[key], 'STABLE_STATUS_CALLBACK: ' + key)
  libraryClosing = true; controller.reportActionStatus('late'); render()
  assert.equal(controller.actionStatus, null, 'CLOSING_NOTICE')
  libraryClosing = false

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
  assert.equal(calls.foreground.closingLifecycle, closingLifecycle)
  libraryClosing = true
  delete calls.refresh
  delete calls.schedule
  controller.refreshDatabaseDerivedState()
  controller.scheduleDatabaseDerivedStateRefresh(88)
  controller.refreshDatabaseMetricsNow()
  assert.equal(calls.refresh, undefined, 'closing library must not start database refresh')
  assert.equal(calls.schedule, undefined, 'closing library must not schedule database refresh')
  libraryClosing = false
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
  options.hfm.getFontMetrics = async () => { throw Error('temporary database failure') }
  controller.refreshDatabaseMetricsNow()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.equal(metricWrites.length, 1, 'failed immediate refresh discarded last authoritative metrics')

}

async function checkOperationsBehavior() {
  const harness = createHookHarness()
  const calls = {}
  const protectionWrites = []
  let liveLibrary = { folders: ['root'], fonts: { a: { id: 'a', deleteProtected: false } } }
  const noOp = () => {}
  const action = () => {}, writeError = () => {}, writeRecovered = () => {}
  const asyncNoOp = async () => {}
  const queueRuntime = {
    clearTimer: noOp,
    queueLocalTagsWrite: noOp,
    queueSharedTagsWrite: noOp,
    flushProtectionWrites: async () => true,
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
      setStatus: noOp, reportActionStatus: action, reportWriteError: writeError, clearWriteError: writeRecovered,
      selectedFolderId: '',
      setSelectedFolderId: noOp,
      indexingActive: false,
      setIndexingActive: noOp,
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
    appendDeveloperStatus: noOp,
    closingLifecycle: { isClosing: () => false, beginClosing: noOp, resume: noOp, subscribe: () => () => {} }
  })
  assert.equal(harness.slots.length, 22)
  assert(!Object.hasOwn(calls.index, 'cacheStatsRequestState'))
  assert(!Object.hasOwn(calls.index, 'setCacheStats'))
  assert(!Object.hasOwn(controller, 'loadCacheStats'))
  assert.equal(calls.queue.scheduleDatabaseDerivedStateRefresh, noOp)
  assert.equal(calls.queue.setStatus, noOp); assert.equal(calls.queue.reportError, writeError); assert.equal(calls.queue.onRecovered, writeRecovered)
  assert.equal(calls.system.setStatus, action); assert.equal(calls.index.setStatus, action)
  assert.equal(calls.install.setStatus, noOp); assert.equal(calls.progress.setStatus, noOp)
  assert.equal(calls.install.knownInstallStatusIds, calls.index.knownInstallStatusIds)
  assert.equal(calls.index.autoInstallStatusRefreshStartedRef, calls.progress.autoInstallStatusRefreshStartedRef)
  assert.equal(calls.index.autoInstallStatusRefreshStartedRef, calls.auto.startedRef)
  assert.equal(calls.close.flushFontWriteQueue, queueRuntime.flush)
  assert.equal(calls.close.flushLibraryPersistence instanceof Function, true)
  assert.equal(calls.close.closingLifecycle, calls.progress.closingLifecycle)
  assert.equal(calls.auto.isClosing, calls.close.closingLifecycle.isClosing)
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
  let closeCancelled
  let beforeUnload
  let closing = false
  const closingLifecycle = {
    isClosing: () => closing,
    beginClosing: () => { closing = true; order.push('closing:true') },
    resume: () => { closing = false; order.push('closing:false') },
    subscribe: () => () => {}
  }
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
    onWindowCloseCancelled(handler) { closeCancelled = handler; return () => {} },
    completeWindowCloseFlush(requestId, saved) { order.push(`complete:${requestId}:${saved}`) }
  }
  const load = createLoader({ hooks, globals: { window: windowObject } })
  load('src/renderer/src/runtime/app/effects/useAppFlushOnUnloadRuntime.ts').useAppFlushOnUnloadRuntime({
    hfm,
    clearDatabaseRefreshTimer: () => order.push('clear-database'),
    clearFontListScrollIdleTimer: () => order.push('clear-preview'),
    clearQueuedFontWriteTimer: () => order.push('clear-write'),
    flushFontWriteQueue: async () => { order.push('flush-write'); return true },
    flushLibraryPersistence: async () => { order.push('flush-library'); return true },
    closingLifecycle
  })
  assert.equal(typeof beforeUnload, 'function')
  assert.equal(typeof closeCancelled, 'function')
  closeRequest({ requestId: 'r1' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['closing:true', 'clear-write', 'clear-database', 'clear-preview', 'flush-write', 'flush-library', 'complete:r1:true'])
  assert.equal(closingLifecycle.isClosing(), true)
  closeCancelled({ requestId: 'r1' })
  assert.equal(closingLifecycle.isClosing(), false)
  assert.equal(order.at(-1), 'closing:false')
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
  const openLifecycle = { isClosing: () => false, beginClosing() {}, resume() {}, subscribe: () => () => {} }
  let load = createLoader({ hooks: disabledHarness.hooks, mocks })
  let controller = disabledHarness.render(load(developerControllerPath).useDeveloperController, { enabled: false, hfm: {}, status: 'ready', closingLifecycle: openLifecycle })
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
  controller = enabledHarness.render(load(developerControllerPath).useDeveloperController, { enabled: true, hfm: {}, status: 'ready', closingLifecycle: openLifecycle })
  const first = controller.refreshDeveloperStatusDetails()
  const second = controller.refreshDeveloperStatusDetails()
  assert.equal(first, second)
  assert.equal(refreshCalls, 1)
  resolveRefresh()
  await first

  const closingHarness = createHookHarness()
  let closingRefreshCalls = 0
  mocks['../../rendererDeveloperStatusRuntime'].refreshDeveloperStatusDetailsRuntime = () => { closingRefreshCalls += 1; return Promise.resolve() }
  const closedLifecycle = { isClosing: () => true, beginClosing() {}, resume() {}, subscribe: () => () => {} }
  load = createLoader({ hooks: closingHarness.hooks, mocks })
  controller = closingHarness.render(load(developerControllerPath).useDeveloperController, { enabled: true, hfm: {}, status: 'ready', closingLifecycle: closedLifecycle })
  controller.appendDeveloperStatus('status', 'closing')
  await controller.refreshDeveloperStatusDetails()
  assert.equal(closingRefreshCalls, 0, 'closing developer controller started diagnostics')
  assert.equal(closingHarness.slots[0].length, 0, 'closing developer controller appended status')
}

async function checkSharedMetadataPartialReceipts(overrides = new Map()) {
  const target = 'src/renderer/src/sharedMetadataSyncRuntime.ts'
  const run = createLoader({ hooks: {}, overrides })(target).runSharedMetadataSyncCheckRuntime
  async function scenario(result, { reason = 'foreground-shared-metadata-sync', closing = false, held = false } = {}) {
    const calls = { refresh: 0, status: [], developer: [], checks: 0 }
    let release
    const gate = new Promise(resolve => { release = resolve })
    let isClosing = false
    const options = {
      hfm: { checkSharedMetadataUpdates: async () => { calls.checks++; if (held) await gate; return result } },
      reason, foldersLength: 2, indexingActive: false,
      libraryLoadedRef: { current: true }, inFlightRef: { current: null }, lastCheckedAtRef: { current: 0 },
      refreshDatabaseDerivedState: () => { calls.refresh++ }, setStatus: text => calls.status.push(text),
      appendDeveloperStatus: (...args) => calls.developer.push(args), isClosing: () => isClosing
    }
    const pending = run(options)
    assert(pending && options.inFlightRef.current === pending)
    if (held) { assert.equal(run({ ...options, lastCheckedAtRef: { current: 0 } }), pending); assert.equal(calls.checks, 1) }
    isClosing = closing; release(); await pending
    assert.equal(options.inFlightRef.current, null)
    return calls
  }
  const base = { changed: true, rebuilt: false, roots: 2, elapsedMs: 10, reason: 'controlled', checkedRoots: 1, syncedRoots: 1 }
  let calls = await scenario({ ...base, status: 'partial', deferredRoots: 1, failedRoots: 0 })
  assert.equal(calls.refresh, 1)
  assert.match(calls.status[0], /仅完成部分检查.*已同步 1 个索引，暂缓 1 个，失败 0 个/)
  assert(!calls.status[0].includes('已同步 2 个'))
  assert.equal(calls.developer[0][2].status, 'partial')
  calls = await scenario({ ...base, changed: false, syncedRoots: 0, status: 'partial', deferredRoots: 2 })
  assert.equal(calls.refresh, 0); assert.equal(calls.status.length, 0); assert.equal(calls.developer.length, 1)
  calls = await scenario({ ...base, changed: false, syncedRoots: 0, status: 'partial', failedRoots: 1, reconciliationRequired: true }, { reason: 'manual-shared-metadata-reconcile' })
  assert.match(calls.status[0], /仅完成部分检查.*失败 1 个，仍需完整校验/)
  assert.equal(calls.refresh, 0)
  for (const partial of [{ failedRoots: 1 }, { deferredRoots: 1 }, { reconciliationRequired: true }]) {
    calls = await scenario({ ...base, ...partial })
    assert.match(calls.status[0], /仅完成部分检查/, 'partial evidence was rendered as full sync')
  }
  calls = await scenario({ ...base, status: 'complete', checkedRoots: 2, syncedRoots: 1 })
  assert.match(calls.status[0], /已同步 1 个共享索引/)
  calls = await scenario({ changed: true, rebuilt: true, roots: 2 })
  assert.match(calls.status[0], /已同步 2 个共享索引/, 'legacy full reconciliation receipt lost compatibility')
  calls = await scenario({ ...base, changed: false, status: 'complete' })
  assert.equal(calls.refresh + calls.status.length + calls.developer.length, 0)
  calls = await scenario({ ...base, status: 'partial', deferredRoots: 1 }, { closing: true, held: true })
  assert.equal(calls.refresh + calls.status.length + calls.developer.length, 0, 'closing view published late partial receipt')
}

async function checkSharedMetadataReceiptMutants() {
  const target = 'src/renderer/src/sharedMetadataSyncRuntime.ts', source = read(target)
  const mutations = [
    ["const message = partial", "const message = false"],
    ['result?.syncedRoots ?? result?.roots ?? 0', 'result?.roots ?? 0'],
    ['if (result?.changed) options.refreshDatabaseDerivedState()', 'options.refreshDatabaseDerivedState()'],
    ['if (options.isClosing?.()) return\n    const partial', 'const partial'],
  ]
  for (const [before, after] of mutations) {
    assert.equal(source.split(before).length, 2, 'partial receipt mutation anchor drifted: ' + before)
    await assert.rejects(() => checkSharedMetadataPartialReceipts(new Map([[target, source.replace(before, after)]])), undefined, 'partial receipt mutation escaped: ' + before)
  }
}

async function main() {
  checkBaseline()
  checkStructure()
  await checkLibraryBehavior()
  for (const [before, after, reason] of [
    ['    setActionStatus(statusRef.current)', '    setActionStatus(null)', /ACTION_NOTICE/],
    ['    if (actionStatusSourceRef.current !== source) return', '', /SCOPED_RECOVERY/],
    ["useCallback((message: SetStateAction<string>): void => reportFeedback('operation', message), [reportFeedback])", "((message: SetStateAction<string>): void => reportFeedback('operation', message))", /STABLE_STATUS_CALLBACK/]
  ]) {
    const original = read(libraryControllerPath)
    assert.equal(original.split(before).length, 2, 'feedback mutation anchor')
    await assert.rejects(() => checkLibraryBehavior(new Map([[libraryControllerPath, original.replace(before, after)]])), reason)
  }
  await checkOperationsBehavior()
  await checkCloseFlushBehavior()
  await checkDeveloperLazyBehavior()
  await checkSharedMetadataPartialReceipts()
  await checkSharedMetadataReceiptMutants()

  const operations = read(operationsControllerPath)
  assert.throws(() => checkStructure(new Map([[
    operationsControllerPath,
    operations.replace('const [cacheMenuOpen, setCacheMenuOpen] = useState(false)', 'const [cacheMenuOpen, setCacheMenuOpen] = useState(true)')
  ]])), 'changed Operations default escaped ownership gate')
  const library = read(libraryControllerPath)
  assert.throws(() => checkStructure(new Map([[
    libraryControllerPath,
    library.replace('  const databaseRefreshTimerRef =', '  const [, setCacheStats] = useState<CacheStats | null>(null)\n  const databaseRefreshTimerRef =')
  ]])), /unread cache statistics owner returned/, 'retired unread state escaped ownership gate')
  assert.throws(() => checkStructure(new Map([[
    operationsControllerPath,
    operations.replace('  const libraryIndexActionRuntime =', '  const cacheStatsRequestState = useRef({ active: null, requested: 0 })\n  const libraryIndexActionRuntime =')
  ]])), /unread cache statistics owner returned/, 'retired statistics request owner escaped ownership gate')
  const app = read(appPath)
  assert.throws(() => checkStructure(new Map([[appPath, `${app}\nfontWriteQueue.current = null\n`]])), 'raw write queue leak escaped port gate')
  const developer = read(developerControllerPath)
  assert.throws(() => checkStructure(new Map([[
    developerControllerPath,
    developer.replace('if (!options.enabled || options.closingLifecycle.isClosing()) return\n', 'if (!options.enabled) return\n')
  ]])), 'production developer closing guard escaped structure gate')
  checkStructure(new Map(controllerPaths.map((relativePath) => [relativePath, read(relativePath).replace(/\n/g, '\r\n')])))
  console.log('[diagnostics:react-composition-domain-controllers] 41 historical live owners plus three explicit feedback owners; stable callbacks and scoped recovery, write refresh, explicit closing admission/resume, close flush, protection/lazy cleanup, developer laziness, narrow ports, mutations and CRLF passed')
}

main().catch((error) => {
  console.error(`[diagnostics:react-composition-domain-controllers] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
