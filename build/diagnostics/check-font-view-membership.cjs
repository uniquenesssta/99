#!/usr/bin/env node
'use strict'
// Windows-only: real renderer filtering/intent/tag authority, then production
// query composition + native SQLite population. Metadata fixtures do not prove
// real-font parsing, system installation, GUI paint or the user's omitted row.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '../..'), renderer = 'src/renderer/src/'
const plain = value => JSON.parse(JSON.stringify(value))
const ids = value => plain(value.map(font => font.id))
let assertions = 0
function equal(actual, expected, message) { assert.deepEqual(plain(actual), plain(expected), message); assertions++ }
function setup(transforms = {}) {
  const { loadModules } = require('./check-activation-entry.cjs')
  const load = loadModules({ window: {} }, {}, transforms)
  const view = load(renderer + 'fontViewRuntime.ts'), tags = load(renderer + 'fontTagStateAuthorityRuntime.ts')
  const intent = load(renderer + 'fontUserIntentRuntime.ts'), index = load(renderer + 'fontFilteringMetrics.ts').buildFontComputedIndex
  const empty = load(renderer + 'library-normalize/libraryNormalizeBase.ts').createEmptyLibrary
  const font = (id, patch = {}) => ({ id, path: `C:\\fixture\\${id}.ttf`, fileName: `${id}.ttf`, family: id, fullName: id,
    format: 'ttf', fileSize: 100, modifiedAt: 1, createdAt: 1, addedAt: '', scripts: ['latin'], favorite: false,
    collectionIds: [], localTagNames: [], tagNames: [], installStatusKnown: true, systemInstalled: false, active: false, ...patch })
  const options = (items, patch = {}) => ({ databasePageReady: true, databasePageResult: { items, total: items.length, offset: 0, limit: 100 },
    library: { ...empty(), folders: ['C:\\fixture'], fonts: Object.fromEntries(items.map(font => [font.id, font])) }, allFonts: items,
    fontIndexById: new Map(items.map(font => [font.id, index(font)])), deferredSearch: '', sidebarPage: 'library', activeFilter: { kind: 'all' },
    selectedWatchedFolders: [], selectedFormats: [], selectedScripts: [], selectedCategory: 'all', selectedTagName: '', selectedSharedTagName: '',
    selectedFolderId: '', installStatus: 'notInstalled', timeSortMode: 'created', sortMode: 'nameAsc', ...patch })
  return { load, view, tags, intent, index, font, options, empty }
}
function paginationAndDuplicateRows(transforms = {}) {
  const h = setup(transforms), { view, font, options } = h
  const good = font('good'), bad = font('bad', { previewError: '字体文件不存在: private name' })
  for (const offset of [0, 100, 4700]) {
    const result = { items: [bad, good], total: 4783, offset, limit: 100 }
    const output = view.buildVisibleFontResult(options(result.items, { databasePageResult: result }))
    equal(ids(output.fonts), ['good'], 'invalid row must remain excluded')
    equal(view.visibleFontResultTotal(result, output.fonts), 4783, 'partial page exclusion must not extrapolate a global total')
    equal(result.offset, offset, 'raw query cursor changed')
    equal(output.diagnostics.totalSource, 'database-query')
    equal(output.diagnostics.reasons, { 'missing-source-preview-error': 1 })
    equal(output.diagnostics.samples[0].ordinal, offset)
    const layout = view.buildVirtualLayout({ databasePageReady: true, databasePageResult: result, visibleFonts: output.fonts,
      virtualViewport: { width: 400, height: 300, scrollTop: 0 }, rowHeight: 100, minCardWidth: 100, columns: 1, panelPadding: 0 })
    equal(layout.totalHeight, 478300, 'scroll range shrank after a local exclusion')
  }
  const complete = { items: [bad, good], total: 2, offset: 0, limit: 100 }
  equal(view.visibleFontResultTotal(complete, [good]), 1, 'complete visible population must count exact local exclusions')
  equal(view.visibleFontResultTotal(null, [good]), 1)
  for (const items of [[{ ...bad, id: good.id }, good], [good, { ...bad, id: good.id }]]) {
    const output = view.buildVisibleFontResult(options(items, { library: { ...h.empty(), fonts: {} } }))
    equal(output.fonts.map(font => font.path), [good.path], 'same-ID sibling borrowed a valid/invalid computed index')
    equal(output.diagnostics.duplicateDatabaseIds, 1)
    equal(output.diagnostics.rejectedDatabaseRows, 1)
  }
  const validSibling = font('same', { systemInstalled: false }), installedSibling = font('same', { path: 'C:\\other\\same.ttf', systemInstalled: true })
  equal(view.buildVisibleFontResult(options([installedSibling, validSibling], { library: { ...h.empty(), fonts: {} } })).fonts.map(font => font.path), [validSibling.path], 'accepted ID reinstated an installed sibling')
}
function intentAndFilterDecisions(transforms = {}) {
  const h = setup(transforms), { view, font, options, tags, intent } = h
  const raw = font('row', { localTagNames: ['Local'], tagNames: ['Shared'] })
  const stopped = intent.markActiveIntent({ ...raw, active: false })
  const activeRaw = { ...raw, active: true }
  const settled = view.buildVisibleFontResult(options([activeRaw], { library: { ...h.empty(), fonts: { row: stopped } } }))
  equal(ids(settled.fonts), ['row'], 'active=false intent cannot remove a known not-installed row')
  equal(settled.fonts[0].active, false)
  equal(intent.hasFontUserIntent(stopped), true, 'diagnostics cleared user intent')
  for (const patch of [{ installStatusKnown: false }, { installStatusKnown: undefined }, { systemInstalled: true }]) {
    const output = view.buildVisibleFontResult(options([{ ...raw, ...patch }], { library: { ...h.empty(), fonts: { row: stopped } } }))
    equal(output.fonts.length, 0, 'stale cached known flags replaced fresh database evidence')
    equal(output.diagnostics.samples[0].stage, 'database-row')
    equal(output.diagnostics.samples[0].reason, patch.systemInstalled ? 'install-status-mismatch' : 'install-status-unknown')
  }
  for (const [patch, reason] of [
    [{ fileName: '._font.ttf' }, 'resource-fork-name'], [{ path: 'C:\\._cache\\font.ttf' }, 'resource-fork-path'],
    [{ fileSize: 63 }, 'undersized-font'], [{ previewError: '字体文件不存在' }, 'missing-source-preview-error'],
    [{ previewError: '路径已失效' }, 'invalid-source-preview-error']
  ]) {
    const output = view.buildVisibleFontResult(options([{ ...raw, ...patch }]))
    equal(output.fonts.length, 0); equal(output.diagnostics.reasons, { [reason]: 1 })
  }
  for (const fileAvailability of ['missing', 'unavailable']) {
    const recovered = { ...raw, recoveryPlaceholder: true, fileAvailability, fileSize: 0, previewError: '字体文件不存在', installStatusKnown: false }
    equal(view.buildVisibleFontResult(options([recovered], { installStatus: 'all' })).fonts.length, 1, 'historical recovery binding disappeared')
    equal(view.buildVisibleFontResult(options([recovered])).fonts.length, 0, 'unknown recovered binding became not installed')
    equal(view.buildVisibleFontResult(options([{ ...recovered, recoveryPlaceholder: false }], { installStatus: 'all' })).fonts.length, 0)
  }
  for (const [patch, reason] of [
    [{ activeFilter: { kind: 'favorites' } }, 'active-filter'], [{ deferredSearch: 'unmatched-private-keyword' }, 'search'],
    [{ sidebarPage: 'filters', selectedWatchedFolders: ['C:\\elsewhere'] }, 'watched-folder'],
    [{ sidebarPage: 'filters', selectedFormats: ['otf'] }, 'format'], [{ sidebarPage: 'filters', selectedScripts: ['arabic'] }, 'script'],
    [{ sidebarPage: 'filters', selectedCategory: 'art' }, 'category'], [{ sidebarPage: 'folders', selectedFolderId: 'virtual-missing' }, 'folder'],
    [{ sidebarPage: 'tags', selectedTagName: 'Absent' }, 'local-tag'], [{ sidebarPage: 'sharedTags', selectedSharedTagName: 'Absent' }, 'shared-tag']
  ]) {
    const output = view.buildVisibleFontResult(options([raw], patch))
    equal(output.fonts.length, 0); equal(output.diagnostics.reasons, { [reason]: 1 })
  }
  for (const scope of ['local', 'shared']) {
    const pageOptions = scope === 'local' ? { sidebarPage: 'tags', selectedTagName: 'Pending' } : { sidebarPage: 'sharedTags', selectedSharedTagName: 'Pending' }
    const edited = tags.markFontTagsOptimistic(raw, scope, ['Pending'])
    const library = { ...h.empty(), fonts: { row: edited }, localTags: [], tags: [], __localTagAuthorityKnown: true, __sharedTagAuthorityKnown: true }
    for (const phase of ['queued', 'sending', 'committed']) {
      if (phase === 'sending') tags.beginFontTagWrite(edited, scope)
      if (phase === 'committed') tags.settleFontTagWrite(edited, scope, true)
      const output = view.buildVisibleFontResult(options([raw], { ...pageOptions, library, allFonts: [edited] }))
      equal(ids(output.fonts), ['row'], `${scope}/${phase}: racing catalog removed a pending tag`)
      equal(tags.isFontTagStateDirty(output.fonts[0], scope), true, 'overlay dropped edit identity')
    }
    const confirm = tags.captureFontTagReadConfirmation(library)
    const confirmed = confirm(library, [raw])
    equal(tags.isFontTagStateDirty(confirmed.fonts.row, scope), false)
    const removed = view.buildVisibleFontResult(options([raw], { ...pageOptions, selectedTagName: 'Local', selectedSharedTagName: 'Shared', library: { ...confirmed, localTags: [], tags: [] } }))
    equal(removed.fonts.length, 0, 'settled catalog deletion was ignored')
    equal(removed.diagnostics.samples[0].stage, 'tag-authority')
    equal(removed.diagnostics.samples[0].rawReason, null)
    equal(removed.diagnostics.samples[0].intentReason, null)
    const foreign = { ...edited, path: 'C:\\foreign\\row.ttf' }
    equal(view.buildVisibleFontResult(options([raw], { ...pageOptions, library: { ...library, fonts: { row: foreign } } })).fonts.length, 0, 'same-ID different file borrowed pending tags')
  }
  const favorite = intent.markFavoriteIntent(raw, false)
  const rejected = view.buildVisibleFontResult(options([{ ...raw, favorite: true }], { activeFilter: { kind: 'favorites' }, library: { ...h.empty(), fonts: { row: favorite } } }))
  equal(rejected.diagnostics.samples[0].stage, 'user-intent')
  equal(rejected.diagnostics.samples[0].rawReason, null)
  equal(rejected.diagnostics.samples[0].intentReason, 'active-filter')
}
function traceEvidence() {
  const h = setup(), privateRows = Array.from({ length: 20 }, (_, i) => h.font('PRIVATE-' + i, { fileSize: 63, previewError: '字体文件不存在: SECRET', path: `C:\\PRIVATE\\${i}.ttf` }))
  const output = h.view.buildVisibleFontResult(h.options(privateRows)), second = h.view.buildVisibleFontResult(h.options(privateRows))
  equal(output.diagnostics.samples.length, 8, 'rejection samples are unbounded')
  equal(output.diagnostics.reasons, { 'undersized-font': 20 })
  equal(second.diagnostics.samples.map(sample => sample.row), output.diagnostics.samples.map(sample => sample.row), 'opaque correlation changes on repeated reads')
  assert(!/PRIVATE|SECRET|\.ttf|字体文件不存在/.test(JSON.stringify(output.diagnostics))); assertions++
  const sent = [], effects = [], logs = [], ref = { current: '' }
  const shouldAppend = h.load('src/main/logging/startupLogPolicy.ts').createStartupLogPolicy().shouldAppend
  const mainTrace = h.load('src/main/performance/rendererInteractionRuntime.ts').createRendererInteractionRuntime({ appendLog: line => { if (shouldAppend(line)) logs.push(line) } })
  const { loadModules } = require('./check-activation-entry.cjs')
  const app = path.join(root, renderer + 'appRuntime.ts')
  const load = loadModules({ window: { hfm: { reportPerformanceEvent: async event => { sent.push(event); mainTrace.reportPerformanceEvent(event) } } } }, {
    react: { useRef: () => ref, useEffect: fn => effects.push(fn), useLayoutEffect() {}, useMemo: fn => fn() },
    [app]: { traceRendererSyncComputation: (_label, _details, fn) => fn() },
    [path.join(root, renderer + 'runtime/app/useBrowseDerivedRuntime.ts')]: { useBrowseDerivedRuntime: () => ({ visibleFonts: [], fontMetrics: {}, membershipDiagnostics: output.diagnostics }) },
    [path.join(root, renderer + 'fontOperationTrace.ts')]: { observeFontRefreshPage() {} }
  })
  const options = { ...h.options(privateRows), cardPoolViewLayout: { listLayout: 'none', columns: 1, rowHeight: 100, minCardWidth: 100 },
    virtualViewport: { width: 400, height: 300, scrollTop: 0 }, selectedFontId: '', selectedFontIds: [], contextMenu: null,
    previewFamilies: {}, nativePreviewImages: {}, failedPreviewFontIds: {}, assignTagName: '', assignSharedTagName: '',
    latestVisibleFontsRef: { current: [] }, latestViewLayoutRef: { current: {} }, contextFontTargets: () => [] }
  load(renderer + 'runtime/app/useAppFontDerivedRuntime.ts').useAppFontDerivedRuntime(options)
  effects[0]()
  const rows = sent.filter(event => event.kind === 'font-query-rejections' && event.label === 'row-decision')
  equal(rows.length, 8, 'production renderer trace did not emit bounded samples')
  equal(rows[0].details.reason, 'undersized-font', 'trace sanitizer erased reason')
  equal(rows[0].details.rawReason, 'undersized-font')
  equal(rows[0].details.row, output.diagnostics.samples[0].row, 'trace sanitizer erased opaque row token')
  equal(sent.find(event => event.label === 'reason-counts').details.validity, { 'undersized-font': 20 })
  equal(sent.find(event => event.kind === 'font-query-view').details.membership.totalSource, 'complete-visible-result')
  assert(!/PRIVATE|SECRET|\.ttf|字体文件不存在/.test(JSON.stringify(rows))); assertions++
  const loggedRows = logs.filter(line => line.includes('kind=font-query-rejections') && line.includes('label=row-decision')).map(line => JSON.parse(line.slice(line.indexOf('details=') + 8)))
  equal(loggedRows.length, 8, 'main logging policy suppressed the bounded rejection evidence')
  equal(loggedRows[0].reason, 'undersized-font', 'main sanitizer erased reason')
  equal(loggedRows[0].row, output.diagnostics.samples[0].row)
  equal(mainTrace.isRendererUserActive(), false, 'diagnostic logging changed user activity and postponed background reconciliation')
  const before = sent.length; effects[0](); equal(sent.length, before, 'unchanged view floods diagnostics')
}
async function rendererRawCursor(transforms={}) {
  const { setup: browseSetup } = require('./check-browse-metrics-reuse.cjs')
  const timers=new Map(), requests=[], pending=[];let timerId=0
  const window={setTimeout:fn=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id)}
  const h=browseSetup({globals:{window},transforms})
  const view=h.load(renderer+'fontViewRuntime.ts'), queryKey=h.load(renderer+'constants/queryCacheRuntime.ts').rendererFontQueryCacheKey
  h.app.rendererFontQueryCacheKey=queryKey
  const items=h.opts.allFonts.slice(0,102).map((font,index)=>index===0?{...font,fileSize:1}:font)
  let options={...h.opts,library:{...h.opts.library,folders:['C:\\fixture'],fonts:Object.fromEntries(items.map(font=>[font.id,font]))},
    allFonts:items,hfm:{queryFontPage:request=>{requests.push(request);return new Promise(resolve=>pending.push({request,resolve}))}},
    libraryLoadedRef:{current:true},databaseRefreshToken:0,databaseQueryFailedKey:'',allFontsLength:items.length,indexingActive:false,
    selectedFontId:'',selectedFontIds:[],virtualViewport:{width:400,height:300,scrollTop:9700},viewLayout:{rowHeight:100,minCardWidth:100,columns:1},
    fontListScrollingRef:{current:false},fontMetricsRequestSeqRef:{current:0},databasePageRequestSeqRef:{current:0},rendererUserActive:()=>false,
    reportTrace(){},setDatabaseFontMetrics(){},setDatabaseQueryResult(){},setDatabaseQueryFailedKey(){},setStatus(){},
    setLibrary:fn=>{options.library=fn(options.library)},setDatabasePageResult:page=>{options.databasePageResult=page}}
  const request=view.createRendererFontQueryRequest({...options,databasePageLimit:100,databasePageOffset:0})
  options.databasePageResult={queryKey:queryKey(request),items:items.slice(0,100),total:102,offset:0,limit:100,truncated:true}
  const initial=view.buildVisibleFontResult({...options,fontIndexById:new Map()})
  equal(initial.fonts.length,99,'cursor fixture must retain the actual raw100/visible99 exclusion')
  equal(options.databasePageResult.items.length,100)
  const hook=h.load(renderer+'runtime/database/useRendererDatabasePageRuntime.ts').useRendererDatabasePageRuntime
  const render=()=>{h.hook.begin();const result=hook({...options});h.hook.flush();return result}
  try {
  render()
  const next=render()
  for(const [id,fn] of [...timers]){timers.delete(id);fn()}
  equal(requests.map(request=>request.offset),[100],'renderer next request used visible count instead of raw page count')
  equal(next.databaseQueryRequest.offset,100,'page request builder drifted from dispatched raw cursor')
  const response=pending[0]
  response.resolve({queryKey:queryKey(response.request),items:items.slice(100),total:102,offset:100,limit:100,truncated:false,engine:'sql'})
  await require('./check-activation-entry.cjs').tick()
  equal(options.databasePageResult.offset,0,'production merge shifted the raw origin')
  equal(options.databasePageResult.total,102)
  equal(ids(options.databasePageResult.items),ids(items),'production merge skipped/duplicated an identity after local exclusion')
  equal(view.buildVisibleFontResult({...options,fontIndexById:new Map()}).fonts.length,101)
  render()
  equal(requests.map(request=>request.offset),[100],'complete raw population re-requested a filtered gap')
  // Returning to the earlier viewport keeps the existing complete raw window.
  options={...options,virtualViewport:{...options.virtualViewport,scrollTop:0}}
  render()
  equal(requests.map(request=>request.offset),[100],'back-navigation lost the retained first raw page')
  // A new generation replaces its raw range; it must not retain the rejected
  // old row or infer a 101-row query from the previous visible window.
  options={...options,databaseRefreshToken:1}
  render();render()
  for(const [id,fn] of [...timers]){timers.delete(id);fn()}
  equal(requests.map(request=>request.offset),[100,0],'refresh did not reset its actual raw request to zero')
  const refreshed=items.slice(0,100).map((font,index)=>index===0?{...font,fileSize:100000}:font)
  const refresh=pending.at(-1)
  refresh.resolve({queryKey:queryKey(refresh.request),items:refreshed,total:102,offset:0,limit:100,truncated:true,engine:'sql'})
  await require('./check-activation-entry.cjs').tick()
  equal(options.databasePageResult.offset,0)
  equal(ids(options.databasePageResult.items),ids(refreshed),'new raw page retained obsolete members')
  equal(options.databasePageResult.items[0].fileSize,100000,'refresh retained the stale rejected row')
  const refreshedVisible=view.buildVisibleFontResult({...options,fontIndexById:new Map()})
  equal(refreshedVisible.fonts.length,100)
  equal(view.visibleFontResultTotal(options.databasePageResult,refreshedVisible.fonts),102,'partial refresh changed the authoritative query total')
  } finally { h.hook.cleanup() }
}
async function rendererRawCursorMutation() {
  const file=path.join(root,renderer+'runtime/database/useRendererDatabasePageRuntime.ts')
  const source=fs.readFileSync(file,'utf8'),from='const loadedItems = options.databasePageResult.items.length'
  equal(source.split(from).length,2,'raw cursor mutation anchor changed')
  const importFrom='import { createRendererFontQueryRequest }'
  equal(source.split(importFrom).length,2,'raw cursor mutation import anchor changed')
  await assert.rejects(()=>rendererRawCursor({[file]:text=>text.replace(importFrom,'import { buildVisibleFonts, createRendererFontQueryRequest }')
    .replace(from,'const loadedItems = buildVisibleFonts({ ...options, databasePageReady: true, allFonts: options.databasePageResult.items, fontIndexById: new Map() }).length')}),
    error=>error instanceof assert.AssertionError&&error.message.includes('renderer next request used visible count instead of raw page count'),
    'visible-count cursor mutant did not fail the real next-request assertion')
  assertions++
}

