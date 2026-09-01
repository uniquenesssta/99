#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
const fixturePath = path.join(root, 'build/diagnostics/fixtures/orchestration-contracts.fixture.json')
const typeFixturePath = path.join(root, 'build/diagnostics/fixtures/orchestration-contract-types.fixture.ts')
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

function fail(message) {
  throw new Error(message)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function sourceFile(rel, scriptKind = ts.ScriptKind.TS) {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, scriptKind)
}

function nodeName(node) {
  if (!node) return null
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return null
}

function sortedUnique(values) {
  return Array.from(new Set(values)).sort()
}

function assertExactSet(label, actual, expected) {
  const actualSorted = sortedUnique(actual)
  const expectedSorted = sortedUnique(expected)
  const missing = expectedSorted.filter((value) => !actualSorted.includes(value))
  const extra = actualSorted.filter((value) => !expectedSorted.includes(value))
  assert(!missing.length && !extra.length, `${label} changed; missing=[${missing.join(', ')}], extra=[${extra.join(', ')}]`)
}

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, (child) => visit(child, callback))
}

function objectPropertyKeys(objectLiteral) {
  return objectLiteral.properties.map((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text
    return nodeName(property.name)
  }).filter(Boolean)
}

function findCallObjectArgument(file, calleeName) {
  let result = null
  visit(file, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== calleeName) return
    const argument = node.arguments[0]
    if (argument && ts.isObjectLiteralExpression(argument)) result = argument
  })
  return result
}

function collectCallNames(node) {
  const names = []
  visit(node, (child) => {
    if (!ts.isCallExpression(child)) return
    if (ts.isIdentifier(child.expression)) names.push(child.expression.text)
    if (ts.isPropertyAccessExpression(child.expression)) names.push(child.expression.name.text)
  })
  return sortedUnique(names)
}

function findEventCallbacks(file, ownerName) {
  const callbacks = new Map()
  visit(file, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
    const expression = node.expression
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== ownerName || expression.name.text !== 'on') return
    const eventName = node.arguments[0]
    const callback = node.arguments[1]
    if (eventName && ts.isStringLiteral(eventName) && callback) callbacks.set(eventName.text, callback)
  })
  return callbacks
}

function findWhenReadyCallback(file) {
  let result = null
  visit(file, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'then') return
    const whenReadyCall = node.expression.expression
    if (!ts.isCallExpression(whenReadyCall) || !ts.isPropertyAccessExpression(whenReadyCall.expression)) return
    if (!ts.isIdentifier(whenReadyCall.expression.expression) || whenReadyCall.expression.expression.text !== 'app' || whenReadyCall.expression.name.text !== 'whenReady') return
    result = node.arguments[0] || null
  })
  return result
}

function testMainRegistrationContract() {
  const indexFile = sourceFile('src/main/index.ts')
  const payload = findCallObjectArgument(indexFile, 'createMainRuntimeRegistrationPayload')
  assert(payload, 'src/main/index.ts no longer passes a structural object to createMainRuntimeRegistrationPayload')
  assertExactSet('main registration capability keys', objectPropertyKeys(payload), fixture.mainRegistrationKeys)
  console.log(`[diagnostics:orchestration-contracts] main registration keys locked (${fixture.mainRegistrationKeys.length})`)
}

function testLifecycleContract() {
  const lifecycleFile = sourceFile('src/main/app/mainProcessLifecycleRuntime.ts')
  const appCallbacks = findEventCallbacks(lifecycleFile, 'app')
  const processCallbacks = findEventCallbacks(lifecycleFile, 'process')
  const readyCallback = findWhenReadyCallback(lifecycleFile)
  assert(readyCallback, 'app.whenReady().then lifecycle callback is missing')

  assertExactSet('application lifecycle hooks', [...appCallbacks.keys(), 'when-ready'], fixture.lifecycle.appEvents)
  assertExactSet('process failure hooks', [...processCallbacks.keys()], fixture.lifecycle.processEvents)

  const callContracts = [
    ['ready', readyCallback, fixture.lifecycle.readyRequiredCalls],
    ['before-quit', appCallbacks.get('before-quit'), fixture.lifecycle.beforeQuitRequiredCalls],
    ['will-quit', appCallbacks.get('will-quit'), fixture.lifecycle.willQuitRequiredCalls],
  ]
  for (const [label, callback, requiredCalls] of callContracts) {
    assert(callback, `${label} lifecycle callback is missing`)
    const actualCalls = collectCallNames(callback)
    const missing = requiredCalls.filter((name) => !actualCalls.includes(name))
    assert(!missing.length, `${label} lifecycle lost required calls: ${missing.join(', ')}`)
  }
  console.log(`[diagnostics:orchestration-contracts] lifecycle hooks locked (${fixture.lifecycle.appEvents.length} app, ${fixture.lifecycle.processEvents.length} process)`)
}

