#!/usr/bin/env node
const assert = require('node:assert/strict')
const { load } = require('./check-decomposition-baseline.cjs')
const file = 'src/main/preview/runtime/previewCacheStorageRuntime.ts'
const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function harness(mode, transform = x => x) {
  const state = { value: 'missing', path: '/old.png', opens: 0, closes: 0, fail: false, hold: null, readHold: null, presenceFail: false }
  const mocks = {}
  const factories = { previewCacheRootAvailabilityRuntime: 'createPreviewCacheRootAvailabilityRuntime', previewCacheTierRuntime: 'createPreviewCacheTierRuntime', previewCacheSharedPresenceRuntime: 'createPreviewCacheSharedPresenceRuntime', previewCachePresenceIndexRuntime: 'createPreviewCacheSharedPresenceIndexRuntime', previewCacheMetaRuntime: 'createPreviewCacheMetaRuntime', previewCacheHydrationRuntime: 'createPreviewCacheHydrationRuntime', previewCachePrefetchRuntime: 'createPreviewCachePrefetchRuntime', previewLocalCacheEvictionRuntime: 'createPreviewLocalCacheEvictionRuntime' }
  const services = { ensureRootPreviewCacheAvailable: async () => true, markRootPreviewCacheUnavailable() {}, rememberSharedPresence() {}, forgetSharedPresence() {}, async rememberSharedPresenceIndex() { if (state.presenceFail) throw Error('presence') }, async forgetSharedPresenceIndex() { if (state.presenceFail) throw Error('presence') }, schedulePreviewLocalCacheEviction() {} }
  for (const [f, factory] of Object.entries(factories)) mocks[`./${f}`] = { [factory]: () => services }
  for (const id of ['./previewInputPolicy', '../../path/fontPathPolicy', './previewCacheKeyRuntime', './previewCachedImageReadBatchRuntime', './previewInstalledFontRouteRuntime']) mocks[id] = {}
  const deadline = load('src/main/path/ioDeadlineRuntime.ts')
  mocks['../../path/ioDeadlineRuntime'] = { ...deadline, previewCacheQueryTimeoutMs: () => 100 }
  async function waitOpen() { const hold = state.hold; state.hold = null; if (hold) await hold.promise }
  mocks['node:fs'] = { promises: { mkdir: waitOpen } }
  function db() {
    state.opens++
    return { prepare(sql) { return { get: () => state.value == null ? undefined : ({ output_path: state.path, status: state.value }), run() { if (sql.startsWith('DELETE')) { if (state.fail) throw Error('write'); state.value = null } } } } }
  }
  const options = { openPreviewDb: async () => { await waitOpen(); return db() }, openStableSqliteDb: db, initializePreviewDb() {}, closeSqliteDb() { state.closes++ }, normalizePathForCacheCompare: x => x, normalizePreviewCacheIndexStatus: x => x || null, appendStartupLog() {}, upsertPreviewCacheRows(_db, rows) { if (state.fail) throw Error('write'); state.value = rows[0].status; state.path = rows[0].output_path } }
  if (mode === 'rust') {
    options.runRustPreviewCacheReadStatus = async ({ outputPath }) => {
      const value = { status: outputPath === state.path ? state.value : null }
      const hold = state.readHold; state.readHold = null
      if (hold) await hold.promise
      return value
    }
    options.runRustPreviewCacheApply = async ({ rows }) => { await waitOpen(); options.upsertPreviewCacheRows(null, rows); return true }
    options.runRustPreviewCacheDelete = async () => { await waitOpen(); if (state.fail) throw Error('delete'); state.value = null; return true }
  }
  const runtime = load(file, mocks, transform).createPreviewCacheStorageRuntime(options)
  const storage = mode === 'local' ? { storage: 'local', dir: '/', identity: 'a' } : { storage: 'root', rootPath: '/root', indexDbPath: '/root/index.db', dir: '/', identity: 'a' }
  return { state, options, read: (path = '/old.png') => runtime.readPreviewCacheIndexStatus(storage, 'key', path), write: (path = '/old.png') => runtime.writePreviewCacheIndex(storage, 'key', { outputPath: path, status: 'ok' }), remove: () => runtime.deletePreviewCacheIndex(storage, 'key') }
}
async function commitCases(transform) {
  for (const mode of ['local', 'node-root', 'rust']) for (const kind of ['write', 'remove']) {
    const h = harness(mode, transform)
    assert.equal(await h.read(), 'missing')
    const pending = gate(); h.state.hold = pending
    const operation = h[kind](); await tick()
    assert.equal(await h.read(), 'missing', `${mode} during ${kind}`)
    pending.resolve(); await operation
    assert.equal(await h.read(), kind === 'write' ? 'ok' : null, `${mode} after ${kind}`)
    assert.equal(h.state.closes, mode === 'node-root' ? h.state.opens : 0)
  }
}
async function failures() {
  for (const mode of ['local', 'node-root', 'rust']) for (const kind of ['write', 'remove']) {
    const h = harness(mode); h.state.fail = true
    if (mode === 'rust') await h[kind]() // optional root I/O preserves existing failure policy
    else await assert.rejects(h[kind](), /write/)
    assert.equal(await h.read(), 'missing')
    h.state.fail = false; await h[kind]()
    assert.equal(await h.read(), kind === 'write' ? 'ok' : null)
    assert.equal(h.state.closes, mode === 'node-root' ? h.state.opens : 0)
  }
  for (const kind of ['write', 'remove']) {
    const h = harness('rust')
    h.options.runRustPreviewCacheApply = async () => null
    h.options.runRustPreviewCacheDelete = async () => null
    await h[kind]()
    assert.equal(h.state.value, kind === 'write' ? 'ok' : null, 'Rust null falls back to Node')
    assert.equal(h.state.closes, h.state.opens)
  }
  const failedOpen = harness('node-root')
  failedOpen.options.initializePreviewDb = () => { throw Error('initialize') }
  await assert.rejects(failedOpen.write(), /initialize/)
  assert.equal(failedOpen.state.opens, 1); assert.equal(failedOpen.state.closes, 1)
  failedOpen.options.initializePreviewDb = () => {}
  await failedOpen.write(); assert.equal(await failedOpen.read(), 'ok')
  assert.equal(failedOpen.state.closes, failedOpen.state.opens)
  // Presence-index failure after the actual commit must not retain pre-commit status.
  const h = harness('node-root'); await h.read(); h.state.presenceFail = true
  await assert.rejects(h.write(), /presence/); h.state.presenceFail = false
  assert.equal(await h.read(), 'ok'); assert.equal(h.state.closes, h.state.opens)
}
async function lateCases(transform) {
  for (const kind of ['write', 'remove']) for (const during of [false, true]) {
    const h = harness('rust', transform)
    const commit = gate()
    let operation
    if (during) { h.state.hold = commit; operation = h[kind](); await tick() }
    const a = gate(); h.state.readHold = a
    const old = h.read(); await tick()
    if (during) { commit.resolve(); await operation } else await h[kind]()
    const b = gate(); h.state.readHold = b
    const newer = h.read(); await tick(); b.resolve()
    const expected = kind === 'write' ? 'ok' : null
    assert.equal(await newer, expected)
    a.resolve(); assert.equal(await old, 'missing') // historical caller result allowed; never cache it
    assert.equal(await h.read(), expected)
  }
  for (const kind of ['write', 'remove']) for (const rejectLate of [false, true]) {
    const h = harness('rust', transform); const pending = gate(); h.state.hold = pending
    await h[kind]() // real 100ms deadline; underlying I/O is still pending
    assert.equal(await h.read(), 'missing')
    if (rejectLate) pending.reject(Error('late I/O failure')); else pending.resolve()
    await tick()
    assert.equal(await h.read(), rejectLate ? 'missing' : kind === 'write' ? 'ok' : null)
    await h.write(); assert.equal(await h.read(), 'ok')
  }
  const h = harness('local', transform)
  await h.write(); assert.equal(await h.read(), 'ok')
  await h.write('/new.png')
  assert.equal(await h.read(), null, 'old output path invalidated too')
  assert.equal(await h.read('/new.png'), 'ok')
}
async function main() {
  await commitCases(); await failures(); await lateCases()
  await assert.rejects(() => commitCases(s => s.replaceAll('            forgetReadStatus(storage, previewKey);', '            // mutant: omitted worker settlement invalidation')), assert.AssertionError)
  await assert.rejects(() => commitCases(s => s.replaceAll('        forgetReadStatus(storage, previewKey);', '        // mutant: omitted local commit invalidation')), assert.AssertionError)
  await assert.rejects(() => lateCases(s => s.replace('if (readStatusGeneration.get(statusCacheKey) !== taskGeneration)', 'if (false)')), assert.AssertionError)
  console.log('[diagnostics:preview-index-commit] local/root Node/Rust write/delete, before/during/after, reversed reads, late timeout success/rejection, retry, path change, close counts; three mutants rejected')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
