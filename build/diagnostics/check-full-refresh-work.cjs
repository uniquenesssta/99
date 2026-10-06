#!/usr/bin/env node
'use strict'

/*
 * PROPOSED WINDOWS-ONLY FULL REFRESH / FOREGROUND BENCHMARK.
 * Prepared outside the repository; NO execution has been performed here.
 * Review/apply alongside hfm-production-projection-host.cjs, then run on Windows:
 * node <this-file> --current-root <checkout> --baseline-root <clean-6620b3b-worktree>
 *   --worker <current-worker.exe> --baseline-worker <6620b3b-worker.exe> --host <projection-host.cjs> --output <private-output>
 *
 * Never checks out/resets a user's repository, changes actual Windows Fonts or
 * registry, builds software, injects latency into performance runs, or silently
 * replaces production query/metrics with array calculations. Failure to construct
 * a real baseline is reported as NON-COMPARABLE, not as a timing improvement.
 * The baseline worktree must be prepared by the Windows orchestration owner.
 *
 * Population: 256 real Arial-derived source COPIES, 32 independent target copies,
 * 5234 valid metadata-only no-candidate rows. Indexed/timed population = 5490.
 * One explicit invalid display row is added only in the labeled correctness lane:
 * attempted population = 5491, indexed population remains 5490. It must not be
 * normalized into a pretend valid SQL row or counted as a real font file.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { createRequire } = require('node:module')
const { AsyncLocalStorage } = require('node:async_hooks')
const { performance } = require('node:perf_hooks')

const liveHosts = new Set()
const BASELINE = '6620b3bafd5b3d894987585dd06c5d5eabc54933'
const WORKLOAD = Object.freeze({ sourceFiles: 256, targetFiles: 32, sourcesPerTarget: 8,
  metadataOnly: 5234, validIndexed: 5490, invalidDisplay: 1, attemptedCorrectness: 5491,
  legacyRows: 94, evidenceConcurrency: 2, previewConcurrency: 10,
  foregroundQueries: 16, nativePreviews: 10, treeEnumerations: 4 })
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const errorInfo = error => ({ name: error?.name, code: error?.code, message: String(error?.message || error), stack: error?.stack })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const summarize = values => { const sorted = [...values].sort((a,b) => a-b); return { count: sorted.length,
  p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * .95)-1] : null,
  maxMs: sorted.length ? sorted.at(-1) : null, minMs: sorted.length ? sorted[0] : null, values: [...values] } }
function argument(name, fallback) { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at+1] }
function git(root, ...args) { return cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim() }
function inside(root, file) { const relative = path.relative(root, path.resolve(file)); return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) }
function save(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)) }

function describeFile(file, kind, fields = {}) {
  const stat = fs.statSync(file, { bigint: true })
  return { kind, path: file, bytes: Number(stat.size), sha256: sha256(fs.readFileSync(file)),
    mtimeNs: stat.mtimeNs.toString(), birthtimeNs: stat.birthtimeNs.toString(),
    physical: `${stat.dev}:${stat.ino}`, ...fields }
}
function verifyFiles(manifest) {
  for (const original of manifest) {
    const actual = describeFile(original.path, original.kind)
    for (const key of ['bytes', 'sha256', 'mtimeNs', 'physical']) assert.equal(actual[key], original[key], `${key} changed: ${original.path}`)
  }
}
function makeFiles(directory, arialPath) {
  const roots = [path.join(directory, 'font-root-a'), path.join(directory, 'font-root-b')]
  const targetRoot = path.join(directory, 'controlled-installed-copies')
  for (const dir of [...roots, targetRoot]) fs.mkdirSync(dir, { recursive: true })
  const original = describeFile(arialPath, 'read-only-system-input')
  assert(original.bytes > 4)
  const sources = [], targets = []
  const copy = (target, kind, fields) => {
    assert(inside(directory, target), 'fixture copy escaped its private root')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(arialPath, target, fs.constants.COPYFILE_EXCL)
    const time = new Date('2026-01-01T00:00:00.000Z')
    fs.utimesSync(target, time, time)
    return describeFile(target, kind, fields)
  }
  for (let group = 0; group < WORKLOAD.targetFiles; group++) {
    const nameCandidate = `HFMFixtureGroup${String(group).padStart(3, '0')}`
    targets.push(copy(path.join(targetRoot, `candidate-${group}.ttf`), 'actual-independent-target-copy', { group, nameCandidate }))
    for (let member = 0; member < WORKLOAD.sourcesPerTarget; member++) {
      const index = group * WORKLOAD.sourcesPerTarget + member
      sources.push(copy(path.join(roots[group % 2], `group-${group}`, `source-${index}.ttf`), 'actual-source-copy', { group, index, nameCandidate }))
    }
  }
  assert.equal(new Set([...sources, ...targets].map(row => row.physical)).size, WORKLOAD.sourceFiles + WORKLOAD.targetFiles,
    'copies must be independent physical files, never hard links')
  const manifest = { createdAt: new Date().toISOString(), workload: WORKLOAD, original, roots, targetRoot, sources, targets,
    actualSourceBytes: sources.reduce((n,row) => n+row.bytes, 0), actualTargetBytes: targets.reduce((n,row) => n+row.bytes, 0),
    expectedUniqueHashFiles: sources.length + targets.length,
    expectedUniqueLogicalHashBytes: [...sources, ...targets].reduce((n,row) => n+row.bytes, 0),
    metadataDisclaimer: 'All actual file content is Arial. Group names are controlled comparison metadata, not modified internal names. 5234 no-candidate rows are synthetic metadata, not real source files.' }
  save(path.join(directory, 'immutable-fixture-manifest.json'), manifest)
  return manifest
}

// Build concrete identifiers with production code, not a duplicate ID algorithm.
// This setup runs before measurement and performs no real font-system mutation.
async function makeItems(currentRoot, fixture, hostModule) {
  assert.equal(typeof hostModule.createHost, 'function', 'projection host must export createHost')
  const host = await hostModule.createHost({ sourceRoot: currentRoot, workerPath: fixture.workerPath,
    directory: path.join(fixture.directory, 'metadata-preparation'), fixtureDirectory: fixture.directory,
    roots: fixture.manifest.roots })
  try {
    const identity = host.load('src/main/fonts/fontFileIdentity.ts')
    const fonts = host.load('src/main/fonts/fontRuntime.ts')
    const parsed = await fonts.fontItemFromPath(fixture.manifest.sources[0].path)
    const make = (file, name, index, kind) => {
      const stat = kind === 'real' ? fs.statSync(file) : fs.statSync(fixture.manifest.sources[0].path)
      return { ...parsed, id: identity.fileRuntimeFontId(file, stat.size, stat.mtimeMs), sourceId: `fixture-${index}`,
        path: file, fileName: path.basename(file), family: name, fullName: name, postscriptName: name,
        fileSize: stat.size, modifiedAt: stat.mtimeMs, createdAt: stat.birthtimeMs,
        fileAvailability: 'available', installStatusKnown: false, installed: false, systemInstalled: false,
        systemInstallMatches: [], localTagNames: index < 26 ? ['FixtureTag'] : [], tagNames: [],
        recoveryContentHash: undefined, recoveryFileStamp: undefined }
    }
    const sources = fixture.manifest.sources.map((entry, index) => make(entry.path, entry.nameCandidate, index, 'real'))
    const synthetic = Array.from({ length: WORKLOAD.metadataOnly }, (_, index) => make(
      path.join(fixture.manifest.roots[index % 2], 'metadata-only', `unmatched-${index}.ttf`),
      `HFMUnmatchedMetadata${String(index).padStart(6, '0')}`, WORKLOAD.sourceFiles + index, 'metadata-only'))
    const items = [...sources, ...synthetic]
    assert.equal(items.length, WORKLOAD.validIndexed)
    assert.equal(new Set(items.map(item => item.id)).size, WORKLOAD.validIndexed)
    const invalid = { ...sources[0], id: 'invalid-display-fixture', path: 'relative-invalid.ttf', fileName: 'relative-invalid.ttf',
      family: 'HFMInvalidDisplay', fullName: 'HFMInvalidDisplay', postscriptName: 'HFMInvalidDisplay' }
    assert.throws(() => identity.fileRuntimeFontId(invalid.path, invalid.fileSize, invalid.modifiedAt))
    const installedRecords = fixture.manifest.targets.map(entry => ({ source: 'HKCU', path: entry.path, value: entry.path,
      fileName: path.basename(entry.path), registryName: `${entry.nameCandidate} (TrueType)`, nameCandidates: [entry.nameCandidate] }))
    save(path.join(fixture.directory, 'metadata-population.json'), { validIndexed: items.length, invalid,
      controlledRegisteredTargets: installedRecords, items })
    return { items, invalid, installedRecords, sourceItems: sources, byId: new Map(items.map(item => [item.id, item])) }
  } finally { await host.close() }
}

// Observers wrap real owners and return their original values. They never decide
// business state, replace SQL, insert latency or replace native transport results.
function instrument(host, fixture) {
  const scope = new AsyncLocalStorage()
  const ioScope = host.load('src/main/path/sharedFileSystemRuntime.ts')
  const content = host.load('src/main/fonts/fontContentIdentityRuntime.ts')
  const originalRead = content.readFontContentIdentity
  const evidence = host.load('src/main/install/fontInstallEvidenceRuntime.ts')
  const originalSession = evidence.createFontInstallEvidenceSession
  const pool = host.load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime()
  const originalRun = pool.run
  let backgroundAdmissions=0,backgroundFinished=false
  const backgroundWaiters=[]
  const waitForBackgroundAdmission=count=>{
    if(backgroundAdmissions>=count)return Promise.resolve()
    if(backgroundFinished)return Promise.reject(Error(`Refresh ended before real evidence admission ${count}`))
    return new Promise((resolve,reject)=>backgroundWaiters.push({count,resolve,reject}))
  }
  const finishBackground=()=>{backgroundFinished=true;for(const waiter of backgroundWaiters.splice(0))waiter.reject(Error(`Refresh ended before real evidence admission ${waiter.count}`))}
  const counters = { hashes: [], processes: [], work: [], confirmations: 0, activeEvidence: 0, maxEvidence: 0,
    activePreview: 0, maxPreview: 0, foregroundBrowseHashes: 0, foregroundQueueMs: [], foregroundEndToEndMs: [],
    logicalHashBytes: 0, transferredSourceBytes: 0, nativeHashedBytes: 0, tasks: 0, invalidationCalls: 0 }
  const hashStart = (file, lane) => ({ file, lane, startedAt: performance.now(), error: null })
  content.readFontContentIdentity = async function(file, ...args) {
    const ownedScope = scope.getStore()
    const priority = ioScope.currentSharedIoPriority?.()
    const lane = priority === 'background' && ownedScope?.lane === 'foreground-browse' ? 'background-history-capture' : (ownedScope?.lane || 'unscoped')
    const row = hashStart(file, lane); counters.hashes.push(row)
    if (lane === 'foreground-browse' && ownedScope?.active) counters.foregroundBrowseHashes++
    try { const value = await originalRead(file, ...args); row.size = value.size; row.sha256 = value.sha256;
      counters.logicalHashBytes += value.size; return value }
    catch (error) { row.error = errorInfo(error); throw error }
    finally { row.elapsedMs = performance.now()-row.startedAt }
  }
  evidence.createFontInstallEvidenceSession = function(...args) {
    const session = originalSession(...args), confirm = session.confirm
    session.confirm = async (...input) => {
      counters.confirmations++; counters.activeEvidence++; counters.maxEvidence = Math.max(counters.maxEvidence, counters.activeEvidence)
      try { return await confirm(...input) } finally { counters.activeEvidence-- }
    }
    return session
  }
  pool.run = function(request) {
    const inherited = scope.getStore()?.lane || 'unscoped'
    const lane = ioScope.currentSharedIoPriority?.() === 'background' && inherited === 'foreground-browse' ? 'background-history-capture' : inherited
    const row = { lane, label: request.label, startedAt: performance.now() }
    let input
    const inputAt = request.args?.indexOf('--input')
    if (inputAt >= 0) {
      input = host.inputMetadata?.get(String(request.args[inputAt+1]))
      if (input) { row.operation = input.operation; row.path = input.path }
    }
    counters.tasks++
    if(lane==='background-refresh' && (input?.operation==='fontContentIdentity'||input?.operation==='readFile'&&/\.(ttf|otf|ttc|otc)$/i.test(input.path))){
      backgroundAdmissions++
      for(let i=backgroundWaiters.length-1;i>=0;i--)if(backgroundAdmissions>=backgroundWaiters[i].count)backgroundWaiters.splice(i,1)[0].resolve()
    }
    return originalRun.call(pool, request).then(receipt => {
      row.queuedMs = receipt.queuedMs; row.executionMs = receipt.executionMs
      if (lane.startsWith('foreground')) counters.foregroundQueueMs.push(Number(receipt.queuedMs || 0))
      try {
        const result = JSON.parse(receipt.stdout.trim().split(/\r?\n/).find(Boolean))
        if (input?.operation === 'fontContentIdentity') counters.nativeHashedBytes += Number(result.value?.readBytes || 0)
        if (input?.operation === 'readFile' && /\.(ttf|otf|ttc|otc)$/i.test(input.path)) {
          const transfer = input.transferPath
          if (transfer && fs.existsSync(transfer)) counters.transferredSourceBytes += fs.statSync(transfer).size
        }
      } catch {}
      return receipt
    }, error => { row.error = errorInfo(error); throw error }).finally(() => {
      row.elapsedMs = performance.now()-row.startedAt; counters.processes.push(row)
    })
  }
  const runScope = (lane, fn) => { const owned = { lane, active: true }; return scope.run(owned, async () => { try { return await fn() } finally { owned.active = false } }) }
  return { counters, pool, runScope, waitForBackgroundAdmission, finishBackground,
    snapshot: () => ({ hashes: counters.hashes, processRequests: counters.processes,
      confirmations: counters.confirmations, maxEvidence: counters.maxEvidence, maxPreview: counters.maxPreview,
      failedOrCancelledIdentityReads: counters.hashes.filter(row => row.error).length,
      unknownFailedReadBytes: counters.hashes.some(row => row.error) ? 'unknown; failed/cancelled work may have consumed font bytes before a receipt' : 0,
      byteScope: 'Successful full-identity receipt bytes only; not complete physical disk/NAS IO. Failed reads, SQLite pages and rendering internals are not measured here.',
      foregroundBrowseHashes: counters.foregroundBrowseHashes, foregroundQueue: summarize(counters.foregroundQueueMs),
      foregroundEndToEnd: summarize(counters.foregroundEndToEndMs), logicalHashBytes: counters.logicalHashBytes,
      transferredSourceBytes: counters.transferredSourceBytes, nativeHashedBytes: counters.nativeHashedBytes,
      tasks: counters.tasks, invalidationCalls: counters.invalidationCalls, pool: plain(pool.status()), observer: host.observer?.snapshot?.() }),
    restore() { content.readFontContentIdentity = originalRead; evidence.createFontInstallEvidenceSession = originalSession; pool.run = originalRun } }
}

function createRunner(host, population, hooks = {}) {
  const compare = host.load('src/main/install/fontInstallCompare.ts').createInstallCompareRuntime({ appName: 'HFMFixture' })
  const writer = host.statusWriter || { saveInstallStatusIndex: host.status.saveInstallStatusIndex, installStatusProjectionOwnedByWriter: false }
  const deps = {
    ...host.status, installStatusProjectionOwnedByWriter: writer.installStatusProjectionOwnedByWriter,
    appName: 'HFMFixture', appWatchedFolders: async () => host.rootPaths,
    loadSharedFontsForFolders: async roots => {
      const real = await host.loadSharedFontsForFolders(roots)
      assert.equal(real.length, WORKLOAD.validIndexed, 'production root load population differs')
      return population.includeInvalid ? [...real, population.invalid] : real
    },
    readTemporaryActiveFonts: async () => ({ records: [] }),
    getSystemInstalledFontsCached: async () => plain(population.installedRecords),
    runRustInstallStatusCompare: input => host.metadata.runRustInstallStatusCompare(input),
    buildInstalledFontLookupIndex: compare.buildInstalledFontLookupIndex,
    compareFontInstalledWithLookupIndex: compare.compareFontInstalledWithLookupIndex,
    rootForFontPath: host.status.rootForFontPath,
    syncMergedIndexAfterInstallStatusRefresh: (...args) => host.query.syncMergedIndexAfterInstallStatusRefresh(...args),
    clearFontQueryCaches: () => host.query.clearFontQueryCaches(),
    emitInstallStatusProgress: event => { hooks.onProgress?.(plain(event)) },
    waitForRendererIdle: host.interaction.waitForRendererIdle,
    delayToEventLoop: tick,
    withGlobalIo: host.withGlobalIo,
    execFileAsync: async () => { throw new Error('Unexpected real OS enumeration port: controlled snapshot must be used') },
    windowsFontsDir: () => population.targetRoot, currentUserFontsDir: () => population.targetRoot,
    fontExtensions: new Set(['.ttf']), appendStartupLog: host.appendStartupLog,
  }
  const realSave = writer.saveInstallStatusIndex
  deps.saveInstallStatusIndex = async (results, items, options) => {
    await hooks.beforeSave?.({ results, items, options, status: host.status })
    const sqlBefore = host.sqlCounters ? { ...host.sqlCounters } : undefined
    let persistedIds
    await realSave(results, items, { ...options, onPersisted: ids => { persistedIds = [...ids]; options?.onPersisted?.(ids) } })
    const sqlAfter = host.sqlCounters ? { ...host.sqlCounters } : undefined
    const evidence = { results, items, options, status: host.status, persistedIds, sqlBefore, sqlAfter }
    if (hooks.afterSave) await hooks.afterSave(evidence)
    else if (host.verifyCommittedBatches) host.verifyCommittedBatches.push(await verifyCommittedBatch(host, evidence, true))
  }
  return host.load('src/main/install/refresh/installStatusRefreshRunner.ts').createInstallStatusRefreshRunner(deps, {
    installStatusRefreshBatchSize: 500, lightweightMissingThreshold: 32,
    readSystemInstalledFontsLightweight: async () => plain(population.installedRecords),
  })
}

function pageRequest(kind, sequence) {
  return { sidebarPage: kind === 'tags' ? 'tags' : 'library', selectedTagName: kind === 'tags' ? 'FixtureTag' : '',
    activeFilter: { kind: kind === 'tags' ? 'all' : kind }, installStatus: 'all', sortMode: 'nameAsc', offset: 0, limit: 100,
    diagnosticRequestSequence: sequence }
}
async function readProjection(host, expected, label) {
  const [all, installed, notInstalled, metrics] = await Promise.all([
    host.query.queryFontPageInLibrary(pageRequest('all', -1)), host.query.queryFontPageInLibrary(pageRequest('installed', -1)),
    host.query.queryFontPageInLibrary(pageRequest('notInstalled', -1)), host.query.getFontMetricsFromLibrary(),
  ])
  assert.equal(all.workerMode, 'rust-merged-index-page', `${label}: fallback/fake page`)
  assert.equal(metrics.workerMode, 'rust-merged-index-metrics', `${label}: fallback/fake metrics`)
  assert.equal(all.total, WORKLOAD.validIndexed)
  assert.equal(metrics.total, WORKLOAD.validIndexed)
  assert.equal(installed.total, metrics.installedCount)
  assert.equal(notInstalled.total, metrics.notInstalledCount)
  assert.equal(metrics.installedCount + metrics.notInstalledCount + metrics.installStatusMissingCount, metrics.total)
  if (expected) for (const [key, value] of Object.entries(expected)) assert.equal(metrics[key], value, `${label}: ${key}`)
  return { all: all.total, installed: installed.total, notInstalled: notInstalled.total,
    unknown: metrics.installStatusMissingCount, metrics: plain(metrics), revisions: plain(host.projectionEvents || []) }
}

async function interleave(host, meter, fixture, caseDirectory) {
  const results = [], previews = [], queries = [], enumeration = []
  const preview = host.load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({
    ...host.transport, appendStartupLog: host.appendStartupLog,
  })
  const io = host.load('src/main/path/sharedFileSystemRuntime.ts')
  const kinds = ['all', 'installed', 'notInstalled', 'tags']
  let submissionError
  try { for (let index = 0; index < WORKLOAD.foregroundQueries; index++) {
    if(index%4===0)await meter.waitForBackgroundAdmission([1,73,145,217][index/4])
    queries.push(meter.runScope('foreground-browse', async () => {
      const start = performance.now()
      host.interaction.markRendererUserActivity(undefined, 'benchmark-query')
      try {
        const value = await host.query.queryFontPageInLibrary(pageRequest(kinds[index % kinds.length], index))
        if (kinds[index % kinds.length] !== 'tags') assert.equal(value.workerMode, 'rust-merged-index-page')
        results.push({ index, kind: kinds[index % kinds.length], total: value.total, workerMode: value.workerMode, startedAt:start,finishedAt:performance.now(),elapsedMs:performance.now()-start })
      } finally { meter.counters.foregroundEndToEndMs.push(performance.now()-start) }
    }))
    if (index < WORKLOAD.nativePreviews) {
      previews.push(meter.runScope('foreground-preview', async () => {
        const startedAt=performance.now()
        meter.counters.activePreview++; meter.counters.maxPreview = Math.max(meter.counters.maxPreview, meter.counters.activePreview)
        const font = fixture.sourceItems[index], output = path.join(caseDirectory, `visible-${index}.png`)
        try {
          const value = await preview.runRustPreviewRenderImage({ fontPath: font.path, text: 'HFM Preview Aa 123',
            fontSize: 36, width: 600, height: 100, outputPath: output,
            preferSystemFont: false })
          assert(value?.ok, `native source preview ${index} failed`)
          const bytes = fs.readFileSync(output)
          assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a')
          assert(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0)
          return { index, output, bytes: bytes.length, sha256: sha256(bytes), receipt: plain(value),startedAt,finishedAt:performance.now(),elapsedMs:performance.now()-startedAt }
        } finally { meter.counters.activePreview-- }
      }))
    }
    if ([0,4,8,12].includes(index)) enumeration.push(meter.runScope('foreground-enumeration', async () => {
      const receipt = await io.executeSharedFile({ operation: 'treeSnapshot', path: host.rootPaths[(index / 4) % 2] })
      assert(receipt.result?.ok && typeof receipt.result.value === 'object')
      return { index, paths: Object.keys(receipt.result.value).length }
    }))
    for(const pending of [queries.at(-1),previews.at(-1),enumeration.at(-1)])pending?.catch(()=>undefined)
    if (index === 5 || index === 11) { meter.counters.invalidationCalls++; host.query.clearFontQueryCaches() }
    await tick()
  }
  } catch(error) { submissionError=error }
  const settled = await Promise.allSettled([...queries, ...previews, ...enumeration])
  const failures = settled.filter(row => row.status === 'rejected').map(row => errorInfo(row.reason));if(submissionError)failures.push(errorInfo(submissionError))
  return { queries: results.sort((a,b) => a.index-b.index), previewReceipts: settled.slice(queries.length,queries.length+previews.length)
    .filter(row => row.status === 'fulfilled').map(row => row.value), enumeration: settled.slice(queries.length+previews.length)
    .filter(row => row.status === 'fulfilled').map(row => row.value), failures }
}

async function openCase(config, fixture, caseId, sourceRoot, options = {}) {
  const directory = path.join(config.output, 'cases', caseId)
  fs.mkdirSync(directory, { recursive: true })
  const { createObserver } = require(path.join(config.currentRoot, 'build/diagnostics/lib/operation-work-performance.cjs'))
  const observer = createObserver(), inputMetadata = new Map()
  const observedFs = observer.fs, observedPromises = observedFs.promises
  const recordedPromises = new Proxy(observedPromises, { get(target, key) {
    const member = Reflect.get(target, key)
    if (key === 'writeFile') return async (...args) => {
      if (typeof args[0] === 'string' && path.basename(args[0]).startsWith('hfm-shared-file-input')) {
        try { inputMetadata.set(args[0], JSON.parse(String(args[1]))) } catch {}
      }
      return member(...args)
    }
    if (key === 'rm' || key === 'unlink') return async (...args) => { try { return await member(...args) } finally { inputMetadata.delete(String(args[0])) } }
    return typeof member === 'function' ? member.bind(target) : member
  } })
  observer.fs = new Proxy(observedFs, { get(target, key) { return key === 'promises' ? recordedPromises : Reflect.get(target, key) } })
  const selectedWorker = sourceRoot === config.baselineRoot ? config.baselineWorkerPath : config.workerPath
  const host = await config.hostModule.createHost({ sourceRoot, workerPath: selectedWorker, directory, observe: observer,
    fixtureDirectory: fixture.directory, fixture: { rootPaths: fixture.manifest.roots, roots: fixture.manifest.roots, items: fixture.items },
    onProjectionCommitted: options.onProjectionCommitted })
  liveHosts.add(host)
  host.inputMetadata = inputMetadata
  try {
  host.interaction = host.load('src/main/performance/rendererInteractionRuntime.ts').createRendererInteractionRuntime({ appendLog: host.appendStartupLog, onActivity: () => { host.globalIo?.recheckGlobalIoQueues(); host.transport.noteRustCoreSchedulerInteractiveActivity('benchmark-foreground') } })
  host.globalIo = host.load('src/main/performance/globalIoRuntime.ts').createGlobalIoRuntime({ env: process.env, localScanWorkers: 2, appendLog: host.appendStartupLog, isIndexingActive: () => false, isUserActive: host.interaction.isRendererUserActive, storageProfileForPath: file => ({ rootPath: path.parse(file).root, type: 'ssd', reason: 'isolated-real-local-fixture', isNetwork: false }) })
  host.withGlobalIo = host.observer.global(host.globalIo)
  for (const field of ['load', 'status', 'query', 'metadata', 'transport', 'observer', 'loadSharedFontsForFolders', 'withGlobalIo', 'appendStartupLog', 'close']) assert(host[field], `missing production host: ${field}`)
  host.rootPaths ||= fixture.manifest.roots
  await host.initialize(fixture.items, { legacyRows: WORKLOAD.legacyRows, oldProjection: true })
  const routing = host.load('src/main/rust-core/rustSharedIoCommandRuntime.ts')
  for (const root of [...host.rootPaths, fixture.manifest.targetRoot]) routing.registerIsolatedRoot(root)
  const writer = await host.load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts').createLocalFontTagNodePersistenceRuntime(host.openLibraryDb).openWriter()
  const tags = writer.setLocalFontTagsBatch(fixture.sourceItems.slice(0,26).map(item => ({ item, tagNames: ['FixtureTag'] })), new Date().toISOString())
  assert.equal(tags.failed.length, 0, 'setup tag assignment failed')
  await host.query.checkMergedIndexExternalChanges('benchmark-production-bootstrap')
  const meter = instrument(host, fixture)
  return { host, meter, directory }
  } catch (error) {
    try { await host.close() } finally { liveHosts.delete(host) }
    throw error
  }
}

function counterDelta(before, after) {
  if (!before || !after) return null
  const result = {}
  for (const key of Object.keys(after)) if (typeof after[key] === 'number') result[key] = after[key] - (before[key] || 0)
  return result
}

async function verifyCommittedBatch(host, batch, strict) {
  const startedAt = performance.now()
  const db = host.openDb(host.paths.mergedPath)
  let raw
  try {
    raw = plain(db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN installed=1 AND COALESCE(installed_by,'')<>'managed' THEN 1 ELSE 0 END) AS installed,
      SUM(CASE WHEN installed=0 OR installed_by='managed' THEN 1 ELSE 0 END) AS notInstalled,
      SUM(CASE WHEN installed IS NULL THEN 1 ELSE 0 END) AS unknown
      FROM entries WHERE COALESCE(is_deleted,0)=0 AND status='ok' AND json_valid(font_json)`).get())
  } finally { host.closeSqliteDb(db) }
  const evidence = { requested: Object.keys(batch.results).length, persistedIds: batch.persistedIds,
    independentSql: raw, work: counterDelta(batch.sqlBefore, batch.sqlAfter), converged: false }
  try {
    evidence.observed = await readProjection(host, null, 'committed-batch')
    assert.equal(raw.total, WORKLOAD.validIndexed)
    assert.equal(raw.installed + raw.notInstalled + raw.unknown, raw.total)
    assert.deepEqual([evidence.observed.all, evidence.observed.installed, evidence.observed.notInstalled, evidence.observed.unknown],
      [raw.total, raw.installed, raw.notInstalled, raw.unknown], 'Committed SQL/page/metrics did not converge')
    evidence.converged = true
  } catch (error) { evidence.convergenceFailure = errorInfo(error); if (strict) throw Object.assign(error, { batchEvidence: evidence }) }
  if (strict) {
    assert.equal(host.statusWriter?.installStatusProjectionOwnedByWriter, true, 'Candidate bypassed central projection writer')
    assert(evidence.work, 'Independent SQL/UDF counters are required, not only self-reported projection logs')
    assert.equal(evidence.work.projectionSelectCalls, 1, 'Projection did not use one population-mapping SELECT per batch')
    assert.equal(evidence.work.projectionExaminedRows, WORKLOAD.validIndexed, 'Projection row examination differs from one5490-row pass')
    assert(evidence.work.projectionUpdateCalls <= evidence.requested, 'Projection ran more updates than requested rows')
    assert.equal(evidence.work.projectionIndexedUpdateCalls, evidence.work.projectionUpdateCalls,
      'Projection UPDATE used per-item whole-table identity expressions instead of root/relative keyed targets')
    assert.equal(evidence.work.projectionIdentityUdfCalls, 0, 'Projection UPDATE invoked identity UDF per row/item')
  }
  evidence.verificationElapsedMs = performance.now()-startedAt
  return evidence
}

async function runPerformance(config, fixture, caseId, sourceRoot, changed) {
  const report = { caseId, changed, sourceRoot, sourceSha: git(sourceRoot, 'rev-parse', 'HEAD'), workerSha256: changed ? config.workerSha256 : config.baselineWorkerSha256,
    lane: 'real-performance-valid-population', injectedLatency: false, attemptedPopulation: WORKLOAD.validIndexed, indexedPopulation: WORKLOAD.validIndexed,
    failure: null, foreground: null, summary: null, fullRefreshMs: null, work: null }
  let resource, finished = false
  const progress = [], committedBatches = []
  try {
    resource = await openCase(config, fixture, caseId, sourceRoot)
    const { host, meter, directory } = resource
    report.readerProvenance = host.readerProvenance
    report.initialization = 'Unversioned legacy state seeded, then actual production external-change rebuild before timed comparable lane; raw-old snapshot refusal is a separate correctness diagnostic.'
    const runner = createRunner(host, { ...fixture, includeInvalid: false, targetRoot: fixture.manifest.targetRoot }, {
      onProgress: value => progress.push(value), afterSave: async batch => { committedBatches.push(await verifyCommittedBatch(host, batch, changed)) } })
    const start = performance.now()
    const refresh = meter.runScope('background-refresh', () => runner.refreshInstallStatusIndex({ force: true }, { jobId: caseId, emitProgress: true }))
      .then(value => { report.summary = plain(value); report.fullRefreshMs = performance.now()-start; finished = true; meter.finishBackground(); return value },
        error => { report.fullRefreshMs = performance.now()-start; finished = true; meter.finishBackground(); throw error })
    refresh.catch(() => undefined)
    const foreground = interleave(host, meter, fixture, directory)
    const outcomes = await Promise.allSettled([refresh, foreground])
    if (outcomes[1].status === 'fulfilled') report.foreground = outcomes[1].value
    else report.foregroundFailure = errorInfo(outcomes[1].reason)
    if (outcomes[0].status === 'rejected') throw outcomes[0].reason
    assert(finished && progress.some(row => row.stage === 'done'), 'refresh did not reach production done')
    assert.equal(report.summary.total, WORKLOAD.validIndexed)
    assert.equal(report.summary.updatedCount, WORKLOAD.validIndexed)
    assert.equal(report.summary.installedCount, WORKLOAD.sourceFiles)
    assert.equal(report.summary.notInstalledCount, WORKLOAD.metadataOnly)
    assert.equal(report.summary.missingCount, 0)
    report.finalProjection = await readProjection(host, { installedCount: WORKLOAD.sourceFiles,
      notInstalledCount: WORKLOAD.metadataOnly, installStatusMissingCount: 0 }, 'complete-refresh')
    await meter.pool.whenIdle()
    report.work = meter.snapshot()
    assert.equal(report.work.pool.metrics.started, report.work.pool.metrics.closed, 'Shared process starts/closes differ after complete workload')
    assert.equal(report.work.pool.pids.length, 0, 'Shared process still active after complete workload')
    if (changed) {
      assert.equal(report.work.foregroundBrowseHashes, 0, 'browse critical path hashed whole font bytes')
      assert(report.work.maxEvidence <= WORKLOAD.evidenceConcurrency, 'background confirmations exceeded bound')
      assert(report.work.maxPreview <= WORKLOAD.previewConcurrency)
      const identity = report.work.processRequests.filter(row => row.operation === 'fontContentIdentity' && row.lane === 'background-refresh')
      assert.equal(identity.length, fixture.manifest.expectedUniqueHashFiles, 'identity calls do not match unique256+32 files')
      assert.equal(new Set(identity.map(row => path.normalize(row.path).toLowerCase())).size, identity.length, 'same-operation duplicate identity process')
      const refreshHashes = report.work.hashes.filter(row => row.lane === 'background-refresh' && !row.error)
      assert.equal(refreshHashes.reduce((n,row) => n+row.size, 0), fixture.manifest.expectedUniqueLogicalHashBytes)
      report.refreshLogicalHashBytes = refreshHashes.reduce((n,row) => n+row.size, 0)
    }
    const backgroundReads=report.work.processRequests.filter(row=>row.lane==='background-refresh'&&!row.error&&(row.operation==='fontContentIdentity'||row.operation==='readFile'&&/\.(ttf|otf|ttc|otc)$/i.test(row.path)))
    const overlap=report.foreground.queries.filter(query=>backgroundReads.some(read=>query.startedAt<read.startedAt+Number(read.queuedMs||0)+Number(read.executionMs||0)&&query.finishedAt>read.startedAt+Number(read.queuedMs||0)))
    report.contentionOverlap={foregroundQueries:overlap.map(row=>row.index),requiredEvidenceAdmissions:[1,73,145,217],actualBackgroundReads:backgroundReads.length}
    assert(overlap.length>=4,'Foreground did not overlap real background font reads; contention is non-comparable')
    report.previewEndToEnd=summarize(report.foreground.previewReceipts.map(row=>row.elapsedMs))
    assert.equal(report.foreground.failures.length, 0, 'foreground workload failed; timings are not comparable')
    report.comparable = true
    report.passed = true
  } catch (error) { report.failure = errorInfo(error); report.passed = false; report.comparable = false }
  finally {
    report.progress = progress
    report.committedBatches = committedBatches
    report.batchVerificationElapsedMs = committedBatches.reduce((n,row) => n+(row.verificationElapsedMs || 0),0)
    report.timingIncludesSameAuditReadsInBothVersions = true
    if (resource) {
      report.work ||= resource.meter.snapshot()
      resource.meter.restore()
      try { await resource.host.close(); liveHosts.delete(resource.host) } catch (error) { report.cleanupFailure = errorInfo(error); report.passed = false; report.comparable = false }
      report.childrenAfterClose = resource.host.observer.children.size
      if (report.childrenAfterClose !== 0) { report.passed = false; report.comparable = false }
      const log = (resource.host.logs || []).join('\n')
      report.logLines = resource.host.logs?.length || 0; report.logBytes = Buffer.byteLength(log)
      fs.writeFileSync(path.join(resource.directory, 'operation.log'), log)
    }
    verifyFiles([fixture.manifest.original, ...fixture.manifest.sources, ...fixture.manifest.targets])
    save(path.join(config.output, 'cases', caseId, 'report.json'), report)
  }
  return report
}

async function runCorrectness(config, fixture, caseId, sourceRoot, test) {
  const report = { caseId, sourceSha: git(sourceRoot, 'rev-parse', 'HEAD'), lane: 'correctness-only-fault-injection',
    excludedFromTimingComparison: true, indexedPopulation: WORKLOAD.validIndexed, attemptedPopulation: WORKLOAD.validIndexed, passed: false }
  let resource
  try {
    resource = await openCase(config, fixture, caseId, sourceRoot)
    report.readerProvenance = resource.host.readerProvenance
    if (sourceRoot === config.currentRoot) resource.host.verifyCommittedBatches = []
    await test(resource, report)
    report.committedBatches = resource.host.verifyCommittedBatches || []
    await resource.meter.pool.whenIdle()
    report.passed = true
  } catch (error) { report.failure = errorInfo(error) }
  finally {
    if (resource) {
      report.work = resource.meter.snapshot()
      resource.meter.restore()
      try { await resource.host.close(); liveHosts.delete(resource.host) } catch (error) { report.cleanupFailure = errorInfo(error); report.passed = false }
      report.childrenAfterClose = resource.host.observer.children.size
      if (report.childrenAfterClose) report.passed = false
    }
    verifyFiles([fixture.manifest.original, ...fixture.manifest.sources, ...fixture.manifest.targets])
    save(path.join(config.output, 'cases', caseId, 'report.json'), report)
  }
  return report
}

async function originalInvalidFailure(resource, report, fixture) {
  const { host } = resource
  const valid = fixture.sourceItems.slice(0, 2)
  const known = Object.fromEntries(valid.map(item => [item.id, { installed: true, known: true, by: 'user', matches: [fixture.installedRecords[Math.floor(fixture.sourceItems.indexOf(item)/8)]] }]))
  await host.status.saveInstallStatusIndex(known, new Map(valid.map(item => [item.id, item])), { completeTasks: false })
  const mixed = await host.status.readInstallStatusIndex([valid[0], fixture.invalid, valid[1]], { enqueueMissTasks: false })
  report.attemptedPopulation = 3; report.validControlRows = 2; report.invalidDisplayRows = 1
  report.actual = { results: plain(mixed.results), misses: mixed.misses.map(item => item.id) }
  report.originalFailurePreserved = !mixed.results[valid[0].id] || !mixed.results[valid[1].id]
  assert(report.originalFailurePreserved, 'The immutable original malformed-row failure did not reproduce; inspect before comparing')
  report.expectedOriginalFailure = true
}

async function invalidComplete(resource, report, fixture) {
  const { host, meter } = resource, progress = []
  report.attemptedPopulation = WORKLOAD.attemptedCorrectness
  report.invalidInputPort = 'Labeled refresh load wrapper appends one malformed display row after actual5490 production root rows; SQL untouched'
  const runner = createRunner(host, { ...fixture, includeInvalid: true, targetRoot: fixture.manifest.targetRoot }, { onProgress: value => progress.push(value) })
  const value = await meter.runScope('background-refresh', () => runner.refreshInstallStatusIndex({ force: true }, { jobId: report.caseId, emitProgress: true }))
  assert.equal(value.total, WORKLOAD.attemptedCorrectness)
  assert.equal(value.updatedCount, WORKLOAD.attemptedCorrectness)
  assert.equal(value.installedCount, WORKLOAD.sourceFiles)
  assert.equal(value.notInstalledCount, WORKLOAD.metadataOnly)
  assert.equal(value.missingCount, 1)
  assert(progress.some(row => row.stage === 'done'))
  const mixed = await host.status.readInstallStatusIndex([fixture.sourceItems[0], fixture.invalid, fixture.sourceItems[1]], { enqueueMissTasks: false })
  assert.equal(mixed.results[fixture.sourceItems[0].id]?.installed, true)
  assert.equal(mixed.results[fixture.sourceItems[1].id]?.installed, true)
  assert(mixed.misses.some(item => item.id === fixture.invalid.id))
  report.summary = plain(value); report.progress = progress
  report.finalProjection = await readProjection(host, { installedCount: WORKLOAD.sourceFiles, notInstalledCount: WORKLOAD.metadataOnly,
    installStatusMissingCount: 0 }, 'invalid display isolated from actual valid projection')
}

async function newerStateDuringBatch(resource, report, fixture) {
  const { host, meter } = resource
  assert.equal(host.statusWriter?.installStatusProjectionOwnedByWriter, true, 'CAS test must use central projection writer')
  assert.equal(typeof host.status.installStatusWriteRevision, 'function', 'Candidate CAS revision API missing')
  const ready = deferred(), release = deferred(), target = fixture.sourceItems[0]
  let first = true, observedExpectedRevision
  const runner = createRunner(host, { ...fixture, includeInvalid: false, targetRoot: fixture.manifest.targetRoot }, {
    beforeSave: async batch => {
      if (!first) return
      first = false; observedExpectedRevision = batch.options?.expectedRevision
      assert(Number.isInteger(observedExpectedRevision), 'Background batch did not carry original revision')
      assert(batch.items.has(target.id), 'Paused batch did not contain target')
      ready.resolve(); await release.promise
    },
  })
  const running = meter.runScope('background-refresh', () => runner.refreshInstallStatusIndex({ force: true }, { jobId: report.caseId }))
  // Ensure a failed refresh cannot leave this correctness barrier waiting forever.
  const early = running.then(() => { throw new Error('Refresh completed without reaching pause') })
  await Promise.race([ready.promise, early])
  const unknown = { installed: false, known: false, by: 'none', matches: [], reason: 'controlled newer authoritative target became unavailable' }
  let concurrentFailure
  try {
    host.queue.scheduleActivationInstallStatusSave({ [target.id]: unknown }, new Map([[target.id, target]]), 'newer-target-during-background-batch')
    await host.queue.flushActivationInstallStatusSave('newer-target-during-background-batch')
    assert(host.status.installStatusWriteRevision() > observedExpectedRevision)
  } catch (error) { concurrentFailure = error } finally { release.resolve() }
  report.summary = plain(await running)
  if (concurrentFailure) throw concurrentFailure
  const read = await host.status.readInstallStatusIndex([target], { enqueueMissTasks: false })
  assert(!read.results[target.id] && read.misses.some(item => item.id === target.id), 'Old background batch overwrote newer unknown evidence')
  assert.equal(report.summary.updatedCount, WORKLOAD.validIndexed - 1, 'Skipped concurrent target incorrectly counted as persisted by background refresh')
  assert.equal(report.summary.missingCount, 1, 'Final runner summary reused stale computed results instead of persisted state')
  assert.equal(report.summary.installedCount, WORKLOAD.sourceFiles - 1)
  report.finalProjection = await readProjection(host, { installedCount: WORKLOAD.sourceFiles - 1,
    notInstalledCount: WORKLOAD.metadataOnly, installStatusMissingCount: 1 }, 'newer target survives paused old batch')
  report.expectedRevision = observedExpectedRevision
}

async function offlineMixed(resource, report, fixture) {
  const { host, meter } = resource
  const availability = host.load('src/main/path/startupPathAvailabilityRuntime.ts')
  const offlineRoot = host.rootPaths[0]
  // Explicit unavailable-root injection, not a timed network simulation.
  availability.markStartupPathRootUnavailable(offlineRoot, new Error('controlled correctness-only root offline'), host.appendStartupLog, 'benchmark-fault')
  const runner = createRunner(host, { ...fixture, includeInvalid: false, targetRoot: fixture.manifest.targetRoot })
  report.summary = plain(await meter.runScope('background-refresh', () => runner.refreshInstallStatusIndex({ force: true }, { jobId: report.caseId })))
  const offlineIds = new Set(fixture.items.filter(item => inside(offlineRoot, item.path)).map(item => item.id))
  const onlineSources = fixture.sourceItems.filter(item => !offlineIds.has(item.id)).length
  const snapshot = await host.status.readInstallStatusIndex(fixture.items, { enqueueMissTasks: false })
  for (const id of offlineIds) assert.equal(snapshot.results[id], undefined, 'Offline no-candidate item was classified definitely uninstalled')
  assert.equal(report.summary.total, WORKLOAD.validIndexed)
  assert.equal(report.summary.missingCount, offlineIds.size)
  assert.equal(report.summary.installedCount, onlineSources)
  const installedCount = onlineSources, notInstalledCount = WORKLOAD.validIndexed - offlineIds.size - onlineSources
  report.finalProjection = await readProjection(host, { installedCount, notInstalledCount,
    installStatusMissingCount: offlineIds.size }, 'offline and current online peers remain separate')
  report.offlinePopulation = offlineIds.size
}

async function unchangedParentChangedChild(resource, report, fixture) {
  const { host, meter } = resource
  const item = fixture.sourceItems[0], file = item.path, directory = path.dirname(file)
  const original = fs.readFileSync(file), stat = fs.statSync(file), parent = fs.statSync(directory)
  const directoryReader = host.load('src/main/path/sharedDirectoryMetadataRuntime.ts')
  const snapshotReader = host.load('src/main/path/sharedFileSystemRuntime.ts')
  const before = await directoryReader.readSharedDirectoryMetadata(directory)
  const treeBefore = await snapshotReader.executeSharedFile({ operation: 'treeSnapshot', path: directory })
  assert(before, 'Isolated root did not use real shared metadata transport')
  const beforeChild = before.entries.find(entry => entry.name === path.basename(file))
  assert(beforeChild?.stat)
  try {
    const changed = Buffer.from(original); changed[changed.length - 1] ^= 1
    fs.writeFileSync(file, changed)
    fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000))
    fs.utimesSync(directory, parent.atime, parent.mtime)
    const after = await directoryReader.readSharedDirectoryMetadata(directory)
    const treeAfter = await snapshotReader.executeSharedFile({ operation: 'treeSnapshot', path: directory })
    const afterChild = after.entries.find(entry => entry.name === path.basename(file))
    assert.equal(fs.statSync(directory).mtimeMs, parent.mtimeMs, 'Parent timestamp preservation failed')
    assert.notEqual(afterChild.stat.mtimeMs, beforeChild.stat.mtimeMs, 'Fresh native enumeration reused stale child attributes')
    assert.notDeepEqual(treeAfter.result.value, treeBefore.result.value)
    const content = host.load('src/main/fonts/fontContentIdentityRuntime.ts')
    const current = await meter.runScope('correctness-changed-child', () => content.readFontContentIdentity(file))
    assert.notEqual(current.sha256, fixture.manifest.sources[0].sha256)
    assert.equal(current.sha256, sha256(changed))
    report.receipt = { parentMtimeUnchanged: true, childBefore: beforeChild.stat.mtimeMs, childAfter: afterChild.stat.mtimeMs,
      sourceSha256Before: fixture.manifest.sources[0].sha256, sourceSha256After: current.sha256,
      scope: 'Fresh production native directory metadata/tree snapshot and full content identity; not a claim of complete watcher event delivery' }
  } finally { fs.writeFileSync(file, original); fs.utimesSync(file, stat.atime, stat.mtime); fs.utimesSync(directory, parent.atime, parent.mtime) }
}

async function retiredQueryOwnership(resource, report) {
  const { host } = resource
  const io = host.load('src/main/path/sharedFileSystemRuntime.ts')
  const tasks = host.load('src/main/library/fontQueryTaskRuntime.ts')
  const cacheFactory = host.load('src/main/library/fontPageQueryCacheRuntime.ts')
  const started = deferred(), finishPhysical = deferred(), consumer = new AbortController()
  let calls = 0
  const cache = cacheFactory.createFontPageQueryCacheRuntime({ pageCacheMax: 4, pageCacheTtlMs: 1000,
    appendStartupLog: host.appendStartupLog,
    queryUncached: async () => {
      calls++; started.resolve()
      await finishPhysical.promise
      return { queryKey: 'synthetic-lifecycle-only', items: [], total: 0, offset: 0, limit: 1, engine: 'sql', elapsedMs: 0 }
    } })
  const old = io.withSharedIoSignal(consumer.signal, () => cache.queryFontPageInLibrary({ limit: 1, offset: 0 }))
  old.catch(() => undefined)
  await started.promise
  consumer.abort(); cache.invalidateFontQueryPageCache(); finishPhysical.resolve()
  await assert.rejects(old, error => error.reason === 'query-superseded')
  await tick(); await tick()
  assert.equal(calls, 1, 'A consumerless invalidated query automatically re-executed')
  const close = deferred(), rejectStarted = deferred()
  const task = tasks.createFontQueryTask(async () => {
    rejectStarted.resolve()
    throw Object.assign(new Error('controlled physical process rejection'), { closed: close.promise })
  })
  task.pending.catch(() => undefined)
  await rejectStarted.promise; await tick()
  assert.equal(task.settled, false, 'Owner was released before physical close')
  close.resolve(); await assert.rejects(task.pending)
  assert.equal(task.settled, true)
  report.scope = 'Supplementary production query task/cache lifecycle gate with controlled promises; not a SQL, file I/O or performance result'
  report.unconsumedAutomaticRetries = calls - 1
  report.physicalOwnerHeldUntilClose = true
}

function compareRuns(runs) {
  const baseline = runs.filter(row => !row.changed), changed = runs.filter(row => row.changed)
  if (runs.some(row => !row.passed || !row.comparable)) return { comparable: false,
    reason: 'One or more source versions failed the full real workload; no speedup claim is valid',
    failedCases: runs.filter(row => !row.passed || !row.comparable).map(row => ({ caseId: row.caseId, failure: row.failure || row.foregroundFailure })) }
  const upper = field => Math.max(...baseline.map(field))
  const queueP95Envelope = upper(row => row.work.foregroundQueue.p95Ms || 0)
  const queueMaxEnvelope = upper(row => row.work.foregroundQueue.maxMs || 0)
  const endToEndEnvelope = upper(row => row.fullRefreshMs)
  const foregroundP95Envelope=upper(row=>row.work.foregroundEndToEnd.p95Ms||0),foregroundMaxEnvelope=upper(row=>row.work.foregroundEndToEnd.maxMs||0)
  const previewP95Envelope=upper(row=>row.previewEndToEnd.p95Ms||0),previewMaxEnvelope=upper(row=>row.previewEndToEnd.maxMs||0)
  const results = changed.map(row => ({ caseId: row.caseId,
    foregroundP95NoRegression: (row.work.foregroundQueue.p95Ms || 0) <= queueP95Envelope,
    foregroundMaxNoRegression: (row.work.foregroundQueue.maxMs || 0) <= queueMaxEnvelope,
    completeDurationNoRegression: row.fullRefreshMs <= endToEndEnvelope,
    foregroundEndToEndP95NoRegression:(row.work.foregroundEndToEnd.p95Ms||0)<=foregroundP95Envelope,
    foregroundEndToEndMaxNoRegression:(row.work.foregroundEndToEnd.maxMs||0)<=foregroundMaxEnvelope,
    previewEndToEndP95NoRegression:(row.previewEndToEnd.p95Ms||0)<=previewP95Envelope,
    previewEndToEndMaxNoRegression:(row.previewEndToEnd.maxMs||0)<=previewMaxEnvelope }))
  return { comparable: true, sameWorker: false, nativeBinaryMatchesEachSourceVersion: true, sameFileManifest: true, syntheticLatency: false,
    timingEnvelopeSource: 'Actual same-job A1 and A2 observations, without fabricated machine-specific millisecond targets',
    baselineEnvelope: { queueP95Ms: queueP95Envelope, queueMaxMs: queueMaxEnvelope, fullRefreshMs: endToEndEnvelope,foregroundP95Ms:foregroundP95Envelope,foregroundMaxMs:foregroundMaxEnvelope,previewP95Ms:previewP95Envelope,previewMaxMs:previewMaxEnvelope },
    candidates: results, passed: results.every(row => row.foregroundP95NoRegression && row.foregroundMaxNoRegression && row.completeDurationNoRegression && row.foregroundEndToEndP95NoRegression && row.foregroundEndToEndMaxNoRegression && row.previewEndToEndP95NoRegression && row.previewEndToEndMaxNoRegression) }
}

async function main() {
  assert.equal(process.platform, 'win32', 'This artifact only executes on Windows; static preparation is not a run')
  const currentRoot = path.resolve(argument('--current-root', process.cwd()))
  const baselineRootArg = argument('--baseline-root')
  assert(baselineRootArg, 'Provide a pre-existing clean baseline6620b3b worktree; this script never changes repositories')
  const baselineRoot = path.resolve(baselineRootArg)
  assert.equal(git(baselineRoot, 'rev-parse', 'HEAD'), BASELINE)
  assert.equal(git(baselineRoot, 'status', '--porcelain', '--untracked-files=no'), '', 'Immutable baseline is dirty')
  const currentSha = git(currentRoot, 'rev-parse', 'HEAD')
  assert.equal(git(currentRoot, 'status', '--porcelain', '--untracked-files=no'), '', 'Candidate source must be committed before evidence run')
  const workerPath = path.resolve(argument('--worker', path.join(currentRoot, 'build/native/hfm-core-worker.exe')))
  const baselineWorkerArgument = argument('--baseline-worker')
  assert(baselineWorkerArgument, 'Provide a worker built from immutable6620b3b; candidate native binary must not be used for the baseline')
  const baselineWorkerPath = path.resolve(baselineWorkerArgument)
  assert(fs.statSync(baselineWorkerPath).isFile(), 'Baseline worker is missing')
  const hostPath = path.resolve(argument('--host', path.join(__dirname, 'lib/production-projection-host.cjs')))
  assert(fs.statSync(workerPath).isFile(), 'A candidate Windows worker built from current committed source is required; no auto-build')
  assert(fs.statSync(hostPath).isFile(), 'Reusable production projection host is a mandatory companion')
  const outputArg = argument('--output')
  const output = outputArg ? path.resolve(outputArg) : fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-full-refresh-evidence-'))
  fs.mkdirSync(output, { recursive: true })
  assert(!fs.existsSync(path.join(output, 'run-manifest.json')), 'Use a new output directory; prior evidence must not be overwritten')
  const config = { currentRoot, baselineRoot, currentSha, workerPath, workerSha256: sha256(fs.readFileSync(workerPath)), baselineWorkerPath, baselineWorkerSha256: sha256(fs.readFileSync(baselineWorkerPath)), hostPath,
    hostSha256: sha256(fs.readFileSync(hostPath)), hostModule: require(hostPath), output }
  const fixtureDirectory = path.join(output, 'immutable-font-fixture')
  fs.mkdirSync(fixtureDirectory, { recursive: true })
  const arial = path.resolve(argument('--font', path.join(process.env.WINDIR, 'Fonts', 'arial.ttf')))
  assert.equal(path.basename(arial).toLowerCase(), 'arial.ttf', 'Predeclared workload uses Arial; revise declared manifest to choose a different input')
  const manifest = makeFiles(fixtureDirectory, arial)
  let fixture = { directory: fixtureDirectory, manifest, workerPath }
  fixture = { ...fixture, ...await makeItems(currentRoot, fixture, config.hostModule) }
  save(path.join(output, 'run-manifest.json'), { baselineSha: BASELINE, currentSha, workerSha256: config.workerSha256,
    baselineWorkerSha256: config.baselineWorkerSha256, hostSha256: config.hostSha256, runtime: process.versions, logDetail: process.env.HFM_LOG_DETAIL || 'normal', workload: WORKLOAD, sourceManifestSha256: sha256(fs.readFileSync(path.join(fixtureDirectory, 'immutable-fixture-manifest.json'))),
    sourceVersionsSharePhysicalFiles: true, nativeBinaryShared: false, nativeBinaryMatchesEachSourceVersion: true, timedLanePopulation: WORKLOAD.validIndexed,
    correctnessAttemptedPopulation: WORKLOAD.attemptedCorrectness, actualInstalledTargetsArePrivateCopies: true,
    operatingSystemRegistryWrites: 0, realFontSystemChanges: 0, baselineInvalidRowExcludedFromBothTimedRuns: true,
    order: ['A1','B1','B2','A2'], timingMethod: 'ABBA same job, no injected latency, no clearing OS disk cache; cold/warm ordering reported',
    exclusions: ['real NAS/network timing', 'real Windows registry/installation', 'full Electron renderer paint/decode',
      'complete watcher event lifecycle (directory metadata/identity correctness has its own case)',
      'query lifecycle supplementary gate uses controlled promises and is never counted as a SQL/performance result'] })
  const report = { passed: false, baselineSha: BASELINE, currentSha, workerSha256: config.workerSha256, baselineWorkerSha256: config.baselineWorkerSha256,
    workload: WORKLOAD, performance: [], correctness: [], startedAt: new Date().toISOString() }
  // A watchdog is solely a hung-diagnostic safety stop, never a performance SLO.
  const watchdogMs = Number(argument('--watchdog-ms', 30 * 60 * 1000))
  assert(Number.isFinite(watchdogMs) && watchdogMs >= 60000)
  const watchdog = setTimeout(async () => {
    report.fatal = { message: 'Diagnostic safety watchdog expired; unfinished work is FAILED, never accepted as partial completion' }
    save(path.join(output, 'report.json'), report)
    report.watchdogExceeded = true
    await Promise.allSettled([...liveHosts].map(host => host.close()))
    report.passed = false
    save(path.join(output, 'report.json'), report)
    // Only this diagnostic and its explicitly owned transports are terminated.
    process.exit(1)
  }, watchdogMs)
  try {
    report.correctness.push(await runCorrectness(config, fixture, 'legacy-invalid-original', baselineRoot,
      (resource, result) => originalInvalidFailure(resource, result, fixture)))
    for (const [caseId, root, changed] of [['A1', baselineRoot, false], ['B1', currentRoot, true], ['B2', currentRoot, true], ['A2', baselineRoot, false]]) {
      report.performance.push(await runPerformance(config, fixture, caseId, root, changed))
      save(path.join(output, 'report.partial.json'), report)
    }
    for (const [caseId, test] of [['current-invalid-complete', invalidComplete], ['current-cas-paused-batch', newerStateDuringBatch],
      ['current-root-offline-mixed', offlineMixed], ['current-child-change-parent-unchanged', unchangedParentChangedChild], ['current-query-consumer-retired', retiredQueryOwnership]]) {
      report.correctness.push(await runCorrectness(config, fixture, caseId, currentRoot,
        (resource, result) => test(resource, result, fixture)))
      save(path.join(output, 'report.partial.json'), report)
    }
    report.comparison = compareRuns(report.performance)
    report.passed = !report.watchdogExceeded && report.correctness.every(row => row.passed) && report.performance.every(row => row.passed) && report.comparison.passed === true
  } catch (error) { report.fatal = errorInfo(error); report.passed = false }
  finally {
    clearTimeout(watchdog)
    report.finishedAt = new Date().toISOString()
    try {
      verifyFiles([manifest.original, ...manifest.sources, ...manifest.targets])
      assert.equal(sha256(fs.readFileSync(workerPath)), config.workerSha256, 'Candidate worker changed during ABBA')
      assert.equal(sha256(fs.readFileSync(baselineWorkerPath)), config.baselineWorkerSha256, 'Baseline worker changed during ABBA')
      assert.equal(git(baselineRoot, 'rev-parse', 'HEAD'), BASELINE, 'Baseline changed during run')
      assert.equal(git(currentRoot, 'rev-parse', 'HEAD'), currentSha, 'Candidate changed during run')
    } catch(error) { report.postVerificationFailure=errorInfo(error);report.passed=false }
    save(path.join(output, 'report.json'), report)
  }
  console.log(JSON.stringify({ passed: report.passed, output, comparison: report.comparison }, null, 2))
  if (!report.passed) process.exitCode = 1
  return report
}

if (require.main === module) {let completed=false;process.once('beforeExit',()=>{if(!completed){console.error('Full refresh work diagnostic did not complete');process.exitCode=1}});main().then(()=>{completed=true}).catch(error=>{console.error(error);process.exitCode=1})}
module.exports = { main, WORKLOAD, BASELINE, makeFiles, makeItems, instrument, createRunner, interleave,
  readProjection, runPerformance, runCorrectness, compareRuns }