function listTypeScriptFiles(dir) {
  const result = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...listTypeScriptFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(full)
  }
  return result
}

function collectRustFunctions() {
  const functions = new Map()
  const rustRoot = path.join(root, 'src/main/rust-core')
  for (const fullPath of listTypeScriptFiles(rustRoot)) {
    const relative = path.relative(root, fullPath).replaceAll(path.sep, '/')
    const file = sourceFile(relative)
    visit(file, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text) {
        functions.set(node.name.text, { node, file })
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        functions.set(node.name.text, { node: node.initializer, file })
      }
    })
  }
  return functions
}

function rustFacadeKeys() {
  const file = sourceFile('src/main/rust-core/rustCoreWorkerRuntime.ts')
  let factory = null
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'createRustCoreWorkerRuntime') factory = statement
  }
  assert(factory, 'createRustCoreWorkerRuntime is missing')
  const candidates = []
  visit(factory, (node) => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      candidates.push(node.expression)
    }
  })
  const facade = candidates.sort((left, right) => right.properties.length - left.properties.length)[0]
  assert(facade, 'Rust facade return object is missing')
  return objectPropertyKeys(facade)
}

function collectRustFunctionStrings(functions, name, seen = new Set()) {
  if (seen.has(name)) return []
  seen.add(name)
  const record = functions.get(name)
  assert(record, `Rust command implementation is missing: ${name}`)
  const strings = []
  const delegatedFunctions = []
  visit(record.node, (node) => {
    if (ts.isStringLiteral(node)) strings.push(node.text)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.startsWith('runRust')) {
      delegatedFunctions.push(node.expression.text)
    }
  })
  for (const delegated of sortedUnique(delegatedFunctions)) {
    if (functions.has(delegated)) strings.push(...collectRustFunctionStrings(functions, delegated, seen))
  }
  return strings
}

function testRustStructuralContract() {
  assertExactSet('Rust facade public methods', rustFacadeKeys(), fixture.rustFacadeMethods)
  const functions = collectRustFunctions()
  const knownCapabilities = new Set(fixture.rustCommands.flatMap((entry) => entry.capabilities))
  for (const command of fixture.rustCommands) {
    const strings = collectRustFunctionStrings(functions, command.method)
    const actualFlags = sortedUnique(strings.filter((value) => value.startsWith('--')))
    const actualCapabilities = sortedUnique(strings.filter((value) => knownCapabilities.has(value)))
    assertExactSet(`${command.method} CLI flags`, actualFlags, command.flags)
    assertExactSet(`${command.method} capabilities`, actualCapabilities, command.capabilities)
  }
  console.log(`[diagnostics:orchestration-contracts] Rust facade locked (${fixture.rustFacadeMethods.length} methods, ${fixture.rustCommands.length} command routes)`)
}

