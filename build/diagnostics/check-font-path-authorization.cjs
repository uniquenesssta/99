#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
const baselineObserve = process.argv.includes('--baseline-observe')

if (!baselineObserve) {
  console.error('[diagnostics:font-path-authorization] Stage 0 only supports --baseline-observe; Stage 2 must convert this script into a correctness gate')
  process.exit(1)
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function fail(caseId, message) {
  throw new Error(`${caseId}: ${message}`)
}

function assert(caseId, condition, message) {
  if (!condition) fail(caseId, message)
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

async function expectReject(caseId, task, messagePart) {
  let error = null
  try {
    await task()
  } catch (caught) {
    error = caught
  }
  assert(caseId, error instanceof Error, 'expected operation to reject')
  if (messagePart) {
    assert(caseId, error.message.includes(messagePart), `unexpected rejection: ${error.message}`)
  }
  return error
}

const fontExtensions = new Set(['.ttf', '.otf', '.ttc', '.otc'])
const deadlineStub = {
  fileExistsTimeoutMs: () => 1_000,
  withIoDeadlineResult: async (_label, task) => {
    try {
      return { ok: true, value: await task() }
    } catch (error) {
      return { ok: false, error }
    }
  },
}

const resolverModule = loadTypeScriptModule('src/main/windows/runtime/fontPathResolverRuntime.ts')
const previewModule = loadTypeScriptModule(
  'src/main/preview/runtime/previewFontDataRuntime.ts',
  (id) => (id === '../../path/ioDeadlineRuntime' ? deadlineStub : require(id)),
)

function createResolver(watchedRoot) {
  return resolverModule.createFontPathResolverRuntime({
    fontExtensions,
    appendStartupLog: () => undefined,
    windowsFontsDir: () => watchedRoot,
    currentUserFontsDir: () => path.join(watchedRoot, 'current-user-fonts'),
  }).resolveExistingFontFilePath
}

function createPreviewReader(resolveExistingFontFilePath) {
  return previewModule.createPreviewFontDataRuntime({
    ensureWindows: () => undefined,
    resolveExistingFontFilePath,
    withGlobalIo: async (_label, task) => task(),
  })
}

function createProtocolHarness(resolveExistingFontFilePath) {
  let protocolHandler = null
  let resolverCalls = 0
  const electronStub = {
    app: { isPackaged: false, getAppPath: () => root },
    BrowserWindow: class BrowserWindow {
      static getAllWindows() { return [] }
      static fromWebContents() { return null }
    },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    ipcMain: { handle: () => undefined },
    protocol: {
      registerSchemesAsPrivileged: () => undefined,
      handle: (scheme, handler) => {
        if (scheme === 'hfm-font') protocolHandler = handler
      },
    },
  }
  const windowModule = loadTypeScriptModule(
    'src/main/app/windowRuntime.ts',
    (id) => {
      if (id === 'electron') return electronStub
      if (id === './windowRoundedShapeRuntime') {
        return { createWindowRoundedShapeRuntime: () => ({ apply: () => undefined, dispose: () => undefined }) }
      }
      if (id === '../security/appSecurityRuntime') {
        return {
          productionDevToolsEnabled: () => false,
          registerWindowSecurityGuards: () => undefined,
          resolveRendererDevUrl: () => '',
        }
      }
      return require(id)
    },
  )
  const runtime = windowModule.createWindowRuntime({
    appName: 'HanFontManager',
    appInstallDir: () => root,
    dataPath: (...parts) => path.join(root, ...parts),
    runtimePreloadSource: '',
    loadErrorHtml: () => '',
    appendLog: () => undefined,
    verboseRendererLogs: false,
    resolveExistingFontFilePath: async (rawPath) => {
      resolverCalls += 1
      return resolveExistingFontFilePath(rawPath)
    },
  })
  runtime.registerFontProtocol()
  assert('P4', typeof protocolHandler === 'function', 'hfm-font protocol handler was not registered')
  return {
    request: (url) => protocolHandler({ url }),
    resolverCalls: () => resolverCalls,
  }
}

function protocolUrl(filePath) {
  return `hfm-font://local/b64/${Buffer.from(filePath, 'utf8').toString('base64url')}`
}

function fontItem(id, filePath) {
  return {
    id,
    fileName: path.basename(filePath),
    path: filePath,
    format: path.extname(filePath).slice(1),
  }
}

async function caseP1(context) {
  const resolved = await context.resolveExistingFontFilePath('legitimate.ttf')
  assert('P1', resolved === context.legitimateFont, `expected legitimate font path, got ${resolved}`)
  return 'supported ordinary font remains resolvable'
}

async function caseP2(context) {
  const invalidNames = ['notes.txt', 'library.db', 'signing-key.pem', 'webfont.woff', 'webfont.woff2']
  for (const name of invalidNames) {
    const resolved = await context.resolveExistingFontFilePath(name)
    assert('P2', resolved === path.join(context.watchedRoot, name), `known defect changed: ${name} was rejected`)
  }

  const bytes = await context.readPreviewFontData(fontItem('secret-preview', context.secretPemName))
  assert('P2', Buffer.from(bytes).toString('utf8') === context.secretContents, 'known defect changed: preview data no longer reads a non-font file')
  return 'resolver accepts five non-font extensions and preview data returns PEM bytes'
}

async function caseP3() {
  let statCalls = 0
  let readCalls = 0
  const directoryFsStub = {
    promises: {
      stat: async () => {
        statCalls += 1
        return { size: 8, isFile: () => false, isDirectory: () => true }
      },
      readFile: async () => {
        readCalls += 1
        return Buffer.from('directory-bytes')
      },
    },
  }
  const isolatedPreviewModule = loadTypeScriptModule(
    'src/main/preview/runtime/previewFontDataRuntime.ts',
    (id) => {
      if (id === 'node:fs') return directoryFsStub
      if (id === '../../path/ioDeadlineRuntime') return deadlineStub
      return require(id)
    },
  )
  const readPreview = isolatedPreviewModule.createPreviewFontDataRuntime({
    ensureWindows: () => undefined,
    resolveExistingFontFilePath: async () => 'C:/Watched/not-a-file.ttf',
    withGlobalIo: async (_label, task) => task(),
  })
  const bytes = await readPreview(fontItem('directory', 'C:/Watched/not-a-file.ttf'))
  assert('P3', statCalls === 1 && readCalls === 1, 'known defect changed: directory-like stat no longer proceeds to readFile')
  assert('P3', Buffer.from(bytes).toString('utf8') === 'directory-bytes', 'unexpected directory fixture result')
  return 'preview ignores stat.isFile() and proceeds to read a directory-like target'
}

async function caseP4(context) {
  const previewBytes = await context.readPreviewFontData(fontItem('symlink-preview', 'escape.ttf'))
  assert('P4', Buffer.from(previewBytes).toString('utf8') === context.outsideContents, 'known defect changed: preview no longer follows the root-escaping symlink')

  const protocol = createProtocolHarness(context.resolveExistingFontFilePath)
  const response = await protocol.request(protocolUrl('escape.ttf'))
  const protocolBytes = Buffer.from(await response.arrayBuffer()).toString('utf8')
  assert('P4', response.status === 200, `known defect changed: protocol returned ${response.status}`)
  assert('P4', protocolBytes === context.outsideContents, 'known defect changed: protocol no longer reads the root-escaping symlink')
  return 'preview and hfm-font protocol both follow a watched-root symlink to an outside file'
}

async function caseP5(context) {
  const protocol = createProtocolHarness(context.resolveExistingFontFilePath)
  const malformed = await protocol.request('hfm-font://local/%E0%A4%A')
  assert('P5', malformed.status === 400, `malformed URL returned ${malformed.status}`)
  assert('P5', protocol.resolverCalls() === 0, 'malformed URL reached the path resolver')

  let readCalls = 0
  const largeFsStub = {
    promises: {
      stat: async () => ({ size: 81 * 1024 * 1024, isFile: () => true }),
      readFile: async () => {
        readCalls += 1
        return Buffer.alloc(0)
      },
    },
  }
  const isolatedPreviewModule = loadTypeScriptModule(
    'src/main/preview/runtime/previewFontDataRuntime.ts',
    (id) => {
      if (id === 'node:fs') return largeFsStub
      if (id === '../../path/ioDeadlineRuntime') return deadlineStub
      return require(id)
    },
  )
  const readLargePreview = isolatedPreviewModule.createPreviewFontDataRuntime({
    ensureWindows: () => undefined,
    resolveExistingFontFilePath: async () => 'C:/Watched/large.ttf',
    withGlobalIo: async (_label, task) => task(),
  })
  await expectReject('P5', () => readLargePreview(fontItem('large', 'C:/Watched/large.ttf')), '字体文件过大')
  assert('P5', readCalls === 0, 'oversized font reached readFile')
  return 'malformed protocol tokens and preview files over 80MB stop before file reads'
}

function loadPhysicalFolderModule() {
  return loadTypeScriptModule(
    'src/main/folders/physicalFolders.ts',
    (id) => {
      if (id === '../cache/cachePaths') return { isIgnoredInternalDirectoryName: () => false }
      if (id === '../storage/runtime/sharedLeaseLockRuntime') {
        return {
          withSharedLeaseLock: async (_options, task) => task(),
          withSharedLeaseLocks: async (_options, task) => task(),
        }
      }
      return require(id)
    },
  )
}

async function caseP6(context) {
  const physicalModule = loadPhysicalFolderModule()
  const actions = physicalModule.createPhysicalFolderActions({
    ensureWindows: () => undefined,
    resolveExistingFontFilePath: async (rawPath) => rawPath,
    windowsFontsDir: () => path.join(context.tempRoot, 'system-fonts'),
    appendStartupLog: () => undefined,
    fontExtensions,
  })
  const created = await actions.createPhysicalFolder(context.untrustedRoot, 'renderer-created')
  assert('P6', created === path.join(context.untrustedRoot, 'renderer-created'), `unexpected created path: ${created}`)
  assert('P6', fs.statSync(created).isDirectory(), 'known defect changed: raw renderer parent no longer creates a directory')
  return 'raw renderer parent path creates a directory outside every configured font root'
}

async function caseP7(context) {
  const physicalModule = loadPhysicalFolderModule()
  const actions = physicalModule.createPhysicalFolderActions({
    ensureWindows: () => undefined,
    resolveExistingFontFilePath: async (rawPath) => rawPath,
    windowsFontsDir: () => path.join(context.tempRoot, 'system-fonts'),
    appendStartupLog: () => undefined,
    fontExtensions,
  })
  const result = await actions.moveFontFileToFolder(fontItem('renderer-move', context.untrustedSource), context.untrustedTarget)
  const destination = path.join(context.untrustedTarget, path.basename(context.untrustedSource))
  assert('P7', result.ok === true && result.newPath === destination, `known defect changed: arbitrary move failed: ${result.message}`)
  assert('P7', !fs.existsSync(context.untrustedSource) && fs.readFileSync(destination, 'utf8') === 'move-me', 'known defect changed: arbitrary move side effect did not occur')

  const rejected = await actions.moveFontFileToFolder(fontItem('non-font-move', context.nonFontSource), context.untrustedTarget)
  assert('P7', rejected.ok === false, 'non-font source unexpectedly moved')
  assert('P7', fs.existsSync(context.nonFontSource), 'rejected non-font source was changed')
  return 'font-extension source moves across untrusted roots; non-font rejection remains side-effect free'
}

async function caseP8() {
  const effects = { registryDeletes: [], unlinks: [], broadcasts: 0 }
  const installFsStub = {
    promises: {
      access: async () => undefined,
      mkdir: async () => undefined,
      copyFile: async () => undefined,
      unlink: async (filePath) => { effects.unlinks.push(filePath) },
    },
  }
  const installModule = loadTypeScriptModule(
    'src/main/install/currentUserManagedInstallRuntime.ts',
    (id) => (id === 'node:fs' ? installFsStub : require(id)),
  )
  const runtime = installModule.createCurrentUserManagedInstallRuntime({
    appName: 'HanFontManager',
    ensureWindows: () => undefined,
    currentUserFontsDir: () => 'C:/Users/Test/AppData/Local/Microsoft/Windows/Fonts',
    safeManagedFontName: () => 'unused.ttf',
    registryNameFor: () => 'unused',
    writeFontRegistryValuesHKCUBatch: async () => undefined,
    deleteFontRegistryValuesHKCUBatch: async (names) => { effects.registryDeletes.push(...names) },
    broadcastFontChange: async () => { effects.broadcasts += 1 },
  })
  const outsidePath = 'D:/Untrusted/HanFontManager_unrelated.ttf'
  const arbitraryRegistryName = 'Unrelated System Font (TrueType)'
  const result = await runtime.uninstallManagedFont({
    ...fontItem('prefix-only', outsidePath),
    managedInstallPath: outsidePath,
    managedRegistryName: arbitraryRegistryName,
  })
  assert('P8', result.ok === true, 'known defect changed: prefix-only uninstall no longer returns success')
  assert('P8', effects.registryDeletes[0] === arbitraryRegistryName, 'known defect changed: arbitrary registry identity was not deleted')
  assert('P8', effects.unlinks[0] === outsidePath && effects.broadcasts === 1, 'known defect changed: outside file unlink/broadcast did not occur')

  effects.registryDeletes.length = 0
  effects.unlinks.length = 0
  await expectReject('P8', () => runtime.uninstallManagedFont(fontItem('unmanaged', 'D:/Untrusted/ordinary.ttf')), '不是由本工具安装')
  assert('P8', effects.registryDeletes.length === 0 && effects.unlinks.length === 0, 'missing managed metadata rejection caused side effects')
  return 'basename prefix alone authorizes outside unlink and arbitrary registry deletion'
}

async function createContext() {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hfm-path-auth-'))
  const watchedRoot = path.join(tempRoot, 'watched')
  const untrustedRoot = path.join(tempRoot, 'renderer-root')
  const untrustedTarget = path.join(tempRoot, 'renderer-target')
  await Promise.all([
    fs.promises.mkdir(watchedRoot),
    fs.promises.mkdir(untrustedRoot),
    fs.promises.mkdir(untrustedTarget),
  ])

  const legitimateFont = path.join(watchedRoot, 'legitimate.ttf')
  const secretPemName = 'signing-key.pem'
  const secretContents = '-----BEGIN TEST SECRET-----\nnot-a-real-key\n-----END TEST SECRET-----\n'
  const invalidFiles = {
    'notes.txt': 'notes',
    'library.db': 'sqlite-like-bytes',
    [secretPemName]: secretContents,
    'webfont.woff': 'woff-like-bytes',
    'webfont.woff2': 'woff2-like-bytes',
  }
  await fs.promises.writeFile(legitimateFont, 'font-like-bytes')
  await Promise.all(Object.entries(invalidFiles).map(([name, contents]) => fs.promises.writeFile(path.join(watchedRoot, name), contents)))

  const outsideTarget = path.join(tempRoot, 'outside-secret.txt')
  const outsideContents = 'outside-watched-root-secret'
  await fs.promises.writeFile(outsideTarget, outsideContents)
  await fs.promises.symlink(outsideTarget, path.join(watchedRoot, 'escape.ttf'))

  const untrustedSource = path.join(tempRoot, 'renderer-source.ttf')
  const nonFontSource = path.join(tempRoot, 'renderer-source.txt')
  await fs.promises.writeFile(untrustedSource, 'move-me')
  await fs.promises.writeFile(nonFontSource, 'do-not-move')

  const resolveExistingFontFilePath = createResolver(watchedRoot)
  return {
    tempRoot,
    watchedRoot,
    untrustedRoot,
    untrustedTarget,
    untrustedSource,
    nonFontSource,
    legitimateFont,
    secretPemName,
    secretContents,
    outsideContents,
    resolveExistingFontFilePath,
    readPreviewFontData: createPreviewReader(resolveExistingFontFilePath),
  }
}

async function main() {
  const context = await createContext()
  const cases = [
    ['P1', 'BEHAVIOR_LOCK', () => caseP1(context)],
    ['P2', 'KNOWN_DEFECT', () => caseP2(context)],
    ['P3', 'KNOWN_DEFECT', caseP3],
    ['P4', 'KNOWN_DEFECT', () => caseP4(context)],
    ['P5', 'BEHAVIOR_LOCK', () => caseP5(context)],
    ['P6', 'KNOWN_DEFECT', () => caseP6(context)],
    ['P7', 'KNOWN_DEFECT', () => caseP7(context)],
    ['P8', 'KNOWN_DEFECT', caseP8],
  ]
  let defects = 0
  let locks = 0
  try {
    for (const [caseId, kind, run] of cases) {
      const message = await run()
      if (kind === 'KNOWN_DEFECT') defects += 1
      else locks += 1
      console.log(`[diagnostics:font-path-authorization] ${kind} ${caseId}: ${message}`)
    }
    console.log(`[diagnostics:font-path-authorization] WINDOWS_PENDING: drive-letter casing, UNC/device paths, junctions, and Windows separator semantics require a Windows runner`)
    console.log(`[diagnostics:font-path-authorization] baseline observed: knownDefects=${defects}, behaviorLocks=${locks}, windowsPending=1, cases=${cases.length}`)
  } finally {
    await fs.promises.rm(context.tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[diagnostics:font-path-authorization] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
