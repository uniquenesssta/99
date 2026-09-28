#!/usr/bin/env node
// Real bootstrap wiring, SQLite configuration reader and preview routing. The
// shared counter is held at its IO boundary; this is not a NAS benchmark.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('./check-operation-chain.cjs')
const { createHarness, root, entry } = require('./helpers/mainCompositionHarness.cjs')
const composition = path.join(root, 'src/main/bootstrap/mainDataCompositionRuntime.ts')
const tick = () => new Promise(resolve => setImmediate(resolve))
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve: value => resolve(value) } }

async function measure({ baseline = false, source } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE app_state(key TEXT, value TEXT);
    CREATE TABLE folders(path TEXT, sort_order INTEGER);
    CREATE TABLE folder_nodes(json TEXT, sort_order INTEGER);
    CREATE TABLE collections(json TEXT, sort_order INTEGER);
    CREATE TABLE tags(name TEXT, sort_order INTEGER);`)
  const fontRoot = 'C:\\fonts'
  db.prepare('INSERT INTO folders VALUES (?, 0)').run(fontRoot)
  const count = gate(), events = []
  let counts = 0, opens = 0
  const load = loader({
    'node:path': path.win32,
    '../../path/sharedFileSystemRuntime': { sharedFileSystem: { mkdir: async () => {} } },
  }, { process: { ...process, env: { ...process.env, HFM_LOG_DETAIL: 'debug' } } })
  const persistence = load('src/main/library/runtime/libraryPersistenceRuntime.ts')
  const openLibraryDb = async () => { opens++; return db }
  const library = load('src/main/library/runtime/libraryLoadRuntime.ts').createLibraryLoadRuntime({
    openLibraryDb, countSharedFontsForFolders: async folders => {
      assert.equal(folders[0], fontRoot); counts++; return count.promise
    }, appendStartupLog() {},
  })
  const h = createHarness(source ? new Map([[composition, source]]) : undefined)
  const module = h.load(path.join(root, 'src/main/library/libraryRuntime.ts'))
  const original = module.createLibraryRuntime
  module.createLibraryRuntime = options => Object.assign(original(options), {
    openLibraryDb, loadLibraryShell: library.loadLibraryShell,
    loadLibraryShellFromSqlite: persistence.loadLibraryShellFromSqlite,
  })
  h.load(entry)
  const previewOptions = h.options('createPreviewRuntime')
  const routing = load('src/main/preview/runtime/previewStorageRoutingRuntime.ts').createPreviewStorageRoutingRuntime(previewOptions, {})
  const trace = load('src/main/logging/operationTraceContext.ts')
  let settled = false
  const started = performance.now()
  const pending = trace.withOperationTrace({ version: 1, sessionId: 'context-test', operationId: 'preview-one',
    attemptId: 'attempt-one', batchId: 'batch-one', domain: 'preview' },
  message => events.push(JSON.parse(message.slice('operation-chain: '.length))),
  () => routing.loadLibraryShellCached()).then(value => { settled = true; return value })
  try {
    // Coalesced consumers must not duplicate configuration work.
    const second = routing.loadLibraryShellCached()
    await tick()
    assert.equal(settled, !baseline, 'preview configuration waited for unrelated shared font counting')
    assert.equal(counts, baseline ? 1 : 0)
    assert.equal(opens, 1)
    const blockedBeforeRelease = !settled
    count.resolve(4068)
    const [shell, same] = await Promise.all([pending, second])
    assert.equal(shell, same)
    assert.equal(shell.folders[0], fontRoot)
    assert.equal(await routing.loadLibraryShellCached(), shell)
    assert.equal(opens, 1, 'hot context reread its database')
    const contextEvents = events.filter(e => e.stage.startsWith('preview-library-context-'))
    assert.deepEqual(contextEvents.map(e => e.stage), ['preview-library-context-start', 'preview-library-context-end'])
    assert(contextEvents.every(e => e.trace?.operationId === 'preview-one'), 'context timing lost request identity')
    assert.equal(contextEvents[1].outcome, 'returned')
    routing.invalidateLibraryShellCache()
    db.prepare('INSERT INTO folders VALUES (?, 1)').run('D:\\new-fonts')
    assert.equal((await routing.loadLibraryShellCached()).folders.length, 2, 'folder change kept stale context')
    const ui = await h.compositions.get('createMainDataCompositionRuntime').capabilities.loadLibraryShell()
    assert.equal(ui.totalFonts, 4068, 'UI lost shared font totals')
    assert.equal(counts, baseline ? 3 : 1)
    return { variant: baseline ? 'baseline' : 'optimized', blockedBeforeRelease, sharedCountsBeforeRelease: baseline ? 1 : 0,
      contextElapsedMs: contextEvents[1].elapsedMs, measuredMs: Math.round(performance.now() - started) }
  } finally { count.resolve(4068); await pending; db.close() }
}

async function main() {
  const source = fs.readFileSync(composition, 'utf8')
  const anchor = 'loadLibraryShell: async () => loadLibraryShellFromSqlite(await openLibraryDb()),'
  assert(source.includes(anchor), 'baseline mutation anchor missing')
  const before = source.replace(anchor, 'loadLibraryShell,')
  console.log(JSON.stringify(await measure({ baseline: true, source: before })))
  console.log(JSON.stringify(await measure()))
  await assert.rejects(() => measure({ source: before }), assert.AssertionError)
  console.log('PASS reconnecting shared counts is rejected; UI counts and context invalidation retained')
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { measure, composition }
