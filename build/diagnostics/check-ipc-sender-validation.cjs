#!/usr/bin/env node
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const fixture = require('./fixtures/ipc-sender-validation.fixture.json')
const securityPath = 'src/main/security/appSecurityRuntime.ts'
const senderPath = 'src/main/security/ipcSenderValidation.ts'
const windowPath = 'src/main/app/windowRuntime.ts'
const tracePath = 'src/main/ipc/ipcTraceRuntime.ts'
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')

function createLoader({ overrides = new Map(), mocks = {}, globals = {} } = {}) {
  const modules = new Map()
  function load(relativePath) {
    if (modules.has(relativePath)) return modules.get(relativePath)
    const exports = {}
    modules.set(relativePath, exports)
    const source = String(overrides.get(relativePath) ?? read(relativePath))
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText
    const localRequire = (id) => {
      const scoped = `${relativePath}::${id}`
      if (Object.hasOwn(mocks, scoped)) return mocks[scoped]
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id.startsWith('node:')) return require(id)
      if (id.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), id))
        return load(path.posix.extname(resolved) ? resolved : `${resolved}.ts`)
      }
      return require(id)
    }
    const context = vm.createContext({ console, URL, ...globals })
    try {
      vm.runInContext(`(function(require,exports){${output}\n})`, context)(localRequire, exports)
    } catch (error) {
      error.message = `${relativePath}: ${error.message}`
      throw error
    }
    return exports
  }
  return load
}

function createSecurityHarness(securitySource = read(securityPath), packaged = false) {
  const state = {
    packaged,
    appPath: '/opt/han-font-manager/app.asar',
    cwd: '/work/han-font-manager',
    env: {},
    platform: 'linux'
  }
  const electron = {
    app: {
      get isPackaged() { return state.packaged },
      getAppPath: () => state.appPath
    },
    BrowserWindow: function BrowserWindow() {},
    session: { defaultSession: {} }
  }
  const processRuntime = {
    env: state.env,
    cwd: () => state.cwd,
    get platform() { return state.platform }
  }
  const load = createLoader({
    overrides: new Map([[securityPath, securitySource]]),
    mocks: { electron },
    globals: { process: processRuntime }
  })
  return { state, load, security: load(securityPath) }
}

function checkRendererUrlPolicy(securitySource = read(securityPath)) {
  const harness = createSecurityHarness(securitySource)
  const { state, security } = harness
  assert.equal(typeof security.isTrustedRendererUrl, 'function', 'one parsed renderer URL policy must be exported')

  const defaultDevUrls = [
    'http://127.0.0.1:39217/',
    'http://localhost:39217/'
  ]
  const developmentFile = pathToFileURL(path.join(state.cwd, 'out', 'renderer', 'index.html')).href
  for (const url of [...defaultDevUrls, developmentFile, `${defaultDevUrls[0]}#font-list`]) {
    assert.equal(security.isTrustedRendererUrl(url), true, `trusted development renderer rejected: ${url}`)
  }
  for (const url of [
    'http://127.0.0.1:39217/evil',
    'http://127.0.0.1:39217/?debug=1',
    'http://127.0.0.1:39218/',
    'https://127.0.0.1:39217/',
    'http://127.0.0.1.evil:39217/',
    `${developmentFile}.evil`,
    pathToFileURL(path.join(state.cwd, 'out', 'renderer-copy', 'index.html')).href,
    '',
    'not a url'
  ]) assert.equal(security.isTrustedRendererUrl(url), false, `untrusted development renderer accepted: ${url}`)

  state.env.ELECTRON_RENDERER_URL = 'http://localhost:4100/app'
  assert.equal(security.resolveRendererDevUrl(), state.env.ELECTRON_RENDERER_URL)
  assert.equal(security.isTrustedRendererUrl('http://localhost:4100/app#detail'), true, 'configured development entry rejected')
  assert.equal(security.isTrustedRendererUrl('http://localhost:4100/app/child'), false, 'configured development path prefix accepted')
  assert.equal(security.isTrustedRendererUrl('http://localhost:4100/app?debug=1'), false, 'configured development query variant accepted')
  state.env.HFM_FORCE_DIST = '1'
  assert.equal(security.resolveRendererDevUrl(), '', 'forced distribution mode must not resolve a dev server')
  assert.equal(security.isTrustedRendererUrl('http://localhost:4100/app'), false, 'forced distribution mode trusted the configured dev server')
  delete state.env.HFM_FORCE_DIST

  state.packaged = true
  const packagedFile = pathToFileURL(path.join(state.appPath, 'out', 'renderer', 'index.html')).href
  for (const url of [packagedFile, `${packagedFile}#tags`]) {
    assert.equal(security.isTrustedRendererUrl(url), true, `trusted packaged renderer rejected: ${url}`)
  }
  state.platform = 'win32'
  assert.equal(security.isTrustedRendererUrl(packagedFile.replace('/opt/han-font-manager/', '/OPT/HAN-FONT-MANAGER/')), true, 'Windows file URL case compatibility changed')
  state.platform = 'linux'
  for (const url of [
    `${packagedFile}.evil`,
    `${packagedFile}?debug=1`,
    pathToFileURL(path.join(state.appPath, 'out', 'renderer-copy', 'index.html')).href,
    pathToFileURL(path.join(state.appPath, 'out', 'other', 'index.html')).href,
    ...defaultDevUrls
  ]) assert.equal(security.isTrustedRendererUrl(url), false, `untrusted packaged renderer accepted: ${url}`)
}

