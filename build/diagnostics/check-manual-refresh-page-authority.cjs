#!/usr/bin/env node
'use strict'
// Controlled React scheduling and IPC promises; actual App wiring, page owner,
// derived view and committed-index event. This is not GUI or timing acceptance.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const { setup, hookPort } = require('./check-browse-metrics-reuse.cjs')
const { tick } = require('./check-activation-entry.cjs')
const root = path.resolve(__dirname, '../..'), renderer = 'src/renderer/src/'
const appFile = path.join(root, renderer + 'App.tsx')
const pageFile = path.join(root, renderer + 'runtime/database/useRendererDatabasePageRuntime.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const noop = () => {}

function appStatements(source) {
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const body = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App')?.body
  assert(body, 'production App body missing')
  const names = new Set(['databaseRuntime', 'databasePageReady', 'displayDatabasePageReady', 'visibleFontTotal', 'handleFontScroll', 'contentViewProps'])
  const selected = body.statements.filter(node => {
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(declaration =>
      names.has(declaration.name.getText(file)) || declaration.initializer?.expression?.getText(file) === 'useAppFontDerivedRuntime')
    return ts.isExpressionStatement(node) && node.expression?.right?.expression?.getText(file) === 'useFontLayoutScrollAnchor'
  })
  assert.equal(selected.length, 8, 'production page/view/scroll wiring extraction changed')
  return selected.map(node => node.getText(file)).join('\n')
}

function fixture({ appSource = fs.readFileSync(appFile, 'utf8'), transforms = {} } = {}) {
  const timers = new Map(), requests = [], cancelled = [], traces = [], status = []
  let timerId = 0, indexChanged, queryRecovered = 0
  const window = { setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) }
  const h = setup({ globals: { window }, transforms })
  h.hook.useLayoutEffect = h.hook.useEffect
  const view = h.load(renderer + 'fontViewRuntime.ts')
  const key = h.load(renderer + 'constants/queryCacheRuntime.ts').rendererFontQueryCacheKey
  h.app.rendererFontQueryCacheKey = key
  const fonts = h.opts.allFonts.map((font, i) => ({ ...font, systemInstalled: i % 2 === 0, localTagNames: ['test'] }))
  const cached = fonts.slice(0, 265)
  const layout = { rowHeight: 100, minCardWidth: 100, columns: 1, panelPadding: 14, rowGap: 0, listLayout: 'wide' }
  const options = { ...h.opts, allFonts: cached, allFontsLength: cached.length,
    library: { ...h.opts.library, folders: ['C:/fixture'], fonts: Object.fromEntries(cached.map(font => [font.id, font])) },
    libraryLoadedRef: { current: true }, databaseRefreshToken: 0, databaseMetricsRefreshToken: 0,
    databasePageResult: null, databaseQueryResult: null, databaseQueryFailedKey: '', indexingActive: false,
    virtualViewport: { width: 400, height: 300, scrollTop: 0 }, cardPoolViewLayout: layout, effectiveCardPoolMode: 'list',
    selectedFontId: '', selectedFontIds: [], fontListScrollingRef: { current: false }, fontMetricsRequestSeqRef: { current: 0 }, databasePageRequestSeqRef: { current: 0 },
    rendererUserActive: () => false, reportRendererTrace: event => traces.push(event), setStatus: value => status.push(value),
    fontScrollerRef: { current: null }, latestVisibleFontsRef: { current: [] }, latestViewLayoutRef: { current: layout },
    detailViewportTransitionRef: { current: null }, detailVisible: false, fontBrowseScopeKey: 'fixture',
    previewFamilies: {}, nativePreviewImages: {}, failedPreviewFontIds: {}, assignTagName: '', assignSharedTagName: '', contextMenu: null,
    previewStateForFont: undefined, requestPreviewFont: noop, contextFontTargets: () => [], setVirtualViewport: value => { options.virtualViewport = value },
    scrollRafRef: { current: null }, lastScrollTraceAtRef: { current: 0 }, beginFontListScroll: noop, reportUserActivity: noop,
    PREVIEW_SCROLL_IDLE_MS: 180, USER_ACTIVITY_IDLE_WINDOW_MS: 500,
    viewMode: 'comfortable', cardPoolViewMode: 'list', setCardPoolViewMode: noop, listPreviewFontSize: 44, setListPreviewFontSize: noop,
    updatePageToolbar: noop, updateViewModeWithScroll: noop, search: '', closeDetail: noop, beginMarqueeSelection: noop, renderFontCard: noop,
    fontFamilyGroupResult: null, fontFamilyGroupLoading: false, fontFamilyGroupError: '', expandedFontFamilyIds: {}, toggleFontFamilyExpanded: noop }
  for (const [setter, field] of Object.entries({ setLibrary: 'library', setDatabaseFontMetrics: 'databaseFontMetrics', setDatabasePageResult: 'databasePageResult',
    setDatabaseQueryResult: 'databaseQueryResult', setDatabaseQueryFailedKey: 'databaseQueryFailedKey', setDatabaseRefreshToken: 'databaseRefreshToken' })) {
    options[setter] = value => { options[field] = typeof value === 'function' ? value(options[field]) : value }
  }
  window.hfm = { queryFontPage(request, token) {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    requests.push({ request, token, resolve, reject }); return promise
  }, cancelFontQuery: async token => { cancelled.push(token) },
  onFontIndexChanged: handler => { indexChanged = handler; return () => { indexChanged = undefined } } }
  options.reportQueryError = options.setStatus
  options.clearQueryError = () => { queryRecovered++ }
  const context = { window, ...options,
    useRendererDatabasePageRuntime: h.load(renderer + 'runtime/database/useRendererDatabasePageRuntime.ts').useRendererDatabasePageRuntime,
    useAppFontDerivedRuntime: h.load(renderer + 'runtime/app/useAppFontDerivedRuntime.ts').useAppFontDerivedRuntime,
    visibleFontResultTotal: view.visibleFontResultTotal,
    useFontListScrollRuntime: args => args, useFontLayoutScrollAnchor: args => args }
  const source = 'function render() {\n' + appStatements(appSource) + '\nreturn { databaseRuntime, visibleFontTotal, visibleFonts, virtualLayout, contentViewProps, scroll: handleFontScroll, anchor: detailViewportTransitionRef.current };\n}\nrender'
  const renderApp = vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  const render = () => { Object.assign(context, options); h.hook.begin(); const result = renderApp(); h.hook.flush(); return result }
  const dispatch = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } }
  const resultFor = (entry, total = 5491, items) => ({ queryKey: key(entry.request), offset: entry.request.offset, limit: entry.request.limit,
    items: items || fonts.slice(entry.request.offset, entry.request.offset + 100), total, truncated: entry.request.offset + 100 < total, engine: 'sql', elapsedMs: 0 })
  const settle = async (entry = requests.at(-1), total, items) => { entry.resolve(resultFor(entry, total, items)); await tick(); return render() }
  const refresh = h.load(renderer + 'databaseDerivedStateRuntime.ts').refreshDatabaseDerivedStateRuntime
  const events = hookPort(), { loadModules } = require('./check-activation-entry.cjs')
  const eventLoad = loadModules({ window }, { react: events, [path.join(root, renderer + 'appRuntime.ts')]: h.app })
  events.begin()
  eventLoad(renderer + 'runtime/app/effects/useFontIndexChangedEventRuntime.ts').useFontIndexChangedEventRuntime({
    hfm: window.hfm, getCurrentLibrary: () => options.library, commitLibraryUpdate: options.setLibrary,
    saveLibraryImmediately: async () => true, cleanupRemovedFontState: noop, captureFontScrollSnapshot: noop, restoreFontScrollSnapshot: noop,
    setStatus: options.setStatus, refreshDatabaseDerivedState: () => refresh({ ...options, timerRef: { current: null }, clearTimeout: window.clearTimeout }) })
  events.flush()
  return { options, requests, cancelled, traces, status, fonts, render, dispatch, settle, resultFor, key,
    get queryRecovered() { return queryRecovered },
    async commit(revision) { indexChanged({ source: 'projection', projectionRevision: revision, upserts: [], deletes: [], errors: [] }); await tick() },
    close() { h.hook.cleanup(); events.cleanup() } }
}

