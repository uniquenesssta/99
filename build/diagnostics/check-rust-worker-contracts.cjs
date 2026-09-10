#!/usr/bin/env node
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const core = 'src/main/rust-core/'
const contracts = core + 'rustCoreWorkerContracts.ts'
const payloads = core + 'rustCoreWorkerPayloadTypes.ts'
const facade = core + 'rustCoreWorkerRuntime.ts'
const fixture = require('./fixtures/rust-worker-contracts.fixture.json')
const publicNames = Object.keys(fixture.publicTypes)
const payloadNames = Object.keys(fixture.payloadTypes)
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
assert.equal(config.error, undefined)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
assert.equal(parsed.errors.length, 0)
// Match the compiler's path identity on both Windows and POSIX hosts.
const canonical = ts.createCompilerHost(parsed.options).getCanonicalFileName
const key = file => canonical(path.resolve(file).replace(/\\/g, '/'))
const abs = rel => path.join(root, rel)
const sourcePrefix = key(abs('src')) + '/'
const corePrefix = key(abs(core)) + '/'
const sorted = values => [...values].sort()
const exact = (actual, expected, label) => assert.deepEqual(sorted(actual), sorted(expected), label)

function shapeHash(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text)
  const tokens = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) tokens.push([kind, scanner.getTokenText()])
  return crypto.createHash('sha256').update(JSON.stringify(tokens)).digest('hex')
}

function view(overrides = new Map()) {
  const sources = new Map([...overrides].map(([file, text]) => [key(abs(file)), text]))
  const cache = new Map()
  const read = file => sources.has(key(file)) ? sources.get(key(file)) : fs.readFileSync(file, 'utf8')
  const file = rel => {
    const filename = abs(rel)
    if (!cache.has(key(filename))) cache.set(key(filename), ts.createSourceFile(filename, read(filename), ts.ScriptTarget.Latest, true))
    return cache.get(key(filename))
  }
  return { sources, read, file }
}

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, child => visit(child, callback))
}

function checkShapes(current) {
  for (const [rel, expected, dependencies] of [
    [contracts, fixture.publicTypes, fixture.publicDependencies],
    [payloads, fixture.payloadTypes, fixture.payloadDependencies],
  ]) {
    const file = current.file(rel)
    const declarations = file.statements.filter(ts.isTypeAliasDeclaration)
    exact(declarations.map(node => node.name.text), Object.keys(expected), rel + ' declarations')
    for (const node of declarations) {
      assert(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword), node.name.text + ' lost its export')
      assert.equal(shapeHash(node.type.getText(file)), expected[node.name.text], node.name.text + ' shape changed')
    }
    const external = []
    for (const node of file.statements) {
      if (ts.isTypeAliasDeclaration(node)) continue
      assert(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly, rel + ' must contain only types and type-only imports')
      const bindings = node.importClause.namedBindings
      assert(bindings && ts.isNamedImports(bindings), rel + ' must use explicit named imports')
      for (const binding of bindings.elements) {
        const record = { name: binding.name.text, imported: (binding.propertyName || binding.name).text, module: node.moduleSpecifier.text }
        if (rel === payloads && record.module === './rustCoreWorkerContracts') {
          assert(publicNames.includes(record.imported), 'payload imports a non-public contract')
        } else external.push(record)
      }
    }
    exact(external.map(value => JSON.stringify(value)), dependencies.map(value => JSON.stringify(value)), rel + ' dependency identities')
  }
}

function moduleReferences(file) {
  const refs = []
  visit(file, node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) refs.push({ node, literal: node.moduleSpecifier })
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) refs.push({ node, literal: node.argument.literal })
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) refs.push({ node, literal: node.arguments[0] })
    }
  })
  return refs.filter(ref => ts.isStringLiteral(ref.literal))
}

