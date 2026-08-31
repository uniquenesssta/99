#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:rust-scheduler-cache-generation] ${message}`)
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
function immediate() { return new Promise((resolve) => setImmediate(resolve)) }

const source = read('src/main/rust-core/rustCoreSchedulerRuntime.ts')
for (const needle of [
  'type SchedulerInFlightEntry',
  'const cacheGenerationByCommand = new Map<string, number>()',
  'let globalCacheGeneration = 0',
  'cacheGenerationIsCurrent(command',
  'existing.promise as Promise<T>',
  'inFlightByKey.get(key)?.promise === promise',
  'detachedInFlight',
  'globalCacheGeneration += 1'
]) assert(source.includes(needle), `scheduler cache generation protection missing ${needle}`)

async function runBehaviorCheck() {
  const { createRustCoreSchedulerRuntime } = loadTypeScriptModule(
    'src/main/rust-core/rustCoreSchedulerRuntime.ts',
    (id) => {
      if (id === './rustPreviewRenderConcurrencyRuntime') {
        return {
          normalizePreviewRenderConcurrency: (_command, value) => value,
          previewRenderConcurrency: () => 1,
          previewRenderGlobalConcurrencyFloor: () => 4
        }
      }
      return require(id)
    }
  )

  const runtime = createRustCoreSchedulerRuntime({ appendStartupLog() {} })
  runtime.applyProfiles([{
    command: '--test-cache-generation',
    lane: 'foreground',
    priority: 100,
    maxConcurrency: 2,
    coalesceMs: 1000,
    cacheMs: 5000,
    interactive: true
  }], 'diagnostic', { globalMaxConcurrency: 4, schedulerYieldMs: 0 })

  const oldGate = deferred()
  const newGate = deferred()
  let executions = 0
  const args = ['--test-cache-generation', '--same-key']
  const execute = () => {
    executions += 1
    return executions === 1 ? oldGate.promise : newGate.promise
  }

  const oldRequest = runtime.run(args, execute)
  await immediate()
  assert(executions === 1, 'the initial scheduler request did not start')

  runtime.invalidate(['--test-cache-generation'])
  const newRequest = runtime.run(args, execute)
  await immediate()
  assert(executions === 2, 'a request after invalidation incorrectly joined the old in-flight task')

  newGate.resolve('new')
  assert(await newRequest === 'new', 'the current-generation scheduler request returned the wrong result')
  oldGate.resolve('old')
  assert(await oldRequest === 'old', 'the original caller should still receive its own completed result')

  const cached = await runtime.run(args, () => {
    executions += 1
    return Promise.resolve('unexpected')
  })
  assert(cached === 'new', 'a late old completion repopulated or overwrote the scheduler result cache')
  assert(executions === 2, 'the current-generation scheduler result was not cached')
}

runBehaviorCheck()
  .then(() => console.log('[diagnostics:rust-scheduler-cache-generation] ok'))
  .catch((error) => {
    console.error(`[diagnostics:rust-scheduler-cache-generation] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
