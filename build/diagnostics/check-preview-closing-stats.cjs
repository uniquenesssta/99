#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const actions = 'src/renderer/src/runtime/library/actions/'
const eventFile = 'src/renderer/src/runtime/app/effects/useFontIndexChangedEventRuntime.ts'
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const stats = { entries: 17, goodEntries: 13, badEntries: 4, sizeBytes: 303 }

function sourceContracts() {
  for (const file of [
    'src/renderer/src/App.tsx',
    'src/renderer/src/runtime/app/useLibraryController.ts',
    'src/renderer/src/runtime/app/useFontOperationsController.ts', eventFile,
    ...['fontLibraryIndexActionTypes', 'fontLibraryIndexSharedRuntime', 'fontLibraryIndexOperationActionRuntime', 'fontLibraryFolderCacheActionRuntime', 'fontLibrarySystemScanActionRuntime', 'fontLibraryCacheMaintenanceActionRuntime'].map(name => actions + name + '.ts')
  ]) {
    assert(!/\b(?:getCacheStats|loadCacheStats|setCacheStats|cacheStatsRequestState)\b/.test(fs.readFileSync(path.join(root, file), 'utf8')), `${file}: unread automatic cache statistics returned`)
  }
}

async function automaticActions(transforms = {}) {
  let library = { folders: ['D:/Fonts'], folderNodes: [], fonts: {}, tags: [], localTags: [] }
  let statsCalls = 0, saveOk = true
  const calls = [], statuses = []
  const scan = { folders: library.folders, fonts: [], errors: [], cacheFolders: library.folders }
  const load = loader({
    '../../../appRuntime': {
      applyFolderTreeToLibrary: (current, tree) => ({ ...current, folders: tree.folders, folderNodes: tree.nodes }),
      applyFolderCacheToLibrary: (current, tree) => ({ ...current, folders: tree.folders, folderNodes: tree.nodes }),
      buildFolderTreeFromCachedFonts: folders => ({ folders, nodes: [] }),
      folderPhysicalPath: () => 'D:/Fonts', mergeScannedFonts: current => current, scanWorkerStatsText: () => ''
    },
    '../../../fontTagStateAuthorityRuntime': { ensureLibraryTagNamesContainFontTags: value => value },
    '../../../fontStatusRuntime': { cacheLoadStatus: () => '缓存已读取', folderRefreshStatusText: () => '已刷新' },
    './deferredInstallStatusRefreshRuntime': { scheduleDeferredInstallStatusRefresh: ({ statusText, setStatus }) => { calls.push('finish'); setStatus(statusText) } }
  }, {}, transforms)
  const options = {
    hfm: {
      getCacheStats: async () => { statsCalls++; return stats },
      listPhysicalFolderTree: async folders => ({ folders, nodes: [] }),
      scanFolders: async () => { calls.push('scan'); return scan },
      scanSystemInstalledFonts: async () => { calls.push('system'); return scan },
      clearScanCache: async () => { calls.push('clear-scan'); return stats },
      loadFolderCache: async () => { calls.push('cache'); return scan },
      refreshWatchedFolder: async () => ({ mode: 'incremental' }),
      checkSharedMetadataUpdates: async () => { calls.push('metadata') }
    },
    getCurrentLibrary: () => library,
    commitLibraryUpdate: update => (library = typeof update === 'function' ? update(library) : update),
    setStatus: value => statuses.push(value), saveLibraryImmediately: async () => { calls.push('save'); return saveOk },
    nextIndexOperationRunId: () => 1, isCurrentIndexOperation: () => true,
    captureFontScrollSnapshot: () => ({}), restoreFontScrollSnapshot() {},
    knownInstallStatusIds: { current: new Set() }, autoInstallStatusRefreshStartedRef: { current: false },
    stopLazyInstallStatusDetect() {}, setDatabasePageResult: () => calls.push('invalidate'),
    setDatabaseQueryResult() {}, setDatabaseFontMetrics() {}, setDatabaseRefreshToken() {},
    setIndexingActive: value => calls.push('indexing:' + value), setContextMenu() {}, setSelectedFolderId() {},
    startBackgroundInstallStatusRefresh: async () => calls.push('install-refresh')
  }
  const runtime = load('src/renderer/src/runtime/library/fontLibraryIndexActionRuntime.ts').createFontLibraryIndexActionRuntime(options)
  assert(!Object.hasOwn(runtime, 'loadCacheStats'), 'unread stats command still exported')
  for (const [name, run, end] of [
    ['rescan', () => runtime.rescan(), 'finish'],
    ['rebuild', () => runtime.rebuildScanCache(), 'finish'],
    ['read shared cache', () => runtime.loadSharedCacheForFolders(library.folders), 'invalidate'],
    ['refresh folder', () => runtime.refreshFolderTarget({ kind: 'folder', id: 'D:/Fonts', rootPath: 'D:/Fonts', name: '字体' }), 'invalidate'],
    ['scan all', () => runtime.scanAllFonts(), 'finish'],
    ['scan installed', () => runtime.scanInstalledFontsIntoLibrary(), 'invalidate']
  ]) {
    calls.length = 0; statuses.length = 0
    await run()
    assert.equal(statsCalls, 0, name + ': automatic stats request')
    assert(calls.includes(end), name + ': useful operation did not finish')
    assert(calls.indexOf('save') < calls.indexOf(end), name + ': changed persistence-before-refresh ordering')
    assert(!statuses.some(status => status.includes('失败')), name + ': successful work reported failure')
  }
  saveOk = false; calls.length = 0
  await runtime.rescan()
  assert(!calls.includes('finish') && !calls.includes('invalidate'), 'failed persistence refreshed derived state')
  assert(statuses.at(-1).includes('保存失败'), 'necessary persistence failure was hidden')
  options.hfm.scanFolders = async () => { throw Error('real scan failure') }
  await runtime.rescan()
  assert(statuses.at(-1).includes('real scan failure'), 'necessary scan failure was hidden')
}

