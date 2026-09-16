#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { bodies } = require('./check-preview-storage-routing.cjs')
const { harness } = require('./check-preview-index-commit.cjs')
const root = path.resolve(__dirname, '../..')
const indexFile = 'src/main/preview/runtime/previewIndexAccessRuntime.ts'
const facadeFile = 'src/main/preview/runtime/previewCacheStorageRuntime.ts'
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function structure() {
  const fixture = JSON.parse(read('build/diagnostics/fixtures/preview-index-owner.fixture.json'))
  const facade = read(facadeFile)
  for (const crlf of [false, true]) {
    const owner = crlf ? read(indexFile).replace(/\r?\n/g, '\r\n') : read(indexFile)
    const current = bodies(owner)
    for (const [name, hash] of Object.entries(fixture.movedBodies)) {
      assert.equal(current[name], hash, `single-item body drift: ${name}`)
      assert.equal(bodies(facade)[name], undefined, `duplicated owner: ${name}`)
    }
    for (const [name, hash] of Object.entries(fixture.batchBodiesAfterScope)) assert.equal(bodies(read('src/main/preview/runtime/previewBatchReadRuntime.ts'))[name], hash, `batch change exceeds DB scope wrapping: ${name}`)
  }
  for (const token of ['readStatusCache', 'readStatusInFlight', 'readStatusGeneration', 'openPreviewIndexDb', 'options.closeSqliteDb']) assert(!facade.includes(token), token)
  assert.equal((facade.match(/= createPreviewIndexAccessRuntime\(/g) || []).length, 1)
  const hydration = facade.slice(facade.indexOf('const hydrationRuntime'), facade.indexOf('const prefetchRuntime'))
  assert(hydration.includes('readPreviewCacheIndexStatus') && hydration.includes('writePreviewCacheIndex'))
  assert(!hydration.includes('withPreviewIndexDb'))
}
async function cacheCases(transform) {
  const h = harness('local', transform)
  assert.deepEqual(Object.keys(h.indexRuntime).sort(), ['deletePreviewCacheIndex', 'readPreviewCacheIndexStatus', 'withPreviewIndexDb', 'writePreviewCacheIndex'])
  for (let i = 0; i < 513; i++) await h.read('/old.png', `key${i}`)
  const opens = h.state.opens
  await h.read('/old.png', 'key512'); assert.equal(h.state.opens, opens)
  await h.read('/old.png', 'key0'); assert.equal(h.state.opens, opens + 1, '512-entry bound must evict oldest')
  const shared = harness('local', transform), pending = gate(); shared.state.hold = pending
  const a = shared.read(), b = shared.read(); pending.resolve()
  assert.deepEqual(await Promise.all([a, b]), ['missing', 'missing'])
  assert.equal(shared.state.opens, 1, 'in-flight read must coalesce')
  const failed = harness('local', transform), open = failed.options.openPreviewDb
  failed.options.openPreviewDb = async () => { throw Error('open failed') }
  await assert.rejects(failed.read(), /open failed/)
  failed.options.openPreviewDb = open
  assert.equal(await failed.read(), 'missing', 'rejected in-flight task must be cleared')
}
async function dbScopes(transform) {
  for (const mode of ['local', 'node-root']) {
    const h = harness(mode, transform), pending = gate()
    const scoped = h.indexRuntime.withPreviewIndexDb(h.storage, async db => { assert.equal(typeof db.prepare, 'function'); await pending.promise; return 42 })
    await tick(); assert.equal(h.state.closes, 0)
    pending.resolve(); assert.equal(await scoped, 42)
    assert.equal(h.state.closes, mode === 'local' ? 0 : 1)
    await assert.rejects(h.indexRuntime.withPreviewIndexDb(h.storage, async () => { throw Error('query failed') }), /query failed/)
    assert.equal(h.state.closes, mode === 'local' ? 0 : 2)
    h.options.initializePreviewDb = () => { throw Error('init failed') }
    if (mode !== 'local') {
      await assert.rejects(h.indexRuntime.withPreviewIndexDb(h.storage, async () => assert.fail('must not run')), /init failed/)
      assert.equal(h.state.closes, 3)
    }
  }
}
async function backendsAndEviction() {
  const absent = harness('rust'); absent.options.runRustPreviewCacheReadStatus = async () => null
  assert.equal(await absent.read(), 'missing'); assert.equal(absent.state.opens, 1); assert.equal(absent.state.closes, 1)
  for (const mode of ['throw', 'timeout']) {
    const h = harness('rust'), pending = gate()
    h.options.runRustPreviewCacheReadStatus = mode === 'throw' ? async () => { throw Error('worker') } : () => pending.promise
    assert.equal(await h.read(), null); assert.equal(h.state.opens, 0, 'failed/timed-out root query must not fall back')
    if (mode === 'timeout') { pending.reject(Error('late')); await tick() }
    await h.write()
    h.options.runRustPreviewCacheReadStatus = async () => ({ status: 'ok' })
    assert.equal(await h.read(), 'ok')
  }
  for (const mode of ['local', 'node-root', 'rust']) {
    const h = harness(mode)
    await h.write(); assert.equal(h.state.evictions, mode === 'local' ? 1 : 0)
    await h.indexRuntime.writePreviewCacheIndex(h.storage, 'key', { outputPath: '/old.png', status: 'failed' })
    await h.remove(); assert.equal(h.state.evictions, mode === 'local' ? 1 : 0)
  }
}
async function main() {
  structure(); await cacheCases(); await dbScopes(); await backendsAndEviction()
  await assert.rejects(() => cacheCases(s => s.replace('while (readStatusCache.size > 512)', 'while (false)')), assert.AssertionError)
  await assert.rejects(() => dbScopes(s => s.replaceAll('if (close) options.closeSqliteDb(db);', 'options.closeSqliteDb(db);')), assert.AssertionError)
  await assert.rejects(() => dbScopes(s => s.replace('return await operation(db);', 'return operation(db);')), assert.AssertionError)
  console.log('[diagnostics:preview-index-owner] exact single-item migration LF/CRLF, batch-only scope rewrite, private Maps/public commands, capacity/coalescing/retry, scoped close, Rust null/failure/timeout, eviction timing; three mutants rejected')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
