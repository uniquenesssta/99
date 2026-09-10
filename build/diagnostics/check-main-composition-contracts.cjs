#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const contractsPath = path.join(root, 'src/main/bootstrap/mainCompositionContracts.ts')
const adapterPath = path.join(root, 'src/main/bootstrap/mainRuntimeRegistrationPayload.ts')
const virtualPath = path.join(root, 'build/diagnostics/fixtures/main-composition.virtual.ts')
const fixture = require('./fixtures/orchestration-contracts.fixture.json')
const groups = require('./fixtures/main-application-registration.fixture.json')
const groupFor = key => Object.keys(groups).find(group => groups[group].includes(key))
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
assert.equal(config.error, undefined)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
assert.equal(parsed.errors.length, 0)

const owners = ['Core', 'Data', 'Mutation', 'Operations']
const resourceKeys = {
  MainDataResourceLifecycle: ['closeLibraryDb', 'closePreviewDb', 'clearLocalPreviewDbHandle', 'checkpointOpenCacheDbs', 'closeCacheDb'],
  MainOperationsResourceLifecycle: ['closeTasksDb', 'checkpointTasksDb'],
}
const positive = `
import { createMainRuntimeRegistrationPayload } from '../../../src/main/bootstrap/mainRuntimeRegistrationPayload'
import type * as C from '../../../src/main/bootstrap/mainCompositionContracts'
import { createMainApplicationRuntime } from '../../../src/main/bootstrap/mainApplicationRuntime'
import type { createLibraryDbConnectionRuntime } from '../../../src/main/library/runtime/libraryDbConnectionRuntime'
import type { createPreviewDbRuntime } from '../../../src/main/preview/previewDbRuntime'
import type { createCacheArchitectureRuntime } from '../../../src/main/cache/cacheArchitectureRuntime'
import type { createBackgroundTaskRuntime } from '../../../src/main/tasks/backgroundTasks'
${owners.map(owner => `declare const ${owner.toLowerCase()}: C.Main${owner}CompositionRuntime`).join('\n')}
const registration = createMainApplicationRuntime({ core, data, mutation, operations }).registration
const application: C.MainApplicationRuntime = { registration }
declare const library: ReturnType<typeof createLibraryDbConnectionRuntime>
declare const preview: ReturnType<typeof createPreviewDbRuntime>
declare const cache: ReturnType<typeof createCacheArchitectureRuntime>
declare const tasks: ReturnType<typeof createBackgroundTaskRuntime>
const dataResources: C.MainDataResourceLifecycle = {
  closeLibraryDb: library.closeLibraryDb, closePreviewDb: preview.closePreviewDb,
  clearLocalPreviewDbHandle: preview.clearLocalPreviewDbHandle,
  checkpointOpenCacheDbs: cache.checkpointOpenCacheDbs, closeCacheDb: cache.closeCacheDb
}
const operationsResources: C.MainOperationsResourceLifecycle = {
  closeTasksDb: tasks.closeTasksDb, checkpointTasksDb: tasks.checkpointTasksDb
}
declare const complete: C.MainApplicationRegistration
declare const completeGroups: C.MainApplicationRegistrationGroups
createMainRuntimeRegistrationPayload(completeGroups)
`

function compile(source, overrides = new Map()) {
  const host = ts.createCompilerHost(parsed.options)
  // TypeScript normalizes Windows separators before calling the host. Use the
  // same identity for overlays and diagnostic locations, preserving host casing.
  const fileKey = file => host.getCanonicalFileName(file.replace(/\\/g, '/'))
  const sources = new Map([...overrides].map(([file, text]) => [fileKey(file), text]))
  sources.set(fileKey(virtualPath), source)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = file => sources.has(fileKey(file)) ? sources.get(fileKey(file)) : readFile(file)
  host.fileExists = file => sources.has(fileKey(file)) || fileExists(file)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => sources.has(fileKey(file))
    ? ts.createSourceFile(file, sources.get(fileKey(file)), languageVersion, true)
    : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram({
    rootNames: [virtualPath, ...parsed.fileNames.filter(file => file.endsWith('.d.ts'))],
    options: parsed.options, host,
  })
  return { program, errors: ts.getPreEmitDiagnostics(program), fileKey }
}

function diagnosticText(errors) {
  return errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')
}

function assertRequired(properties, label) {
  for (const property of properties) {
    assert.equal(property.flags & ts.SymbolFlags.Optional, 0, `${label}.${property.name} became optional`)
  }
}

