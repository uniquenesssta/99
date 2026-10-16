#!/usr/bin/env node
'use strict'
// Windows-only: production directory walk, orchestrator, manifest writer and
// managed wrapper on real private SQLite/files. Only fault and parse ports vary.
const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..'), abs = value => path.join(root, value)
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function bounded(promise, name) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`scan retention watchdog: ${name}`)), 5000) })]) }
  finally { clearTimeout(timer) }
}
async function fixture(transforms = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-scan-retention-'))
  const folders = [path.join(directory, 'fonts-a'), path.join(directory, 'fonts-b')]
  const state = { denied: '', nullStat: false, parseError: false, invalid: false, parseGate: null, parseEntered: deferred(), tailGate: null, tailEntered: deferred(), writes: [], signatures: [], logs: [], handles: new Set() }
  const exists = async file => { try { await fsp.stat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
  const open = file => {
    const db = new DatabaseSync(file); state.handles.add(db)
    const close = db.close.bind(db)
    db.close = () => { if (state.handles.delete(db)) close() }
    return db
  }
  // Keep all actual owners/signal scopes; only the filesystem's readdir fault
  // is injected. No parser or writer runs until its actual production call.
  const mocks = { [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: { sharedIoResourceKeys: async () => [] } }
  const shared = loader(mocks, { setInterval, clearInterval, setImmediate, clearImmediate })('src/main/path/sharedFileSystemRuntime.ts')
  mocks[abs('src/main/path/sharedFileSystemRuntime.ts')] = { ...shared, sharedFileSystem: { ...fsp,
    readdir: async (file, ...args) => { if (file === state.denied) throw Object.assign(Error('controlled unreadable subtree'), { code: 'EACCES' }); return fsp.readdir(file, ...args) },
  } }
  const load = loader(mocks, { setInterval, clearInterval, setImmediate, clearImmediate }, transforms)
  const constants = load('src/main/cache/cachePaths.ts')
  const index = load('src/main/indexing/rootIndexRuntime.ts').createRootIndexRuntime({
    appName: 'HFM', fontScanCacheVersion: 1, scriptDetectionVersion: 1, exists,
    openStableSqliteDb: open, closeSqliteDb: db => db.close(), appendStartupLog: text => state.logs.push(text),
    withGlobalIo: async (_label, work) => work(), invalidateSharedFontRuntimeCaches() {}, recordCacheEvent: async () => {},
  })
  const paths = new Map()
  for (const folder of folders) {
    await fsp.mkdir(path.join(folder, 'child'), { recursive: true })
    const dbPath = path.join(directory, path.basename(folder), '.hfm-cache', 'database', 'index.sqlite')
    await fsp.mkdir(path.dirname(dbPath), { recursive: true }); paths.set(folder, dbPath)
    const entries = {}
    for (const key of ['child/retained.ttf', 'change.ttf', 'removed.ttf']) {
      const file = path.join(folder, key); await fsp.writeFile(file, 'source-font-bytes')
      const stat = await fsp.stat(file)
      const font = { id: `${path.basename(folder)}:${key}`, path: file, fileName: path.basename(file), family: key, fullName: key,
        fileSize: stat.size, modifiedAt: stat.mtimeMs, scripts: ['latin'], scriptVersion: 1, localTagNames: ['keep'], tagNames: [], active: false }
      entries[key] = { path: key, cacheKey: constants.fileCacheSignature(key, stat.size, stat.mtimeMs), fileSize: stat.size, modifiedAt: stat.mtimeMs,
        status: 'ok', font, cachedAt: 'previous-confirmed' }
    }
    await index.saveRootIndexSqliteFile(dbPath, folder, 'fallback', { version: 1, entries })
  }
  const deps = {
    appendStartupLog: text => state.logs.push(text), emitFontIndexProgress() {}, recheckGlobalIoQueues() {},
    globalIoSnapshot: () => ({ active: 0, pending: 0, concurrency: 1 }), withGlobalIo: async (_name, work) => work(),
    fontExtensions: new Set(['.ttf']), scriptDetectionVersion: 1, fontScanCacheVersion: 1, scanHashFlushBatchSize: 100, indexProgressEventMinIntervalMs: 0,
    cacheKeyForRootFile: (folder, file) => path.relative(folder, file).replaceAll('\\', '/').toLowerCase(),
    cacheEntryRuntimePath: (folder, key) => path.join(folder, key), sanitizeCachedFont: font => font,
    cachedFontForRuntime: (font, file, stat) => ({ ...font, path: file, fileSize: stat.size, modifiedAt: stat.mtimeMs }),
    ensureRootScanCacheStorage: async folder => ({ cachePath: paths.get(folder), cacheDir: path.dirname(path.dirname(paths.get(folder))), storage: 'fallback',
      cache: await index.readRootIndexSqliteFile(paths.get(folder), folder, 'fallback') }),
    loadLegacyScanCache: async () => ({ version: 1, entries: {} }),
    saveScanCacheFile: (file, cache, folder, storage) => index.saveRootIndexSqliteFile(file, folder, storage, cache),
    writeRootCacheManifest: index.writeRootCacheManifest, openRootIndexDb: index.openRootIndexDb, closeSqliteDb: db => db.close(),
    withRootCacheWriteLock: index.withRootCacheWriteLock,
    saveRootIndexSqliteChanges: async (...args) => { state.writes.push({ folder: args[1], upserts: plain(args[3]), deletes: plain(args[4]) }); await index.saveRootIndexSqliteChanges(...args) },
    saveRootIndexDirectorySignatures: async (...args) => { state.signatures.push(args[1]); await index.saveRootIndexDirectorySignatures(...args) },
    upsertFontHashIndex: async () => {}, recordCacheEvent: async (_scope, kind) => { if (kind === 'scan_finished' && state.tailGate) { state.tailEntered.resolve(); await state.tailGate.promise } },
    runFontIndexListWorker: async () => { throw Error('unexpected fallback after partial directory return') },
    // Production invokes this port even for an empty native remainder. Its
    // actual empty-work contract returns zero without launching a parser.
    runFontParseWorkerPool: async (jobs, _progress, signal) => { load('src/main/performance/ioQueue.ts').throwIfAborted(signal); if (jobs.length) throw Error('unexpected Node parser fallback'); return { workerCount: 0 } }, scanWorkerCount: () => 0,
    runRustFontParseBatch: async jobs => {
      state.parseEntered.resolve(); if (state.parseGate) await state.parseGate.promise
      return state.parseError ? { results: [], errors: jobs.map(job => ({ jobId: job.jobId, message: 'controlled source read failure' })) }
        : { results: jobs.map(job => ({ ...job, signatureValid: !state.invalid, nameHint: { familyName: 'Parsed' }, scriptHint: { scripts: ['latin'] } })) }
    },
  }
  const listing=load('src/main/indexing/scan-orchestrator/scanListingRuntime.ts')
  mocks[abs('src/main/indexing/scan-orchestrator/scanListingRuntime.ts')]={...listing,listScanStatJobs:async args=>{
    const jobs=await listing.listScanStatJobs(args)
    return state.nullStat ? jobs.map(job=>path.basename(job.file)==='change.ttf'?{...job,stat:null,error:'controlled null stat receipt'}:job) : jobs
  }}
  const scan = load('src/main/indexing/scanOrchestrator.ts').createScanOrchestrator(deps)
  const read = folder => index.readRootIndexSqliteFile(paths.get(folder), folder, 'fallback')
  const close = async () => { for (const db of [...state.handles]) db.close(); assert.equal(state.handles.size, 0); await fsp.rm(directory, { recursive: true, force: true }) }
  return { directory, folders, paths, state, read, scan, deps, load, close }
}
async function nullStatCase(transforms={}) {
  const f=await fixture(transforms)
  try {
    const a=f.folders[0],before=plain((await f.read(a)).entries)
    f.state.nullStat=true;await fsp.unlink(path.join(a,'removed.ttf'))
    const result=await f.scan.scanFolders([a])
    assert.equal(result.errors.length,1)
    assert.deepEqual(plain((await f.read(a)).entries),before,'NULL_STAT_RETAIN: unreported failed stat authorized missing-row deletion')
    assert.equal(f.state.signatures.length,0)
  } finally {await f.close()}
}
async function partialAndParseCases(transforms = {}) {
  const f = await fixture(transforms)
  try {
    const [a, b] = f.folders, original = plain((await f.read(a)).entries['child/retained.ttf'])
    await fsp.unlink(path.join(a, 'removed.ttf')); await fsp.unlink(path.join(b, 'removed.ttf'))
    f.state.denied = path.join(a, 'child')
    const partial = await f.scan.scanFolders(f.folders)
    assert.equal(partial.errors.length, 1)
    const retained = (await f.read(a)).entries['child/retained.ttf']
    assert(retained, 'PARTIAL_SCAN_RETAIN: unreadable subtree lost its committed row')
    assert.deepEqual(plain(retained), original, 'PARTIAL_SCAN_RETAIN: unreadable subtree changed its committed row')
    assert((await f.read(a)).entries['removed.ttf'], 'PARTIAL_SCAN_RETAIN: incomplete root certified missing-file deletion')
    assert(!(await f.read(b)).entries['removed.ttf'], 'complete peer root did not reconcile a real deletion')
    assert(!f.state.signatures.includes(a), 'incomplete walk advanced directory receipts')
    assert.deepEqual(plain(partial.committedFolders), f.folders)
    f.state.denied = ''; await f.scan.scanFolders([a])
    assert(!(await f.read(a)).entries['removed.ttf'], 'later complete scan did not finish retained deletion')
    const old = plain((await f.read(a)).entries['change.ttf'])
    await fsp.appendFile(path.join(a, 'change.ttf'), '-changed')
    await fsp.writeFile(path.join(a, 'new.ttf'), 'new-content')
    f.state.parseError = true; f.state.signatures.length = 0
    const failed = await f.scan.scanFolders([a])
    assert.equal(failed.errors.length, 2); assert.equal(failed.stats.skippedBad, 0)
    assert.deepEqual(plain((await f.read(a)).entries['change.ttf']), old, 'PARSE_FAILURE_RETAIN: transient failure overwrote confirmed font')
    assert.equal((await f.read(a)).entries['new.ttf'], undefined, 'PARSE_FAILURE_RETAIN: unknown new file became definitive bad')
    assert.equal(f.state.signatures.length, 0, 'parse failure suppressed a future retry via directory receipts')
    f.state.parseError = false; await f.scan.scanFolders([a])
    assert.equal((await f.read(a)).entries['change.ttf'].status, 'ok'); assert.equal((await f.read(a)).entries['new.ttf'].status, 'ok')
    f.state.invalid = true; await fsp.appendFile(path.join(a, 'new.ttf'), 'changed-again'); await f.scan.scanFolders([a])
    assert.equal((await f.read(a)).entries['new.ttf'].status, 'bad', 'genuine invalid signature lost its separate terminal state')
    f.state.invalid = false; await f.scan.scanFolders([a])
    assert.equal((await f.read(a)).entries['new.ttf'].status, 'ok', 'ordinary scan failed to revalidate an existing root-cache bad row')
    assert.equal(await fsp.readFile(path.join(a, 'child/retained.ttf'), 'utf8'), 'source-font-bytes')
  } finally { await f.close() }
}
function managedWrapper(runtime, effects, transform = value => value) {
  const file = 'src/main/bootstrap/mainScanCompositionRuntime.ts', source = transform(fs.readFileSync(abs(file), 'utf8'))
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let expression
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'scanFoldersManaged' && node.initializer) expression = node.initializer.getText(tree); ts.forEachChild(node, visit) }
  visit(tree); assert(expression, 'actual managed scan wrapper missing')
  const js = ts.transpileModule(`export const run = ${expression}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new Function('exports', 'assertFeedbackReady', 'scanFoldersRuntime', 'syncMergedIndexForRootSnapshot', 'delayToEventLoop', 'isApplicationClosing', 'sourceRecovery', js)(
    exports, () => {}, () => runtime, async folder => effects.push(folder), async () => {}, () => false, { resume() {}, pause() {} })
  return exports.run
}
async function cancelledWrapperCases(transform) {
  const load = loader(), entered = deferred(), release = deferred(), effects = []
  const runtime = load('src/main/indexing/scan-orchestrator/fontScanActiveJobRuntime.ts').createFontScanActiveJobRuntime({
    appendStartupLog() {}, emitFontIndexProgress() {}, recheckGlobalIoQueues() {}, globalIoSnapshot: () => ({ active: 0, pending: 0, concurrency: 1 }),
  }, async (folders, _known, { signal }) => { entered.resolve(); await release.promise; load('src/main/performance/ioQueue.ts').throwIfAborted(signal); return { folders, fonts: [], errors: [], committedFolders: folders } })
  const run = managedWrapper(runtime, effects, transform)
  const first = run(['C:\\one']), firstSettled = first.then(value => value)
  try {
    await bounded(entered.promise, 'active scan entered')
    const second = run(['C:\\two']), third = run(['C:\\three'])
    const all = Promise.all([firstSettled, second, third]); release.resolve()
    const results = await bounded(all, 'cancelled and replacement scans settled')
    assert(results[0].stats.cancelled && results[1].stats.cancelled)
    assert.deepEqual(effects, [path.resolve('C:\\three')], 'CANCELLED_SCAN_NO_PROJECTION: cancelled/superseded request launched projection')
    const empty = managedWrapper({ scanFoldersManaged: async () => ({ folders: ['C:\\busy'], fonts: [], errors: [] }) }, effects)
    await empty([]); assert.equal(effects.length, 1, 'uncommitted busy root launched projection')
  } finally { release.resolve(); await bounded(first.catch(() => {}), 'active scan cleanup') }
}
async function cancelledTailCase(transforms = {}) {
  const f = await fixture(transforms), effects=[]
  f.state.tailGate=deferred()
  const managed=f.load('src/main/indexing/scan-orchestrator/fontScanActiveJobRuntime.ts').createFontScanActiveJobRuntime(f.deps,f.scan.scanFolders)
  const run=managedWrapper(managed,effects)
  const pending=run([f.folders[0]])
  void pending.catch(()=>{})
  try {
    await bounded(f.state.tailEntered.promise,'actual scan_finished tail entered')
    assert.equal(managed.cancelActiveFontScan('cancel during committed tail').cancelled,true)
    let settled=false;void pending.finally(()=>{settled=true}).catch(()=>{})
    await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'cancel released owned scan tail early')
    f.state.tailGate.resolve()
    const result=await bounded(pending,'cancelled committed tail')
    assert.equal(result.stats.cancelled,true,'CANCELLED_SCAN_TAIL: retired owner published successful completion')
    assert.equal(effects.length,0,'CANCELLED_SCAN_TAIL: post-cancel root projection started')
    assert.equal(Object.keys((await f.read(f.folders[0])).entries).length,3,'cancel undid already committed source population')
  } finally { f.state.tailGate.resolve();await bounded(pending.catch(()=>{}),'tail cleanup');await f.close() }
}
async function main() {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  const env = Object.fromEntries(['HFM_RUST_SCAN_LISTING', 'HFM_NODE_STATE_FALLBACK', 'HFM_NODE_FONTKIT_SCAN_FALLBACK'].map(key => [key, process.env[key]]))
  process.env.HFM_RUST_SCAN_LISTING = '0'; process.env.HFM_NODE_STATE_FALLBACK = '1'; process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK = '0'
  try {
    await partialAndParseCases(); await nullStatCase(); await cancelledWrapperCases(); await cancelledTailCase()
    const writeFile = abs('src/main/indexing/scan-orchestrator/scanRootCacheWriteRuntime.ts')
    const guard = 'context.scanListingComplete === true && !context.scanReadIncomplete'
    assert.equal(fs.readFileSync(writeFile, 'utf8').split(guard).length - 1, 1)
    await assert.rejects(() => partialAndParseCases({ [writeFile]: text => text.replace(guard, 'true') }), /PARTIAL_SCAN_RETAIN/)
    const ownerFile=abs('src/main/indexing/scan-orchestrator/fontScanActiveJobRuntime.ts'), tailGuard='throwIfAborted(controller.signal)'
    assert.equal(fs.readFileSync(ownerFile,'utf8').split(tailGuard).length-1,1)
    await assert.rejects(()=>cancelledTailCase({[ownerFile]:text=>text.replace(tailGuard,'')}),/CANCELLED_SCAN_TAIL/)
    const scanFile=abs('src/main/indexing/scanOrchestrator.ts'),nullGuard=';(await ensureRootContext(item.rootPath)).scanReadIncomplete = true'
    assert.equal(fs.readFileSync(scanFile,'utf8').split(nullGuard).length-1,1)
    await assert.rejects(()=>nullStatCase({[scanFile]:text=>text.replace(nullGuard,'')}),/NULL_STAT_RETAIN/)
    const guard2 = 'if (result.stats?.cancelled || isApplicationClosing()) return result;'
    const committedLoop = 'for (const root of result.committedFolders || []) {'
    assert.equal(fs.readFileSync(abs('src/main/bootstrap/mainScanCompositionRuntime.ts'), 'utf8').split(guard2).length - 1, 1)
    assert.equal(fs.readFileSync(abs('src/main/bootstrap/mainScanCompositionRuntime.ts'), 'utf8').split(committedLoop).length - 1, 1)
    await assert.rejects(() => cancelledWrapperCases(text => text.replace(guard2, '').replace(committedLoop, 'for (const root of result.folders || []) {')), /CANCELLED_SCAN_NO_PROJECTION/)
    console.log('[diagnostics:scan-partial-retention] real SQLite partial directory/peer completion, transient parse retention/retry/genuine bad, original sources intact, actual managed cancellation including committed tail and four causal mutants passed')
  } finally { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}
module.exports = { fixture }
if (require.main === module) {
const watchdog=setTimeout(()=>{console.error('scan retention diagnostic did not settle within 120s');process.exit(1)},120000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(()=>clearTimeout(watchdog))
}
