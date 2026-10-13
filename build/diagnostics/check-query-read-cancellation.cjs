#!/usr/bin/env node
// Production metadata clients, read adapters, install fallback boundary and page
// owner. Only native command, filesystem and SQLite ports are controlled.
const assert = require('node:assert/strict')
const path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const plain = value => JSON.parse(JSON.stringify(value))
const font = { id: 'f', path: 'C:\\fonts\\a.ttf', fileName: 'a.ttf', fileSize: 1, modifiedAt: 1, localTagNames: ['old'] }
const installed = { installed: true, by: 'system', matches: [] }
let cases = 0

async function withPolicy(mode, run) {
  const keys = ['HFM_RUST_FULL_MIGRATION', 'HFM_NODE_STATE_FALLBACK'], previous = keys.map(key => process.env[key])
  process.env[keys[0]] = mode === 'legacy' ? '0' : '1'
  process.env[keys[1]] = mode === 'explicit' ? '1' : '0'
  try { await run() } finally { keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]) }
}

function harness(settings = {}, transforms = {}) {
  const load = loader({ electron: { app: { isPackaged: false, getAppPath: () => '' } }, 'node:path': path.win32 }, {}, transforms)
  const io = load('src/main/path/sharedFileSystemRuntime.ts')
  const tasks = load('src/main/library/fontQueryTaskRuntime.ts')
  const failure = load('src/shared/fontQueryFailure.ts')
  const { SharedIoProcessError } = load('src/main/path/sharedIoProcessRuntime.ts')
  const { RustCoreSchedulerTaskCancelled } = load('src/main/rust-core/rustCoreSchedulerRuntime.ts')
  const { OperationCancelledError } = load('src/main/performance/ioQueue.ts')
  const controller = new AbortController(), events = [], logs = []
  const event = async (stage, detail) => { events.push(stage); return settings.hook?.(stage, detail, controller) }
  const db = {
    prepare(sql) {
      events.push('node-sql')
      return {
        all: () => sql.includes('SELECT font_id,') ? [{ font_id: 'f', tag_name: 'node' }] : [],
        get: () => ({ signature: 'signature', installed: 1, by_type: 'system', matches_json: '[]' }),
      }
    },
  }
  const metadata = load('src/main/rust-core/clients/rustMetadataClientRuntime.ts').createRustMetadataClientRuntime({
    diagnoseRustCoreWorker: async () => { await event('diagnose'); return { available: !settings.unavailable, path: 'C:\\worker.exe', capabilities: ['local-tags-read', 'install-status-index-read','install-status-signature-authority-v1'] } },
    createTemporaryJsonFile: () => {
      events.push('input-created')
      return { path: 'C:\\input.json', writeJson: () => event('input-written'), dispose: () => event('input-disposed') }
    },
    runRustCoreScheduledCommand: async (_path, args) => {
      await event('command', args[0])
      const payload = args[0] === '--local-tags-read'
        ? { ok: true, tagMap: { f: ['rust'] }, knownTags: ['rust'] }
        : { ok: true, results: { f: installed }, missingIds: [] }
      return { stdout: JSON.stringify(payload), stderr: '' }
    },
    appendStartupLog: text => logs.push(text),
  })
  const tags = load('src/main/library/runtime/localFontTagsRuntime.ts').createLocalFontTagsRuntime({
    librarySqlitePath: () => 'C:\\library.sqlite',
    prepareIdentity: () => event('identity-ready'),
    openLibraryDb: async () => { await event('node-open'); return db },
    runRustLocalTagsRead: settings.tagRead || metadata.runRustLocalTagsRead,
    appendStartupLog: text => logs.push(text),
  })
  const worker = load('src/main/install/status/installStatusWorkerReadRuntime.ts').createInstallStatusWorkerReadRuntime({
    openLibraryDb: () => event('library-ready'),
    exists: async () => { await event('migration-exists'); return false },
    openStableSqliteDb: () => { throw Error('unexpected migration database open') }, closeSqliteDb() {}, initializeMachineInstallDb() {},
    readRust: settings.installRead || metadata.runRustInstallStatusRead,
    readWorker: async () => { await event('db-worker'); return { results: { f: installed }, missingIds: [] } },
    appendStartupLog: text => logs.push(text),
  })
  const index = load('src/main/install/status/installStatusReadRuntime.ts').createInstallStatusReadRuntime({
    readInstallStatusIndexInWorker: settings.directNode ? undefined : worker,
    appendStartupLog: text => logs.push(text),
    parseSqliteJson: (text, fallback) => text ? JSON.parse(text) : fallback,
    closeSqliteDb: () => events.push('node-closed'),
  }, {
    fallbackInstallStatusDbPath: async () => { await event('install-path'); return 'C:\\install.sqlite' },
    installStatusWorkerItem: item => ({ ...item, signature: 'signature' }),
    openFallbackInstallDb: async () => { await event('node-open'); return db },
    installStatusSignature: () => 'signature', normalizeInstallCompareResult: value => value,
  })
  const facade = load('src/main/library/fontQueryFacadeRuntime.ts').createFontQueryFacadeRuntime({
    readInstallStatusIndex: index.readInstallStatusIndex, appendLog: text => logs.push(text),
    applyPendingActivationState: items => { events.push('install-overlay'); return items },
  })
  const read = kind => kind === 'tags' ? tags.hydrateLocalTagsForFonts([font])
    : kind === 'ids' ? tags.localTagsByFontIds(['f']) : facade.hydrateInstallStatusForFonts([font])
  const readPage = async kind => {
    events.push('page-read')
    const value = await read(kind)
    return { queryKey: 'current', items: kind === 'ids' ? [] : value, total: 1, offset: 0, limit: 1, engine: 'sql', elapsedMs: 0 }
  }
  const pages = load('src/main/library/fontPageQueryCacheRuntime.ts').createFontPageQueryCacheRuntime({
    pageCacheMax: 3, pageCacheTtlMs: 5000, appendStartupLog: text => logs.push(text), queryUncached: () => readPage(settings.kind || 'tags'),
  })
  return { load, io, tasks, failure, controller, events, logs, metadata, read, pages, index, worker,
    count: stage => events.filter(value => value === stage).length, SharedIoProcessError, RustCoreSchedulerTaskCancelled, OperationCancelledError }
}

