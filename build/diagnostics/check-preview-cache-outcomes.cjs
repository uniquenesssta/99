#!/usr/bin/env node
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { loader } = require('./check-operation-chain.cjs')
const base = 'src/main/preview/runtime/'
const png = require('./fixtures/preview-png.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve: value => resolve(value) } }
async function main() {
  const load = loader(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-outcomes-'))
  const logs = [], marks = [], shared = { storage: 'root', rootPath: dir, dir }, local = { storage: 'local', dir, shared }
  const errors = { cancelled: Object.assign(Error('cancel'), { name: 'AbortError' }), timeout: Object.assign(Error('timeout'), { name: 'IoDeadlineTimeoutError' }),
    unavailable: Object.assign(Error('denied'), { code: 'EACCES' }), miss: Object.assign(Error('absent'), { code: 'ENOENT' }), error: Error('real failure') }
  const io = load(base + 'previewStorageIoRuntime.ts').createPreviewStorageIoRuntime({ appendStartupLog: line => logs.push(line) }, { markRootPreviewCacheUnavailable: (_root, error) => marks.push(error) })
  try {
    for (const [outcome, error] of Object.entries(errors)) {
      const result = await io.runStoragePreviewCacheIo(shared, 'outcome-test', async () => { throw error })
      assert.equal(result.ok, false); assert.equal(result.error, error, 'IO lost the original classification')
      assert.equal(marks.includes(error), !['cancelled', 'miss'].includes(outcome), 'cancellation poisoned availability')
      assert(logs.some(line => line.startsWith('preview cache io ' + outcome + ':')))
    }
    let status = 'ok', fail, available = true, calls = 0, hold
    const options = { appendStartupLog: line => logs.push(line), withIoDeadlineResult: load('src/main/path/ioDeadlineRuntime.ts').withIoDeadlineResult,
      previewCacheStorageToShared: () => shared, ensureSharedAvailable: async () => available,
      readPreviewCacheIndexStatus: async () => { calls++; if (hold) await hold.promise; if (fail) throw fail; return status }, writePreviewCacheIndex: async () => {} }
    const runtime = load(base + 'previewCacheHydrationRuntime.ts').createPreviewCacheHydrationRuntime(options)
    let serial = 0
    async function run(expected, setup = () => {}, current = () => true) {
      const row = { id: 'a' + serial++, previewKey: 'key' + serial, outputPath: path.join(dir, 'local', serial + '.png') }
      fs.writeFileSync(path.join(dir, row.previewKey + '.png'), png)
      status = 'ok'; fail = undefined; available = true; setup(row)
      const results = []
      const ids = await runtime.hydratePreviewCacheRows(local, [row], current, (_row, outcome) => results.push(outcome))
      assert.deepEqual(results, [expected]); assert.equal(ids.has(row.id), expected === 'hydrated')
      return row
    }
    await run('hydrated')
    // A foreground render completed during the prefetch delay. A valid local
    // PNG must avoid all shared probes, even while the share is unavailable.
    const localRow = { id: 'already-local', previewKey: 'already-local', outputPath: path.join(dir, 'local', 'ready.png') }
    fs.writeFileSync(localRow.outputPath, png)
    const beforeLocal = calls
    available = false
    let sharedTouches = 0
    options.touchSharedPreviewCache = async () => { sharedTouches++ }
    const localOutcomes = []
    const ready = await runtime.hydratePreviewCacheRows(local, [localRow], () => true, (_row, outcome) => localOutcomes.push(outcome))
    assert(ready.has(localRow.id)); assert.deepEqual(localOutcomes, ['local-hit'])
    assert.equal(calls, beforeLocal); assert.equal(sharedTouches, 0)
    assert.equal(await runtime.hydratePreviewCache(local, localRow), true)
    fs.writeFileSync(localRow.outputPath, 'incomplete PNG')
    assert.equal(await runtime.hydratePreviewCache(local, localRow), false, 'invalid local image accepted')
    available = true

    await run('miss', () => { status = null })
    await run('miss', row => fs.unlinkSync(path.join(dir, row.previewKey + '.png')))
    await run('unavailable', () => { available = false })
    for (const [outcome, error] of Object.entries(errors)) await run(outcome, () => { fail = error })
    await run('error', row => fs.writeFileSync(path.join(dir, row.previewKey + '.png'), 'broken PNG'))
    await run('cancelled', () => {}, () => false)
    // Cancellation/timeout must not create a negative cache; the same key retries.
    for (const kind of ['timeout', 'cancelled']) {
      const row = await run(kind, () => { fail = errors[kind] })
      const before = calls; fail = undefined
      assert.equal(await runtime.hydratePreviewCache(local, row), true)
      assert.equal(calls, before + 1)
    }
    hold = gate(); const before = calls
    const row = { id: 'pair', previewKey: 'pair', outputPath: path.join(dir, 'local', 'pair.png') }
    fs.writeFileSync(path.join(dir, 'pair.png'), png)
    const a = runtime.hydratePreviewCache(local, row), b = runtime.hydratePreviewCacheRows(local, [row])
    for (let i=0; calls === before && i<100; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(calls, before + 1, 'same key duplicated physical hydration')
    hold.resolve(); hold = undefined; assert.equal(await a, true); assert((await b).has(row.id))
    // A metadata rejection arriving after its image lease was superseded must
    // not become checksum damage or poison the same key's negative cache.
    const staleRow = { id: 'stale-meta', previewKey: 'stale-meta', outputPath: path.join(dir, 'local', 'stale-meta.png') }
    fs.writeFileSync(path.join(dir, 'stale-meta.png'), png)
    let competing
    options.validateSharedPreviewCacheMeta = async () => {
      competing = load(base + 'previewImageCommitRuntime.ts').claimPreviewImage(staleRow.outputPath, 'render')
      return { status: 'invalid', message: 'late cancelled validation' }
    }
    const staleOutcomes = [], beforeStale = calls
    const staleIds = await runtime.hydratePreviewCacheRows(local, [staleRow], () => true, (_row, outcome) => staleOutcomes.push(outcome))
    assert.equal(staleIds.size, 0); assert.deepEqual(staleOutcomes, ['cancelled'])
    assert(!logs.some(line => line.includes('late cancelled validation')), 'obsolete metadata logged as corruption')
    await competing.release(); delete options.validateSharedPreviewCacheMeta
    assert.equal(await runtime.hydratePreviewCache(local, staleRow), true)
    assert.equal(calls, beforeStale + 2, 'obsolete metadata poisoned same-key recovery')
    console.log('PASS cache outcomes: real IO errors retained, six hydration results, timeout/cancel same-key retry, physical coalescing')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  // Confirmed ENOENT is remembered before any further shared probes. Time and
  // generations are controlled; physical PNG reads remain real filesystem IO.
  const negativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-negative-'))
  try {
    let clock = 10000, generation = 1, probes = 0, reads = 0, indexes = 0, presence = null
    const share = { storage: 'root', rootPath: negativeDir, dir: negativeDir }
    const row = { id: 'miss', previewKey: 'absent', outputPath: path.join(negativeDir, 'local', 'absent.png') }
    const negativeLoad = loader({
      '../../path/startupPathAvailabilityRuntime': { getStartupPathRootState: () => ({ generation, state: 'online' }) },
      '../../path/sharedFileSystemRuntime': { withSharedIoSignal: (_signal, fn) => fn(), sharedFileSystem: { ...fs.promises, readFile: async (...args) => { reads++; return fs.promises.readFile(...args) } } },
    }, { Date: class extends Date { static now() { return clock } } })
    const opts = { appendStartupLog() {}, withIoDeadlineResult: load('src/main/path/ioDeadlineRuntime.ts').withIoDeadlineResult,
      previewCacheStorageToShared: () => share, ensureSharedAvailable: async () => { probes++; return true },
      legacyRootPreviewCacheDir: () => negativeDir,
      readPreviewCacheIndexStatus: async () => { indexes++; return null }, writePreviewCacheIndex: async () => {},
      sharedPresence: { getSharedPresence: () => presence, forgetSharedPresence: () => { presence = null }, rememberSharedPresence: () => { presence = 'ok' } },
    }
    const create = negativeLoad(base + 'previewCacheHydrationRuntime.ts').createPreviewCacheHydrationRuntime
    const cached = create(opts), local = { storage: 'local' }
    async function readOutcome(runtime, item) {
      const outcomes = []
      const ids = await runtime.hydratePreviewCacheRows(local, [item], () => true, (reportedRow, outcome) => {
        assert.equal(reportedRow, item, 'outcome reported for another row')
        outcomes.push(outcome)
      })
      assert.equal(outcomes.length, 1, 'one row must report exactly one outcome')
      const outcome = outcomes[0], ready = outcome === 'hydrated' || outcome === 'local-hit'
      assert.equal(ids.has(item.id), ready, 'hydrated membership disagrees with outcome')
      assert.equal(ids.size, ready ? 1 : 0, 'batch returned unexpected hydrated IDs')
      return outcome
    }
    assert.equal(await readOutcome(cached, row), 'miss')
    for (let i=0; i<3; i++) assert.equal(await readOutcome(cached, row), 'miss')
    assert.deepEqual([probes, indexes, reads], [1,1,1], 'negative hit still performed shared IO')
    clock += 31000
    assert.equal(await readOutcome(cached, row), 'miss')
    assert.deepEqual([probes, indexes, reads], [2,2,2], 'confirmed miss never expired')
    generation++
    assert.equal(await readOutcome(cached, row), 'miss')
    assert.equal(reads, 3, 'old root generation suppressed a fresh read')
    assert.equal(await readOutcome(create(opts), row), 'miss')
    assert.equal(reads, 4, 'new runtime trusted an old transient miss')
    const outageRow = { ...row, id: 'index-outage', previewKey: 'index-outage', outputPath: path.join(negativeDir, 'local', 'index-outage.png') }
    const indexReader = opts.readPreviewCacheIndexStatus
    opts.readPreviewCacheIndexStatus = async () => { throw errors.timeout }
    assert.equal(await readOutcome(cached, outageRow), 'miss')
    opts.readPreviewCacheIndexStatus = indexReader
    fs.writeFileSync(path.join(negativeDir, 'index-outage.png'), png)
    assert.equal(await readOutcome(cached, outageRow), 'hydrated', 'index outage plus legacy miss suppressed later recovery')
    const beforePublication = reads
    fs.writeFileSync(path.join(negativeDir, 'absent.png'), png); presence = 'ok'
    assert.equal(await readOutcome(cached, row), 'hydrated', 'new publication did not override a recent miss')
    assert.equal(reads, beforePublication + 1)
    fs.unlinkSync(row.outputPath)
    opts.validateSharedPreviewCacheMeta = async () => ({ status: 'mismatch' })
    assert.equal(await readOutcome(cached, row), 'error')
    assert.equal(await readOutcome(cached, row), 'error', 'checksum failure became a missing image')
    console.log('PASS confirmed PNG miss avoids repeat shared IO; TTL, root generation, restart and successful publication restore reads; corruption remains error')
  } finally { fs.rmSync(negativeDir, {recursive: true, force: true}) }
  // Summary observes typed results; compatibility failed still means non-hydrated.
  let clock = 10001, finish = gate(), closing = false, closeListener
  const lines = [], rows = ['hydrated', 'miss', 'unavailable', 'timeout', 'cancelled', 'error'].map((id, i) => ({ id, previewKey: id, outputPath: '/p/' + i }))
  const prefetchLoad = loader({ '../../app/shutdownCoordinatorRuntime': { isApplicationClosing: () => closing, onApplicationClosing: fn => { closeListener = fn } } }, { Date: class extends Date { static now() { return clock } } })
  const prefetch = prefetchLoad(base + 'previewCachePrefetchRuntime.ts').createPreviewCachePrefetchRuntime({ appendStartupLog: line => lines.push(line), hydratePreviewCacheRows: async (_s, items, _current, report) => {
    await finish.promise; for (const row of items) report(row, row.id); return new Set(['hydrated'])
  } })
  prefetch.schedulePreviewCachePrefetch(local, rows, true)
  await new Promise(resolve => setTimeout(resolve, 10)); clock += 10001; finish.resolve(); await tick(); await tick()
  let summary = lines.filter(line => line.startsWith('preview cache prefetch summary:')).at(-1)
  for (const field of ['hydrated=1', 'failed=5', 'miss=1', 'unavailable=1', 'timeout=1', 'error=1', 'hydrationCancelled=1', 'unclassified=0']) assert(summary.includes(field), field + ': ' + summary)
  finish = gate(); prefetch.schedulePreviewCachePrefetch(local, rows, true); await new Promise(resolve => setTimeout(resolve, 10))
  closing = true; closeListener(); clock += 10001; finish.resolve(); await tick(); await tick()
  summary = lines.filter(line => line.startsWith('preview cache prefetch summary:')).at(-1)
  assert(summary.includes('hydrationCancelled=6')); assert(summary.includes('error=0')); assert(summary.includes('hydrated=0'))
  console.log('PASS prefetch summary separates misses, access, timeouts, cancellation and errors; obsolete results cannot count as hydrated')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
