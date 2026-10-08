#!/usr/bin/env node
// Source-owner mechanics, not latency measurements. Run through Windows acceptance.
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { setImmediate: immediate } = require('node:timers/promises')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const metricsFile = 'src/main/library/fontMetricsRuntime.ts'
const coalescerFile = 'src/main/library/fontMetricsRequestCoalescerRuntime.ts'
const plain = value => JSON.parse(JSON.stringify(value))

function replaceOnce(source, before, after) {
  source = source.replace(/\r\n/g, '\n')
  assert.equal(source.split(before).length, 2, 'Metrics fairness mutation anchor must be unique: ' + before)
  return source.replace(before, after)
}

function harness(transforms = {}) {
  const state = { events: [], turns: 0, open: false, closed: 0, sqlReads: 0, rowReads: 0,
    libraryOpens: 0, mergedOpens: 0, overlayCalls: 0, countReads: 0, categoryReads: 0,
    saved: [], fallbackCalls: 0, pending: false, onTurn: () => {} }
  // The real source cancellation context, task owner, coalescer, SQL builders,
  // identity and path normalization all remain loaded through the existing loader.
  const load = loader({ 'node:timers/promises': { setImmediate: async () => {
    assert.equal(state.open, false, 'Metrics yielded while the merged DB handle was open')
    state.events.push('yield-request')
    await immediate()
    state.turns += 1
    state.events.push('yield')
    await state.onTurn()
  } } }, {}, Object.fromEntries(Object.entries(transforms).map(([file, transform]) => [path.join(root, file), transform])))
  const runtime = load(metricsFile)
  const io = load('src/main/path/sharedFileSystemRuntime.ts')
  const tasks = load('src/main/library/fontQueryTaskRuntime.ts')
  const failure = load('src/shared/fontQueryFailure.ts')
  return { state, load, runtime, io, tasks, failure }
}

function metricsFixture(h, count = 260) {
  const { state } = h
  const categories = ['serif', 'sansSerif', 'script', 'monospace', 'art']
  const directories = ['C:\\Fonts\\A', 'C:\\Fonts\\B', 'C:\\Alias', 'C:\\Fonts\\A', 'C:\\Outside']
  const formats = ['ttf', 'otf', 'ttc', 'invalid', 'otc']
  const locals = [['private'], ['collision'], ['private2'], [], ['collision']]
  const shared = [['collision'], ['common'], ['common', 'collision'], ['collision'], []]
  const scripts = [['latin'], ['latin', 'cjk'], ['cjk'], [], ['symbol']]
  const fonts = Array.from({ length: count }, (_, index) => ({ id: 'font-' + index,
    path: directories[index % 5] + '\\font-' + index + '.ttf', format: formats[index % 5],
    favorite: index % 5 === 0 || index % 5 === 2, active: true, systemInstalled: true,
    scripts: scripts[index % 5], collectionIds: index % 5 === 0 || index % 5 === 2 ? ['col-a'] : index % 5 === 1 ? ['col-b'] : [],
    tagNames: shared[index % 5], localTagNames: locals[index % 5] }))
  const resultKinds = [
    { known: true, installed: true, by: 'system', matches: ['system-match'] },
    { known: true, installed: true, by: 'managed', matches: ['managed-match'] },
    { known: true, installed: true, by: 'both', matches: ['both-match'] },
    { known: false, installed: true, by: 'both', matches: ['must-be-cleared'] },
  ]
  const results = Object.fromEntries(fonts.filter((_, index) => index % 5 !== 4).map(font => [font.id, resultKinds[Number(font.id.slice(5)) % 5]]))
  const missingIds = fonts.filter((_, index) => index % 5 >= 3).map(font => font.id)
  if (missingIds.length) missingIds.push(missingIds[0])
  const hydrated = fonts.map((font, index) => ({ ...font, installStatusKnown: index % 5 < 3,
    systemInstalled: index % 5 === 0 || index % 5 === 2, active: index % 5 === 1 || index % 5 === 2,
    systemInstallMatches: index % 5 < 3 ? resultKinds[index % 5].matches : [] }))
  const shell = { collections: [{ id: 'col-a' }, { id: 'empty-collection' }],
    localTags: ['empty-local'], tags: ['empty-shared'], folders: ['C:\\Fonts', 'C:\\Alias', 'C:\\Empty'],
    folderNodes: [{ id: 'C:\\Fonts\\A' }, { id: 'C:\\Fonts\\B' }, { id: 'C:\\Fonts' }, {}] }
  const options = {
    appWatchedFolders: async () => ['C:\\Fonts', 'C:\\Alias', 'virtual-folder'],
    loadSharedFontsForFolders: async () => { state.events.push('shared-hydrated'); return fonts },
    getInstallStatusIndexSnapshot: async () => { state.events.push('install-snapshot'); return { results, missingIds } },
    hydrateInstallStatusForFonts: async () => { state.fallbackCalls += 1; state.events.push('install-fallback'); return hydrated },
    hydrateLocalTagsForFonts: async items => {
      assert.deepEqual(plain(items), plain(hydrated), 'Install status hydration changed known/unknown/system/managed truth')
      state.events.push('tags-hydrated'); return items
    },
    openLibraryDb: async () => { state.libraryOpens += 1; state.events.push('library-open'); return shell },
    loadLibraryShellFromSqlite: db => { assert.equal(db, shell); return shell },
    saveMetricsSnapshot: async (name, value) => { assert.equal(name, 'font_metrics'); state.saved.push(plain(value)) },
    inferFontSearchCategory: font => { state.categoryReads += 1; return categories[Number(font.id.slice(5)) % 5] },
    sharedFontMatchesPathPrefixes: (font, folders) => folders.some(folder => folder === 'virtual-folder'
      ? Number(font.id.slice(5)) % 5 === 4 : font.path.toLowerCase().startsWith(folder.toLowerCase() + '\\')),
  }
  return { fonts, hydrated, options, run: () => h.runtime.createFontMetricsRuntime(options).getFontMetricsFromLibrary() }
}

