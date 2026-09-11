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
    const altered = originalFacade.replace(new RegExp('    ' + method + ',(?=\\n)'), '    ' + method + ': () => null,')
    assert.notEqual(altered, originalFacade, 'facade mutant did not apply')
    assert.throws(() => checkComposition(new Map([[facade, altered]])), undefined, 'facade wrapper/identity drift accepted')
  }
  const crlf = new Map([...sources].map(([rel, text]) => [rel, text.replace(/\n/g, '\r\n')]))
  checkFunctions(crlf)
  console.log(`[diagnostics:rust-worker-clients] ${fixture.groups.length} clients, ${fixture.groups.reduce((n,g)=>n+g.methods.length,0)} method identities, frozen function bodies, narrow shared ports, partial health report and submitted backup, ${fixture.groups.length * 3} rejected mutations, CRLF passed`)
}
main().catch(error => { console.error('[diagnostics:rust-worker-clients]', error.stack || error); process.exitCode = 1 })