function authoritative(output, total, ids, offset = 0) {
  assert.equal(output.databaseRuntime.databasePageReady, true, 'valid query page lost hook authority')
  assert.equal(output.contentViewProps.databasePageReady, true, 'manual indexing hid the authoritative App page')
  assert.equal(output.scroll.databasePageReady, true, 'scroll consumer lost authoritative page')
  assert.equal(output.visibleFontTotal, total, 'App displayed the frontend hot-cache total')
  assert.equal(output.contentViewProps.visibleFontTotal, total)
  assert.equal(output.scroll.visibleFontTotal, total)
  assert.deepEqual(plain(output.visibleFonts.map(font => font.id)), ids, 'App derivation substituted the hot cache')
  assert.equal(output.virtualLayout.totalHeight, 28 + total * 100, 'refresh collapsed the query scroll range')
  assert.equal(output.anchor.fontOffset, offset, 'App scroll anchor lost the raw query offset')
}
async function refreshCases(settings = {}) {
  const f = fixture(settings), ids = items => items.map(font => font.id)
  try {
    let output = f.render(); assert.equal(output.contentViewProps.databasePageReady, false, 'pending first load fabricated readiness')
    f.options.indexingActive = true
    assert.equal(f.render().contentViewProps.databasePageReady, false, 'indexing fabricated first-load readiness')
    f.options.indexingActive = false; f.render()
    f.dispatch(); output = await f.settle()
    authoritative(output, 5491, ids(f.fonts.slice(0, 100)))
    assert.equal(f.queryRecovered, 1, 'QUERY_RECOVERY: accepted first page did not retire its error notice')
    const accepted = f.options.databasePageResult, count = f.requests.length
    f.options.indexingActive = true; output = f.render()
    authoritative(output, 5491, ids(accepted.items))
    assert.equal(f.requests.length, count, 'indexing start restarted the page query')
    // A projection commit retains its current page, invalidates readers and
    // replaces the same range only after an accepted response.
    await f.commit(1); output = f.render(); f.render(); f.dispatch()
    authoritative(output, 5491, ids(accepted.items))
    const old = f.requests.at(-1)
    await f.commit(2); output = f.render(); f.render(); f.dispatch()
    authoritative(output, 5491, ids(accepted.items))
    assert(f.cancelled.includes(old.token), 'committed index did not cancel its obsolete query')
    output = await f.settle(f.requests.at(-1), 5500)
    authoritative(output, 5500, ids(f.fonts.slice(0, 100)))
    old.resolve(f.resultFor(old, 1, [f.fonts[499]])); await tick()
    authoritative(f.render(), 5500, ids(f.fonts.slice(0, 100)))
    assert(f.traces.some(row => row.kind === 'db-query-rejected'), 'late commit response was not rejected')
    // Valid navigation remains usable while the manual scan is still active.
    f.options.installStatus = 'installed'; output = f.render()
    assert.equal(output.contentViewProps.databasePageReady, false, 'wrong-scope page revived during refresh')
    f.dispatch(); const installed = f.fonts.filter(font => font.systemInstalled).slice(0, 100)
    output = await f.settle(f.requests.at(-1), 708, installed)
    authoritative(output, 708, ids(installed))
    assert.equal(f.options.indexingActive, true)
    f.options.virtualViewport = { ...f.options.virtualViewport, scrollTop: 50114 }
    f.render(); f.render(); f.dispatch()
    assert.equal(f.requests.at(-1).request.offset, 500, 'refresh navigation lost direct raw page offset')
    const nextItems = f.fonts.filter(font => font.systemInstalled).slice(500, 600)
    output = await f.settle(f.requests.at(-1), 708, nextItems)
    authoritative(output, 708, ids(nextItems), 500)
    await f.commit(3); f.render(); f.render(); f.dispatch()
    assert.equal(f.requests.at(-1).request.offset, 0, 'committed index did not restart the raw query window')
    output = await f.settle(f.requests.at(-1), 708, installed)
    authoritative(output, 708, ids(installed))
    f.render(); f.dispatch()
    assert.equal(f.requests.at(-1).request.offset, 500, 'refreshed window lost the current viewport demand')
    output = await f.settle(f.requests.at(-1), 708, nextItems)
    authoritative(output, 708, ids(nextItems), 500)
    f.options.virtualViewport = { ...f.options.virtualViewport, scrollTop: 0 }
    f.render(); f.render(); f.dispatch()
    assert.equal(f.requests.at(-1).request.offset, 0, 'back-navigation did not request page zero')
    output = await f.settle(f.requests.at(-1), 708, installed)
    authoritative(output, 708, ids(installed))
    const beforeEnd = f.requests.length
    f.options.indexingActive = false; output = f.render(); f.dispatch()
    authoritative(output, 708, ids(installed))
    assert.equal(f.requests.length, beforeEnd, 'indexing end restarted an already accepted page')
    await f.commit(4); f.render(); f.render(); f.dispatch()
    output = await f.settle(f.requests.at(-1), 710, installed)
    authoritative(output, 710, ids(installed))
    const committedToken = f.options.databaseRefreshToken
    await f.commit(4)
    assert.equal(f.options.databaseRefreshToken, committedToken, 'duplicate projection commit restarted the query')
    // A real new-scope failure still uses memory; cancellation never labels it
    // failed, and a late previous-scope success cannot replace the newer scope.
    f.options.indexingActive = true; f.options.installStatus = 'notInstalled'; f.render(); f.dispatch()
    const retired = f.requests.at(-1)
    f.options.sidebarPage = 'tags'; f.options.selectedTagName = 'test'; output = f.render(); f.dispatch()
    assert.equal(output.contentViewProps.databasePageReady, false)
    f.requests.at(-1).reject(Error('controlled database read failure')); await tick(); output = f.render()
    assert.equal(output.contentViewProps.databasePageReady, false, 'real query failure fabricated readiness')
    assert.equal(f.options.databasePageResult, null)
    assert(f.options.databaseQueryFailedKey, 'real query failure lost fallback key')
    assert(f.status.some(value => value.includes('已回退前端筛选')), 'real failure lost memory fallback status')
    const recoveryBeforeRetired = f.queryRecovered
    retired.resolve(f.resultFor(retired, 4783)); await tick()
    assert.equal(f.queryRecovered, recoveryBeforeRetired, 'late old scope cleared the current failure notice')
    assert.equal(f.options.databasePageResult, null, 'late old-scope result revived a failed current page')
    await f.commit(5); f.render(); f.render(); f.dispatch()
    const recovered = f.fonts.filter(font => !font.systemInstalled).slice(0, 100)
    output = await f.settle(f.requests.at(-1), 4783, recovered)
    authoritative(output, 4783, ids(recovered))
    assert.equal(f.queryRecovered, recoveryBeforeRetired + 1, 'QUERY_RECOVERY: accepted recovery did not retire its notice')
    for (const [revision, error] of [[6, Object.assign(Error('retired query'), { reason: 'query-superseded' })], [7, Error('temporary same-scope read failure')]]) {
      await f.commit(revision); f.render(); f.render(); f.dispatch()
      f.requests.at(-1).reject(error); await tick(); output = f.render()
      authoritative(output, 4783, ids(recovered))
      assert.equal(f.options.databaseQueryFailedKey, '', 'retained same-scope page was marked as fallback')
    }
    assert(f.traces.some(row => row.kind === 'db-query-cancelled'), 'typed cancellation became a failure')
    assert(f.status.some(value => value.includes('保留上次结果')), 'same-scope failure lost retained-page status')
    f.options.databaseQueryFailedKey = output.databaseRuntime.databaseQueryKey
    assert.equal(f.render().contentViewProps.databasePageReady, false, 'failed current query key was ignored')
    f.options.databaseQueryFailedKey = ''; f.options.effectiveCardPoolMode = 'family'
    assert.equal(f.render().contentViewProps.databasePageReady, false, 'disabled page query fabricated readiness')
  } finally { f.close() }
}
async function run() {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  await refreshCases()
  const source = fs.readFileSync(appFile, 'utf8'), anchor = 'const displayDatabasePageReady = databasePageReady'
  assert.equal(source.split(anchor).length, 2, 'refresh readiness mutation anchor changed')
  await assert.rejects(() => refreshCases({ appSource: source.replace(anchor, anchor + ' && !indexingActive') }), /manual indexing hid the authoritative App page/)
  await refreshCases({ appSource: source.replace(/\r?\n/g, '\r\n') })
  const current = fs.readFileSync(pageFile, 'utf8'), scope = 'databaseResultScope === databaseQueryScope'
  assert.equal(current.split(scope).length, 2, 'page scope mutation anchor changed')
  await assert.rejects(() => refreshCases({ transforms: { [pageFile]: text => text.replace(scope, 'true') } }), /wrong-scope page revived/)
  const recovered = '        options.onReadRecovered?.()'
  assert.equal(current.split(recovered).length, 2, 'query recovery mutation anchor')
  await assert.rejects(() => refreshCases({ transforms: { [pageFile]: text => text.replace(recovered, '') } }), /QUERY_RECOVERY/)
  console.log('[diagnostics:manual-refresh-page-authority] production App/page/derived wiring retains current-scope pages and totals during refresh; real commit invalidation, late-response rejection, navigation/raw offsets, first-load/failure/disabled guards; LF/CRLF and masking/scope mutants passed (controlled ports).')
}
module.exports = { run, refreshCases }
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1 })