function cancellation(h, name) {
  if (name === 'scheduler') return new h.RustCoreSchedulerTaskCancelled('replaced generation')
  if (name === 'queue') return new h.OperationCancelledError('cancelled queued read')
  if (name === 'shared') return new h.SharedIoProcessError('cancelled child', 'unknown', 'cancelled')
  return Object.assign(Error('native operation aborted'), name === 'code' ? { code: 'ABORT_ERR' } : { name: 'AbortError' })
}

async function terminalErrors(transforms = {}) {
  for (const mode of ['disabled', 'explicit', 'legacy']) await withPolicy(mode, async () => {
    for (const kind of ['tags', 'ids', 'install']) for (const name of ['abort', 'code', 'scheduler', 'queue', 'shared']) {
      let error
      const h = harness({ hook: stage => { if (stage === 'command') throw error } }, transforms)
      error = cancellation(h, name)
      await assert.rejects(h.read(kind), value => kind === 'install' ? h.failure.isFontQuerySuperseded(value) : value === error)
      assert.equal(h.count('command'), 1)
      assert.equal(h.count('input-disposed'), 1)
      for (const stage of ['db-worker', 'node-open', 'node-sql', 'install-overlay']) assert.equal(h.count(stage), 0, `${mode}/${kind}/${name}: ${stage}`)
      assert(!h.logs.some(text => /fallback|read finished/.test(text)), 'cancellation was reported as backend failure/success')
      cases++
    }
  })
}

