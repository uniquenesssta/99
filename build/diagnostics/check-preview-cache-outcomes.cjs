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
    await tick(); assert.equal(calls, before + 1, 'same key duplicated physical hydration')
    hold.resolve(); hold = undefined; assert.equal(await a, true); assert((await b).has(row.id))
    console.log('PASS cache outcomes: real IO errors retained, six hydration results, timeout/cancel same-key retry, physical coalescing')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
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
