'use strict'
// Invoked by the existing Windows native/SQLite watcher fixture. Faults are
// introduced only after genuine native receipts; font bytes and paths stay private.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const deadline = async (pending, label) => {
  let timer
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 30000) })]) }
  finally { clearTimeout(timer) }
}
// The original apply may reject or return row errors before the selected read.
// Retain that outcome immediately rather than relabel it as a readiness timeout.
// After entry wins, Promise.race still owns the eventual pending rejection.
async function awaitReadCloseBoundary(entered, pending, mode) {
  const earlySettlement = pending.then(result => {
    throw Object.assign(Error('Actual watcher apply fulfilled before controlled close boundary: ' + mode), { watcherEarlyResult: result })
  }, error => { throw error })
  await deadline(Promise.race([entered, earlySettlement]), 'Actual watcher read did not reach controlled close boundary: ' + mode)
}

function observeErrorClose(error, evidence) {
  if (error?.sharedIo !== true || typeof error.closed?.then !== 'function') return
  evidence.closeState = 'pending'
  // Observation only: never wait, suppress the original error, or substitute a
  // new lifetime. Both handlers keep a rejected close from becoming unhandled.
  Promise.resolve(error.closed).then(() => { evidence.closeState = 'fulfilled' }, () => { evidence.closeState = 'rejected' })
}

function heldForegroundRead() {
  const entered = deferred(), release = deferred()
  let reads = 0, cancellations = 0, activeSignal
  return { entered: entered.promise, release: () => release.resolve(), get reads() { return reads }, get cancellations() { return cancellations }, get signal() { return activeSignal },
    run: async (result, signal) => {
      if (++reads !== 1) return result
      activeSignal = signal
      const abort = () => { cancellations++; release.reject(Object.assign(Error('controlled held foreground cancelled'), { name: 'AbortError' })) }
      signal?.addEventListener('abort', abort, { once: true }); entered.resolve()
      try { await release.promise; return result } finally { signal?.removeEventListener('abort', abort) }
    },
  }
}

