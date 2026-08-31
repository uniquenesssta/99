#!/usr/bin/env node
const fs = require('node:fs')
const fsp = fs.promises
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:shutdown-log-durability] ${message}`)
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
  new Function('exports', 'require', 'module', '__filename', '__dirname', output)(
    module.exports,
    localRequire,
    module,
    path.join(root, rel),
    path.dirname(path.join(root, rel))
  )
  return module.exports
}

const lifecycle = read('src/main/app/mainProcessLifecycleRuntime.ts')
for (const needle of [
  'beginStartupSessionSync();',
  'flushStartupLogSync();',
  'flushPerformanceLogs("before-quit")',
  'await flushStartupLogAsync()',
  'previous shutdown was unclean'
]) {
  const source = needle.includes('previous shutdown') ? read('src/main/app/cleanShutdownRuntime.ts') : lifecycle
  assert(source.includes(needle), `shutdown observability missing ${needle}`)
}
assert(lifecycle.indexOf('await flushStartupLogAsync()') < lifecycle.indexOf('quitCleanupDone = true'), 'startup log must drain before quit is released')
assert(lifecycle.indexOf('stopFolderWatchers();') < lifecycle.indexOf('await flushStartupLogAsync()'), 'final watcher state must be logged before the log drain')

for (const needle of [
  'requestRendererWindowsCloseForQuit()',
  'before-quit renderer flush requested',
  'before-quit renderer flush completed',
  'before-quit renderer flush cancelled; application remains open'
]) assert(lifecycle.includes(needle), `renderer quit preflight missing ${needle}`)
assert(
  lifecycle.indexOf('requestRendererWindowsCloseForQuit()') < lifecycle.indexOf('stopBackgroundTaskScheduler();'),
  'renderer persistence preflight must complete before main-process services are stopped'
)

async function runLoggerBehavior() {
  const { createStartupLogger } = loadTypeScriptModule('src/main/logging/startupLog.ts')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-log-durability-'))
  try {
    const logger = createStartupLogger({ logsDir: () => dir, fileName: 'test.log', flushDelayMs: 100000 })
    logger.append('first')
    const firstFlush = logger.flushAsync()
    logger.append('second')
    const secondFlush = logger.flushAsync()
    await Promise.all([firstFlush, secondFlush])
    const content = await fsp.readFile(path.join(dir, 'test.log'), 'utf8')
    assert(content.includes('first'), 'the first concurrent log chunk was not written')
    assert(content.includes('second'), 'a log appended during an active flush was not drained before flushAsync resolved')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

async function runShutdownMarkerBehavior() {
  const { createCleanShutdownRuntime } = loadTypeScriptModule('src/main/app/cleanShutdownRuntime.ts')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-shutdown-marker-'))
  const markerPath = path.join(dir, 'last-shutdown.json')
  const logs = []
  try {
    const runtime = createCleanShutdownRuntime({
      dataPath: () => markerPath,
      cacheArchitectureVersion: 7,
      appendLog: (message) => logs.push(message)
    })
    runtime.beginStartupSessionSync()
    let marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'))
    assert(marker.clean === false, 'startup must mark the current session unclean until will-quit completes')
    runtime.markCleanShutdownSync()
    marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'))
    assert(marker.clean === true, 'will-quit must mark the session clean')

    marker.clean = false
    await fsp.writeFile(markerPath, JSON.stringify(marker), 'utf8')
    const second = createCleanShutdownRuntime({
      dataPath: () => markerPath,
      cacheArchitectureVersion: 7,
      appendLog: (message) => logs.push(message)
    })
    second.beginStartupSessionSync()
    assert(logs.some((message) => message.includes('previous shutdown was unclean')), 'an unclean previous session must be visible in the next startup log')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

Promise.all([runLoggerBehavior(), runShutdownMarkerBehavior()])
  .then(() => console.log('[diagnostics:shutdown-log-durability] ok'))
  .catch((error) => {
    console.error(`[diagnostics:shutdown-log-durability] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
