// Read-only observations, not a passing regression gate. No user DB, Windows, or NAS calls.
const { loader } = require('../../build/diagnostics/check-operation-chain.cjs')
const observations = []
async function activation() {
  const timers = []
  const load = loader({}, { setTimeout: fn => { timers.push(fn); return { unref() {} } }, clearTimeout() {} })
  let persisted = { installed: true, by: 'managed', matches: [] }
  const font = { id: 'audit-a', path: '/audit/a.ttf', fileName: 'a.ttf', active: false }
  const facade = load('src/main/library/fontQueryFacadeRuntime.ts').createFontQueryFacadeRuntime({
    readInstallStatusIndex: async () => ({ results: { [font.id]: persisted } }), appendLog() {},
  })
  const memory = load('src/main/library/fontMemoryQueryRuntime.ts').createFontMemoryQueryRuntime({
    resultCacheMax: 10, resultCacheTtlMs: 1800,
    appWatchedFolders: async () => ['/audit'], loadSharedFontsForFolders: async () => [{ ...font }],
    hydrateLocalTagsForFonts: async items => items,
    hydrateInstallStatusForFonts: facade.hydrateInstallStatusForFonts,
    normalizePathForCacheCompare: x => x, isSystemInstalledRecord: () => false,
    isPathInWindowsFonts: () => false, inferFontSearchCategory: () => '',
  })
  const request = { sidebarPage: 'library', activeFilter: { kind: 'active' } }
  const before = await memory.cleanSharedFontsForQuery(request)
  let invalidations = 0
  const snapshots = []
  const validation = load('src/main/indexing/merged-page/mergedIndexValidationRuntime.ts')
    .createMergedIndexValidationRuntime({ appendStartupLog() {}, delayToEventLoop: async () => {} }, {}, {})
  const queue = load('src/main/activation/activationInstallStatusSaveQueue.ts').createActivationInstallStatusSaveQueue({
    readInstallStatusIndex: async () => ({ results: { [font.id]: persisted }, misses: [] }),
    saveInstallStatusIndex: async results => { persisted = results[font.id] },
    appWatchedFolders: async () => ['/audit'], rootForFontPath: async () => '/audit',
    syncMergedIndexAfterInstallStatusRefresh: roots => validation.syncMergedIndexAfterInstallStatusRefresh(roots, async (root, reason) => snapshots.push({ root, reason })),
    clearFontQueryCaches() { invalidations++; memory.invalidateFontQueryResultCache() }, appendStartupLog() {},
  })
  // OS removal already succeeded; only the real queue's scheduled persistence remains.
  queue.schedule({ [font.id]: { installed: false, by: 'none', matches: [] } }, new Map([[font.id, font]]), 'audit-deactivate')
  const warm = await memory.cleanSharedFontsForQuery(request)
  memory.invalidateFontQueryResultCache() // show that clearing only query cache cannot fix the pending DB window
  const cold = await memory.cleanSharedFontsForQuery(request)
  const invalidationsBeforeFlush = invalidations
  await queue.flush('audit')
  const after = await memory.cleanSharedFontsForQuery(request)
  observations.push({ id: 'W-01', before: before.length, warmAfterSchedule: warm.length, coldAfterSchedule: cold.length, invalidationsBeforeFlush, afterFlush: after.length, reproduced: warm.length === 1 && cold.length === 1 && after.length === 0 })
  observations.push({ id: 'W-02', changedFonts: 1, snapshotCalls: snapshots, reproduced: snapshots.length === 1, boundary: 'real queue and validation; snapshot I/O replaced, fullSnapshot=true separately source-reviewed' })
}
function storage() {
  const calls = []
  const load = loader({ 'node:child_process': { execFileSync: (exe) => { calls.push(exe); return exe === 'net' ? 'OK           O:        \\\\audit\\fonts\r\n' : '{"MediaType":"SSD","BusType":"NVMe"}' } } })
  const runtime = load('src/main/performance/storageProfileRuntime.ts').createStorageProfileRuntime({ platform: 'win32', env: {}, localWorkers: 6, networkWorkers: 2, windowsMediaDetectEnabled: true, windowsMediaDetectTimeoutMs: 2500 })
  const first = runtime.storageProfileForPath('O:\\fonts\\a.ttf')
  const firstCalls = [...calls]
  runtime.storageProfileForPath('O:\\fonts\\a.ttf')
  observations.push({ id: 'W-03', synchronousCommandsBeforeReturn: firstCalls, profile: first.type, secondCallCommands: calls.length - firstCalls.length, reproduced: firstCalls.includes('powershell.exe'), boundary: 'external command output controlled; no measured Windows probe latency' })
}
async function preview() {
  const resolvers = [], calls = []
  const appPort = { PREVIEW_STATE_LRU_LIMIT: 800, pruneRecordByKeyLimit: x => x, rendererMemoryPressure: () => 'none', requestIdleWindow() {}, INDEXING_PREVIEW_LOADS: 1, SCROLLING_PREVIEW_LOADS: 1, MAX_CONCURRENT_PREVIEW_LOADS: 3 }
  const load = loader({ '../../../appRuntime': appPort, '../../../rendererPerformance': { reportRendererTrace() {} }, './fontPreviewQuickFallbackRuntime': {} }, { window: { setTimeout: () => 1, clearTimeout() {} } })
  const font = { id: 'audit-a', path: '/audit/a.ttf', fileName: 'a.ttf' }
  const options = {
    previewText: 'audit', listPreviewFontSize: 39, selectedFontId: '', selectedFontIds: [],
    previewFamilies: {}, nativePreviewImages: {}, loadingFonts: { current: new Set() },
    previewRequestTokenRef: { current: 'audit::39' }, previewQueue: { current: [{ font, priority: 'high' }] },
    queuedPreviewFontIds: { current: new Set([font.id]) }, activePreviewLoads: { current: 0 }, fontListScrollingRef: { current: false },
    rendererUserActive: () => false, isBadFontRecord: () => false, setNativePreviewImages() {}, setPreviewFamilies() {},
    hfm: { getCachedPreviewImages: (...args) => { calls.push(args[0].map(f => f.id)); return new Promise(resolve => resolvers.push(resolve)) } },
  }
  const make = () => load('src/renderer/src/runtime/preview/queue/fontVisiblePreviewQueueRuntime.ts').createFontVisiblePreviewQueueRuntime(options, { canRequestPreviewFont: () => true }, load('src/renderer/src/runtime/preview/queue/fontPreviewLoadRuntime.ts').createFontPreviewLoadRuntime(options))
  const first = make(); first.processPreviewQueue(); first.processPreviewQueue()
  const sameInstanceCalls = calls.length
  // Same ref-owned queue, new factory as on the next usePreviewController render.
  const next = make(); next.processPreviewQueue()
  observations.push({ id: 'W-04', sameInstanceCalls, afterRecreationCalls: calls.length, batches: calls, reproduced: sameInstanceCalls === 1 && calls.length === 2, boundary: 'real visible queue and batch loader; React rerender construction simulated; no native renderer' })
  options.previewQueue.current = []
  for (const resolve of resolvers) resolve({})
  await new Promise(resolve => setImmediate(resolve))
}
;(async () => { await activation(); storage(); await preview(); console.log(JSON.stringify({ scope: 'production modules loaded unchanged; controlled external ports only; observations must become false after repair', observations }, null, 2)) })().catch(error => { console.error(error); process.exitCode = 1 })
