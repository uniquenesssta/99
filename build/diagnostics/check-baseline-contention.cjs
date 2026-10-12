#!/usr/bin/env node
'use strict'
// Separate WINDOWS-ONLY diagnostic. Never an acceptance run or baseline envelope.
// Exactly two frozen-baseline cases, each in a fresh child process, no retries.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process')
const { performance } = require('node:perf_hooks')
const work = require('./check-full-refresh-work.cjs')
const { createFixtureCacheLifecycle } = require('./lib/full-refresh-fixture-lifecycle.cjs')
const { createBaselineContentionObservation, SQLITE_POLICY } = require('./lib/baseline-contention-observation.cjs')
const CONDITIONS = Object.freeze([
  Object.freeze({ id: 'baseline-with-foreground', foreground: true }),
  Object.freeze({ id: 'baseline-without-foreground', foreground: false }),
])
const WATCHDOG_MS = 15 * 60 * 1000
const OVERRIDES = Object.freeze(['HFM_IO_DEADLINE_MS', 'HFM_UNC_ROOT_PROBE_TIMEOUT_MS', 'HFM_ROOT_PROBE_QUEUE_TIMEOUT_MS',
  'HFM_FILE_EXISTS_TIMEOUT_MS', 'HFM_SHARED_METADATA_QUERY_TIMEOUT_MS', 'HFM_PREVIEW_CACHE_QUERY_TIMEOUT_MS', 'HFM_UNAVAILABLE_ROOT_TTL_MS'])