async function stageCancellation(transforms = {}) {
  await withPolicy('explicit', async () => {
    for (const kind of ['tags', 'ids', 'install']) {
      const stages = ['diagnose', 'input-written', 'command', 'input-disposed', ...(kind === 'install' ? ['install-path', 'library-ready', 'migration-exists'] : ['identity-ready'])]
      for (const stage of ['before', ...stages]) {
        const h = harness({ hook: (current, _detail, controller) => { if (current === stage) controller.abort() } }, transforms)
        if (stage === 'before') h.controller.abort()
        await assert.rejects(h.io.withSharedIoSignal(h.controller.signal, () => h.read(kind)))
        assert.equal(h.count('command'), +['command', 'input-disposed'].includes(stage), `${kind}/${stage}: stale native work admitted`)
        for (const next of ['db-worker', 'node-open', 'node-sql', 'install-overlay']) assert.equal(h.count(next), 0, `${kind}/${stage}: ${next}`)
        assert.equal(h.count('input-disposed'), h.count('input-created'))
        cases++
      }
    }
    for (const kind of ['tags', 'ids', 'install']) {
      const h = harness({ unavailable: true, directNode: kind === 'install', hook: (stage, _detail, controller) => { if (stage === 'node-open') controller.abort() } }, transforms)
      await assert.rejects(h.io.withSharedIoSignal(h.controller.signal, () => h.read(kind)))
      assert.equal(h.count('node-open'), 1)
      assert.equal(h.count('node-sql'), 0, 'cancelled DB-open continuation ran compatibility SQL')
      assert.equal(h.count('install-overlay'), 0)
      if (kind === 'install') assert.equal(h.count('node-closed'), 1, 'cancelled open leaked its owned DB handle')
      cases++
    }
    for (const value of [null, { results: { f: installed }, missingIds: [] }]) {
      let h
      h = harness({ installRead: async () => { h.controller.abort(); return value } }, transforms)
      await assert.rejects(h.io.withSharedIoSignal(h.controller.signal, () => h.read('install')))
      assert.equal(h.count('db-worker'), 0, 'cancelled Rust-null handoff admitted DB worker')
      assert.equal(h.count('install-overlay'), 0)
      cases++
    }
    const duringWorker = harness({ unavailable: true, hook: (stage, _detail, controller) => { if (stage === 'db-worker') controller.abort() } }, transforms)
    await assert.rejects(duringWorker.io.withSharedIoSignal(duringWorker.controller.signal, () => duringWorker.read('install')))
    assert.equal(duringWorker.count('db-worker'), 1)
    assert.equal(duringWorker.count('install-overlay') + duringWorker.count('node-open'), 0)
    cases++
  })
}

async function nonCancellationPolicy() {
  for (const mode of ['disabled', 'explicit', 'legacy']) await withPolicy(mode, async () => {
    for (const kind of ['tags', 'ids', 'install']) for (const unavailable of [false, true]) {
      const h = harness({ unavailable, hook: stage => { if (stage === 'command') throw Error('ordinary worker unavailable') } })
      const result = await h.read(kind), allowed = mode !== 'disabled'
      assert.equal(h.count(kind === 'install' ? 'db-worker' : 'node-open'), +allowed)
      if (kind === 'install') {
        assert.equal(result[0].installStatusKnown, allowed)
        assert.equal(result[0].systemInstalled, allowed)
        if (!allowed) {
          assert(h.logs.some(text => text.includes('machine install status unavailable read:')))
          assert(!h.logs.some(text => text.includes('machine install status db worker read:')), 'disabled fallback falsely reported DB-worker work')
        }
      } else if (kind === 'ids') assert.deepEqual(plain(result), allowed ? { f: ['node'] } : {})
      else assert.deepEqual(plain(result[0].localTagNames), allowed ? ['node'] : ['old'])
      assert(h.logs.some(text => allowed ? text.includes('node state fallback used') : text.includes('fallback disabled')))
      cases++
    }
    for (const kind of ['tags', 'ids', 'install']) {
      const h = harness(), result = await h.read(kind)
      assert.equal(h.count('command'), 1)
      assert.equal(h.count('db-worker') + h.count('node-open'), 0)
      if (kind === 'install') assert.equal(result[0].systemInstalled, true)
      else assert.deepEqual(plain(kind === 'ids' ? result.f : result[0].localTagNames), ['rust'])
      cases++
    }
    const failedWorker = harness({ unavailable: true, hook: stage => { if (stage === 'db-worker') throw Error('ordinary DB worker failure') } })
    const result = await failedWorker.read('install')
    assert.equal(failedWorker.count('db-worker'), +(mode !== 'disabled'))
    assert.equal(failedWorker.count('node-open'), +(mode !== 'disabled'))
    assert.equal(result[0].systemInstalled, mode !== 'disabled')
    cases++
  })
}

