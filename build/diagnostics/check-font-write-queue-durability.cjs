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
    require,
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
assert(runtime.includes('while (queuedFontWriteCount(options.queueRef.current))'), 'flush must drain writes added while a pass is active')
assert(runtime.includes('folders: options.getFolders()'), 'each flush pass must use the latest watched folders')

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

runBehaviorChecks()
  .then(() => console.log('[diagnostics:font-write-queue-durability] ok'))
  .catch((error) => {
    console.error(`[diagnostics:font-write-queue-durability] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