function expectedMetrics() {
  return { total: 260, favoriteCount: 104, installedCount: 104, notInstalledCount: 52,
    installStatusKnownCount: 156, installStatusMissingCount: 104, installStatusReady: false,
    activeCount: 104, systemDefaultCount: 0,
    formatCounts: { ttf: 52, otf: 52, ttc: 52, otc: 52, unknown: 52 },
    categoryCounts: { all: 260, serif: 52, slabSerif: 0, sansSerif: 52, script: 52, monospace: 52, handwriting: 0, hei: 0, art: 52 },
    scriptCounts: { latin: 104, cjk: 104, symbol: 52 },
    collectionCounts: { 'col-a': 104, 'empty-collection': 0, 'col-b': 52 },
    tagCounts: { 'empty-shared': 0, collision: 104, common: 104, 'empty-local': 0, private: 52, private2: 52 },
    localTagCounts: { 'empty-local': 0, private: 52, collision: 104, private2: 52 },
    sharedTagCounts: { 'empty-shared': 0, collision: 156, common: 104 },
    folderCounts: { 'C:\\Fonts': 156, 'C:\\Alias': 52, 'C:\\Empty': 0, 'C:\\Fonts\\A': 104, 'C:\\Fonts\\B': 52, 'virtual-folder': 52 }, elapsedMs: 0 }
}

function assertTurnBetween(events, before, after) {
  const first = events.indexOf(before), last = events.indexOf(after)
  assert(first >= 0 && last > first && events.slice(first + 1, last).includes('yield'), 'No I/O turn between ' + before + ' and ' + after)
}

async function metricParityAndStages(transforms = {}) {
  const h = harness(transforms), fixture = metricsFixture(h), raw = plain(fixture.fonts)
  const result = await fixture.run()
  assert.deepEqual({ ...plain(result), elapsedMs: 0 }, expectedMetrics())
  assert.deepEqual(plain(fixture.fonts), raw, 'Metrics mutated its shared input rows')
  assert.deepEqual(h.state.saved, [plain(result)])
  assert.equal(h.state.fallbackCalls, 0)
  assertTurnBetween(h.state.events, 'shared-hydrated', 'install-snapshot')
  assertTurnBetween(h.state.events, 'install-snapshot', 'tags-hydrated')
  assertTurnBetween(h.state.events, 'tags-hydrated', 'library-open')
}