function checkIpcAssertion() {
  const harness = createSecurityHarness(read(securityPath), true)
  const { state, load } = harness
  const { assertTrustedIpcSender } = load(senderPath)
  const trustedUrl = pathToFileURL(path.join(state.appPath, 'out', 'renderer', 'index.html')).href
  const trustedEvent = {
    senderFrame: { url: trustedUrl },
    sender: { id: 7, getURL: () => 'https://untrusted.invalid/' }
  }
  assert.doesNotThrow(() => assertTrustedIpcSender(trustedEvent, 'library:load'))
  assert.doesNotThrow(() => assertTrustedIpcSender({
    sender: { id: 8, getURL: () => trustedUrl }
  }, 'library:load'), 'top-frame URL fallback rejected the trusted renderer')

  const logs = []
  assert.throws(() => assertTrustedIpcSender({
    senderFrame: { url: `${trustedUrl}.evil` },
    sender: { id: 9, getURL: () => trustedUrl }
  }, 'app-window:close', (message) => logs.push(message)), /Blocked untrusted renderer IPC sender/)
  assert.equal(logs.length, 1, 'untrusted IPC sender must be logged once')
  assert.match(logs[0], /channel=app-window:close, sender=9/)
  assert.match(logs[0], /index\.html\.evil/)
}

function fakeWindow() {
  const handlers = new Map()
  let openHandler = null
  return {
    handlers,
    webContents: {
      setWindowOpenHandler(handler) { openHandler = handler },
      on(event, handler) { handlers.set(event, handler) }
    },
    open(details) { return openHandler?.(details) }
  }
}

function checkWindowGuards(securitySource = read(securityPath)) {
  const development = createSecurityHarness(securitySource, false)
  const devWindow = fakeWindow()
  const devLogs = []
  development.security.registerWindowSecurityGuards(devWindow, (message) => devLogs.push(message))
  assert.equal(devWindow.open({ url: 'https://untrusted.invalid/' })?.action, 'deny', 'new windows must be denied')
  const devNavigate = devWindow.handlers.get('will-navigate')
  assert.equal(typeof devNavigate, 'function', 'development navigation guard is missing')
  let prevented = false
  devNavigate({ preventDefault: () => { prevented = true } }, 'http://127.0.0.1:39217/')
  assert.equal(prevented, false, 'trusted development navigation was blocked')
  devNavigate({ preventDefault: () => { prevented = true } }, 'http://127.0.0.1:39217/evil')
  assert.equal(prevented, true, 'untrusted development navigation was not blocked')
  assert(devLogs.some((message) => message.includes('blocked navigation:')), 'blocked development navigation was not logged')

  const packaged = createSecurityHarness(securitySource, true)
  const packagedWindow = fakeWindow()
  const packagedLogs = []
  packaged.security.registerWindowSecurityGuards(packagedWindow, (message) => packagedLogs.push(message))
  const packagedNavigate = packagedWindow.handlers.get('will-navigate')
  const packagedFile = pathToFileURL(path.join(packaged.state.appPath, 'out', 'renderer', 'index.html')).href
  prevented = false
  packagedNavigate({ preventDefault: () => { prevented = true } }, packagedFile)
  assert.equal(prevented, false, 'trusted packaged navigation was blocked')
  packagedNavigate({ preventDefault: () => { prevented = true } }, `${packagedFile}.evil`)
  assert.equal(prevented, true, 'packaged path-prefix navigation was not blocked')
  assert.equal(typeof packagedWindow.handlers.get('before-input-event'), 'function', 'packaged shortcut guard changed')
  assert(packagedLogs.some((message) => message.includes('blocked packaged navigation:')), 'blocked packaged navigation was not logged')
}

