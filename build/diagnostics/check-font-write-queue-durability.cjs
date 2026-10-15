#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:font-write-queue-durability] ${message}`)
    process.exit(1)
  }
}
function loadTypeScriptModule(rel) {
  const output = ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} }
  new Function('exports', 'require', 'module', '__filename', '__dirname', output)(
    module.exports,
    id => id === './fontTagStateAuthorityRuntime' ? loadTypeScriptModule('src/renderer/src/fontTagStateAuthorityRuntime.ts') : id === './fontOperationTrace' ? require('./check-operation-chain.cjs').loader()('src/renderer/src/fontOperationTrace.ts') : id === './fontUserIntentRuntime' ? loadTypeScriptModule('src/renderer/src/fontUserIntentRuntime.ts') : require(id),
    module,
    path.join(root, rel),
    path.dirname(path.join(root, rel))
  )
  return module.exports
}

const queueSource = read('src/renderer/src/fontWriteQueue.ts')
for (const needle of [
  'retryQueue: QueuedFontWriteState',
  'mergeQueuedFontWritesPreservingNewer',
  'failedIdsFromResult',
  'retryTagEntries',
  'retryBooleanEntries',
  'attemptedCount: queuedFontWriteCount(queue)',
  'wroteCount',
  'retryQueue'
]) assert(queueSource.includes(needle), `font write queue missing ${needle}`)

assert(queueSource.includes('if (!target.localTags.has(id))'), 'failed local tag writes must not overwrite newer queued values')
assert(queueSource.includes('if (!target.sharedTags.has(id))'), 'failed shared tag writes must not overwrite newer queued values')
assert(queueSource.includes('if (!target.favorite.has(id))'), 'failed favorite writes must not overwrite newer queued values')
assert(queueSource.includes('if (!target.protection.has(id))'), 'failed protection writes must not overwrite newer queued values')
assert(queueSource.includes("failures.push(`${args.label}写入接口不可用。`)"), 'missing mutation APIs must be treated as failures')

const runtime = read('src/renderer/src/fontWriteQueueRuntime.ts')
for (const needle of [
  'FOREGROUND_RETRY_DELAYS_MS',
  'BACKGROUND_RETRY_DELAYS_MS',
  'retryTimerRef',
  'retryAttemptRef',
  'getFolders: () => string[]',
  'Promise<boolean>',
  'mergeQueuedFontWritesPreservingNewer(options.queueRef.current, result.retryQueue)',
  'scheduleBackgroundRetry()',
  'return false'
]) assert(runtime.includes(needle), `font write runtime missing ${needle}`)

assert(!runtime.includes('library: LibraryState'), 'font write runtime must not capture a stale LibraryState snapshot')
assert(runtime.includes('while (queuedFontWriteCount(options.queueRef.current) || fieldTasks.size)'), 'flush must drain writes added while a pass is active')
assert(runtime.includes('const folders = options.getFolders()'), 'each flush pass must use the latest watched folders')

const unload = read('src/renderer/src/runtime/app/effects/useAppFlushOnUnloadRuntime.ts')
assert(unload.includes('if (result === false) fontWritesSaved = false'), 'window close acknowledgement must reject partial write failures')

const dialog = read('src/renderer/src/fontDialogRuntime.ts')
assert(dialog.includes("if (!saved) throw new Error('仍有共享标签写入未保存"), 'shared tag rename must stop when pending writes cannot flush')
assert(dialog.includes('if (flushed === false)'), 'tag deletion must stop when pending writes cannot flush')

