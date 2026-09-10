const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { promisify } = require('node:util')
const { createHash } = require('node:crypto')
const ts = require('typescript')
const root = path.resolve(__dirname, '../../..')
const core = 'src/main/rust-core/'
const commands = require('../fixtures/orchestration-contracts.fixture.json').rustCommands
const capabilities = [...new Set(commands.flatMap(c => c.capabilities))]
const compiled = new Map()
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function createHarness(settings = {}, overrides = new Map()) {
  const trace = [], files = new Map(), modules = new Map()
  let clock = 1000, serial = 0, builds = 0, handshakeCount = 0
  let mode = settings.mode || 'oneshot'
  const external = new AbortController(), scheduler = new AbortController()
  const record = (event, ...values) => trace.push([event, ...values])
  for (const [label, signal] of [['external', external.signal], ['scheduler', scheduler.signal]]) {
    for (const method of ['addEventListener', 'removeEventListener']) {
      const original = signal[method].bind(signal)
      signal[method] = (...args) => { record(label + '.' + method, args[0]); return original(...args) }
    }
  }
  const failure = (name = 'Error', message = 'injected failure') => Object.assign(new Error(message), { name })
  const optionsView = options => ({ timeout: options.timeout, windowsHide: options.windowsHide, maxBuffer: options.maxBuffer, signal: options.signal ? { aborted: options.signal.aborted, reason: options.signal.reason?.message } : undefined })
  const job = { jobId: 'j', rootPath: 'C:/fonts', filePath: 'C:/fonts/a.ttf', cacheKey: 'k', signature: 's' }
  function payload(command) {
    if (mode === 'false-daemon' || mode === 'false-oneshot') return { ok: false, message: 'worker said no' }
    return {
      ok: true, applied: true, rebuilt: true, synced: true, unchanged: true, written: 1, deleted: 1, touched: 1,
      count: 1, copied: 1, rows: [], items: [{ id: 'f', source: 'registry', registryName: 'Font', value: 'a.ttf' }],
      files: [{ path: 'C:/fonts/a.ttf', size: 2, modifiedMs: 1 }], directories: [], foldersScanned: 1,
      errors: [], ids: ['f'], total: 1, missingIds: [], tagMap: { f: ['tag'] }, knownTags: ['tag'], updatedIds: ['f'],
      matched: [], signature: 's', folders: ['C:/fonts'], nodes: [], outputPath: 'C:/preview.png', backupDir: 'C:/backup',
      results: command === '--font-parse-batch' ? [job] : command.startsWith('--font-resource-') ? [{ path: 'C:/fonts/a.ttf', ok: true, count: 1 }] : { f: { installed: true } },
    }
  }
  async function commandResult(args) {
    const command = args[0]
    if (mode === 'bad-json') return { stdout: '{broken', stderr: '' }
    if (mode === 'empty-json') return { stdout: '\r\n', stderr: '' }
    const output = args.indexOf('--output')
    if (output >= 0) files.set(args[output + 1], JSON.stringify(payload(command)))
    return { stdout: '\r\n' + JSON.stringify(payload(command)) + '\r\nignored second line', stderr: '' }
  }
  function execFile() { throw new Error('diagnostic requires the promisified exec path') }
  execFile[promisify.custom] = async (worker, args, options) => {
    record('exec', worker, args, optionsView(options))
    if (args[0] === '--handshake') {
      handshakeCount++
      if (settings.handshake === 'invalid-json') return { stdout: '{bad', stderr: '' }
      if (settings.handshake === 'throw') throw failure('Error', 'handshake failed')
      return { stdout: JSON.stringify({ ok: settings.handshake !== 'false', version: 'fixture', protocolVersion: settings.stale && handshakeCount === 1 ? 0 : 1, capabilities: settings.noCapabilities ? [] : capabilities }), stderr: '' }
    }
    if (args[0] === '--core-scheduler-profile') {
      if (settings.profileFailure) throw failure('Error', 'profile failed')
      return { stdout: JSON.stringify({ ok: true, schedulerVersion: 'fixture', profiles: [], queuePolicy: {} }), stderr: '' }
    }
    if (mode === 'external-abort') external.abort(failure('Error', 'external cancelled'))
    if (mode === 'scheduler-abort') scheduler.abort(failure('Error', 'scheduler cancelled'))
    if (options.signal?.aborted) { record('aborted', options.signal.reason?.message); throw failure('AbortError', 'cancelled') }
    if (mode === 'timeout') throw Object.assign(failure('Error', 'timed out'), { killed: true, signal: 'SIGTERM' })
    if (mode === 'max-buffer') throw Object.assign(failure('RangeError', 'stdout maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    if (mode === 'exec-fail') throw failure('Error', 'exec failed')
    if (settings.realChild) return promisify(require('node:child_process').execFile)(worker, args, options)
    if (settings.execHook) await settings.execHook({ args, options, files })
    return commandResult(args)
  }
  const stubs = {
    'node:child_process': { execFile },
    'node:crypto': { randomUUID: () => { record('uuid', ++serial); return 'id-' + serial } },
    'node:os': { tmpdir: () => '/fixture-tmp' },
    'node:path': path.posix,
    'node:fs': { promises: {
      writeFile: async (file, contents, encoding) => { record('write', file, contents, encoding); if (mode === 'write-fail') throw failure('Error', 'write failed'); files.set(file, contents) },
      readFile: async (file, encoding) => { record('read', file, encoding); if (mode === 'read-fail') throw failure('Error', 'read failed'); if (!files.has(file)) throw failure('Error', 'missing fixture file'); return files.get(file) },
      rm: async (file, options) => { record('rm', file, options); if (mode === 'cleanup-fail') throw failure('Error', 'cleanup failed'); files.delete(file) },
    } },
    './rustCoreWorkerPathRuntime': { resolveRustCoreWorkerPathWithDiagnostics: () => { record('resolve'); return { path: settings.missing && !(settings.autoBuild && builds) ? null : 'C:/worker.exe', candidates: ['C:/worker.exe'] } } },
    './rustCoreWorkerAutoBuildRuntime': { tryBuildRustCoreWorkerForDevelopment: () => { builds++; record('build'); return { attempted: !!settings.autoBuild, built: !!settings.autoBuild, message: 'fixture build' } } },
    './rustCoreProtocolRuntime': { EXPECTED_RUST_CORE_PROTOCOL_VERSION: 1, rustCoreWorkerIsCompatible: status => { record('compatibility', status.protocolVersion); return { ok: status.protocolVersion === 1, message: 'fixture incompatible' } } },
    './rustCoreSchedulerRuntime': { createRustCoreSchedulerRuntime: () => {
      record('create.scheduler')
      return {
        applyProfiles: (...args) => { record('profiles', ...args); return 0 },
        run: async (args, run) => { record('schedule', args); if (mode === 'schedule-fail') throw failure('Error', 'schedule rejected'); return run(scheduler.signal) },
        invalidate: commands => { record('invalidate', commands); return 2 },
        cancelScopes: scopes => { record('cancelScopes', scopes); return 3 },
        markInteractiveActivity: reason => record('interactive', reason),
      }
    } },
    './rustCoreDaemonRuntime': {
      isRustCoreDaemonSubmittedError: error => !!error?.daemonSubmitted,
      createRustCoreDaemonRuntime: options => {
        record('create.daemon')
        return {
          tryRun: async (worker, args, execOptions) => {
            record('daemon', worker, args, optionsView(execOptions))
            if (settings.domainEvent) options.onDomainEvent?.({ domain: 'tags', event: 'changed' })
            if (mode === 'submitted') throw Object.assign(failure('Error', 'daemon submitted failure'), { daemonSubmitted: true, command: args[0] })
            if (mode === 'pre-failure') throw failure('Error', 'daemon not submitted failure')
            if (mode === 'daemon-abort') throw failure('AbortError', 'daemon cancelled')
            if (mode === 'daemon' || mode === 'false-daemon') return commandResult(args)
            return null
          },
          pollStatus: () => record('poll'), status: () => ({ running: true }), stop: () => record('stop'),
        }
      },
    },
  }
  // Keep malformed JSON fault text independent of the host V8 version.
  const json = { stringify: JSON.stringify, parse: text => { try { return JSON.parse(text) } catch { throw new SyntaxError('fixture invalid JSON') } } }
  const context = vm.createContext({ Error, TypeError, RangeError, SyntaxError, JSON: json, AbortController, Buffer, console, process: { pid: 1, env: settings.env || {} }, Date: class extends Date { static now() { return clock } } })
  function load(rel) {
    if (modules.has(rel)) return modules.get(rel).exports
    const text = overrides.get(rel) ?? fs.readFileSync(path.join(root, rel), 'utf8')
    const cacheKey = rel + '\n' + text
    if (!compiled.has(cacheKey)) compiled.set(cacheKey, ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)
    const module = { exports: {} }; modules.set(rel, module)
    const requireLocal = id => {
      if (Object.hasOwn(stubs, id)) return stubs[id]
      if (id.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), id)) + '.ts')
      assert.equal(id, 'node:util', 'unexpected runtime dependency: ' + id)
      return require(id)
    }
    const run = vm.runInContext('(function(exports, require, module) {' + compiled.get(cacheKey) + '\n})', context)
    run(module.exports, requireLocal, module)
    return module.exports
  }
  const module = load(core + 'rustCoreWorkerRuntime.ts')
  assert.equal(trace.length, 0, 'importing worker created runtime state')
  const runtime = module.createRustCoreWorkerRuntime({ enabled: settings.enabled !== false, required: !!settings.required, appendStartupLog: message => record('log', message), onDaemonDomainEvent: event => record('event', event) })
  return { runtime, trace, files, external, scheduler, load, setMode: value => { mode = value }, setClock: value => { clock = value }, settings }
}