function sourceFile(relativePath, source) {
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function ipcRegistrations(relativePath, source) {
  const file = sourceFile(relativePath, source)
  const registrations = []
  function walk(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(file) === 'ipcMain' &&
        ['handle', 'handleOnce', 'on', 'once'].includes(node.expression.name.text)) {
      const channelNode = node.arguments[0]
      registrations.push({
        method: node.expression.name.text,
        channel: channelNode && ts.isStringLiteral(channelNode) ? channelNode.text : '<dynamic>',
        callback: node.arguments[1],
        file
      })
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return registrations
}

function mainTypeScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return mainTypeScriptFiles(target)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path.relative(root, target).replaceAll(path.sep, '/')] : []
  })
}

function firstStatement(registration) {
  const callback = registration.callback
  assert(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)), `IPC ${registration.channel} needs an inline validation boundary`)
  assert(ts.isBlock(callback.body) && callback.body.statements.length, `IPC ${registration.channel} needs a validation statement`)
  return callback.body.statements[0].getText(registration.file)
}

function checkRegistrationWiring(overrides = new Map()) {
  const registrations = mainTypeScriptFiles(path.join(root, 'src/main')).flatMap((relativePath) => {
    const source = String(overrides.get(relativePath) ?? read(relativePath))
    return ipcRegistrations(relativePath, source).map((registration) => ({ relativePath, ...registration }))
  })
  assert.equal(registrations.length, fixture.windowChannels.length + 1, 'unexpected direct ipcMain registration bypassed the central audit')
  const windowRegistrations = registrations.filter((registration) => registration.relativePath === windowPath)
  assert.deepEqual(windowRegistrations.map((registration) => registration.channel), fixture.windowChannels, 'window IPC channel topology changed')
  for (const registration of windowRegistrations) {
    assert.equal(registration.method, 'handle')
    assert(firstStatement(registration).includes(`assertTrustedIpcSender(event, '${registration.channel}', options.appendLog)`), `${registration.channel} does not validate before side effects`)
  }
  const traced = registrations.filter((registration) => registration.relativePath === tracePath)
  assert.equal(traced.length, 1, 'business IPC must have one traced registration boundary')
  assert.equal(traced[0].channel, '<dynamic>')
  assert(firstStatement(traced[0]).includes('assertTrustedIpcSender(event, channel, append)'), 'business IPC validation is not first')
}

function main() {
  assert.equal(childProcess.execFileSync('git', ['rev-parse', fixture.baseline], { cwd: root, encoding: 'utf8' }).trim(), fixture.baseline, 'AT-7.1 baseline is unavailable')
  const security = read(securityPath)
  const windowRuntime = read(windowPath)
  checkRendererUrlPolicy()
  checkIpcAssertion()
  checkWindowGuards()
  checkRegistrationWiring()

  const pathToken = 'actualPath === expectedPath'
  assert(security.includes(pathToken), 'path mutation target is missing')
  assert.throws(() => checkRendererUrlPolicy(security.replace(pathToken, 'actualPath.startsWith(expectedPath)')), 'path-prefix policy mutation escaped the gate')
  const originToken = 'actual.origin === expected.origin &&\n    actual.host === expected.host'
  assert(security.includes(originToken), 'origin mutation target is missing')
  assert.throws(() => checkRendererUrlPolicy(security.replace(originToken, 'true')), 'origin policy mutation escaped the gate')
  const navigationToken = '    event.preventDefault()\n  })'
  assert(security.includes(navigationToken), 'navigation mutation target is missing')
  assert.throws(() => checkWindowGuards(security.replace(navigationToken, '  })')), 'navigation denial mutation escaped the gate')
  const windowAssertion = "    assertTrustedIpcSender(event, 'app-window:minimize', options.appendLog)\n"
  assert(windowRuntime.includes(windowAssertion), 'window IPC mutation target is missing')
  assert.throws(() => checkRegistrationWiring(new Map([[windowPath, windowRuntime.replace(windowAssertion, '')]])), 'window IPC validation mutation escaped the gate')

  checkRendererUrlPolicy(security.replace(/\n/g, '\r\n'))
  checkWindowGuards(security.replace(/\n/g, '\r\n'))
  checkRegistrationWiring(new Map([
    [securityPath, security.replace(/\n/g, '\r\n')],
    [windowPath, windowRuntime.replace(/\n/g, '\r\n')]
  ]))
  console.log(`[diagnostics:ipc-sender-validation] exact packaged/dev URL identity, trusted IPC fallback, ${fixture.windowChannels.length} window channels, navigation/new-window denial, four mutations and CRLF passed`)
}

try {
  main()
} catch (error) {
  console.error(`[diagnostics:ipc-sender-validation] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
}
