#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:merged-index-mutation] ${message}`)
    process.exit(1)
  }
}
function loadTypeScriptModule(rel, localRequire = require) {
  const output = ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} }
  new Function('exports', 'require', 'module', output)(module.exports, localRequire, module)
  return module.exports
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const coordinatorSource = read('src/main/indexing/merged-page/mergedIndexMutationCoordinatorRuntime.ts')
for (const needle of [
  'tail.catch(() => undefined).then',
  'runMergedIndexMutation',
  'waitForMergedIndexMutations',
  'options.onCommitted?.',
  'revision += 1'
]) assert(coordinatorSource.includes(needle), `mutation coordinator missing ${needle}`)

const syncSource = read('src/main/indexing/merged-page/mergedIndexSyncRuntime.ts')
assert((syncSource.match(/ctx\.runMergedIndexMutation\(/g) || []).length === 2, 'incremental and snapshot writes must both use the global mutation coordinator')
assert(syncSource.includes('commit(`incremental-rust:${reason}`)'), 'Rust incremental commits must invalidate derived query caches')
assert(syncSource.includes('commit(`snapshot-rust:${reason}`)'), 'Rust snapshot commits must invalidate derived query caches')

const buildSource = read('src/main/indexing/merged-page/mergedIndexBuildRuntime.ts')
assert(buildSource.includes('ctx.runMergedIndexMutation('), 'background and blocking rebuilds must use the global mutation coordinator')
assert(buildSource.includes('if (ctx.mergedIndexRebuildInFlight.get(sourcesKey) === rebuildPromise)'), 'an older rebuild completion must not delete a newer in-flight entry')

const querySource = read('src/main/indexing/merged-page/mergedIndexPageQueryRuntime.ts')
assert(querySource.includes('`pending-snapshot:${ctx.mergedIndexRootsKey(roots)}`'), 'pending snapshot replacement must be serialized with other merged-index writes')

const watcherSource = read('src/main/watcher/folderWatcherRuntime.ts')
for (const needle of [
  'let watcherGeneration = 0',
  'let flushInFlight: Promise<void> | null = null',
  'flushRequested = true',
  'generation !== watcherGeneration',
  'batch result discarded after watcher restart',
  'notification discarded after watcher restart'
]) assert(watcherSource.includes(needle), `watcher lifecycle protection missing ${needle}`)

const rendererEventSource = read('src/renderer/src/runtime/app/effects/useFontIndexChangedEventRuntime.ts')
assert(rendererEventSource.includes('current.refreshDatabaseDerivedState()'), 'watcher index commits must invalidate renderer database pages and metrics')

async function runBehaviorChecks() {
  const { createMergedIndexMutationCoordinatorRuntime } = loadTypeScriptModule(
    'src/main/indexing/merged-page/mergedIndexMutationCoordinatorRuntime.ts'
  )
  const commits = []
  const order = []
  const gate = deferred()
  const runtime = createMergedIndexMutationCoordinatorRuntime({
    appendStartupLog() {},
    onCommitted(event) { commits.push(event) }
  })

  const first = runtime.runMergedIndexMutation('first', async ({ commit }) => {
    order.push('first:start')
    await gate.promise
    commit('first:commit')
    order.push('first:end')
    return 1
  })
  const second = runtime.runMergedIndexMutation('second', async ({ commit }) => {
    order.push('second:start')
    commit('second:commit')
    order.push('second:end')
    return 2
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert(order.join(',') === 'first:start', 'a later merged-index mutation started before the active mutation completed')
  gate.resolve()
  const values = await Promise.all([first, second])
  assert(values[0] === 1 && values[1] === 2, 'serialized mutation results were not preserved')
  assert(order.join(',') === 'first:start,first:end,second:start,second:end', 'merged-index mutations did not execute in request order')
  assert(commits.length === 2 && commits[0].revision === 1 && commits[1].revision === 2, 'commit revisions must be monotonic')

  const failed = runtime.runMergedIndexMutation('failed', async () => {
    throw new Error('expected failure')
  })
  const afterFailure = runtime.runMergedIndexMutation('after-failure', async ({ commit }) => {
    commit('after-failure:commit')
    return 'ok'
  })
  await failed.catch(() => undefined)
  assert(await afterFailure === 'ok', 'a failed mutation permanently blocked the global write queue')
  await runtime.waitForMergedIndexMutations()
}


async function runWatcherBehaviorChecks() {
  let sends = 0
  const watcherModule = loadTypeScriptModule(
    'src/main/watcher/folderWatcherRuntime.ts',
    (id) => {
      if (id === 'electron') {
        return {
          BrowserWindow: {
            getAllWindows: () => [{
              isDestroyed: () => false,
              webContents: { send: () => { sends += 1 } }
            }]
          }
        }
      }
      if (id === '../path/cachePath') {
        return { normalizePathForCacheCompare: (value) => String(value || '').replaceAll('/', '\\').toLowerCase() }
      }
      if (id === '../path/startupPathAvailabilityRuntime') {
        return { ensureStartupPathRootAvailable: async () => true }
      }
      return require(id)
    }
  )

  const restartGate = deferred()
  let restartSyncs = 0
  const restartRuntime = watcherModule.createFolderWatcherRuntime({
    appendStartupLog() {},
    isIgnoredWatcherPath: () => false,
    verboseLogs: false,
    startupGraceMs: 0,
    flushDebounceMs: 5,
    closeRuntimeDatabases() {},
    watcherChangeBatchLooksUnchanged: async () => false,
    applyWatchedFolderChangesToIndex: async () => {
      await restartGate.promise
      return { folder: 'D:/Old', at: '', upserts: [{ id: 'old', path: 'D:/Old/a.ttf' }], deletes: [], errors: [] }
    },
    syncMergedIndexForRootIncremental: async () => { restartSyncs += 1 }
  })
  restartRuntime.notifyFolderChanged('D:/Old', 'change', 'a.ttf')
  const restartFlush = restartRuntime.flushPendingFolderChanges()
  await new Promise((resolve) => setImmediate(resolve))
  restartRuntime.stopFolderWatchers()
  restartGate.resolve()
  await restartFlush
  assert(restartSyncs === 0 && sends === 0, 'a watcher task completed after restart and still updated the merged index or renderer')

  let active = 0
  let maxActive = 0
  let applyCalls = 0
  const firstGate = deferred()
  const singleFlightRuntime = watcherModule.createFolderWatcherRuntime({
    appendStartupLog() {},
    isIgnoredWatcherPath: () => false,
    verboseLogs: false,
    startupGraceMs: 0,
    flushDebounceMs: 5,
    closeRuntimeDatabases() {},
    watcherChangeBatchLooksUnchanged: async () => false,
    applyWatchedFolderChangesToIndex: async () => {
      applyCalls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      if (applyCalls === 1) await firstGate.promise
      active -= 1
      return { folder: 'D:/Fonts', at: '', upserts: [{ id: String(applyCalls), path: `D:/Fonts/${applyCalls}.ttf` }], deletes: [], errors: [] }
    },
    syncMergedIndexForRootIncremental: async () => undefined
  })
  singleFlightRuntime.notifyFolderChanged('D:/Fonts', 'change', 'a.ttf')
  const firstFlush = singleFlightRuntime.flushPendingFolderChanges()
  await new Promise((resolve) => setImmediate(resolve))
  singleFlightRuntime.notifyFolderChanged('D:/Fonts', 'change', 'b.ttf')
  const joinedFlush = singleFlightRuntime.flushPendingFolderChanges()
  firstGate.resolve()
  await Promise.all([firstFlush, joinedFlush])
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert(applyCalls === 2, 'events queued during a watcher flush were not processed by a follow-up pass')
  assert(maxActive === 1, 'watcher flush passes overlapped')
  singleFlightRuntime.stopFolderWatchers()
}

Promise.all([runBehaviorChecks(), runWatcherBehaviorChecks()])
  .then(() => console.log('[diagnostics:merged-index-mutation] ok'))
  .catch((error) => {
    console.error(`[diagnostics:merged-index-mutation] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
