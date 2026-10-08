#!/usr/bin/env node
'use strict'

/*
 * PROPOSED WINDOWS-ONLY DIAGNOSTIC. Prepared by static review; not executed.
 * Run later from the checked-out repository on Windows, after building its worker:
 *   node <this-file> --source-root <repository> --worker <built-worker.exe>
 * Optional: --report <output.json> --keep-fixture
 *
 * Actual production owners exercised:
 * - createInstallStatusWorkerReadRuntime (migration + native read boundary)
 * - createInstallStatusRuntime, root-index schema/database owner
 * - createMainDataQueryCompositionRuntime (real merged pages and metrics)
 * - createMainActivationInstallStatusSaveRuntime (persist + real projection)
 * - merged mutation coordinator -> real folder event broadcaster -> renderer hook
 *
 * Only external host ports are controlled: Electron window/event boundary,
 * node:sqlite API adapter, temporary paths, an explicitly unavailable root,
 * React hook host, and forbidden OS-mutation endpoints. Query SQL, metrics,
 * installation migration, state hydration, projection and revision decisions
 * are production code. No fake queryLive, array-derived metrics or fake projection.
 *
 * This is a functional composition regression, not a NAS performance claim,
 * production-installation test, full-App/Electron UI test or cancellation gate.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { createHost } = require('./lib/production-projection-host.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function arg(name, fallback) {
  const at = process.argv.indexOf(name)
  return at < 0 ? fallback : process.argv[at + 1]
}
async function main() {
  assert.equal(process.platform, 'win32', 'This diagnostic must only execute on Windows')
  const sourceRoot = path.resolve(arg('--source-root', process.cwd()))
  const workerPath = path.resolve(arg('--worker', path.join(sourceRoot, 'build/native/hfm-core-worker.exe')))
  const { selectFonts } = require(path.join(sourceRoot, 'build/diagnostics/lib/operation-work-performance.cjs'))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-production-projection-'))
  const fontRoot = path.join(directory, 'fonts')
  fs.mkdirSync(fontRoot, { recursive: true })
  let host, success = false, finishedReport, primaryFailure
  const reportPath = arg('--report')
  const stages = []
  try {
    host = await createHost({ sourceRoot, workerPath, directory, fixtureDirectory: directory, roots: [fontRoot] })
    assert.equal(host.readerProvenance.mode, 'production-extracted-reader', 'Projection correctness gate requires candidate production reader')
    const { load, status, query, indexing, nativeReceipts, queue, readBoundary, projectionEvents,
      rendererState, openDb, openStableSqliteDb, config, fontIdentity, rootStorage } = host
    const committedProjections = () => projectionEvents.filter(event => event.source === 'projection')
    const metricsEvents = () => projectionEvents.filter(event => event.source === 'metrics')
    const { mergedPath, libraryPath, installPath } = host.paths
    const fonts = load('src/main/fonts/fontRuntime.ts')
    const manifests = selectFonts(path.join(directory, 'manifest')).slice(0, 3)
    const items = []
    for (let index = 0; index < manifests.length; index++) {
      const target = path.join(fontRoot, `fixture-${index}.ttf`)
      fs.copyFileSync(manifests[index].source, target)
      fs.utimesSync(target, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
      items.push(await fonts.fontItemFromPath(target))
    }
    const originalSources = items.map(item => ({ path: item.path, bytes: sha256(fs.readFileSync(item.path)), size: item.fileSize, modifiedAt: item.modifiedAt }))
    await host.initialize(items, { legacyRows: 94, oldProjection: true })
    // Direct native read must not accept the seeded, unversioned old projection.
    await assert.rejects(() => indexing.runRustMergedIndexMetricsQuery({ roots: [fontRoot], mergedIndexDbPath: mergedPath,
      libraryDbPath: libraryPath, schemaVersion: config.MERGED_INDEX_SCHEMA_VERSION }),
    /merged index snapshot is not usable/i,
    'Native must specifically reject the unversioned snapshot, not silently return a missing-capability fallback')
    host.setRootOnline(false)
    const pageRequest = kind => ({ sidebarPage: 'library', activeFilter: { kind }, installStatus: 'all', sortMode: 'nameAsc', limit: 100, offset: 0 })

    async function checkState(label, expected) {
      const page = await query.queryFontPageInLibrary(pageRequest('all'))
      const installed = await query.queryFontPageInLibrary(pageRequest('installed'))
      const notInstalled = await query.queryFontPageInLibrary(pageRequest('notInstalled'))
      const metrics = await query.getFontMetricsFromLibrary()
      assert.equal(page.total, 3, `${label}: font population lost`)
      assert.equal(page.items.length, 3)
      assert.equal(installed.total, expected.installed)
      assert.equal(notInstalled.total, expected.notInstalled)
      assert.equal(metrics.total, 3)
      assert.equal(metrics.installedCount, expected.installed)
      assert.equal(metrics.notInstalledCount, expected.notInstalled)
      assert.equal(metrics.installStatusMissingCount, expected.unknown)
      assert.equal(metrics.installStatusReady, expected.unknown === 0)
      assert.equal(page.items.filter(item => item.installStatusKnown === false).length, expected.unknown)
      assert.equal(page.workerMode, 'rust-merged-index-page', `${label}: page replaced by a fake/fallback query`)
      assert.equal(metrics.workerMode, 'rust-merged-index-metrics', `${label}: metrics replaced by an array fallback`)
      const lastNativeMetrics = nativeReceipts.filter(row => row.method === 'runRustMergedIndexMetricsQuery').at(-1)
      assert(lastNativeMetrics, `${label}: missing real native metrics receipt`)
      assert.deepEqual([lastNativeMetrics.result.installedCount, lastNativeMetrics.result.notInstalledCount, lastNativeMetrics.result.installStatusMissingCount],
        [expected.installed, expected.notInstalled, expected.unknown], `${label}: native and delivered metrics differ`)
      stages.push({ label, ...expected, total: metrics.total, revisions: committedProjections().length, metricsRevisions: metricsEvents().length })
      return { page, metrics }
    }
    await checkState('offline startup withdraws old authority and preserves population', { installed: 0, notInstalled: 0, unknown: 3 })
    assert.equal(committedProjections().length, 0, 'Opening/migrating a local snapshot fabricated a merged commit')

    host.setRootOnline(true)
    const refreshed = await query.checkMergedIndexExternalChanges('diagnostic-real-bootstrap')
    assert.equal(refreshed.changed, true)
    await tick()
    assert(committedProjections().length > 0, 'Real native rebuild did not notify the renderer')
    assert(projectionEvents.every(event => ['projection', 'metrics'].includes(event.source) && event.upserts.length === 0 && event.deletes.length === 0))
    assert(metricsEvents().every(event => Number.isSafeInteger(event.metricsRevision) && event.metricsRevision > 0), 'Invalid count notification was broadcast')
    assert.equal(rendererState.pageSeq.current, rendererState.refreshes)
    assert.equal(rendererState.metricsSeq.current, rendererState.refreshes)
    assert.equal(rendererState.token, rendererState.refreshes)

    const result = (known, installed) => ({ known, installed, by: installed ? 'user' : 'none', matches: [] })
    async function persist(label, results) {
      const before = committedProjections().length
      queue.scheduleActivationInstallStatusSave(Object.fromEntries(items.map((item, index) => [item.id, results[index]])),
        new Map(items.map(item => [item.id, item])), label)
      await queue.flushActivationInstallStatusSave(label)
      await tick()
      assert(!queue.hasPendingActivationInstallStatusSave() && !queue.hasInFlightActivationInstallStatusSave(), `${label}: save queue not drained`)
      assert(committedProjections().length > before, `${label}: persistence did not commit a real merged projection`)
      const rebuilds = nativeReceipts.filter(row => row.method === 'runRustMergedIndexRebuild').length
      // Expire the external-check reuse window without wall-clock sleeps by
      // checking the actual persistent key through the production owner.
      const snapshot = await query.openMergedIndexDb()
      try {
        const key = JSON.parse(snapshot.prepare("SELECT value FROM meta WHERE key='sourcesKey'").get().value)
        assert(key.length && key.every(source => source.installSignature.startsWith('install-content-v1|')))
        const signature = load('src/main/indexing/mergedIndexRuntime.ts').createMergedIndexRuntime({
          dataPath: host.dataPath, exists: host.exists, openStableSqliteDb, openRootIndexDb: rootStorage.openRootIndexDb,
          closeSqliteDb: db => db.close(), getSqliteMeta: load('src/main/db/sqliteHelpers.ts').getSqliteMeta,
          setSqliteMeta: load('src/main/db/sqliteHelpers.ts').setSqliteMeta, sqliteTableExists: load('src/main/db/sqliteHelpers.ts').sqliteTableExists,
          appendStartupLog() {}, schemaVersion: config.MERGED_INDEX_SCHEMA_VERSION, staleFirstPageEnabled: true,
        })
        for (const source of key) assert.equal(source.installSignature, await signature.installStatusContentSignature(source.installDbPath), `${label}: saved source signature lagged its committed projection`)
      } finally { snapshot.close() }
      await status.saveInstalledTotalSummaryForRoots([fontRoot], 999)
      await query.checkMergedIndexExternalChanges(`batch-coherency:${label}`)
      assert.equal(nativeReceipts.filter(row => row.method === 'runRustMergedIndexRebuild').length, rebuilds, 'A status-only projection triggered full rebuild')
    }
    await persist('all current evidence', [result(true, true), result(true, false), result(true, true)])
    await checkState('known mixed installed/uninstalled', { installed: 2, notInstalled: 1, unknown: 0 })

    // Actual storage migration boundary: invalid rows must not erase valid peers.
    const invalid = [
      { ...items[1], id: 'invalid-relative', path: 'relative.ttf' },
      { ...items[1], id: 'invalid-size', fileSize: 0.5 },
      { ...items[1], id: 'invalid-time', modifiedAt: NaN },
    ]
    const mixed = await status.readInstallStatusIndex([items[0], ...invalid, items[2]], { enqueueMissTasks: false })
    assert.equal(mixed.results[items[0].id].installed, true)
    assert.equal(mixed.results[items[2].id].installed, true)
    assert.deepEqual(plain(mixed.misses.map(item => item.id).sort()), invalid.map(item => item.id).sort())
    const duplicate = await readBoundary([{ rootLabel: 'local-fallback', rootPath: 'local-fallback', dbPath: installPath,
      items: [status.installStatusWorkerItem(items[0]), status.installStatusWorkerItem({ ...items[0], path: 'relative.ttf' })] }])
    assert.equal(duplicate.results[items[0].id], undefined, 'Invalid duplicate ID borrowed valid authority')
    assert(duplicate.missingIds.includes(items[0].id))
    const identityDb = openDb(installPath)
    assert.equal(identityDb.prepare("SELECT COUNT(*) AS n FROM install_status WHERE font_id LIKE 'legacy-unresolved-%'").get().n, 94,
      'Unresolved historical rows were destroyed')
    identityDb.close()
    stages.push({ label: 'mixed identity isolation and historical row preservation', valid: 2, invalid: 3, historicalRetained: 94 })

    await persist('known to unknown and mixed batch', [result(false, false), result(true, true), result(true, false)])
    await checkState('one unknown plus installed/uninstalled peers', { installed: 1, notInstalled: 1, unknown: 1 })
    const projected = openDb(mergedPath)
    fontIdentity.registerFileIdentitySql(projected)
    const projection = projected.prepare('SELECT installed,installed_by,matches_json FROM entries WHERE hfm_file_font_id(root_path,relative_path,file_size,modified_at)=?').get(items[0].id)
    assert.deepEqual(plain(projection), { installed: null, installed_by: null, matches_json: null })
    projected.close()
    await persist('all unknown', items.map(() => result(false, false)))
    await checkState('unknown is neither installed nor uninstalled', { installed: 0, notInstalled: 0, unknown: 3 })

    // Count notifications have their own owner/revision and cannot manufacture
    // a projection commit or race this projection-only duplicate check.
    await query.disposeSharedTagMetrics?.()
    await tick()
    const refreshCount = rendererState.refreshes
    const lastEvent = committedProjections().at(-1)
    assert(lastEvent, 'No actual projection revision available for the duplicate gate')
    host.deliverRendererEvent(lastEvent)
    host.deliverRendererEvent({ ...lastEvent, projectionRevision: Math.max(0, lastEvent.projectionRevision - 1) })
    await tick()
    assert.equal(rendererState.refreshes, refreshCount, 'Duplicate/older projection revision restarted queries')
    assert(committedProjections().every((event, index, events) => !index || event.projectionRevision > events[index - 1].projectionRevision),
      'Committed revisions are not monotonic')
    assert(metricsEvents().every((event, index, events) => !index || event.metricsRevision > events[index - 1].metricsRevision), 'Metrics revisions are not monotonic within their own stream')

    for (const source of originalSources) {
      assert.equal(sha256(fs.readFileSync(source.path)), source.bytes, 'Original fixture font bytes changed')
      const stat = fs.statSync(source.path)
      assert.equal(stat.size, source.size)
      assert.equal(stat.mtimeMs, source.modifiedAt)
    }
    assert(nativeReceipts.some(row => row.method === 'runRustMergedIndexRebuild'))
    assert(nativeReceipts.some(row => row.method === 'runRustInstallStatusRead'))
    assert(nativeReceipts.some(row => row.method === 'runRustInstallStatusSave'))
    success = true
    finishedReport = { ok: true, platform: process.platform, workerSha256: sha256(fs.readFileSync(workerPath)), stages, sqlitePolicy: host.sqlitePolicyEvidence,
      projectionEvents: committedProjections(), metricsEvents: metricsEvents(), indexEvents: projectionEvents, rendererRefreshes: rendererState.refreshes,
      nativeCounts: Object.fromEntries([...new Set(nativeReceipts.map(row => row.method))].map(method => [method, nativeReceipts.filter(row => row.method === method).length])),
      scope: 'production storage read boundary + data query composition + native SQLite pages/metrics + activation projection + renderer revision hook',
      exclusions: ['real system installation', 'NAS performance', 'full App/Electron UI', 'preload transport', 'query cancellation stress'],
    }
  } catch (error) {
    primaryFailure=error
    finishedReport={ok:false,platform:process.platform,stages,sqlitePolicy:host?.sqlitePolicyEvidence,lastCompletedStage:stages.at(-1),error:{name:error.name,message:error.message,stack:error.stack},
      projectionEvents:(host?.projectionEvents||[]).filter(event=>event.source==='projection'),
      metricsEvents:(host?.projectionEvents||[]).filter(event=>event.source==='metrics'),indexEvents:host?.projectionEvents||[],nativeCounts:Object.fromEntries([...new Set((host?.nativeReceipts||[]).map(row=>row.method))].map(method=>[method,host.nativeReceipts.filter(row=>row.method===method).length]))}
  } finally {
    try{await host?.close()}catch(error){primaryFailure ||= error;finishedReport={...(finishedReport||{}),ok:false,cleanupFailure:String(error)}}
    if (!success || primaryFailure || process.argv.includes('--keep-fixture')) {
      fs.writeFileSync(path.join(directory, 'diagnostic.log'), (host?.logs || primaryFailure?.diagnosticLogs || []).join('\n'))
      if(reportPath){
        const evidence=path.join(path.dirname(path.resolve(reportPath)),'projection-failure')
        fs.mkdirSync(evidence,{recursive:true})
        // Only this fixture's controlled databases/logs/receipts are copied.
        fs.cpSync(directory,evidence,{recursive:true,filter:file=>!file.endsWith('.ttf')&&!file.endsWith('.otf')})
        fs.writeFileSync(path.join(evidence,'native-receipts.json'),JSON.stringify(host?.nativeReceipts||[],null,2))
        finishedReport={...(finishedReport||{}),failureEvidence:evidence}
      }
      console.error(`Diagnostic fixture retained: ${directory}`)
    } else fs.rmSync(directory, { recursive: true, force: true })
    if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)),{recursive:true}); fs.writeFileSync(path.resolve(reportPath), JSON.stringify(finishedReport, null, 2)) }
  }
  if(primaryFailure)throw primaryFailure
  console.log(JSON.stringify(finishedReport, null, 2))
}
if (require.main === module) {
  let completed=false;process.once('beforeExit',()=>{if(!completed){console.error('Production projection diagnostic did not complete');process.exitCode=1}})
  main().then(()=>{completed=true}).catch(error=>{console.error(error);process.exitCode=1})
}
module.exports = { main }