function testRustTypeContract() {
  const configPath = path.join(root, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert(!config.error, `cannot read tsconfig: ${config.error ? ts.flattenDiagnosticMessageText(config.error.messageText, '\n') : ''}`)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram({
    rootNames: [typeFixturePath, ...parsed.fileNames.filter((fileName) => fileName.endsWith('.d.ts'))],
    options: { ...parsed.options, noEmit: true },
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) {
    const host = {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }
    fail(`Rust Input/Result assignability contract failed:\n${ts.formatDiagnostics(diagnostics, host)}`)
  }
  console.log('[diagnostics:orchestration-contracts] Rust Input/Result assignability locked')
}

function loadTypeScriptModule(rel, localRequire = require) {
  const output = ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  new Function('exports', 'require', 'module', '__filename', '__dirname', output)(
    module.exports,
    localRequire,
    module,
    path.join(root, rel),
    path.dirname(path.join(root, rel)),
  )
  return module.exports
}

function createRustBehaviorHarness(mode) {
  let schedulerRuns = 0
  const logs = []
  const submittedError = Object.assign(new Error('injected daemon failure after submit'), {
    daemonSubmitted: true,
    command: '--font-activation-files',
  })
  function execFileStub() {
    throw new Error('callback execFile path must not be used by this diagnostic')
  }
  execFileStub[promisify.custom] = async (_workerPath, args) => {
    if (args.includes('--handshake')) {
      return {
        stdout: `${JSON.stringify({ ok: true, version: 'fixture', protocolVersion: 1, capabilities: ['font-activation-files'] })}\n`,
        stderr: '',
      }
    }
    if (args.includes('--core-scheduler-profile')) {
      return { stdout: `${JSON.stringify({ ok: true, schedulerVersion: 'fixture', profiles: [] })}\n`, stderr: '' }
    }
    throw new Error(`unexpected one-shot exec: ${args.join(' ')}`)
  }

  const module = loadTypeScriptModule(
    'src/main/rust-core/rustCoreWorkerRuntime.ts',
    (id) => {
      if (id === 'node:child_process') return { execFile: execFileStub }
      if (id === './rustCoreWorkerAutoBuildRuntime') {
        return { tryBuildRustCoreWorkerForDevelopment: () => ({ attempted: false, built: false, message: 'fixture' }) }
      }
      if (id === './rustCoreProtocolRuntime') {
        return { EXPECTED_RUST_CORE_PROTOCOL_VERSION: 1, rustCoreWorkerIsCompatible: () => ({ ok: true }) }
      }
      if (id === './rustCoreWorkerPathRuntime') {
        return {
          resolveRustCoreWorkerPathWithDiagnostics: () => mode === 'unavailable'
            ? { path: null, candidates: ['fixture-none'] }
            : { path: 'C:/fixture/hfm-core-worker.exe', candidates: [] },
        }
      }
      if (id === './rustCoreSchedulerRuntime') {
        return {
          createRustCoreSchedulerRuntime: () => ({
            applyProfiles: () => 0,
            invalidate: () => 0,
            cancelScopes: () => 0,
            markInteractiveActivity: () => undefined,
            run: async (_args, task) => {
              schedulerRuns += 1
              return task(new AbortController().signal)
            },
          }),
        }
      }
      if (id === './rustCoreDaemonRuntime') {
        return {
          createRustCoreDaemonRuntime: () => ({
            tryRun: async () => {
              if (mode === 'submitted') throw submittedError
              return null
            },
            pollStatus: () => undefined,
            status: () => ({ running: false }),
            stop: () => undefined,
          }),
          isRustCoreDaemonSubmittedError: (error) => Boolean(error?.daemonSubmitted),
        }
      }
      if (id === './rustCoreDaemonWriteBoundaryRuntime') {
        return {
          rethrowRustCoreDaemonSubmittedJob: (error) => {
            if (error?.daemonSubmitted) throw error
          },
        }
      }
      if (id === './rustStateFallbackFailureProtocolRuntime') {
        return { rustStateFallbackFailureLogSuffix: () => 'fixture fallback policy' }
      }
      if (id === './nodeFontkitScanFallbackCompatibilityRuntime') {
        return { nodeFontkitScanFallbackFailureLogSuffix: () => 'fixture fallback policy' }
      }
      return require(id)
    },
  )
  return {
    runtime: module.createRustCoreWorkerRuntime({
      appendStartupLog: (message) => logs.push(message),
      enabled: true,
      required: false,
    }),
    schedulerRuns: () => schedulerRuns,
    submittedError,
    logs,
  }
}

async function testRustFailureBoundary() {
  const unavailable = createRustBehaviorHarness('unavailable')
  const unavailableResult = await unavailable.runtime.runRustFontActivationFiles({ copies: [] })
  assert(unavailableResult === null, 'unavailable Rust capability must return null for Node fallback')
  assert(unavailable.schedulerRuns() === 0, 'unavailable Rust capability reached one-shot scheduler')

  const submitted = createRustBehaviorHarness('submitted')
  const submittedStatus = await submitted.runtime.diagnoseRustCoreWorker()
  assert(submittedStatus.available === true, `submitted fixture worker did not become available: ${JSON.stringify(submittedStatus)}; logs=${submitted.logs.join(' | ')}`)
  let caught = null
  try {
    await submitted.runtime.runRustFontActivationFiles({ copies: [] })
  } catch (error) {
    caught = error
  }
  assert(caught === submitted.submittedError, `daemon failure after submit must be rethrown to block duplicate one-shot work; caught=${caught instanceof Error ? caught.stack || caught.message : String(caught)}`)
  assert(submitted.schedulerRuns() === 0, 'daemon failure after submit incorrectly entered one-shot scheduler fallback')
  console.log('[diagnostics:orchestration-contracts] Rust unavailable/null and submitted/throw boundary locked')
}

function jsxTagNames(file) {
  const names = []
  visit(file, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) names.push(nodeName(node.tagName))
  })
  return sortedUnique(names.filter(Boolean))
}