const plain = value => JSON.parse(JSON.stringify(value))
const errorInfo = error => ({ name: error?.name, code: error?.code, reason: error?.reason, outcome: error?.outcome,
  message: String(error?.message || error), stack: error?.stack })
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (root, ...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2))
function arg(name, fallback) { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] }
function required(name) { const value = arg(name); assert(value && !value.startsWith('--'), `${name} is required`); return path.resolve(value) }
function requireWindows() { assert.equal(process.platform, 'win32', 'Baseline investigation only executes on Windows') }
function requireBudgets() { for (const name of OVERRIDES) assert(!process.env[name], `Do not override original frozen-baseline budget: ${name}`) }
function verifySource(manifest) {
  requireBudgets()
  assert.equal(git(manifest.baselineRoot, 'rev-parse', 'HEAD'), work.BASELINE)
  assert.equal(git(manifest.baselineRoot, 'status', '--porcelain', '--untracked-files=no'), '', 'Frozen baseline has tracked changes')
  assert.equal(git(manifest.currentRoot, 'rev-parse', 'HEAD'), manifest.currentSha)
  assert.equal(git(manifest.currentRoot, 'status', '--porcelain', '--untracked-files=no'), '', 'Diagnostic source has tracked changes')
  for (const file of manifest.sourceFiles) assert.equal(sha(file.path), file.sha256, 'Diagnostic support file changed: ' + file.path)
  assert.equal(sha(manifest.baselineWorkerPath), manifest.baselineWorkerSha256, 'Frozen-baseline worker changed')
  assert.equal(sha(manifest.workerPath), manifest.workerSha256, 'Fixture preparation worker changed')
  if (manifest.fixture) {
    assert.equal(sha(path.join(manifest.fixture.directory, 'immutable-fixture-manifest.json')), manifest.sourceManifestSha256, 'Immutable fixture manifest changed')
    assert.equal(sha(path.join(manifest.fixture.directory, 'metadata-population.json')), manifest.metadataPopulationSha256, 'Prepared metadata population changed')
  }
}
function frozenBudgets(host) {
  const owner = host.load('src/main/path/ioDeadlineRuntime.ts')
  const result = Object.fromEntries(['uncRootProbeTimeoutMs', 'rootProbeQueueTimeoutMs', 'fileExistsTimeoutMs',
    'sharedMetadataQueryTimeoutMs', 'previewCacheQueryTimeoutMs', 'unavailableRootTtlMs'].map(name => [name, owner[name]()]))
  assert.deepEqual(result, { uncRootProbeTimeoutMs: 500, rootProbeQueueTimeoutMs: 3000, fileExistsTimeoutMs: 500,
    sharedMetadataQueryTimeoutMs: 500, previewCacheQueryTimeoutMs: 2000, unavailableRootTtlMs: 30000 })
  return result
}
function caseConfig(manifest) {
  return { ...manifest, hostModule: require(manifest.hostPath),
    fixtureCacheLifecycle: createFixtureCacheLifecycle({ ownership: manifest.fixture.manifest.fixtureRootOwnership, evidenceDirectory: manifest.output }) }
}
function fixtureFrom(manifest) {
  const fixture = manifest.fixture
  return { ...fixture, byId: new Map(fixture.items.map(item => [item.id, item])) }
}
function positiveClose(proof) {
  return proof?.hostClosed === true && proof.databaseOwnersClosed === true && proof.childrenReaped === true &&
    proof.remainingDatabaseOwners === 0 && proof.remainingChildren === 0
}
function unknownSql(host) {
  const db = host.openDb(host.paths.mergedPath)
  try { return plain(db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN installed=1 AND COALESCE(installed_by,'')<>'managed' THEN 1 ELSE 0 END) AS installed,
    SUM(CASE WHEN installed=0 OR installed_by='managed' THEN 1 ELSE 0 END) AS notInstalled,
    SUM(CASE WHEN installed IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM entries WHERE COALESCE(is_deleted,0)=0 AND status='ok' AND json_valid(font_json)`).get()) }
  finally { host.closeSqliteDb(db) }
}
function baselineOutcome(report) {
  const summary = report.summary, expected = work.WORKLOAD, persisted = report.independentSql
  return { completed: !report.refreshFailure && !!summary && report.progress.some(row => row.stage === 'done'),
    fullPopulationConfirmed: !!summary && summary.total === expected.validIndexed && summary.updatedCount === expected.validIndexed &&
      summary.installedCount === expected.sourceFiles && summary.notInstalledCount === expected.metadataOnly && summary.missingCount === 0 &&
      !!persisted && persisted.total === expected.validIndexed && persisted.installed === expected.sourceFiles &&
      persisted.notInstalled === expected.metadataOnly && persisted.unknown === 0,
    unknownRows: report.independentSql?.unknown ?? null,
    observedBatches: report.committedBatches?.length || 0,
    allObservedBatchesConverged: report.committedBatches?.length ? report.committedBatches.every(row => row.converged === true) : null,
    foregroundDeclared: report.condition.foreground,
    foregroundCompleted: report.condition.foreground ? !!report.foreground && report.foreground.failures.length === 0 &&
      report.foreground.queries.length === expected.foregroundQueries && report.foreground.previewReceipts.length === expected.nativePreviews &&
      report.foreground.metrics.length === expected.foregroundMetrics && report.foreground.enumeration.length === expected.treeEnumerations : null }
}

async function runCase(manifest, caseId) {
  requireWindows(); verifySource(manifest)
  const condition = CONDITIONS.find(row => row.id === caseId); assert(condition, 'Unknown predeclared condition')
  const fixture = fixtureFrom(manifest), config = caseConfig(manifest)
  work.verifyFiles([fixture.manifest.original, ...fixture.manifest.sources, ...fixture.manifest.targets])
  const report = { schema: 'hfm-frozen-baseline-contention-case-v1', diagnosticOnly: true, excludedFromAcceptance: true,
    comparable: false, condition, pid: process.pid, parentPid: process.ppid, sourceSha: work.BASELINE,
    workerSha256: manifest.baselineWorkerSha256, sourceManifestSha256: manifest.sourceManifestSha256,
    attempt: 1, startedAt: new Date().toISOString(), progress: [], committedBatches: [], collectionIntegrity: false,
    foregroundDeclaration: condition.foreground ? { ...work.WORKLOAD, scheduling: 'original interleave; evidence admissions 1,73,145,217' }
      : { queries: 0, previews: 0, metrics: 0, enumerations: 0, rendererActivity: 0, note: 'Foreground composition exists as in the other setup, but no foreground workload is submitted.' },
    historicalDifference: 'Fresh case process for each condition, original legacy-invalid prelude in each process, no ABBA candidate cases. This compares the two declared diagnostic conditions, not historical A1 timing.' }
  const directory = path.join(manifest.output, 'cases', caseId)
  fs.mkdirSync(directory, { recursive: true })
  assert(!fs.existsSync(path.join(directory, 'report.json')), 'A condition must never be retried or overwritten')
  let resource, observationContext = () => ({}), checkpointing = false
  const observationState = {}
  const timing = createBaselineContentionObservation({ getContext: () => observationContext() })
  config.decorateDiagnosticHostOptions = options => {
    observationContext = options.getObservationContext
    timing.installProcessObserver(options.observe)
    options.diagnosticHooks = { timerGlobals: timing.timerGlobals, onSqlitePort: timing.onSqlitePort }
    const original = options.onLoaderReady
    options.onLoaderReady = load => { original?.(load); timing.installSelectedSource(load) }
  }
  const checkpoint = () => {
    if (checkpointing) return
    checkpointing = true
    try { save(path.join(directory, 'report.partial.json'), { ...report, timing: timing.snapshot(),
      liveOwners: resource?.host.closeProof(), livePool: resource?.meter.pool.status() }) }
    finally { checkpointing = false }
  }
  // Safety watchdog is not a deadline/SLO or a condition retry. Parent allows a
  // separate bounded cleanup interval before a final kill of this owned process.
  const watchdog = setTimeout(() => {
    report.watchdogExceeded = true
    report.fatal = { message: 'Diagnostic case watchdog expired; incomplete collection retained' }
    try { checkpoint() } finally { resource?.host.close().catch(() => undefined); process.exitCode = 1 }
  }, WATCHDOG_MS)
  try {
    timing.setStage('prelude')
    report.legacyInvalidPrelude = await timing.runOwner('legacy-invalid-prelude', () => work.runCorrectness(config, fixture,
      caseId + '-legacy-invalid-original', manifest.baselineRoot,
      (prelude, result) => work.originalInvalidFailure(prelude, result, fixture)))
    work.assertFixtureCacheCanContinue(config)
    assert.equal(report.legacyInvalidPrelude.passed, true, 'Unexpected legacy-invalid prelude outcome; timed condition is blocked')
    assert.equal(report.legacyInvalidPrelude.expectedOriginalFailure, true, 'Original prelude did not establish the declared failure')
    timing.setStage('setup')
    resource = await work.openCase(config, fixture, caseId, manifest.baselineRoot, { observationState })
    const { host, meter } = resource
    report.ownerBeforeWork = host.closeProof(); report.poolBeforeWork = meter.pool.status()
    report.effectiveBudgets = frozenBudgets(host)
    report.provenance = { reader: host.readerProvenance, sqlite: plain(host.sqlitePolicyEvidence), performance: plain(host.performanceProvenance),
      readPorts: plain(host.readPortsProvenance), foreground: host.foreground.provenance }
    const runner = work.createRunner(host, { ...fixture, includeInvalid: false, targetRoot: fixture.manifest.targetRoot }, {
      onProgress: value => report.progress.push(value),
      afterSave: batch => timing.runOwner('verifyCommittedBatch-audit', async () => {
        report.committedBatches.push(await work.verifyCommittedBatch(host, batch, false))
      }),
    })
    resource.setObservationStage('timed'); timing.setStage('timed')
    const started = performance.now()
    const refresh = meter.runScope('background-refresh', () => runner.refreshInstallStatusIndex({ force: true }, { jobId: caseId, emitProgress: true }))
      .then(value => { report.summary = plain(value); return value }, error => { report.refreshFailure = errorInfo(error); throw error })
      .finally(() => { report.fullRefreshMs = performance.now() - started; meter.finishBackground() })
    refresh.catch(() => undefined)
    const foreground = condition.foreground ? work.interleave(host, meter, fixture, directory) : Promise.resolve(null)
    const outcomes = await Promise.allSettled([refresh, foreground])
    report.workAtTimedEnd = meter.snapshot()
    if (outcomes[1].status === 'fulfilled') report.foreground = outcomes[1].value
    else report.foregroundFailure = errorInfo(outcomes[1].reason)
    report.timedWorkFinished = true
    resource.setObservationStage('validation'); timing.setStage('validation')
    report.independentSql = timing.runOwner('final-diagnostic-audit', () => unknownSql(host))
    report.baselineOutcome = baselineOutcome(report)
    report.batchVerificationElapsedMs = report.committedBatches.reduce((sum, row) => sum + Number(row.verificationElapsedMs || 0), 0)
    report.auditPolicy = 'Same unchanged verifyCommittedBatch after every saved batch in both conditions; its time remains inside fullRefreshMs. Final count audit is after timed work.'
    checkpoint()
  } catch (error) { report.fatal = errorInfo(error); report.setupObservation = observationState }
  finally {
    clearTimeout(watchdog)
    if (resource) {
      const { host, meter } = resource
      report.ownersBeforeCleanup = host.closeProof(); report.poolBeforeCleanup = meter.pool.status()
      report.workBeforeCleanup = meter.snapshot()
      resource.setObservationStage('cleanup'); timing.setStage('cleanup')
      try { meter.restore(); await host.close() } catch (error) { report.cleanupFailure = errorInfo(error) }
      report.ownersAfterCleanup = host.closeProof(); report.poolAfterCleanup = meter.pool.status()
      report.workAfterCleanup = meter.snapshot()
      report.diagnosticObservation = work.finalizeObservation(resource)
      report.fixtureCacheLifecycle = work.finalizeFixtureCache(config, caseId, host)
      fs.writeFileSync(path.join(directory, 'operation.log'), host.logs.join('\n'))
    } else {
      report.fixtureCacheLifecycle = observationState.fixtureCacheLifecycle || report.legacyInvalidPrelude?.fixtureCacheLifecycle ||
        { ok: false, lifecycle: config.fixtureCacheLifecycle.snapshot() }
      report.ownersAfterCleanup = report.fixtureCacheLifecycle?.case?.closeProof
      report.cleanupScope = 'No timed resource was returned; proof belongs only to the completed prelude/setup boundary, if present.'
    }
    timing.restore(); report.timing = timing.snapshot()
    try {
      verifySource(manifest); work.verifyFiles([fixture.manifest.original, ...fixture.manifest.sources, ...fixture.manifest.targets])
      report.postVerification = true
    } catch (error) { report.postVerificationFailure = errorInfo(error) }
    report.baselineOutcome ||= baselineOutcome(report)
    report.collectionIntegrity = !report.fatal && !report.watchdogExceeded && !report.cleanupFailure && report.postVerification === true &&
      positiveClose(report.ownersAfterCleanup) && report.fixtureCacheLifecycle?.ok === true &&
      report.timing.observerErrors === 0 && report.timing.restorationConflicts === 0 && report.timing.remainingPatches === 0 &&
      report.timing.sqliteCoverage.requiredRepresentationComplete === true &&
      Object.values(report.timing.dropped).every(value => value === 0)
    report.finishedAt = new Date().toISOString()
    save(path.join(directory, 'report.json'), report)
  }
  return report
}

async function launchCase(manifest, condition) {
  const directory = path.join(manifest.output, 'cases', condition.id)
  fs.mkdirSync(directory, { recursive: true })
  const log = fs.openSync(path.join(directory, 'case-process.log'), 'wx')
  const launch = { condition, attempt: 1, startedAt: new Date().toISOString(), diagnosticOnly: true, excludedFromAcceptance: true }
  try {
    const child = cp.spawn(process.execPath, [__filename, '--case', condition.id, '--manifest', path.join(manifest.output, 'investigation-manifest.json')],
      { cwd: manifest.currentRoot, windowsHide: true, stdio: ['ignore', log, log], env: process.env })
    launch.pid = child.pid
    // The case's own watchdog gets one bounded cleanup interval. No new attempt.
    const watchdog = setTimeout(() => { launch.forcedAfterWatchdog = true; child.kill('SIGKILL') }, WATCHDOG_MS + 30000)
    try { await new Promise(resolve => {
      child.once('error', error => { launch.spawnError = errorInfo(error) })
      child.once('close', (code, signal) => { launch.exitCode = code; launch.signal = signal; resolve() })
    }) } finally { clearTimeout(watchdog) }
  } finally { fs.closeSync(log); launch.finishedAt = new Date().toISOString(); save(path.join(directory, 'launch.json'), launch) }
  const reportPath = path.join(directory, 'report.json')
  if (fs.existsSync(reportPath)) launch.report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  else launch.missingFinalReport = true
  return launch
}

async function main() {
  requireWindows(); requireBudgets()
  if (arg('--case')) {
    const manifest = JSON.parse(fs.readFileSync(required('--manifest'), 'utf8'))
    assert.equal(manifest.schema, 'hfm-frozen-baseline-contention-v1')
    assert.deepEqual(manifest.conditions, CONDITIONS)
    const report = await runCase(manifest, arg('--case'))
    process.exitCode = report.collectionIntegrity ? 0 : 1
    return report
  }
  const currentRoot = path.resolve(arg('--current-root', process.cwd())), baselineRoot = required('--baseline-root')
  assert.equal(currentRoot.toLowerCase(), path.resolve(__dirname, '../..').toLowerCase(), 'Invoke the diagnostic from its declared current source checkout')
  assert.equal(git(baselineRoot, 'rev-parse', 'HEAD'), work.BASELINE)
  assert.equal(git(baselineRoot, 'status', '--porcelain', '--untracked-files=no'), '')
  assert.equal(git(currentRoot, 'status', '--porcelain', '--untracked-files=no'), '')
  const output = required('--output'), baselineWorkerPath = required('--baseline-worker'), workerPath = required('--worker')
  const hostPath = path.join(currentRoot, 'build/diagnostics/lib/production-projection-host.cjs')
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output) // Exclusive; no overwriting prior evidence.
  const manifest = { schema: 'hfm-frozen-baseline-contention-v1', diagnosticOnly: true, excludedFromAcceptance: true,
    baselineSha: work.BASELINE, currentRoot, currentSha: git(currentRoot, 'rev-parse', 'HEAD'), baselineRoot,
    baselineWorkerPath, baselineWorkerSha256: sha(baselineWorkerPath), workerPath, workerSha256: sha(workerPath), hostPath,
    output, conditions: CONDITIONS, caseWatchdogMs: WATCHDOG_MS, attemptsPerCondition: 1, workload: work.WORKLOAD,
    sqliteObservationPolicy: SQLITE_POLICY,
    originalBudgetsRequired: true, processRuntime: process.versions, sourceFiles: [__filename, path.join(__dirname, 'check-full-refresh-work.cjs'),
      hostPath, path.join(__dirname, 'lib/baseline-contention-observation.cjs'), path.join(__dirname, 'lib/full-refresh-fixture-lifecycle.cjs')]
      .map(file => ({ path: file, sha256: sha(file) })),
    differencesFromAcceptance: ['Separate fresh process for each condition with the original legacy-invalid prelude', 'No candidate performance case',
      'Second condition explicitly submits no foreground work', 'Extra timing observation adds unquantified overhead; no correction/subtraction'],
    comparisonLimit: 'Descriptive two-condition evidence only. Never update ABBA baseline, acceptance gates, thresholds, defaults or claim candidate speedup.',
    orderConfound: 'Fixed full-then-none order and shared OS/file cache can confound this two-case comparison. Use per-request timer, SQLite and child timelines; second-condition success alone is not causal proof. OS caches are not cleared.',
    fixturePreparation: 'Existing makeFiles/makeItems once using current source and its worker, as in the original harness. Both timed conditions use only frozen-baseline source and worker.',
    cachePolicy: 'Original generated namespace lifecycle: absent before every case, archived after positive owner cleanup, never deleted/reset/retried.' }
  verifySource(manifest)
  const fixtureDirectory = path.join(output, 'immutable-font-fixture'); fs.mkdirSync(fixtureDirectory)
  const arial = path.resolve(arg('--font', path.join(process.env.WINDIR, 'Fonts', 'arial.ttf')))
  assert.equal(path.basename(arial).toLowerCase(), 'arial.ttf')
  const fixtureManifest = work.makeFiles(fixtureDirectory, arial)
  let fixture = { directory: fixtureDirectory, manifest: fixtureManifest, workerPath }
  fixture = { ...fixture, ...await work.makeItems(currentRoot, fixture, require(hostPath)) }
  delete fixture.byId; manifest.fixture = fixture
  manifest.sourceManifestSha256 = sha(path.join(fixtureDirectory, 'immutable-fixture-manifest.json'))
  manifest.metadataPopulationSha256 = sha(path.join(fixtureDirectory, 'metadata-population.json'))
  save(path.join(output, 'investigation-manifest.json'), manifest)
  const report = { schema: manifest.schema, diagnosticOnly: true, excludedFromAcceptance: true, comparable: false,
    baselineSha: work.BASELINE, sourceManifestSha256: manifest.sourceManifestSha256, conditions: [], startedAt: new Date().toISOString(),
    collectionIntegrity: false, expectedBaselineFailureDoesNotFailCollection: true }
  for (const condition of CONDITIONS) {
    const previous = report.conditions.at(-1)
    if (previous && (!positiveClose(previous.report?.ownersAfterCleanup) || previous.report?.fixtureCacheLifecycle?.ok !== true)) {
      report.conditions.push({ condition, attempt: 0, blocked: 'Previous owner cleanup/cache archival was not proven; unsafe second use was not attempted.',
        diagnosticOnly: true, excludedFromAcceptance: true }); break
    }
    try { report.conditions.push(await launchCase(manifest, condition)) }
    catch (error) { report.conditions.push({ condition, attempt: 1, launchFailure: errorInfo(error), diagnosticOnly: true, excludedFromAcceptance: true }) }
    save(path.join(output, 'investigation.partial.json'), report)
  }
  try { verifySource(manifest); work.verifyFiles([fixtureManifest.original, ...fixtureManifest.sources, ...fixtureManifest.targets]); report.postVerification = true }
  catch (error) { report.postVerificationFailure = errorInfo(error) }
  report.collectionIntegrity = report.postVerification === true && report.conditions.length === CONDITIONS.length &&
    report.conditions.every(row => row.attempt === 1 && row.exitCode === 0 && row.report?.collectionIntegrity === true)
  report.finishedAt = new Date().toISOString()
  save(path.join(output, 'investigation.json'), report)
  console.log(JSON.stringify({ diagnosticOnly: true, excludedFromAcceptance: true, collectionIntegrity: report.collectionIntegrity, output,
    outcomes: report.conditions.map(row => ({ id: row.condition.id, attempt: row.attempt, outcome: row.report?.baselineOutcome, blocked: row.blocked })) }, null, 2))
  process.exitCode = report.collectionIntegrity ? 0 : 1
  return report
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main, runCase, CONDITIONS, WATCHDOG_MS, OVERRIDES, positiveClose, baselineOutcome }
