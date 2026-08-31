#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:activation-save-queue-durability] ${message}`)
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

const queueSource = read('src/main/activation/activationInstallStatusSaveQueue.ts')
for (const needle of [
  'SAVE_RETRY_DELAYS_MS',
  'BACKGROUND_RETRY_DELAY_MS',
  'mergeFailedBatch',
  'if (!(id in pendingResults)) pendingResults[id] = result',
  'if (!pendingItemsById.has(id))',
  "scheduleTimer(BACKGROUND_RETRY_DELAY_MS, 'background-retry')",
  'throw lastError instanceof Error',
  'activation install status post-save sync failed'
]) assert(queueSource.includes(needle), `activation save queue missing ${needle}`)

assert(queueSource.includes('void flush(reason).catch(() => undefined)'), 'timer retries must consume rejected flush promises')
assert(queueSource.indexOf('await deps.saveInstallStatusIndex') < queueSource.indexOf('await deps.syncMergedIndexAfterInstallStatusRefresh'), 'install status persistence must complete before merged-index sync')

const mainRuntime = read('src/main/activation/mainActivationInstallStatusSaveRuntime.ts')
for (const needle of [
  'flushActivationInstallStatusSave: queue.flush',
  'hasPendingActivationInstallStatusSave: queue.hasPending',
  'hasInFlightActivationInstallStatusSave: queue.hasInFlight'
]) assert(mainRuntime.includes(needle), `activation main runtime missing ${needle}`)

const lifecycle = read('src/main/app/mainProcessLifecycleRuntime.ts')
for (const needle of [
  'await flushActivationInstallStatusSave("before-quit")',
  'before-quit activation status flush failed:',
  'before-quit activation status flush force-skipped by user',
  'restoreAfterQuitAbort()',
  'if (startupBackgroundTasksEnabled) startBackgroundTaskScheduler()',
  'await flushStartupLogAsync()'
]) assert(lifecycle.includes(needle), `unified activation quit lifecycle missing ${needle}`)
assert(lifecycle.indexOf('await flushActivationInstallStatusSave("before-quit")') < lifecycle.indexOf('stopFolderWatchers();'), 'activation status must flush before watcher shutdown')
assert((lifecycle.match(/stopRustCoreDaemon\(\)/g) || []).length === 1, 'Rust daemon must only stop in will-quit after renderer and activation flushes complete')
assert(!fs.existsSync(path.join(root, 'src/main/activation/activationInstallStatusQuitFlushRuntime.ts')), 'the duplicate activation before-quit listener must be removed')


async function runBehaviorChecks() {
  const runtimeModule = loadTypeScriptModule('src/main/activation/activationInstallStatusSaveQueue.ts')
  const font = { id: 'font-a', fileName: 'A.ttf', path: 'D:/Fonts/A.ttf' }
  const items = new Map([[font.id, font]])
  const oldResult = { marker: 'old' }
  const newerResult = { marker: 'newer' }
  let runtime
  let failWrites = true
  let saveCalls = 0
  const persisted = []

  runtime = runtimeModule.createActivationInstallStatusSaveQueue({
    batchDelayMs: 100000,
    appendStartupLog: () => undefined,
    saveInstallStatusIndex: async (results) => {
      saveCalls += 1
      if (failWrites) {
        if (saveCalls === 1) runtime.schedule({ [font.id]: newerResult }, items, 'newer-state')
        throw new Error('temporary write failure')
      }
      persisted.push(results)
    },
    appWatchedFolders: async () => [],
    rootForFontPath: async () => null,
    syncMergedIndexAfterInstallStatusRefresh: async () => undefined,
    clearFontQueryCaches: () => undefined
  })

  runtime.schedule({ [font.id]: oldResult }, items, 'initial-state')
  let rejected = false
  try {
    await runtime.flush('behavior-failure')
  } catch {
    rejected = true
  }
  assert(rejected, 'behavior: a fully failed batch must reject its explicit flush')
  assert(runtime.hasPending(), 'behavior: a failed batch must remain pending for retry')

  failWrites = false
  await runtime.flush('behavior-recovery')
  assert(persisted.length === 1, 'behavior: the recovered batch must be persisted once')
  assert(persisted[0][font.id].marker === 'newer', 'behavior: an older failed snapshot must not overwrite a newer pending install state')
  assert(!runtime.hasPending() && !runtime.hasInFlight(), 'behavior: a successful recovery must fully drain the queue')
}

runBehaviorChecks()
  .then(() => console.log('[diagnostics:activation-save-queue-durability] ok'))
  .catch((error) => {
    console.error(`[diagnostics:activation-save-queue-durability] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
