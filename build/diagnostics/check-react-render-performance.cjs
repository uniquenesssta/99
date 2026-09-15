#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { performance } = require('node:perf_hooks')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const fixture = require('./fixtures/react-render-performance.fixture.json')
const rendererPath = 'src/renderer/src/components/app/FontCardRenderer.tsx'
const appPath = 'src/renderer/src/App.tsx'
const virtualPath = 'src/renderer/src/fontViewRuntime.ts'
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')

function createLoader({ hooks = {}, overrides = new Map(), mocks = {} } = {}) {
  const modules = new Map()
  function load(relativePath) {
    if (modules.has(relativePath)) return modules.get(relativePath)
    const exports = {}
    modules.set(relativePath, exports)
    const source = String(overrides.get(relativePath) ?? read(relativePath))
    const output = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText
    const localRequire = (id) => {
      const scoped = `${relativePath}::${id}`
      if (Object.hasOwn(mocks, scoped)) return mocks[scoped]
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id === 'react') return hooks
      if (id === 'react/jsx-runtime') {
        const element = (type, props, key) => ({ type, props, key: key ?? null })
        return { jsx: element, jsxs: element, Fragment: Symbol.for('fragment') }
      }
      if (id.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), id))
        return load(path.posix.extname(resolved) ? resolved : `${resolved}.ts`)
      }
      return {}
    }
    const context = vm.createContext({ console, performance, setTimeout, clearTimeout, ...globalThis })
    try {
      vm.runInContext(`(function(require,exports){${output}\n})`, context)(localRequire, exports)
    } catch (error) {
      error.message = `${relativePath}: ${error.message}`
      throw error
    }
    return exports
  }
  return load
}

function createHookHarness() {
  let cursor = 0
  const slots = []
  let pendingEffects = []
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const hooks = {
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(callback, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || !sameDeps(previous.deps, deps)) slots[index] = { value: callback, deps }
      return slots[index].value
    },
    useLayoutEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || !sameDeps(previous.deps, deps)) pendingEffects.push({ index, effect, deps })
    }
  }
  return {
    hooks,
    render(hook, options) {
      cursor = 0
      pendingEffects = []
      const result = hook(options)
      for (const pending of pendingEffects) {
        slots[pending.index]?.cleanup?.()
        slots[pending.index] = { deps: pending.deps, cleanup: pending.effect() }
      }
      return result
    }
  }
}

function createFonts(count) {
  return Array.from({ length: count }, (_, index) => {
    const serial = String(index).padStart(5, '0')
    return {
      id: `font-${serial}`,
      fileName: `Font-${serial}.ttf`,
      family: `Family ${serial}`,
      fullName: `Family ${serial} Regular`,
      postscriptName: `Family-${serial}`,
      style: 'Regular',
      format: 'ttf',
      fileSize: 100000 + index,
      path: `C:\\Fonts\\Font-${serial}.ttf`,
      tagNames: [`tag-${index % 10}`],
      localTagNames: [`local-${index % 7}`],
      active: index % 11 === 0,
      installed: index % 3 === 0,
      createdAt: new Date(1700000000000 + index * 1000).toISOString(),
      modifiedAt: new Date(1710000000000 + index * 1000).toISOString()
    }
  })
}

function createFontIndex(fonts) {
  return new Map(fonts.map((font, index) => [font.id, {
    id: font.id,
    searchText: `${font.id} ${font.family} ${font.fullName} ${font.fileName} ${font.tagNames.join(' ')}`.toLowerCase(),
    scripts: index % 2 ? ['latin'] : ['cjk'],
    category: 'sansSerif',
    installed: !!font.installed,
    installStatusKnown: true,
    systemBuiltin: false,
    cleanSystem: false,
    bad: false,
    createdAtMs: Date.parse(font.createdAt),
    modifiedAtMs: Date.parse(font.modifiedAt)
  }]))
}

function createLibrary(fonts) {
  return {
    fonts: Object.fromEntries(fonts.map((font) => [font.id, font])),
    folders: [],
    folderAliases: {},
    folderNodes: [],
    collections: [],
    tags: [],
    localCollections: [],
    localTags: [],
    fontFolderIds: {},
    previewText: '汉字 AaBb 123',
    previewMode: 'sample'
  }
}