function checkOwnership(program) {
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(contractsPath)
  const exports = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(file)).map(symbol => [symbol.name, symbol]))
  const exportedType = name => {
    assert(exports.has(name), `missing contract ${name}`)
    return checker.getDeclaredTypeOfSymbol(exports.get(name))
  }
  const propertyType = (type, name) => {
    const property = type.getProperty(name)
    assert(property, `missing property ${name}`)
    return checker.getTypeOfSymbolAtLocation(property, file)
  }
  const groupType = exportedType('MainApplicationRegistrationGroups')
  assert.deepEqual(groupType.getProperties().map(property => property.name).sort(), Object.keys(groups).sort())
  const groupedKeys = []
  for (const [name, keys] of Object.entries(groups)) {
    const fields = propertyType(groupType, name).getProperties()
    assertRequired(fields, name)
    assert.deepEqual(fields.map(field => field.name).sort(), [...keys].sort(), name + ' group drifted')
    groupedKeys.push(...keys)
  }
  assert.equal(new Set(groupedKeys).size, groupedKeys.length, 'duplicate grouped capability')
  assert.deepEqual(groupedKeys.sort(), [...fixture.mainRegistrationKeys].sort())
  const ownedKeys = []
  const lifecycleKeys = []
  for (const owner of owners) {
    const name = `Main${owner}CompositionRuntime`
    const type = exportedType(name)
    const fields = type.getProperties()
    assertRequired(fields, name)
    const expected = ['capabilities', 'lifecycle', ...(resourceKeys[`Main${owner}ResourceLifecycle`] ? ['resources'] : [])]
    assert.deepEqual(fields.map(field => field.name).sort(), expected.sort(), `${name} output grew`)
    for (const group of ['capabilities', 'lifecycle']) {
      const properties = propertyType(type, group).getProperties()
      assert(properties.length > 0, `${name}.${group} is empty`)
      assertRequired(properties, `${name}.${group}`)
      for (const property of properties) {
        assert(!ownedKeys.includes(property.name), `multiple owners for ${property.name}`)
        ownedKeys.push(property.name)
        if (group === 'lifecycle') lifecycleKeys.push(property.name)
        const value = checker.getTypeOfSymbolAtLocation(property, file)
        const checkValue = (valueType, label) => {
          assert.equal(valueType.flags & ts.TypeFlags.Any, 0, `${label} exposes any`)
          if (valueType.isUnionOrIntersection()) valueType.types.forEach(part => checkValue(part, label))
          if (valueType.flags & ts.TypeFlags.Object && valueType.objectFlags & ts.ObjectFlags.Reference) {
            checker.getTypeArguments(valueType).forEach(part => checkValue(part, label))
          }
        }
        checkValue(value, property.name)
        for (const signature of value.getCallSignatures()) {
          checkValue(signature.getReturnType(), `${property.name} result`)
          signature.getParameters().forEach(parameter => checkValue(checker.getTypeOfSymbolAtLocation(parameter, file), `${property.name} argument`))
        }
      }
    }
  }
  assert.deepEqual(ownedKeys.sort(), [...fixture.mainRegistrationKeys].sort(), 'registration capabilities changed')
  for (const hook of [...fixture.lifecycle.beforeQuitRequiredCalls, ...fixture.lifecycle.willQuitRequiredCalls]) {
    assert(lifecycleKeys.includes(hook), `${hook} lost lifecycle ownership`)
  }
  for (const [name, keys] of Object.entries(resourceKeys)) {
    const properties = exportedType(name).getProperties()
    assertRequired(properties, name)
    assert.deepEqual(properties.map(property => property.name).sort(), [...keys].sort(), `${name} ownership changed`)
    assert(keys.every(key => !ownedKeys.includes(key)), 'private database close leaked into registration')
  }
  assertRequired(exportedType('MainApplicationRuntime').getProperties(), 'application')
  assert.deepEqual(exportedType('MainApplicationRuntime').getProperties().map(property => property.name), ['registration'])
}