async function snapshotFallback() {
  for (const useSnapshot of [true, false]) {
    const h = harness(), fixture = metricsFixture(h)
    if (useSnapshot) fixture.options.getInstallStatusIndexSnapshot = async () => { throw Error('ordinary snapshot failure') }
    else delete fixture.options.getInstallStatusIndexSnapshot
    const result = await fixture.run()
    assert.deepEqual({ ...plain(result), elapsedMs: 0 }, expectedMetrics())
    assert.equal(h.state.fallbackCalls, 1)
    assertTurnBetween(h.state.events, 'install-fallback', 'tags-hydrated')
  }
  const h = harness(), fixture = metricsFixture(h, 0)
  const empty = await fixture.run()
  assert.equal(empty.total, 0); assert.equal(empty.installStatusReady, true)
  assert.equal(empty.installStatusKnownCount, 0); assert.equal(empty.installStatusMissingCount, 0)
  assert.equal(h.state.saved.length, 1)
}

async function snapshotSupersession(transforms = {}) {
  for (const error of [Object.assign(Error('[HFM_QUERY:query-superseded] stale'), { reason: 'query-superseded' }), Object.assign(Error('aborted'), { name: 'AbortError' })]) {
    const h = harness(transforms), fixture = metricsFixture(h)
    fixture.options.getInstallStatusIndexSnapshot = async () => { throw error }
    await assert.rejects(fixture.run(), h.failure.isFontQuerySuperseded)
    assert.equal(h.state.fallbackCalls, 0, 'Supersession entered the ordinary snapshot fallback')
    assert.equal(h.state.saved.length, 0)
  }
}

async function metricsCancellation(transforms = {}) {
  const h = harness(transforms), fixture = metricsFixture(h), controller = new AbortController()
  h.state.onTurn = () => { if (h.state.categoryReads === 128) controller.abort() }
  await assert.rejects(h.io.withSharedIoSignal(controller.signal, fixture.run), h.failure.isFontQuerySuperseded)
  assert.equal(h.state.categoryReads, 128, 'Cancelled metrics consumed a second counting chunk')
  assert.equal(h.state.saved.length, 0, 'Cancelled metrics published a snapshot')
}

async function metricsPublicationCancellation(transforms = {}, stages = ['before-library', 'before-save', 'after-save']) {
  for (const stage of stages) {
    const h = harness(transforms), fixture = metricsFixture(h), controller = new AbortController()
    if (stage === 'before-library') h.state.onTurn = () => { if (h.state.events.includes('tags-hydrated')) controller.abort() }
    if (stage === 'before-save') {
      const infer = fixture.options.inferFontSearchCategory
      fixture.options.inferFontSearchCategory = font => { const category = infer(font); if (h.state.categoryReads === 260) controller.abort(); return category }
    }
    if (stage === 'after-save') fixture.options.saveMetricsSnapshot = async (_name, value) => { h.state.saved.push(plain(value)); controller.abort() }
    await assert.rejects(h.io.withSharedIoSignal(controller.signal, fixture.run), h.failure.isFontQuerySuperseded)
    assert.equal(h.state.saved.length, stage === 'after-save' ? 1 : 0)
    if (stage === 'before-library') assert.equal(h.state.libraryOpens, 0)
  }
}

function localFixture(h, count = 260) {
  const { state } = h, sql = h.load('src/main/indexing/root-query/rootIndexQuerySharedSql.ts')
  const rows = Array.from({ length: count }, (_, index) => ({ get id() { state.rowReads += 1; return 'row-' + index },
    installed_by: ['managed', 'both', 'system', 'none'][index % 4], favorite: Number(index % 2 === 0) }))
  const roots = ['C:\\Fonts', 'C:\\Fonts'], resolved = path.resolve(roots[0])
  const expectedSql = `SELECT ${sql.rootIndexRuntimeFontIdExpr()} AS id,
      entries.installed_by, ${sql.mergedIndexLocalFavoriteExpr()} AS favorite
      FROM entries WHERE COALESCE(entries.is_deleted, 0) = 0 AND entries.status = 'ok'
      AND entries.font_json IS NOT NULL AND json_valid(entries.font_json)
      AND entries.root_path IN (?)`
  const db = {
    exec: statement => { assert(state.open); assert.equal(statement, "ATTACH DATABASE ':memory:' AS local_db") },
    prepare: statement => {
      assert.equal(statement, expectedSql, 'Local-user metrics SQL/filters changed')
      return { all: (...parameters) => { assert(state.open); assert.deepEqual(parameters, [resolved]); state.sqlReads += 1; state.events.push('sql'); return rows } }
    },
  }
  const options = { roots, expectedTotal: count,
    openLibraryDb: async () => { state.libraryOpens += 1; state.events.push('library-open') },
    openMergedIndexDb: async () => { state.mergedOpens += 1; state.open = true; state.events.push('merged-open'); return db },
    librarySqlitePath: () => ':memory:',
    closeSqliteDb: value => { assert.equal(value, db); assert(state.open); state.open = false; state.closed += 1; state.events.push('close') },
    applyPendingActivationState: items => {
      state.overlayCalls += 1; assert.equal(state.open, false); assert.equal(items.length, count)
      assert.deepEqual(Array.from(items, font => font.id), Array.from({ length: count }, (_, index) => 'row-' + index))
      const pending = state.pending
      return items.map((font, index) => ({ ...font, active: font.active || (pending && index % 5 === 0),
        get favorite() { state.countReads += 1; return font.favorite } }))
    },
  }
  return { options, db, run: () => h.runtime.readLocalUserMetricsFromMergedIndex(options) }
}