function visibleOptions(fonts, fontIndexById, library, deferredSearch) {
  return {
    databasePageReady: false,
    databasePageResult: null,
    allFonts: fonts,
    fontIndexById,
    deferredSearch,
    activeFilter: { kind: 'all', name: '全部字体' },
    selectedWatchedFolders: [],
    selectedFormats: [],
    selectedScripts: [],
    selectedCategory: 'all',
    selectedTagName: '',
    selectedSharedTagName: '',
    selectedFolderId: '',
    installStatus: 'all',
    timeSortMode: 'custom',
    sortMode: 'smart',
    sidebarPage: 'library',
    library
  }
}

function runTenThousandBenchmark(overrides = new Map()) {
  const load = createLoader({
    overrides,
    mocks: {
      'src/renderer/src/appConstants.ts::./constants/environmentConstants': {
        STARTUP_AUTO_SYSTEM_FONT_IMPORT_ENABLED: false,
        APP_VERSION: '3.0.0',
        RENDERER_ENV: {},
        IS_DEVELOPMENT: false
      }
    }
  })
  const { buildVisibleFonts, buildVirtualLayout } = load(virtualPath)
  const { shiftFontSelection } = load('src/renderer/src/fontSelectionRuntime.ts')
  const fonts = createFonts(fixture.fontCount)
  const library = createLibrary(fonts)
  const fontIndexById = createFontIndex(fonts)

  const searchStarted = performance.now()
  const searchCounts = fixture.searchQueries.map((query) => buildVisibleFonts(visibleOptions(fonts, fontIndexById, library, query)).length)
  const searchMs = performance.now() - searchStarted
  assert.equal(searchCounts[0], fixture.fontCount, 'empty search lost fonts')
  assert.equal(searchCounts[1], 1, 'specific 10k search result changed')
  assert.equal(searchCounts.at(-1), 0, 'missing 10k search must stay empty')
  assert(searchMs < fixture.searchBudgetMs, `10k search exceeded ${fixture.searchBudgetMs}ms: ${searchMs.toFixed(1)}ms`)

  let maxVirtualItems = 0
  const layouts = []
  const scrollStarted = performance.now()
  for (let index = 0; index < fixture.scrollSamples; index += 1) {
    const layout = buildVirtualLayout({
      databasePageReady: false,
      databasePageResult: null,
      visibleFonts: fonts,
      virtualViewport: { scrollTop: index * 160, height: 900, width: 1440 },
      minCardWidth: 240,
      rowHeight: 260
    })
    maxVirtualItems = Math.max(maxVirtualItems, layout.items.length)
    layouts.push(layout)
  }
  const scrollMs = performance.now() - scrollStarted
  assert(maxVirtualItems <= fixture.maxVirtualItems, `virtual window expanded to ${maxVirtualItems} cards`)
  assert(layouts.every((layout) => layout.totalHeight > 0 && layout.endIndex >= layout.startIndex), 'virtual scroll bounds changed')
  assert(scrollMs < fixture.scrollBudgetMs, `10k virtual scroll exceeded ${fixture.scrollBudgetMs}ms: ${scrollMs.toFixed(1)}ms`)

  const selectionStarted = performance.now()
  const selectedIds = shiftFontSelection(fonts, fonts.at(-1).id, fonts[0].id, [], false)
  const selectionMs = performance.now() - selectionStarted
  assert.equal(selectedIds.length, fixture.fontCount, '10k shift selection lost ids')
  assert(selectionMs < fixture.selectionBudgetMs, `10k selection exceeded ${fixture.selectionBudgetMs}ms: ${selectionMs.toFixed(1)}ms`)

  return { fonts, layouts, searchMs, scrollMs, selectionMs, maxVirtualItems }
}

function changedPropKeys(previous, next) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  return Array.from(keys).filter((key) => !Object.is(previous[key], next[key]))
}