function allIdentifiers(file) {
  const names = []
  visit(file, (node) => {
    if (ts.isIdentifier(node)) names.push(node.text)
  })
  return new Set(names)
}

function testAppRootViewContract() {
  const rootView = sourceFile('src/renderer/src/components/app/AppRootView.tsx', ts.ScriptKind.TSX)
  const app = sourceFile('src/renderer/src/App.tsx', ts.ScriptKind.TSX)
  let propsType = null
  let destructuredProps = []
  let callerProps = []
  visit(rootView, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'AppRootView') {
      propsType = node.parameters[0]?.type?.kind === ts.SyntaxKind.AnyKeyword ? 'any' : node.parameters[0]?.type?.getText(rootView) || 'missing'
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && ts.isIdentifier(node.initializer) && node.initializer.text === 'props') {
      destructuredProps = node.name.elements.map((element) => nodeName(element.name)).filter(Boolean)
    }
  })
  visit(app, (node) => {
    if (!ts.isJsxSelfClosingElement(node) || nodeName(node.tagName) !== 'AppRootView') return
    callerProps = node.attributes.properties
      .filter(ts.isJsxAttribute)
      .map((attribute) => nodeName(attribute.name))
      .filter(Boolean)
  })

  assert(propsType === fixture.appRootView.currentPropType, `AppRootView current prop type changed from the recorded Stage 0 gap: ${propsType}`)
  assert(destructuredProps.length === fixture.appRootView.currentPropCount, `AppRootView flattened prop count changed: ${destructuredProps.length}`)
  assertExactSet('AppRootView caller/callee prop keys', callerProps, destructuredProps)

  const targetGroupNames = Object.keys(fixture.appRootView.targetGroups)
  assertExactSet('AppRootView target groups', targetGroupNames, ['topbar', 'sidebar', 'content', 'detail', 'overlays', 'developer'])
  const tags = jsxTagNames(rootView)
  const rootIdentifiers = allIdentifiers(rootView)
  for (const [groupName, group] of Object.entries(fixture.appRootView.targetGroups)) {
    if (group.component) assert(tags.includes(group.component), `${groupName} target component is missing: ${group.component}`)
    for (const prop of group.requiredProps) {
      assert(rootIdentifiers.has(prop), `${groupName} target contract lost required prop: ${prop}`)
    }
  }

  const flowIdentifiers = new Set([...allIdentifiers(app), ...rootIdentifiers])
  for (const flow of fixture.appRootView.flows) {
    const missing = flow.identifiers.filter((identifier) => !flowIdentifiers.has(identifier))
    assert(!missing.length, `UI flow ${flow.name} lost identifiers: ${missing.join(', ')}`)
  }
  console.log(`[diagnostics:orchestration-contracts] UI flows locked (${fixture.appRootView.flows.length}); TARGET_GAP AppRootView props:any, flattened=${destructuredProps.length}, targetGroups=${targetGroupNames.join('/')}`)
}

function testPackageRegistration() {
  const pkg = JSON.parse(read('package.json'))
  assert(pkg.scripts?.['diagnostics:orchestration-contracts'] === 'node build/diagnostics/check-orchestration-contracts.cjs', 'orchestration diagnostic package script is missing or changed')
  assert(!pkg.scripts?.['diagnostics:font-activation-transaction'], 'Stage 0 activation baseline observer must not enter diagnostics:all')
  assert(!pkg.scripts?.['diagnostics:font-path-authorization'], 'Stage 0 path baseline observer must not enter diagnostics:all')
}

async function main() {
  assert(fixture.name === 'hfm-orchestration-contracts' && fixture.version === 1, 'unexpected orchestration fixture identity')
  testMainRegistrationContract()
  testLifecycleContract()
  testRustStructuralContract()
  testRustTypeContract()
  await testRustFailureBoundary()
  testAppRootViewContract()
  testPackageRegistration()
  console.log('[diagnostics:orchestration-contracts] ok')
}

main().catch((error) => {
  console.error(`[diagnostics:orchestration-contracts] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
