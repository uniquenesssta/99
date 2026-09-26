#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require('typescript')
const { load } = require('./check-decomposition-baseline.cjs')
const { bodies } = require('./check-preview-storage-routing.cjs')
const root = path.resolve(__dirname, '../..'), base = 'src/main/preview/runtime/'
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const plain = x => JSON.parse(JSON.stringify(x))
function tailBodies(source) {
  const ast = ts.createSourceFile('batch.ts', source.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true), result = {}
  function walk(node) {
    if (ts.isFunctionDeclaration(node) && ['getPreviewCacheStatus', 'readCachedPreviewImages'].includes(node.name?.text)) {
      const text = node.body.getText(ast), tail = text.slice(text.indexOf('    const now ='))
      result[node.name.text] = bodies('function tail() {\n' + tail).tail
    }
    ts.forEachChild(node, walk)
  }
  walk(ast); return result
}
function structure() {
  const fixture = JSON.parse(read('build/diagnostics/fixtures/preview-batch-read.fixture.json'))
  for (const newline of [x => x, x => x.replace(/\r?\n/g, '\r\n')]) {
    assert.deepEqual(tailBodies(newline(read(base + 'previewBatchReadRuntime.ts'))), fixture.queryTails)
    const io = bodies(newline(read(base + 'previewStorageIoRuntime.ts')))
    for (const [k, v] of Object.entries(fixture.ioBodies)) assert.equal(io[k], v)
    assert.equal(bodies(newline(read(base + 'previewBatchRowsRuntime.ts'))).buildPreviewCacheGroups, fixture.rowBuilderBody)
  }
  const facade = read(base + 'previewCacheStorageRuntime.ts')
  assert(!facade.includes('SELECT ') && !facade.includes('previewCacheKey('))
  assert.equal((facade.match(/= createPreviewBatchReadRuntime\(/g) || []).length, 1)
  const route = read(base + 'previewStorageRoutingRuntime.ts')
  assert(route.includes('return tierRuntime.localStorageForRoot(root, identity)'))
  assert(route.includes('return tierRuntime.localStorageForPath('))
}
function harness({ rootStorage = false, shared = true, transform = x => x } = {}) {
  const events = [], rowsByKey = new Map(), files = new Set(), byId = new Map()
  const state = { active: 0, maxActive: 0, reads: [], hydrates: new Set(), available: true, rustCalls: [] }
  const input = load(base + 'previewInputPolicy.ts')
  const keys = load(base + 'previewCacheKeyRuntime.ts', { './previewInputPolicy': input, '../native-renderer/directwrite/directWritePreviewHelperPathRuntime': { hasDirectWritePreviewHelper: () => false } })
  const installed = load(base + 'previewInstalledFontRouteRuntime.ts')
  const deadline = load('src/main/path/ioDeadlineRuntime.ts')
  const imageRead = load(base + 'previewCachedImageReadBatchRuntime.ts', { './previewImageValidationRuntime': load(base + 'previewImageValidationRuntime.ts'), '../../path/ioDeadlineRuntime': deadline, 'node:fs': { promises: { async readFile(p) {
    state.active++; state.maxActive = Math.max(state.active, state.maxActive); state.reads.push(p)
    try { await new Promise(resolve => setTimeout(resolve, 1)); if (!files.has(p)) throw Error('ENOENT'); return require('./fixtures/preview-png.cjs') } finally { state.active-- }
  } } } })
  const options = { sha1: x => crypto.createHash('sha1').update(x).digest('hex'), normalizePathForCacheCompare: x => x.toLowerCase(), normalizePreviewCacheIndexStatus: x => x, appendStartupLog() {}, previewSqliteSchemaVersion: 1 }
  const tier = load(base + 'previewCacheTierRuntime.ts').createPreviewCacheTierRuntime({ ...options, localPreviewImageDir: () => path.resolve('local'), rootPreviewImageDir: r => path.join(r, 'images'), rootPreviewDbPath: r => path.join(r, 'index.db') })
  const rootPath = path.resolve('fonts')
  const selectStorage = p => {
    const local = shared ? tier.localStorageForRoot(rootPath, p) : tier.localStorageForPath(p)
    return rootStorage ? tier.previewCacheStorageToShared(local) : local
  }
  const { buildPreviewCacheGroups } = load(base + 'previewBatchRowsRuntime.ts', { './previewCacheKeyRuntime': keys, './previewInstalledFontRouteRuntime': installed }).createPreviewBatchRowsRuntime(options, selectStorage)
  const rootAvailability = { async ensureRootPreviewCacheAvailable() { return state.available }, markRootPreviewCacheUnavailable() { events.push(['unavailable']) } }
  const io = load(base + 'previewStorageIoRuntime.ts', { '../../path/ioDeadlineRuntime': { ...deadline, previewCacheQueryTimeoutMs: () => 100 } }).createPreviewStorageIoRuntime(options, rootAvailability)
  const hydrationRuntime = { rememberLocalHit(n) { events.push(['hits', n]) }, rememberRenderQueued(n) { events.push(['render', n]) }, async hydratePreviewCacheRows(storage, rows) {
    events.push(['hydrate', Array.from(rows, x => x.id)])
    const ids = new Set()
    for (const r of rows) if (state.hydrates.has(r.id)) { files.add(r.outputPath); ids.add(r.id) }
    return ids
  } }
  const prefetchRuntime = { beginPreviewCachePrefetchGeneration(reason) { events.push(['generation', reason]) }, schedulePreviewCachePrefetch(storage, rows) { events.push(['prefetch', Array.from(rows, x => x.id)]) } }
  const db = { prepare(sql) { return { all(...keys) { events.push(['select', keys.length]); return keys.flatMap(k => rowsByKey.has(k) ? [rowsByKey.get(k)] : []) }, run(_now, _updated, ...keys) { events.push(['touch', keys.map(k => byId.get(k))]) } } } }
  const runtime = load(base + 'previewBatchReadRuntime.ts', { '../../../shared/previewFailure': load('src/shared/previewFailure.ts'), './previewInputPolicy': input, './previewCachedImageReadBatchRuntime': imageRead }, transform).createPreviewBatchReadRuntime(options, {
    ...io, buildPreviewCacheGroups, rootAvailability, hydrationRuntime, prefetchRuntime,
    loadLibraryShellCached: async () => ({ folders: [rootPath] }),
    withPreviewIndexDb: async (storage, fn) => { events.push(['db', storage.storage]); return fn(db) }
  })
  function prepare(items, statuses = {}, absent = []) {
    const groups = buildPreviewCacheGroups(items, { folders: [rootPath] }, 'test', 34, 520, 150)
    for (const g of groups.values()) for (const row of g.rows) {
      byId.set(row.previewKey, row.id)
      if (statuses[row.id] !== null) rowsByKey.set(row.previewKey, { preview_key: row.previewKey, output_path: row.outputPath, status: statuses[row.id] || 'ok' })
      if (!absent.includes(row.id)) files.add(row.outputPath)
    }
    return groups
  }
  return { runtime, options, state, events, prepare, buildPreviewCacheGroups, files, rowsByKey, byId, selectStorage }
}
const font = id => ({ id, path: path.resolve(`font-${id}.ttf`), fileSize: 20, modifiedAt: 40 })
async function policies(transform) {
  const h = harness({ transform }), items = ['ok', 'missing', 'failed', 'nofile', 'hydrate'].map(font)
  items.push({ ...font('nostat'), fileSize: 0 }, { id: 'invalid' }, null)
  h.prepare(items, { missing: 'missing', failed: 'failed', hydrate: null }, ['missing', 'failed', 'nofile', 'hydrate'])
  h.state.hydrates.add('hydrate')
  const status = await h.runtime.getPreviewCacheStatus(items, 'test')
  assert.deepEqual(plain(status), { invalid: false, ok: true, missing: false, failed: false, nofile: false, hydrate: false })
  assert.equal(h.state.reads.length, 2)
  assert.deepEqual(h.events.filter(x => x[0] === 'prefetch'), [['prefetch', ['missing', 'failed', 'nofile', 'hydrate']]])
  h.events.length = 0
  const images = await h.runtime.readCachedPreviewImages(items, 'test')
  assert.deepEqual(Object.keys(images).sort(), ['hydrate', 'ok'])
  for (const [key, id] of h.byId) if (['missing', 'failed'].includes(id)) assert(!h.state.reads.includes(h.rowsByKey.get(key).output_path), 'non-ok index must not read PNG')
  assert.deepEqual(h.events.filter(x => x[0] === 'hydrate'), [['hydrate', ['missing', 'failed', 'nofile', 'hydrate']]])
  assert.deepEqual(h.events.at(-1), ['touch', ['ok', 'hydrate']])
  assert(h.events.findIndex(x => x[0] === 'hydrate') < h.events.findIndex(x => x[0] === 'touch'))
  assert(h.events.some(x => x[0] === 'render' && x[1] === 3))
  assert(!h.events.some(x => x[0] === 'generation'))
  const active = { ...font('active'), fileSize: 0, modifiedAt: 0, active: true, family: 'Family', familyName: 'Family' }
  assert.equal([...h.buildPreviewCacheGroups([active], { folders: [] }, 'test', 34, 520, 150).values()].flatMap(x => x.rows).length, 1)
}
async function chunks(transform) {
  const h = harness({ transform, shared: false }), items = Array.from({ length: 801 }, (_, i) => font(String(i)))
  h.prepare(items)
  assert.equal(Object.keys(await h.runtime.getPreviewCacheStatus(items, 'test')).length, 801)
  assert.deepEqual(h.events.filter(x => x[0] === 'select').map(x => x[1]), [400, 400, 1])
  h.events.length = 0
  assert.equal(Object.keys(await h.runtime.readCachedPreviewImages(items, 'test')).length, 801)
  assert.deepEqual(h.events.filter(x => x[0] === 'select').map(x => x[1]), [400, 400, 1])
  assert(h.state.maxActive <= 6 && h.state.maxActive > 1)
}
async function compatibility() {
  // Injected internal root route only: no new production route is introduced.
  const h = harness({ rootStorage: true }), items = [font('x')]; h.prepare(items)
  h.options.runRustPreviewCacheBatch = async args => { h.state.rustCalls.push(plain(args)); return { rows: args.rows.map(r => ({ ...r, status: 'ok', matched: true })) } }
  assert.equal((await h.runtime.getPreviewCacheStatus(items, 'test')).x, true)
  assert((await h.runtime.readCachedPreviewImages(items, 'test')).x)
  assert.deepEqual(h.state.rustCalls.map(x => x.acceptedStatuses), [['ok'], ['ok']])
  assert.deepEqual(h.state.rustCalls.map(x => x.checkFiles), [false, true])
  h.options.runRustPreviewCacheBatch = async () => null
  h.options.runRustPreviewCacheQuery = async args => { h.state.rustCalls.push(plain(args)); return { rows: args.rows.map(r => ({ ...r, status: 'ok', matched: true })) } }
  h.options.runRustPreviewCacheTouch = async args => { h.events.push(['rust-touch', args.keys.length]); return {} }
  await h.runtime.readCachedPreviewImages(items, 'test'); assert.deepEqual(h.events.at(-1), ['rust-touch', 1])
  h.options.runRustPreviewCacheQuery = async () => null
  await h.runtime.readCachedPreviewImages(items, 'test'); assert(h.events.some(x => x[0] === 'db'))
  h.options.runRustPreviewCacheBatch = async () => { throw Error('root failed') }
  assert.equal((await h.runtime.getPreviewCacheStatus(items, 'test')).x, false)
  assert.deepEqual(plain(await h.runtime.readCachedPreviewImages(items, 'test')), {})
  h.state.available = false; assert.equal((await h.runtime.getPreviewCacheStatus(items, 'test')).x, false)
}
async function prefetchCancellation() {
  const oldEnv = process.env.HFM_PREVIEW_BACKGROUND_PREFETCH, oldDelay = process.env.HFM_PREVIEW_PREFETCH_IDLE_DELAY_MS
  process.env.HFM_PREVIEW_BACKGROUND_PREFETCH = '1'; process.env.HFM_PREVIEW_PREFETCH_IDLE_DELAY_MS = '500'
  let done, timer; const completion = new Promise(resolve => { done = resolve }), calls = []
  try {
    const runtime = load(base + 'previewCachePrefetchRuntime.ts', { './previewTaskGenerationRuntime': load(base + 'previewTaskGenerationRuntime.ts') }).createPreviewCachePrefetchRuntime({ appendStartupLog() {}, async hydratePreviewCacheRows(_storage, rows) { calls.push(...rows.map(x => x.id)); done(); return new Set(rows.map(x => x.id)) } })
    const storage = { storage: 'local', dir: '/local', shared: { rootPath: '/root' } }
    runtime.schedulePreviewCachePrefetch(storage, [{ id: 'old', previewKey: 'old', outputPath: '/old' }])
    runtime.beginPreviewCachePrefetchGeneration('new-query')
    runtime.schedulePreviewCachePrefetch(storage, [{ id: 'new', previewKey: 'new', outputPath: '/new' }])
    await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('prefetch timeout')), 2000) })])
    assert.deepEqual(calls, ['new'])
  } finally {
    clearTimeout(timer)
    if (oldEnv === undefined) delete process.env.HFM_PREVIEW_BACKGROUND_PREFETCH; else process.env.HFM_PREVIEW_BACKGROUND_PREFETCH = oldEnv
    if (oldDelay === undefined) delete process.env.HFM_PREVIEW_PREFETCH_IDLE_DELAY_MS; else process.env.HFM_PREVIEW_PREFETCH_IDLE_DELAY_MS = oldDelay
  }
}
async function main() {
  structure(); await policies(); await chunks(); await compatibility(); await prefetchCancellation()
  await assert.rejects(() => policies(s => s.replace('status === "ok";', 'status === "ok" || status === "missing" || status === "failed";')), assert.AssertionError)
  await assert.rejects(() => policies(s => s.replace('status === "ok" &&', '(status === "ok" || status === "missing") &&')), assert.AssertionError)
  await assert.rejects(() => chunks(s => s.replaceAll('const chunkSize = 400;', 'const chunkSize = 800;')), assert.AssertionError)
  console.log('[diagnostics:preview-batch-read] row/IO/query-tail locks, invalid/stat/active semantics, statuses vs PNG, hydration/touch,801 rows/400 chunks/6 reads, actual prefetch cancellation, injected root compatibility;3 mutants')
}
module.exports = { tailBodies }
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1 })