async function runBehaviorChecks() {
  const queueRuntime = loadTypeScriptModule('src/renderer/src/fontWriteQueue.ts')
  const oldItem = { id: 'font-b', fileName: 'B.ttf', path: 'D:/Fonts/B.ttf' }
  const queue = queueRuntime.createEmptyQueuedFontWriteState()
  queue.localTags.set('font-a', {
    item: { id: 'font-a', fileName: 'A.ttf', path: 'D:/Fonts/A.ttf' },
    tagNames: ['成功']
  })
  queue.localTags.set('font-b', { item: oldItem, tagNames: ['旧状态'] })

  const result = await queueRuntime.flushQueuedFontWriteQueue({
    queue,
    folders: ['D:/Fonts'],
    hfm: {
      setLocalTagsBatch: async () => ({
        ok: false,
        updatedIds: ['font-a'],
        failed: [{ id: 'font-b', fileName: 'B.ttf', message: '磁盘暂不可写' }],
        message: '部分失败'
      })
    }
  })

  assert(result.attemptedCount === 2, 'behavior: attempted write count must include both entries')
  assert(result.wroteCount === 1, 'behavior: successful write count must exclude failed entries')
  assert(result.retryQueue.localTags.has('font-b'), 'behavior: the failed font must be returned to the retry queue')
  assert(!result.retryQueue.localTags.has('font-a'), 'behavior: successful fonts must not be retried')

  const current = queueRuntime.createEmptyQueuedFontWriteState()
  current.localTags.set('font-b', { item: oldItem, tagNames: ['用户更新后的状态'] })
  const retry = queueRuntime.createEmptyQueuedFontWriteState()
  retry.localTags.set('font-b', { item: oldItem, tagNames: ['旧失败状态'] })
  retry.localTags.set('font-c', {
    item: { id: 'font-c', fileName: 'C.ttf', path: 'D:/Fonts/C.ttf' },
    tagNames: ['需要重试']
  })
  queueRuntime.mergeQueuedFontWritesPreservingNewer(current, retry)
  assert(current.localTags.get('font-b').tagNames[0] === '用户更新后的状态', 'behavior: a retry must not overwrite a newer user write')
  assert(current.localTags.has('font-c'), 'behavior: unrelated failed writes must be restored')
}


