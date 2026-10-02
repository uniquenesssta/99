#!/usr/bin/env node
/**
 * Regression checks for shared library SQLite handle lifecycle.
 * Startup schema audit and shared known tags refresh use openLibraryDb(), which
 * returns the process-wide library DB handle. They must not close that handle;
 * otherwise early fonts:getMetrics/appWatchedFolders can hit
 * "The database connection is not open".
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertIncludes(relativePath, needle) {
  const text = readText(relativePath)
  assert(text.includes(needle), `${relativePath} missing ${needle}`)
}

function assertNotIncludes(relativePath, needle) {
  const text = readText(relativePath)
  assert(!text.includes(needle), `${relativePath} should not include ${needle}`)
}

function testFixtureCapturesClosedHandleRegression() {
  const data = readJson('build/diagnostics/fixtures/library-db-handle-lifecycle.fixture.json')
  assert(data.name === 'library-db-handle-lifecycle-fixture', 'unexpected fixture name')
  assert(data.symptoms.firstFontsGetMetricsError === 'The database connection is not open', 'fixture no longer captures closed DB error')
  assert(data.rootCause.startupSchemaAuditClosedSharedLibraryHandle === true, 'fixture must document startup audit root cause')
  assert(data.expectedPolicy.openLibraryDbMustDiscardClosedSingletonBeforeReturning === true, 'fixture must require closed singleton guard')
}

function testOpenLibraryDbDiscardsClosedSingleton() {
  const text = readText('src/main/library/runtime/libraryDbConnectionRuntime.ts')
  assert(text.includes('function isSqliteDbOpen(db: SqliteDb | null): db is SqliteDb'), 'library DB runtime missing open-state guard')
  assert(text.includes('(db as any).open !== false'), 'library DB open-state guard must use better-sqlite3 open flag')
  assert(text.includes('if (isSqliteDbOpen(libraryDb)) return libraryDb'), 'openLibraryDb must return only an open singleton')
  assert(text.includes('if (libraryDb) libraryDb = null'), 'openLibraryDb must discard closed singleton')
}

function testGetOpenLibraryDbDoesNotReturnClosedHandle() {
  const text = readText('src/main/library/runtime/libraryDbConnectionRuntime.ts')
  assert(text.includes('function getOpenLibraryDb(): SqliteDb | null'), 'missing getOpenLibraryDb')
  assert(text.includes('if (isSqliteDbOpen(libraryDb)) return libraryDb'), 'getOpenLibraryDb must verify open singleton')
  assert(text.includes('return null'), 'getOpenLibraryDb must return null for closed singleton')
}

function testStartupSchemaAuditDoesNotCloseLibrarySingleton() {
  const text = readText('src/main/diagnostics/startupSchemaAudit.ts')
  assert(text.includes('const libraryDb = await deps.openLibraryDb()'), 'startup audit must still read library schema')
  assert(!/libraryDb[\s\S]{0,240}deps\.closeSqliteDb\(libraryDb\)/.test(text), 'startup audit must not close the shared library DB handle')
}

function bodyOf(text, functionName) {
  const start = text.indexOf(`async function ${functionName}`)
  assert(start >= 0, `missing ${functionName}`)
  const next = text.indexOf('\n  async function ', start + 1)
  return text.slice(start, next >= 0 ? next : text.length)
}

function testSharedKnownTagsDoesNotCloseLibrarySingleton() {
  const text = readText('src/main/library/sharedKnownTagsRuntime.ts')
  const persistedBody = bodyOf(text, 'readPersistedSharedTags')
  const persistBody = bodyOf(text, 'persistKnownSharedTags')
  assert(persistedBody.includes('const db = await deps.openLibraryDb()'), 'readPersistedSharedTags must still use library DB')
  assert(persistBody.includes('const db = await deps.openLibraryDb()'), 'persistKnownSharedTags must still use library DB')
  assert(!persistedBody.includes('deps.closeSqliteDb(db)'), 'readPersistedSharedTags must not close openLibraryDb handle')
  assert(!persistBody.includes('deps.closeSqliteDb(db)'), 'persistKnownSharedTags must not close openLibraryDb handle')
}

function testSharedMetadataDbStillClosesStandaloneHandles() {
  const text = readText('src/main/library/sharedKnownTagsRuntime.ts')
  const metadataBody = bodyOf(text, 'readMetadataTagsForRoot')
  assert(metadataBody.includes('deps.closeSqliteDb(db)'), 'standalone shared metadata DB handles should still be closed')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:library-db-handle'] === 'node build/diagnostics/check-library-db-handle-lifecycle.cjs', 'missing diagnostics:library-db-handle script')
}

const tests = [
  testFixtureCapturesClosedHandleRegression,
  testOpenLibraryDbDiscardsClosedSingleton,
  testGetOpenLibraryDbDoesNotReturnClosedHandle,
  testStartupSchemaAuditDoesNotCloseLibrarySingleton,
  testSharedKnownTagsDoesNotCloseLibrarySingleton,
  testSharedMetadataDbStillClosesStandaloneHandles,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`library DB handle lifecycle checks passed (${tests.length})`)

async function testPreparationLifetime() {
  const strict = require('node:assert/strict')
  const os = require('node:os')
  const { DatabaseSync } = require('node:sqlite')
  const { loader } = require('./check-operation-chain.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-library-lifetime-'))
  const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
  let hold, entered, fail = false, preparations = 0, initializations = 0
  const handles = []
  const load = loader({ [path.join(root, 'src/main/library/runtime/librarySchemaRuntime.ts')]: {
    initializeLibraryDb(db) { initializations++; db.exec('CREATE TABLE IF NOT EXISTS sample(value INTEGER)') }
  } })
  const runtime = load('src/main/library/runtime/libraryDbConnectionRuntime.ts').createLibraryDbConnectionRuntime({
    librarySqlitePath: () => path.join(dir, 'library.sqlite'),
    openRecoverableApplicationSqliteDb: async () => {
      const db = new DatabaseSync(':memory:')
      Object.defineProperty(db, 'open', { get: () => db.isOpen })
      handles.push(db); return db
    },
    closeSqliteDb: db => { if (db?.isOpen) db.close() },
    prepareLocalFontIdentity: async db => {
      preparations++; entered?.resolve()
      if (hold) await hold.promise
      // A close request must not physically close the handle under preparation.
      strict.equal(db.prepare('SELECT 1 AS n').get().n, 1)
      if (fail) throw Error('controlled migration failure')
    }
  })
  try {
    const first = await runtime.openLibraryDb()
    hold = gate(); entered = gate()
    const pending = runtime.openLibraryDb()
    await entered.promise
    const joined = runtime.openLibraryDb()
    strict.equal(preparations, 2, 'cached preparation was duplicated')
    runtime.closeLibraryDb()
    strict.equal(runtime.getOpenLibraryDb(), null)
    strict.equal(first.isOpen, true, 'close interrupted active migration')
    const rejected = Promise.all([strict.rejects(pending, /连接已失效/), strict.rejects(joined, /连接已失效/)])
    hold.resolve(); await rejected
    strict.equal(first.isOpen, false)
    strict.equal(runtime.getOpenLibraryDb(), null, 'obsolete handle was republished')
    hold = undefined; entered = undefined
    const second = await runtime.openLibraryDb()
    strict.notEqual(first, second); strict.equal(second.isOpen, true)
    strict.equal(initializations, 2, 'cached opens reran schema initialization')
    runtime.closeLibraryDb()
    // Also invalidate the first open while its migration is pending.
    hold = gate(); entered = gate()
    const opening = runtime.openLibraryDb(); await entered.promise
    runtime.closeLibraryDb()
    const closed = strict.rejects(opening, /连接已失效/)
    hold.resolve(); await closed
    strict.equal(handles.at(-1).isOpen, false)
    hold = undefined; entered = undefined; fail = true
    await strict.rejects(runtime.openLibraryDb(), /controlled migration failure/)
    strict.equal(handles.at(-1).isOpen, false)
    fail = false
    strict.equal((await runtime.openLibraryDb()).isOpen, true, 'failed preparation blocked retry')
    const watcher = readText('src/main/bootstrap/mainScanCompositionRuntime.ts')
    const closeBlock = watcher.slice(watcher.indexOf('closeRuntimeDatabases: () => {'), watcher.indexOf('watcherChangeBatchLooksUnchanged:', watcher.indexOf('closeRuntimeDatabases: () => {')))
    strict(!closeBlock.includes('closeLibraryDb()'), 'watcher restart closes application library')
    console.log('PASS actual SQLite: cached/initial preparation invalidation, single flight, no stale publication, failure recovery')
  } finally {
    runtime.closeLibraryDb()
    for (const db of handles) if (db.isOpen) db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
testPreparationLifetime().catch(error => { console.error(error); process.exitCode = 1 })