function checkBoundaries(current) {
  const graph = new Map()
  for (const filename of parsed.fileNames.filter(file => key(file).startsWith(sourcePrefix))) {
    const file = current.file(path.relative(root, filename))
    const edges = []
    for (const { node, literal } of moduleReferences(file)) {
      const resolved = ts.resolveModuleName(literal.text, filename, parsed.options, ts.sys).resolvedModule
      if (!resolved || !key(resolved.resolvedFileName).startsWith(sourcePrefix)) continue
      const target = key(resolved.resolvedFileName)
      edges.push(target)
      if (target === key(abs(payloads))) {
        assert(key(filename).startsWith(corePrefix) && key(filename) !== key(abs(contracts)), 'private payload escaped rust-core')
        assert(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly, 'private payload must be imported only as a type, never re-exported')
      }
      if (target === key(abs(facade)) && ts.isImportDeclaration(node)) {
        const names = node.importClause?.namedBindings
        assert(!node.importClause?.isTypeOnly && names && ts.isNamedImports(names), 'type consumer still imports the facade')
        assert(names.elements.every(e => !e.isTypeOnly && (e.propertyName || e.name).text === 'createRustCoreWorkerRuntime'), 'type consumer must import contracts directly')
      }
    }
    graph.set(key(filename), edges)
  }
  for (const start of [contracts, payloads]) {
    const origin = key(abs(start))
    const seen = new Set()
    const follow = (node, chain) => {
      assert(node !== origin, 'type dependency cycle: ' + [...chain, node].map(p => path.relative(root, p)).join(' -> '))
      assert(node !== key(abs(facade)), start + ' depends on the facade implementation')
      if (seen.has(node)) return
      seen.add(node)
      for (const target of graph.get(node) || []) follow(target, [...chain, node])
    }
    for (const target of graph.get(origin) || []) follow(target, [origin])
  }
}

function checkErasure(current) {
  for (const rel of [contracts, payloads]) {
    const js = ts.transpileModule(current.read(abs(rel)), { compilerOptions: { ...parsed.options, module: ts.ModuleKind.CommonJS } }).outputText
    const exports = {}
    vm.runInNewContext(js, {
      exports,
      require: id => { throw new Error('type module caused runtime loading: ' + id) },
    }, { filename: rel, timeout: 1000 })
    exact(Object.keys(exports), [], 'type module exposed runtime values')
  }
}

