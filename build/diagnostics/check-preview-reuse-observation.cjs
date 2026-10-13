#!/usr/bin/env node
// Production preview memory, source validation, native ownership and physical
// cleanup. Only filesystem/storage/native-renderer/application ports are fake.
const assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto')
const { loader } = require('./check-operation-chain.cjs')
const png = require('./fixtures/preview-png.cjs')
const root = path.resolve(__dirname, '../..'), abs = file => path.join(root, file)
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function bounded(pending, label) {
  let timer
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 5000) })]) }
  finally { clearTimeout(timer) }
}
const secret = 'PRIVATE_PREVIEW_SENTINEL'
const font = { id: secret + '-id', path: 'C:/private/' + secret + '.ttf', fileSize: 100, modifiedAt: 1, family: secret + '-family' }
const text = secret + '-text'

function fixture() {
  const state = { now: 1000, logs: [], native: [], stats: 0, publications: 0, writes: 0, hashes: 0 }
  const closingListeners = new Set(); let closing = false, epoch = 1
  class Clock extends Date { static now() { return state.now } }
  const fakefs = {
    stat: async () => { state.stats++; if (state.sourceError) throw state.sourceError; return { size: 100, mtimeMs: 1 } },
    access: async () => {}, mkdir: async () => {}, writeFile: async () => { state.writes++ },
    readFile: async () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }) },
    unlink: async file => { await state.cleanup?.(file) },
  }
  const storage = {
    previewCacheStorageForFont: async () => ({ identity: 'verified-file', dir: 'C:/private/cache', storage: 'local' }),
    readPreviewCacheIndexStatus: async () => null, deletePreviewCacheIndex: async () => {},
    writePreviewCacheIndex: async () => { state.writes++ },
  }
  const load = loader({
    'node:crypto': { ...crypto, createHash: (...args) => { state.hashes++; return crypto.createHash(...args) } },
    [abs('src/main/path/sharedFileSystemRuntime.ts')]: { sharedFileSystem: fakefs, withSharedPreviewReads: run => run(), currentSharedIoSignal: () => undefined, withSharedIoSignal: (_signal, run) => run(), withoutSharedIoSignal: run => run() },
    [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: { sharedIoResourceKeys: async () => [], sharedIoAvailabilityRoot: () => 'C:' },
    [abs('src/main/app/shutdownCoordinatorRuntime.ts')]: { applicationWorkEpoch: () => epoch, isApplicationClosing: () => closing, onApplicationClosing: listener => { closingListeners.add(listener); return () => closingListeners.delete(listener) } },
    '../native-renderer/directwrite/directWritePreviewHelperPathRuntime': { hasDirectWritePreviewHelper: () => false },
    './runtime/previewCacheStorageRuntime': { createPreviewCacheStorageRuntime: () => storage },
    './runtime/previewCachePublishRuntime': { createPreviewCachePublishRuntime: () => ({ enqueuePreviewCachePublish: () => { state.publications++ } }) },
    './native-renderer/previewNativeRendererRuntime': { createPreviewNativeRenderer: () => ({ activeEngineLabel: () => 'test', renderNativePreview: async request => {
      state.native.push(request); if (state.render) return state.render(request)
      return { ok: true, engine: 'test', bytes: png, transient: true, outputPath: request.outputPath }
    } }) },
  }, { Date: Clock })
  const options = {
    ensureWindows() {}, appendStartupLog: line => { state.logs.push({ at: state.now, line }); if (state.throwLog) throw Error(secret + '-logger') },
    sha1: value => crypto.createHash('sha1').update(value).digest('hex'), resolveExistingFontFilePath: async file => file,
    withGlobalIo: (_label, run) => state.queueError ? Promise.reject(state.queueError) : run(), previewTaskKey: key => key,
  }
  for (const name of ['completeBackgroundTask', 'upsertBackgroundTask', 'startBackgroundTask', 'heartbeatBackgroundTask', 'failBackgroundTask']) options[name] = async () => { state.writes++ }
  const create = () => load('src/main/preview/previewRuntime.ts').createPreviewRuntime(options)
  const events = () => state.logs.filter(row => row.line.startsWith('preview reuse: ')).map(row => ({ ...JSON.parse(row.line.slice('preview reuse: '.length)), at: row.at }))
  return { state, runtime: create(), create, events, close: () => {
    assert(closingListeners.size > 0, 'preview owner did not subscribe to application closing')
    closing = true; epoch++; for (const listener of closingListeners) listener()
  } }
}
const render = (runtime, item = font, input = text) => runtime.renderFontPreviewImage(item, input, 44, 720, 260)
const requestEvents = h => h.events().filter(row => row.event === 'request')

