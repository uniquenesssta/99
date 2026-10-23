#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const h = require('./helpers/rustWorkerTransportHarness.cjs')
// Reviewed transport-boundary migrations retain exact body hashes. Foreground
// bytes, stdout listing, binding snapshots and guarded root writes have causal
// port/lifetime tests; all other domain functions remain frozen.
const fixture = require('./fixtures/rust-worker-clients.fixture.json')
const root = path.resolve(__dirname, '../..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n')
const facade = h.core + 'rustCoreWorkerRuntime.ts'
const sources = new Map(fixture.groups.map(g => [g.path, read(g.path)]))
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)) }
function tokens(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text.replace(/\r\n/g, '\n')), result = []
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) result.push(scanner.getTokenText())
  return result
}
// Explicit migration of ONLY the reviewed parse invocation. The historical fixture
// remains frozen; all other domain/helper fingerprints are checked unchanged.
// Causal budget, slicing, cleanup and physical-close checks live in
// check-font-parse-stability-capability and check-preview-owned-stage.
const parseClientPath = h.core + 'clients/rustIndexingClientRuntime.ts'
const previewClientPath = h.core + 'clients/rustPreviewClientRuntime.ts'
const previewCacheFailureGuard = '        if (query && previewCacheFailureKind(error)) throw error\n'
const previewCacheFailureAddition = '        // Keep native cache categories visible on both isolated and local-daemon\n'
  + '        // reads. Returning null here would turn a denied/corrupt cache into a miss.\n'
  + previewCacheFailureGuard
