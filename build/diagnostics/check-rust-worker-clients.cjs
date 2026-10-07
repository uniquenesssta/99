#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const h = require('./helpers/rustWorkerTransportHarness.cjs')
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
function checkFunctions(overrides = sources) {
  for (const group of fixture.groups) {
    const file = ts.createSourceFile(group.path, overrides.get(group.path), ts.ScriptTarget.Latest, true)
    const found = new Map()
    walk(file, node => {
      if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node)
      if (ts.isImportDeclaration(node)) {
        const target = node.moduleSpecifier.text
        assert(!target.startsWith('node:'), 'client owns native I/O: ' + target)
        assert(!/rustCoreWorkerRuntime|rustCoreSchedulerRuntime|rustCoreWorkerAutoBuildRuntime|rustCoreWorkerPathRuntime|ClientRuntime/.test(target), 'client dependency direction reversed: ' + target)
      }
      if (ts.isCallExpression(node)) assert(!/^(createRustCore|execFile|setInterval|setTimeout)/.test(node.expression.getText(file)), 'client constructs transport or background state')
    })
    for (const [name, hash] of Object.entries(group.functions)) {
      assert(found.has(name), 'lost domain/helper function: ' + name)
      assert.equal(h.digest(tokens(found.get(name).getText(file))), hash, name + ' changed from pre-extraction baseline')
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
async function main() {
  checkFunctions()
  checkFacadeClosure()
  checkControlIdentities()
  checkClosureMutations()
  checkComposition()
  await checkMaintenanceFailureReports()
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
  console.log(`[diagnostics:rust-worker-clients] ${fixture.groups.length} clients, ${fixture.groups.reduce((n,g)=>n+g.methods.length,0)} method identities, frozen function bodies, narrow shared ports, partial health report and submitted backup, ${fixture.groups.length * 3 + 5} rejected mutations, facade closure and 7 control identities, CRLF passed`)
}
main().catch(error => { console.error('[diagnostics:rust-worker-clients]', error.stack || error); process.exitCode = 1 })