exports.checkWatcherInventoryCheckpoints = async function checkWatcherInventoryCheckpoints({ host, rootIndex, makeWatcher, fontRoot, cacheDir, dbPath, files, manifest, copy, state, startStage, finishStage, audit, controls }) {
  const shared = host.load('src/main/path/sharedFileSystemRuntime.ts')
  const { sharedWatcherInventory } = host.load('src/main/watcher/sharedWatcherInventoryRuntime.ts')
  const cachePaths = host.load('src/main/cache/cachePaths.ts')
  const constants = host.load('src/main/cache/constants.ts')
  const cacheKey = host.load('src/main/path/cachePath.ts').relativePathForRoot
  const change = () => [{ folder: fontRoot, fileName: '.', eventType: 'rescan', receivedAt: Date.now() }]
  const inventory = async () => {
    const receipt = await shared.executeSharedFile({ operation: 'treeSnapshot', path: fontRoot })
    return sharedWatcherInventory(fontRoot, receipt.result.value)
  }
  let jobs = 0, parsedBatches = 0, partial = false, failedPath
  const nativeParse = async (batch, signal) => {
    jobs += batch.length; parsedBatches++
    assert(batch.length <= 32, 'Watcher parse batch exceeded the checkpoint bound')
    const result = await host.indexing.runRustFontParseBatch(batch, signal)
    assert(result?.results.length, 'Actual native parse receipt is required')
    if (partial) return { ...result, results: result.results.filter(row => row.filePath !== failedPath),
      errors: [...(result.errors || []), { path: failedPath, message: 'controlled receipt omission' }] }
    return result
  }
  const watcher = () => makeWatcher({ runRustFontParseBatch: nativeParse })
  const apply = (instance, snapshot, context = {}) => instance.applyWatchedFolderChangesToIndex(change(), false, { inventory: snapshot, ...context })
  const countLive = () => audit(host).entries.filter(row => !row.is_deleted && row.status !== 'deleted').length
  const lockPath = path.join(cacheDir, constants.ROOT_CACHE_LOCK_DIR_NAME, constants.ROOT_INDEX_LOCK_FILE_NAME)
  const initialCount = countLive()
  const prior = audit(host)
  startStage('inventory-noop')
  const noOp = await apply(watcher(), await inventory())
  const noOpWork = finishStage()
  assert.deepEqual([noOp.upserts.length, noOp.deletes.length, noOp.errors.length, jobs], [0,0,0,0])
  assert.equal(noOpWork.operations.treeSnapshot, 1)
  assert.equal(noOpWork.operations.directoryMetadata || 0, 0, 'Inventory triggered a second walk')
  assert.equal(noOpWork.operations.directoryMetadataBatch || 0, 0, 'Inventory triggered a second walk')
  assert.equal(noOpWork.fontStats, 0)
  assert.equal(noOpWork.fontReads, 0, 'No-op inventory reopened font contents')
  assert.deepEqual(audit(host), prior, 'No-op inventory changed actual SQLite state')
  controls.push('complete-inventory-zero-content-reads-and-zero-parse')

  const snapshot = await inventory()
  for (const invalid of [ { ...snapshot, complete: false }, { ...snapshot, rootPath: path.dirname(fontRoot) },
    { ...snapshot, files: new Map([['../escape.ttf', { size: 1, mtimeMs: 1 }]]) },
    { ...snapshot, files: new Map([['case.ttf', { size: 1, mtimeMs: 1 }], ['CASE.ttf', { size: 1, mtimeMs: 1 }]]) },
    { ...snapshot, files: new Map([['invalid.ttf', { size: 1, mtimeMs: Infinity }]]) } ]) {
    await assert.rejects(() => apply(watcher(), invalid))
    assert.deepEqual(audit(host), prior, 'Invalid inventory mutated the persisted index')
  }
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(() => apply(watcher(), snapshot, { signal: cancelled.signal }))
  assert.deepEqual(audit(host), prior)
  controls.push('malformed-incomplete-wrong-root-and-cancel-retain-index')

  // Remove only the new capability from a genuine handshake. The selective
  // watcher must not submit an older parser, even with legacy fallback enabled.
  let legacyParseCommands = 0
  const legacyClient = host.load('src/main/rust-core/clients/rustIndexingClientRuntime.ts').createRustIndexingClientRuntime({
    ...host.transport, appendStartupLog: host.appendLog,
    diagnoseRustCoreWorker: async () => {
      const status = await host.transport.diagnoseRustCoreWorker()
      assert(status.capabilities?.includes('font-parse-batch-source-stability-v1'), 'Fixture worker lacks required source-stability capability')
      return { ...status, capabilities: status.capabilities.filter(value => value !== 'font-parse-batch-source-stability-v1') }
    },
    runRustCoreScheduledCommand: async (binary, args, options) => {
      if (args[0] === '--font-parse-batch') legacyParseCommands++
      return host.transport.runRustCoreScheduledCommand(binary, args, options)
    },
  })
  const oldCompatibility = process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK
  process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK = '1'
  try {
    const incompatible = makeWatcher({ runRustFontParseBatch: legacyClient.runRustFontParseBatch })
    await assert.rejects(() => apply(incompatible, snapshot, { forceVerifyPaths: new Set([cacheKey(fontRoot, files[0])]) }),
      error => error.reason === 'font-parse-source-stability-unavailable')
    assert.equal(legacyParseCommands, 0, 'Watcher submitted a parser lacking the stability contract')
    assert.deepEqual(audit(host), prior, 'Capability denial changed the real root index')
    // The pre-existing manual contract does not require this watcher capability.
    const manual = makeWatcher({ runRustFontParseBatch: legacyClient.runRustFontParseBatch, exposeEntry: true })
    const stat = fs.statSync(files[0]), cache = { version: host.config.FONT_SCAN_CACHE_VERSION, entries: {} }
    const compatible = await manual.upsertFontIndexEntries(fontRoot, [{ file: files[0], freshStat: stat }], cache)
    assert.equal(compatible.results.filter(row => !row.error && row.font).length, 1)
    assert.equal(legacyParseCommands, 1, 'Unmarked manual parsing lost its prior compatibility contract')
  } finally { if (oldCompatibility === undefined) delete process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK; else process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK = oldCompatibility }
  controls.push('old-worker-capability-blocks-selective-watcher-without-changing-manual-contract')

  // Lock the observer's failure identity and early-return behavior separately
  // from native timing. These controls must never count as native read proof.
  const neverEntered = deferred(), originalFailure = Error('controlled pre-boundary rejection')
  await assert.rejects(() => awaitReadCloseBoundary(neverEntered.promise, Promise.reject(originalFailure), 'observer-rejection'), error => error === originalFailure)
  const earlyResult = { upserts: [], deletes: [], errors: [{ message: 'controlled pre-boundary row error' }] }
  await assert.rejects(() => awaitReadCloseBoundary(neverEntered.promise, Promise.resolve(earlyResult), 'observer-return'),
    error => error.watcherEarlyResult === earlyResult && /fulfilled before controlled close boundary/.test(error.message))
  controls.push('close-boundary-observer-preserves-early-apply-outcome')

  // Each real owner must retain a failed native read's close receipt before
  // converting it to cancellation or a normal row error. Faults follow genuine
  // read receipts; the close barrier itself is deliberately held by this test.
  for (const mode of ['target-stat', 'directory-read', 'directory-batch', 'outer-directory', 'compatibility-entry']) {
    const failedClose = deferred(), failureEntered = deferred(), abort = new AbortController()
    const beforeFailure = audit(host)
    const { SharedIoProcessError } = host.load('src/main/path/sharedIoProcessRuntime.ts')
    const failure = new SharedIoProcessError('controlled watcher read failure', 'unknown', 'cancelled')
    failure.closed = failedClose.promise
    const availability = host.load('src/main/path/startupPathAvailabilityRuntime.ts')
    const snapshot = () => Object.fromEntries([['font', fontRoot], ['cache', cacheDir]].map(([name, root]) => {
      const value = availability.getStartupPathRootState(root)
      return [name, { state: value.state, generation: value.generation }]
    }))
    const evidence = state.readCloseBoundary = { mode, outcome: 'pending', injected: false, closeReleased: false,
      availabilityBefore: snapshot(), counts: {}, events: [] }
    state.phase = 'read-close-boundary:' + mode
    // Capture bounded operation labels and signal identity, never inputs, paths,
    // native rows or stdout. Observe without changing admission or settlement.
    state.observeReadCloseBoundary = (owner, label, phase, signal, error) => {
      const allowed = owner === 'native'
        ? ['stat', 'lstat', 'access', 'realpath', 'readFile', 'sqliteSnapshot', 'directoryMetadata', 'directoryMetadataBatch']
        : ['watch:stat-target', 'scan:directory-metadata', 'scan:directory-metadata-batch', 'scan:stat-dir', 'scan:read-dir']
      const operation = allowed.includes(label) ? label : 'other'
      const key = owner + ':' + operation + ':' + phase
      evidence.counts[key] = (evidence.counts[key] || 0) + 1
      const event = { owner, operation, phase, signalPresent: !!signal, expectedSignal: signal === abort.signal, aborted: !!signal?.aborted, error }
      observeErrorClose(error, event); evidence.events.push(event)
      if (evidence.events.length > 24) evidence.events.shift()
    }
    let settled = false, writes = 0, injected = false
    const fail = () => { if (injected) return; injected = true; evidence.injected = true; abort.abort(); failureEntered.resolve(); throw failure }
    state.afterRootApply = () => { writes++ }
    if (mode === 'outer-directory') state.afterDirectoryRows = fail
    else if (mode === 'compatibility-entry') state.afterSingleEntry = fail
    else state.afterGlobalIo = label => {
      const expected = mode === 'target-stat' ? 'watch:stat-target' : mode === 'directory-read' ? 'scan:directory-metadata' : 'scan:directory-metadata-batch'
      if (label === expected) fail()
    }
    const target = ['target-stat', 'compatibility-entry'].includes(mode) ? cacheKey(fontRoot, files[0]) : '.'
    const instance = makeWatcher({ compatibilityEntry: mode === 'compatibility-entry' })
    const pending = instance.applyWatchedFolderChangesToIndex([{ folder: fontRoot, fileName: target, eventType: 'rescan', receivedAt: Date.now() }], false, { signal: abort.signal })
    pending.then(result => { settled = true; evidence.outcome = 'fulfilled'; evidence.result = result },
      error => { settled = true; evidence.outcome = 'rejected'; evidence.error = error; observeErrorClose(error, evidence) })
    try {
      await awaitReadCloseBoundary(failureEntered.promise, pending, mode)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(settled, false, 'Watcher apply settled before physical close: ' + mode)
      assert.equal(writes, 0, 'Watcher wrote while failed read still owned its physical close')
      assert.deepEqual(audit(host), beforeFailure)
      evidence.closeReleased = true; failedClose.resolve()
      await assert.rejects(pending)
      assert.equal(writes, 0)
    } finally {
      state.afterRootApply = undefined; state.afterGlobalIo = undefined; state.afterDirectoryRows = undefined; state.afterSingleEntry = undefined
      evidence.closeReleased = true; failedClose.resolve(); await Promise.allSettled([pending])
      evidence.availabilityAfter = snapshot(); state.observeReadCloseBoundary = undefined
    }
  }
  state.readCloseBoundary = undefined
  state.phase = 'inventory-signature-close-boundary'
  const signatureClose = deferred(), signatureEntered = deferred(), signatureAbort = new AbortController()
  const directoryOwner = makeWatcher({ exposeEntry: true })
  const currentCache = await rootIndex.readRootIndexSqliteFile(dbPath, fontRoot, 'root')
  const signatureContext = directoryOwner.makeRootScanCacheContext(fontRoot, { cachePath: dbPath, cacheDir, storage: 'root', cache: currentCache })
  signatureContext.directoryUpdates.push({ relativePath: '', modifiedAt: fs.statSync(fontRoot).mtimeMs, fileCount: 1, dirCount: files.length - 1 })
  signatureContext.assertCurrent = () => { if (signatureAbort.signal.aborted) throw Error('controlled-signature-owner-cancelled') }
  state.afterDirectorySave = () => {
    const { SharedIoProcessError } = host.load('src/main/path/sharedIoProcessRuntime.ts')
    const failure = new SharedIoProcessError('controlled signature close', 'unknown', 'cancelled'); failure.closed = signatureClose.promise
    signatureAbort.abort(); signatureEntered.resolve(); throw failure
  }
  let signatureSettled = false
  const pendingSignature = directoryOwner.saveRootDirectorySignatures(signatureContext)
  pendingSignature.then(() => { signatureSettled = true }, () => { signatureSettled = true })
  try {
    await deadline(signatureEntered.promise, 'Actual signature writer did not reach its close boundary')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(signatureSettled, false, 'Directory signature guard discarded the physical close owner')
    signatureClose.resolve(); await assert.rejects(pendingSignature, /controlled-signature-owner-cancelled/)
  } finally { state.afterDirectorySave = undefined; signatureClose.resolve(); await Promise.allSettled([pendingSignature]) }
  controls.push('actual-watcher-and-directory-owners-retain-failed-read-close-before-abort')

  // Manual Rust listing and watcher native metadata must use the same rounded
  // identity at both sides of the fractional millisecond boundary.
  const fractional = files.slice(0, 6), originalTimes = fractional.map(file => fs.statSync(file))
  for (const [index, fraction] of [0.4,0.4999,0.5,0.5001,0.7,0.999].entries()) {
    const seconds = (Date.UTC(2026, 1, 1) + fraction) / 1000
    fs.utimesSync(fractional[index], seconds, seconds)
  }
  const listed = await host.indexing.runRustFontIndexListWorker([fontRoot], ['.ttf'], () => {})
  assert(listed && !listed.truncated && !listed.errors.length, 'Actual native manual listing failed')
  const selected = listed.files.filter(row => fractional.includes(row.file))
  assert.equal(selected.length, fractional.length)
  for (const row of selected) {
    const nanos = fs.statSync(row.file, { bigint: true }).mtimeNs
    const expected = Math.round(Number(nanos / 1000000n) + Number(nanos % 1000000n) / 1000000)
    assert.equal(row.stat.mtimeMs, expected, 'Native listing disagrees with actual nanosecond-derived cache identity')
  }
  const rows = selected.map(row => ({ file: row.file, freshStat: row.stat }))
  // This is the production manual-entry owner, fed actual native listing stats.
  const entry = makeWatcher({ runRustFontParseBatch: nativeParse, exposeEntry: true })
  const manualCache = { version: host.config.FONT_SCAN_CACHE_VERSION, entries: {} }
  const prepared = await entry.upsertFontIndexEntries(fontRoot, rows, manualCache)
  assert.equal(prepared.results.filter(row => !row.error).length, fractional.length)
  const manualQueryInvalidations = state.queryInvalidations
  await rootIndex.saveRootIndexSqliteChanges(dbPath, fontRoot, 'root', Object.entries(manualCache.entries), [])
  assert.equal(state.sourcePublicationModes.at(-1), true, 'Default source write stopped publishing query changes')
  assert.equal(state.queryInvalidations - manualQueryInvalidations, 1)
  jobs = 0
  const fractionalNoOp = await apply(watcher(), await inventory())
  assert.deepEqual([fractionalNoOp.errors.length, fractionalNoOp.upserts.length, jobs], [0,0,0], 'Manual→watcher timestamp precision forced a reparse')
  for (const [index, file] of fractional.entries()) fs.utimesSync(file, originalTimes[index].atimeMs / 1000, originalTimes[index].mtimeMs / 1000)
  await apply(watcher(), await inventory())
  controls.push('actual-fractional-manual-listing-to-watcher-cache-hit')

  const swapped = path.join(fontRoot, 'inventory-replacement.ttf'), removed = files.at(-1)
  fs.renameSync(removed, swapped)
  jobs = 0
  const replacement = await apply(watcher(), await inventory())
  assert.deepEqual([replacement.upserts.length, replacement.deletes.length, replacement.errors.length, jobs], [1,1,0,1])
  assert.equal(countLive(), initialCount, 'Same-count rename lost population')
  fs.renameSync(swapped, removed)
  await apply(watcher(), await inventory())
  controls.push('same-count-native-rename-add-delete')

  // A concrete bounded native hint must recheck an equal-size/equal-mtime
  // overwrite. Metadata-only reconciliation alone cannot establish this fact.
  const hintedFile = files[7], hintedStat = fs.statSync(hintedFile)
  const originalHeader = Buffer.alloc(4)
  let handle = fs.openSync(hintedFile, 'r+')
  fs.readSync(handle, originalHeader, 0, 4, 0)
  fs.writeSync(handle, Buffer.from('OOOO'), 0, 4, 0); fs.closeSync(handle)
  fs.utimesSync(hintedFile, hintedStat.atimeMs / 1000, hintedStat.mtimeMs / 1000)
  const hint = new Set([cacheKey(fontRoot, hintedFile)]), progress = []
  jobs = 0
  const hintResult = await apply(watcher(), await inventory(), { forceVerifyPaths: hint, onProgress: count => progress.push(count) })
  assert.deepEqual([hintResult.errors.length, hintResult.deletes.length, jobs], [0,1,1], 'Concrete equal-metadata change bypassed selective native verification')
  assert.deepEqual(progress, [1], 'Processing count was cleared before index/projection acknowledgement')
  handle = fs.openSync(hintedFile, 'r+')
  fs.writeSync(handle, originalHeader, 0, 4, 0); fs.closeSync(handle)
  fs.utimesSync(hintedFile, hintedStat.atimeMs / 1000, hintedStat.mtimeMs / 1000)
  jobs = 0
  const hintRecovery = await apply(watcher(), await inventory(), { forceVerifyPaths: hint })
  assert.deepEqual([hintRecovery.errors.length, hintRecovery.upserts.length, jobs], [0,1,1])
  controls.push('bounded-concrete-hint-verifies-equal-size-and-mtime-content-change')

  // One omitted native parse result cannot delete any row in the partial pass.
  const changed = files.slice(4, 6)
  const oldRows = new Map(audit(host).entries.map(row => [row.relative_path, row]))
  changed.forEach(file => { const stat = fs.statSync(file); fs.utimesSync(file, stat.atimeMs / 1000, (stat.mtimeMs + 2100) / 1000) })
  fs.renameSync(removed, removed + '.held')
  failedPath = changed[1]; partial = true; jobs = 0
  const previousFallback = process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK
  process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK = '1'
  let partialResult
  try { partialResult = await apply(watcher(), await inventory()) }
  finally { partial = false; if (previousFallback === undefined) delete process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK; else process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK = previousFallback }
  assert(partialResult.errors.length > 0)
  assert.equal(partialResult.deletes.length, 0, 'Partial parse deleted rows')
  const retained = new Map(audit(host).entries.map(row => [row.relative_path, row]))
  assert.deepEqual(retained.get(cacheKey(fontRoot, failedPath)), oldRows.get(cacheKey(fontRoot, failedPath)), 'Failed parse replaced its old SQLite row')
  assert.equal(countLive(), initialCount, 'Partial parse lost the missing-source row')
  fs.renameSync(removed + '.held', removed)
  jobs = 0
  const partialRecovery = await apply(watcher(), await inventory())
  assert.equal(partialRecovery.errors.length, 0)
  assert.equal(jobs, 1, 'Completed partial work was reparsed on recovery')
  controls.push('partial-native-parse-retains-old-and-deletion-proof')

  // Hold the actual selected page/facade owners after real native receipts.
  // Two durable checkpoints plus a final source transaction must not change
  // query generations, abort the reader, or force a second physical query.
  await state.sync.syncMergedIndexForRootSnapshot(fontRoot, 'watcher-checkpoint-foreground-prepare')
  await Promise.all([...state.context.mergedIndexValidateInFlight.values()])
  await state.context.waitForMergedIndexMutations()
  host.query.clearFontQueryCaches()
  state.context.mergedIndexLastValidateAt.set(state.context.mergedIndexRootsKey([fontRoot]), Date.now())
  const pageHeld = heldForegroundRead(), idsHeld = heldForegroundRead(), sourceHeld = heldForegroundRead()
  const pageRequest = { sidebarPage: 'library', activeFilter: { kind: 'all' }, installStatus: 'all', sortMode: 'nameAsc', limit: 7, offset: 0 }
  const foregroundController = new AbortController()
  host.folderCache.invalidateSharedFontRuntimeCaches(false)
  state.sourceRead = sourceHeld.run
  state.foreground = { page: pageHeld.run, ids: idsHeld.run }
  const heldPage = shared.withSharedIoSignal(foregroundController.signal, () => host.query.queryFontPageInLibrary(pageRequest))
  const heldIds = shared.withSharedIoSignal(foregroundController.signal, () => host.query.queryFontsInLibrary({ ...pageRequest, limit: 1000 }))
  const heldSource = shared.withSharedIoSignal(foregroundController.signal, () => host.folderCache.loadSharedFontsForFolders([fontRoot]))
  heldPage.catch(() => undefined); heldIds.catch(() => undefined); heldSource.catch(() => undefined)
  let foregroundPayload
  try {
    await deadline(Promise.all([pageHeld.entered, idsHeld.entered, sourceHeld.entered]), 'Actual foreground page/IDs reads did not enter their hold')
    const beforeSource = state.sourceInvalidations, beforeQuery = state.queryInvalidations, beforeModes = state.sourcePublicationModes.length
    const beforeProjection = host.projectionEvents.filter(row => row.source === 'projection').length
    for (const file of files.slice(0, 65)) { const stat = fs.statSync(file); fs.utimesSync(file, stat.atimeMs / 1000, (stat.mtimeMs + 3100) / 1000) }
    const actualWrites = []
    state.afterRootApply = input => actualWrites.push({ upserts: input.upserts.length, deletes: input.deletes.length })
    jobs = 0
    try { foregroundPayload = await apply(watcher(), await inventory()) } finally { state.afterRootApply = undefined }
    assert.equal(foregroundPayload.errors.length, 0)
    assert.equal(jobs, 65)
    assert.deepEqual(actualWrites, [{ upserts: 32, deletes: 0 }, { upserts: 32, deletes: 0 }, { upserts: 1, deletes: 0 }])
    assert.equal(state.sourceInvalidations - beforeSource, 3, 'Durable source writes failed to invalidate actual source cache')
    assert.equal(state.queryInvalidations - beforeQuery, 0, 'Checkpoint/final source write invalidated actual query generation')
    assert.deepEqual(state.sourcePublicationModes.slice(beforeModes), [false, false, false])
    assert.equal(host.projectionEvents.filter(row => row.source === 'projection').length, beforeProjection, 'Source checkpoint published a view revision')
    assert.deepEqual([pageHeld.cancellations, idsHeld.cancellations, sourceHeld.cancellations], [0, 0, 0])
    pageHeld.release(); idsHeld.release(); sourceHeld.release()
    const [pageResult, idsResult, oldSource] = await deadline(Promise.all([heldPage, heldIds, heldSource]), 'Checkpoint invalidation retired a held foreground generation')
    assert.equal(pageResult.total, initialCount); assert.equal(idsResult.total, initialCount)
    assert.deepEqual([pageHeld.reads, idsHeld.reads, sourceHeld.reads], [1, 1, 1], 'Checkpoint forced a foreground reread despite no physical abort')
    assert.equal(oldSource.length, initialCount)
    const newSource = await host.folderCache.loadSharedFontsForFolders([fontRoot])
    assert.equal(sourceHeld.reads, 2, 'Held stale source result repopulated the post-checkpoint cache')
    assert.equal(newSource.length, initialCount)
    assert.notDeepEqual(newSource.map(row => row.id).sort(), oldSource.map(row => row.id).sort(), 'Next source read reused stale checkpoint identities')
  } finally { state.foreground = undefined; state.sourceRead = undefined; pageHeld.release(); idsHeld.release(); sourceHeld.release(); await Promise.allSettled([heldPage, heldIds, heldSource]) }

  // A confirmed merged commit, in contrast, retires the old page exactly once.
  // Source reads above deliberately keep the previously committed view valid.
  const mergedHeld = heldForegroundRead()
  state.context.mergedIndexLastValidateAt.set(state.context.mergedIndexRootsKey([fontRoot]), Date.now())
  state.foreground = { page: mergedHeld.run, ids: result => result }
  const beforeMergeEvents = host.projectionEvents.filter(row => row.source === 'projection').length
  const oldPage = host.query.queryFontPageInLibrary({ ...pageRequest, offset: 1 })
  oldPage.catch(() => undefined)
  try {
    await deadline(mergedHeld.entered, 'Actual foreground page did not enter pre-merge hold')
    await state.sync.syncMergedIndexForRootIncremental(fontRoot, foregroundPayload, 'watcher')
    await state.context.waitForMergedIndexMutations()
    assert.equal(mergedHeld.cancellations, 1, 'Confirmed merged publication did not retire the held physical page once')
    assert.equal(host.projectionEvents.filter(row => row.source === 'projection').length - beforeMergeEvents, 1, 'Confirmed merged commit did not publish exactly one view revision')
    const currentPage = await deadline(oldPage, 'Retired page did not recover after confirmed merged publication')
    assert.equal(currentPage.total, initialCount)
    assert.equal(mergedHeld.reads, 2, 'Page did not replace the retired generation exactly once')
  } finally { state.foreground = undefined; mergedHeld.release(); await Promise.allSettled([oldPage]) }
  const supersededSource = heldForegroundRead()
  host.folderCache.invalidateSharedFontRuntimeCaches(false)
  state.sourceRead = supersededSource.run
  const oldSourceLoad = host.folderCache.loadSharedFontsForFolders([fontRoot])
  oldSourceLoad.catch(() => undefined)
  try {
    await deadline(supersededSource.entered, 'Actual source read did not enter full-invalidation hold')
    host.folderCache.invalidateSharedFontRuntimeCaches()
    supersededSource.release()
    const failure = host.load('src/shared/fontQueryFailure.ts')
    await assert.rejects(oldSourceLoad, error => failure.isFontQuerySuperseded(error))
  } finally { state.sourceRead = undefined; supersededSource.release(); await Promise.allSettled([oldSourceLoad]) }
  controls.push('actual-source-checkpoints-preserve-page-and-facade-until-one-merged-publication')

  // A manual scan taking admission while actual native parsing is in flight
  // invalidates the watcher guard before any checkpoint or deletion can commit.
  const preemptedFile = files[10], preemptedStat = fs.statSync(preemptedFile)
  fs.utimesSync(preemptedFile, preemptedStat.atimeMs / 1000, (preemptedStat.mtimeMs + 1700) / 1000)
  fs.renameSync(removed, removed + '.held')
  const preemptedBefore = audit(host), parseEntered = deferred(), parseRelease = deferred()
  let manualActive = false, preemptedWrites = 0
  const preempted = makeWatcher({ runRustFontParseBatch: async (...args) => { const result = await nativeParse(...args); parseEntered.resolve(); await parseRelease.promise; return result } })
  state.afterRootApply = () => { preemptedWrites++ }
  const preemptedApply = apply(preempted, await inventory(), { assertCurrent: () => { if (manualActive) throw Error('watcher-scan-preempted') } })
  preemptedApply.catch(() => undefined)
  try {
    await deadline(parseEntered.promise, 'Native parse did not enter manual-preemption hold')
    manualActive = true; parseRelease.resolve()
    await assert.rejects(preemptedApply, /watcher-scan-preempted/)
    assert.equal(preemptedWrites, 0)
    assert.deepEqual(audit(host), preemptedBefore, 'Manual preemption committed stale watcher rows or deletions')
  } finally { state.afterRootApply = undefined; parseRelease.resolve(); await Promise.allSettled([preemptedApply]); fs.renameSync(removed + '.held', removed) }
  manualActive = false
  jobs = 0
  const afterManual = await apply(watcher(), await inventory())
  assert.deepEqual([afterManual.errors.length, afterManual.deletes.length, jobs], [0, 0, 1])
  controls.push('manual-admission-during-real-native-parse-prevents-checkpoint-and-deletion')

  // A real upsert transaction survives cancellation. It is neither a deletion
  // nor a fully indexed cursor; reopening SQLite parses only the remaining rows.
  const checkpointFiles = files.slice(0, 65)
  for (const file of checkpointFiles) { const stat = fs.statSync(file); fs.utimesSync(file, stat.atimeMs / 1000, (stat.mtimeMs + 4100) / 1000) }
  fs.renameSync(removed, removed + '.held')
  const controller = new AbortController()
  let commits = 0
  jobs = 0; parsedBatches = 0
  const interrupted = makeWatcher({ runRustFontParseBatch: nativeParse })
  state.afterRootApply = input => {
    assert.equal(input.deletes.length, 0, 'A checkpoint contained deletion authority')
    commits++
    if (commits === 1) controller.abort()
  }
  const interruptedSnapshot = await inventory()
  try {
    await assert.rejects(() => apply(interrupted, interruptedSnapshot, { signal: controller.signal }), error => error.watcherCommittedCheckpointRows === 32)
  } finally { state.afterRootApply = undefined }
  assert(!fs.existsSync(lockPath), 'Generation cancellation stranded its owned native root lock')
  assert.equal(commits, 1)
  assert.equal(jobs, 32, 'Cancellation failed to bound parsing at the persisted checkpoint')
  assert.equal(countLive(), initialCount, 'Cancelled checkpoint deleted a missing row')
  const persisted = new Map(audit(host).entries.map(row => [row.relative_path, row]))
  let matching = 0
  for (const file of checkpointFiles) {
    const stat = fs.statSync(file), key = cacheKey(fontRoot, file)
    if (persisted.get(key)?.cache_key === cachePaths.fileCacheSignature(key, stat.size, stat.mtimeMs)) matching++
  }
  assert.equal(matching, 32, 'Checkpoint was not durable in real SQLite')
  jobs = 0
  const resumed = await apply(watcher(), await inventory())
  assert.deepEqual([resumed.errors.length, resumed.deletes.length, jobs], [0,1,33], 'Reopened watcher did not reuse durable partial work')
  const projectionReceiptStart = host.receipts.length
  await state.sync.syncMergedIndexForRootSnapshot(fontRoot, 'watcher-checkpoint-restart')
  await state.context.waitForMergedIndexMutations()
  assert(host.receipts.slice(projectionReceiptStart).some(row => ['runRustMergedIndexRebuild','runRustMergedIndexSync'].includes(row.method)), 'Restart projection reconciliation did not use the actual native owner')
  const restoredPage = await state.page.queryFontPageFromMergedIndexWorker({ sidebarPage: 'library', activeFilter: { kind: 'all' }, installStatus: 'all', sortMode: 'nameAsc' }, 1000, 0)
  assert(restoredPage)
  assert.equal(restoredPage.total, initialCount - 1)
  const projectedIds = new Set(restoredPage.items.map(item => item.id))
  for (const file of checkpointFiles) {
    const stat = fs.statSync(file)
    assert(projectedIds.has(host.fontIdentity.fileRuntimeFontId(file, stat.size, stat.mtimeMs)), 'Durable checkpoint row was missing from the reopened native worker page')
  }
  controls.push('restart-checkpoint-native-snapshot-sync-restores-all-65-visible-identities')
  fs.renameSync(removed + '.held', removed)
  await apply(watcher(), await inventory())
  jobs = 0
  const secondLaunch = await apply(watcher(), await inventory())
  assert.deepEqual([secondLaunch.upserts.length, secondLaunch.deletes.length, secondLaunch.errors.length, jobs], [0,0,0,0])
  controls.push('real-sqlite-checkpoint-cancel-reopen-only-remaining-parse')

  const caseFile = files[0], caseRenamed = path.join(path.dirname(caseFile), path.basename(caseFile).toUpperCase())
  fs.renameSync(caseFile, caseRenamed)
  jobs = 0
  const caseChange = await apply(watcher(), await inventory())
  assert.deepEqual([caseChange.errors.length, caseChange.deletes.length, jobs], [0,0,0], 'Case-only rename deleted or reparsed the same normalized identity')
  assert.equal(countLive(), initialCount)
  fs.renameSync(caseRenamed, caseFile)
  controls.push('case-only-rename-preserves-normalized-row')

  // A stale waiter must be rejected after acquiring the real root lock, before
  // submitting a native SQLite mutation. The transport rejects the genuine
  // exclusive-open EEXIST receipt; it is not a fulfilled executor response.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, 'controlled-external-lock-owner')
  const existing = await rootIndex.readRootIndexSqliteFile(dbPath, fontRoot, 'root')
  const first = Object.entries(existing.entries)[0]
  const beforeStale = audit(host)
  let current = true, blocked = false
  state.observeNativeFailure = (request, error) => {
    if (request.operation === 'openFile' && path.resolve(request.path) === path.resolve(lockPath)) {
      assert.equal(error.sharedIo, true)
      assert.equal(error.code, 'EEXIST')
      assert.equal(error.outcome, 'not-started')
      assert.equal(error.reason, 'file-write-failed')
      blocked = true; current = false
      fs.unlinkSync(lockPath)
    }
  }
  try {
    await assert.rejects(() => rootIndex.saveRootIndexSqliteChanges(dbPath, fontRoot, 'root', [first], [], () => {
      if (!current) throw new Error('controlled-stale-root-owner')
    }), /controlled-stale-root-owner/)
  } finally { state.observeNativeFailure = undefined; if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath) }
  assert(blocked, 'Stale-waiter case did not reach the actual lock contention boundary')
  assert.deepEqual(audit(host), beforeStale, 'Stale lock waiter changed real SQLite state')
  controls.push('actual-root-lock-stale-waiter-rejected-before-native-write')
  // Cancellation while a different owner keeps the lock must settle without
  // waiting for the full lock timeout or removing that owner's file.
  fs.writeFileSync(lockPath, 'external-owner-remains')
  const waitingAbort = new AbortController()
  let sawBlocked = false
  state.observeNativeFailure = (request, error) => {
    if (request.operation === 'openFile' && path.resolve(request.path) === path.resolve(lockPath)) {
      assert.equal(error.sharedIo, true)
      assert.equal(error.code, 'EEXIST')
      assert.equal(error.outcome, 'not-started')
      assert.equal(error.reason, 'file-write-failed')
      sawBlocked = true; waitingAbort.abort()
    }
  }
  const waitStarted = Date.now()
  try {
    await assert.rejects(() => shared.withSharedIoSignal(waitingAbort.signal, () => rootIndex.saveRootIndexSqliteChanges(dbPath, fontRoot, 'root', [first], [])))
    assert(sawBlocked)
    assert(Date.now() - waitStarted < 3000, 'Cancellation waited for the complete external root-lock timeout')
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'external-owner-remains', 'Cancelled waiter removed another owner lock')
  } finally { state.observeNativeFailure = undefined; fs.unlinkSync(lockPath) }
  controls.push('cancelled-root-lock-waiter-retains-other-owner-and-settles')
  return { noOpFontReads: noOpWork.fontReads, noOpParseJobs: 0, checkpointRows: 32, resumedParseJobs: 33 }
}