function argsFor(method, h) {
  const row = { id: 'f', fontId: 'f', itemId: 'f', key: 'k', path: 'C:/fonts/a.ttf', fontPath: 'C:/fonts/a.ttf', relativePath: 'a.ttf', pathKey: 'a', aliases: [], tagNames: ['tag'] }
  const input = { appName: 'HFM', rootPath: 'C:/fonts', dbPath: 'C:/index.db', storage: 'root', schemaVersion: 1, cacheVersion: 1, scriptDetectionVersion: 1, roots: ['C:/fonts'], sources: [{ root: 'C:/fonts' }], source: { root: 'C:/fonts' }, rows: [row], items: [row], entries: [row], installed: [], upserts: [['a.ttf', {}]], deletes: [], folders: ['C:/fonts'], extensions: ['.ttf'], windowsFontsDir: 'C:/Windows/Fonts', currentUserFontsDir: 'C:/user/Fonts', includeNameCandidates: true, copies: [], paths: ['C:/fonts/a.ttf'], queryKey: 'q', request: {}, limit: 20, offset: 0, sql: {}, fontPath: 'C:/fonts/a.ttf', text: 'A', fontSize: 24, width: 200, height: 60, outputPath: 'C:/preview.png', tagName: 'tag' }
  if (method === 'runRustFontIndexListWorker') return [['C:/fonts'], ['.ttf'], p => h.trace.push(['progress', p]), h.external.signal]
  if (method === 'runRustFontParseBatch') return [[{ jobId: 'j', rootPath: 'C:/fonts', filePath: 'C:/fonts/a.ttf', cacheKey: 'k', signature: 's' }], h.external.signal]
  if (method === 'runRustInstallStatusRead' || method === 'runRustInstallStatusSave') return [[{ rootPath: 'C:/fonts', items: [row] }]]
  if (method === 'runRustFontResourceAdd' || method === 'runRustFontResourceRemove') return [['C:/fonts/a.ttf', 'C:/fonts/a.ttf'], { notify: true, strong: true, reason: 'fixture' }]
  if (method === 'runRustFontRegistryApply') return [[{ name: 'Font', path: 'C:/fonts/a.ttf' }]]
  if (method === 'runRustFontRegistryDelete') return [['Font']]
  return [input]
}

