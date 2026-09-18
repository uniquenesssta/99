#!/usr/bin/env node
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { declarations, hash } = require('./check-browse-controller.cjs')

const root = path.resolve(__dirname, '../..')
const fixture = require('./fixtures/react-composition-controllers.fixture.json')
const appPath = 'src/renderer/src/App.tsx'
const folderControllerPath = 'src/renderer/src/runtime/app/useFolderController.ts'
const selectionControllerPath = 'src/renderer/src/runtime/app/useSelectionController.ts'
const previewControllerPath = 'src/renderer/src/runtime/app/usePreviewController.ts'
const targetControllerPaths = [folderControllerPath, selectionControllerPath, previewControllerPath]
const stateNames = Object.keys(fixture.states)
const folderStateNames = stateNames.slice(0, 6)
const selectionStateNames = stateNames.slice(6, 23)
const previewStateNames = stateNames.slice(23)
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')

function sourceFile(relativePath, text) {
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function namedNodeHash(relativePath, text, targetName) {
  const file = sourceFile(relativePath, text)
  let result = ''
  function walk(node) {
    if (!result && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(file) === targetName) {
      result = hash(node.getText(file))
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return result
}

function callNames(text, acceptedNames) {
  const file = sourceFile(appPath, text)
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

function checkBaseline() {
  const baselineApp = childProcess.execFileSync('git', ['show', `${fixture.baseline}:${appPath}`], { cwd: root, encoding: 'utf8' })
  const baselineDeclarations = declarations(baselineApp)
  for (const [name, expectedHash] of Object.entries(fixture.states)) {
    assert.equal(baselineDeclarations[name], expectedHash, `AT-6.3 immutable baseline changed: ${name}`)
  }
}

function checkStructure(overrides = new Map()) {
  const get = (relativePath) => String(overrides.get(relativePath) ?? read(relativePath)).replace(/\r\n/g, '\n')
  const app = get(appPath)
  const ownerNames = new Map([
    [folderControllerPath, folderStateNames],
    [selectionControllerPath, selectionStateNames],
    [previewControllerPath, previewStateNames]
  ])
  const seen = new Set()

  for (const [relativePath, expectedNames] of ownerNames) {
    const owned = declarations(get(relativePath))
    for (const name of expectedNames) {
      assert.equal(owned[name], fixture.states[name], `${relativePath} changed frozen initializer ${name}`)
      assert(!seen.has(name), `duplicate controller owner: ${name}`)
      seen.add(name)
    }
    assert.equal(Object.keys(owned).filter((name) => Object.hasOwn(fixture.states, name)).length, expectedNames.length, `${relativePath} owns an unexpected AT-6.3 state/ref`)
  }
  assert.equal(seen.size, 40, 'not all 40 AT-6.3 state/ref slots have one controller owner')

  const appDeclarations = declarations(app)
  for (const name of stateNames) assert(!Object.hasOwn(appDeclarations, name), `App retained duplicate owner ${name}`)
  assert.equal((app.match(/= useFolderController\(/g) || []).length, 1, 'Folder controller must be composed once')
  assert.equal((app.match(/= useSelectionController\(/g) || []).length, 1, 'Selection controller must be composed once')
  assert.equal((app.match(/= usePreviewController\(/g) || []).length, 1, 'Preview controller must be composed once')
  assert.deepEqual(callNames(app, new Set(fixture.appCallOrder)), fixture.appCallOrder, 'selection/folder/preview composition order changed')

  for (const [relativePath, expectedHash] of Object.entries(fixture.sourceHashes)) {
    assert.equal(hash(get(relativePath)), expectedHash, `frozen selection/detail/preview behavior changed: ${relativePath}`)
  }
  for (const [key, expectedHash] of Object.entries(fixture.functionHashes)) {
    const splitAt = key.lastIndexOf('#')
    const relativePath = key.slice(0, splitAt)
    const functionName = key.slice(splitAt + 1)
    assert.equal(namedNodeHash(relativePath, get(relativePath), functionName), expectedHash, `frozen behavior changed: ${key}`)
  }

  const folderRuntime = get('src/renderer/src/fontFolderTreeRuntime.ts')
  const indexEffect = get('src/renderer/src/runtime/app/effects/useFontIndexChangedEventRuntime.ts')
  const previewController = get(previewControllerPath)
  const selectionController = get(selectionControllerPath)
  const rawPreviewPorts = ['previewQueue', 'autoPreviewCacheQueue', 'queuedPreviewFontIds', 'queuedAutoPreviewCacheIds', 'loadingFonts']
  for (const port of rawPreviewPorts) {
    assert(!new RegExp(`\\b${port}\\b`).test(app), `App leaked mutable preview port ${port}`)
    assert(!new RegExp(`\\b${port}\\b`).test(folderRuntime), `Folder runtime mutates preview owner port ${port}`)
    assert(!new RegExp(`\\b${port}\\b`).test(indexEffect), `Index event mutates preview owner port ${port}`)
  }
  assert(/cleanupRemovedFontState: \(removedFontIds: Set<string>\) => void/.test(folderRuntime), 'Folder removal lacks narrow cleanup command')
  assert(/cleanupRemovedFontState: \(removedFontIds: string\[\]\) => void/.test(indexEffect), 'Index removal lacks narrow cleanup command')
  assert(/fontListScrollingRef: fontListScrollingRef as Readonly<\{ current: boolean \}>/.test(previewController), 'scroll state is not exported as read-only')
  assert(!/fontListScrollingRef\.current\s*=/.test(app), 'App directly mutates preview scroll state')
  const queueCreation = previewController.indexOf('createFontPreviewQueueRuntime(runtimeOptionsRef.current)')
  assert(queueCreation >= 0 && queueCreation < previewController.indexOf('usePreviewTextResetRuntime({'), 'preview reset effect moved before retained queue runtime creation')
  assert.equal((selectionController.match(/options\.hydrateFont\(font, selectedFontIds\)[\s\S]{0,100}runtime\.handleFont(?:Select|OpenDetail)\(event, font\)/g) || []).length, 2, 'selection hydration must precede select and detail dispatch')
}

function createHookHarness() {
  let cursor = 0
  const slots = []
  return {
    hooks: {
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
      useEffect(effect, deps) {
        const index = cursor++, previous = slots[index]
        if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
          previous?.cleanup?.()
          slots[index] = { deps, cleanup: effect() }
        }
      }
    },
    render(hook, options) {
      cursor = 0
      return hook(options)
    },
    slots
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
    const context = vm.createContext({ console, ...globals })
    vm.runInContext(`(function(require,exports){${code}\n})`, context)(localRequire, exports)
    return exports
  }
  return load
}

function checkSelectionBehavior() {
  const harness = createHookHarness()
  let clock = 100
  const listeners = new Map()
  const fontNodes = [
    { dataset: { fontId: 'a' }, getBoundingClientRect: () => ({ left: 4, top: 4, right: 24, bottom: 24 }) },
    { dataset: { fontId: 'b' }, getBoundingClientRect: () => ({ left: 30, top: 4, right: 50, bottom: 24 }) },
    { dataset: { fontId: 'c' }, getBoundingClientRect: () => ({ left: 90, top: 90, right: 110, bottom: 110 }) }
  ]
  class TestDomRect {
    constructor(left, top, width, height) {
      this.left = left
      this.top = top
      this.width = width
      this.height = height
      this.right = left + width
      this.bottom = top + height
    }
  }
  const windowObject = {
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type) }
  }
  const load = createLoader({
    hooks: harness.hooks,
    globals: {
      window: windowObject,
      document: { querySelectorAll: () => fontNodes },
      DOMRect: TestDomRect,
      performance: { now: () => clock }
    }
  })
  const useSelectionController = load(selectionControllerPath).useSelectionController
  const visibleFonts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const hydrated = []
  const statuses = []
  const activity = []
  let controller
  const render = () => {
    controller = harness.render(useSelectionController)
    return controller
  }
  const interaction = () => controller.createInteractionRuntime({
    visibleFonts,
    setStatus: (value) => statuses.push(typeof value === 'function' ? value(statuses.at(-1) || '') : value),
    setSingleFontSelection: (fontId) => {
      controller.setSelectedFontIds(fontId ? [fontId] : [])
      controller.setSelectionAnchorFontId(fontId)
    },
    toggleFontDetail: () => {},
    hydrateFont: (font) => hydrated.push(font.id),
    reportUserActivity: (...args) => activity.push(args),
    userActivityIdleWindowMs: 900
  })

  render()
  assert.equal(harness.slots.length, 19, '17 existing hook slots plus the scope ref/effect')
  interaction().handleFontSelect({ shiftKey: false, ctrlKey: false, metaKey: false }, visibleFonts[0])
  render()
  assert.equal(controller.selectedFontId, 'a')
  assert.deepEqual(Array.from(controller.selectedFontIds), ['a'])
  assert.equal(controller.detailVisible, true)
  assert.equal(controller.pendingDetailRevealFontId, 'a')

  interaction().handleFontSelect({ shiftKey: false, ctrlKey: true, metaKey: false }, visibleFonts[1])
  render()
  assert.deepEqual(Array.from(controller.selectedFontIds), ['a', 'b'])
  assert.equal(controller.selectionAnchorFontId, 'b')
  assert.equal(controller.detailVisible, false)

  interaction().handleFontSelect({ shiftKey: true, ctrlKey: false, metaKey: false }, visibleFonts[2])
  render()
  assert.deepEqual(Array.from(controller.selectedFontIds), ['b', 'c'])
  assert.equal(controller.selectedFontId, 'c')

  clock = 300
  interaction().handleFontOpenDetail({ shiftKey: false, ctrlKey: false, metaKey: false }, visibleFonts[1])
  render()
  assert.equal(controller.selectedFontId, 'b')
  assert.equal(controller.pendingDetailRevealFontId, 'b')
  assert.equal(controller.detailVisible, true)

  interaction().beginMarqueeSelection({
    button: 0,
    clientX: 0,
    clientY: 0,
    ctrlKey: false,
    metaKey: false,
    target: { closest: () => null },
    preventDefault() {},
    stopPropagation() {}
  })
  listeners.get('mousemove')({ clientX: 55, clientY: 30 })
  listeners.get('mouseup')({ clientX: 55, clientY: 30 })
  render()
  assert.deepEqual(Array.from(controller.selectedFontIds), ['a', 'b'])
  assert.equal(controller.selectionRect, null)
  assert.deepEqual(activity, [['marquee', 900]])

  controller.setSelectedFontId('b')
  controller.setDetailVisible(true)
  render()
  const selectedRef = controller.selectedFontIdRef
  assert.equal(controller.removeFontIds(new Set(['b'])), true)
  render()
  assert.equal(controller.selectedFontId, '')
  assert.equal(controller.detailVisible, false)
  assert.deepEqual(Array.from(controller.selectedFontIds), ['a'])
  assert.equal(controller.selectedFontIdRef, selectedRef)
  assert(hydrated.length >= 4)
}

function checkFolderBehavior() {
  const harness = createHookHarness()
  let capturedOptions
  const loadController = createLoader({
    hooks: harness.hooks,
    globals: { window: { clearTimeout() {} } },
    mocks: {
      '../../fontFolderTreeRuntime': {
        createFontFolderTreeRuntime(options) { capturedOptions = options; return { marker: 'folder-runtime' } }
      }
    }
  })
  const useFolderController = loadController(folderControllerPath).useFolderController
  let controller = harness.render(useFolderController)
  assert.equal(harness.slots.length, 6)
  controller.setExpandedFolderIds({ root: true })
  controller.setNewFolderName('Child')
  controller.setDraggingFontId('font-a')
  controller.setDropHoverFolderId('root')
  controller = harness.render(useFolderController)
  assert.equal(controller.newFolderName, 'Child')
  assert.equal(controller.draggingFontId, 'font-a')
  assert.equal(controller.dropHoverFolderId, 'root')
  assert.equal(controller.expandedFolderIds.root, true)
  assert.equal(controller.createRuntime({ selectedFolderId: 'root' }).marker, 'folder-runtime')
  assert.equal(capturedOptions.draggingFontId, 'font-a')
  assert.equal(typeof capturedOptions.clearAutoRefreshTimer, 'function')

  const loadMutation = createLoader({ hooks: {}, mocks: { './libraryNormalize': {} } })
  const mutation = loadMutation('src/renderer/src/fontFolderMutationRuntime.ts')
  const batch = mutation.fontIdsFromDragDataTransfer({
    getData(type) { return type === 'application/x-hfm-font-ids' ? '["a","b"]' : '' }
  }, 'fallback')
  assert.deepEqual(Array.from(batch), ['a', 'b'])
  assert.deepEqual(Array.from(mutation.fontIdsFromDragDataTransfer({ getData: () => '' }, 'fallback')), ['fallback'])

  let library = { folders: ['root'], folderNodes: [], fonts: { a: { id: 'a' } }, fontFolderIds: {} }
  let cleaned
  let timerCleared = 0
  let selectedFolder = 'root'
  const loadRuntime = createLoader({
    hooks: {},
    mocks: {
      './appRuntime': { applyFolderTreeToLibrary: (value) => value, folderPhysicalPath: () => 'root', fontDisplayName: (font) => font.id },
      './fontFilterStateRuntime': { toggleExpandedFolderId: (value) => value },
      './fontFolderMutationRuntime': {
        applyMovedFontToLibrary: (value) => value,
        applyMovedFontsToLibrary: (value) => value,
        createRemoveFolderTargetPlan: () => ({ childIds: new Set(['root']), removedFontIds: new Set(['a']) }),
        fontIdsFromDragDataTransfer: () => [],
        removeFolderTargetFromLibrary: (value) => ({ ...value, fonts: {} })
      },
      './runtime/library/fontPhysicalMutationIndexRuntime': { physicalMutationIndexRefreshSuffix: () => '', refreshIndexesAfterPhysicalMutation: async () => null }
    }
  })
  const runtime = loadRuntime('src/renderer/src/fontFolderTreeRuntime.ts').createFontFolderTreeRuntime({
    selectedFolderId: 'root',
    draggingFontId: '',
    clearAutoRefreshTimer: () => { timerCleared += 1 },
    cleanupRemovedFontState: (ids) => { cleaned = ids },
    hfm: {},
    readPhysicalFolderTree: async () => ({}),
    getCurrentLibrary: () => library,
    commitLibraryUpdate: (update) => { library = update(library); return library },
    saveLibraryImmediately: async () => true,
    setExpandedFolderIds() {},
    setSelectedFolderId: (value) => { selectedFolder = typeof value === 'function' ? value(selectedFolder) : value },
    setDraggingFontId() {},
    setDatabasePageResult() {},
    setDatabaseQueryResult() {},
    setDatabaseFontMetrics() {},
    setDatabaseRefreshToken() {},
    setStatus() {}
  })
  return runtime.removeFolderTarget({ kind: 'folder', id: 'root', name: 'Root', rootPath: 'root', virtual: false }).then(() => {
    assert.deepEqual(Array.from(cleaned), ['a'])
    assert.equal(timerCleared, 1)
    assert.equal(selectedFolder, '')
    assert.equal(Object.keys(library.fonts).length, 0)
  })
}

function checkPreviewBehavior() {
  const harness = createHookHarness()
  const timers = new Map()
  const cleared = []
  let nextTimerId = 1
  let queueOptions
  let resetOptions
  const processed = []
  const load = createLoader({
    hooks: harness.hooks,
    globals: {
      window: {
        setTimeout(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id },
        clearTimeout(id) { cleared.push(id); timers.delete(id) }
      }
    },
    mocks: {
      '@shared/preview-layout/previewTextFitRuntime': { normalizePreviewText: (value) => String(value || '').trim() || '字体预览\nAaBb 123' },
      '../preview/listPreviewSizeRuntime': { clampListPreviewFontSize: (value) => Math.round(Number(value)) },
      '../preview/fontPreviewQueueRuntime': {
        createFontPreviewQueueRuntime(options) {
          queueOptions = options
          return {
            resetPreviewRuntimeState() { processed.push('reset') },
            disposePreviewQueue() {},
            resumePreviewQueue() {},
            processPreviewQueue() { processed.push('visible') },
            requestPreviewFont() {},
            processAutoPreviewCacheQueue() { processed.push('auto') }
          }
        }
      },
      './effects/usePreviewTextResetRuntime': { usePreviewTextResetRuntime(options) { resetOptions = options } }
    }
  })
  const usePreviewController = load(previewControllerPath).usePreviewController
  const baseOptions = {
    hfm: {},
    previewText: '  Sample  ',
    listPreviewFontSize: 36,
    selectedFontId: 'a',
    selectedFontIds: ['a'],
    indexingActive: false,
    rendererUserActive: () => false,
    isBadFontRecord: () => false,
    setStatus: () => {},
    updateFont: () => {}
  }
  let controller = harness.render(usePreviewController, baseOptions)
  assert.equal(harness.slots.length, 20, '17 original owners plus two runtime refs and one disposal effect')
  assert.equal(queueOptions.previewRequestTokenRef.current, 'Sample::36')
  assert.equal(resetOptions.previewText, '  Sample  ')
  assert.equal(resetOptions.listPreviewFontSize, 36)

  queueOptions.previewQueue.current = [{ font: { id: 'a' }, priority: 'normal' }, { font: { id: 'b' }, priority: 'normal' }]
  queueOptions.autoPreviewCacheQueue.current = [{ id: 'a' }, { id: 'b' }]
  queueOptions.queuedPreviewFontIds.current.add('a')
  queueOptions.queuedPreviewFontIds.current.add('b')
  queueOptions.queuedAutoPreviewCacheIds.current.add('a')
  queueOptions.queuedAutoPreviewCacheIds.current.add('b')
  queueOptions.loadingFonts.current.add('a')
  queueOptions.loadingFonts.current.add('b')
  queueOptions.setNativePreviewImages({ a: 'image-a', b: 'image-b' })
  queueOptions.setFailedPreviewFontIds({ a: true, b: true })
  queueOptions.setNativeDetailImage('detail-a')
  controller = harness.render(usePreviewController, baseOptions)
  controller.removeFontIds(new Set(['a']), true)
  controller = harness.render(usePreviewController, baseOptions)
  assert.deepEqual(queueOptions.previewQueue.current.map((entry) => entry.font.id), ['b'])
  assert.deepEqual(queueOptions.autoPreviewCacheQueue.current.map((font) => font.id), ['b'])
  assert.deepEqual(Array.from(queueOptions.queuedPreviewFontIds.current), ['b'])
  assert.deepEqual(Array.from(queueOptions.queuedAutoPreviewCacheIds.current), ['b'])
  assert.deepEqual(Array.from(queueOptions.loadingFonts.current), ['b'])
  assert.deepEqual(Object.keys(controller.nativePreviewImages), ['b'])
  assert.deepEqual(Object.keys(controller.failedPreviewFontIds), ['b'])
  assert.equal(controller.nativeDetailImage, '')

  controller.beginFontListScroll(240)
  assert.equal(controller.isFontListScrolling(), true)
  const pending = Array.from(timers.values())[0]
  assert.equal(pending.delay, 240)
  pending.callback()
  assert.equal(controller.isFontListScrolling(), false)
  assert.deepEqual(processed.slice(-2), ['visible', 'auto'])
  controller.beginFontListScroll(180)
  controller.clearFontListScrollIdleTimer()
  assert(cleared.length >= 1)

  const priorRequestTokenRef = queueOptions.previewRequestTokenRef
  controller = harness.render(usePreviewController, { ...baseOptions, previewText: 'Next', listPreviewFontSize: 42 })
  assert.equal(queueOptions.previewRequestTokenRef, priorRequestTokenRef)
  assert.equal(queueOptions.previewRequestTokenRef.current, 'Next::42')
  for (const forbidden of ['previewQueue', 'autoPreviewCacheQueue', 'queuedPreviewFontIds', 'queuedAutoPreviewCacheIds', 'loadingFonts']) {
    assert(!Object.hasOwn(controller, forbidden), `Preview controller leaked mutable queue ${forbidden}`)
  }
}

async function main() {
  checkBaseline()
  checkStructure()
  checkSelectionBehavior()
  await checkFolderBehavior()
  checkPreviewBehavior()

  const selectionSource = read(selectionControllerPath)
  assert.throws(() => checkStructure(new Map([[selectionControllerPath, selectionSource.replace('useState(false)', 'useState(true)')]])), 'changed selection default escaped ownership gate')
  const appSource = read(appPath)
  assert.throws(() => checkStructure(new Map([[appPath, `${appSource}\npreviewQueue.current = []\n`]])), 'raw preview mutation escaped port gate')
  checkStructure(new Map(targetControllerPaths.map((relativePath) => [relativePath, read(relativePath).replace(/\n/g, '\r\n')])))
  console.log('[diagnostics:react-composition-controllers] 40 state/ref owners, click/Ctrl/Shift/marquee/detail, folder drag/removal, preview cleanup/scroll/token, frozen race/queue algorithms, narrow ports, mutations and CRLF passed')
}

main().catch((error) => {
  console.error(`[diagnostics:react-composition-controllers] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