async function localParityAndTurns(transforms = {}) {
  const h = harness(transforms), fixture = localFixture(h)
  // A queued callback must run before atomic SQL admission. The controlled port
  // below still awaits a real setImmediate rather than substituting microtasks.
  const queued = immediate().then(() => h.state.events.push('queued-io'))
  h.state.onTurn = () => {
    if (h.state.closed && !h.state.overlayCalls) h.state.pending = true
    if (h.state.overlayCalls) h.state.pending = false
  }
  const result = await fixture.run()
  await queued
  assert(h.state.events.indexOf('queued-io') < h.state.events.indexOf('sql'), 'Atomic SQL starved an already-queued I/O turn')
  assert.deepEqual(plain(result), { favoriteCount: 130, activeCount: 156 }, 'Metrics lost pending overlay or re-read it while counting')
  assert.equal(h.state.overlayCalls, 1); assert.equal(h.state.sqlReads, 1); assert.equal(h.state.closed, 1)
  assert.equal(h.state.rowReads, 260); assert.equal(h.state.countReads, 260)
  assert(h.state.events.indexOf('yield') < h.state.events.indexOf('library-open'), 'Local metrics opened DBs before its cooperative turn')
}

async function localCancellation(transforms = {}) {
  for (const stage of ['pre-sql', 'pre-merged', 'post-sql', 'rows', 'counts']) {
    const h = harness(transforms), fixture = localFixture(h), controller = new AbortController()
    h.state.onTurn = () => {
      if (stage === 'pre-sql' || (stage === 'pre-merged' && h.state.libraryOpens === 1)
        || (stage === 'post-sql' && h.state.closed === 1)
        || (stage === 'rows' && h.state.rowReads === 128) || (stage === 'counts' && h.state.countReads === 128)) controller.abort()
    }
    await assert.rejects(h.io.withSharedIoSignal(controller.signal, fixture.run), h.failure.isFontQuerySuperseded)
    assert.equal(h.state.open, false)
    if (stage === 'pre-sql' || stage === 'pre-merged') {
      assert.equal(h.state.libraryOpens, stage === 'pre-sql' ? 0 : 1); assert.equal(h.state.mergedOpens, 0); assert.equal(h.state.sqlReads, 0)
    } else {
      assert.equal(h.state.closed, 1)
      if (stage === 'post-sql') { assert.equal(h.state.rowReads, 0); assert.equal(h.state.overlayCalls, 0) }
      else if (stage === 'rows') { assert.equal(h.state.rowReads, 128); assert.equal(h.state.overlayCalls, 0) }
      else { assert.equal(h.state.countReads, 128); assert.equal(h.state.overlayCalls, 1) }
    }
  }
}