async function settle(run) {
  try { const value = await run(); return { kind: value === null ? 'null' : 'result', value: value === undefined ? 'undefined' : JSON.parse(JSON.stringify(value)) } }
  catch (error) { return { kind: 'error', name: error.name, message: error.message, submitted: !!error.daemonSubmitted, command: error.command } }
}

async function observe(method, settings = {}, overrides) {
  const h = createHarness(settings, overrides)
  if (settings.preAbort) h.external.abort(new Error('already cancelled'))
  const outcome = await settle(() => h.runtime[method](...argsFor(method, h)))
  const summary = JSON.parse(JSON.stringify({ outcome, traceHash: digest(h.trace), pendingFiles: h.files.size }))
  return { summary, h }
}

const modes = ['oneshot', 'daemon', 'pre-failure', 'submitted', 'false-oneshot', 'false-daemon', 'bad-json', 'write-fail', 'cleanup-fail']
function scenarios() {
  const rows = commands.flatMap(({ method }) => modes.map(mode => ({ id: method + '/' + mode, method, settings: { mode } })))
  for (const settings of [{ enabled: false }, { enabled: false, required: true }, { missing: true }, { missing: true, required: true }, { missing: true, autoBuild: true }, { stale: true }, { stale: true, autoBuild: true }, { handshake: 'false' }, { handshake: 'throw', required: true }, { handshake: 'invalid-json' }, { profileFailure: true }, { noCapabilities: true }, { domainEvent: true }, { mode: 'empty-json' }, { mode: 'timeout' }, { mode: 'max-buffer' }, { mode: 'exec-fail' }, { mode: 'schedule-fail' }, { mode: 'daemon-abort' }]) rows.push({ id: 'activation/' + JSON.stringify(settings), method: 'runRustFontActivationFiles', settings })
  for (const method of ['runRustFontParseBatch', 'runRustFontIndexListWorker']) for (const settings of [{ preAbort: true }, { mode: 'external-abort' }, { mode: 'scheduler-abort' }, { mode: 'read-fail' }]) rows.push({ id: method + '/' + JSON.stringify(settings), method, settings })
  return rows
}

