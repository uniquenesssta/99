#!/usr/bin/env node
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process')
const { root, prefix, read, loader, css, fonts, renderCase } = require('./lib/font-view-layout-harness.cjs')
const geometryFile = prefix + 'runtime/app/fontViewLayoutRuntime.ts'
function behavior(overrides = {}) {
  const load = loader({ overrides }), build = load(geometryFile).buildFontViewLayout
  const virtual = load(prefix + 'fontViewRuntime.ts').buildVirtualLayout
  const scroll = load(prefix + 'fontScrollRuntime.ts'), grid = load(prefix + 'constants/layoutConstants.ts').getVirtualGridColumns
  for (const mode of ['list', 'grid']) for (const density of ['compact', 'comfortable', 'large']) for (const width of [420, 719, 720, 1179, 1180, 1500]) for (const size of [18, 44, 72]) for (const lines of [1, 2]) {
    const layout = build(mode, density, width, size, lines)
    assert.equal(layout.rowHeight, layout.cardHeight + layout.rowGap, 'row stride must include the real gap')
    if (mode === 'grid') assert.equal(layout.rowHeight, { compact: 266, comfortable: 342, large: 386 }[density], 'grid baseline changed')
    else {
      assert.equal(layout.listLayout, width < 720 ? 'stacked' : width < 1180 ? 'medium' : 'wide')
      assert.equal(layout.cardHeight, layout.previewHeight + 2 * layout.cardPaddingY + 2 + layout.infoHeight + layout.innerRowGap)
    }
    for (const top of [0, 15000, 1e9]) {
      const result = virtual({ ...layout, visibleFonts: fonts, virtualViewport: { width, height: 520, scrollTop: top }, databasePageReady: false, databasePageResult: null })
      assert.equal(result.startIndex % layout.columns, 0, 'last virtual slice lost row alignment')
      assert.equal(result.top, layout.panelPadding + result.startIndex / layout.columns * layout.rowHeight)
      assert.equal(result.totalHeight, layout.panelPadding * 2 + Math.ceil(fonts.length / layout.columns) * layout.rowHeight - layout.rowGap)
      if (top === 1e9) assert.equal(result.endIndex, fonts.length)
    }
  }
  const before = build('grid', 'comfortable', 1180, 44, 2), after = build('list', 'comfortable', 600, 72, 2)
  for (const density of ['compact', 'comfortable', 'large']) for (const size of [18, 57, 72]) for (const lines of [1, 2]) {
    const wide = build('list', density, 1218, size, lines), docked = build('list', density, 848, size, lines)
    for (const key of ['rowHeight', 'cardHeight', 'rowGap', 'cardPaddingX', 'previewHeight']) assert.equal(wide[key], docked[key], 'detail docking changed list geometry: ' + key)
  }
  const node = { scrollTop: 14 + before.rowHeight * 20 + 27, clientWidth: 600, clientHeight: 520, scrollHeight: 1e6 }
  // The DOM already has its new width: capture must use committed old columns.
  const selected = fonts[20 * before.columns + 1].id
  const snapshot = scroll.captureFontScrollSnapshotFromNode(node, fonts, before, 600, 14, grid, selected)
  assert.equal(snapshot.anchor.fontId, selected)
  const target = scroll.scrollTopForSnapshotAnchor(snapshot, node, fonts, after, 600, 14, grid)
  assert.equal(target, 14 + (20 * before.columns + 1) * after.rowHeight + 27)
  assert.equal(scroll.applyFontScrollTopToNode(node, 1e9, { width: 600, height: 520, scrollTop: 0 }).viewport.scrollTop, 1e6 - 520)
  const paged = virtual({ ...before, databasePageReady: true, databasePageResult: { offset: 100, total: 1003 }, visibleFonts: fonts.slice(100, 200), virtualViewport: { width: 1180, height: 520, scrollTop: 0 } })
  assert.equal(paged.top, 14 + Math.floor(100 / before.columns) * before.rowHeight)
  assert.equal(paged.startIndex, 100)
  const windowPolicy = load(prefix + 'runtime/database/rendererDatabasePageWindowRuntime.ts').rendererDatabaseViewportPageOffset
  for (const mode of ['list', 'grid']) {
    const layout = build(mode, 'comfortable', 1218, 57, 1), viewport = { width: 1218, height: 520, scrollTop: 25000 }
    const heights = [100, 200, 50].map(count => virtual({ ...layout, visibleFonts: fonts.slice(0, count), virtualViewport: viewport,
      databasePageReady: true, databasePageResult: { offset: 0, total: 10000 } }).totalHeight)
    assert.equal(new Set(heights).size, 1, 'page refill shrank browser scroll range')
    const jump = windowPolicy({ offset: 0, loadedItems: 100, totalItems: 10000, viewportHeight: 520, scrollTop: 500 * layout.rowHeight + 14, rowHeight: layout.rowHeight, columns: layout.columns })
    assert.equal(jump, Math.floor(500 * layout.columns / 100) * 100, 'fast jump serially crawls intermediate pages')
    assert.equal(windowPolicy({ offset: jump, loadedItems: 100, totalItems: 10000, viewportHeight: 520, scrollTop: 0, rowHeight: layout.rowHeight, columns: layout.columns }), 0, 'backward jump cannot reload page zero')
  }
  const merge = load(prefix + 'runtime/database/useRendererDatabasePageRuntime.ts').mergeIncrementalDatabasePage
  const pageResult = (offset, count = 100) => ({ offset, items: fonts.slice(offset, offset + count), total: 1003, queryKey: JSON.stringify({ offset, limit: count, keyword: '' }) })
  assert.equal(merge(pageResult(0), pageResult(500)).offset, 500, 'noncontiguous ranges falsely concatenated')
  assert.equal(merge(pageResult(500), pageResult(600)).items.length, 200)
  assert.equal(merge(pageResult(500), pageResult(400)).offset, 400)
  assert.equal(merge(pageResult(500), pageResult(0)).offset, 0)
  const page = load(prefix + 'runtime/database/rendererDatabasePageWindowRuntime.ts').buildRendererDatabasePageWindow({ ...before, width: 600, height: 520, scrollTop: 5000, pageOffset: 199 })
  assert.equal(page.columns, before.columns); assert.equal(page.offset, 100); assert.equal(page.limit, 100)
  const fallback = load(prefix + 'runtime/app/cardPoolViewModePolicyRuntime.ts').effectiveCardPoolViewMode
  for (const tab of ['tags', 'sharedTags']) assert.equal(fallback('family', tab, { kind: 'all' }), 'grid')
  assert.equal(fallback('family', 'library', { kind: 'favorites' }), 'grid')
  assert.equal(fallback('list', 'tags', { kind: 'all' }), 'list')
}
function hookCases() {
  let slots = [], cursor = 0, effects = [], observed = [], disconnected = []
  const hooks = { useRef(value) { const i = cursor++; return slots[i] ||= { current: value } }, useLayoutEffect: effect, useEffect: effect }
  function effect(fn, deps) { const i = cursor++, prior = slots[i]; if (!prior || deps.some((d, j) => d !== prior.deps[j])) { prior?.cleanup?.(); const slot = slots[i] = { deps }; effects.push(() => { slot.cleanup = fn() }) } }
  const render = (hook, args) => { cursor = 0; hook(args); const pending = effects; effects = []; pending.forEach(fn => fn()) }
  const load = loader({ hooks, globals: { window: { addEventListener() {}, removeEventListener() {} }, ResizeObserver: class { observe(node) { observed.push(node) } disconnect() { disconnected.push(true) } } } })
  const build = load(geometryFile).buildFontViewLayout, anchor = load(prefix + 'runtime/app/useFontScrollRestoreRuntime.ts').useFontLayoutScrollAnchor
  const before = build('list', 'comfortable', 1200, 44, 2), after = build('list', 'comfortable', 719, 72, 2)
  const node = { scrollTop: 14 + before.rowHeight * 40 + 17, scrollHeight: 1e6, clientWidth: 1200, clientHeight: 520 }
  let viewport = { scrollTop: node.scrollTop, width: 1200, height: 520 }
  const options = { layout: before, fonts, viewport, fontScrollerRef: { current: node }, setVirtualViewport: value => { viewport = value }, preferredFontId: '', enabled: true }
  render(anchor, options); node.clientWidth = 719
  render(anchor, { ...options, layout: after })
  assert.equal(node.scrollTop, 14 + after.rowHeight * 40 + 17, 'resize/size change lost anchor')
  assert.equal(viewport.scrollTop, node.scrollTop)
  render(anchor, { ...options, fonts: fonts.slice().reverse(), layout: before, viewport })
  assert.equal(node.scrollTop, viewport.scrollTop, 'filter/sort must own their reset')
  slots = []; cursor = 0
  const resize = load(prefix + 'runtime/app/effects/useFontViewportResizeObserverRuntime.ts').useFontViewportResizeObserverRuntime
  viewport = { scrollTop: 0, width: 719, height: 520 }; node.clientWidth = 720; node.scrollTop = 0
  const resizeOptions = { viewportKey: 'library:list', fontScrollerRef: { current: node }, setVirtualViewport: update => { viewport = update(viewport) } }
  render(resize, resizeOptions); assert.equal(viewport.width, 720, 'one-pixel breakpoint change was dropped')
  const replacement = { ...node, clientWidth: 1180 }; resizeOptions.fontScrollerRef.current = replacement
  render(resize, { ...resizeOptions, viewportKey: 'library:family' })
  assert.equal(observed[1], replacement); assert.equal(disconnected.length, 1)
}
function makeDomFile() {
  const load = loader(), cases = []
  for (const mode of ['list', 'grid']) for (const density of ['compact', 'comfortable', 'large']) for (const width of [420, 719, 720, 1179, 1180, 1500]) for (const size of [18, 72]) for (const lines of [1, 2]) {
    cases.push(renderCase(load, { mode, density, width, size, lines, scrollTop: cases.length % 2 ? 15000 : 0 }))
  }
  for (const mode of ['list', 'grid']) {
    cases.push(renderCase(load, { mode, density: 'comfortable', width: 900, scrollTop: 1e9 }))
    cases.push(renderCase(load, { mode, density: 'comfortable', width: 900, offset: 100, scrollTop: 11000 }))
    cases.push(renderCase(load, { mode, density: 'comfortable', width: 900, total: 0 }))
  }
  const family = renderCase(load, { mode: 'family', density: 'comfortable', width: 900 })
  const familyBaselineCss = css(undefined, file => cp.execFileSync('git', ['show', `6012cb6:${file}`], { cwd: root, encoding: 'utf8' }))
  const samples = require('./check-preview-layout-contract.cjs').makeDomSamples()
  const webFontData = process.platform === 'win32' ? fs.readFileSync(path.join(process.env.WINDIR, 'Fonts/arial.ttf')).toString('base64') : null
  const listSamples = []
  for (const size of [18,44,72]) for (const text of ['Ag 字体', 'Wide '.repeat(80) + '\nSecond', '\nAg']) {
    const spec=load('src/shared/preview-layout/previewTextFitRuntime.ts').getCardPreviewLayout('list',text,size)
    for(const route of webFontData ? ['fallback','system','webfont'] : ['fallback']) listSamples.push({...renderCase(load,{mode:'list',density:'compact',width:720,total:1,size,lines:spec.lines.length,previewText:text,previewFamily:route==='webfont'?'HfmV03WebFont':undefined,fontOverrides:route==='system'?{family:'Arial',systemInstalled:true}:undefined}),size,expectedText:spec.text,route,canvasWidth:spec.width,canvasHeight:spec.height,native:false})
  }
  if(process.env.HFM_LIST_NATIVE_SAMPLES) for(const sample of JSON.parse(fs.readFileSync(path.resolve(root,process.env.HFM_LIST_NATIVE_SAMPLES),'utf8'))) {
    listSamples.push({...renderCase(load,{mode:'list',density:'compact',width:720,total:1,size:sample.size,lines:sample.text.split('\n').length,previewText:sample.text,previewImage:sample.image}),size:sample.size,canvasWidth:sample.width,canvasHeight:sample.height,native:true})
  }
  const ts=require('typescript'), viewportSource=ts.transpileModule(read(prefix+'components/ListPreviewViewport.tsx'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText
  const reactScripts='<script>'+fs.readFileSync(path.join(root,'node_modules/react/umd/react.development.js'),'utf8')+'</script><script>'+fs.readFileSync(path.join(root,'node_modules/react-dom/umd/react-dom.development.js'),'utf8')+'</script>'
  const viewportScript='const viewportExports={};(function(require,exports){'+viewportSource+'})(()=>({jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}),viewportExports);window.ListPreviewViewport=viewportExports.ListPreviewViewport;'
  const checkDom = require('./lib/font-view-layout-dom.cjs')
  const select = load(prefix + 'fontSelectionRuntime.ts').fontIdsInClientRect
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-layout-')), file = path.join(temp, 'layout.html')
  fs.writeFileSync(file, '<!doctype html><html data-theme="light"><meta charset="utf-8"><style>' + css() + '</style><body><div id="fixture"></div>' + reactScripts + '<script>' + viewportScript + 'const webFontData=' + JSON.stringify(webFontData) + ';const listSamples=' + JSON.stringify(listSamples).replace(/</g, '\\u003c') + ';const cases=' + JSON.stringify(cases).replace(/</g, '\\u003c') + ';const family=' + JSON.stringify(family).replace(/</g, '\u003c') + ';const familyBaselineCss=' + JSON.stringify(familyBaselineCss).replace(/</g, '\u003c') + ';const select=' + select.toString() + ';const samples=' + JSON.stringify(samples).replace(/</g, '\\u003c') + ';window.checkLayout=' + checkDom.toString() + '</script></body></html>')
  const gridNativeSamples = process.env.HFM_GRID_NATIVE_SAMPLES ? JSON.parse(fs.readFileSync(path.resolve(root, process.env.HFM_GRID_NATIVE_SAMPLES), 'utf8')) : []
  fs.appendFileSync(file, '<script>window.gridNativeSamples=' + JSON.stringify(gridNativeSamples).replace(/</g, '\\u003c') + ';window.gridWebFontData=' + JSON.stringify(webFontData) + '</script>')
  const detailBundle = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, 'lib/font-detail-transition-dom.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { '@shared': path.join(root, 'src/shared') }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' } }).outputFiles[0].text
  fs.appendFileSync(file, '<script>' + detailBundle.replace(/<\/script/gi, '<\\/script') + '</script>')
  return { file, temp, count: cases.length }
}
behavior(); hookCases()
require('./lib/font-detail-transition-cases.cjs')()
assert.throws(() => behavior({ [geometryFile]: read(geometryFile).replace('rowHeight: cardHeight + rowGap', 'rowHeight: cardHeight') }), /stride/)
const virtualFile = prefix + 'fontViewRuntime.ts'
assert.throws(() => behavior({ [virtualFile]: read(virtualFile).replace('Math.max(0, Math.ceil(options.visibleFonts.length / columns) - visibleRows) * columns', 'Math.max(0, options.visibleFonts.length - visibleRows * columns)') }), /alignment/)
console.log('[font-view-layout] geometry matrix, paging, anchors, resize rebind/breakpoints, fallback and two regression mutants passed')
if (process.argv.includes('--dom') || process.argv.includes('--emit-dom')) {
  const { file, temp, count } = makeDomFile()
  if (process.argv.includes('--emit-dom')) console.log(file)
  else {
    try {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = cp.spawnSync(require('electron'), [path.join(__dirname, 'lib/font-view-layout-electron.cjs'), file], { cwd: root, env, encoding: 'utf8', timeout: 210000 })
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
      if (result.error) throw result.error
      assert.equal(result.status, 0, 'real Electron DOM geometry gate failed')
      console.log(`[font-view-layout] ${count} real DOM scenarios and legacy-gap mutant passed`)
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  }
}