async function closeAndPublication() {
  await withPolicy('explicit', async () => {
    for (const kind of ['tags', 'install']) for (const failureKind of ['cancelled', 'unclassified']) {
      const started = deferred(), closed = deferred()
      let h, calls = 0, published = 0
      h = harness({ kind, hook: async stage => {
        if (stage !== 'command' || ++calls > 1) return
        const signal = h.io.currentSharedIoSignal()
        const cancelled = new Promise((_, reject) => signal.addEventListener('abort', () => {
          const error = failureKind === 'unclassified' ? Error('timeout raced query cancellation') : cancellation(h, kind === 'tags' ? 'shared' : 'abort')
          error.closed = closed.promise
          reject(error)
        }, { once: true }))
        started.resolve()
        await cancelled
      } })
      const first = h.io.withSharedIoSignal(h.controller.signal, () => h.pages.queryFontPageInLibrary({ limit: 1 })).then(() => { published++; return null }, error => error)
      await started.promise
      h.controller.abort()
      assert(h.failure.isFontQuerySuperseded(await first))
      const next = h.pages.queryFontPageInLibrary({ limit: 1 }).then(value => { published++; return value })
      await tick()
      assert.equal(calls, 1, 'new query crossed the physical-close barrier')
      assert.equal(published, 0)
      assert.equal(h.count('db-worker') + h.count('node-open') + h.count('install-overlay'), 0)
      closed.resolve()
      assert.equal((await next).items.length, 1)
      assert.equal(calls, 2)
      await h.pages.queryFontPageInLibrary({ limit: 1 })
      assert.equal(calls, 2, 'accepted replacement failed to populate page cache')
      assert.equal(published, 1)
      cases++
    }
  })
  const h = harness(), closed = deferred()
  const error = cancellation(h, 'scheduler'); error.closed = closed.promise
  let normalized
  try { h.tasks.rethrowFontQuerySuperseded(error) } catch (value) { normalized = value }
  assert(h.failure.isFontQuerySuperseded(normalized))
  assert.equal(normalized.closed, closed.promise, 'query cancellation classification lost worker close ownership')
  assert.doesNotThrow(() => h.tasks.rethrowFontQuerySuperseded(Error('ordinary failure')))
  closed.resolve()
  cases++
}

async function queuedCancellation() {
  await withPolicy('explicit', async () => {
    const h = harness(), held = deferred(), controller = new AbortController()
    const { AdaptiveIoQueue, OperationCancelledError } = h.load('src/main/performance/ioQueue.ts')
    const queue = new AdaptiveIoQueue(() => 1)
    const first = queue.add('held reader', () => held.promise)
    let executed = false
    const queued = queue.add('obsolete metadata', async () => { executed = true }, { signal: controller.signal }).catch(error => error)
    controller.abort()
    const error = await queued
    assert(error instanceof OperationCancelledError)
    assert.equal(executed, false)
    held.resolve(); await first
    for (const kind of ['tags', 'install']) {
      const chain = harness({ hook: stage => { if (stage === 'command') throw error } })
      await assert.rejects(chain.read(kind))
      assert.equal(chain.count('db-worker') + chain.count('node-open') + chain.count('install-overlay'), 0)
    }
    cases++
  })
}