function checkOmissions() {
  let source = positive
  const expected = new Map()
  const addFailure = (declaration, expression, name) => {
    source += `${declaration}\n`
    const line = source.split('\n').length - 1
    source += `${expression}\n`
    expected.set(line, name)
  }
  for (const key of fixture.mainRegistrationKeys) {
    const group = groupFor(key)
    addFailure(`declare const missing_${key}: Omit<C.MainApplicationRegistrationGroups['${group}'], '${key}'>`,
      `createMainRuntimeRegistrationPayload({ ...completeGroups, ${group}: missing_${key} })`, key)
  }
  for (const [name, keys] of Object.entries(resourceKeys)) {
    for (const key of keys) {
      addFailure(`declare const missing_${key}: Omit<C.${name}, '${key}'>`,
        `const reject_${key}: C.${name} = missing_${key}`, key)
    }
  }
  addFailure('', 'createMainRuntimeRegistrationPayload({ ...completeGroups, lifecycle: { ...completeGroups.lifecycle, flushActivationInstallStatusSave: () => {} } })', 'Promise<void>')
  addFailure('', 'createMainRuntimeRegistrationPayload({ ...completeGroups, lifecycle: { ...completeGroups.lifecycle, dbQueryWorkerShutdown: "missing" } })', 'void')
  addFailure('', 'const badLabel: C.MainDataResourceLifecycle = { ...dataResources, closeCacheDb: (label: "tasks") => {} }', 'ApplicationCacheDbLabel')
  const { errors, fileKey } = compile(source)
  assert.equal(errors.length, expected.size, diagnosticText(errors))
  for (const error of errors) {
    assert(error.file, diagnosticText([error]))
    assert.equal(fileKey(error.file.fileName), fileKey(virtualPath), diagnosticText([error]))
    const line = error.file.getLineAndCharacterOfPosition(error.start).line
    const key = expected.get(line)
    assert(key, `unexpected compiler error: ${diagnosticText([error])}`)
    assert([2322, 2345, 2741].includes(error.code), `wrong error category ${error.code}`)
    assert(diagnosticText([error]).includes(key), `wrong rejection for ${key}: ${diagnosticText([error])}`)
    expected.delete(line)
  }
  assert.equal(expected.size, 0, 'a negative compiler case was accepted')
  return errors.length
}

function checkRuntimeErasure() {
  const source = fs.readFileSync(contractsPath, 'utf8')
  const file = ts.createSourceFile(contractsPath, source, ts.ScriptTarget.Latest, true)
  function visit(node) {
    assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, 'new composition contract contains explicit any')
    ts.forEachChild(node, visit)
  }
  visit(file)
  const emit = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.trim()
  assert.equal(emit(source), 'export {};', 'contract module introduced runtime work')
  const adapter = fs.readFileSync(adapterPath, 'utf8')
  const exports = {}
  const js = ts.transpileModule(adapter, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(js, { exports }, { timeout: 1000 })
  const flat = Object.freeze(Object.fromEntries(fixture.mainRegistrationKeys.map(key => [key, Object.freeze({ key })])))
  const grouped = Object.freeze(Object.fromEntries(Object.entries(groups).map(([name, keys]) => [name,
    Object.freeze(Object.fromEntries(keys.map(key => [key, flat[key]])))
  ])))
  const payload = exports.createMainRuntimeRegistrationPayload(grouped)
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(flat).sort(), 'adapter changed registered keys')
  for (const key of Object.keys(flat)) assert.equal(payload[key], flat[key], key + ' changed capability identity')
}

function main() {
  const { program, errors } = compile(positive)
  assert.equal(errors.length, 0, diagnosticText(errors))
  checkOwnership(program)
  const rejected = checkOmissions()
  // Prove that the pre-4.1 adapter accepted an omitted optional capability. This
  // control uses the old public type, not a cast or a suppressed compiler error.
  const legacy = `import type { MainProcessRuntimeRegistrationOptions } from '../app/mainProcessRuntimeRegistration'
export function createMainRuntimeRegistrationPayload(options: MainProcessRuntimeRegistrationOptions): MainProcessRuntimeRegistrationOptions { return options }`
  const probe = `
import { createMainRuntimeRegistrationPayload } from '../../../src/main/bootstrap/mainRuntimeRegistrationPayload'
import type { MainApplicationRegistration } from '../../../src/main/bootstrap/mainCompositionContracts'
declare const incomplete: Omit<MainApplicationRegistration, 'moveFontFilesToFolder'>
createMainRuntimeRegistrationPayload(incomplete)
`
  const old = compile(probe, new Map([[adapterPath, legacy]]))
  assert.equal(old.errors.length, 0, diagnosticText(old.errors))
  checkRuntimeErasure()
  console.log(`[diagnostics:main-composition-contracts] 115 unique required capabilities; real database owners compatible; ${rejected} compiler rejections; legacy omission reproduced; runtime unchanged`)
}

try { main() } catch (error) {
  console.error(`[diagnostics:main-composition-contracts] ${error.stack || error}`)
  process.exitCode = 1
}