async function indexEvents(transforms = {}) {
  let listener, dispose, library = { folders: ['D:/Fonts'], fonts: {} }, statsCalls = 0, refreshes = 0, saves = 0, release
  const saved = [], gate = new Promise(resolve => { release = resolve })
  const load = loader({
    react: { useRef: current => ({ current }), useEffect: effect => { dispose = effect() } },
    '../../../appRuntime': { applyFontIndexChangeToLibrary: (current, payload) => ({ library: { ...current, fonts: { ...current.fonts, ...Object.fromEntries(payload.upserts.map(font => [font.id, font])) } }, removedIds: [], upsertedFonts: payload.upserts }) },
    '../../../library-normalize/libraryNormalizeBase': { normalizeFolderPathForCompare: value => value.toLowerCase() },
    '../../../fontIndexEventRuntime': { fontIndexChangeStatusText: () => '索引已更新' }
  }, {}, transforms)
  load(eventFile).useFontIndexChangedEventRuntime({
    hfm: { getCacheStats: async () => { statsCalls++; return stats }, onFontIndexChanged: fn => { listener = fn; return () => { listener = null } } },
    getCurrentLibrary: () => library, commitLibraryUpdate: next => { library = next },
    saveLibraryImmediately: async latest => { saves++; saved.push(latest); if (saves === 1) await gate; return true },
    refreshDatabaseDerivedState: () => refreshes++, cleanupRemovedFontState() {}, captureFontScrollSnapshot() {}, restoreFontScrollSnapshot() {}, setStatus() {}
  })
  const event = family => ({ folder: 'D:/Fonts', source: 'watcher', upserts: [{ id: 'a', family }], deletes: [] })
  try {
    listener(event('first')); await settle()
    listener(event('latest')); await settle()
    assert.equal(saves, 1, 'index events bypassed serial persistence')
    assert.equal(refreshes, 2, 'pending refresh blocked behind an in-flight save')
    release(); await settle()
    assert.equal(saves, 2); assert.equal(saved.at(-1).fonts.a.family, 'latest', 'new event saved a stale shell')
    for (const source of ['projection', 'metrics']) {
      for (const revision of [1, 1, 0, NaN, 2]) listener({ folder: 'D:/Fonts', source, [source + 'Revision']: revision, upserts: [], deletes: [] })
      await settle()
    }
    assert.equal(refreshes, 4, 'projection/metrics revisions no longer coalesce')
    assert.equal(saves, 2, 'projection/metrics notification wrote the library')
    assert.equal(statsCalls, 0, 'index event automatic stats request')
    listener(event('dispose before flush')); dispose(); await settle()
    assert.equal(refreshes, 4); assert.equal(saves, 2, 'disposed event flushed work')
  } finally {
    release(); dispose(); await settle()
  }
}

async function explicitApi() {
  for (const runtimePreload of [false, true]) {
    const handlers = new Map(), exposed = {}
    let fail = false, reads = 0
    const electron = {
      contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } },
      ipcRenderer: { invoke: (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({}, ...args)), on() {}, removeListener() {} }
    }
    const load = loader({ electron })
    load('src/main/ipc/handlers/maintenanceIpcHandlers.ts').registerMaintenanceIpcHandlers((channel, fn) => handlers.set(channel, fn), {
      getCacheStats: async () => { reads++; if (fail) throw Error('explicit stats failed'); return stats }
    })
    if (runtimePreload) vm.runInNewContext(load('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource, { require: id => id === 'electron' ? electron : require(id), process, Buffer, Date, console })
    else load('src/preload/index.ts')
    assert.equal(await exposed.hfm.getCacheStats(), stats, 'explicit stats API replaced real result')
    fail = true
    await assert.rejects(exposed.hfm.getCacheStats(), /explicit stats failed/)
    assert.equal(reads, 2, 'explicit stats API did not forward both requests')
  }
}