function checkRendererStability(fonts, layouts, source = read(rendererPath)) {
  const harness = createHookHarness()
  const events = []
  const load = createLoader({
    hooks: harness.hooks,
    overrides: new Map([[rendererPath, source]]),
    mocks: {
      '../../appRuntime': { fontDisplayName: (font) => font.fullName || font.fileName },
      '../FontCard': { FontCard: Symbol.for('FontCard') }
    }
  })
  const useFontCardRenderer = load(rendererPath).useFontCardRenderer
  assert.equal(typeof useFontCardRenderer, 'function', 'FontCard renderer must expose the measured hook')
  const previewFamilies = {}
  const nativePreviewImages = {}
  const emptySelection = new Set()
  const options = (label, overrides = {}) => ({
    detailVisible: false,
    selectedFontId: undefined,
    selectedFontIdSet: emptySelection,
    previewFamilies,
    nativePreviewImages,
    previewText: '汉字 AaBb 123',
    listPreviewFontSize: 44,
    selectedFontIds: [],
    handleFontSelect: (_event, font) => events.push(`${label}:select:${font.id}`),
    handleFontOpenDetail: (_event, font) => events.push(`${label}:detail:${font.id}`),
    requestPreviewFont: (font, priority) => events.push(`${label}:preview:${font.id}:${priority}`),
    fontListScrolling: () => label === 'second',
    openFontMenu: (_event, font) => events.push(`${label}:menu:${font.id}`),
    setDraggingFontId: (fontId) => events.push(`${label}:drag:${fontId}`),
    ...overrides
  })

  const first = harness.render(useFontCardRenderer, options('first'))
  const firstElement = first.renderFontCard(fonts[0])
  const second = harness.render(useFontCardRenderer, options('second'))
  const secondElement = second.renderFontCard(fonts[0])
  assert.equal(first.renderFontCard, second.renderFontCard, 'callback-only App renders must keep renderFontCard stable')
  for (const key of ['onSelect', 'onOpenDetail', 'onVisible', 'onContextMenu', 'onDragStart', 'onDragEnd']) {
    assert.equal(firstElement.props[key], secondElement.props[key], `card ${key} changed during callback-only render`)
  }
  secondElement.props.onSelect({})
  secondElement.props.onVisible()
  assert.deepEqual(events.slice(-2), [`second:select:${fonts[0].id}`, `second:preview:${fonts[0].id}:normal`], 'stable handlers used stale controller ports')

  const detailTarget = layouts[0].items[0]
  const detailBefore = new Map(layouts[0].items.map((font) => [font.id, second.renderFontCard(font).props]))
  const detail = harness.render(useFontCardRenderer, options('detail', { detailVisible: true, selectedFontId: detailTarget.id }))
  const detailChanged = layouts[0].items.filter((font) => changedPropKeys(detailBefore.get(font.id), detail.renderFontCard(font).props).length > 0)
  assert.deepEqual(detailChanged.map((font) => font.id), [detailTarget.id], 'detail toggle invalidated unrelated visible cards')

  const detailCloseBefore = new Map(layouts[0].items.map((font) => [font.id, detail.renderFontCard(font).props]))
  const detailClosed = harness.render(useFontCardRenderer, options('detail-closed'))
  const detailCloseChanged = layouts[0].items.filter((font) => changedPropKeys(detailCloseBefore.get(font.id), detailClosed.renderFontCard(font).props).length > 0)
  assert.deepEqual(detailCloseChanged.map((font) => font.id), [detailTarget.id], 'detail close invalidated unrelated visible cards')

  const selectedFontIds = fonts.slice(0, fixture.selectedCount).map((font) => font.id)
  const selectedFontIdSet = new Set(selectedFontIds)
  const selectionBefore = new Map(layouts[0].items.map((font) => [font.id, detailClosed.renderFontCard(font).props]))
  const selection = harness.render(useFontCardRenderer, options('selection', { selectedFontIds, selectedFontIdSet }))
  const selectedVisible = layouts[0].items.filter((font) => selectedFontIdSet.has(font.id))
  const selectionChanged = layouts[0].items.filter((font) => changedPropKeys(selectionBefore.get(font.id), selection.renderFontCard(font).props).length > 0)
  assert.deepEqual(selectionChanged.map((font) => font.id), selectedVisible.map((font) => font.id), 'batch selection invalidated unrelated visible cards')

  const dragData = {}
  selection.renderFontCard(fonts[0]).props.onDragStart({ dataTransfer: {
    effectAllowed: '',
    setData(type, value) { dragData[type] = value }
  } })
  assert.equal(JSON.parse(dragData['application/x-hfm-font-ids']).length, fixture.selectedCount, 'stable drag handler used stale batch selection')

  const nextLayout = layouts.find((layout) => layout.startIndex > layouts[0].startIndex)
  assert(nextLayout, '10k scroll fixture did not advance the virtual window')
  const scrollBefore = new Map(layouts[0].items.map((font) => [font.id, selection.renderFontCard(font).props]))
  const scroll = harness.render(useFontCardRenderer, options('scroll', { selectedFontIds, selectedFontIdSet }))
  assert.equal(scroll.renderFontCard, selection.renderFontCard, 'scroll-only App render changed renderFontCard')
  const overlapping = nextLayout.items.filter((font) => scrollBefore.has(font.id))
  assert(overlapping.length > 0, 'adjacent virtual windows must overlap')
  assert(overlapping.every((font) => changedPropKeys(scrollBefore.get(font.id), scroll.renderFontCard(font).props).length === 0), 'scroll invalidated overlapping cards')
}

