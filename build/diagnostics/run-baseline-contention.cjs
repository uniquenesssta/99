#!/usr/bin/env node
'use strict'
// Separate Windows diagnostic orchestration. Never invokes/changes acceptance.
// Mirrors the established frozen worktree + identical-lockfile junction setup.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process')
const assert = require('node:assert/strict'), crypto = require('node:crypto')
const root = path.resolve(__dirname, '../..'), baseline = '6620b3bafd5b3d894987585dd06c5d5eabc54933'
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function git(...args) { return cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim() }
function run(command, args, options = {}) {
  const result = cp.spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options })
  assert.equal(result.status, 0, String(result.error || `${command} exited ${result.status}`))
  return result
}
function closed(proof) {
  return proof?.hostClosed === true && proof.databaseOwnersClosed === true && proof.childrenReaped === true &&
    proof.remainingDatabaseOwners === 0 && proof.remainingChildren === 0
}
function main() {
  assert.equal(process.platform, 'win32', 'Baseline investigation orchestration only executes on Windows')
  const evidence = path.join(root, 'artifacts/real-feedback'), output = path.join(evidence, 'baseline-contention')
  fs.mkdirSync(evidence, { recursive: true })
  assert(!fs.existsSync(output), 'Do not overwrite or retry an existing baseline investigation')
  const recordPath = path.join(evidence, 'baseline-contention-orchestration.json')
  assert(!fs.existsSync(recordPath), 'Do not overwrite a prior orchestration record')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-baseline-contention-')), source = path.join(temporary, 'source')
  const report = { schema: 'hfm-frozen-baseline-orchestration-v1', diagnosticOnly: true, excludedFromAcceptance: true,
    baseline, diagnosticSource: git('rev-parse', 'HEAD'), startedAt: new Date().toISOString(), collectionIntegrity: false,
    output, temporary, source, attempts: 1, originalAcceptanceInvoked: false }
  fs.writeFileSync(recordPath, JSON.stringify(report, null, 2), { flag: 'wx' })
  let attached = false, buildComplete = false, diagnosticStarted = false, safeToRemove = false, failure
  try {
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Commit diagnostic sources before a Windows evidence run')
    const worker = path.join(root, 'build/native/hfm-core-worker.exe')
    assert(fs.statSync(worker).isFile(), 'Build the current Windows worker first using the existing build command')
    run('git', ['worktree', 'add', '--detach', source, baseline]); attached = true
    const baselineLock = git('rev-parse', `${baseline}:package-lock.json`), currentLock = git('rev-parse', 'HEAD:package-lock.json')
    assert.equal(baselineLock, currentLock, 'Baseline dependency reuse requires identical lockfiles')
    const modules = path.join(source, 'node_modules'), currentModules = path.join(root, 'node_modules')
    assert(fs.statSync(currentModules).isDirectory(), 'Install current dependencies with npm ci first')
    assert(!fs.existsSync(modules), 'Temporary baseline dependency destination must be absent')
    fs.symlinkSync(currentModules, modules, 'junction')
    assert.equal(fs.realpathSync.native(modules), fs.realpathSync.native(currentModules))
    report.dependencyLock = currentLock; report.dependencyReuse = 'Explicit temporary junction; identical package-lock blob verified'
    run(process.execPath, [path.join(source, 'build/rust/build-core-worker.cjs'), '--required'], { cwd: source, timeout: 600000 })
    buildComplete = true
    const baselineWorker = path.join(source, 'build/native/hfm-core-worker.exe')
    report.baselineWorkerSha256 = hash(baselineWorker); report.fixturePreparationWorkerSha256 = hash(worker)
    assert.equal(git('-C', source, 'rev-parse', 'HEAD'), baseline)
    assert.equal(git('-C', source, 'status', '--porcelain', '--untracked-files=no'), '')
    diagnosticStarted = true
    const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'check-baseline-contention.cjs'),
      '--current-root', root, '--baseline-root', source, '--worker', worker, '--baseline-worker', baselineWorker, '--output', output],
    { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 35 * 60 * 1000 })
    report.diagnosticExitCode = result.status; report.diagnosticSignal = result.signal
    if (result.error) report.diagnosticProcessError = String(result.error)
    const finalPath = path.join(output, 'investigation.json')
    if (fs.existsSync(finalPath)) {
      const investigation = JSON.parse(fs.readFileSync(finalPath, 'utf8'))
      report.collectionIntegrity = result.status === 0 && investigation.collectionIntegrity === true
      report.outcomes = investigation.conditions.map(row => ({ id: row.condition.id, attempt: row.attempt, baselineOutcome: row.report?.baselineOutcome, blocked: row.blocked }))
      // A correctness failure does not prevent safe cleanup; missing physical
      // close/archive proof does. Never remove a worktree still possibly owned.
      safeToRemove = !result.error && investigation.conditions.length === 2 && investigation.conditions.every(row =>
        row.attempt === 1 && closed(row.report?.ownersAfterCleanup) && row.report?.fixtureCacheLifecycle?.ok === true)
    }
    if (!report.collectionIntegrity) failure = Error('Diagnostic collection incomplete; retained reports are not acceptance evidence')
  } catch (error) { failure = error; report.failure = error.stack || String(error) }
  finally {
    // A failed/timed-out build may retain subprocesses; leave its private tree.
    if (attached && !diagnosticStarted && buildComplete) safeToRemove = true
    if (attached && safeToRemove) {
      try {
        const link = path.join(source, 'node_modules')
        if (fs.existsSync(link)) { assert(fs.lstatSync(link).isSymbolicLink()); fs.rmSync(link, { recursive: true, force: true }) }
        assert.equal(git('-C', source, 'rev-parse', 'HEAD'), baseline)
        run('git', ['worktree', 'remove', '--force', source])
        fs.rmSync(temporary, { recursive: true, force: true }); report.worktreeCleanup = 'owned worktree removed after positive physical-close proof'
      } catch (error) { report.worktreeCleanupFailure = error.stack || String(error); failure ||= error }
    } else if (attached) report.worktreeCleanup = 'retained: physical cleanup not proved; no forced namespace/worktree removal'
    else { fs.rmdirSync(temporary); report.worktreeCleanup = 'no worktree attached' }
    report.finishedAt = new Date().toISOString()
    if (failure) report.collectionIntegrity = false
    fs.writeFileSync(recordPath, JSON.stringify(report, null, 2))
  }
  console.log(JSON.stringify({ diagnosticOnly: true, excludedFromAcceptance: true, collectionIntegrity: report.collectionIntegrity,
    output, orchestration: recordPath, worktreeCleanup: report.worktreeCleanup }, null, 2))
  if (failure) { console.error(failure); process.exitCode = 1 }
  return report
}
if (require.main === module) try { main() } catch (error) { console.error(error); process.exitCode = 1 }
module.exports = { main, closed }
