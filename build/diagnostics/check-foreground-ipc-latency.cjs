#!/usr/bin/env node
'use strict'
// Windows-only deterministic delayed-NAS model, NEVER actual NAS measurements.
// Actual production IPC, security/admission, query/preview composition, SQLite,
// native listing/stat/render, metadata reads/preflight and source files. Only
// explicitly labeled pre-launch process release gates are controlled test ports.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { createHost } = require('./lib/production-projection-host.cjs')
const { createObserver } = require('./lib/operation-work-performance.cjs')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const plain = value => JSON.parse(JSON.stringify(value))
const errorInfo = error => ({ message: String(error?.message || error), reason: error?.reason, outcome: error?.outcome })
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
// These are hung-fixture watchdogs, not NAS or foreground latency acceptance SLOs.
// Production queue/execution deadlines remain unchanged.
async function until(predicate, message, timeoutMs = 5000) {
  const start = performance.now()
  while (!predicate()) {
    assert(performance.now() - start < timeoutMs, message)
    await pause(5)
  }
}
async function bounded(promise, message, timeoutMs = 5000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
const page = () => ({ sidebarPage: 'library', activeFilter: { kind: 'all' }, installStatus: 'all', sortMode: 'nameAsc', offset: 0, limit: 20 })

// Wait BEFORE launching the exact real native command, then forward its real
// stdout/stderr/exit code. Cancellation cases occur only before release, while
// this sole owned child is alive and no nested native child has been launched.
const delayedNativeSource = String.raw`
const fs = require('node:fs'), cp = require('node:child_process');
const [ready, release, worker, encoded] = process.argv.slice(1);
fs.writeFileSync(ready, 'held-before-native-launch');
const timer = setInterval(() => {
  if (!fs.existsSync(release)) return;
  clearInterval(timer);
  const child = cp.spawn(worker, JSON.parse(encoded), {windowsHide:true, stdio:['ignore','pipe','pipe'], env:{...process.env,HFM_PARENT_PID:String(process.pid)}});
  if (child.pid) fs.writeFileSync(ready+'.native-pid',String(child.pid));
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.on('error', error => {process.stderr.write(String(error)); process.exitCode=1});
  child.on('close', code => {fs.writeFileSync(ready+'.native-closed',String(code));process.exitCode=code ?? 1});
}, 5);
`

async function main() {
  assert.equal(process.platform, 'win32', 'Foreground IPC latency simulation runs only on Windows')
  const sourceRoot = path.resolve(__dirname, '../..')
  const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
  const workerPath = path.resolve(argument('--worker', path.join(sourceRoot, 'build/native/hfm-core-worker.exe')))
  assert(fs.statSync(workerPath).isFile(), 'Build the matching Windows native worker first')
  const artifactParent = path.join(sourceRoot, 'artifacts', 'real-feedback')
  fs.mkdirSync(artifactParent, { recursive: true })
  const directory = argument('--output') ? path.resolve(argument('--output')) : fs.mkdtempSync(path.join(artifactParent, 'foreground-ipc-'))
  fs.mkdirSync(directory, { recursive: true })
  assert(!fs.existsSync(path.join(directory, 'report.json')), 'Prior evidence cannot be overwritten')
  const fixtureDirectory = path.join(directory, 'fixture'), root = path.join(fixtureDirectory, 'fonts')
  fs.mkdirSync(root, { recursive: true })
  const source = path.join(root, 'source.ttf')
  fs.copyFileSync(path.join(process.env.WINDIR, 'Fonts', 'arial.ttf'), source, fs.constants.COPYFILE_EXCL)
  const sourceHash = hash(source), sourceStat = fs.statSync(source), workerHash = hash(workerPath)
  const observer = createObserver(), rows = [], gates = [], submitted = new Map()
  const spawn = observer.childProcess.spawn
  observer.childProcess.spawn = (file, args, options) => {
    const row = submitted.get(JSON.stringify([file, args]))
    if (row) row.startedAt = performance.now()
    return spawn(file, args, options)
  }
  let host, pool, originalRun, foreground, nextGate = 0
  const report = { passed: false, nativeWorkerSha256: workerHash, sourceFontSha256: sourceHash, lane: 'deterministic-delayed-NAS-simulation', actualNasMeasurement: false,
    injectedLatency: 'Explicit release gates before real native listing, read-only bindingSnapshot and legacy preflight writer; no fabricated native receipts',
    actualPorts: ['registerIpcHandlers and sender validation', 'createPreviewRuntime storage/source-stat/cache SQL', 'real native list/stat/render and read-only binding snapshot', 'real legacy preflight writer exclusion', 'real merged-index page/metrics SQL'],
    exclusions: ['real NAS/network latency', 'Electron renderer painting or cross-process serialization'], cases: [], requests: rows }
  function gate(label) {
    const id = nextGate++, ready = path.join(directory, `${id}-${label}-ready`), release = path.join(directory, `${id}-${label}-release`)
    const value = { ready, release, open: () => fs.writeFileSync(release, 'release') }
    gates.push(value)
    return value
  }
  function readInput(request) {
    let input
    const at = request.args.indexOf('--input')
    if (at >= 0) {
      const file = request.args[at + 1]
      assert.equal(fs.realpathSync(path.dirname(file)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase(), 'Diagnostic input is not an owned temporary file')
      assert(fs.statSync(file).size <= 1024 * 1024)
      input = JSON.parse(fs.readFileSync(file, 'utf8'))
    }
    return input
  }
  function observe(request, actual = request) {
    const input = readInput(request)
    const row = { label: request.label, command: request.args[0], operation: input?.operation, path: input?.path, bindingSnapshot: input?.bindingSnapshot === true, preflight: input?.preflight?.phase,
      listingStdoutOnly: request.label === 'list-font-files' ? request.args[0] === '--list-font-files' && !request.args.some(arg => arg === '--output' || arg.startsWith('--output=')) : undefined,
      write: request.write, verifiedReadOnly: request.verifiedReadOnly === true, lane: request.lane || 'default',
      roots: [...request.roots], submittedAt: performance.now(), syntheticDelay: actual !== request }
    rows.push(row); submitted.set(JSON.stringify([actual.file, actual.args]), row)
    const pending = originalRun({ ...actual, onClose: () => { row.closedAt = performance.now(); request.onClose?.() } })
      .then(receipt => { row.queuedMs = receipt.queuedMs; row.executionMs = receipt.executionMs; row.ok = true; return receipt },
        error => { row.error = errorInfo(error); row.queuedMs = error?.queuedMs; row.executionMs = error?.executionMs; throw error })
    pending.catch(() => undefined)
    return pending
  }
  let nextListGate, nextCountsGate, nextPreflightGate
  try {
    host = await createHost({ sourceRoot, workerPath, directory: path.join(directory, 'state'), fixtureDirectory, roots: [root], observe: observer })
    const item = await host.load('src/main/fonts/fontRuntime.ts').fontItemFromPath(source)
    assert(item?.id && item.path === source)
    await host.initialize([item], { legacyRows: 0 })
    await host.query.checkMergedIndexExternalChanges('foreground-simulation-bootstrap')
    const routing = host.load('src/main/rust-core/rustSharedIoCommandRuntime.ts')
    routing.registerIsolatedRoot(root)
    const metadataDb = host.load('src/main/indexing/shared-metadata/sharedMetadataPathsRuntime.ts').sharedMetadataDbPathForRoot(root)
    const seeded = await host.metadata.runRustSharedMetadataApply({ rootPath: root, dbPath: metadataDb, updatedAt: new Date().toISOString(),
      updatedBy: 'diagnostic-fixture', writerPid: process.pid, rows: [{ fontId: item.id, relativePath: path.basename(source),
        pathKey: source.replaceAll('\\', '/').toLowerCase(), tagNamesJson: JSON.stringify(['SimulatedTag']), favorite: false, deleteProtected: false }] })
    assert.equal(seeded?.written, 1, 'Real native metadata fixture initialization failed')
    const metadataHashBeforeCounts = hash(metadataDb), metadataMtimeBeforeCounts = fs.statSync(metadataDb).mtimeMs
    assert.deepEqual([...fs.readFileSync(metadataDb).subarray(18,20)], [1,1], 'Positive count fixture must be rollback-journal SQLite')
    report.countsStorage = 'Native-created rollback-journal fixture; WAL remains deliberately unavailable to the read-only path'
    // Page/metrics retain the real local SQLite route. Registering these DBs as
    // shared pure reads would make unproved WAL sidecars part of the exemption.
    const interaction = host.load('src/main/performance/rendererInteractionRuntime.ts').createRendererInteractionRuntime({ appendLog: host.appendStartupLog })
    const globalIo = host.load('src/main/performance/globalIoRuntime.ts').createGlobalIoRuntime({ env: process.env, localScanWorkers: 2,
      appendLog: host.appendStartupLog, isIndexingActive: () => false, isUserActive: interaction.isRendererUserActive,
      storageProfileForPath: file => ({ rootPath: path.parse(file).root, type: 'ssd', reason: 'local-real-files-in-labeled-delay-model', isNetwork: false }) })
    foreground = await host.createForegroundRuntime({ withGlobalIo: observer.global(globalIo), interaction })
    const untrusted = foreground.createRenderer(); untrusted.senderFrame.url = 'https://untrusted.invalid/'
    await assert.rejects(foreground.invoke('fonts:getMetrics', ['untrusted'], untrusted), /Blocked untrusted renderer IPC sender/)
    report.foregroundProvenance = { ...foreground.provenance, simulatedDelays: report.injectedLatency }
    pool = host.load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime()
    originalRun = pool.run.bind(pool)
    pool.run = request => {
      const input = readInput(request)
      let held
      if (request.label === 'list-font-files' && nextListGate) { held = nextListGate; nextListGate = undefined }
      else if (request.label === 'shared-metadata-overlay-read' && input?.bindingSnapshot === true && nextCountsGate) { held = nextCountsGate; nextCountsGate = undefined }
      else if (request.label === 'shared-metadata-overlay-read' && input?.preflight && nextPreflightGate) { held = nextPreflightGate; nextPreflightGate = undefined }
      if (!held) return observe(request)
      assert.equal(request.file, workerPath)
      if (request.label === 'list-font-files') {
        assert.equal(request.args[0], '--list-font-files')
        assert(!request.args.some(arg => arg === '--output' || arg.startsWith('--output=')), 'Held listing must return stdout without an aliased output-file write')
      }
      if (input?.preflight) {
        assert.equal(request.write, true, 'Legacy preflight lost its real write effect')
        assert.equal(request.verifiedReadOnly, false, 'Legacy preflight received a read-only exception')
      } else {
        assert.equal(request.write, false); assert.equal(request.verifiedReadOnly, true, 'Production list/count read-effect proof was lost')
      }
      return observe(request, { ...request, file: process.execPath,
        args: ['-e', delayedNativeSource, held.ready, held.release, workerPath, JSON.stringify(request.args)],
        env: { ...request.env, ELECTRON_RUN_AS_NODE: '1' } })
    }
    const io = host.load('src/main/path/sharedFileSystemRuntime.ts')
    async function holdListing() {
      const held = gate('list'); nextListGate = held
      const controller = new AbortController()
      const result = host.indexing.runRustFontIndexListWorker([root], ['ttf'], undefined, controller.signal)
      result.catch(() => undefined)
      await until(() => fs.existsSync(held.ready), 'Real listing never acquired the production process slot')
      return { ...held, controller, result, row: rows.findLast(row => row.label === 'list-font-files') }
    }

    const read = await holdListing()
    const pageValue = await bounded(foreground.invoke('fonts:queryPage', [page(), 'read-held-page']), 'Full page IPC stalled behind the delayed list')
    assert.equal(pageValue.total, 1); assert.equal(pageValue.workerMode, 'rust-merged-index-page')
    const counts = gate('counts'); nextCountsGate = counts
    const metricsValue = await bounded(foreground.invoke('fonts:getMetrics', ['read-held-metrics']), 'Local metrics IPC awaited the delayed shared count read')
    assert.equal(metricsValue.total, 1); assert.equal(metricsValue.workerMode, 'rust-merged-index-metrics')
    await until(() => fs.existsSync(counts.ready), 'Production metrics did not start the read-only binding snapshot')
    const countsRow = rows.find(row => row.bindingSnapshot)
    assert(countsRow && !countsRow.write && countsRow.verifiedReadOnly, 'Counts still use the preflight writer')
    assert.equal(metricsValue.sharedTagCountsStatus, 'refreshing')
    const startedAt = performance.now(), previewFrom = rows.length
    const preview = foreground.invoke('fonts:renderPreviewImage', [item, 'HFM delayed read Aa', 36, 600, 100])
    preview.catch(() => undefined)
    await until(() => rows.slice(previewFrom).some(row => row.operation === 'stat' && row.path === source && row.closedAt && row.ok), 'Foreground source stat was blocked behind the delayed list/count reads')
    await until(() => rows.slice(previewFrom).some(row => ['preview-render-owned-stage', 'preview-render-image'].includes(row.label) && row.startedAt), 'Real preview render never entered after source stat while list/counts remained active')
    const stat = rows.slice(previewFrom).find(row => row.operation === 'stat' && row.path === source)
    assert.equal(stat.lane, 'preview-read')
    assert.equal(stat.write, false)
    assert.equal(stat.verifiedReadOnly, true)
    assert(!read.row.closedAt, 'List closed before source-stat/render overlap was established')
    assert(!countsRow.closedAt, 'Counts closed before source-stat/render overlap was established')
    const png = await bounded(preview, 'Full preview IPC remained blocked behind the delayed list/counts')
    const fullPreviewIpcMs = performance.now()-startedAt
    assert(!read.row.closedAt && !countsRow.closedAt, 'Full preview returned only after its competing reads closed')
    const bytes = Buffer.from(png.slice('data:image/png;base64,'.length), 'base64')
    assert(png.startsWith('data:image/png;base64,')); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(foreground.previewReceipts.length, 1, 'The full preview route bypassed or repeated native rendering')
    const transient = foreground.previewReceipts[0]
    assert.equal(transient.input.foregroundBytes, true, 'Foreground runtime did not request owned bytes')
    assert.equal(transient.result.transient, true, 'Foreground native result was not explicitly transient')
    assert.equal(transient.result.bytes.diagnosticByteLength, bytes.length)
    assert.equal(transient.result.bytes.diagnosticSha256, crypto.createHash('sha256').update(bytes).digest('hex'))
    assert.equal(foreground.previewDb.prepare("SELECT COUNT(*) AS n FROM preview_cache WHERE status='ok'").get().n, 0, 'Transient foreground bytes were falsely recorded as a persisted cache image')
    assert.equal(rows.filter(row => row.operation === 'copyFile').length, 0, 'Transient foreground return secretly awaited an output publication')
    const releaseAt = performance.now(); read.open(); counts.open()
    const listed = await bounded(read.result, 'Released native listing did not complete', 5000)
    assert.equal(read.row.listingStdoutOnly, true, 'Listing receipt was not produced by the no-output command form')
    assert.equal(listed.files.length, 1); assert.equal(listed.files[0].file, source); assert.equal(listed.errors.length, 0); assert.equal(listed.truncated, false)
    await until(() => host.projectionEvents.some(event => event.source === 'metrics' && event.metricsRevision > 0), 'Read-only counts never emitted their metrics invalidation')
    const refreshedMetrics = await foreground.invoke('fonts:getMetrics', ['counts-current'])
    assert.equal(refreshedMetrics.sharedTagCounts.SimulatedTag, 1, 'Actual read-only snapshot did not reach metrics')
    assert.equal(refreshedMetrics.sharedTagCountsStatus, 'current')
    assert.equal(rows.filter(row => row.bindingSnapshot).length, 1, 'Metrics retry duplicated an unchanged count read')
    assert.equal(hash(metadataDb), metadataHashBeforeCounts, 'Read-only count snapshot mutated the metadata database')
    assert.equal(fs.statSync(metadataDb).mtimeMs, metadataMtimeBeforeCounts, 'Read-only count snapshot rewrote the metadata database')
    report.cases.push({ name: 'actual-source-stat-and-render-overlap-delayed-list-and-counts', passed: true, listHeldMs: releaseAt-read.row.startedAt,
      listingResponse: 'bounded-stdout', fullPreviewIpcMs, sourceStat: plain(stat), fullPageTotal: pageValue.total, fullMetricsTotal: metricsValue.total, counts: plain(countsRow), refreshedSharedCount: refreshedMetrics.sharedTagCounts.SimulatedTag })
    await pool.whenIdle()
    const cached = await bounded(foreground.invoke('fonts:ensurePreviewCache', [item, 'HFM explicit persistent cache', 36, 600, 100]), 'Explicit cache generation did not persist after read release', 5000)
    assert.equal(cached.ok, true); assert.equal(cached.cached, false)
    assert.equal(foreground.previewDb.prepare("SELECT COUNT(*) AS n FROM preview_cache WHERE status='ok'").get().n, 1, 'Explicit cache request did not commit real cache SQL')
    assert.equal(foreground.previewReceipts.length, 2, 'Explicit persistence did not perform its own native render')
    assert.notEqual(foreground.previewReceipts[1].result.transient, true, 'Explicit cache request returned transient bytes')
    assert.equal(rows.filter(row => row.operation === 'copyFile' && row.ok).length, 1, 'Explicit cache lost its required native output publication')
    report.cases.push({ name: 'explicit-cache-retains-persisted-publication', passed: true, result: plain(cached) })
    await pool.whenIdle()

    // Fault injection touches only this newly created private fixture, never a
    // user database. A WAL database must retain prior counts without fallback writes.
    const filesFor = file => ['', '-wal', '-shm'].map(suffix => {
      const target = file + suffix
      return fs.existsSync(target) ? { suffix, bytes: fs.statSync(target).size, sha256: hash(target) } : { suffix, absent: true }
    })
    const wal = new DatabaseSync(metadataDb)
    try {
      wal.exec('PRAGMA journal_mode=WAL')
      wal.prepare('UPDATE font_metadata SET tag_names_json=?').run(JSON.stringify(['UnconfirmedWalTag']))
    } finally { wal.close() }
    try {
      assert.deepEqual([...fs.readFileSync(metadataDb).subarray(18,20)], [2,2], 'WAL fault injection did not change the fixture journal format')
      const before = filesFor(metadataDb), attempts = rows.filter(row => row.bindingSnapshot).length
      host.query.clearFontQueryCaches()
      await foreground.invoke('fonts:getMetrics', ['wal-unavailable-start'])
      await until(() => rows.filter(row => row.bindingSnapshot).length > attempts && rows.filter(row => row.bindingSnapshot).at(-1).closedAt,
        'WAL read-only count attempt never settled')
      await pause(0)
      const retained = await foreground.invoke('fonts:getMetrics', ['wal-unavailable-result'])
      assert.equal(retained.sharedTagCountsStatus, 'unavailable', 'WAL failure claimed authoritative current counts')
      assert.equal(retained.sharedTagCounts.SimulatedTag, 1, 'WAL refusal discarded the last confirmed counts')
      assert.equal(retained.sharedTagCounts.UnconfirmedWalTag, undefined, 'WAL refusal read an unconfirmed replacement count')
      assert.equal(rows.filter(row => row.bindingSnapshot).length, attempts + 1, 'WAL refusal created a same-revision retry loop')
      assert.equal(rows.filter(row => row.preflight).length, 0, 'WAL count refusal fell back to a writer')
      assert.deepEqual(filesFor(metadataDb), before, 'WAL count refusal changed or created database sidecars')
      report.cases.push({ name: 'wal-count-refusal-retains-prior-without-writing', passed: true, status: retained.sharedTagCountsStatus,
        retainedCount: retained.sharedTagCounts.SimulatedTag, files: before })
    } finally {
      const restore = new DatabaseSync(metadataDb)
      try {
        restore.prepare('UPDATE font_metadata SET tag_names_json=?').run(JSON.stringify(['SimulatedTag']))
        restore.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE')
      } finally { restore.close() }
    }

    // Cancellation-only fault injection routes the real local merged SQLite
    // request into the conservative shared owner. Positive page/metrics above
    // used their ordinary local route; this grants no SQLite read-only bypass.
    routing.registerIsolatedRoot(host.paths.mergedPath)
    const blockedRead = await holdListing(), writer = gate('preflight-writer')
    nextPreflightGate = writer
    const writerTask = host.metadata.runRustSharedMetadataOverlayRead({ rootPath: root, dbPath: metadataDb, entries: [],
      preflight: { phase: 'snapshot', updatedAt: new Date().toISOString(), updatedBy: 'diagnostic-fixture', writerPid: process.pid } })
    writerTask.catch(() => undefined)
    await until(() => rows.some(row => row.preflight === 'snapshot'), 'Legacy preflight never reached the production scheduler')
    assert(!fs.existsSync(writer.ready), 'Preflight writer bypassed an active read')
    const from = rows.length, previewAbort = new AbortController(), renderer = foreground.createRenderer()
    const cancelledPreview = io.withSharedIoSignal(previewAbort.signal, () => foreground.invoke('fonts:renderPreviewImage', [item, 'cancelled preview unique key', 37, 600, 100]))
    cancelledPreview.catch(() => undefined)
    host.query.clearFontQueryCaches()
    const cancelledPage = foreground.invoke('fonts:queryPage', [page(), 'cancel-held-page'], renderer)
    cancelledPage.catch(() => undefined)
    await until(() => rows.slice(from).some(row => row.operation === 'stat' && row.path === source), 'Full preview never reached source-stat admission')
    const blockedStat = rows.slice(from).find(row => row.operation === 'stat' && row.path === source)
    assert(!blockedStat.startedAt, 'Later source-stat bypassed an earlier pending writer')
    await until(() => rows.slice(from).some(row => row.label === 'merged-index-query-page'), 'Cancellation fixture page did not reach its native queue')
    const blockedPage = rows.slice(from).find(row => row.label === 'merged-index-query-page')
    assert(!blockedPage.startedAt && !blockedPage.verifiedReadOnly, 'Conservative SQLite cancellation fixture acquired an unproved read bypass')
    blockedRead.open(); await bounded(blockedRead.result, 'Native read did not release pending writer', 5000)
    await until(() => fs.existsSync(writer.ready), 'Pending writer never acquired its exclusion slot')
    assert(!blockedStat.startedAt, 'Source-stat bypassed an active unknown writer')
    const cancelAt = performance.now()
    previewAbort.abort()
    await foreground.invoke('fonts:cancelQuery', ['cancel-held-page'], renderer)
    const cancelled = await bounded(Promise.allSettled([cancelledPreview, cancelledPage]), 'Retired full IPC consumers did not settle while writer remained active')
    assert(cancelled.every(value => value.status === 'rejected'), 'Cancelled page or preview returned a stale successful result')
    assert.equal(cancelled[1].reason.reason, 'query-superseded')
    assert(!blockedStat.startedAt, 'Cancelled pre-stat work executed anyway')
    assert(!fs.existsSync(writer.release), 'Cancellation required releasing the writer')
    const cancellationMs = performance.now()-cancelAt
    writer.open(); const preflight = await bounded(writerTask, 'Writer release failed'); assert(Array.isArray(preflight?.preflight?.snapshot?.rows), 'Released preflight did not return a real native snapshot'); await pool.whenIdle()
    assert(!blockedStat.startedAt, 'Retired preview resurrected after writer release')
    assert(!blockedPage.startedAt, 'Retired native page resurrected after writer release')
    assert.equal(foreground.previewReceipts.length, 2, 'Cancelled preview reached native render')
    report.cases.push({ name: 'pending-and-active-preflight-writer-exclusion-with-full-ipc-cancellation', passed: true, cancellationMs,
      pageCancellationBoundary: 'Only this cancellation phase deliberately isolates the real merged DB; native query queues conservatively behind preflight writer',
      previewFailure: errorInfo(cancelled[0].reason), pageFailure: errorInfo(cancelled[1].reason), sourceStat: plain(blockedStat) })

    const cancelledList = await holdListing(); cancelledList.controller.abort()
    await assert.rejects(cancelledList.result, error => error.reason === 'cancelled')
    await bounded(pool.whenIdle(), 'Cancelled list retained an owned child after physical close')
    assert(cancelledList.row.closedAt, 'Cancelled list owner was not closed')
    assert(!fs.existsSync(cancelledList.release), 'Cancelled list was released into native execution')
    report.cases.push({ name: 'active-delayed-list-cancelled-before-native-launch', passed: true, request: plain(cancelledList.row) })
    report.passed = true
  } catch (error) { report.failure = errorInfo(error) }
  finally {
    if (pool && originalRun) pool.run = originalRun
    try { if (host) await host.close() } catch (error) { report.cleanupFailure = errorInfo(error); report.passed = false }
    report.delayedNativeChildren = []
    for (const held of gates) {
      const pidFile = held.ready + '.native-pid', closeFile = held.ready + '.native-closed'
      if (!fs.existsSync(pidFile)) continue
      const pid = Number(fs.readFileSync(pidFile, 'utf8'))
      const exited = () => {
        if (fs.existsSync(closeFile)) return true
        try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
      }
      try { await until(exited, 'Owned delayed native child remained alive after wrapper cleanup', 5000) }
      catch (error) { report.cleanupFailure = errorInfo(error); report.passed = false }
      report.delayedNativeChildren.push({ pid, exited: exited(), closeObserved: fs.existsSync(closeFile) })
    }
    report.remainingChildren = observer.children.size
    if (report.remainingChildren) report.passed = false
    try {
      assert.equal(hash(workerPath), workerHash, 'Native worker changed during the diagnostic')
      assert.equal(hash(source), sourceHash, 'Source font bytes changed')
      assert.equal(fs.statSync(source).mtimeMs, sourceStat.mtimeMs, 'Source timestamp changed')
      report.sourceUnchanged = true
    } catch (error) { report.sourceFailure = errorInfo(error); report.passed = false }
    report.invocations = foreground ? plain(foreground.invocations) : []
    report.pool = pool?.status()
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(directory, 'operation.log'), (host?.logs || []).join('\n'))
  }
  console.log(JSON.stringify({ passed: report.passed, lane: report.lane, actualNasMeasurement: false, output: directory, failure: report.failure }))
  if (!report.passed) process.exitCode = 1
  return report
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