async function localFailureAndEmpty() {
  for (const kind of ['mismatch', 'empty-roots', 'sql-failure', 'cancel-on-open']) {
    const h = harness(), fixture = localFixture(h), controller = new AbortController()
    if (kind === 'mismatch') fixture.options.expectedTotal += 1
    if (kind === 'empty-roots') fixture.options.roots = []
    if (kind === 'sql-failure') fixture.db.prepare = () => { throw Error('atomic SQL failed') }
    if (kind === 'cancel-on-open') {
      const open = fixture.options.openMergedIndexDb
      fixture.options.openMergedIndexDb = async () => { const db = await open(); controller.abort(); return db }
    }
    const pending = h.io.withSharedIoSignal(controller.signal, fixture.run)
    if (kind === 'sql-failure') await assert.rejects(pending, /atomic SQL failed/)
    else if (kind === 'cancel-on-open') await assert.rejects(pending, h.failure.isFontQuerySuperseded)
    else assert.deepEqual(plain(await pending), kind === 'mismatch' ? null : { favoriteCount: 0, activeCount: 0 })
    assert.equal(h.state.closed, kind === 'empty-roots' ? 0 : 1)
    assert.equal(h.state.overlayCalls, 0); assert.equal(h.state.open, false)
  }
}

async function pendingActivationOwner() {
  const h = harness(), fixture = localFixture(h)
  // Retain the real queue's merge/known-status overlay; only its delayed write
  // timer is parked because this regression does not persist activation changes.
  const queueLoad = loader({}, { setTimeout: () => ({ unref() {} }), clearTimeout() {} })
  const queue = queueLoad('src/main/activation/activationInstallStatusSaveQueue.ts').createActivationInstallStatusSaveQueue({
    readInstallStatusIndex: async () => { throw Error('Unexpected activation index read') },
    saveInstallStatusIndex: async () => { throw Error('Unexpected activation write') },
    appWatchedFolders: async () => [], rootForFontPath: async () => null,
    syncMergedIndexAfterInstallStatusRefresh: async () => {}, clearFontQueryCaches() {}, appendStartupLog() {},
  })
  const schedule = results => queue.schedule(results, new Map(), 'metrics-fairness')
  schedule({ 'row-0': { known: true, installed: false, by: 'none' } })
  let afterSql = false, afterOverlay = false
  h.state.onTurn = () => {
    if (h.state.closed && !afterSql) {
      afterSql = true
      schedule({ 'row-2': { known: true, installed: true, by: 'managed' }, 'row-1': { known: false, installed: true, by: 'both' } })
    }
    if (h.state.overlayCalls && !afterOverlay) {
      afterOverlay = true
      schedule({ 'row-2': { known: false, installed: true, by: 'managed' } })
    }
  }
  fixture.options.applyPendingActivationState = items => {
    h.state.overlayCalls += 1
    assert.equal(items.length, 260); assert.equal(h.state.open, false)
    return queue.applyPendingState(items)
  }
  assert.deepEqual(plain(await fixture.run()), { favoriteCount: 130, activeCount: 129 })
  assert(afterSql && afterOverlay); assert.equal(h.state.overlayCalls, 1)
}

async function coalescerInvalidation(transforms = {}) {
  const h = harness(transforms), fixture = metricsFixture(h)
  const owner = h.load(coalescerFile).createFontMetricsRequestCoalescerRuntime(10000)
  let loads = 0, invalidated = false
  h.state.onTurn = () => {
    if (!invalidated && h.state.categoryReads === 128) {
      invalidated = true
      const signal = h.io.currentSharedIoSignal()
      assert(signal); assert.equal(signal.aborted, false)
      owner.clear(false)
      assert.equal(signal.aborted, false, 'Non-cancelling invalidation aborted the physical owner')
      fixture.fonts.forEach(font => { font.favorite = false })
      fixture.hydrated.forEach(font => { font.favorite = false })
    }
  }
  const request = () => owner.run({ key: 'fairness', appendLog() {}, load: async () => { loads += 1; return fixture.run() } })
  const [first, joined] = await Promise.all([request(), request()])
  assert(invalidated); assert.equal(loads, 2, 'Coalescer did not rerun the invalidated physical generation')
  assert.equal(first.favoriteCount, 0, 'Creator returned a stale metrics generation')
  assert.equal(joined.favoriteCount, 0, 'Joined consumer returned a stale metrics generation')
  assert.equal((await request()).favoriteCount, 0, 'Stale metrics generation was cached')
  assert.equal(loads, 2)
}

