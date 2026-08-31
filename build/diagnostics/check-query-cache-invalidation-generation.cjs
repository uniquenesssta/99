#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:query-cache-generation] ${message}`)
    process.exit(1)
  }
}
function transpile(rel) {
  return ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
}
function loadTypeScriptModule(rel, localRequire = require) {
  const module = { exports: {} }
  new Function('exports', 'require', 'module', transpile(rel))(module.exports, localRequire, module)
  return module.exports
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const pageSource = read('src/main/library/fontPageQueryCacheRuntime.ts')
for (const needle of [
  'let cacheGeneration = 0',
  'cacheGeneration += 1',
  'fontQueryPageInFlight.clear()',
  'requestGeneration === cacheGeneration',
  'fontQueryPageInFlight.get(cacheKey) === promise'
]) assert(pageSource.includes(needle), `page query cache missing ${needle}`)

const metricsSource = read('src/main/library/fontMetricsRequestCoalescerRuntime.ts')
for (const needle of [
  'let cacheGeneration = 0',
  'requestGeneration === cacheGeneration',
  'inFlightByKey.get(key) === promise',
  'cacheGeneration += 1'
]) assert(metricsSource.includes(needle), `metrics cache missing ${needle}`)

const memorySource = read('src/main/library/fontMemoryQueryRuntime.ts')
for (const needle of [
  'let cacheGeneration = 0',
  'const requestGeneration = cacheGeneration',
  'if (requestGeneration !== cacheGeneration) return items'
]) assert(memorySource.includes(needle), `memory query cache missing ${needle}`)

async function runPageCacheBehavior() {
  const { createFontPageQueryCacheRuntime } = loadTypeScriptModule(
    'src/main/library/fontPageQueryCacheRuntime.ts',
    (id) => {
      if (id === './fontQuerySqlRuntime') return { fontQueryCacheKey: () => 'same-key' }
      return require(id)
    }
  )
  const oldGate = deferred()
  const newGate = deferred()
  let loads = 0
  const runtime = createFontPageQueryCacheRuntime({
    pageCacheMax: 10,
    pageCacheTtlMs: 10000,
    appendStartupLog() {},
    queryUncached: async () => {
      loads += 1
      return loads === 1 ? oldGate.promise : newGate.promise
    }
  })
  const request = { limit: 20, offset: 0 }
  const oldRequest = runtime.queryFontPageInLibrary(request)
  runtime.invalidateFontQueryPageCache()
  const newRequest = runtime.queryFontPageInLibrary(request)
  assert(loads === 2, 'a request after invalidation incorrectly joined an older in-flight page query')

  oldGate.resolve({ queryKey: 'old', items: [], total: 1, offset: 0, limit: 20, truncated: false, engine: 'sql', elapsedMs: 1 })
  await oldRequest
  const joinedNewRequest = runtime.queryFontPageInLibrary(request)
  assert(loads === 2, 'an older completion deleted the newer in-flight page query')

  const newResult = { queryKey: 'new', items: [], total: 2, offset: 0, limit: 20, truncated: false, engine: 'sql', elapsedMs: 1 }
  newGate.resolve(newResult)
  assert((await newRequest).queryKey === 'new' && (await joinedNewRequest).queryKey === 'new', 'new page query callers did not share the current-generation result')
  assert((await runtime.queryFontPageInLibrary(request)).queryKey === 'new' && loads === 2, 'current-generation page result was not cached')
}

async function runMetricsCacheBehavior() {
  const { createFontMetricsRequestCoalescerRuntime } = loadTypeScriptModule(
    'src/main/library/fontMetricsRequestCoalescerRuntime.ts'
  )
  const oldGate = deferred()
  const newGate = deferred()
  let loads = 0
  const runtime = createFontMetricsRequestCoalescerRuntime(10000)
  const load = () => {
    loads += 1
    return loads === 1 ? oldGate.promise : newGate.promise
  }
  const oldRequest = runtime.run({ appendLog() {}, key: 'metrics:a', load })
  runtime.clear()
  const newRequest = runtime.run({ appendLog() {}, key: 'metrics:a', load })
  assert(loads === 2, 'a metrics request after clear incorrectly joined an older in-flight request')

  oldGate.resolve({ total: 1 })
  await oldRequest
  const joinedNewRequest = runtime.run({ appendLog() {}, key: 'metrics:a', load })
  assert(loads === 2, 'an older metrics completion deleted the newer in-flight request')

  newGate.resolve({ total: 2 })
  assert((await newRequest).total === 2 && (await joinedNewRequest).total === 2, 'metrics callers did not receive the current-generation result')
  assert((await runtime.run({ appendLog() {}, key: 'metrics:a', load })).total === 2 && loads === 2, 'current-generation metrics were not cached')
}

async function runMemoryCacheBehavior() {
  const { createFontMemoryQueryRuntime } = loadTypeScriptModule(
    'src/main/library/fontMemoryQueryRuntime.ts',
    (id) => {
      if (id === './fontMemoryQueryCacheKeyRuntime') return { fontFilterCacheKey: () => 'same-key' }
      if (id === './fontMemoryQueryMatcherRuntime') return {
        createFontMemoryQueryMatcher: () => ({
          sharedFontMatchesPathPrefixes: () => true,
          sharedFontMatchesRequest: () => true
        })
      }
      if (id === './fontMemoryQuerySortRuntime') return { compareSharedFonts: () => 0 }
      if (id === './tagQueryFreshnessRuntime') return { fontQueryNeedsFreshTagMetadata: () => false }
      return require(id)
    }
  )
  const oldGate = deferred()
  let loads = 0
  const runtime = createFontMemoryQueryRuntime({
    resultCacheMax: 10,
    resultCacheTtlMs: 10000,
    appWatchedFolders: async () => ['D:/Fonts'],
    normalizePathForCacheCompare: (value) => value,
    loadSharedFontsForFolders: async () => {
      loads += 1
      return loads === 1 ? oldGate.promise : [{ id: 'new', path: 'D:/Fonts/new.ttf' }]
    },
    hydrateLocalTagsForFonts: async (items) => items,
    hydrateInstallStatusForFonts: async (items) => items
  })

  const oldRequest = runtime.cleanSharedFontsForQuery({})
  runtime.invalidateFontQueryResultCache()
  oldGate.resolve([{ id: 'old', path: 'D:/Fonts/old.ttf' }])
  await oldRequest
  const fresh = await runtime.cleanSharedFontsForQuery({})
  assert(loads === 2 && fresh[0].id === 'new', 'an invalidated memory query repopulated the result cache after completing late')
}

Promise.all([
  runPageCacheBehavior(),
  runMetricsCacheBehavior(),
  runMemoryCacheBehavior()
])
  .then(() => console.log('[diagnostics:query-cache-generation] ok'))
  .catch((error) => {
    console.error(`[diagnostics:query-cache-generation] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
