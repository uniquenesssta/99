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
// This callback belongs to the in-memory write owner. Preserve every frozen
// native input token while locking the one reviewed optional admission hook.
const reviewedOptionalProperties = {
  ...fixture.reviewedOptionalProperties,
  RustListedFontFile: { metadataDiagnostics: 'metadataDiagnostics?: RustMetadataDiagnostic[]',
    parseDisposition: 'parseDisposition?: RustParseDisposition', sourceStability: 'sourceStability?: RustSourceStability' },
  RustInstallStatusReadResult: {
    missingReasons: "missingReasons?: Record<string, import('../install/status/installStatusTypes').InstallStatusMissReason>",
    readError: 'readError?: boolean',
  },
  RustRootIndexApplyChangesInput: { assertCurrent: 'assertCurrent?: () => void' },
  RustMergedIndexRebuildInput: { requireAuthoritativeSources: 'requireAuthoritativeSources?: boolean' },
  RustMergedIndexSyncInput: {
    preparedRows: 'preparedRows?: Record<string, unknown>[]',
    expectedSourcesKey: 'expectedSourcesKey?: string',
    preserveSourceCheckpoint: 'preserveSourceCheckpoint?: boolean',
    assertCurrent: 'assertCurrent?: () => void',
  },
}
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

// Type-only additive migration: lock each explicitly reviewed optional field,
// then check every original token against its unchanged frozen shape hash.
function originalShapeAfterReviewedAdditions(node, file, additions = {}) {
  const entries = Object.entries(additions)
  if (!entries.length) return node.type.getText(file)
  assert(ts.isTypeLiteralNode(node.type), node.name.text + ' no longer has its reviewed object shape')
  const ranges = []
  for (const [name, expected] of entries) {
    const members = node.type.members.filter(member => member.name?.getText(file) === name)
    assert.equal(members.length, 1, `${node.name.text}.${name} missing or duplicated`)
    const member = members[0]
    assert(ts.isPropertySignature(member) && member.questionToken && member.type, `${node.name.text}.${name} must remain optional`)
    assert.equal(shapeHash(member.getText(file)), shapeHash(expected), `${node.name.text}.${name} reviewed property changed`)
    ranges.push([member.getFullStart() - node.type.getStart(file), member.end - node.type.getStart(file)])
  }
  let text = node.type.getText(file)
  for (const [start, end] of ranges.sort((left, right) => right[0] - left[0])) text = text.slice(0, start) + text.slice(end)
  return text
}

// Only the reviewed nested listing receipt is additive. All surrounding payload
// tokens and dependency identities remain checked against the historical fixture.
function originalMetadataPayloadShape(node, file) {
  if (node.name.text !== 'RustListFontFilesPayload') return node.type.getText(file)
  assert(ts.isTypeLiteralNode(node.type), 'metadata listing payload object changed')
  const files = node.type.members.filter(member => member.name?.getText(file) === 'files')
  assert.equal(files.length, 1, 'metadata listing files missing or duplicated')
  const list = files[0].type
  assert(ts.isTypeReferenceNode(list) && list.typeName.getText(file) === 'Array' && list.typeArguments?.length === 1
    && ts.isTypeLiteralNode(list.typeArguments[0]), 'metadata listing files shape changed')
  let text = node.type.getText(file)
  const start = node.type.getStart(file), ranges = []
  for (const [name, expected] of Object.entries(reviewedOptionalProperties.RustListedFontFile)) {
    const members = list.typeArguments[0].members.filter(member => member.name?.getText(file) === name)
    assert.equal(members.length, 1, `metadata listing ${name} missing or duplicated`)
    const member = members[0]
    assert(ts.isPropertySignature(member) && member.questionToken
      && shapeHash(member.getText(file)) === shapeHash(expected), `metadata listing ${name} type changed`)
    ranges.push([member.getFullStart() - start, member.end - start])
  }
  for (const [from, to] of ranges.sort((a, b) => b[0] - a[0])) text = text.slice(0, from) + text.slice(to)
  return text
}