async function cleanupContracts() {
  const removals = [], order = []
  let fail = false
  const load = loader({ '../../path/sharedFileSystemRuntime': { sharedFileSystem: { rm: async target => { removals.push(target); order.push('remove') } } } })
  const options = {
    legacyScanCachePath: () => 'D:/cache/scan.json', loadLibraryShell: async () => ({ folders: [] }),
    localPreviewImageDir: () => 'D:/cache/images', clearLocalPreviewDbHandle: () => order.push('close-db'), previewSqlitePath: () => 'D:/cache/preview.sqlite'
  }
  const cleanup = load('src/main/cache/scan-storage/cacheCleanupRuntime.ts').createCacheCleanupRuntime(options, {
    getCacheStats: async () => { order.push('stats'); if (fail) throw Error('cleanup statistics failed'); return stats }
  })
  for (const name of ['clearScanCache', 'clearPreviewCache']) {
    order.length = 0
    assert.equal(await cleanup[name](), stats, name + ': real result lost')
    assert(order.indexOf('remove') >= 0 && order.at(-1) === 'stats', name + ': stats were not read after cleanup')
    fail = true
    await assert.rejects(cleanup[name](), /cleanup statistics failed/)
    fail = false
  }
  assert(removals.length > 0, 'cleanup became a no-op')
  let library = { fonts: { a: { id: 'a', previewDisabled: true } } }, confirm = true, failAt = ''
  const statuses = [], calls = []
  const renderer = loader({ '../../../confirmationDialogRuntime': { confirmUserAction: async () => confirm } })(actions + 'fontLibraryCacheMaintenanceActionRuntime.ts').createFontLibraryCacheMaintenanceActionRuntime({
    hfm: Object.fromEntries(['clearScanCache', 'clearPreviewCache'].map(name => [name, async () => { calls.push(name); if (name === failAt) throw Error(name + ' failure'); return stats }])),
    setLibrary: update => { library = typeof update === 'function' ? update(library) : update }, setStatus: status => statuses.push(status),
    resetPreviewRuntimeState: () => calls.push('reset-preview'), isBadFontRecord: () => false
  })
  await renderer.clearAllCacheAction()
  assert.deepEqual(calls, ['clearScanCache', 'clearPreviewCache', 'reset-preview'])
  assert.equal(library.fonts.a.previewDisabled, false)
  calls.length = 0; await renderer.clearPreviewCacheAction()
  assert.deepEqual(calls, ['reset-preview', 'clearPreviewCache'])
  assert(statuses.at(-1).includes('已清理预览缓存') && !statuses.at(-1).includes('失败：'), 'manual preview cleanup did not complete')
  for (const action of ['clearAllCacheAction', 'clearPreviewCacheAction']) {
    failAt = 'clearPreviewCache'; await renderer[action]()
    assert(statuses.at(-1).includes('clearPreviewCache failure'), action + ': actual cleanup failure was hidden')
  }
  calls.length = 0; failAt = 'clearScanCache'; await renderer.clearAllCacheAction()
  assert.deepEqual(calls, ['clearScanCache']); assert(statuses.at(-1).includes('clearScanCache failure'))
  calls.length = 0; confirm = false; await renderer.clearAllCacheAction()
  assert.deepEqual(calls, [], 'cancelled cleanup touched storage')
}

async function main() {
  sourceContracts()
  await automaticActions(); await indexEvents(); await explicitApi(); await cleanupContracts()
  const operationFile = path.join(root, actions + 'fontLibraryIndexOperationActionRuntime.ts')
  await assert.rejects(() => automaticActions({ [operationFile]: source => {
    const anchor = '      const indexedCount = result.stats?.totalFiles ?? 0'
    assert(source.includes(anchor), 'automatic statistics mutant anchor missing')
    return source.replace(anchor, '      await options.hfm.getCacheStats()\n' + anchor)
  } }), /automatic stats request/)
  await assert.rejects(() => indexEvents({ [path.join(root, eventFile)]: source => {
    const anchor = '        current.refreshDatabaseDerivedState()'
    assert(source.includes(anchor), 'event statistics mutant anchor missing')
    return source.replace(anchor, anchor + '\n        void current.hfm.getCacheStats()')
  } }), /automatic stats request/)
  console.log('PASS cache statistics: automatic actions/events issue no reads; persistence, revisions/disposal, both explicit preload APIs, cleanup results/failures, and regression mutants retained')
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { automaticActions, indexEvents, explicitApi, cleanupContracts }