async function main() {
  {
    const h = fixture(), first = await render(h.runtime)
    assert(first.startsWith('data:image/png;base64,')); assert.equal(await render(h.runtime), first)
    await render(h.runtime, { ...font, recoveryContentHash: 'a'.repeat(64), localTagNames: ['private-tag'] })
    assert.equal(h.state.native.length, 1, 'Repeated/enriched identical main key rerendered')
    assert.deepEqual(requestEvents(h).map(row => row.decision), ['new-work', 'memory-hit', 'memory-hit'])
    assert.equal(requestEvents(h)[0].requestKey, requestEvents(h)[2].requestKey)
    assert.notEqual(requestEvents(h)[0].recoveryKey, requestEvents(h)[2].recoveryKey)
    assert.equal(h.events().filter(row => row.event === 'memory-stored').length, 1)
    assert.equal(h.state.writes, 0); assert.equal(h.state.publications, 0)
  }
  {
    const h = fixture(), entered = gate(), release = gate(); let held = false
    h.state.cleanup = async file => { if (!held && file.includes('.display.')) { held = true; entered.resolve(); await release.promise } }
    const first = render(h.runtime); await entered.promise
    assert.equal(h.events().filter(row => row.event === 'memory-stored' || row.event === 'settled').length, 0, 'Native completion was mistaken for full cleanup')
    const second = render(h.runtime); await tick()
    const requests = requestEvents(h); assert.equal(requests[1].decision, 'inflight-join')
    assert.equal(requests[1].joinedRequest, requests[0].request); assert.equal(h.state.native.length, 1)
    release.resolve(); assert.equal(await first, await second)
    const stored = h.events().findIndex(row => row.event === 'memory-stored'), settled = h.events().findIndex(row => row.event === 'settled')
    assert(stored >= 0 && settled > stored); assert.equal(h.events()[settled].retired, true)
    await render(h.runtime); assert.equal(h.state.native.length, 1)
  }
  {
    const h = fixture(); await render(h.runtime)
    await render(h.runtime, { ...font, previewError: '字体文件不存在或路径已失效。' })
    assert.equal(h.state.native.length, 2, 'Observation erased authoritative legacy revalidation')
    const request = requestEvents(h)[1]; assert.equal(request.decision, 'legacy-bypass'); assert.equal(request.memory, true)
    h.state.sourceError = Object.assign(Error(secret + '-source'), { code: 'ENOENT' })
    await assert.rejects(render(h.runtime, { ...font, previewError: '字体文件不存在或路径已失效。' }), /HFM_PREVIEW:missing/)
    assert.equal(h.state.native.length, 2)
    assert.equal(h.events().at(-1).failure, 'missing'); assert.equal(h.events().at(-1).outcome, 'rejected')
    assert.equal(h.events().filter(row => row.event === 'memory-stored').length, 2)
  }
  {
    const h = fixture(), entered = gate(), release = gate(); let held = false
    h.state.cleanup = async file => { if (!held && file.includes('.display.')) { held = true; entered.resolve(); await release.promise } }
    const first = render(h.runtime); await entered.promise
    const second = render(h.runtime, { ...font, id: secret + '-joined-alternate-id' }); await tick()
    const requests = requestEvents(h), joined = h.events().find(row => row.event === 'native-join')
    assert.notEqual(requests[0].requestKey, requests[1].requestKey)
    assert(joined, 'Different main keys failed to report their actual shared native owner')
    assert.equal(joined.joinedRequest, requests[0].request); assert.equal(joined.joinedOwner, requests[0].owner)
    assert.equal(h.state.native.length, 1); release.resolve(); assert.equal(await first, await second)
    assert.equal(h.events().filter(row => row.event === 'settled' && row.outcome === 'fulfilled').length, 2)
  }
  {
    const h = fixture(); await render(h.runtime)
    await render(h.runtime, { ...font, id: secret + '-alternate-id' })
    await render(h.runtime, { ...font, path: font.path.toLowerCase() })
    await render(h.runtime, { ...font, modifiedAt: 2 })
    const native = h.events().filter(row => row.event === 'native-start'), requests = requestEvents(h)
    assert.equal(h.state.native.length, 4); assert.equal(new Set(native.map(row => row.nativeKey)).size, 1)
    assert.equal(new Set(requests.map(row => row.requestKey)).size, 4)
    assert.notEqual(requests[0].idKey, requests[1].idKey); assert.notEqual(requests[0].pathKey, requests[2].pathKey)
    assert.equal(requests[0].foldedPathKey, requests[2].foldedPathKey); assert.notEqual(requests[0].stampKey, requests[3].stampKey)
    const another = h.create(); await render(another)
    const final = requestEvents(h).at(-1); assert.notEqual(final.owner, requests[0].owner); assert.equal(final.requestKey, requests[0].requestKey)
    await render(h.runtime, font, text + '-different-layout-input')
    assert.notEqual(requestEvents(h).at(-1).layoutKey, requests[0].layoutKey)
    assert.notEqual(h.events().filter(row => row.event === 'native-start').at(-1).nativeKey, native[0].nativeKey)
  }
  {
    const h = fixture(), entered = gate(), closed = gate()
    h.state.render = async () => { entered.resolve(); throw Object.assign(Error(secret + '-cancelled'), { sharedIo: true, reason: 'cancelled', closed: closed.promise }) }
    const pending = render(h.runtime).then(() => assert.fail('Cancelled render returned'), error => error)
    await entered.promise; await tick()
    assert.equal(h.events().filter(row => row.event === 'memory-stored' || row.event === 'settled').length, 0)
    h.close()
    closed.resolve(); assert.match((await pending).message, /HFM_PREVIEW:cancelled/)
    assert.equal(h.events().at(-1).failure, 'cancelled'); assert.equal(h.events().at(-1).retired, true)
    assert.equal(h.events().filter(row => row.event === 'memory-stored').length, 0)
    assert.equal(h.state.writes, 0); assert.equal(h.state.publications, 0)
    const encoded = h.events().map(row => JSON.stringify(row)).join('\n')
    assert(!encoded.includes(secret)); assert(!encoded.includes('data:image')); assert(!encoded.includes(font.path))
  }
  {
    const h = fixture(); h.state.throwLog = true
    assert((await render(h.runtime)).startsWith('data:image/png;base64,'), 'Observer logger changed successful outcome')
    assert.equal(h.events().at(-1).outcome, 'fulfilled')
  }
  {
    const h = fixture(), first = await render(h.runtime)
    const hostile = { ...font }
    Object.defineProperty(hostile, 'recoveryContentHash', { get() { throw Error(secret + '-metadata-getter') } })
    assert.equal(await render(h.runtime, hostile), first, 'Observation-only getter broke a memory hit')
    assert.equal(h.state.native.length, 1)
    assert((await render(h.runtime, { ...font, id: secret + '-new', recoveryContentHash: { toJSON() { throw Error(secret + '-serialize') } } })).startsWith('data:image/png;base64,'))
    assert.equal(h.state.native.length, 2, 'Observation serialization retried or suppressed the operation')
    const closed = gate(), cancellation = Object.assign(Error(), { sharedIo: true, reason: 'cancelled', closed: closed.promise })
    Object.defineProperty(cancellation, 'message', { get() { throw Error(secret + '-classification') } })
    h.state.queueError = cancellation
    let settled = false
    const pending = render(h.runtime, { ...font, id: secret + '-cancelled-owner' }).then(() => { settled = true; assert.fail('Cancelled queue returned') }, error => { settled = true; return error })
    await tick(); assert.equal(settled, false, 'Queued failure dropped its physical-close owner')
    closed.resolve()
    const actual = await bounded(pending, 'Queued physical-close receipt did not retire')
    assert.equal(actual, cancellation); assert.equal(actual.closed, closed.promise, 'Observation replaced physical-close ownership')
    assert.equal(h.state.native.length, 2); assert.equal(h.events().at(-1).outcome, 'rejected')
  }
  {
    const h = fixture(), first = await render(h.runtime); let reads = 0
    const observed = { ...font }
    Object.defineProperty(observed, 'recoveryContentHash', { get() { reads++; return 'a'.repeat(64) } })
    assert.equal(await render(h.runtime, observed), first)
    assert(reads > 0 && h.state.hashes > 0, 'Observation counters did not observe the production admission')
    while (h.events().length < 255) await render(h.runtime)
    const hashes = h.state.hashes, beforeReads = reads
    assert.equal(await render(h.runtime, observed), first)
    assert.equal(h.events().at(-1).event, 'observation-cap')
    assert.equal(h.state.hashes, hashes, 'Cap marker performed unused fingerprints')
    assert.equal(reads, beforeReads, 'Cap marker read observation-only metadata')
    for (let request = 0; request < 12; request++) assert.equal(await render(h.runtime, observed), first)
    assert.equal(h.events().length, 256); assert.equal(h.state.hashes, hashes, 'Window-suppressed admission still hashed')
    assert.equal(reads, beforeReads, 'Window-suppressed memory hit read observation-only metadata')
    h.state.now += 60000
    assert.equal(await render(h.runtime, observed), first)
    assert.equal(h.events().at(-1).decision, 'memory-hit'); assert.equal(h.events().at(-1).suppressed, 13)
    assert(reads > beforeReads && h.state.hashes > hashes, 'Observation did not resume in the next window')
    assert.equal(h.state.native.length, 1, 'Observation budget changed positive-memory reuse')
  }
  {
    const h = fixture(), another = h.create(); await render(h.runtime); await render(another)
    for (let window = 0; window < 9; window++) {
      h.state.now = 1000 + window * 60000
      for (let request = 0; request < 300; request++) await render(request % 2 ? another : h.runtime)
    }
    const events = h.events()
    assert.equal(events.length, 2048, 'Process-session log cap changed')
    for (const at of new Set(events.map(row => row.at))) assert(events.filter(row => row.at === at).length <= 256)
    assert.equal(events.at(-1).event, 'observation-cap'); assert.equal(events.at(-1).scope, 'session')
    for (const row of events) for (const value of Object.values(row)) if (typeof value === 'number') assert(Number.isFinite(value))
    assert.equal(new Set(events.filter(row => row.owner).map(row => row.owner)).size, 2)
    assert.equal(new Set(events.map(row => row.session)).size, 1)
    assert.equal(h.state.native.length, 2, 'Shared observation cap changed settled reuse across owners')
    let reads = 0; const hashes = h.state.hashes, observed = { ...font }
    Object.defineProperty(observed, 'recoveryContentHash', { get() { reads++; return 'b'.repeat(64) } })
    h.state.now += 60000
    for (const runtime of [h.runtime, another]) assert((await render(runtime, observed)).startsWith('data:image/png;base64,'))
    assert.equal(reads, 0, 'Session-suppressed admission read optional metadata after a window reset')
    assert.equal(h.state.hashes, hashes, 'Session-suppressed admission still hashed across owners')
    assert.equal(h.events().length, 2048); assert.equal(h.state.native.length, 2)
    const lines = h.state.logs.filter(row => row.line.startsWith('preview reuse: ')).map(row => row.line)
    assert(lines.every(line => !line.includes(secret) && !line.includes(font.path) && !line.includes(text) && !line.includes('data:image')))
  }
  console.log('[diagnostics:preview-reuse-observation] production settled/overlapping transient reuse, cleanup, legacy/source/key/owner distinctions, cancellation, redaction and finite log caps passed')
}
// This referenced guard covers all controlled waits, including readiness gates.
const watchdog = setTimeout(() => { console.error('Preview reuse diagnostic did not settle within 120s'); process.exit(1) }, 120000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(watchdog))