function checkStructure() {
  const app = read(appPath)
  const renderer = read(rendererPath)
  assert(app.includes("import { useFontCardRenderer } from './components/app/FontCardRenderer'"), 'App must use the measured card renderer hook')
  assert.equal((app.match(/useFontCardRenderer\(/g) || []).length, 1, 'App must compose one card renderer hook')
  assert(renderer.includes('useRef(new WeakMap<FontItem, FontCardHandlers>())'), 'card event handlers need a weak identity cache')
  assert(renderer.includes('useLayoutEffect(() => {'), 'latest event ports must update after commit')
  assert(renderer.includes('const renderFontCard = useCallback('), 'renderFontCard must be stable across callback-only renders')
  for (const controller of ['operationsController', 'developerController']) {
    assert(!new RegExp(`(?:topbar|sidebar|content|detail|overlays|developer)=\\{${controller}\\}`).test(app), `${controller} object must not cross the view boundary`)
  }
}

function main() {
  assert.equal(require('node:child_process').execFileSync('git', ['rev-parse', fixture.baseline], { cwd: root, encoding: 'utf8' }).trim(), fixture.baseline, 'AT-6.5 baseline is unavailable')
  const benchmark = runTenThousandBenchmark()
  checkStructure()
  checkRendererStability(benchmark.fonts, benchmark.layouts)

  const renderer = read(rendererPath)
  assert.throws(() => checkRendererStability(benchmark.fonts, benchmark.layouts, renderer.replace(
    'const handlerCacheRef = useRef(new WeakMap<FontItem, FontCardHandlers>())',
    'const handlerCacheRef = { current: new WeakMap<FontItem, FontCardHandlers>() }'
  )), 'per-render handler cache mutation escaped the stability gate')
  const virtual = read(virtualPath)
  assert.throws(() => runTenThousandBenchmark(new Map([[virtualPath, virtual.replace(
    'items: options.visibleFonts.slice(startIndex, endIndex)',
    'items: options.visibleFonts.slice(0, options.visibleFonts.length)'
  )]])), 'unbounded virtual window mutation escaped the 10k gate')
  checkRendererStability(benchmark.fonts, benchmark.layouts, renderer.replace(/\n/g, '\r\n'))

  console.log(`[diagnostics:react-render-performance] 10k search=${benchmark.searchMs.toFixed(1)}ms, scroll=${benchmark.scrollMs.toFixed(1)}ms/${fixture.scrollSamples}, selection=${benchmark.selectionMs.toFixed(1)}ms, maxCards=${benchmark.maxVirtualItems}; stable card handlers, scoped detail/selection updates, mutations and CRLF passed`)
}

try {
  main()
} catch (error) {
  console.error(`[diagnostics:react-render-performance] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
}
