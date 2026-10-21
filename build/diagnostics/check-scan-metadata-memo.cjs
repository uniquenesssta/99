#!/usr/bin/env node
'use strict'
// Windows only; isolated generated files/SQLite. Never touches user NAS/fonts.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')
const { fixture } = require('./check-scan-partial-retention.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
function job(overrides = {}) {
  return { jobId: '1', rootPath: 'C:\\fonts', filePath: 'C:\\fonts\\one.ttf', cacheKey: 'one.ttf', signature: 'one:8:1', fileSize: 8, modifiedAt: 1, createdAt: 1,
    signatureValid: true, sourceStability: 'stable', parseDisposition: { scripts: 'complete' }, nameHint: { familyName: 'Fixture' }, scriptHint: { scripts: ['latin'] }, ...overrides }
}
function boundaries() {
  const load = loader(), { createScanMetadataMemoRuntime } = load('src/main/indexing/scan-orchestrator/scanMetadataMemoRuntime.ts')
  const memo = createScanMetadataMemoRuntime({ entries: 2, bytes: 8192 }), one = job()
  memo.remember('root', 'epoch:1', one, 1)
  assert(memo.read('root', 'epoch:1', one), 'success metadata not reused')
  const copy = memo.read('root', 'epoch:1', one); copy.nameHint.familyName = 'mutated'; copy.tagNames = ['private']
  assert.equal(memo.read('root', 'epoch:1', one).nameHint.familyName, 'Fixture')
  assert.equal(memo.read('root', 'epoch:2', one), undefined, 'registration/rebuild/parser/script epoch reused')
  for (const disposition of ['missing', 'empty', 'unsupported', 'malformed']) {
    const bad = job({ scriptHint: undefined, parseDisposition: { scripts: disposition } })
    memo.remember('root', 'epoch:1', bad, 1); assert(memo.read('root', 'epoch:1', bad))
    memo.clearRoot('root')
  }
  for (const bad of [job({ sourceStability: undefined }), job({ sourceStability: 'changed' }), job({ sourceStability: 'unknown' }),
    job({ parseDisposition: undefined }), job({ parseDisposition: { scripts: 'io-error' } }), job({ parseDisposition: { scripts: 'resource-limit' } }),
    job({ signatureValid: false }), job({ parseDisposition: { scripts: 'not-requested' } })]) {
    memo.remember('root', 'epoch:1', bad, 1); assert.equal(memo.size().entries, 0, 'unproven result cached')
  }
  memo.remember('root', 'epoch:1', one, 1)
  memo.prune('root', new Set(), false); assert.equal(memo.size().entries, 1, 'partial listing removed unseen memo')
  memo.prune('root', new Set(), true); assert.equal(memo.size().entries, 0)
  for (const delta of [{ modifiedAt: 2 }, { fileSize: 9 }, { createdAt: 2 }, { contentHash: 'changed' }]) {
    memo.remember('root', 'epoch:1', one, 1); assert.equal(memo.read('root', 'epoch:1', { ...one, ...delta }), undefined)
  }
  const parsed = job({ contentHash: 'native-read-hash' }); memo.remember('root', 'epoch:1', parsed, 1, one)
  assert(memo.read('root', 'epoch:1', one), 'native output hash incorrectly compared to absent enumeration hash')
  for (let i = 0; i < 10; i++) memo.remember('root', 'epoch:1', job({ cacheKey: `font-${i}` }), 1)
  assert.equal(memo.size().entries, 2); assert(memo.size().bytes <= 8192)
  const tiny = createScanMetadataMemoRuntime({ entries: 10000, bytes: 1000 })
  for (let i = 0; i < 50; i++) tiny.remember('root', 'epoch', job({ cacheKey: `font-${i}` }), 1)
  assert(tiny.size().bytes <= 1000)
  assert.equal(createScanMetadataMemoRuntime().size().entries, 0, 'new process owner inherited memo')
}
async function recoveryRounds() {
  const f = await fixture()
  try {
    const [a, b] = f.folders
    // A missing display name remains a real parse failure; unknown scripts now
    // belong to other (covered by native metadata recovery diagnostics).
    // 4122 entries in failed root, 1435 in independent healthy root.
    for (const [folder, count] of [[a, 4119], [b, 1432]]) {
      for (let start = 0; start < count; start += 100) await Promise.all(Array.from({ length: Math.min(100, count - start) }, (_, n) => fs.writeFile(path.join(folder, `fixture-${start + n}.ttf`), 'synthetic-font')))
    }
    const previous = plain((await f.read(a)).entries), originalStorage = f.deps.ensureRootScanCacheStorage
    let bCommitted = false, parsed = 0, failureMode = 'unsupported', failingPath, parseGate, parseEntered
    const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
    f.deps.ensureRootScanCacheStorage = async root => {
      const storage = await originalStorage(root)
      if (root === a || !bCommitted) storage.cache = { ...storage.cache, rebuildRequired: true, rebuildRequestId: 'recovery-fixture' }
      return storage
    }
    const save = f.deps.saveScanCacheFile
    f.deps.saveScanCacheFile = async (...args) => { await save(...args); if (args[2] === b) bCommitted = true }
    f.deps.runRustFontParseBatch = async jobs => {
      parsed += jobs.length
      parseEntered?.resolve()
      if (parseGate) await parseGate.promise
      return { results: jobs.map(input => {
        const match = path.basename(input.filePath).match(/^fixture-(\d+)\.ttf$/)
        const failed = input.rootPath === a && match && Number(match[1]) < 55
        if (failed) failingPath ||= input.filePath
        return { ...input, signatureValid: true, sourceStability: 'stable', parseDisposition: { scripts: failed ? Number(match[1]) === 54 ? 'malformed' : failureMode : 'complete' },
          nameHint: failed ? undefined : { familyName: 'Synthetic' }, scriptHint: failed ? undefined : { scripts: ['latin'] } }
      }) }
    }
    const first = await f.scan.scanFoldersWhenIdle(f.folders)
    assert.equal(parsed, 5557); assert.equal(first.errors.length, 55)
    assert.deepEqual(plain(first.committedFolders), [b], 'failed recovery blocked healthy root or published partial root')
    assert.deepEqual(plain((await f.read(a)).entries), previous, 'failed root replaced old rows/tags')
    for (let i = 0; i < 2; i++) {
      const before = parsed, repeated = await f.scan.scanFoldersWhenIdle([a])
      assert.equal(parsed, before, 'unchanged retry reparsed the library')
      assert.equal(repeated.errors.length, 55); assert.equal(repeated.committedFolders.length, 0)
      assert.deepEqual(plain((await f.read(a)).entries), previous)
    }
    await fs.appendFile(failingPath, '-new')
    const beforeChange = parsed; await f.scan.scanFoldersWhenIdle([a]); assert.equal(parsed - beforeChange, 1)
    const beforeManual = parsed; await f.scan.scanFoldersManaged([a]); assert.equal(parsed - beforeManual, 4122, 'manual retry did not bypass negative and positive memo')
    const beforeEpoch = parsed
    f.load('src/main/watcher/folderWatcherRegistrationRuntime.ts').retireFolderWatcherRegistration()
    await f.scan.scanFoldersWhenIdle([a]); assert.equal(parsed - beforeEpoch, 4122, 'remove/re-add epoch reused previous memo')
    // Complete enumeration reconciles delete/add without reparsing retained successes.
    await fs.unlink(path.join(a, 'fixture-100.ttf'))
    await fs.writeFile(path.join(a, 'added.ttf'), 'new-synthetic')
    const beforeAdd = parsed; await f.scan.scanFoldersWhenIdle([a]); assert.equal(parsed - beforeAdd, 1)
    // A partial listing must not evict metadata for a temporarily unreadable subtree.
    f.state.denied = path.join(a, 'child')
    await f.scan.scanFoldersWhenIdle([a]); f.state.denied = ''
    const beforeComplete = parsed; await f.scan.scanFoldersWhenIdle([a]); assert.equal(parsed, beforeComplete)
    // Cancellation after native admission cannot leave reusable partial work.
    parseGate = deferred(); parseEntered = deferred()
    const cancelled = f.scan.scanFoldersManaged([a]); await parseEntered.promise
    f.scan.cancelActiveFontScan('controlled memo cancellation'); parseGate.resolve()
    assert.equal((await cancelled).stats.cancelled, true)
    parseGate = undefined; parseEntered = undefined
    const afterCancel = parsed; await f.scan.scanFoldersWhenIdle([a]); assert.equal(parsed - afterCancel, 4122)
    // Registration retirement while native work is in flight rejects publication
    // and clears this round, including already retained successful hints.
    parseGate = deferred(); parseEntered = deferred()
    const retired = f.scan.scanFoldersManaged([a]); const retiredOutcome = retired.then(value => ({ value }), error => ({ error }))
    await parseEntered.promise
    f.load('src/main/watcher/folderWatcherRegistrationRuntime.ts').retireFolderWatcherRegistration()
    parseGate.resolve(); const outcome = await retiredOutcome
    assert(outcome.error, 'mid-round root retirement published a result')
    parseGate = undefined; parseEntered = undefined
    assert.deepEqual(plain((await f.read(a)).entries), previous)
    const afterRetire = parsed; await f.scan.scanFoldersWhenIdle([a]); assert.equal(parsed - afterRetire, 4122)
    failureMode = 'complete'
    f.deps.runRustFontParseBatch = async jobs => { parsed += jobs.length; return { results: jobs.map(input => ({ ...input, signatureValid: true,
      sourceStability: 'stable', parseDisposition: { scripts: 'complete' }, nameHint: { familyName: 'Repaired' }, scriptHint: { scripts: ['latin'] } })) } }
    const repaired = await f.scan.scanFoldersManaged([a]); assert.equal(repaired.errors.length, 0); assert.deepEqual(plain(repaired.committedFolders), [a])
    assert.equal(Object.keys((await f.read(a)).entries).length, 4122)
  } finally { await f.close() }
}
async function main() {
  if (process.platform !== 'win32') throw Error('This diagnostic requires Windows')
  boundaries(); await recoveryRounds(); console.log('scan metadata memo boundaries and 4122/1435 recovery rounds passed')
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { boundaries, recoveryRounds }