function checkMetadataEvidenceTypes(current) {
  const file = current.file(core + 'fontMetadataDiagnostics.ts')
  const expected = {
    RustParseDisposition: "export interface RustParseDisposition { scripts: 'complete' | 'missing' | 'empty' | 'unsupported' | 'malformed' | 'resource-limit' | 'io-error' | 'not-requested' }",
    RustSourceStability: "export type RustSourceStability = 'stable' | 'changed' | 'unknown'",
  }
  for (const [name, declaration] of Object.entries(expected)) {
    const nodes = file.statements.filter(node => node.name?.text === name)
    assert.equal(nodes.length, 1, name + ' evidence declaration missing or duplicated')
    assert.equal(shapeHash(nodes[0].getText(file)), shapeHash(declaration), name + ' evidence vocabulary changed')
  }
}
function checkShapes(current) {
  checkMetadataEvidenceTypes(current)
  for (const [rel, expected, dependencies] of [
    [contracts, fixture.publicTypes, fixture.publicDependencies],
    [payloads, fixture.payloadTypes, fixture.payloadDependencies],
  ]) {
    const file = current.file(rel)
    const additions = rel === contracts ? reviewedOptionalProperties : {}
    for (const name of Object.keys(additions)) assert(Object.hasOwn(expected, name), 'Reviewed additions name an unknown public alias: ' + name)
    const declarations = file.statements.filter(ts.isTypeAliasDeclaration)
    exact(declarations.map(node => node.name.text), Object.keys(expected), rel + ' declarations')
    for (const node of declarations) {
      assert(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword), node.name.text + ' lost its export')
      assert.equal(shapeHash(rel === payloads ? originalMetadataPayloadShape(node, file) : originalShapeAfterReviewedAdditions(node, file, additions[node.name.text])), expected[node.name.text], node.name.text + ' original shape changed')
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
    const reviewedDependencies = [...dependencies, ...['RustMetadataDiagnostic', 'RustParseDisposition', 'RustSourceStability'].map(name => ({ name, imported: name, module: './fontMetadataDiagnostics' }))]
    exact(external.map(value => JSON.stringify(value)), reviewedDependencies.map(value => JSON.stringify(value)), rel + ' dependency identities')
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
import type * as P from '../../../src/main/rust-core/rustCoreWorkerPayloadTypes'
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
${publicNames.map((name, i) => `type Public${i} = Assert<Equal<C.${name}, L.${name}>>`).join('\n')}
${payloadNames.map((name, i) => `// @ts-expect-error Internal payload is not part of the public facade\ntype Private${i} = L.${name}`).join('\n')}
declare const oldListedFile: Omit<C.RustListedFontFile, 'metadataDiagnostics' | 'parseDisposition' | 'sourceStability'>
const legacyListedFile: C.RustListedFontFile = oldListedFile
const legacyListedPayload: P.RustListFontFilesPayload = { files: [{ path: 'fixture.ttf' }] }
type MetadataDiagnostic = NonNullable<C.RustListedFontFile['metadataDiagnostics']>[number]
const metadataDiagnostic: MetadataDiagnostic = { stage: 'name', kind: 'missing-table', detail: 'name-table-absent' }
const typedListedFile: C.RustListedFontFile = { ...legacyListedFile, metadataDiagnostics: [metadataDiagnostic] }
const typedListedPayload: P.RustListFontFilesPayload = { files: [{ metadataDiagnostics: [metadataDiagnostic] }] }
const evidenceListedFile: C.RustListedFontFile = { ...legacyListedFile, parseDisposition: { scripts: 'unsupported' }, sourceStability: 'stable' }
const evidenceListedPayload: P.RustListFontFilesPayload = { files: [{ parseDisposition: { scripts: 'io-error' }, sourceStability: 'unknown' }] }
// @ts-expect-error Disposition vocabulary is closed.
const invalidParseDisposition: C.RustListedFontFile = { ...legacyListedFile, parseDisposition: { scripts: 'anything' } }
// @ts-expect-error Present disposition must identify scripts.
const missingScriptDisposition: C.RustListedFontFile = { ...legacyListedFile, parseDisposition: {} }
// @ts-expect-error Source stability is not a boolean.
const invalidSourceStability: C.RustListedFontFile = { ...legacyListedFile, sourceStability: true }
// @ts-expect-error Nested receipt retains the same closed vocabulary.
const invalidNestedDisposition: P.RustListFontFilesPayload = { files: [{ parseDisposition: { scripts: 'bad-font' } }] }
// @ts-expect-error Nested receipt must carry scripts when disposition exists.
const missingNestedDisposition: P.RustListFontFilesPayload = { files: [{ parseDisposition: {} }] }
// @ts-expect-error Changed source is explicit, arbitrary states are not accepted.
const invalidNestedStability: P.RustListFontFilesPayload = { files: [{ sourceStability: 'anything' }] }

// @ts-expect-error Native stage is a closed vocabulary.
const badMetadataStage: MetadataDiagnostic = { ...metadataDiagnostic, stage: 'anything' }
// @ts-expect-error Unsupported metadata never becomes a bad-font disposition.
const badMetadataKind: MetadataDiagnostic = { ...metadataDiagnostic, kind: 'bad-font' }
// @ts-expect-error Native detail remains text.
const badMetadataDetail: MetadataDiagnostic = { ...metadataDiagnostic, detail: 1 }
// @ts-expect-error Source index remains numeric.
const badMetadataIndex: MetadataDiagnostic = { ...metadataDiagnostic, sourceIndex: '0' }
const legacyInstallRead: C.RustInstallStatusReadResult = { results: {}, missingIds: [], workerMode: 'rust-install-status-read' }
const unavailableInstallRead: C.RustInstallStatusReadResult = { ...legacyInstallRead, missingReasons: { font: 'signature-mismatch' }, readError: true }
// @ts-expect-error Unknown authority reasons cannot silently acquire trusted meaning.
const invalidInstallReason: C.RustInstallStatusReadResult = { ...legacyInstallRead, missingReasons: { font: 'anything' } }
// @ts-expect-error Read failure remains boolean and distinct from a missing row.
const invalidInstallReadError: C.RustInstallStatusReadResult = { ...legacyInstallRead, readError: 'missing' }
const legacyWatcher: C.RustWatcherPreflightInput = { rootPath: 'C:/fonts', dbPath: 'index.sqlite', extensions: ['ttf'], changes: [] }
const versionedWatcher: C.RustWatcherPreflightInput = { ...legacyWatcher, scriptDetectionVersion: 2 }
// @ts-expect-error Watcher script version remains numeric.
const invalidWatcherVersion: C.RustWatcherPreflightInput = { ...legacyWatcher, scriptDetectionVersion: '2' }
// Legacy callers must remain valid without recovery-only fields.
const legacyTagSet: C.RustLocalTagsSetInput = { dbPath: 'local.sqlite', updatedAt: 'now', rows: [{ itemId: 'font', aliases: ['font'], fontPath: 'C:/font.ttf', tagNames: ['Keep'] }] }
const recoveryTagSet: C.RustLocalTagsSetInput = { ...legacyTagSet,
  rows: [{ ...legacyTagSet.rows[0], expectedTagNames: [] }],
  recoveryMoves: [{ from: 'C:/old.ttf', to: 'C:/new.ttf' }],
  recoveryFiles: [{ path: 'C:/new.ttf', physicalPath: 'C:/new.ttf', sha256: 'proof' }],
  recoveryMissingSources: [{ path: 'C:/old.ttf', rootPath: 'C:/' }],
}
// @ts-expect-error Expected tags are names, never numeric identities.
const invalidRecoveryTags: C.RustLocalTagsSetRow = { ...legacyTagSet.rows[0], expectedTagNames: [1] }
// @ts-expect-error Recovery files must carry their verified physical target.
const invalidRecoveryFile: C.RustLocalTagsSetInput = { ...legacyTagSet, recoveryFiles: [{ path: 'C:/new.ttf', sha256: 'proof' }] }
// @ts-expect-error Missing-source validation must retain its accessible root.
const invalidRecoverySource: C.RustLocalTagsSetInput = { ...legacyTagSet, recoveryMissingSources: [{ path: 'C:/old.ttf' }] }
// Legacy callers do not need either optional capability field.
const legacyOverlay: C.RustSharedMetadataOverlayReadInput = { rootPath: 'C:/fonts', dbPath: 'metadata.sqlite', entries: [] }
const bindingRead: C.RustSharedMetadataOverlayReadInput = { ...legacyOverlay, bindingSnapshot: true }
const bindingRows: C.RustSharedMetadataOverlayReadResult['bindingSnapshot'] = { version: 1, rows: [] }
const legacyPreviewInput: C.RustPreviewRenderImageInput = { fontPath: 'C:/font.ttf', text: 'a', fontSize: 12, width: 100, height: 100, outputPath: 'out.png' }
const bytePreviewInput: C.RustPreviewRenderImageInput = { ...legacyPreviewInput, foregroundBytes: true }
const previewBytes: C.RustPreviewRenderImageResult['bytes'] = Buffer.from([137, 80, 78, 71])
const transientPreview: C.RustPreviewRenderImageResult['transient'] = true
const legacyRebuild: C.RustMergedIndexRebuildInput = { mergedIndexDbPath: 'local.sqlite', schemaVersion: 7, sourcesKey: 'key', syncedAt: 'now', sources: [] }
const strictRebuild: C.RustMergedIndexRebuildInput = { ...legacyRebuild, requireAuthoritativeSources: true }
const legacySync: C.RustMergedIndexSyncInput = { mergedIndexDbPath: 'local.sqlite', schemaVersion: 7, sourcesKey: 'next', syncedAt: 'now', source: { root: 'C:/fonts', indexDbPath: 'index.sqlite', indexSignature: 'root-v3', installSignature: 'none' } }
const preparedSync: C.RustMergedIndexSyncInput = { ...legacySync, preparedRows: [{ relative_path: 'font.ttf', font_json: '{}' }], expectedSourcesKey: 'previous', preserveSourceCheckpoint: true, assertCurrent: () => {} }
// @ts-expect-error A partial root receipt must use the explicit boolean mode.
const invalidPreserveCheckpoint: C.RustMergedIndexSyncInput = { ...legacySync, preserveSourceCheckpoint: 'yes' }
// @ts-expect-error Strict source admission flag remains boolean.
const invalidStrictRebuild: C.RustMergedIndexRebuildInput = { ...legacyRebuild, requireAuthoritativeSources: 'yes' }
// @ts-expect-error Prepared rows are named scalar-record payloads, not strings.
const invalidPreparedRows: C.RustMergedIndexSyncInput = { ...legacySync, preparedRows: ['font'] }
// @ts-expect-error Expected source checkpoint is an exact string receipt.
const invalidSourceReceipt: C.RustMergedIndexSyncInput = { ...legacySync, expectedSourcesKey: 2 }
// @ts-expect-error In-memory guard must be callable.
const invalidPreparedGuard: C.RustMergedIndexSyncInput = { ...legacySync, assertCurrent: true }
// @ts-expect-error Snapshot request flag remains boolean.
const invalidBindingRead: C.RustSharedMetadataOverlayReadInput = { ...legacyOverlay, bindingSnapshot: 'true' }
// @ts-expect-error Snapshot receipt version is the exact supported protocol.
const invalidBindingRows: C.RustSharedMetadataOverlayReadResult['bindingSnapshot'] = { version: 2, rows: [] }
// @ts-expect-error Foreground byte request flag remains boolean.
const invalidBytePreviewInput: C.RustPreviewRenderImageInput = { ...legacyPreviewInput, foregroundBytes: 'true' }
// @ts-expect-error Returned bytes are Buffer data, not an unvalidated string.
const invalidPreviewBytes: C.RustPreviewRenderImageResult['bytes'] = '89504e47'
// @ts-expect-error Transient state remains boolean.
const invalidTransientPreview: C.RustPreviewRenderImageResult['transient'] = 1
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
  const preparedGuardAnchor = 'preserveSourceCheckpoint?: boolean\n  expectedSourcesKey?: string\n  assertCurrent?: () => void'
  assert.equal(actual.read(abs(contracts)).replace(/\r\n/g, '\n').split(preparedGuardAnchor).length, 2, 'prepared guard mutation anchor drifted')
  const metadataField = 'metadataDiagnostics?: RustMetadataDiagnostic[]'
  for (const rel of [contracts, payloads]) assert.equal(actual.read(abs(rel)).split(metadataField).length, 2, 'metadata field mutation anchor drifted')
  const rejects = [
    ['authority reason made mandatory', () => checkShapes(mutated(contracts, text => text.replace('missingReasons?: Record', 'missingReasons: Record')))],
    ['authority read error widened', () => checkShapes(mutated(contracts, text => text.replace('readError?: boolean', 'readError?: string')))],
    ['strict rebuild flag missing', () => checkShapes(mutated(contracts, text => text.replace('requireAuthoritativeSources?: boolean', '')))],
    ['prepared rows widened', () => checkShapes(mutated(contracts, text => text.replace('preparedRows?: Record<string, unknown>[]', 'preparedRows?: unknown[]')))],
    ['expected checkpoint missing', () => checkShapes(mutated(contracts, text => text.replace('expectedSourcesKey?: string', '')))],
    ['partial checkpoint flag missing', () => checkShapes(mutated(contracts, text => text.replace('preserveSourceCheckpoint?: boolean', '')))],
    ['prepared guard async', () => checkShapes(mutated(contracts, text => text.replace(/\r\n/g, '\n').replace(preparedGuardAnchor, preparedGuardAnchor.replace('() => void', '() => Promise<void>'))))],
    ['write admission missing', () => checkShapes(mutated(contracts, text => text.replace('assertCurrent?: () => void', '')))],
    ['write admission made mandatory', () => checkShapes(mutated(contracts, text => text.replace('assertCurrent?: () => void', 'assertCurrent: () => void')))],
    ['write admission made asynchronous', () => checkShapes(mutated(contracts, text => text.replace('assertCurrent?: () => void', 'assertCurrent?: () => Promise<void>')))],
    ['binding request made mandatory', () => checkShapes(mutated(contracts, text => text.replace('bindingSnapshot?: boolean', 'bindingSnapshot: boolean')))],
    ['binding receipt version widened', () => checkShapes(mutated(contracts, text => text.replace('bindingSnapshot?: { version: 1;', 'bindingSnapshot?: { version: number;')))],
    ['foreground flag widened', () => checkShapes(mutated(contracts, text => text.replace('foregroundBytes?: boolean', 'foregroundBytes?: string')))],
    ['returned bytes widened', () => checkShapes(mutated(contracts, text => text.replace('bytes?: Buffer', 'bytes?: string')))],
    ['transient state made mandatory', () => checkShapes(mutated(contracts, text => text.replace('transient?: boolean', 'transient: boolean')))],
    ['reviewed addition missing', () => checkShapes(mutated(contracts, text => text.replace('foregroundBytes?: boolean', '')))],
    ['reviewed addition duplicated', () => checkShapes(mutated(contracts, text => text.replace('foregroundBytes?: boolean', 'foregroundBytes?: boolean\n  foregroundBytes?: boolean')))],
    ['unreviewed property introduced', () => checkShapes(mutated(contracts, text => text.replace('foregroundBytes?: boolean', 'foregroundBytes?: boolean\n  unreviewedWrite?: boolean')))],
    ['required field widened', () => checkShapes(mutated(contracts, text => text.replace('available: boolean', 'available?: boolean')))],
    ['legacy recovery field made mandatory', () => checkShapes(mutated(contracts, text => text.replace('expectedTagNames?: string[]', 'expectedTagNames: string[]')))],
    ['public export removed', () => checkShapes(mutated(contracts, text => text.replace('export type RustCoreWorkerStatus', 'type RustCoreWorkerStatus')))],
    ['private payload narrowed', () => checkShapes(mutated(payloads, text => text.replace('ok?: boolean', 'ok: boolean')))],
    ['runtime import introduced', () => checkShapes(mutated(contracts, text => text.replace('import type', 'import')))],
    ['runtime side effect introduced', () => checkErasure(mutated(contracts, text => text + '\nrequire("node:fs")\n'))],
    ['type dependency cycle', () => checkBoundaries(mutated(contracts, text => text + "\nimport type { rustCoreWorkerIsCompatible } from './rustCoreProtocolRuntime'\n"))],
    ['payload leaked to business', () => checkBoundaries(mutated('src/main/indexing/shared-metadata/sharedMetadataMutationSignalRuntime.ts', text => text + "\nimport type { RustCoreWorkerHandshake } from '../../rust-core/rustCoreWorkerPayloadTypes'\n"))],
    ['payload re-exported by facade', () => checkBoundaries(mutated(facade, text => text + "\nexport type { RustCoreWorkerHandshake } from './rustCoreWorkerPayloadTypes'\n"))],
    ['business import reverted', () => checkBoundaries(mutated('src/main/indexing/shared-metadata/sharedMetadataMutationSignalRuntime.ts', text => text.replace('rustCoreWorkerContracts', 'rustCoreWorkerRuntime')))],
  ]
  for (const rel of [contracts, payloads]) {
    for (const [label, replacement] of [['missing', ''], ['mandatory', 'metadataDiagnostics: RustMetadataDiagnostic[]'],
      ['untyped', 'metadataDiagnostics?: any'], ['duplicate', metadataField + '\n  ' + metadataField]]) {
      rejects.push([`${rel} metadata ${label}`, () => checkShapes(mutated(rel, text => text.replace(metadataField, replacement)))])
    }
    rejects.push([`${rel} metadata dependency changed`, () => checkShapes(mutated(rel, text => text.replace("'./fontMetadataDiagnostics'", "'../indexing/fontScanWorkers'")))])
  }
  for (const rel of [contracts, payloads]) for (const field of ['parseDisposition?: RustParseDisposition', 'sourceStability?: RustSourceStability']) {
    assert.equal(actual.read(abs(rel)).split(field).length, 2, 'evidence field mutation anchor drifted')
    for (const [label, replacement] of [['missing', ''], ['mandatory', field.replace('?:', ':')],
      ['widened', field.replace(/: .+$/, ': string')], ['duplicate', field + '\n  ' + field]]) {
      rejects.push([`${rel} ${field} ${label}`, () => checkShapes(mutated(rel, text => text.replace(field, replacement)))])
    }
  }
  for (const [label, before, after] of [
    ['script enum widened', "scripts: 'complete'", "scripts: string | 'complete'"],
    ['script discriminator optional', "scripts: 'complete'", "scripts?: 'complete'"],
    ['stability enum widened', "= 'stable' | 'changed' | 'unknown'", "= string"],
    ['script enum missing', "'unsupported' | ", ''],
  ]) rejects.push([label, () => checkShapes(mutated(core + 'fontMetadataDiagnostics.ts', text => text.replace(before, after)))])
  for (const [label, run] of rejects) assert.throws(run, undefined, 'negative control did not fail: ' + label)
  const crlf = view(new Map([contracts, payloads, facade].map(rel => [rel, actual.read(abs(rel)).replace(/\r?\n/g, '\r\n')])))
  checkShapes(crlf)
  checkBoundaries(crlf)
  checkErasure(crlf)
  console.log(`[diagnostics:rust-worker-contracts] ${publicNames.length} public aliases, ${payloadNames.length} private shapes, compiler rejection controls including closed parse evidence, legacy/versioned watcher, recovery tags, binding snapshots, transient bytes and prepared projection guards, import erasure, dependency boundaries and cycles passed; ${rejects.length} mutants rejected; CRLF passed`)
}

try { main() } catch (error) {
  console.error('[diagnostics:rust-worker-contracts]', error.stack || error)
  process.exitCode = 1
}
