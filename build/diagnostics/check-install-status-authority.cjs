#!/usr/bin/env node
'use strict'
// Windows only. Real SQL/signature/read/projection/composition owners; native
// worker and SQLite are real. External fonts/OS installation are never modified.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('./check-operation-chain.cjs')
const { createHost } = require('./lib/production-projection-host.cjs')
const root = path.resolve(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const load = loader()
const signature = load('src/main/install/status/installStatusSignatureRuntime.ts')
const identity = load('src/main/fonts/fontFileIdentity.ts')
let assertions = 0
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`authority diagnostic watchdog: ${label}`)), 10000) })]) }
  finally { clearTimeout(timer) }
}
function adapter(db) {
  return { prepare: sql => db.prepare(sql), exec: sql => db.exec(sql), function: (...args) => db.function(...args),
    transaction: fn => () => { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value } catch (error) { db.exec('ROLLBACK'); throw error } }, close() {} }
}
function makeFont(index, folder = 'C:\\authority') {
  const fileName = `${String(index).padStart(3, '0')}.ttf`, file = path.join(folder, fileName)
  return { id: identity.fileRuntimeFontId(file, 1, 100), path: file, fileName, fileSize: 1, modifiedAt: 100, createdAt: 100,
    family: `Fixture ${index}`, fullName: `Fixture ${index}`, style: 'Regular', format: 'ttf', scripts: ['latin'],
    tagNames: [], localTagNames: [], collectionIds: [], favorite: false, active: false, systemInstalled: false,
    installStatusKnown: true, systemInstallMatches: [], deleteProtected: false }
}
function vectorAndSqlCases() {
  for (const vector of require('./fixtures/install-status-signature.json')) {
    assert.equal(signature.installStatusSignatureValue(vector.item), vector.expected)
    const runtime = signature.createInstallStatusSignatureRuntime({ sha1: text => crypto.createHash('sha1').update(text).digest('hex'),
      normalizePathForCacheCompare: load('src/main/path/cachePath.ts').normalizePathForCacheCompare })
    assert.equal(runtime.installStatusSignature(vector.item), vector.expected)
  }
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`ATTACH DATABASE ':memory:' AS install_db;
      CREATE TABLE install_db.install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT,system_default INTEGER);
      CREATE TABLE install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT,system_default INTEGER);
      CREATE TABLE entries(root_path TEXT,relative_path TEXT,cache_key TEXT,file_size INTEGER,modified_at REAL,created_at REAL,status TEXT,font_json TEXT,message TEXT,cached_at TEXT,is_deleted INTEGER);
      CREATE TABLE fonts(id TEXT PRIMARY KEY); CREATE TABLE font_details(font_id TEXT,json TEXT); CREATE TABLE font_search(font_id TEXT,search_text TEXT);`)
    identity.registerFileIdentitySql(db); signature.registerInstallStatusSql(db)
    load('src/main/library/runtime/librarySchemaRuntime.ts').ensureStructuredFontsSchema(db, (_db,_table,column,type) => db.exec(`ALTER TABLE fonts ADD COLUMN ${column} ${type}`))
    const fonts = Array.from({ length: 7 }, (_, i) => makeFont(i))
    const mapper = load('src/main/library/fontSqliteMapper.ts')
    for (const [index, item] of fonts.entries()) {
      const source = { ...item, fileName: 'historical-display.ttf' }
      db.prepare("INSERT INTO entries VALUES ('C:\\authority',?,'',1,100,100,'ok',?,'','',0)").run(item.fileName, JSON.stringify(source))
      const values = mapper.fontToSqliteParams(item.id, item, 'now'), keys = Object.keys(values)
      db.prepare(`INSERT INTO fonts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(values))
      db.prepare('INSERT INTO font_details VALUES (?,?)').run(item.id, JSON.stringify(item))
      const sig = index === 1 ? signature.installStatusSignatureValue({ ...item, managedRegistryName: 'previous' })
        : index === 2 ? 'unknown:' + signature.installStatusSignatureValue(item)
        : index === 3 ? 'legacy-name-only' : signature.installStatusSignatureValue(item)
      if (index === 4) continue
      for (const table of ['install_db.install_status', 'install_status']) db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,0)`).run(item.id, sig, index === 6 ? null : index === 5 ? 1 : 0, index === 5 ? 'managed' : 'none', '[]')
    }
    const request = { sidebarPage: 'library', installStatus: 'notInstalled', sortMode: 'nameAsc', limit: 1 }
    const rootQuery = load('src/main/indexing/root-query/rootIndexPageQuerySql.ts')
    const localQuery = load('src/main/library/fontQuerySqlRuntime.ts')
    const expected = [fonts[0].id, fonts[5].id]
    for (const source of ['root', 'local']) {
      const seen = []
      for (let offset = 0; offset < 2; offset++) {
        const query = source === 'root' ? rootQuery.buildRootIndexQuerySql('C:\\authority', request, true, 1, offset) : localQuery.buildFontQueryPageSql({ ...request, offset })
        assert.equal(db.prepare(query.countSql).get(...query.countParams).count, 2)
        const rows = db.prepare(query.sql).all(...query.params)
        seen.push(...rows.map(row => source === 'root' ? JSON.parse(row.font_json).id : row.id))
      }
      assert.deepEqual(seen, expected, `${source}: stale/unknown row distorted count or raw-offset pages`)
    }
    const ids = localQuery.buildFontQuerySql({ ...request, limit: 50 })
    assert.deepEqual(db.prepare(ids.sql).all(...ids.params).map(row => row.id), expected)
    const known = fonts[0]
    for (const field of ['managedInstallPath', 'managedRegistryName']) {
      assert.equal(signature.rootInstallStatusSignature('C:\\authority', known.fileName, 1, 100, JSON.stringify({ ...known, [field]: 42 })), null)
      assert.throws(() => signature.installStatusSignatureValue({ ...known, [field]: {} }), /invalid-install-status-signature-field/)
    }
    assert.notEqual(signature.rootInstallStatusSignature('C:\\authority', known.fileName, 1, 100, JSON.stringify({ ...known, managedInstallPath: 'changed' })), signature.installStatusSignatureValue(known))
    assert.equal(signature.rootInstallStatusSignature('C:\\authority', known.fileName, 1, 100, JSON.stringify({ ...known, fileName: 'display-only.ttf' })), signature.installStatusSignatureValue(known))
    assertions += 15
  } finally { db.close() }
}
async function readCases() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT)')
  const items = Array.from({ length: 5 }, (_, i) => makeFont(i))
  for (const [index, item] of items.entries()) if (index < 3) db.prepare('INSERT INTO install_status VALUES (?,?,0,\'none\',\'[]\')').run(item.id,
    index === 0 ? signature.installStatusSignatureValue(item) : index === 1 ? 'content-v1:stale' : 'unknown:' + signature.installStatusSignatureValue(item))
  const source = load('src/main/db/query-worker/dbQueryWorkerInstallStatusSource.ts').buildDbQueryWorkerInstallStatusSource()
  const worker = { nowMs: Date.now, fs: { statSync: () => ({}) }, Database: function () { return { ...adapter(db), pragma() {} } },
    parseJson: (text, fallback) => { try { return JSON.parse(text) } catch { return fallback } }, module: { exports: {} } }
  vm.runInNewContext(source + '\nmodule.exports = readInstallStatusIndex', worker)
  const groups = [{ dbPath: 'controlled', items: items.map(item => ({ ...item, signature: signature.installStatusSignatureValue(item) })) }]
  const generated = worker.module.exports({ groups })
  worker.fs.statSync = () => { throw Object.assign(Error('denied'), { code: 'EACCES' }) }
  assert.throws(() => worker.module.exports({ groups }), /denied/)
  worker.fs.statSync = () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }) }
  assert(Object.values(worker.module.exports({ groups }).missingReasons).every(reason => reason === 'missing-db'))
  worker.fs.statSync = () => ({})
  assert.deepEqual(Object.keys(generated.results), [items[0].id])
  assert.deepEqual(Object.values(generated.missingReasons).sort(), ['explicit-unknown', 'missing-row', 'missing-row', 'signature-mismatch'])
  const missLogs = []
  const previous = process.env.HFM_NODE_STATE_FALLBACK; process.env.HFM_NODE_STATE_FALLBACK = '1'
  try {
    const reader = load('src/main/install/status/installStatusReadRuntime.ts').createInstallStatusReadRuntime({ appendStartupLog: line => { missLogs.push(line); if (line.startsWith('install status authority misses:')) throw Error('controlled miss log delivery failure') }, closeSqliteDb() {}, parseSqliteJson: worker.parseJson },
      { openFallbackInstallDb: async () => adapter(db), installStatusSignature: signature.installStatusSignatureValue,
        normalizeInstallCompareResult: load('src/main/install/status/installStatusCompareNormalizeRuntime.ts').createInstallStatusCompareNormalizeRuntime().normalizeInstallCompareResult })
    const node = await reader.readInstallStatusIndex(items)
    assert.deepEqual(plain(node.results), plain(generated.results)); assert.deepEqual(plain(node.missingReasons), plain(generated.missingReasons))
    const evidence = missLogs.find(line => line.startsWith('install status authority misses:'))
    assert(evidence.includes('"signature-mismatch":1'))
    const examples = JSON.parse(evidence.match(/examples=(.*)$/)[1])
    assert.equal(node.misses.length, 4); assert.equal(examples.length, 3)
    assert(examples.every(example => /^[a-f0-9]{12}$/.test(example.idHash)))
    assert(items.every(item => !evidence.includes(item.path) && !evidence.includes(item.id)))
    const unavailable = load('src/main/install/status/installStatusReadRuntime.ts').createInstallStatusReadRuntime({ appendStartupLog() {}, closeSqliteDb() {} }, { openFallbackInstallDb: async () => { throw Error('controlled-read-error') } })
    assert.equal((await unavailable.readInstallStatusIndex(items)).readError, true)
    assertions += 5
  } finally { if (previous === undefined) delete process.env.HFM_NODE_STATE_FALLBACK; else process.env.HFM_NODE_STATE_FALLBACK = previous; db.close() }
}
async function facadeOwnershipCases() {
  const task = load('src/main/library/fontQueryTaskRuntime.ts')
  const io = load('src/main/path/sharedFileSystemRuntime.ts')
  for (const mode of ['repair', 'retired', 'unavailable', 'repeated', 'frozen-retired', 'frozen-failure']) {
    const item = makeFont(0), offsets = [], logs = []
    let repaired = false, repairs = 0
    const controller = new AbortController()
    const frozen = Object.freeze(Error(mode === 'frozen-retired' ? '[HFM_QUERY:query-superseded]' : 'controlled projection failure'))
    const facade = load('src/main/library/fontQueryFacadeRuntime.ts').createFontQueryFacadeRuntime({
      appendLog: value => logs.push(value), hasPendingActivationState: () => false,
      queryFontPageFromMergedIndexWorker: async (_request, limit, offset) => { offsets.push(offset); return { items: repaired && mode !== 'repeated' ? [] : [item], total: repaired ? 0 : 1, offset, limit, engine: 'sql' } },
      readInstallStatusIndex: async () => ({ results: {}, readError: mode === 'unavailable', missingReasons: { [item.id]: 'signature-mismatch' } }),
      reconcileInstallStatusPage: async () => { repairs++; repaired = true; if (mode === 'retired') controller.abort(); if (mode.startsWith('frozen-')) throw frozen },
    })
    const pending = io.withSharedIoSignal(controller.signal, () => facade.queryFontPageInLibraryUncached({ installStatus: 'notInstalled' }, 100, 100))
    if (mode === 'repair') { assert.equal((await pending).total, 0); assert.deepEqual(offsets, [100, 100]); assert.equal(repairs, 1) }
    else { await assert.rejects(bounded(pending, mode), mode === 'frozen-failure' ? error => error === frozen : mode === 'unavailable' ? /authority-unavailable/ : error => /query-superseded/.test(String(error)) && error.requiresPageWindowRestart === true); assert.equal(repairs, mode === 'unavailable' ? 0 : 1) }
    assert(logs.every(line => !line.includes(item.path) && !line.includes(item.id)), 'new authority diagnostics disclosed paths/IDs')
    assertions++
  }
  const gate = {}; gate.promise = new Promise(resolve => { gate.release = resolve })
  let closed = false
  const physical = task.createFontQueryTask(async () => { try { await gate.promise; task.assertFontQueryActive(); return 1 } finally { closed = true } })
  const controller = new AbortController(), subscriber = task.joinFontQueryTask(physical, controller.signal)
  controller.abort(); await assert.rejects(subscriber, /query-superseded/)
  assert.equal(closed, false); gate.release(); await assert.rejects(physical.pending, /query-superseded/); assert.equal(closed, true)
  assertions++
}
async function migrationCases() {
  const db = new DatabaseSync(':memory:'), authority = new DatabaseSync(':memory:')
  const rootA = 'C:\\authority', rootB = '\\\\offline\\fonts', machine = 'C:\\data\\machines\\fixture\\install.sqlite'
  const first = makeFont(0, rootA), stale = makeFont(1, rootA), peer = makeFont(0, rootB)
  authority.exec('CREATE TABLE install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT)')
  authority.prepare("INSERT INTO install_status VALUES (?,?,1,'managed','[]')").run(first.id, signature.installStatusSignatureValue(first))
  authority.prepare("INSERT INTO install_status VALUES (?,?,0,'none','[]')").run(stale.id, 'content-v1:prefix-valid-stale')
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE sources(root_path TEXT PRIMARY KEY,index_db_path TEXT,install_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT,synced_at TEXT); CREATE TABLE entries(root_path TEXT,relative_path TEXT,file_size INTEGER,modified_at REAL,font_json TEXT,status TEXT,is_deleted INTEGER,installed INTEGER,installed_by TEXT,matches_json TEXT)')
  const sources = [{ root: rootA, indexDbPath: 'index-a', installDbPath: machine, indexSignature: 'root-v3|old-A', installSignature: 'install-content-v1|old-A', sharedMetadataSignature: 'metadata-v2|old-A' },
    { root: rootB, indexDbPath: 'index-b', installDbPath: 'C:\\data\\machines\\..\\other.sqlite', indexSignature: 'root-v3|old-B', installSignature: 'install-content-v1|old-B', sharedMetadataSignature: 'metadata-v2|old-B' }]
  for (const source of sources) db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?)').run(source.root, source.indexDbPath, source.installDbPath, source.indexSignature, source.installSignature, source.sharedMetadataSignature, 'unchanged-time')
  for (const item of [first, stale, peer]) db.prepare("INSERT INTO entries VALUES (?,?,1,100,?,'ok',0,0,'none','[]')").run(path.dirname(item.path), item.fileName, JSON.stringify({ ...item, fileName: 'old-display.ttf' }))
  db.prepare("INSERT INTO entries VALUES (?, 'bad-stat.ttf', -1, 100, '{}', 'ok', 0, 1, 'system', '[]')").run(rootA)
  db.prepare("INSERT INTO entries VALUES (?, 'bad-managed.ttf', 1, 100, ?, 'ok', 0, 1, 'system', '[]')").run(rootA, JSON.stringify({ managedRegistryName: {} }))
  const getMeta = (_db, key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value || ''
  const setMeta = (_db, key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value)
  const sourcesKey = rows => JSON.stringify(rows)
  setMeta(null, 'sourcesKey', sourcesKey(sources)); setMeta(null, 'installEvidenceVersion', 'content-v1')
  const probed = [], opened = [], migrationLogs = []
  const options = { machineDirectory: 'C:\\data\\machines', exists: async file => { probed.push(file); return file === machine },
    open: file => { opened.push(file); return adapter(authority) }, close: value => value.exec('ROLLBACK'), getMeta, setMeta, sourcesKey, appendLog(line) { migrationLogs.push(line); throw Error('controlled log delivery failure after commit') } }
  try {
    await load('src/main/indexing/merged-page/mergedIndexInstallAuthorityRuntime.ts').migrateMergedInstallAuthority(adapter(db), options)
    assert.deepEqual(probed, [machine]); assert.deepEqual(opened, [machine], 'migration touched a remote or unrelated authority')
    const rows = db.prepare('SELECT * FROM entries ORDER BY root_path,relative_path').all()
    assert.equal(rows.length, 5)
    const known = rows.find(row => JSON.parse(row.font_json).id === first.id)
    assert.equal(known.installed, 1); assert.equal(known.installed_by, 'managed')
    assert(rows.filter(row => JSON.parse(row.font_json).id !== first.id).every(row => row.installed === null && row.installed_by === null))
    const sourceRows = db.prepare('SELECT * FROM sources').all()
    assert.equal(sourceRows.find(row => row.root_path === rootA).install_signature, sources[0].installSignature)
    assert.equal(sourceRows.find(row => row.root_path === rootB).install_signature, 'pending:install-signature-authority')
    assert(sourceRows.every((row, i) => row.index_signature === sources[i].indexSignature && row.shared_metadata_signature === sources[i].sharedMetadataSignature && row.synced_at === 'unchanged-time'))
    assert.equal(getMeta(null, 'installEvidenceVersion'), signature.INSTALL_STATUS_PROJECTION_VERSION)
    assert(migrationLogs[0].includes('"signature-mismatch":1') && migrationLogs[0].includes('"exact-known":1'))
    assert(JSON.parse(migrationLogs[0].match(/examples=(.*), sourceHashes=/)[1]).length <= 3)
    assert([first, stale, peer].every(item => !migrationLogs[0].includes(item.path) && !migrationLogs[0].includes(item.id)))
    const before = JSON.stringify(rows); await load('src/main/indexing/merged-page/mergedIndexInstallAuthorityRuntime.ts').migrateMergedInstallAuthority(adapter(db), options)
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM entries ORDER BY root_path,relative_path').all()), before)
    assert.equal(opened.length, 1, 'migration repeated machine IO after certificate advanced')
    assertions += 10
  } finally { db.close(); authority.close() }
}
async function productionCompositionCase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-authority-'))
  const folder = path.join(directory, 'fonts'); fs.mkdirSync(folder)
  let host
  try {
    host = await createHost({ sourceRoot: root, workerPath: path.join(root, 'build/native/hfm-core-worker.exe'), directory, fixtureDirectory: directory, roots: [folder] })
    const items = Array.from({ length: 101 }, (_, i) => makeFont(i, folder))
    for (const item of items) fs.writeFileSync(item.path, 'x')
    await host.initialize(items, { legacyRows: 0, oldProjection: true })
    const results = Object.fromEntries(items.map(item => [item.id, { known: true, installed: false, by: 'none', matches: [] }]))
    // Persist source evidence without invoking projection, to seed exactly the
    // old prefix-known projection/new exact-authority mismatch from production.
    await host.status.saveInstallStatusIndex(results, new Map(items.map(item => [item.id, item])))
    const authority = host.openDb(host.paths.installPath)
    authority.prepare('UPDATE install_status SET signature=? WHERE font_id=?').run(signature.installStatusSignatureValue({ ...items[17], managedRegistryName: 'previous' }), items[17].id)
    authority.close()
    host.setRootOnline(false)
    const request = { sidebarPage: 'library', activeFilter: { kind: 'all' }, installStatus: 'notInstalled', sortMode: 'nameAsc', limit: 100, offset: 0 }
    const readsBefore = host.nativeReceipts.filter(row => row.method === 'runRustInstallStatusRead').length
    const first = await host.query.queryFontPageInLibrary(request)
    assert.equal(first.total, 100); assert.equal(first.items.length, 100)
    assert(first.items.every(item => item.installStatusKnown && !item.systemInstalled))
    assert(!first.items.some(item => item.id === items[17].id))
    const readsAfter = host.nativeReceipts.filter(row => row.method === 'runRustInstallStatusRead').length
    assert.equal(readsAfter - readsBefore, 1, 'composition rehydrated the same accepted page twice')
    const metrics = await host.query.getFontMetricsFromLibrary()
    assert.deepEqual([metrics.total, metrics.notInstalledCount, metrics.installStatusMissingCount], [101, 100, 1])
    assert.equal(first.workerMode, 'rust-merged-index-page'); assert.equal(metrics.workerMode, 'rust-merged-index-metrics')
    const nativeRead = await host.status.readInstallStatusIndex(items)
    assert.equal(nativeRead.missingReasons[items[17].id], 'signature-mismatch')
    assert.equal(Object.keys(nativeRead.results).length, 100)
    // A later durable source change must invalidate all cached offsets. It may
    // not append a repaired late page against an older first-page population.
    const realPage = host.native.runRustMergedIndexPageQuery
    host.native.runRustMergedIndexPageQuery = async payload => {
      host.native.runRustMergedIndexPageQuery = realPage
      const result = await realPage(payload)
      await host.status.saveInstallStatusIndex({ [items[100].id]: { known: false, installed: false, by: 'none', matches: [] } }, new Map([[items[100].id, items[100]]]))
      return result
    }
    host.query.clearFontQueryCaches()
    const beforeEvents = host.projectionEvents.length, beforePageSeq = host.rendererState.pageSeq.current, beforeToken = host.rendererState.token
    await assert.rejects(() => host.query.queryFontPageInLibrary({ ...request, limit: 50, offset: 50 }), /query-superseded/)
    assert(host.projectionEvents.length > beforeEvents, 'projection repair did not retire the renderer window')
    assert(host.rendererState.pageSeq.current > beforePageSeq && host.rendererState.token > beforeToken, 'actual renderer invalidation owner did not reset the page window')
    const later = await host.query.queryFontPageInLibrary({ ...request, limit: 50, offset: 50 })
    const start = await host.query.queryFontPageInLibrary({ ...request, limit: 50 })
    assert.equal(later.offset, 50); assert.equal(start.total, 99); assert.equal(later.total, 99)
    assert.equal(start.items.length + later.items.length, 99)
    assert.equal(new Set([...start.items, ...later.items].map(item => item.id)).size, 99)
    const finalMetrics = await host.query.getFontMetricsFromLibrary()
    assert.deepEqual([finalMetrics.notInstalledCount, finalMetrics.installStatusMissingCount], [99, 2])
    assert(!host.nativeReceipts.some(row => row.method === 'runRustMergedIndexRebuild'), 'offline authority repair forced a global root rebuild')
    assertions += 15
  } finally { if (host) await host.close(); fs.rmSync(directory, { recursive: true, force: true }) }
}
async function pageCacheOwnershipCases(transforms = {}) {
  const scoped = loader({}, {}, transforms)
  for (const restart of [true, false]) {
    let release, started, reads = 0
    const held = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { started = resolve })
    const request = { installStatus: 'notInstalled', sortMode: 'nameAsc', limit: 50, offset: 50 }
    const cache = scoped('src/main/library/fontPageQueryCacheRuntime.ts').createFontPageQueryCacheRuntime({
      pageCacheMax: 5, pageCacheTtlMs: 1000, appendStartupLog() {}, queryUncached: async (_request, limit, offset) => {
        const call = ++reads
        if (call === 1) {
          started(); await held
          if (restart) throw Object.assign(Error('[HFM_QUERY:query-superseded]'), { requiresPageWindowRestart: true })
        }
        return { items: [], total: call, offset, limit, engine: 'sql' }
      },
    })
    const creator = cache.queryFontPageInLibrary(request)
    void creator.catch(() => undefined)
    try {
      await bounded(entered, 'page cache entered')
      const waiter = cache.queryFontPageInLibrary(request)
      const settled = Promise.allSettled([creator, waiter])
      cache.invalidateFontQueryPageCache(restart)
      release()
      const results = await bounded(settled, 'page cache creator and waiter settled')
      if (restart) {
        assert(results.every(result => result.status === 'rejected' && /query-superseded/.test(String(result.reason))), 'PAGE_WINDOW_RESTART_GUARD: retired creator or joined waiter succeeded')
        assert.equal(reads, 1, 'PAGE_WINDOW_RESTART_GUARD: creator/joined waiter revived a retired offset')
      } else {
        assert(results.every(result => result.status === 'fulfilled' && result.value.total === 2))
        assert.equal(reads, 2, 'ordinary non-cancelling cache invalidation lost its existing coalesced retry')
      }
      assertions++
    } finally { release(); cache.invalidateFontQueryPageCache(); await bounded(creator.catch(() => undefined), 'page cache creator cleanup') }
  }
}
async function legacyCapabilityCases() {
  const capabilities = ['merged-index-page-query', 'merged-index-ids-query', 'merged-index-metrics-query', 'merged-index-rebuild', 'merged-index-sync', 'install-status-index-read']
  const ports = { diagnoseRustCoreWorker: async () => ({ available: true, path: 'old-worker.exe', capabilities }), appendStartupLog() {},
    createTemporaryJsonFile() { throw Error('old worker reached payload creation') }, runRustCoreScheduledCommand() { throw Error('old worker submitted a command') } }
  const indexing = load('src/main/rust-core/clients/rustIndexingClientRuntime.ts').createRustIndexingClientRuntime(ports)
  const metadata = load('src/main/rust-core/clients/rustMetadataClientRuntime.ts').createRustMetadataClientRuntime(ports)
  for (const method of ['runRustMergedIndexPageQuery', 'runRustMergedIndexIdsQuery', 'runRustMergedIndexMetricsQuery', 'runRustMergedIndexRebuild', 'runRustMergedIndexSync']) assert.equal(await indexing[method]({}), null)
  assert.equal(await metadata.runRustInstallStatusRead([]), null)
  assertions += 6
}
async function main() {
  assert.equal(process.platform, 'win32', 'Installation authority verification runs only on Windows')
  vectorAndSqlCases(); await readCases(); await facadeOwnershipCases(); await legacyCapabilityCases(); await pageCacheOwnershipCases(); await migrationCases(); await productionCompositionCase()
  const cacheFile = path.join(root, 'src/main/library/fontPageQueryCacheRuntime.ts')
  const restartGuard = 'if ((error as { requiresPageWindowRestart?: boolean })?.requiresPageWindowRestart) throw error;'
  assert.equal(fs.readFileSync(cacheFile, 'utf8').split(restartGuard).length - 1, 2, 'exact creator/waiter mutant anchors changed')
  await assert.rejects(() => pageCacheOwnershipCases({ [cacheFile]: text => text.replaceAll(restartGuard, '') }), error => error instanceof assert.AssertionError && /PAGE_WINDOW_RESTART_GUARD/.test(error.message))
  console.log(`[diagnostics:install-status-authority] ${assertions} grouped checks: exact Node/root/local/native signatures, stale prefix/managed metadata/unknown/missing, generated-worker/Node reasons, local offline migration, page/count/metrics consistency, full-window retirement and original-offset paging, read failure/cancellation; actual Windows worker + production composition.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