async function nativePopulation() {
  const { createHost } = require('./lib/production-projection-host.cjs')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-view-membership-')), fontRoot = path.join(directory, 'fonts')
  fs.mkdirSync(fontRoot)
  let host, primaryFailure
  try {
    host = await createHost({ sourceRoot: root, workerPath: path.join(root, 'build/native/hfm-core-worker.exe'), directory, fixtureDirectory: directory, roots: [fontRoot] })
    const h = setup(), items = Array.from({ length: 102 }, (_, i) => {
      const file = path.join(fontRoot, `${String(i).padStart(3, '0')}.ttf`), size = 1024, modifiedAt = 1767225600000
      return h.font(host.fontIdentity.fileRuntimeFontId(file, size, modifiedAt), { path: file, fileName: path.basename(file), fileSize: size,
        modifiedAt, createdAt: modifiedAt, previewError: i === 0 ? '字体文件不存在: historical diagnostic fixture' : undefined })
    })
    await host.initialize(items, { legacyRows: 1, oldProjection: true })
    await host.query.checkMergedIndexExternalChanges('view-membership-population')
    async function save(selected, installed, known = true) {
      host.queue.scheduleActivationInstallStatusSave(Object.fromEntries(selected.map(item => [item.id, { known, installed, by: installed ? 'user' : 'none', matches: [] }])),
        new Map(selected.map(item => [item.id, item])), 'view-membership-fixture')
      await host.queue.flushActivationInstallStatusSave('view-membership-fixture')
      assert(!host.queue.hasPendingActivationInstallStatusSave() && !host.queue.hasInFlightActivationInstallStatusSave()); assertions++
    }
    await save(items, false)
    const options = h.options(items, { library: { ...h.empty(), folders: [fontRoot], fonts: Object.fromEntries(items.map(item => [item.id, item])) } })
    const request = h.view.createRendererFontQueryRequest({ ...options, databasePageLimit: 100, databasePageOffset: 0 })
    async function read(offset, expectedTotal, expectedItems, expectedVisible) {
      const page = await host.query.queryFontPageInLibrary({ ...request, offset })
      equal(page.workerMode, 'rust-merged-index-page', 'renderer population gate bypassed native SQL')
      equal(page.total, expectedTotal); equal(page.items.length, expectedItems); equal(page.offset, offset)
      const output = h.view.buildVisibleFontResult({ ...options, databasePageResult: page })
      equal(output.fonts.length, expectedVisible)
      equal(h.view.visibleFontResultTotal(page, output.fonts), expectedTotal, 'partial native page invented a global display count')
      return { page, output }
    }
    const first = await read(0, 102, 100, 99), last = await read(100, 102, 2, 2)
    equal(first.output.diagnostics.reasons, { 'missing-source-preview-error': 1 }, 'actual native row rejection is not explained')
    equal(first.output.diagnostics.samples[0].stage, 'database-row')
    equal(ids([...first.page.items, ...last.page.items]).sort(), items.map(item => item.id).sort(), 'native pagination lost/duplicated raw rows')
    equal(ids([...first.output.fonts, ...last.output.fonts]).sort(), items.slice(1).map(item => item.id).sort(), 'renderer changed legitimate row membership')
    const metrics = await host.query.getFontMetricsFromLibrary()
    equal(metrics.workerMode, 'rust-merged-index-metrics'); equal(metrics.total, 102); equal(metrics.notInstalledCount, 102)
    const complete = await host.query.queryFontPageInLibrary({ ...request, limit: 200 })
    const completeOutput = h.view.buildVisibleFontResult({ ...options, databasePageResult: complete })
    equal(complete.items.length, 102); equal(completeOutput.fonts.length, 101)
    equal(h.view.visibleFontResultTotal(complete, completeOutput.fonts), 101, 'complete exact exclusions were hidden')
    await save([items[1]], true)
    await read(0, 101, 100, 99)
    equal((await host.query.getFontMetricsFromLibrary()).notInstalledCount, 101)
    await save([items[1]], false)
    await read(0, 102, 100, 99)
    await save([items[2]], false, false)
    const unknown = await read(0, 101, 100, 99)
    assert(!unknown.page.items.some(item => item.id === items[2].id), 'unknown state entered the native notInstalled population'); assertions++
    equal((await host.query.getFontMetricsFromLibrary()).installStatusMissingCount, 1)
    assert(host.nativeReceipts.some(receipt => receipt.method === 'runRustMergedIndexPageQuery')); assertions++
    assert(host.nativeReceipts.some(receipt => receipt.method === 'runRustInstallStatusSave')); assertions++
  } catch (error) { primaryFailure = error }
  finally {
    try { await host?.close() } catch (error) { primaryFailure ||= error }
    if (primaryFailure) {
      fs.writeFileSync(path.join(directory, 'diagnostic.log'), (host?.logs || []).join('\n'))
      console.error(`Controlled metadata fixture retained: ${directory}`)
    } else fs.rmSync(directory, { recursive: true, force: true })
  }
  if (primaryFailure) throw primaryFailure
}
function mutations() {
  const file = path.join(root, renderer + 'fontViewRuntime.ts')
  for (const [name, from, to, run] of [
    ['partial-total', 'return result && !isCompleteFontPage(result) ? Math.max(0, result.total) : fonts.length', 'return result ? Math.max(0, result.total + fonts.length - result.items.length) : fonts.length', paginationAndDuplicateRows],
    ['id-borrowed-index', 'const reason = fontRejectionReason(options, font, buildFontComputedIndex(font))', 'const reason = fontRejectionReason(options, font, buildFontComputedIndex(page.items[page.items.length - 1]))', paginationAndDuplicateRows],
    ['tag-intent-loss', 'current = applyFontTagEdit(current, cached, scope)', "current = { ...current, ...(scope === 'local' ? { localTagNames: cached.localTagNames } : { tagNames: cached.tagNames }) }", intentAndFilterDecisions],
    ['invalid-filter-bypass', 'if (index.bad)', 'if (false)', intentAndFilterDecisions]
  ]) {
    assert(fs.readFileSync(file, 'utf8').includes(from), `${name}: mutation anchor missing`)
    assert.throws(() => run({ [file]: source => source.replace(from, to) }), assert.AssertionError, `${name}: mutation survived`)
    assertions++
  }
}
async function main() {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  paginationAndDuplicateRows(); intentAndFilterDecisions(); traceEvidence(); mutations(); await rendererRawCursor(); await rendererRawCursorMutation(); await require('./check-manual-refresh-page-authority.cjs').run(); await nativePopulation()
  console.log(`[diagnostics:font-view-membership] ${assertions} assertions: row-level filtering, exact/partial totals, opaque bounded trace through production sanitizer, raced tag edits/catalogs, duplicate IDs, preserved safety/recovery/search/category filters; real native SQLite pages/metrics/install projection raw cursor/navigation through actual page-window and merge owners, and five rejected mutations. Metadata fixtures; actual user omission and GUI acceptance remain separate.`)
}
if (require.main === module) {
  let complete = false
  process.once('beforeExit', () => { if (!complete) { console.error('Font view membership diagnostic did not complete'); process.exitCode = 1 } })
  main().then(() => { complete = true }).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { main }