function checkCompiler(current) {
  const virtualPath = abs('build/diagnostics/fixtures/rust-worker-contracts.virtual.ts')
  const source = `
import type * as C from '../../../src/main/rust-core/rustCoreWorkerContracts'
import type * as L from '../../../src/main/rust-core/rustCoreWorkerRuntime'
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
${publicNames.map((name, i) => `type Public${i} = Assert<Equal<C.${name}, L.${name}>>`).join('\n')}
${payloadNames.map((name, i) => `// @ts-expect-error Internal payload is not part of the public facade\ntype Private${i} = L.${name}`).join('\n')}
// @ts-expect-error Worker availability must be boolean
const invalidStatus: C.RustCoreWorkerStatus = { available: 'yes' }
// @ts-expect-error Preview dimensions must be numeric
const invalidPreview: C.RustPreviewRenderImageInput = { fontPath: 'font.ttf', text: 'a', fontSize: 12, width: '100', height: 100, outputPath: 'out.png' }
// @ts-expect-error Root-index mutations require their database path
const missingDb: C.RustRootIndexApplyChangesInput = { rootPath: 'root', storage: 'root', schemaVersion: 1, cacheVersion: 1, scriptDetectionVersion: 1, upserts: [], deletes: [] }
`
  const host = ts.createCompilerHost(parsed.options)
  const sources = new Map(current.sources)
  sources.set(key(virtualPath), source)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = file => sources.has(key(file)) ? sources.get(key(file)) : readFile(file)
  host.fileExists = file => sources.has(key(file)) || fileExists(file)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => sources.has(key(file))
    ? ts.createSourceFile(file, sources.get(key(file)), languageVersion, true)
    : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram({ rootNames: [virtualPath, abs(payloads), ...parsed.fileNames.filter(file => file.endsWith('.d.ts'))], options: parsed.options, host })
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 0, errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'))
  const checker = program.getTypeChecker()
  const exportsOf = rel => checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(abs(rel))))
  exact(exportsOf(contracts).map(symbol => symbol.name), publicNames, 'public contract export set')
  exact(exportsOf(payloads).map(symbol => symbol.name), payloadNames, 'private payload export set')
  exact(exportsOf(facade).map(symbol => symbol.name), ['createRustCoreWorkerRuntime', ...publicNames], 'legacy facade export set')
  const publicSymbols = new Map(exportsOf(contracts).map(symbol => [symbol.name, symbol]))
  for (const symbol of exportsOf(facade).filter(s => s.name !== 'createRustCoreWorkerRuntime')) {
    assert(symbol.flags & ts.SymbolFlags.Alias, symbol.name + ' was duplicated instead of re-exported')
    assert.equal(checker.getAliasedSymbol(symbol), publicSymbols.get(symbol.name), symbol.name + ' has multiple owners')
  }
}

function main() {
  const actual = view()
  checkShapes(actual)
  checkBoundaries(actual)
  checkErasure(actual)
  checkCompiler(actual)
  const mutated = (rel, change) => view(new Map([[rel, change(actual.read(abs(rel)))]]))
  const rejects = [
    ['required field widened', () => checkShapes(mutated(contracts, text => text.replace('available: boolean', 'available?: boolean')))],
    ['public export removed', () => checkShapes(mutated(contracts, text => text.replace('export type RustCoreWorkerStatus', 'type RustCoreWorkerStatus')))],
    ['private payload narrowed', () => checkShapes(mutated(payloads, text => text.replace('ok?: boolean', 'ok: boolean')))],
    ['runtime import introduced', () => checkShapes(mutated(contracts, text => text.replace('import type', 'import')))],
    ['runtime side effect introduced', () => checkErasure(mutated(contracts, text => text + '\nrequire("node:fs")\n'))],
    ['type dependency cycle', () => checkBoundaries(mutated(contracts, text => text + "\nimport type { rustCoreWorkerIsCompatible } from './rustCoreProtocolRuntime'\n"))],
    ['payload leaked to business', () => checkBoundaries(mutated('src/main/indexing/shared-metadata/sharedMetadataMutationSignalRuntime.ts', text => text + "\nimport type { RustCoreWorkerHandshake } from '../../rust-core/rustCoreWorkerPayloadTypes'\n"))],
    ['payload re-exported by facade', () => checkBoundaries(mutated(facade, text => text + "\nexport type { RustCoreWorkerHandshake } from './rustCoreWorkerPayloadTypes'\n"))],
    ['business import reverted', () => checkBoundaries(mutated('src/main/indexing/shared-metadata/sharedMetadataMutationSignalRuntime.ts', text => text.replace('rustCoreWorkerContracts', 'rustCoreWorkerRuntime')))],
  ]
  for (const [label, run] of rejects) assert.throws(run, undefined, 'negative control did not fail: ' + label)
  const crlf = view(new Map([contracts, payloads, facade].map(rel => [rel, actual.read(abs(rel)).replace(/\r?\n/g, '\r\n')])))
  checkShapes(crlf)
  checkBoundaries(crlf)
  checkErasure(crlf)
  console.log(`[diagnostics:rust-worker-contracts] ${publicNames.length} public aliases, ${payloadNames.length} private shapes, 41 compiler rejections, import erasure, dependency boundaries and cycles passed; ${rejects.length} mutants rejected; CRLF passed`)
}

try { main() } catch (error) {
  console.error('[diagnostics:rust-worker-contracts]', error.stack || error)
  process.exitCode = 1
}