async function feedbackCases(transform = source => source, targetFullRefreshWindow = false) {
  const strict = require('node:assert/strict')
  const file = 'src/renderer/src/fontWriteQueueRuntime.ts'
  const load = require('./check-operation-chain.cjs').loader({}, {}, { [path.join(root, file)]: transform })
  const create = load(file).createRendererFontWriteQueueRuntime
  const empty = load('src/renderer/src/fontWriteQueue.ts').createEmptyQueuedFontWriteState
  let queueRef = { current: empty() }
  const errors = [], diagnostics = [], timers = new Map()
  let serial = 0, recoveries = 0, failWrites = true, failRefresh = false, writes = 0
  const item = { id: 'notice-font', fileName: 'notice.ttf', path: 'C:/fixture/notice.ttf' }
  const save = async () => { writes++; return failWrites
    ? { ok: false, updatedIds: [], failed: [{ id: item.id, fileName: item.fileName, message: 'controlled failure' }] }
    : { ok: true, updatedIds: [item.id], failed: [] } }
  const options = {
    queueRef, timerRef: { current: null }, retryTimerRef: { current: null }, retryAttemptRef: { current: 0 },
    activeRef: { current: false }, activePromiseRef: { current: null },
    hfm: { setLocalTagsBatch: save, setSharedTagsBatch: save, setDeleteProtection: save },
    getFolders: () => ['C:/fixture'], writeBehindDelayMs: 10, writeBehindMaxItems: 100,
    writeBehindMaxBufferBytes: 1000000, memoryPressure: () => 'normal',
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, fn); if ([120, 360, 900].includes(ms)) queueMicrotask(() => { if (timers.delete(id)) fn() }); return id },
    clearTimeout(id) { timers.delete(id) }, setStatus: text => diagnostics.push(text), reportError: text => errors.push(text),
    onRecovered: () => { recoveries++ }, scheduleDatabaseDerivedStateRefresh() { if (failRefresh) throw Error('controlled refresh failure') }
  }
  let runtime = create(options)
  try {
    queueRef.current.localTags.set(item.id, { item, tagNames: ['new'] })
    strict.equal(await runtime.flush('controlled', 'local'), false)
    strict.equal(writes, 4); strict.equal(errors.length, 1)
    strict.equal(diagnostics.length, 0, 'failed write went only to diagnostics')
    strict.equal(recoveries, 0, 'FAILED_WRITE_RECOVERY')
    // The queue and its failure receipt survive the ordinary React factory rebuild.
    runtime = create(options); failWrites = false
    strict.equal(await runtime.flush('controlled', 'local'), true)
    strict.equal(recoveries, 1, 'CONFIRMED_WRITE_RECOVERY')
    strict.equal(queueRef.current.localTags.size, 0)
    strict.match(diagnostics.at(-1), /已落库/)
    strict.equal(await runtime.flush('empty', 'local'), true)
    strict.equal(recoveries, 1, 'EMPTY_WRITE_RECOVERY')

    // The full-refresh mutant must reach the failed-refresh window. Its removed
    // guard also doubles the earlier healthy-drain notification; that separate
    // positive remains mandatory in the unmutated run and all other mutants.
    if (!targetFullRefreshWindow) {
      queueRef.current.protection.set(item.id, { font: item, protect: true })
      await runtime.flush('successful-full-drain')
      strict.equal(recoveries, 2, 'FULL_WRITE_RECOVERY')
    }
    failWrites = true; queueRef.current.localTags.set(item.id, { item, tagNames: ['full-failure'] })
    strict.equal(await runtime.flush('failed-full-drain'), false)
    const beforeFull = recoveries, errorCount = errors.length
    failWrites = false; failRefresh = true
    await strict.rejects(runtime.flush('full-recovery-refresh-failed'), /controlled refresh failure/)
    strict.equal(recoveries, beforeFull, 'FULL_REFRESH_RECOVERY')
    strict.equal(errors.length, errorCount + 1, 'FULL_REFRESH_ERROR_NOTICE')
    failRefresh = false; runtime = create(options)
    await runtime.flush('empty-after-full-error')
    strict.equal(recoveries, beforeFull, 'FULL_EMPTY_RECOVERY')

    queueRef = { current: empty() }
    options.queueRef = queueRef
    runtime = create(options)
    // A post-write callback failure has no retry receipt. Later empty fields,
    // another field, and a new same-field write cannot certify that error recovered.
    const beforeUncertain = recoveries
    failRefresh = true
    queueRef.current.localTags.set(item.id, { item, tagNames: ['uncertain'] })
    strict.equal(await runtime.flush('controlled', 'local'), false)
    strict.equal(queueRef.current.localTags.size, 0)
    strict.equal(recoveries, beforeUncertain, 'UNCERTAIN_FAILED_RECOVERY')
    const before = recoveries
    strict.match(errors.at(-1), /队列异常/)
    failRefresh = false; runtime = create(options)
    await runtime.flush('empty-after-error')
    strict.equal(recoveries, before, 'UNCERTAIN_EMPTY_RECOVERY')
    queueRef.current.protection.set(item.id, { font: item, protect: true })
    await runtime.flush('other-field')
    strict.equal(recoveries, before, 'UNCERTAIN_PEER_RECOVERY')
    queueRef.current.localTags.set(item.id, { item, tagNames: ['later'] })
    await runtime.flush('new-same-field', 'local')
    strict.equal(recoveries, before, 'UNCERTAIN_SAME_FIELD_RECOVERY')
  } finally { runtime.clearTimer(); strict.equal(timers.size, 0, 'feedback fixture leaked timer') }
}

async function feedbackMutants() {
  const strict = require('node:assert/strict')
  for (const [before, after, reason, targetFullRefreshWindow = false] of [
    ['confirmedWrites > 0 && !feedbackFailures.size && !fieldTasks.size', '!feedbackFailures.size && !fieldTasks.size', /EMPTY_WRITE_RECOVERY/],
    ['flushField(field, reason, collectRefresh, false)', 'flushField(field, reason, collectRefresh)', /FULL_REFRESH_RECOVERY/, true],
    ["      feedbackFailures.set(field, 'uncertain')", '', /UNCERTAIN_FAILED_RECOVERY/],
    ["feedbackFailures.get(field) === 'retry'", 'feedbackFailures.has(field)', /UNCERTAIN_SAME_FIELD_RECOVERY/]
  ]) {
    strict.equal(runtime.split(before).length, 2, 'feedback mutation anchor must be unique')
    await strict.rejects(() => feedbackCases(source => source.replace(before, after), targetFullRefreshWindow), reason)
  }
}

runBehaviorChecks()
  .then(() => feedbackCases())
  .then(() => feedbackMutants())
  .then(() => console.log('[diagnostics:font-write-queue-durability] ok'))
  .catch((error) => {
    console.error(`[diagnostics:font-write-queue-durability] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
