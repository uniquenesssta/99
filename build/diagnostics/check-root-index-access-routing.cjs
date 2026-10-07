#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('./check-operation-chain.cjs')
const { applyNativeRootIndex } = require('./root-index-native-fixture.cjs')

const root = path.resolve(__dirname, '../..')
const crlf = process.argv.includes('--crlf')
const mutantStorageRoute = process.argv.includes('--mutant-storage-route')
const mutantFallbackShared = process.argv.includes('--mutant-fallback-shared')
const abs = rel => path.join(root, rel)
const sharedMarker = 'network-root'
const transforms = {}

for (const rel of [
  'src/main/indexing/root-index/rootIndexAccessRuntime.ts',
  'src/main/indexing/root-index/rootIndexDatabaseRuntime.ts',
  'src/main/indexing/rootIndexRuntime.ts',
]) {
  transforms[abs(rel)] = source => {
    let text = source
    if (mutantStorageRoute && rel.endsWith('rootIndexRuntime.ts')) {
      text = text.replace("storage === 'root' && accessKind === 'local' &&", "storage === 'root' &&")
    }
    if (mutantFallbackShared && rel.endsWith('rootIndexAccessRuntime.ts')) {
      text = text.replace("if (storage === 'fallback' && access === 'shared')", "if (false)")
    }
    return crlf ? text.replace(/\r?\n/g, '\r\n') : text
  }
}