const reviewedParseHash = '6f6ed1d9fe8184a201fefdd0cab52d7a444e95d5de91169e2c2ec67bb31e1c07'
function ownsParseInvocation(node, group) {
  if (group.path !== parseClientPath) return false
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return parent.name?.text === 'runRustFontParseBatch'
  }
  return false
}
const metadataReceiptAdditions = {
  normalizeRustParseBatchJob: [
    '    metadataDiagnostics: normalizeRustMetadataDiagnostics(input.metadataDiagnostics),\n',
    '    parseDisposition: normalizeRustParseDisposition(input.parseDisposition),\n',
    '    sourceStability: normalizeRustSourceStability(input.sourceStability),\n',
  ],
  runRustFontIndexListWorker: [
    'metadataDiagnostics: normalizeRustMetadataDiagnostics(item.metadataDiagnostics), ',
    'parseDisposition: normalizeRustParseDisposition(item.parseDisposition), ',
    'sourceStability: normalizeRustSourceStability(item.sourceStability), ',
  ],
}
function originalMetadataReceiptFunction(text, name, group) {
  if (group.path !== parseClientPath || !Object.hasOwn(metadataReceiptAdditions, name)) return text
  for (const addition of metadataReceiptAdditions[name]) {
    assert.equal(text.split(addition).length, 2, name + ' metadata receipt normalization missing or changed')
    text = text.replace(addition, '')
  }
  return text
}
function checkFunctions(overrides = sources) {
  for (const group of fixture.groups) {
    const file = ts.createSourceFile(group.path, overrides.get(group.path), ts.ScriptTarget.Latest, true)
    if (group.path === previewClientPath) {
      const imports = file.statements.filter(node => ts.isImportDeclaration(node)
        && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some(binding => binding.name.text === 'previewCacheFailureKind'))
      assert.equal(imports.length, 1, 'preview cache failure import missing or duplicated')
      const imported = imports[0], bindings = imported.importClause.namedBindings.elements
      assert(imported.moduleSpecifier.text === '../../../shared/previewCacheFailure' && !imported.importClause.isTypeOnly
        && bindings.length === 1 && !bindings[0].propertyName && !bindings[0].isTypeOnly,
      'preview cache failure dependency changed')
    }
    if (group.path === parseClientPath) {
      const imports = file.statements.filter(node => ts.isImportDeclaration(node)
        && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some(binding => ['normalizeRustMetadataDiagnostics', 'normalizeRustParseDisposition', 'normalizeRustSourceStability'].includes(binding.name.text)))
      assert.equal(imports.length, 1, 'metadata normalizer import missing or duplicated')
      const imported = imports[0]
      assert(imported.moduleSpecifier.text === '../fontMetadataDiagnostics' && !imported.importClause.isTypeOnly
        && imported.importClause.namedBindings.elements.length === 3
        && imported.importClause.namedBindings.elements.every(binding => !binding.propertyName && !binding.isTypeOnly), 'metadata normalizer dependency changed')
      assert.deepEqual(imported.importClause.namedBindings.elements.map(binding => binding.name.text).sort(),
        ['normalizeRustMetadataDiagnostics', 'normalizeRustParseDisposition', 'normalizeRustSourceStability'].sort(), 'metadata normalizer dependency changed')
    }
    const found = new Map()
    walk(file, node => {
      if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node)
      if (ts.isImportDeclaration(node)) {
        const target = node.moduleSpecifier.text
        assert(!target.startsWith('node:'), 'client owns native I/O: ' + target)
        assert(!/rustCoreWorkerRuntime|rustCoreSchedulerRuntime|rustCoreWorkerAutoBuildRuntime|rustCoreWorkerPathRuntime|ClientRuntime/.test(target), 'client dependency direction reversed: ' + target)
      }
      if (ts.isCallExpression(node)) {
        const call = node.expression.getText(file)
        const invocationTimer = call === 'setTimeout' && ownsParseInvocation(node, group)
        assert(invocationTimer || !/^(createRustCore|execFile|setInterval|setTimeout)/.test(call), 'client constructs transport or background state')
      }
    })
    for (const [name, hash] of Object.entries(group.functions)) {
      assert(found.has(name), 'lost domain/helper function: ' + name)
      let text = originalMetadataReceiptFunction(found.get(name).getText(file).replace(/\r\n/g, '\n'), name, group)
      if (group.path === previewClientPath && name === 'runRustPreviewCacheInputCommand') {
        // Invert the complete reviewed addition, including its comments. This
        // historical scanner does not rescan template spans, so these comments
        // are part of a template token. Keep its original fingerprints intact.
        assert.equal(text.split(previewCacheFailureGuard).length, 2, 'preview cache failure guard missing or duplicated')
        assert.equal(text.split(previewCacheFailureAddition).length, 2, 'preview cache failure addition missing or duplicated')
        text = text.replace(previewCacheFailureAddition, '')
      }
      if (name === 'runRustFontIndexListWorker') {
        const extension = " || !hasCapability(status, 'list-font-files-complete-v1')"
        assert.equal(text.split(extension).length - 1, 1, 'complete listing capability guard missing')
        text = text.replace(extension, '') // only this independently tested guard extends the frozen client
      }
      const migratedParse = group.path === parseClientPath && name === 'runRustFontParseBatch'
      if (migratedParse) assert.equal(hash, 'cdd22806d7cc007546391607289b1e525a2892013ce30ee9f524562a3cbcba26', 'historical parse fixture changed')
      assert.equal(h.digest(tokens(text)), migratedParse ? reviewedParseHash : hash, name + ' changed from pre-extraction baseline')
    }
    assert.equal(found.size, Object.keys(group.functions).length + 1, 'unexpected client function owner')
    const clientFactory = found.get(group.factory)
    const returned = clientFactory.body.statements.find(ts.isReturnStatement)
    assert(returned && ts.isObjectLiteralExpression(returned.expression))
    assert.deepEqual(returned.expression.properties.map(n => n.name.text), group.methods)
  }
}
function checkComposition(overrides = new Map()) {
  const replacements = new Map(overrides)
  for (const group of fixture.groups) replacements.set(group.path, `export let captured: any; export let methods: any; export function ${group.factory}(options: any) { if(captured) throw new Error('client constructed twice'); captured = options; methods = { ${group.methods.map(n => n + ': () => undefined').join(', ')} }; return methods }`)
  const env = h.createHarness({}, replacements)
  // The real facade and transport construct once; client construction performs no I/O.
  assert.deepEqual(env.trace.map(e => e[0]), ['create.scheduler', 'create.daemon'])
  const shared = new Map()
  for (const group of fixture.groups) {
    const { captured, methods } = env.load(group.path)
    assert(captured, 'client is not composed: ' + group.name)
    assert.deepEqual(Object.keys(captured).sort(), [...group.ports].sort(), 'client received broad or missing dependencies')
    for (const port of group.ports) {
      assert.equal(typeof captured[port], 'function', 'invalid port: ' + port)
      if (shared.has(port)) assert.equal(captured[port], shared.get(port), 'clients do not share the same port: ' + port)
      else shared.set(port, captured[port])
    }
    assert.equal(captured.diagnoseRustCoreWorker, env.runtime.diagnoseRustCoreWorker, 'diagnostics owner duplicated')
    for (const name of group.methods) assert.equal(env.runtime[name], methods[name], 'facade changed method identity: ' + name)
  }
}
// A compatibility facade may only construct owners and publish their references.
function checkFacadeClosure(text = read(facade)) {
  const file = ts.createSourceFile(facade, text, ts.ScriptTarget.Latest, true)
  const expectedImports = new Set(['./rustCoreWorkerContracts', './rustCoreWorkerTransportRuntime', ...fixture.groups.map(g => './clients/' + path.posix.basename(g.path, '.ts'))])
  const functions = []
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      assert(expectedImports.delete(statement.moduleSpecifier.text), 'unexpected or duplicate facade import')
    } else if (ts.isExportDeclaration(statement)) {
      assert(statement.isTypeOnly && statement.moduleSpecifier.text === './rustCoreWorkerContracts', 'facade leaks runtime or private exports')
    } else {
      assert(ts.isFunctionDeclaration(statement) && statement.name.text === 'createRustCoreWorkerRuntime', 'facade owns module state or extra implementation')
      functions.push(statement)
    }
  }
  assert.equal(expectedImports.size, 0)
  assert.equal(functions.length, 1)
  const statements = functions[0].body.statements
  assert.equal(statements.length, 7, 'facade must only create six owners and return')
  const factories = new Set(['createRustCoreWorkerTransportRuntime', ...fixture.groups.map(g => g.factory)])
  const owners = new Set()
  for (const statement of statements.slice(0, -1)) {
    assert(ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const, 'mutable facade owner')
    assert.equal(statement.declarationList.declarations.length, 1)
    const declaration = statement.declarationList.declarations[0], call = declaration.initializer
    assert(ts.isIdentifier(declaration.name) && ts.isCallExpression(call) && ts.isIdentifier(call.expression), 'facade owns non-composition logic')
    assert(factories.delete(call.expression.text), 'duplicate or unexpected owner factory')
    owners.add(declaration.name.text)
    assert.equal(call.arguments.length, 1)
    const argument = call.arguments[0]
    if (call.expression.text === 'createRustCoreWorkerTransportRuntime') {
      assert(ts.isIdentifier(argument) && argument.text === 'options', 'transport options changed')
    } else {
      assert(ts.isObjectLiteralExpression(argument), 'client receives entire options/transport')
      for (const port of argument.properties) {
        assert(ts.isPropertyAssignment(port) && ts.isPropertyAccessExpression(port.initializer), 'client receives broad or computed dependency')
        assert(['transport', 'options'].includes(port.initializer.expression.getText(file)))
        assert.equal(port.name.text, port.initializer.name.text, 'client port renamed or miswired')
      }
    }
  }
  assert.equal(factories.size, 0)
  const returned = statements.at(-1)
  assert(ts.isReturnStatement(returned) && ts.isObjectLiteralExpression(returned.expression))
  for (const property of returned.expression.properties) {
    assert(ts.isPropertyAssignment(property) && ts.isPropertyAccessExpression(property.initializer), 'facade must publish direct references, without spread or wrappers')
    assert(owners.has(property.initializer.expression.getText(file)), 'unknown method owner')
    assert.equal(property.name.text, property.initializer.name.text, 'method renamed or miswired')
  }
  assert.deepEqual(returned.expression.properties.map(p => p.name.text).sort(), require('./fixtures/orchestration-contracts.fixture.json').rustFacadeMethods)
}
function checkControlIdentities(overrides = new Map()) {
  const transportPath = h.core + 'rustCoreWorkerTransportRuntime.ts'
  // Wrap construction only: the captured ports belong to the real transport.
  const source = read(transportPath).replace('export function createRustCoreWorkerTransportRuntime(', 'function createActualTransport(')
    + '\nexport let captured: any; export function createRustCoreWorkerTransportRuntime(options: any) { captured = createActualTransport(options); return captured }'
  const env = h.createHarness({}, new Map(overrides).set(transportPath, source))
  const { captured } = env.load(transportPath)
  const domainMethods = new Set(fixture.groups.flatMap(g => g.methods))
  for (const method of require('./fixtures/orchestration-contracts.fixture.json').rustFacadeMethods) {
    if (!domainMethods.has(method)) assert.equal(env.runtime[method], captured[method], 'control identity changed: ' + method)
  }
  env.runtime.stopRustCoreDaemon()
  assert.equal(env.trace.filter(e => e[0] === 'stop').length, 1, 'stop must reach the sole daemon once')
}
function checkClosureMutations() {
  const original = read(facade)
  const changes = [
    ['module state', 'export function createRustCoreWorkerRuntime', 'const cache = new Map()\nexport function createRustCoreWorkerRuntime'],
    ['duplicate transport', '  return {', '  const duplicate = createRustCoreWorkerTransportRuntime(options)\n  return {'],
    ['broad client ports', 'createRustIndexingClientRuntime({', 'createRustIndexingClientRuntime({ ...transport,'],
    ['extra public port', '  return {', '  return { runRustCoreScheduledCommand: transport.runRustCoreScheduledCommand,'],
    ['wrapped stop', 'stopRustCoreDaemon: transport.stopRustCoreDaemon,', 'stopRustCoreDaemon: () => transport.stopRustCoreDaemon(),'],
  ]
  for (const [name, before, after] of changes) {
    const altered = original.replace(before, after)
    assert.notEqual(altered, original, 'closure mutant did not apply: ' + name)
    assert.throws(() => checkFacadeClosure(altered), undefined, 'closure regression accepted: ' + name)
    if (name === 'wrapped stop') assert.throws(() => checkControlIdentities(new Map([[facade, altered]])), /control identity changed/)
  }
}
async function checkMaintenanceFailureReports() {
  const item = { label: 'index', filePath: 'C:/index.db', ok: false, message: 'integrity failed' }
  const health = h.createHarness({ mode: 'false-daemon', payloads: { '--database-health-check': { ok: false, items: [item], elapsedMs: 12 } } })
  const report = await health.runtime.runRustDatabaseHealthCheck(h.argsFor('runRustDatabaseHealthCheck', health)[0])
  assert.deepEqual(JSON.parse(JSON.stringify(report)), { items: [item], elapsedMs: 12, workerMode: 'rust-database-health-check' })
  assert.equal(health.files.size, 0)
  const backup = h.createHarness({ mode: 'false-daemon', payloads: { '--database-backup': { ok: false, items: [], message: 'backup failed' } } })
  await assert.rejects(backup.runtime.runRustDatabaseBackup({ reason: 'manual', createdAt: 'fixture', items: [] }), error => error.daemonSubmitted === true && error.command === '--database-backup' && error.message === 'backup failed')
  assert.equal(backup.files.size, 0)
  assert(!backup.trace.some(e => e[0] === 'schedule'), 'failed submitted backup executed again')
}
async function checkRecoveryCapability() {
  for (const guard of [{ expectedTagNames: [] }, { recoveryFiles: [{ path: 'C:/a.ttf' }] }, { recoveryMissingSources: [{ path: 'C:/old.ttf' }] }, { recoveryMoves: [{ from: 'old', to: 'new' }] }]) {
    const env=h.createHarness(), input=h.argsFor('runRustLocalTagsSet',env)[0]
    if (guard.expectedTagNames) input.rows[0].expectedTagNames=guard.expectedTagNames
    else Object.assign(input,guard)
    await assert.rejects(env.runtime.runRustLocalTagsSet(input),/重新编译 worker/)
    assert.equal(env.files.size,0,'old worker denial must precede recovery submission')
    assert(!env.trace.some(entry=>JSON.stringify(entry).includes('--local-tags-set')))
  }
  const capabilities=[...new Set(h.commands.flatMap(command=>command.capabilities)),'local-tags-recovery-guard']
  const env=h.createHarness({capabilities}), input=h.argsFor('runRustLocalTagsSet',env)[0]
  input.rows[0].expectedTagNames=[]
  assert.deepEqual(JSON.parse(JSON.stringify((await env.runtime.runRustLocalTagsSet(input)).updatedIds)),['f'])
  assert.equal(env.files.size,0)
}
function clientFixture(groupName, config, overrides = new Map()) {
  const group = fixture.groups.find(group => group.name === groupName)
  const env = h.createHarness({}, overrides)
  const inputs = [], commands = [], disposed = []
  let allocated = 0
  const ports = {
    appendStartupLog() {}, appendPreviewCacheFailureLog() {},
    diagnoseRustCoreWorker: async () => ({ available: true, path: 'C:/worker.exe', capabilities: config.capabilities }),
    createTemporaryJsonFile: () => {
      const filePath = 'C:/fixture/input-' + (++allocated) + '.json'
      return { path: filePath, writeJson: async value => inputs.push(JSON.parse(JSON.stringify(value))),
        readText: async () => JSON.stringify(config.payload), dispose: async () => disposed.push(filePath) }
    },
    runRustCoreScheduledCommand: async (worker, args, options) => {
      commands.push({ worker, args: JSON.parse(JSON.stringify(args)), options })
      config.onCommand?.(options)
      if (config.error) throw config.error
      return { stdout: JSON.stringify(config.payload), stderr: '', ...(config.previewBytes ? { previewBytes: config.previewBytes } : {}),
        ...(config.sharedIo ? { sharedIo: true } : {}), ...(config.daemon ? { daemon: true } : {}) }
    },
  }
  return { client: env.load(group.path)[group.factory](ports), inputs, commands, disposed, allocated: () => allocated }
}
async function checkPreviewCacheFailureContracts(overrides = new Map()) {
  const methods = [
    ['runRustPreviewCacheReadStatus', 'preview-cache-index-read'],
    ['runRustPreviewCacheQuery', 'preview-cache-index-query'],
    ['runRustPreviewCacheBatch', 'preview-cache-batch'],
  ]
  const input = { dbPath: 'C:/preview.sqlite', readOnly: true, rows: [], previewKey: 'key', outputPath: 'C:/preview.png', schemaVersion: 1, now: 'now' }
  for (const [method, capability] of methods) {
    const capabilities = [capability, 'preview-cache-read-only-v1']
    for (const kind of ['missing', 'busy', 'denied', 'corrupt', 'incompatible', 'unavailable']) {
      const error = Object.assign(new Error(`[HFM_PREVIEW_CACHE:${kind}] native read failed`), { closed: Promise.resolve(), queuedMs: 7, executionMs: 11 })
      const failed = clientFixture('Preview', { capabilities, error }, overrides)
      await assert.rejects(failed.client[method](input), value => value === error,
        'preview cache failure contract: original error/lifetime lost: ' + method)
      assert.equal(failed.commands.length, 1, 'preview cache failure contract: read replayed')
      assert.equal(failed.disposed.length, 1, 'preview cache failure contract: temporary input leaked')
      assert.equal(failed.commands[0].options.sharedIo.write, false, 'preview cache failure contract: read became writable')
      const receipt = clientFixture('Preview', { capabilities, payload: { ok: false, message: error.message } }, overrides)
      await assert.rejects(receipt.client[method](input), value => value.message === error.message,
        'preview cache failure contract: daemon receipt category swallowed')
      assert.equal(receipt.commands.length, 1, 'preview cache failure contract: failed receipt replayed')
      assert.equal(receipt.disposed.length, 1, 'preview cache failure contract: failed receipt input leaked')
    }
    for (const message of ['unable to open database file', '[HFM_PREVIEW_CACHE:unknown] unavailable']) {
      const failed = clientFixture('Preview', { capabilities, error: new Error(message) }, overrides)
      assert.equal(await failed.client[method](input), null, 'preview cache failure contract: unclassified local error changed')
    }
    const error = Object.assign(new Error('shared process failed'), { sharedIo: true, closed: Promise.resolve() })
    const shared = clientFixture('Preview', { capabilities, error }, overrides)
    await assert.rejects(shared.client[method](input), value => value === error,
      'preview cache failure contract: shared process ownership lost')
  }
  // The migration applies to reads; existing mutation/optional-touch behavior stays intact.
  for (const [method, capability] of [['runRustPreviewCacheTouch', 'preview-cache-index-touch'],
    ['runRustPreviewCacheApply', 'preview-cache-index-apply'], ['runRustPreviewCacheDelete', 'preview-cache-index-delete']]) {
    const error = new Error('[HFM_PREVIEW_CACHE:denied] denied')
    const failed = clientFixture('Preview', { capabilities: [capability], error }, overrides)
    if (method === 'runRustPreviewCacheTouch') {
      let result
      await assert.doesNotReject(async () => { result = await failed.client[method](input) },
        'preview cache failure contract: read-only migration changed touch')
      assert.equal(result, null, 'preview cache failure contract: optional touch result changed')
    } else await assert.rejects(failed.client[method](input), value => value === error,
      'preview cache failure contract: submitted write failure swallowed')
    assert.equal(failed.commands.length, 1, 'preview cache failure contract: mutation replayed')
    assert.equal(failed.disposed.length, 1, 'preview cache failure contract: mutation input leaked')
  }
}
async function checkPreviewCacheFailureMutations() {
  const original = sources.get(previewClientPath)
  for (const replacement of ['', previewCacheFailureGuard + previewCacheFailureGuard,
    previewCacheFailureGuard.replace('query && ', ''), previewCacheFailureGuard.replace('throw error', 'throw new Error(String(error))')]) {
    assert.throws(() => checkFunctions(new Map(sources).set(previewClientPath, original.replace(previewCacheFailureGuard, replacement))),
      error => error instanceof assert.AssertionError && /preview cache failure guard|runRustPreviewCacheInputCommand changed/.test(error.message),
      'preview cache failure structural mutation accepted')
  }
  for (const replacement of [previewCacheFailureGuard, previewCacheFailureAddition.replace('Keep native', 'Keep changed')]) {
    assert.throws(() => checkFunctions(new Map(sources).set(previewClientPath, original.replace(previewCacheFailureAddition, replacement))),
      error => error instanceof assert.AssertionError && /preview cache failure addition missing or duplicated/.test(error.message),
      'preview cache failure incomplete inverse accepted')
  }
  const dependency = "'../../../shared/previewCacheFailure'"
  assert.equal(original.split(dependency).length, 2)
  assert.throws(() => checkFunctions(new Map(sources).set(previewClientPath, original.replace(dependency, "'../../../shared/wrongFailure'"))),
    /preview cache failure dependency changed/)
  for (const replacement of ['', previewCacheFailureGuard.replace('query && ', ''),
    previewCacheFailureGuard.replace('throw error', 'throw new Error(String(error))')]) {
    await assert.rejects(checkPreviewCacheFailureContracts(new Map([[previewClientPath, original.replace(previewCacheFailureGuard, replacement)]])),
      error => error instanceof assert.AssertionError && /preview cache failure contract/.test(error.message),
      'preview cache failure causal mutation accepted')
  }
}
async function checkReviewedClientContracts(overrides = new Map()) {
  const png = require('./fixtures/preview-png.cjs')
  const input = { fontPath: 'C:/fonts/a.ttf', outputPath: 'C:/preview.png', text: 'A', fontSize: 24, width: 200, height: 60 }
  for (const foregroundBytes of [true, false, undefined]) {
    const config = { capabilities: ['preview-render-image'], payload: { ok: true, outputPath: input.outputPath, imageHex: png.toString('hex') }, ...(foregroundBytes ? { previewBytes: png } : {}) }
    const f = clientFixture('Preview', config, overrides)
    const result = await f.client.runRustPreviewRenderImage({ ...input, foregroundBytes })
    assert.equal(Object.hasOwn(f.inputs[0], 'foregroundBytes'), false, 'UI intent leaked into unproved native JSON')
    assert.deepEqual(f.inputs[0], input)
    assert.equal(f.commands[0].options.foregroundPreviewBytes, foregroundBytes === true)
    assert.equal(f.commands[0].options.maxBuffer, (foregroundBytes ? 5 : 1) * 1024 * 1024)
    assert.equal(result.bytes, foregroundBytes ? png : undefined, 'client accepted unvalidated receipt hex or lost validated transport bytes')
    assert.equal(result.transient, foregroundBytes ? true : undefined)
    assert.equal(f.disposed.length, 1)
  }
  const failedPreview = clientFixture('Preview', { capabilities: ['preview-render-image'], payload: { ok: false }, daemon: true }, overrides)
  await assert.rejects(failedPreview.client.runRustPreviewRenderImage(input), error => error.daemonSubmitted === true)
  assert.equal(failedPreview.disposed.length, 1)

  const listing = { ok: true, files: [{ path: 'C:/fonts/a.ttf', size: 2, modifiedMs: 1 }], directories: [{ path: 'C:/fonts' }], errors: [{ path: 'C:/fonts/denied', message: 'denied' }], foldersScanned: 1, truncated: true }
  for (const stdout of [false, true]) {
    const progress = []
    const f = clientFixture('Indexing', { capabilities: ['list-font-files', 'list-font-files-complete-v1', ...(stdout ? ['list-font-files-stdout-v1'] : [])], payload: listing,
      onCommand: options => { for (const line of ['hfm-scan-progress: {"files":0,"foldersScanned":0}', 'hfm-scan-progress: {"files":-1,"foldersScanned":0}', 'hfm-scan-progress: {broken']) options.onStderrLine(line) } }, overrides)
    const result = await f.client.runRustFontIndexListWorker(['C:/fonts'], ['.TTF'], value => progress.push(JSON.parse(JSON.stringify(value))))
    const command = f.commands[0]
    assert.equal(command.args.includes('--output'), !stdout)
    assert.equal(f.allocated(), stdout ? 0 : 1); assert.equal(f.disposed.length, stdout ? 0 : 1)
    assert.equal(command.options.maxBuffer, stdout ? 32 * 1024 * 1024 + 256 * 1024 : 256 * 1024)
    assert.equal(command.options.sharedIo.write, !stdout)
    if (stdout) assert(command.options.sharedIo.accesses.every(access => access.mode === 'read' && access.scope === 'tree'))
    else assert(command.options.sharedIo.paths.includes(command.args[command.args.indexOf('--output') + 1]))
    assert.equal(result.files.length, 1); assert.equal(result.directories.length, 1); assert.equal(result.errors[0].message, 'denied'); assert.equal(result.truncated, true)
    assert.deepEqual(progress, [{ files: 0, foldersScanned: 0 }, { files: 1, foldersScanned: 1 }])
  }
  const incomplete = clientFixture('Indexing', { capabilities: ['list-font-files', 'list-font-files-complete-v1', 'list-font-files-stdout-v1'], payload: { ok: true, files: [] } }, overrides)
  await assert.rejects(incomplete.client.runRustFontIndexListWorker(['C:/fonts'], ['.ttf']), /receipt incomplete/)
  assert.equal(incomplete.allocated(), 0)

  const strictRebuildInput={mergedIndexDbPath:'C:/local/merged.sqlite',schemaVersion:7,sourcesKey:'same',syncedAt:'now',sources:[],requireAuthoritativeSources:true}
  const oldRebuild=clientFixture('Indexing',{capabilities:['merged-index-rebuild'],payload:{ok:true,rebuilt:true,rows:0}},overrides)
  assert.equal(await oldRebuild.client.runRustMergedIndexRebuild(strictRebuildInput),null);assert.equal(oldRebuild.commands.length,0)
  const badRebuild=clientFixture('Indexing',{capabilities:['merged-index-rebuild','merged-index-strict-rebuild-v1','install-status-signature-authority-v1'],payload:{ok:true}},overrides)
  await assert.rejects(()=>badRebuild.client.runRustMergedIndexRebuild(strictRebuildInput),error=>error.daemonSubmitted===true)
  assert.equal(badRebuild.commands.length,1)

  const prepared = { mergedIndexDbPath:'C:/local/merged.sqlite',schemaVersion:7,sourcesKey:'same',expectedSourcesKey:'same',syncedAt:'now',
    source:{root:'Z:/fonts',indexDbPath:'Z:/offline.sqlite',indexSignature:'root-v3|1',installSignature:'none',sharedMetadataSignature:'metadata:none'},preparedRows:[],fullSnapshot:true }
  const oldMerged = clientFixture('Indexing',{capabilities:['merged-index-sync'],payload:{ok:true,synced:true}},overrides)
  assert.equal(await oldMerged.client.runRustMergedIndexSync(prepared),null);assert.equal(oldMerged.commands.length,0);assert.equal(oldMerged.allocated(),0)
  for(const payload of [{ok:true},{ok:false},{ok:true,synced:false},{ok:'yes',synced:true,rows:0,changed:0,fullSnapshot:true},{ok:true,synced:true,rows:1,changed:0,fullSnapshot:true},{ok:true,synced:true,rows:0,changed:0,fullSnapshot:false},{ok:true,synced:true,rows:0,changed:0.5,fullSnapshot:true}]) {
    let writes=0
    const malformed = clientFixture('Indexing',{capabilities:['merged-index-sync','merged-index-prepared-sync-v1','install-status-signature-authority-v1'],payload,onCommand:()=>writes++},overrides)
    await assert.rejects(()=>malformed.client.runRustMergedIndexSync(prepared),error=>error.daemonSubmitted===true)
    assert.equal(writes,1,'malformed post-commit receipt replayed an identical-key write');assert.equal(malformed.disposed.length,1)
  }
  const guarded = clientFixture('Indexing',{capabilities:['merged-index-sync','merged-index-prepared-sync-v1','install-status-signature-authority-v1'],payload:{ok:true,synced:true,rows:0,changed:0,fullSnapshot:true}},overrides)
  const assertCurrent=()=>{}
  assert.equal((await guarded.client.runRustMergedIndexSync({...prepared,assertCurrent})).synced,true)
  assert.equal(guarded.commands[0].options.assertCurrent,assertCurrent)
  assert(!guarded.commands[0].options.sharedIo.paths.includes(prepared.source.root),'prepared commit inferred a remote read footprint')

  const snapshotInput = { rootPath: 'C:/fonts', dbPath: 'C:/metadata.db', entries: [], bindingSnapshot: true }
  const baseCapabilities = ['shared-metadata-overlay-read'], capabilities = [...baseCapabilities, 'shared-metadata-bindings-read-v1']
  const row = { font_id: 'f', relative_path: 'a.ttf', path_key: 'a.ttf', tag_names_json: '["tag"]', favorite: 1, delete_protected: 0, revision: 2 }
  const payload = { ok: true, matched: [], bindingSnapshot: { version: 1, rows: [row] } }
  const snapshot = clientFixture('Metadata', { capabilities, payload, sharedIo: true }, overrides)
  const result = await snapshot.client.runRustSharedMetadataOverlayRead(snapshotInput)
  assert.deepEqual(JSON.parse(JSON.stringify(result.bindingSnapshot)), payload.bindingSnapshot)
  assert.equal(snapshot.inputs[0].bindingSnapshot, true); assert.deepEqual(snapshot.inputs[0].entries, [])
  assert.equal(snapshot.commands[0].options.sharedIo.write, false)
  assert(snapshot.commands[0].options.sharedIo.accesses.every(access => access.mode === 'read'))
  assert.equal(snapshot.disposed.length, 1)
  for (const [caps, change, reason] of [[baseCapabilities, {}, 'capability-unavailable'], [capabilities, { preflight: { version: 1, phase: 'snapshot' } }, 'invalid-input'], [capabilities, { entries: [{ key: 'k' }] }, 'invalid-input']]) {
    const denied = clientFixture('Metadata', { capabilities: caps, payload, sharedIo: true }, overrides)
    await assert.rejects(denied.client.runRustSharedMetadataOverlayRead({ ...snapshotInput, ...change }), error => error.reason === reason)
    assert.equal(denied.allocated(), 0); assert.equal(denied.commands.length, 0)
  }
  for (const bindingSnapshot of [undefined, { version: 2, rows: [] }, { version: 1, rows: {} }, { version: 1, rows: [null] }, { version: 1, rows: [{ ...row, tag_names_json: [] }] }, { version: 1, rows: [{ ...row, favorite: true }] }, { version: 1, rows: [{ ...row, revision: 1.5 }] }]) {
    const invalid = clientFixture('Metadata', { capabilities, payload: { ok: true, matched: [], bindingSnapshot }, sharedIo: true }, overrides)
    await assert.rejects(invalid.client.runRustSharedMetadataOverlayRead(snapshotInput), error => error.reason === 'invalid-receipt')
    assert.equal(invalid.commands.length, 1); assert.equal(invalid.disposed.length, 1)
  }
  const closed = Promise.resolve()
  for (const pin of ['database','parent','wal','journal']) for (const code of [32,33]) {
    const error = { sharedIo:true, reason:'process-exit', outcome:'unknown', closed, queuedMs:7, executionMs:11,
      message:`Shared I/O process failed: code=2, signal=null, message=[HFM_BINDING_SNAPSHOT_BUSY:${pin}:${code}] binding snapshot ${pin} pin unavailable` }
    const busy = clientFixture('Metadata', { capabilities, error }, overrides)
    await assert.rejects(busy.client.runRustSharedMetadataOverlayRead(snapshotInput), value => {
      assert.equal(value.reason,'snapshot-busy');assert.equal(value.pinTarget,pin);assert.match(value.rootToken,/^[a-f0-9]{16}$/)
      assert.equal(value.closed,closed);assert.equal(value.queuedMs,7);assert.equal(value.executionMs,11);return true
    })
    assert.equal(busy.commands.length,1,'client replayed read internally');assert.equal(busy.disposed.length,1)
    const ordinary = clientFixture('Metadata', { capabilities, error }, overrides)
    await assert.rejects(ordinary.client.runRustSharedMetadataOverlayRead({...snapshotInput,bindingSnapshot:false,entries:[{key:'one'}]}), value=>value===error)
  }
  for (const change of [
    { reason:'timeout' }, { sharedIo:false },
    { message:'binding snapshot sidecar pin unavailable (os error 32)' },
    { message:'Shared I/O process failed: code=2, signal=null, message=[HFM_BINDING_SNAPSHOT_BUSY:wal:5] denied' },
    { message:'Shared I/O process failed: code=2, signal=null, message=prefix [HFM_BINDING_SNAPSHOT_BUSY:wal:32] denied' },
    { message:'Shared I/O process failed: code=2, signal=null, message=[HFM_BINDING_SNAPSHOT_BUSY:shm:32] denied' },
  ]) {
    const error = { sharedIo:true, reason:'process-exit', outcome:'unknown',
      message:'Shared I/O process failed: code=2, signal=null, message=[HFM_BINDING_SNAPSHOT_BUSY:wal:32] busy',...change }
    const denied = clientFixture('Metadata', { capabilities, error }, overrides)
    if(error.sharedIo)await assert.rejects(denied.client.runRustSharedMetadataOverlayRead(snapshotInput),value=>value===error)
    else assert.equal(await denied.client.runRustSharedMetadataOverlayRead(snapshotInput),null)
    assert.equal(denied.commands.length,1)
  }

}
const installAuthorityCapability = 'install-status-signature-authority-v1'
const installAuthorityMethods = [
  ['Metadata', 'runRustInstallStatusRead', 'install-status-index-read'],
  ['Indexing', 'runRustMergedIndexPageQuery', 'merged-index-page-query'],
  ['Indexing', 'runRustMergedIndexIdsQuery', 'merged-index-ids-query'],
  ['Indexing', 'runRustMergedIndexMetricsQuery', 'merged-index-metrics-query'],
  ['Indexing', 'runRustMergedIndexRebuild', 'merged-index-rebuild'],
  ['Indexing', 'runRustMergedIndexSync', 'merged-index-sync'],
]
async function checkInstallAuthorityCapabilities(overrides = new Map()) {
  const input = { mergedIndexDbPath:'C:/local/merged.sqlite', libraryDbPath:'C:/local/library.sqlite', roots:['C:/fonts'],
    queryKey:'authority', offset:0, limit:20, sources:[], source:{root:'C:/fonts'}, rows:[] }
  const payload = { ok:true, results:{}, missingIds:['missing'], missingReasons:{missing:'signature-mismatch'}, readError:true,
    items:[], ids:[], total:0, metrics:{}, rebuilt:true, synced:true, rows:0, changed:0 }
  for (const [group, method, capability] of installAuthorityMethods) {
    const args = method === 'runRustInstallStatusRead' ? [[{rootPath:'C:/fonts',dbPath:'C:/local/install.sqlite',items:[]}]] : [input]
    const old = clientFixture(group,{capabilities:[capability],payload},overrides)
    assert.equal(await old.client[method](...args),null,'authority capability gate: '+method)
    assert.equal(old.allocated(),0,'old authority worker allocated temporary input: '+method)
    assert.equal(old.commands.length,0,'old authority worker submitted command: '+method)
    const current = clientFixture(group,{capabilities:[capability,installAuthorityCapability],payload},overrides)
    const result = await current.client[method](...args)
    assert(result,'current authority worker was refused: '+method)
    assert.equal(current.commands.length,1,'authority command duplicated: '+method)
    assert.equal(current.disposed.length,1,'authority input lifetime: '+method)
    if (method === 'runRustInstallStatusRead') {
      assert.equal(result.readError,true,'unavailable authority was converted to missing')
      assert.deepEqual(JSON.parse(JSON.stringify(result.missingReasons)),payload.missingReasons,'authority miss reasons lost')
    }
  }
}
async function checkInstallAuthorityMutations() {
  for (const [groupName,method,capability] of installAuthorityMethods) {
    const group=fixture.groups.find(group=>group.name===groupName), original=sources.get(group.path)
    const before=`!hasCapability(status, '${capability}') || !hasCapability(status, '${installAuthorityCapability}')`
    assert.equal(original.split(before).length-1,1,'authority mutant anchor count: '+method)
    const changed=new Map([[group.path,original.replace(before,`!hasCapability(status, '${capability}')`)]])
    await assert.rejects(checkInstallAuthorityCapabilities(changed),error=>error instanceof assert.AssertionError && error.message.includes('authority capability gate: '+method),'authority gate mutant was not causally rejected: '+method)
  }
}
async function checkReviewedClientMutations() {
  const mutations = [
    ['Preview', 'foregroundPreviewBytes: foregroundBytes === true', 'foregroundPreviewBytes: false'],
    ['Preview', '{ bytes: commandOutput.previewBytes, transient: true }', '{ bytes: commandOutput.previewBytes, transient: false }'],
    ['Indexing', "const stdoutListing = hasCapability(status, 'list-font-files-stdout-v1')", 'const stdoutListing = false'],
    ['Metadata', "input.bindingSnapshot && !hasCapability(status, 'shared-metadata-bindings-read-v1')", "false && !hasCapability(status, 'shared-metadata-bindings-read-v1')"],
    ['Metadata', 'if (input.bindingSnapshot) rethrowSharedMetadataSnapshotBusy(error, input.rootPath)', 'rethrowSharedMetadataSnapshotBusy(error, input.rootPath)'],
    ['Metadata', 'if (input.bindingSnapshot) rethrowSharedMetadataSnapshotBusy(error, input.rootPath)', '/* missing positive busy classification */'],
  ]
  for (const [groupName, before, after] of mutations) {
    const group = fixture.groups.find(group => group.name === groupName), original = sources.get(group.path)
    assert(original.includes(before), 'reviewed client mutant anchor missing: ' + groupName)
    const changed = new Map([[group.path, original.replace(before, after)]])
    await assert.rejects(checkReviewedClientContracts(changed), undefined, 'reviewed client behavior mutation accepted: ' + groupName)
  }
}
async function checkCompleteListingCapability(overrides = new Map()) {
  const old = clientFixture('Indexing',{capabilities:['list-font-files'],payload:{ok:true,files:[],directories:[],errors:[],truncated:false}},overrides)
  assert.equal(await old.client.runRustFontIndexListWorker(['C:/fonts'],['.ttf']),null,'COMPLETE_LISTING_GATE: old iterator semantics accepted')
  assert.equal(old.commands.length,0);assert.equal(old.allocated(),0)
}
function checkParseInvocationBoundaryMutations() {
  const original = sources.get(parseClientPath)
  const mutants = [
    ['module timer', null, '\nsetTimeout(() => {}, 0)\n', /client constructs transport or background state/],
    ['missing timer cleanup', 'clearTimeout(timer)', 'void timer', /runRustFontParseBatch changed from pre-extraction baseline/],
    ['missing caller abort forwarding', 'controller.abort(signal?.reason)', 'void signal?.reason', /runRustFontParseBatch changed from pre-extraction baseline/],
    ['persistent interval', 'setTimeout(resolve, 0)', 'setInterval(resolve, 0)', /client constructs transport or background state/],
  ]
  for (const [label, before, after, cause] of mutants) {
    if (before) assert.equal(original.split(before).length, 2, 'parse boundary mutant anchor: ' + label)
    const changed = before ? original.replace(before, after) : original + after
    assert.throws(() => checkFunctions(new Map(sources).set(parseClientPath, changed)),
      error => error instanceof assert.AssertionError && cause.test(error.message), 'parse boundary mutant accepted: ' + label)
  }
}
function checkMetadataReceiptMutations() {
  const original = sources.get(parseClientPath)
  const mutations = [
    ['parse receipt omitted', metadataReceiptAdditions.normalizeRustParseBatchJob[0], ''],
    ['parse receipt unnormalized', 'normalizeRustMetadataDiagnostics(input.metadataDiagnostics)', 'input.metadataDiagnostics'],
    ['listing receipt omitted', metadataReceiptAdditions.runRustFontIndexListWorker[0], ''],
    ['listing receipt unnormalized', 'normalizeRustMetadataDiagnostics(item.metadataDiagnostics)', 'item.metadataDiagnostics'],
    ...['normalizeRustParseBatchJob', 'runRustFontIndexListWorker'].flatMap(name => metadataReceiptAdditions[name].slice(1).flatMap(addition => [
      [name + ' evidence omitted', addition, ''],
      [name + ' evidence duplicate', addition, addition + addition],
      [name + ' evidence bypassed', addition, addition.replace(/normalizeRust(?:ParseDisposition|SourceStability)\(([^)]+)\)/, '$1')],
    ])),
    ['parse normalizer import missing', 'normalizeRustMetadataDiagnostics, normalizeRustParseDisposition, normalizeRustSourceStability', 'normalizeRustMetadataDiagnostics, normalizeRustSourceStability'],
    ['stability normalizer import missing', 'normalizeRustMetadataDiagnostics, normalizeRustParseDisposition, normalizeRustSourceStability', 'normalizeRustMetadataDiagnostics, normalizeRustParseDisposition'],
    ['normalizer dependency changed', "'../fontMetadataDiagnostics'", "'../../indexing/fontScanWorkers'"],
  ]
  for (const [label, before, after] of mutations) {
    assert.equal(original.split(before).length, 2, 'metadata receipt mutation anchor: ' + label)
    assert.throws(() => checkFunctions(new Map(sources).set(parseClientPath, original.replace(before, after))),
      error => error instanceof assert.AssertionError && /metadata receipt normalization|metadata normalizer dependency/.test(error.message),
      'metadata receipt mutation accepted: ' + label)
  }
}
async function checkMetadataEvidenceNormalization(overrides = new Map()) {
  // The same hand-written loader used by every client must expose both new exports.
  const env = h.createHarness({}, overrides)
  const normalizers = env.load(h.core + 'fontMetadataDiagnostics.ts')
  assert.equal(typeof normalizers.normalizeRustParseDisposition, 'function')
  assert.equal(typeof normalizers.normalizeRustSourceStability, 'function')
  const dispositions = ['complete', 'missing', 'empty', 'unsupported', 'malformed', 'resource-limit', 'io-error', 'not-requested']
  for (const scripts of dispositions) assert.deepEqual(JSON.parse(JSON.stringify(normalizers.normalizeRustParseDisposition({ scripts }))), { scripts }, 'evidence normalization valid disposition')
  for (const input of [undefined, null, false, 'complete', {}, { scripts: 1 }, { scripts: 'anything' }])
    assert.equal(normalizers.normalizeRustParseDisposition(input), undefined, 'evidence normalization invalid disposition')
  for (const value of ['stable', 'changed', 'unknown']) assert.equal(normalizers.normalizeRustSourceStability(value), value, 'evidence normalization valid stability')
  for (const value of [undefined, null, true, {}, 'anything']) assert.equal(normalizers.normalizeRustSourceStability(value), undefined, 'evidence normalization invalid stability')
  const job = { jobId: 'evidence', rootPath: 'C:/fonts', filePath: 'C:/fonts/evidence.ttf', cacheKey: 'evidence.ttf', signature: 'stable', fileSize: 1, modifiedAt: 1, createdAt: 1 }
  for (const evidence of [{}, { parseDisposition: { scripts: 'unsupported' }, sourceStability: 'stable' },
    { parseDisposition: { scripts: 'io-error' }, sourceStability: 'unknown' },
    { parseDisposition: {}, sourceStability: true }, { parseDisposition: { scripts: 'anything' }, sourceStability: 'anything' }]) {
    const expectedDisposition = normalizers.normalizeRustParseDisposition(evidence.parseDisposition)
    const expectedStability = normalizers.normalizeRustSourceStability(evidence.sourceStability)
    const parse = clientFixture('Indexing', { capabilities: ['font-parse-batch'], payload: { ok: true, results: [{ ...job, ...evidence }], errors: [] } }, overrides)
    const parsed = (await parse.client.runRustFontParseBatch([job])).results[0]
    const listing = clientFixture('Indexing', { capabilities: ['list-font-files', 'list-font-files-complete-v1', 'list-font-files-stdout-v1'],
      payload: { ok: true, files: [{ path: job.filePath, size: 1, modifiedMs: 1, ...evidence }], directories: [], errors: [], truncated: false } }, overrides)
    const listed = (await listing.client.runRustFontIndexListWorker(['C:/fonts'], ['.ttf'])).files[0]
    for (const row of [parsed, listed]) {
      assert.equal(JSON.stringify(row.parseDisposition), JSON.stringify(expectedDisposition), 'evidence normalization client disposition')
      assert.equal(row.sourceStability, expectedStability, 'evidence normalization client stability')
    }
  }
}
async function checkMetadataEvidenceNormalizerMutations() {
  const rel = h.core + 'fontMetadataDiagnostics.ts', original = read(rel)
  for (const [before, after] of [
    ['scriptDispositions.has(scripts)', 'true'],
    ["input === 'stable' || input === 'changed' || input === 'unknown'", 'true'],
    ["if (!input || typeof input !== 'object') return undefined", "if (!input || typeof input !== 'object') return { scripts: 'unsupported' }"],
    ["? { scripts: scripts as RustParseDisposition['scripts'] } : undefined", "? { scripts: 'unsupported' } : undefined"],
  ]) {
    assert.equal(original.split(before).length, 2, 'evidence normalizer mutation anchor drifted')
    await assert.rejects(checkMetadataEvidenceNormalization(new Map([[rel, original.replace(before, after)]])),
      error => error instanceof assert.AssertionError && /evidence normalization/.test(error.message), 'evidence normalizer mutant accepted')
  }
}
async function main() {
  checkFunctions()
  checkMetadataReceiptMutations()
  await checkMetadataEvidenceNormalization()
  await checkMetadataEvidenceNormalizerMutations()
  checkParseInvocationBoundaryMutations()
  checkFacadeClosure()
  checkControlIdentities()
  checkClosureMutations()
  checkComposition()
  await checkMaintenanceFailureReports()
  await checkRecoveryCapability()
  await checkPreviewCacheFailureContracts()
  await checkPreviewCacheFailureMutations()
  await checkReviewedClientContracts()
  await checkCompleteListingCapability()
  const listingGroup=fixture.groups.find(group=>group.name==='Indexing'), listingGuard=" || !hasCapability(status, 'list-font-files-complete-v1')"
  await assert.rejects(()=>checkCompleteListingCapability(new Map([[listingGroup.path,sources.get(listingGroup.path).replace(listingGuard,'')]])),error=>error instanceof assert.AssertionError && /COMPLETE_LISTING_GATE/.test(error.message))
  await checkInstallAuthorityCapabilities()
  await checkInstallAuthorityMutations()
  await checkReviewedClientMutations()
  for (const group of fixture.groups) {
    const changed = new Map(sources)
    const name = Object.keys(group.functions)[0]
    const original = changed.get(group.path)
    const target = original.replace(new RegExp('function ' + name + '\\b'), 'function ' + name + 'Changed')
    assert.notEqual(target, original, 'function mutant did not apply')
    changed.set(group.path, target)
    assert.throws(() => checkFunctions(changed), undefined, 'changed domain function accepted')
    const badImport = new Map(sources).set(group.path, original + "\nimport type { RustCoreWorkerStatus } from '../rustCoreWorkerRuntime'\n")
    assert.throws(() => checkFunctions(badImport), undefined, 'reverse client dependency accepted')
    const method = group.methods[0]
    const originalFacade = read(facade)
    const altered = originalFacade.replace(new RegExp('    ' + method + ': [^\\n]+,(?=\\n)'), '    ' + method + ': () => null,')
    assert.notEqual(altered, originalFacade, 'facade mutant did not apply')
    assert.throws(() => checkComposition(new Map([[facade, altered]])), undefined, 'facade wrapper/identity drift accepted')
  }
  const crlf = new Map([...sources].map(([rel, text]) => [rel, text.replace(/\n/g, '\r\n')]))
  checkFunctions(crlf)
  const facadeCRLF = read(facade).replace(/\n/g, '\r\n')
  checkFacadeClosure(facadeCRLF)
  checkControlIdentities(new Map([[facade, facadeCRLF]]))
  checkComposition(new Map([[facade, facadeCRLF]]))
  console.log(`[diagnostics:rust-worker-clients] ${fixture.groups.length} clients, ${fixture.groups.reduce((n,g)=>n+g.methods.length,0)} method identities, frozen function bodies with reviewed causal port checks and six authority capability gates, narrow shared ports, typed metadata/evidence receipt inverse, explicit preview cache read failures and causal mutations, optional old-worker compatibility and causal normalizer mutations, partial health report and submitted backup, domain and evidence mutations rejected, facade closure and 7 control identities, CRLF passed`)
}
main().catch(error => { console.error('[diagnostics:rust-worker-clients]', error.stack || error); process.exitCode = 1 })