async function consumerCancellation() {
  for (const reason of ['cancel-query', 'destroyed', 'render-process-gone', 'shutdown']) {
    const h = harness(), fixture = metricsFixture(h), consumers = h.tasks.createFontQueryConsumers()
    const sender = Object.assign(new EventEmitter(), { id: 19, isDestroyed: () => false })
    const owner = h.load(coalescerFile).createFontMetricsRequestCoalescerRuntime(10000)
    let physical, cancelled = false, shutdownOutcome
    const shutdown = h.load('src/main/app/shutdownCoordinatorRuntime.ts').createShutdownCoordinator({
      log() {}, freeze() {}, restore() { throw Error('Unexpected shutdown restore') },
      closeRenderers: async () => { sender.emit('destroyed'); return true },
      cleanup: async () => ({ remaining: 0 }), save: async () => {}, drainLogs: async () => {},
      confirmLoss: async () => { throw Error('Unexpected shutdown confirmation') },
      terminate: outcome => { shutdownOutcome = outcome },
    })
    h.state.onTurn = async () => {
      if (cancelled || h.state.categoryReads !== 128) return
      cancelled = true
      if (reason === 'cancel-query') consumers.cancel(sender.id, 'metrics-fairness')
      else if (reason === 'shutdown') await shutdown.request()
      else sender.emit(reason)
    }
    const pending = consumers.run(sender, 'metrics', 'metrics-fairness', () => owner.run({
      key: 'consumer', appendLog() {}, load: () => { physical = fixture.run(); return physical },
    }))
    await assert.rejects(pending, h.failure.isFontQuerySuperseded)
    assert(physical); await assert.rejects(physical, h.failure.isFontQuerySuperseded)
    assert.equal(h.state.categoryReads, 128); assert.equal(h.state.saved.length, 0)
    if (reason === 'shutdown') assert.equal(shutdownOutcome?.reason, 'complete')
    for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) assert.equal(sender.listenerCount(event), 0)
  }
}

async function runFontMetricsFairnessRegressions() {
  await metricParityAndStages()
  await snapshotFallback()
  await snapshotSupersession()
  await metricsCancellation()
  await metricsPublicationCancellation()
  await localParityAndTurns()
  await localCancellation()
  await localFailureAndEmpty()
  await pendingActivationOwner()
  await coalescerInvalidation()
  await consumerCancellation()
  const uninterrupted = { [metricsFile]: source => replaceOnce(source, 'await yieldImmediate()', 'await Promise.resolve()') }
  await assert.rejects(localParityAndTurns(uninterrupted), /queued I\/O turn/)
  const unchunked = { [metricsFile]: source => replaceOnce(source, 'if (end < items.length) await yieldFontMetricsTurn()', '// old uninterrupted memory loop') }
  await assert.rejects(metricsCancellation(unchunked), /Missing expected rejection/)
  const missingAfterYield = { [metricsFile]: source => replaceOnce(source, 'await yieldImmediate()\n  assertFontQueryActive()', 'await yieldImmediate()') }
  await assert.rejects(metricsCancellation(missingAfterYield), /Cancelled metrics consumed a second counting chunk/)
  const swallowedSupersession = { [metricsFile]: source => replaceOnce(source, '        rethrowFontQuerySuperseded(error)', '        // historical unconditional snapshot fallback') }
  await assert.rejects(snapshotSupersession(swallowedSupersession), /Missing expected rejection/)
  const missingReturnCheck = { [metricsFile]: source => replaceOnce(source,
    "    await options.saveMetricsSnapshot('font_metrics', metrics)\n    assertFontQueryActive()",
    "    await options.saveMetricsSnapshot('font_metrics', metrics)") }
  await assert.rejects(metricsPublicationCancellation(missingReturnCheck, ['after-save']), /Missing expected rejection/)
  const staleReturn = { [coalescerFile]: source => replaceOnce(source,
    "      if (requestGeneration !== cacheGeneration) { trace('invalidated-reread'); return run(args) }\n      trace('load-end')",
    "      trace('load-end')") }
  await assert.rejects(coalescerInvalidation(staleReturn), /Creator returned a stale metrics generation/)
  console.log('[diagnostics:font-metrics-fairness] source hydration/count parity, SQL turn/close ownership, cancellation, pending overlay and coalescer generation negatives passed')
}

module.exports = { runFontMetricsFairnessRegressions }
if (require.main === module) runFontMetricsFairnessRegressions().catch(error => { console.error(error); process.exitCode = 1 })
