#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ts = require('typescript')
const { load } = require('./check-decomposition-baseline.cjs')
const root = path.resolve(__dirname, '../..')
const storageFile = 'src/main/preview/runtime/previewCacheStorageRuntime.ts'
const routeFile = 'src/main/preview/runtime/previewStorageRoutingRuntime.ts'
const routePath = process.argv.includes('--win-paths') ? path.win32 : path
const fontRoot = routePath.resolve('routing-fonts'), fontPath = routePath.join(fontRoot, 'a.ttf')
const cacheDir = routePath.join(fontRoot, 'cache'), imagesDir = routePath.join(cacheDir, 'images'), dbPath = routePath.join(cacheDir, 'index.db')
const localDir = routePath.resolve('routing-local'), rootLocalDir = routePath.join(localDir, 'roots', 'root-hash', 'images')
const outsidePath = routePath.resolve('routing-other.ttf')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const plain = x => JSON.parse(JSON.stringify(x))
const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function bodies(source) {
  source = source.replace(/\r\n/g, "\n")
  const ast = ts.createSourceFile('runtime.ts', source, ts.ScriptTarget.Latest, true)
  const result = {}
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.body.getText(ast))
      const tokens = []; while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText())
      result[node.name.text] = crypto.createHash('sha256').update(JSON.stringify(tokens)).digest('hex')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast); return result
}
function structure() {
  const fixture = JSON.parse(read('build/diagnostics/fixtures/preview-storage-routing.fixture.json'))
  for (const crlf of [false, true]) {
    const source = crlf ? read(routeFile).replace(/\r?\n/g, '\r\n') : read(routeFile)
    const current = bodies(source)
    for (const [name, hash] of Object.entries(fixture.movedBodies)) {
      assert.equal(current[name], hash, `${name} must be a pure relocation`)
      assert.equal(bodies(read(storageFile))[name], undefined, `${name} duplicated in facade`)
    }
    assert.equal(bodies(read('src/main/preview/runtime/previewStorageIoRuntime.ts')).runRequiredRootPreviewCacheIo, fixture.requiredIoBody)
  }
  const facade = read(storageFile), route = read(routeFile)
  assert.equal((facade.match(/const rootAvailability = createPreviewCacheRootAvailabilityRuntime\(/g) || []).length, 1)
  assert(!route.includes('= createPreviewCacheRootAvailabilityRuntime('))
  assert(!facade.includes('let libraryShellCache'))
  for (const name of ['readStatusCache', 'readStatusInFlight', 'readStatusGeneration']) assert(!route.includes(name))
}
function harness(transform = x => x) {
  const events = [], state = { available: true, loads: 0, library: { folders: [fontRoot] }, failure: '', manifestHold: null, loadHold: null }
  const mocks = { 'node:path': routePath }
  const factories = { previewCacheSharedPresenceRuntime: 'createPreviewCacheSharedPresenceRuntime', previewCachePresenceIndexRuntime: 'createPreviewCacheSharedPresenceIndexRuntime', previewCacheMetaRuntime: 'createPreviewCacheMetaRuntime', previewCacheHydrationRuntime: 'createPreviewCacheHydrationRuntime', previewCachePrefetchRuntime: 'createPreviewCachePrefetchRuntime', previewLocalCacheEvictionRuntime: 'createPreviewLocalCacheEvictionRuntime' }
  for (const [file, name] of Object.entries(factories)) mocks[`./${file}`] = { [name]: () => ({}) }
  mocks['./previewCacheRootAvailabilityRuntime'] = { createPreviewCacheRootAvailabilityRuntime: () => ({
    async ensureRootPreviewCacheAvailable(r) { events.push(['probe', r]); return state.available },
    markRootPreviewCacheUnavailable(r) { events.push(['unavailable', r]) }
  }) }
  mocks['./previewCacheTierRuntime'] = load('src/main/preview/runtime/previewCacheTierRuntime.ts', { 'node:path': routePath })
  for (const id of ['./previewInputPolicy', './previewCacheKeyRuntime', './previewCachedImageReadBatchRuntime', './previewInstalledFontRouteRuntime']) mocks[id] = {}
  mocks['../../path/fontPathPolicy'] = { findBestWatchedRootForFile: (_path, folders) => folders[0] || null }
  mocks['../../path/ioDeadlineRuntime'] = { ...load('src/main/path/ioDeadlineRuntime.ts'), previewCacheQueryTimeoutMs: () => 100 }
  mocks['node:fs'] = { promises: { async mkdir(dir) { events.push(['mkdir', dir]); if (state.failure === dir) throw Error('mkdir') } } }
  let route
  mocks['./previewStorageRoutingRuntime'] = { createPreviewStorageRoutingRuntime(options, ports) {
    route = load(routeFile, mocks, transform).createPreviewStorageRoutingRuntime(options, ports); return route
  } }
  const options = {
    async loadLibraryShell() { state.loads++; const hold = state.loadHold; state.loadHold = null; return hold ? hold.promise : state.library },
    cacheKeyForRootFile: (r, p) => `${r}:${p}`, cacheKeyForPath: p => `file:${p}`,
    rootPreviewCacheDir: r => routePath.join(r, 'cache'), rootPreviewImageDir: r => routePath.join(r, 'cache', 'images'), rootPreviewDbPath: r => routePath.join(r, 'cache', 'index.db'),
    localPreviewImageDir: () => localDir, sha1: () => 'root-hash', normalizePathForCacheCompare: x => x,
    async hideDirectoryOnWindows(dir) { events.push(['hide', dir]); if (state.failure === 'hide') throw Error('hide') },
    async writeRootPreviewCacheManifest(...args) { events.push(['manifest', ...args]); if (state.manifestHold) await state.manifestHold.promise },
    appendStartupLog() {}
  }
  const facade = load(storageFile, mocks).createPreviewCacheStorageRuntime(options)
  assert.equal(facade.previewCacheStorageForFont, route.previewCacheStorageForFont)
  assert.equal(facade.invalidateLibraryShellCache, route.invalidateLibraryShellCache)
  return { facade, route, events, state }
}
async function routingCases(transform) {
  const h = harness(transform), expected = { dir: rootLocalDir, identity: `${fontRoot}:${fontPath}`, storage: 'local', shared: { dir: imagesDir, identity: `${fontRoot}:${fontPath}`, storage: 'root', rootPath: fontRoot, indexDbPath: dbPath } }
  assert.deepEqual(plain(h.facade.previewCacheStorageForFontFromIndex(fontPath, h.state.library)), expected)
  assert.equal(h.events.length, 0); assert.equal(h.state.loads, 0)
  assert.deepEqual(plain(await h.facade.previewCacheStorageForFont(fontPath, h.state.library)), expected)
  assert.deepEqual(h.events, [['probe', fontRoot], ['mkdir', imagesDir], ['mkdir', cacheDir], ['hide', cacheDir], ['manifest', cacheDir, fontRoot, 'root', dbPath, imagesDir], ['mkdir', rootLocalDir]])
  assert.equal(h.state.loads, 0)
  for (const failure of ['unavailable', 'hide', imagesDir, 'deadline']) {
    const f = harness(transform); f.state.available = failure !== 'unavailable'; f.state.failure = failure
    if (failure === 'deadline') f.state.manifestHold = gate()
    assert.deepEqual(plain(await f.facade.previewCacheStorageForFont(fontPath, f.state.library)), expected)
    assert(f.events.some(x => x[0] === 'unavailable'))
    assert.deepEqual(f.events.at(-1), ['mkdir', rootLocalDir])
    if (failure === 'unavailable') assert(!f.events.some(x => x[0] === 'manifest'))
    if (failure === 'deadline') { f.state.manifestHold.reject(Error('late')); await Promise.resolve() }
  }
  const outside = harness(transform)
  assert.deepEqual(plain(await outside.facade.previewCacheStorageForFont(outsidePath, { folders: [] })), { dir: localDir, identity: `file:${outsidePath}`, storage: 'local' })
  assert.deepEqual(outside.events, [['mkdir', localDir]])
  const failed = harness(transform); const rejection = gate(); failed.state.loadHold = rejection
  const result = failed.facade.previewCacheStorageForFont(outsidePath); rejection.reject(Error('load'))
  assert.equal((await result).dir, localDir)
}
async function generations(transform) {
  const h = harness(transform), a = gate(), b = gate()
  h.state.loadHold = a; const old = h.route.loadLibraryShellCached(); const joined = h.route.loadLibraryShellCached()
  assert.equal(h.state.loads, 1)
  h.facade.invalidateLibraryShellCache()
  h.state.loadHold = b; const current = h.route.loadLibraryShellCached()
  a.resolve({ folders: ['/old'] }); await old; await joined
  const joinedNew = h.route.loadLibraryShellCached(); assert.equal(h.state.loads, 2, 'old completion must not clear new promise')
  b.resolve({ folders: ['/new'] }); await current; await joinedNew
  assert.deepEqual(plain(await h.route.loadLibraryShellCached()), { folders: ['/new'] })
  const c = gate(); h.facade.invalidateLibraryShellCache(); h.state.loadHold = c; const late = h.route.loadLibraryShellCached()
  h.facade.invalidateLibraryShellCache(); h.state.library = { folders: ['/latest'] }; await h.route.loadLibraryShellCached()
  c.resolve({ folders: ['/stale'] }); await late
  assert.deepEqual(plain(await h.route.loadLibraryShellCached()), { folders: ['/latest'] })
  const fail = gate(); h.facade.invalidateLibraryShellCache(); h.state.loadHold = fail
  const failed = h.route.loadLibraryShellCached(); fail.reject(Error('load')); await assert.rejects(failed, /load/)
  assert.deepEqual(plain(await h.route.loadLibraryShellCached()), { folders: ['/latest'] })
}
async function main() {
  structure(); await routingCases(); await generations()
  await assert.rejects(() => generations(s => s.replace('if (taskGeneration === libraryShellGeneration)', 'if (true)')), assert.AssertionError)
  await assert.rejects(() => generations(s => s.replace('if (libraryShellCachePromise === task)', 'if (true)')), assert.AssertionError)
  await assert.rejects(() => routingCases(s => s.replace('"root",\n                previewDbPath', '"local",\n                previewDbPath')), assert.AssertionError)
  if (!process.argv.includes('--win-paths')) require('node:child_process').execFileSync(process.execPath, [__filename, '--win-paths'], { stdio: 'pipe' })
  console.log('[diagnostics:preview-storage-routing] four unchanged bodies LF/CRLF, sole owners, real facade/tier/deadline, sync purity, preparation order, local degradation, shell coalescing/invalidation/retry, three mutants rejected')
}
module.exports = { bodies }
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1 })
