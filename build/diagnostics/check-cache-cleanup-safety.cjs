#!/usr/bin/env node
'use strict'
// Windows-only TypeScript orchestration diagnostics. Native SQLite transactions
// and Windows handle exclusion are covered by the separate native cleanup suite.
const assert = require('node:assert/strict')
assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const storage = 'src/main/cache/scan-storage/'
const statsFile = storage + 'cacheStatsRuntime.ts'
const oldPreviewKey = 'a'.repeat(40), laterPreviewKey = 'b'.repeat(40)
let completed = false
process.once('beforeExit', () => {
  if (!completed) { console.error('[diagnostics:cache-cleanup-safety] incomplete'); process.exitCode = 1 }
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settle() { for (let i = 0; i < 100; i++) await Promise.resolve() }
async function until(predicate, description) {
  for (let i = 0; i < 400 && !predicate(); i++) await Promise.resolve()
  assert(predicate(), description)
}
function error(code, message = code, extra = {}) { return Object.assign(new Error(message), { code, ...extra }) }
function cache(good, bad = 0) {
  return { version: 1, entries: Object.fromEntries(Array.from({ length: good + bad }, (_, i) => [String(i), { status: i < good ? 'ok' : 'bad' }])) }
}
function receipt(value) { return { result: { value } } }
function fileEntry(name, size) {
  return { name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, stat: { size } }
}

// Only widen the returned diagnostic surface, without replacing a production
// branch. Direct calls distinguish per-file/per-directory ownership from the
// public aggregate promise that otherwise hides those independent races.
function exposeStatsClosures(source) {
  const marker = '  return {\n    invalidateCacheStats,'
  assert.equal(source.split(marker).length, 2, 'stats diagnostic return-surface anchor changed')
  return source.replace(marker, '  return {\n    diagnosticFileStats: getCacheStatsForFile,\n    diagnosticDirectorySize: (directory: string) => cachedDirectorySizeBytes(directory, statsGeneration),\n    invalidateCacheStats,')
}

function onlySourceNode(parent, predicate, label) {
  const found = []
  function visit(node) {
    if (predicate(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(parent)
  assert.equal(found.length, 1, label + ': expected exactly one production source node')
  return found[0]
}

function loadSelectedSource(source, exportName, bindings = {}) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true
  })
  assert.equal((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0, exportName + ': selected production source did not transpile')
  const exports = {}
  new Function('exports', ...Object.keys(bindings), compiled.outputText)(exports, ...Object.values(bindings))
  assert.equal(typeof exports[exportName], 'function')
  return exports[exportName]
}

function previewCleanupRowsUseDatabaseWriteAdmission() {
  const parse = relative => ts.createSourceFile(relative, fs.readFileSync(path.join(root, relative), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const filesystemSource = parse('src/main/path/sharedFileSystemRuntime.ts')
  const accessFunction = onlySourceNode(filesystemSource,
    node => ts.isFunctionDeclaration(node) && node.name?.text === 'sharedFileAccesses', 'sharedFileAccesses')
  const sharedFileAccesses = loadSelectedSource(accessFunction.getText(filesystemSource), 'sharedFileAccesses', {
    sharedDatabaseTarget: () => assert.fail('unexpected unrelated root-database admission branch')
  })
  const transportSource = parse('src/main/rust-core/rustCoreWorkerTransportRuntime.ts')
  const configure = onlySourceNode(transportSource,
    node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'configureSharedFileExecutor', 'shared-file executor registration')
  const executor = configure.arguments[0]
  assert(ts.isArrowFunction(executor) && ts.isBlock(executor.body), 'shared-file executor callback shape changed')
  const writeDeclaration = onlySourceNode(executor.body,
    node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'write', 'native write classification')
  const scheduled = onlySourceNode(executor.body,
    node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'runRustCoreScheduledCommand', 'shared-file command submission')
  const executionOptions = scheduled.arguments[2]
  assert(ts.isObjectLiteralExpression(executionOptions), 'shared-file execution options are no longer a source object literal')
  const identityTimeout = onlySourceNode(transportSource,
    node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'FONT_CONTENT_IDENTITY_TIMEOUT_MS', 'font identity timeout')
  assert(writeDeclaration.initializer && identityTimeout.initializer)
  // Evaluate the actual classifier declaration and submitted options object.
  // No copied read-only operation list, timeout ternary, or footprint algorithm.
  const transportPolicy = loadSelectedSource(`
    const FONT_CONTENT_IDENTITY_TIMEOUT_MS = ${identityTimeout.initializer.getText(transportSource)};
    export function transportPolicy(request: any) {
      const signal = undefined;
      const ${writeDeclaration.getText(transportSource)};
      return ${executionOptions.getText(transportSource)};
    }
  `, 'transportPolicy', { sharedFileAccesses })
  for (const db of [path.resolve('C:/cache/preview.sqlite'), String.raw`\\server\fonts\.hfm-preview-cache\database\preview.sqlite`]) {
    const request = { operation: 'previewCleanupRows', path: db, schemaVersion: 1 }
    assert.deepEqual(sharedFileAccesses(request), [{ path: db, scope: 'database', mode: 'write' }], 'SQLite preview cleanup enumeration may maintain SHM and must reserve database writes')
    const options = transportPolicy(request)
    assert.equal(options.sharedIo.write, true, 'preview cleanup enumeration was admitted as read-only transport work')
    assert.equal(options.timeout, 5000, 'preview cleanup enumeration lost the write execution budget')
    assert.deepEqual(options.sharedIo.accesses, [{ path: db, scope: 'database', mode: 'write' }], 'transport did not submit the actual database-write footprint')
    assert(options.sharedIo.paths.includes(db), 'transport omitted the cleanup database path')
    for (const [operation, write, timeout] of [['sqliteSnapshot', false, 2000], ['readFile', false, 2000], ['stat', false, 500], ['fontContentIdentity', false, 4000], ['previewCleanupEntries', true, 5000], ['unrecognized-operation', true, 5000]]) {
      const control = transportPolicy({ ...request, operation })
      assert.equal(control.sharedIo.write, write, operation + ': admission control changed')
      assert.equal(control.timeout, timeout, operation + ': execution budget control changed')
    }
    assert.deepEqual(sharedFileAccesses({ ...request, operation: 'sqliteSnapshot' }), [{ path: db, scope: 'database', mode: 'read' }], 'ordinary SQLite snapshot lost its audited read classification')
  }
}

function createLoader(ports, Clock) {
  const modules = new Map()
  function load(relative) {
    const filename = path.resolve(root, relative)
    assert(filename.startsWith(root + path.sep), 'diagnostic module escaped source tree')
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }
    modules.set(filename, module)
    let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
    if (filename === path.join(root, statsFile)) source = exposeStatsClosures(source)
    const code = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      reportDiagnostics: true
    })
    assert.equal((code.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0, 'diagnostic TypeScript transpilation failed: ' + relative)
    const localRequire = id => {
      if (Object.hasOwn(ports, id)) return ports[id]
      if (id.startsWith('node:')) return require(id)
      assert(id.startsWith('.'), 'unmocked external port: ' + id)
      return load(path.resolve(path.dirname(filename), id) + '.ts')
    }
    new Function('exports', 'require', 'module', 'Date', code.outputText)(module.exports, localRequire, module, Clock)
    return module.exports
  }
  return load
}

function harness() {
  let now = 1_800_000_000_000, identity = 0, releaseScope = false
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const nodes = new Map(), scanCaches = new Map(), previewRows = new Map(), faults = new Map()
  const events = [], logs = [], reads = new Map(), nativeCalls = []
  let readScan, readDirectory, nativeOverride, shellOverride
  const folders = []
  const dataDir = path.resolve('C:/hfm-cleanup-diagnostic')
  const key = value => path.resolve(value)
  function directory(target) {
    target = key(target)
    if (nodes.has(target)) return
    const parent = path.dirname(target)
    if (parent !== target) directory(parent)
    nodes.set(target, { kind: 'directory', size: 0 })
  }
  function file(target, contents = '', size = Buffer.byteLength(contents)) {
    target = key(target)
    directory(path.dirname(target))
    nodes.set(target, { kind: 'file', size, contents: Buffer.from(contents), identity: { value: ++identity } })
    return nodes.get(target)
  }
  async function checkFault(operation, target) {
    const fault = faults.get(operation + ':' + key(target))
    if (typeof fault === 'function') await fault()
    else if (fault) throw fault
  }
  const fsp = {
    async stat(target) {
      events.push(['stat', target]); await checkFault('stat', target)
      const node = nodes.get(key(target))
      if (!node) throw error('ENOENT')
      return { size: node.size, isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file' }
    },
    async mkdir(target) { events.push(['mkdir', target]); await checkFault('mkdir', target); directory(target) },
    async readdir(target, options) {
      events.push(['readdir', target]); await checkFault('readdir', target)
      if (!nodes.has(key(target))) throw error('ENOENT')
      const entries = [...nodes].filter(([name]) => name !== key(target) && path.dirname(name) === key(target))
      return entries.map(([name, node]) => options?.withFileTypes
        ? { name: path.basename(name), isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'directory' }
        : path.basename(name))
    },
    async rm() { assert.fail('cleanup bypassed the guarded native removal port') },
    async unlink() { assert.fail('cleanup bypassed the guarded native removal port') }
  }
  function requireOwner(target, expected) {
    const node = nodes.get(key(target))
    assert(node && node.identity === expected, 'cleanup used a missing or superseded owned-lock identity: ' + target)
    return node
  }
  async function executeSharedFile(request, payload) {
    nativeCalls.push({ ...request, releaseScope })
    events.push([request.operation, request.path])
    if (nativeOverride) {
      const overridden = await nativeOverride(request, payload)
      if (overridden !== undefined) return overridden
    }
    await checkFault(request.operation, request.path)
    switch (request.operation) {
      case 'openFile': {
        assert.equal(request.exclusive, true, 'cleanup must acquire locks exclusively')
        if (nodes.has(key(request.path))) throw error('EEXIST', 'existing owner is busy')
        return receipt(file(request.path).identity)
      }
      case 'writeOwnedFile': {
        const node = requireOwner(request.path, request.identity)
        assert(Buffer.isBuffer(payload), 'lease payload was not written')
        node.contents = Buffer.from(payload)
        node.identity = { value: ++identity }
        return receipt(node.identity)
      }
      case 'removeOwnedFile':
        assert(releaseScope, 'lock release inherited the cancelled shared-I/O signal')
        requireOwner(request.path, request.identity)
        nodes.delete(key(request.path))
        return receipt(true)
      case 'removeWithOwnedLocks':
        assert(request.guards.length, 'guarded deletion has no lease')
        assert(request.rootPath, 'guarded deletion omitted its pinned cache root')
        for (const guard of request.guards) requireOwner(guard.path, guard.identity)
        return receipt(request.paths.map(target => {
          const relative = path.relative(request.rootPath, target)
          assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup target escaped its cache root')
          const removed = nodes.delete(key(target))
          if (removed) scanCaches.delete(key(target))
          return { path: target, status: removed ? 'removed' : 'missing' }
        }))
      case 'previewCleanupRows':
        assert.equal(request.schemaVersion, constants.PREVIEW_SQLITE_SCHEMA_VERSION)
        return receipt([...(previewRows.get(key(request.path)) || [])])
      case 'previewCleanupEntries': {
        assert(request.rootPath, 'preview cleanup omitted its pinned cache root')
        assert.equal(request.schemaVersion, constants.PREVIEW_SQLITE_SCHEMA_VERSION)
        assert(request.previewKeys.length <= 32)
        assert(request.previewKeys.every(value => /^[a-f0-9]{40}$/.test(value)))
        const rows = previewRows.get(key(request.path)) || new Set()
        return receipt(request.previewKeys.map(previewKey => {
          rows.delete(previewKey)
          nodes.delete(key(path.join(request.dest, previewKey + '.png')))
          return { key: previewKey, status: 'removed', rowsCommitted: true }
        }))
      }
      default: assert.fail('unexpected native cleanup operation: ' + request.operation)
    }
  }
  const ports = {
    './rootIndexFileRuntime': { writeJsonAtomic: async (target, value) => {
      await checkFault('writeRebuildRequest', path.dirname(target))
      file(target, JSON.stringify(value))
    } },
    '../../path/sharedFileSystemRuntime': { sharedFileSystem: fsp, executeSharedFile,
      sharedSqliteReadSnapshot: async () => null,
      withoutSharedIoSignal: async action => {
        const previous = releaseScope; releaseScope = true
        try { return await action() } finally { releaseScope = previous }
      } },
    './sharedFileSystemRuntime': { sharedFileSystem: fsp },
    '../../path/sharedDirectoryMetadataRuntime': {
      readSharedDirectoryMetadata: async target => readDirectory ? readDirectory(target) : null
    }
  }
  const load = createLoader(ports, Clock)
  const constants = load('src/main/cache/constants.ts')
  const paths = load('src/main/cache/cachePaths.ts').createCachePathHelpers({
    dataPath: (...parts) => path.join(dataDir, ...parts),
    sha1: text => require('node:crypto').createHash('sha1').update(text).digest('hex'), fontExtensions: new Set(['.ttf'])
  })
  const options = {
    ...paths, previewSqliteSchemaVersion: constants.PREVIEW_SQLITE_SCHEMA_VERSION,
    previewSqlitePath: () => path.join(dataDir, 'preview.sqlite'),
    appWatchedFolders: async () => [...folders],
    loadLibraryShell: async () => shellOverride ? shellOverride() : { folders: [...folders] },
    exists: async target => nodes.has(key(target)),
    appendStartupLog: text => logs.push(text),
    listRootIndexDatabaseFiles: async (_directory, db) => nodes.has(key(db)) ? [db] : [],
    readRootIndexSqliteFile: async target => scanCaches.get(key(target)) || cache(0),
    openStableSqliteDb: target => ({ prepare: () => ({ get: () => {
      const count = previewRows.get(key(target))?.size || 0
      return { entries: count, goodEntries: count, badEntries: 0 }
    } }) }),
    initializePreviewDb() {}, closeSqliteDb() {}
  }
  const stats = load(statsFile).createCacheStatsRuntime(options, {
    readScanCacheFile: async target => {
      reads.set(key(target), (reads.get(key(target)) || 0) + 1)
      return readScan ? readScan(target) : scanCaches.get(key(target)) || cache(0)
    }
  })
  function cleanup(realStats = false) {
    let statsReads = 0, invalidations = 0
    const runtime = load(storage + 'cacheCleanupRuntime.ts').createCacheCleanupRuntime(options, {
      invalidateCacheStats() { invalidations++; events.push(['invalidate']); stats.invalidateCacheStats() },
      getCacheStats: async () => {
        statsReads++; events.push(['stats'])
        return realStats ? stats.getCacheStats() : { entries: 0, goodEntries: 0, badEntries: 0, sizeBytes: 0 }
      }
    })
    return { runtime, get statsReads() { return statsReads }, get invalidations() { return invalidations } }
  }
  function seedScan(folder, fallback = false) {
    const cacheDir = fallback ? options.fallbackCacheRootDir(folder) : options.rootCacheDir(folder)
    const db = fallback ? options.fallbackIndexDbPath(folder) : options.rootIndexDbPath(folder)
    const json = fallback ? options.fallbackScanCachePath(folder) : options.rootScanCachePath(folder)
    const snapshot = path.join(path.dirname(db), 'index.retained.sqlite')
    for (const target of [db, db + '-wal', db + '-shm', db + '-journal', snapshot, snapshot + '-wal', json,
      path.join(cacheDir, constants.ROOT_CACHE_MANIFEST_FILE_NAME), path.join(path.dirname(db), constants.ROOT_INDEX_LATEST_FILE_NAME)]) file(target, 'retained-cache')
    return { cacheDir, db, json, snapshot }
  }
  function seedPreview(cacheDir, imageDir, db, keys = [oldPreviewKey]) {
    directory(cacheDir); directory(imageDir); file(db, 'preview-container', 20)
    previewRows.set(key(db), new Set(keys))
    for (const item of keys) file(path.join(imageDir, item + '.png'), 'image', 90)
    return { cacheDir, imageDir, db }
  }
  return { options, stats, cleanup, constants, nodes, scanCaches, previewRows, faults, events, logs, reads, nativeCalls, folders, key, file, directory, seedScan, seedPreview,
    lease: load(storage + 'cacheCleanupLeaseRuntime.ts').withCacheCleanupLocks,
    advance: ms => { now += ms },
    setReadScan: fn => { readScan = fn }, setReadDirectory: fn => { readDirectory = fn },
    setNativeOverride: fn => { nativeOverride = fn }, setShellOverride: fn => { shellOverride = fn } }
}

async function warmClearReadsCurrentStats() {
  const h = harness(), scan = h.options.legacyScanCachePath(), images = h.options.localPreviewImageDir(), db = h.options.previewSqlitePath()
  h.file(scan, 'scan', 40); h.scanCaches.set(h.key(scan), cache(2, 1))
  h.seedPreview(images, images, db)
  await h.stats.getCacheStats(); await settle(); h.advance(10_001)
  const before = await h.stats.getCacheStats()
  assert.deepEqual(before, { entries: 4, goodEntries: 3, badEntries: 1, sizeBytes: 150 })
  assert.equal(h.reads.get(h.key(scan)), 1, 'warm aggregate failed to reuse the per-file cache')
  const cleanup = h.cleanup(true)
  const scanResult = await cleanup.runtime.clearScanCache()
  assert.equal(scanResult.entries, 1, 'clearing a warm scan cache returned pre-clear entries')
  assert.equal(h.nodes.has(h.key(scan)), false)
  await settle()
  assert.equal((await h.stats.getCacheStats()).sizeBytes, 110, 'old file bytes survived clear')
  const previewResult = await cleanup.runtime.clearPreviewCache()
  assert.equal(previewResult.entries, 0, 'clearing a warm preview cache returned pre-clear rows')
  await settle()
  assert.equal((await h.stats.getCacheStats()).sizeBytes, 20, 'old directory bytes survived clear')
  assert(h.nodes.has(h.key(db)), 'snapshot cleanup removed the preview database container')
  assert.equal(cleanup.invalidations, 4, 'each clear must invalidate before work and in finally')
  assert.equal(cleanup.statsReads, 2)
  assert.equal(h.reads.get(h.key(scan)), 3, 'file cache was not invalidated for both clears')
}

async function oldPublicCallerRejoinsCurrentGeneration() {
  const h = harness(), old = deferred(), fresh = deferred(), scan = h.options.legacyScanCachePath()
  let loads = 0
  h.setReadScan(() => (++loads === 1 ? old.promise : fresh.promise))
  const retired = h.stats.getCacheStats()
  await until(() => loads === 1, 'old cold stats read never started')
  h.stats.invalidateCacheStats()
  let freshSettled = false
  const current = h.stats.getCacheStats().then(value => { freshSettled = true; return value })
  await until(() => loads === 2, 'post-clear stats joined retired file work')
  old.resolve(cache(7)); await settle()
  assert.equal(freshSettled, false, 'retired completion settled the current stats caller')
  const joined = h.stats.getCacheStats()
  await settle(); assert.equal(loads, 2, 'retired aggregate finalizer removed the current in-flight promise')
  fresh.resolve(cache(1, 1))
  for (const result of await Promise.all([retired, current, joined])) assert.deepEqual(result, { entries: 2, goodEntries: 1, badEntries: 1, sizeBytes: 0 })
  await settle(); h.advance(10_001)
  assert.equal((await h.stats.getCacheStats()).entries, 2)
  assert.equal(h.reads.get(h.key(scan)), 2, 'retired read republished a file cache')
}

async function coldFileFinalizerKeepsNewOwner() {
  const h = harness(), old = deferred(), fresh = deferred(), file = h.options.legacyScanCachePath()
  let loads = 0
  h.setReadScan(() => (++loads === 1 ? old.promise : fresh.promise))
  const retired = h.stats.diagnosticFileStats(file)
  await until(() => loads === 1, 'cold file read not started')
  h.stats.invalidateCacheStats()
  const current = h.stats.diagnosticFileStats(file)
  await until(() => loads === 2, 'new generation did not start its own cold file read')
  old.resolve(cache(9)); await retired; await settle()
  const joined = h.stats.diagnosticFileStats(file)
  await settle()
  assert.equal(loads, 2, 'old cold-file finalizer deleted the newer in-flight entry')
  fresh.resolve(cache(1))
  assert.equal((await current).entries, 1); assert.equal((await joined).entries, 1)
  assert.equal((await h.stats.diagnosticFileStats(file)).entries, 1, 'old cold-file result republished into the current cache')
}

async function backgroundFileFinalizerKeepsNewOwner() {
  const h = harness(), oldRefresh = deferred(), fresh = deferred(), file = h.options.legacyScanCachePath()
  let loads = 0
  h.setReadScan(() => { loads++; return loads === 1 ? cache(5) : loads === 2 ? oldRefresh.promise : fresh.promise })
  assert.equal((await h.stats.diagnosticFileStats(file)).entries, 5)
  h.advance(300_001)
  assert.equal((await h.stats.diagnosticFileStats(file)).entries, 5)
  await until(() => loads === 2, 'expired file cache did not refresh in the background')
  h.stats.invalidateCacheStats()
  const current = h.stats.diagnosticFileStats(file)
  await until(() => loads === 3, 'clear retained the expired-file refresh')
  oldRefresh.resolve(cache(8)); await settle()
  const joined = h.stats.diagnosticFileStats(file)
  await settle(); assert.equal(loads, 3, 'old background refresh deleted the new file owner')
  fresh.resolve(cache(2))
  assert.equal((await current).entries, 2); assert.equal((await joined).entries, 2)
  assert.equal((await h.stats.diagnosticFileStats(file)).entries, 2)
}

async function directoryCompletionCannotRepublishOrDeleteNewOwner() {
  const h = harness(), directory = h.options.localPreviewImageDir(), gates = [deferred(), deferred(), deferred(), deferred()]
  let loads = 0
  h.setReadDirectory(() => {
    assert(loads < gates.length, 'retired directory finalizer scheduled duplicate current work')
    return gates[loads++].promise
  })
  assert.equal(h.stats.diagnosticDirectorySize(directory), 0)
  h.stats.invalidateCacheStats()
  assert.equal(h.stats.diagnosticDirectorySize(directory), 0)
  assert.equal(loads, 2)
  gates[0].resolve({ entries: [fileEntry('old.png', 900)] }); await settle()
  assert.equal(h.stats.diagnosticDirectorySize(directory), 0, 'old directory completion republished bytes after clear')
  assert.equal(loads, 2, 'old directory completion removed the newer in-flight task')
  gates[1].resolve({ entries: [fileEntry('new.png', 25)] }); await settle()
  assert.equal(h.stats.diagnosticDirectorySize(directory), 25)
  h.advance(300_001)
  assert.equal(h.stats.diagnosticDirectorySize(directory), 25)
  assert.equal(loads, 3)
  h.stats.invalidateCacheStats()
  assert.equal(h.stats.diagnosticDirectorySize(directory), 0)
  gates[2].resolve({ entries: [fileEntry('expired.png', 800)] }); await settle()
  assert.equal(h.stats.diagnosticDirectorySize(directory), 0, 'expired background result escaped its generation')
  assert.equal(loads, 4)
  gates[3].resolve({ entries: [fileEntry('latest.png', 12)] }); await settle()
  assert.equal(h.stats.diagnosticDirectorySize(directory), 12)
}

async function scanPartialFailuresStillVisitOtherRoots() {
  for (const mode of ['busy', 'denied', 'offline', 'request-publication']) {
    const h = harness(), badRoot = path.resolve('D:/fonts-one'), goodRoot = path.resolve('E:/fonts-two')
    h.folders.push(badRoot, goodRoot)
    const bad = h.seedScan(badRoot), fallback = h.seedScan(badRoot, true), good = h.seedScan(goodRoot)
    const busyPath = path.join(bad.cacheDir, h.constants.ROOT_CACHE_LOCK_DIR_NAME, h.constants.ROOT_INDEX_LOCK_FILE_NAME)
    let busyOwner
    if (mode === 'busy') busyOwner = h.file(busyPath, 'original-writer-lock')
    else if (mode === 'request-publication') h.faults.set('writeRebuildRequest:' + h.key(bad.cacheDir), error('EACCES', 'rebuild request publication denied'))
    else h.faults.set('stat:' + h.key(bad.cacheDir), error(mode === 'denied' ? 'EACCES' : 'ENETUNREACH', mode + '-root'))
    const cleanup = h.cleanup()
    await assert.rejects(cleanup.runtime.clearScanCache(), /缓存清理未全部完成/, mode + ' was reported as successful cleanup')
    assert.equal(h.nodes.has(h.key(bad.db)), true, mode + ': failed root database was deleted')
    assert.equal(h.nativeCalls.filter(call => call.operation === 'removeWithOwnedLocks' && call.paths.includes(bad.db)).length, 0, mode + ': incomplete acquisition/enumeration authorized guarded deletion')
    assert.equal(h.nodes.has(h.key(good.db)), true, mode + ': last-good source database was removed')
    assert.equal(h.nodes.has(h.key(path.join(good.cacheDir, 'index-rebuild-request.json'))), true, mode + ': later healthy root reset was skipped')
    assert.equal(h.nodes.has(h.key(good.json)), false, mode + ': reusable legacy JSON survived reset')
    assert.equal(h.nodes.has(h.key(good.snapshot + '-wal')), true, mode + ': retained source sidecar was removed')
    assert.equal(h.nodes.has(h.key(fallback.db)), true, mode + ': fallback source was removed')
    assert.equal(h.nodes.has(h.key(path.join(fallback.cacheDir, 'index-rebuild-request.json'))), true, mode + ': failed root prevented fallback reset')
    assert.equal(cleanup.invalidations, 2, mode + ': partial clear skipped finally invalidation')
    assert.equal(cleanup.statsReads, 0, mode + ': failure fabricated successful stats')
    assert.equal(h.events[0][0], 'invalidate', mode + ': deletion started before invalidation')
    assert.equal(h.events.at(-1)[0], 'invalidate', mode + ': finally invalidation did not follow all I/O')
    assert(h.logs.some(text => text.startsWith('cache cleanup retained: ')), mode + ': retained files missing from logs')
    if (busyOwner) {
      assert.equal(h.nodes.get(h.key(busyPath)), busyOwner, 'busy lock identity was replaced')
      assert.equal(busyOwner.contents.toString(), 'original-writer-lock', 'busy owner lock bytes changed')
      assert(!h.nativeCalls.some(call => ['writeOwnedFile', 'removeOwnedFile'].includes(call.operation) && call.path === busyPath), 'cleanup touched a lock it never acquired')
    }
  }
}

async function rootEnumerationFailureIsNotSuccess() {
  for (const kind of ['scan', 'preview']) {
    const h = harness(), scan = h.options.legacyScanCachePath(), imageDir = h.options.localPreviewImageDir()
    if (kind === 'scan') h.file(scan, 'legacy-cache')
    else h.seedPreview(imageDir, imageDir, h.options.previewSqlitePath())
    h.setShellOverride(() => { throw error('EACCES', 'configured roots unavailable') })
    const cleanup = h.cleanup()
    await assert.rejects(cleanup.runtime[kind === 'scan' ? 'clearScanCache' : 'clearPreviewCache'](), /读取字体根目录失败/)
    assert.equal(cleanup.invalidations, 2)
    assert.equal(cleanup.statsReads, 0)
    assert.equal(h.nodes.has(h.key(kind === 'scan' ? scan : path.join(imageDir, oldPreviewKey + '.png'))), false, 'completed local deletion was not preserved on root enumeration failure')
  }
}

async function previewPartialFailuresStillVisitOtherRoots() {
  for (const mode of ['busy', 'denied', 'offline', 'bad-receipt', 'failed-row']) {
    const h = harness(), badRoot = path.resolve('D:/fonts-one'), goodRoot = path.resolve('E:/fonts-two')
    h.folders.push(badRoot, goodRoot)
    const bad = h.seedPreview(h.options.rootPreviewCacheDir(badRoot), h.options.rootPreviewImageDir(badRoot), h.options.rootPreviewDbPath(badRoot))
    const good = h.seedPreview(h.options.rootPreviewCacheDir(goodRoot), h.options.rootPreviewImageDir(goodRoot), h.options.rootPreviewDbPath(goodRoot))
    if (mode === 'busy') h.faults.set('previewCleanupRows:' + h.key(bad.db), error('SQLITE_BUSY', 'preview is busy'))
    else if (mode === 'denied') h.faults.set('readdir:' + h.key(bad.imageDir), error('EACCES', 'preview directory denied'))
    else if (mode === 'offline') h.faults.set('stat:' + h.key(bad.cacheDir), error('ENETUNREACH', 'preview root offline'))
    else h.setNativeOverride(request => {
      if (request.operation === 'previewCleanupEntries' && request.path === bad.db) return receipt(mode === 'bad-receipt' ? [] : [{ key: oldPreviewKey, status: 'failed', rowsCommitted: false, message: 'guarded preview deletion denied' }])
    })
    const cleanup = h.cleanup()
    await assert.rejects(cleanup.runtime.clearPreviewCache(), /缓存清理未全部完成/, mode + ' preview error became success')
    assert(h.nodes.has(h.key(path.join(bad.imageDir, oldPreviewKey + '.png'))), mode + ': failed preview image disappeared')
    assert.equal(h.nodes.has(h.key(path.join(good.imageDir, oldPreviewKey + '.png'))), false, mode + ': later preview root was skipped')
    assert(h.nodes.has(h.key(good.db)), mode + ': preview database container was removed')
    assert.equal(cleanup.invalidations, 2); assert.equal(cleanup.statsReads, 0)
    if (['busy', 'denied', 'offline'].includes(mode)) assert(!h.nativeCalls.some(call => call.operation === 'previewCleanupEntries' && call.path === bad.db), mode + ': incomplete preview enumeration authorized deletion')
  }
}

async function previewSnapshotBatchesPreserveNewKeys() {
  const h = harness(), imageDir = h.options.localPreviewImageDir(), db = h.options.previewSqlitePath()
  const keys = Array.from({ length: 70 }, (_, i) => i.toString(16).padStart(40, '0'))
  h.seedPreview(imageDir, imageDir, db, keys)
  let published = false
  h.setNativeOverride(request => {
    if (request.operation === 'previewCleanupEntries' && !published) {
      published = true
      h.previewRows.get(h.key(db)).add(laterPreviewKey)
      h.file(path.join(imageDir, laterPreviewKey + '.png'), 'new-image')
    }
  })
  const cleanup = h.cleanup()
  await cleanup.runtime.clearPreviewCache()
  const batches = h.nativeCalls.filter(call => call.operation === 'previewCleanupEntries')
  assert.deepEqual(batches.map(call => call.previewKeys.length), [32, 32, 6])
  assert.deepEqual(batches.flatMap(call => call.previewKeys), keys)
  assert.deepEqual([...h.previewRows.get(h.key(db))], [laterPreviewKey])
  assert(h.nodes.has(h.key(path.join(imageDir, laterPreviewKey + '.png'))), 'post-snapshot preview was deleted')
  assert(h.nodes.has(h.key(db)))
  assert.equal(cleanup.statsReads, 1); assert.equal(cleanup.invalidations, 2)
}

async function missingPreviewDirectoryDoesNotHideDatabaseRows() {
  const h = harness(), imageDir = h.options.localPreviewImageDir(), db = h.options.previewSqlitePath()
  h.file(db, 'preview-container')
  h.previewRows.set(h.key(db), new Set([oldPreviewKey]))
  assert.equal(h.nodes.has(h.key(imageDir)), false)
  const cleanup = h.cleanup()
  await cleanup.runtime.clearPreviewCache()
  assert.equal(h.previewRows.get(h.key(db)).size, 0, 'missing image directory hid retained preview index rows')
  assert(h.nodes.has(h.key(db)), 'missing-image cleanup removed the database container')
  assert.equal(h.nativeCalls.filter(call => call.operation === 'previewCleanupEntries').length, 1)
  assert.equal(cleanup.invalidations, 2); assert.equal(cleanup.statsReads, 1)
}

async function unsupportedPreviewKeyIsRetainedAndReported() {
  const h = harness(), imageDir = h.options.localPreviewImageDir(), db = h.options.previewSqlitePath()
  h.seedPreview(imageDir, imageDir, db, ['not-a-supported-key', oldPreviewKey])
  const cleanup = h.cleanup()
  await assert.rejects(cleanup.runtime.clearPreviewCache(), /不支持的预览键已保留/)
  assert(h.nodes.has(h.key(path.join(imageDir, 'not-a-supported-key.png'))))
  assert(h.previewRows.get(h.key(db)).has('not-a-supported-key'))
  assert.equal(h.nodes.has(h.key(path.join(imageDir, oldPreviewKey + '.png'))), false, 'unsupported sibling prevented supported-key cleanup')
  assert.deepEqual(h.nativeCalls.filter(call => call.operation === 'previewCleanupEntries').flatMap(call => call.previewKeys), [oldPreviewKey])
  assert.equal(cleanup.invalidations, 2); assert.equal(cleanup.statsReads, 0)
}

async function ownedPreviewStagesAreRetainedAsPartialCleanup() {
  for (const owner of ['render', 'hydrate', 'display']) {
    const h = harness(), imageDir = h.options.localPreviewImageDir(), db = h.options.previewSqlitePath()
    h.seedPreview(imageDir, imageDir, db)
    const stages = [oldPreviewKey, laterPreviewKey].map(previewKey => {
      const target = path.join(imageDir, `${previewKey}.png.${owner}.00000000-0000-4000-8000-000000000001.png`)
      const contents = `${owner}-owned-stage:${previewKey}`
      return { target, contents, node: h.file(target, contents) }
    })
    const cleanup = h.cleanup()
    await assert.rejects(cleanup.runtime.clearPreviewCache(), failure => {
      assert.match(failure.message, /缓存清理未全部完成/)
      assert.match(failure.message, /预览任务暂存文件已保留/)
      assert(!failure.message.includes('不支持的预览键'), owner + ': owned stage was misclassified as an unsupported cache key')
      return true
    })
    assert.equal(h.nodes.has(h.key(path.join(imageDir, oldPreviewKey + '.png'))), false, owner + ': owned stage prevented normal cache-image cleanup')
    assert.equal(h.previewRows.get(h.key(db)).has(oldPreviewKey), false, owner + ': ordinary captured index row was retained')
    for (const stage of stages) {
      assert.equal(h.nodes.get(h.key(stage.target)), stage.node, owner + ': active stage was removed or replaced')
      assert.equal(h.nodes.get(h.key(stage.target)).contents.toString(), stage.contents, owner + ': active stage bytes changed')
      assert(h.logs.some(text => text.includes(imageDir) && text.includes(path.basename(stage.target)) && text.includes('预览任务暂存文件已保留')), owner + ': retained stage was not reported')
    }
    assert.deepEqual(h.nativeCalls.filter(call => call.operation === 'previewCleanupEntries').flatMap(call => call.previewKeys), [oldPreviewKey], owner + ': stage-only key was passed to native cache deletion')
    assert.equal(cleanup.invalidations, 2, owner + ': partial stage retention skipped final invalidation')
    assert.equal(cleanup.statsReads, 0, owner + ': partial stage retention fabricated success statistics')
  }
}

async function leaseAcquisitionFailureKeepsExistingOwner() {
  const h = harness(), first = path.resolve('C:/lease/first.lock'), busy = path.resolve('C:/lease/busy.lock')
  const original = h.file(busy, 'another-owner')
  let actionCalls = 0
  await assert.rejects(h.lease([first, busy], async remove => { actionCalls++; return remove(['C:/should-not-delete']) }, h.options.appendStartupLog), /existing owner is busy/)
  assert.equal(actionCalls, 0, 'action ran without all cleanup leases')
  assert.equal(h.nativeCalls.filter(call => call.operation === 'removeWithOwnedLocks').length, 0)
  assert.equal(h.nodes.get(h.key(busy)), original)
  assert.equal(original.contents.toString(), 'another-owner')
  assert.equal(h.nodes.has(h.key(first)), false, 'earlier lease leaked when a later acquisition failed')
}

async function physicalClosePrecedesReleaseAndPreservesPrimaryFailure() {
  const h = harness(), leasePath = path.resolve('C:/lease/guard.lock')
  const primaryClosed = deferred(), releaseClosed = deferred()
  const primary = error('ETIMEDOUT', 'main cleanup failed', { sharedIo: true, closed: primaryClosed.promise })
  const secondary = error('EACCES', 'release also failed', { sharedIo: true, closed: releaseClosed.promise })
  let releaseStarted = false, settled = false
  h.setNativeOverride(request => {
    if (request.operation === 'removeWithOwnedLocks') throw primary
    if (request.operation === 'removeOwnedFile') { releaseStarted = true; throw secondary }
  })
  const task = h.lease([leasePath], remove => remove([path.resolve('C:/lease/index.sqlite')]), h.options.appendStartupLog)
  const observed = task.then(value => { settled = true; return { value } }, failure => { settled = true; return { failure } })
  await until(() => h.nativeCalls.some(call => call.operation === 'removeWithOwnedLocks'), 'guarded delete never started')
  await settle()
  assert.equal(releaseStarted, false, 'lease was released before failed native work physically closed')
  assert.equal(settled, false)
  primaryClosed.resolve(); await until(() => releaseStarted, 'lease release did not start after physical close')
  await settle(); assert.equal(settled, false, 'release timeout settled before physical release closure')
  releaseClosed.resolve()
  assert.equal((await observed).failure, primary, 'lease release failure masked the original cleanup error')
  assert(h.logs.some(text => text.includes('release also failed')))
  assert(h.nativeCalls.find(call => call.operation === 'removeOwnedFile').releaseScope)
}

async function unconfirmedReleaseAndMalformedReceiptsFailClosed() {
  {
    const h = harness(), leasePath = path.resolve('C:/lease/release.lock')
    h.faults.set('removeOwnedFile:' + h.key(leasePath), error('EACCES', 'release denied'))
    await assert.rejects(h.lease([leasePath], async () => 'otherwise successful', h.options.appendStartupLog), /锁释放未确认/)
  }
  for (const mode of ['missing-row', 'wrong-target', 'invalid-status']) {
    const h = harness(), leasePath = path.resolve('C:/lease/receipt.lock'), target = path.resolve('C:/lease/index.sqlite')
    h.setNativeOverride(request => {
      if (request.operation === 'removeWithOwnedLocks') return receipt(mode === 'missing-row' ? [] : [{ path: mode === 'wrong-target' ? target + '.other' : target, status: mode === 'invalid-status' ? 'unknown' : 'removed' }])
    })
    await assert.rejects(h.lease([leasePath], remove => remove([target]), h.options.appendStartupLog), /清理回执不完整/)
    assert.equal(h.nodes.has(h.key(leasePath)), false, mode + ': validation failure leaked the owned lock')
  }
  {
    const h = harness(), leasePath = path.resolve('C:/lease/expired.lock')
    await assert.rejects(h.lease([leasePath], remove => {
      h.advance(h.constants.ROOT_SCAN_CACHE_LOCK_STALE_MS / 2)
      return remove([path.resolve('C:/lease/too-late.sqlite')])
    }, h.options.appendStartupLog), /清理等待过久/)
    assert(!h.nativeCalls.some(call => call.operation === 'removeWithOwnedLocks'), 'expired lease authorized deletion')
    assert.equal(h.nodes.has(h.key(leasePath)), false)
  }
}

async function releaseLoggingCannotMaskAnyPrimaryFailure() {
  for (const primary of [new Error('primary operation failed'), undefined, null, false, 0, '']) {
    const h = harness(), first = path.resolve('C:/lease/first.lock'), second = path.resolve('C:/lease/second.lock')
    h.setNativeOverride(request => { if (request.operation === 'removeOwnedFile') throw error('EACCES', 'release failed') })
    const outcome = await h.lease([first, second], async () => { throw primary }, () => { throw new Error('logging also failed') })
      .then(value => ({ ok: true, value }), failure => ({ ok: false, failure }))
    assert.equal(outcome.ok, false, 'falsy primary failure was converted to success')
    assert.equal(outcome.failure, primary, 'release/logging failure replaced the primary thrown value')
    assert.deepEqual(h.nativeCalls.filter(call => call.operation === 'removeOwnedFile').map(call => call.path), [second, first], 'logging failure prevented release attempts for remaining leases')
  }
}

async function queuedClearWaitsForPhysicalFailureSettlement() {
  const h = harness(), scan = h.options.legacyScanCachePath(), closed = deferred()
  h.file(scan, 'scan-cache')
  let deletes = 0
  h.setNativeOverride(request => {
    if (request.operation === 'removeWithOwnedLocks' && ++deletes === 1) throw error('ETIMEDOUT', 'native cleanup still closing', { sharedIo: true, closed: closed.promise })
  })
  const cleanup = h.cleanup()
  const first = cleanup.runtime.clearScanCache().then(value => ({ value }), failure => ({ failure }))
  await until(() => deletes === 1, 'first cleanup did not reach its native action')
  const second = cleanup.runtime.clearScanCache()
  await settle()
  assert.equal(cleanup.invalidations, 1, 'queued clear started while previous native work was still open')
  assert.equal(deletes, 1)
  assert.equal(h.nativeCalls.filter(call => call.operation === 'removeOwnedFile').length, 0)
  closed.resolve()
  assert.match((await first).failure.message, /缓存清理未全部完成/)
  await second
  assert.equal(deletes, 2, 'failed predecessor prevented subsequent cleanup')
  assert.equal(cleanup.invalidations, 4)
  assert.equal(cleanup.statsReads, 1, 'only the successful queued clear may return statistics')
  assert.equal(h.nodes.has(h.key(scan)), false)
}

async function main() {
  const cases = [previewCleanupRowsUseDatabaseWriteAdmission,
    warmClearReadsCurrentStats, oldPublicCallerRejoinsCurrentGeneration,
    coldFileFinalizerKeepsNewOwner, backgroundFileFinalizerKeepsNewOwner,
    directoryCompletionCannotRepublishOrDeleteNewOwner, scanPartialFailuresStillVisitOtherRoots,
    rootEnumerationFailureIsNotSuccess, previewPartialFailuresStillVisitOtherRoots,
    previewSnapshotBatchesPreserveNewKeys, missingPreviewDirectoryDoesNotHideDatabaseRows,
    unsupportedPreviewKeyIsRetainedAndReported, ownedPreviewStagesAreRetainedAsPartialCleanup,
    leaseAcquisitionFailureKeepsExistingOwner,
    physicalClosePrecedesReleaseAndPreservesPrimaryFailure, unconfirmedReleaseAndMalformedReceiptsFailClosed,
    releaseLoggingCannotMaskAnyPrimaryFailure, queuedClearWaitsForPhysicalFailureSettlement]
  for (const test of cases) {
    let timer
    try {
      await Promise.race([test(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(test.name + ' did not settle')), 15_000) })])
      console.log('[diagnostics:cache-cleanup-safety] ' + test.name + ' ok')
    } finally { clearTimeout(timer) }
  }
  completed = true
  console.log('[diagnostics:cache-cleanup-safety] ok (' + cases.length + ' behavior groups)')
}
main().catch(failure => { console.error(failure.stack || failure); process.exitCode = 1 })
