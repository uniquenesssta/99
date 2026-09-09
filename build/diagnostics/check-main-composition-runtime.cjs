#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { createHarness, observeBootstrap, root, entry, bootstrap } = require('./helpers/mainCompositionHarness.cjs')
const fixture = require('./fixtures/main-composition-runtime.fixture.json')
const compositionFile = owner => path.join(bootstrap, `main${owner}CompositionRuntime.ts`)

function checkImportAndOwnership() {
  const h = createHarness()
  for (const owner of ['Core', 'Data', 'DataStorage', 'DataQuery']) h.load(compositionFile(owner))
  assert.equal(h.constructors.size, 0, 'import constructed a domain runtime')
  assert.equal(h.compositions.size, 0, 'import constructed a composition')
  assert.deepEqual(h.calls, [], 'import opened resources or scheduled work')
  h.load(entry)
  const data = h.compositions.get('createMainDataCompositionRuntime')
  const storage = h.compositions.get('createMainDataStorageCompositionRuntime')
  const query = h.compositions.get('createMainDataQueryCompositionRuntime')
  for (const key of ['closeLibraryDb', 'closePreviewDb', 'clearLocalPreviewDbHandle', 'checkpointOpenCacheDbs', 'closeCacheDb']) {
    assert.equal(data.resources[key], storage[key], `${key} lost its single storage owner`)
  }
  assert.equal(data.capabilities.queryFontsInLibrary, query.queryFontsInLibrary)
  assert.equal(data.capabilities.loadLibrary, storage.loadLibrary)
  assert.equal(h.options('createPreviewRuntime').openPreviewDb, storage.openPreviewDb)
  assert.equal(h.options('createMainBackgroundRuntime').openRecoverableApplicationSqliteDb, storage.openRecoverableApplicationSqliteDb)
  h.reset()
  data.resources.checkpointOpenCacheDbs()
  for (const label of ['kvs', 'events', 'hash', 'metrics']) data.resources.closeCacheDb(label)
  assert.deepEqual(h.calls, [
    ['createCacheArchitectureRuntime.checkpointOpenCacheDbs', []],
    ...['kvs', 'events', 'hash', 'metrics'].map(label => ['createCacheArchitectureRuntime.closeCacheDb', [label]]),
  ])
}