async function bindingCloseOwnership() {
  const root = path.resolve(__dirname, '../..'), at = file => path.join(root, 'src/main/library', file)
  const items = [0, 1].map(index => ({ ...font, id: 'f' + index, path: `C:\\fonts\\${index}\\a.ttf`, localTagNames: ['tag'] }))
  const key = file => path.win32.normalize(file).toLowerCase()
  const load = loader({
    'node:path': path.win32,
    [at('tagRecoveryPathRuntime.ts')]: { createTagRecoveryPaths: async () => ({ roots: ['C:\\fonts'], compare: key, inside: () => true, contains: () => true }) },
    [at('tagFontBindingRuntime.ts')]: { readTagFontBindings: async () => ({ bindings: new Map(items.map(item => [key(item.path), { id: item.id, path: item.path, tags: ['tag'], pathResolved: true }])), legacyTags: new Map(), unavailableRoots: [] }) },
    [at('tagFontSnapshotRuntime.ts')]: { openTagFontSnapshots: () => ({ schedule() { return { queued: 0, coalesced: 0, historyWrites: 0 } }, remember() { return { examined: 0, written: 0 } }, holdBackgroundCapture() { return () => {} }, read() {} }) },
    [path.join(root, 'src/main/fonts/fontRuntime.ts')]: { asFormat: () => 'ttf', fontItemFromPath: () => { throw Error('unexpected parse') } },
  })
  const io = load('src/main/path/sharedFileSystemRuntime.ts'), { SharedIoProcessError } = load('src/main/path/sharedIoProcessRuntime.ts')
  const started = deferred(), closes = [deferred(), deferred()], controller = new AbortController()
  let reads = 0, live = 0, hydrated = 0
  io.sharedFileSystem = { readdir: async () => {
    const index = reads++
    if (index >= 2) return [{ name: 'a.ttf', isFile: () => true, isSymbolicLink: () => false }]
    const signal = io.currentSharedIoSignal()
    const pending = new Promise((_, reject) => signal.addEventListener('abort', () => {
      const error = new SharedIoProcessError('directory cancelled', 'unknown', 'cancelled')
      error.closed = closes[index].promise; reject(error)
    }, { once: true }))
    if (reads === 2) started.resolve()
    return pending
  } }
  const owner = load('src/main/library/tagFontQueryRuntime.ts').createTagFontQueryRuntime({
    roots: async () => ['C:\\fonts'], openLibraryDb: async () => ({}), readShared: async () => { throw Error('unexpected shared tags') },
    queryLive: async () => { live++; return { items, total: 2 } },
    hydrate: async value => { hydrated++; return value }, matches: () => true, compare: () => 0,
  })
  const request = { sidebarPage: 'tags', selectedTagName: 'tag' }
  const old = io.withSharedIoSignal(controller.signal, () => owner.query(request, 10, 0)).catch(error => error)
  await started.promise; controller.abort(); assert.equal((await old).reason, 'query-superseded')
  const next = owner.query(request, 10, 0)
  closes[0].resolve(); await tick()
  assert.equal(reads, 2, 'replacement admitted before every old directory child closed')
  assert.equal(live, 1); assert.equal(hydrated, 0)
  closes[1].resolve()
  assert.equal((await next).items.length, 2)
  assert.equal(reads, 4); assert.equal(live, 2); assert.equal(hydrated, 1)
  cases++
}

async function main() {
  await terminalErrors(); await stageCancellation(); await nonCancellationPolicy(); await closeAndPublication(); await queuedCancellation(); await bindingCloseOwnership()
  console.log(`[diagnostics:query-read-cancellation] ${cases} production-client/caller cancellation, stage admission, migration policy, close ownership and page publication cases passed`)
}
let completed = false
process.once('beforeExit', () => { if (!completed) { console.error('Query read cancellation diagnostic did not complete'); process.exitCode = 1 } })
main().then(() => { completed = true }).catch(error => { console.error(error); process.exitCode = 1 })