function mocks(dir, published) {
  const isShared = value => String(value || '').includes(sharedMarker)
  return {
    [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: {
      sharedIoResourceKeys: async paths => paths.some(isShared) ? ['\\\\nas\\share'] : [],
    },
    [abs('src/main/path/sharedFileSystemRuntime.ts')]: {
      sharedFileSystem: fsp, currentSharedIoSignal: () => undefined,
      sharedSqliteReadSnapshot: async file => {
        const target = path.join(dir, `read-${require('node:crypto').randomUUID()}.sqlite`)
        const db = new DatabaseSync(file)
        try { db.prepare('VACUUM INTO ?').run(target) } finally { db.close() }
        return { path: target, dispose: () => fsp.rm(target, { force: true }) }
      },
    },
    [abs('src/main/indexing/root-index/rootIndexLockRuntime.ts')]: {
      createRootIndexLockRuntime: () => ({
        rootCacheDirForIndexPath: file => path.dirname(file),
        withRootCacheWriteLock: async (_file, action) => action(),
      }),
    },
    [abs('src/main/indexing/root-index/rootIndexManifestRuntime.ts')]: {
      createRootIndexManifestRuntime: () => ({
        resolveActiveRootIndexDbPath: async (_dir, fallback) => fallback,
        writeRootCacheManifest: async (_dir, _root, _storage, _count, selected) => { published.push(selected) },
        validateRootIndexLatestPointer: async () => undefined,
      }),
    },
    [abs('src/main/indexing/root-index/rootIndexSnapshotRuntime.ts')]: {
      createRootIndexSnapshotRuntime: () => ({
        rootIndexSnapshotDbPath: cacheDir => path.join(cacheDir, 'snapshot.sqlite'),
        cleanupOldRootIndexSnapshots: async () => undefined,
        inspectRootIndexSnapshotMaintenance: async () => ({}),
        cleanupRootIndexSnapshotMaintenance: async () => ({}),
        listRootIndexDatabaseFiles: async () => [],
      }),
    },
  }
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-c01-routing-'))
  try {
    const published = []
    const load = loader(mocks(dir, published), {}, transforms)
    const access = load('src/main/indexing/root-index/rootIndexAccessRuntime.ts')
    const localRoot = path.join(dir, 'local-root')
    const sharedRoot = path.join(dir, sharedMarker)
    const localDb = path.join(localRoot, 'index.sqlite')
    const sharedDb = path.join(sharedRoot, 'index.sqlite')

    assert.equal(await access.resolveRootIndexAccessKind(localDb, 'root'), 'local')
    assert.equal(await access.resolveRootIndexAccessKind(sharedDb, 'root'), 'shared')
    assert.equal(await access.resolveRootIndexAccessKind(localDb, 'fallback'), 'local')
    await assert.rejects(
      access.resolveRootIndexAccessKind(sharedDb, 'fallback'),
      error => error?.reason === 'invalid-root-index-access',
      'fallback/shared must fail closed',
    )

    const rustCalls = []
    const openCalls = []
    const events = []
    const runtime = load('src/main/indexing/rootIndexRuntime.ts').createRootIndexRuntime({
      appName: 'HFM',
      fontScanCacheVersion: 1,
      scriptDetectionVersion: 1,
      exists: async file => { try { await fsp.access(file); return true } catch { return false } },
      openStableSqliteDb: file => { openCalls.push(file); return new DatabaseSync(file) },
      closeSqliteDb: db => db.close(),
      appendStartupLog: line => events.push(line),
      withGlobalIo: async (_label, action) => action(),
      invalidateSharedFontRuntimeCaches() {},
      recordCacheEvent: async (_source, eventType, payload) => events.push(JSON.stringify({ eventType, payload })),
      runRustRootIndexApplyChanges: async input => {
        rustCalls.push(input)
        return applyNativeRootIndex(root, dir, input)
      },
    })
    const entryFor = base => ({
      path: 'a.ttf',
      cacheKey: 'a.ttf',
      fileSize: 10,
      modifiedAt: 1,
      createdAt: 1,
      status: 'ok',
      font: { id: 'a', path: path.join(base, 'a.ttf'), fileName: 'a.ttf', format: 'ttf' },
      cachedAt: '2026-09-20T00:00:00.000Z',
    })

    await fsp.mkdir(localRoot, { recursive: true })
    await runtime.saveRootIndexSqliteChanges(localDb, localRoot, 'root', [['a.ttf', entryFor(localRoot)]], [])
    assert.equal(rustCalls.length, 0, 'local root incremental write must keep local snapshot route')
    assert(openCalls.length > 0, 'local root did not use local SQLite')
    assert.equal(await fsp.stat(path.join(localRoot, 'snapshot.sqlite')).then(stat => stat.isFile()), true)

    openCalls.length = 0
    await fsp.mkdir(sharedRoot, { recursive: true })
    await runtime.saveRootIndexSqliteChanges(sharedDb, sharedRoot, 'root', [['a.ttf', entryFor(sharedRoot)]], [])
    assert.equal(rustCalls.length, 1, 'shared root incremental write did not reach isolated native route')
    assert.equal(openCalls.length, 0, 'shared root incremental write opened main-process SQLite')

    const oldBytes = await fsp.readFile(sharedDb)
    await runtime.saveRootIndexSqliteFile(sharedDb, sharedRoot, 'root', { version: 1, entries: { 'a.ttf': entryFor(sharedRoot) } })
    assert.equal(rustCalls.length, 2, 'shared root full write did not reach isolated native replace route')
    assert.equal(rustCalls[1].mode, 'replace')
    assert(openCalls.length > 0, 'candidate was not validated')
    assert(openCalls.every(file => !file.includes(sharedMarker)), 'main SQLite opened a shared DB instead of isolated validation copy')
    assert.deepEqual(await fsp.readFile(sharedDb), oldBytes, 'full recovery mutated retained original')
    const candidate = new DatabaseSync(published.at(-1))
    try {
      assert.equal(candidate.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 1)
      assert.equal(JSON.parse(candidate.prepare('SELECT font_json FROM entries').get().font_json).path, entryFor(sharedRoot).font.path)
    } finally { candidate.close() }

    console.log(JSON.stringify({
      ok: true,
      crlf,
      routes: {
        rootLocal: 'local-atomic-snapshot',
        rootSharedIncremental: 'rust-isolated-apply',
        fallbackLocal: 'local',
        fallbackShared: 'rejected',
        rootSharedFull: 'rust-isolated-replace',
      },
      rustCalls: rustCalls.length,
    }))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }

  if (!crlf && !mutantStorageRoute && !mutantFallbackShared) {
    const child = args => cp.spawnSync(process.execPath, [__filename, ...args], { cwd: root, encoding: 'utf8', timeout: 30000 })
    const crlfRun = child(['--crlf'])
    assert.equal(crlfRun.status, 0, crlfRun.stdout + crlfRun.stderr)
    const storageMutant = child(['--mutant-storage-route'])
    assert.notEqual(storageMutant.status, 0, 'storage-only routing mutant was accepted')
    const fallbackMutant = child(['--mutant-fallback-shared'])
    assert.notEqual(fallbackMutant.status, 0, 'fallback/shared fail-closed mutant was accepted')
    console.log('[diagnostics:root-index-access-routing] CRLF passed; storage-route and fallback/shared mutants rejected')
  }
}
main().catch(error => {
  console.error('[diagnostics:root-index-access-routing]', error.stack || error)
  process.exitCode = 1
})