// Use the real preview connection owner, substituting only the driver/schema
// ports. The existing library-db-handle gate exercises the real library owner.
async function checkPreviewHandleOwnership() {
  const file = path.join(root, 'src/main/preview/previewDbRuntime.ts')
  const source = fs.readFileSync(file, 'utf8')
  const module = { exports: {} }
  let schemaFails = false, schemas = 0
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require: spec => {
    if (spec === './previewCacheRuntime') return { initializePreviewDbSchema: () => {
      schemas += 1
      if (schemaFails) throw new Error('fixture schema failure')
    } }
    if (spec.startsWith('node:')) return require(spec)
    throw new Error(`unexpected import ${spec}`)
  } }, { filename: file })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-composition-preview-'))
  const handles = [], closed = [], deleted = []
  const owner = module.exports.createPreviewDbRuntime({
    previewSqlitePath: () => path.join(directory, 'preview.sqlite'), previewSqliteSchemaVersion: 1,
    openRecoverableApplicationSqliteDb: async (_file, label) => {
      assert.equal(label, 'preview')
      const handle = { prepare: sql => ({ run: () => deleted.push(sql) }) }
      handles.push(handle)
      return handle
    },
    closeSqliteDb: db => { if (db) closed.push(db) },
    ensureSqliteColumn: () => undefined, setSqliteMeta: () => undefined,
  })
  try {
    assert.equal(handles.length, 0, 'constructing a connection opened a DB')
    const [a, b] = await Promise.all([owner.openPreviewDb(), owner.openPreviewDb()])
    assert.equal(a, b)
    assert.equal(handles.length, 1)
    assert.equal(schemas, 1)
    assert.equal(owner.getOpenPreviewDb(), a)
    owner.closePreviewDb()
    owner.closePreviewDb()
    assert.deepEqual(closed, [a], 'one handle closed twice')
    assert.equal(owner.getOpenPreviewDb(), null)
    const c = await owner.openPreviewDb()
    assert.notEqual(c, a)
    owner.clearLocalPreviewDbHandle()
    assert.deepEqual(deleted, ['DELETE FROM preview_cache'])
    assert.deepEqual(closed, [a, c])
    assert.equal(owner.getOpenPreviewDb(), null)
    schemaFails = true
    await assert.rejects(owner.openPreviewDb(), /fixture schema failure/)
    assert.equal(owner.getOpenPreviewDb(), null)
    assert.equal(closed.at(-1), handles.at(-1), 'schema failure leaked its handle')
    schemaFails = false
    const recovered = await owner.openPreviewDb()
    assert.equal(owner.getOpenPreviewDb(), recovered)
    owner.closePreviewDb()
    assert.equal(closed.at(-1), recovered)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

function checkOutputTypes() {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const files = ['Core', 'Data', 'DataStorage', 'DataQuery'].map(compositionFile)
  const program = ts.createProgram({ rootNames: [...files, ...parsed.fileNames.filter(file => file.endsWith('.d.ts'))], options: parsed.options })
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 0, errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  const checker = program.getTypeChecker()
  let operations = 0
  function value(type, label) {
    assert.equal(type.flags & ts.TypeFlags.Any, 0, `${label} exposes any`)
    if (type.isUnionOrIntersection()) type.types.forEach(part => value(part, label))
    if (type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Reference) {
      checker.getTypeArguments(type).forEach(part => value(part, label))
    }
  }
  function surface(type, location, label) {
    for (const field of type.getProperties()) {
      const member = checker.getTypeOfSymbolAtLocation(field, location)
      value(member, `${label}.${field.name}`)
      const signatures = member.getCallSignatures()
      if (signatures.length) {
        operations += 1
        for (const signature of signatures) {
          value(signature.getReturnType(), `${label}.${field.name} result`)
          signature.getParameters().forEach(parameter => value(checker.getTypeOfSymbolAtLocation(parameter, location), `${label}.${field.name} argument`))
        }
      } else if (member.flags & ts.TypeFlags.Object) surface(member, location, `${label}.${field.name}`)
    }
  }
  for (const file of files) {
    const source = program.getSourceFile(file)
    const factory = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find(symbol => symbol.name.startsWith('create'))
    const signature = checker.getTypeOfSymbolAtLocation(factory, source).getCallSignatures()[0]
    surface(signature.getReturnType(), source, factory.name)
  }
  assert(operations > 100, 'composition type surface was not inspected')
  return operations
}

async function checkRejectedMutations() {
  const mutations = [
    ['eager DB open', compositionFile('Data'), '  const query = createMainDataQueryCompositionRuntime({', '  void storage.openLibraryDb();\n  const query = createMainDataQueryCompositionRuntime({'],
    ['wrong close owner', entry, '      closeLibraryDb();', '      closePreviewDb();'],
    ['false-save notification', compositionFile('DataStorage'), 'if (saved) notifyPreviewLibraryShellChanged()', 'notifyPreviewLibraryShellChanged()'],
    ['lost preview task binding', compositionFile('Data'), '    completeBackgroundTask,\n    skipBackgroundTask,', '    completeBackgroundTask: () => undefined,\n    skipBackgroundTask,'],
    ['missing DB worker shutdown', compositionFile('Data'), 'dbQueryWorkerShutdown: () => dbQueryWorkerRuntime.shutdown()', 'dbQueryWorkerShutdown: () => undefined'],
    ['wrong schema audit database', compositionFile('Data'), '        openLibraryDb,\n        closeSqliteDb,\n        getSqliteMeta,', '        openLibraryDb: openPreviewDb,\n        closeSqliteDb,\n        getSqliteMeta,'],
  ]
  for (const [name, file, before, after] of mutations) {
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    assert.equal(source.split(before).length, 2, `${name}: mutation anchor drifted`)
    await assert.rejects(async () => {
      const observations = await observeBootstrap(new Map([[file, source.replace(before, after)]]))
      assert.deepEqual(observations, fixture.observations)
    }, undefined, `${name} was not detected`)
  }
  return mutations.length
}

async function main() {
  checkImportAndOwnership()
  await checkPreviewHandleOwnership()
  assert.deepEqual(await observeBootstrap(), fixture.observations, 'AT-4.1 composition behavior changed')
  const operations = checkOutputTypes()
  const mutations = await checkRejectedMutations()
  console.log(`[diagnostics:main-composition-runtime] passed: ${fixture.observations.registrations.length} registrations, ${Object.keys(fixture.observations.flows).length} baseline flows, import/DB ownership, ${operations} typed operations, ${mutations} rejected mutations`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