const sequenceNames = ['cached-ready', 'cached-required-missing', 'controls-events', 'throttled-preview-daemon', 'concurrent-files', 'serialization-error', 'partial-health-report']
async function observeSequence(name, overrides) {
  let release, entered, rejectEntry
  const enteredPromise = new Promise((resolve, reject) => { entered = resolve; rejectEntry = reject })
  const pending = new Promise(resolve => { release = resolve })
  const settings = name === 'cached-required-missing' ? { missing: true, required: true }
    : name === 'controls-events' ? { domainEvent: true }
    : name === 'throttled-preview-daemon' ? { mode: 'submitted' }
    : name === 'concurrent-files' ? { execHook: async () => { entered(); await pending } }
    : {}
  const h = createHarness(settings, overrides)
  const results = []
  if (name.startsWith('cached-')) {
    results.push(await settle(() => h.runtime.diagnoseRustCoreWorker()), await settle(() => h.runtime.diagnoseRustCoreWorker()), h.runtime.rustCoreWorkerStatus())
  } else if (name === 'controls-events') {
    results.push(h.runtime.rustCoreWorkerStatus(), await settle(() => h.runtime.runRustFontActivationFiles(...argsFor('runRustFontActivationFiles', h))));
    results.push(h.runtime.invalidateRustCoreSchedulerCaches(['a']), h.runtime.cancelRustCoreSchedulerScopes(['b']))
    h.runtime.noteRustCoreSchedulerInteractiveActivity()
    h.runtime.noteRustCoreSchedulerInteractiveActivity('editing')
    results.push(h.runtime.rustCoreDaemonStatus())
    h.runtime.stopRustCoreDaemon()
  } else if (name === 'throttled-preview-daemon') {
    for (const now of [1000, 1001, 8999, 9000]) {
      h.setClock(now)
      results.push(await settle(() => h.runtime.runRustPreviewCacheReadStatus(...argsFor('runRustPreviewCacheReadStatus', h))))
    }
    results.push(await settle(() => h.runtime.runRustPreviewCacheQuery(...argsFor('runRustPreviewCacheQuery', h))))
  } else if (name === 'concurrent-files') {
    await h.runtime.diagnoseRustCoreWorker()
    const a = settle(() => h.runtime.runRustFontActivationFiles(...argsFor('runRustFontActivationFiles', h)))
    const b = settle(() => h.runtime.runRustPreviewRenderImage(...argsFor('runRustPreviewRenderImage', h)))
    // A regression that returns before exec must fail, not leave an unresolved
    // promise that lets Node exit successfully before the diagnostic finishes.
    const deadline = setTimeout(() => rejectEntry(new Error('concurrent commands never reached exec')), 2000)
    try {
      await enteredPromise
      assert.equal(h.files.size, 2, 'pending commands lost or reused a temporary input')
      assert.equal(h.trace.filter(x => x[0] === 'rm').length, 0, 'file was cleaned before exec settled')
    } finally { clearTimeout(deadline); release() }
    results.push(...await Promise.all([a, b]))
  } else if (name === 'serialization-error') {
    const input = { copies: [] }; input.cycle = input
    // Supply a stable serialization failure independent of V8's cycle message.
    input.toJSON = () => { throw new Error('fixture serialization failed') }
    results.push(await settle(() => h.runtime.runRustFontActivationFiles(input)))
  } else if (name === 'partial-health-report') {
    h.setMode('false-daemon')
    results.push(await settle(() => h.runtime.runRustDatabaseHealthCheck(...argsFor('runRustDatabaseHealthCheck', h))))
  }
  return { summary: JSON.parse(JSON.stringify({ results, traceHash: digest(h.trace), pendingFiles: h.files.size })), h }
}

module.exports = { core, commands, createHarness, argsFor, settle, observe, scenarios, digest, sequenceNames, observeSequence }
