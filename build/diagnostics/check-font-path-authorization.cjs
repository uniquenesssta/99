#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
const baselineObserve = process.argv.includes('--baseline-observe')
const correctnessCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length) || ''

if (baselineObserve === (correctnessCase === 'POLICY')) {
  console.error('[diagnostics:font-path-authorization] use exactly one selector: --baseline-observe or --case=POLICY')
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

function assertResult(caseId, result, expectedOk, expectedReason) {
  assert(caseId, result?.ok === expectedOk, `expected ok=${expectedOk}, got ${JSON.stringify(result)}`)
  if (!expectedOk && expectedReason) {
    assert(caseId, result.reason === expectedReason, `expected reason=${expectedReason}, got ${result.reason}`)
  }
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

async function runPolicyCorrectness() {
  const boundaryModule = loadTypeScriptModule('src/main/path/pathBoundaryPolicy.ts')
  const authorizationModule = loadTypeScriptModule(
    'src/main/path/fontPathAuthorizationRuntime.ts',
    (id) => (id === './pathBoundaryPolicy' ? boundaryModule : require(id)),
  )

  const lexicalCases = [
    { id: 'drive casing', candidate: 'c:\\Fonts\\Family\\A.TTF', root: 'C:\\fonts', expected: true },
    { id: 'drive prefix collision', candidate: 'C:\\Fonts-Backup\\A.ttf', root: 'C:\\Fonts', expected: false },
    { id: 'drive traversal', candidate: 'C:\\Fonts\\..\\Secrets\\A.ttf', root: 'C:\\Fonts', expected: false },
    { id: 'UNC casing', candidate: '\\\\SERVER\\Share\\Fonts\\A.ttf', root: '\\\\server\\share\\fonts', expected: true },
    { id: 'UNC different share', candidate: '\\\\server\\share-copy\\A.ttf', root: '\\\\server\\share', expected: false },
    { id: 'long drive path', candidate: '\\\\?\\C:\\Fonts\\A.ttf', root: 'c:\\fonts', expected: true },
    { id: 'long UNC path', candidate: '\\\\?\\UNC\\Server\\Share\\Fonts\\A.ttf', root: '\\\\server\\share', expected: true },
  ]
  for (const row of lexicalCases) {
    assert('P0.1', boundaryModule.isPathInsideAbsoluteBoundary(row.candidate, row.root) === row.expected, `lexical case failed: ${row.id}`)
  }

  const invalidPaths = [
    ['relative', 'Fonts\\A.ttf'],
    ['drive relative', 'C:A.ttf'],
    ['device namespace', '\\\\.\\PhysicalDrive0'],
    ['unsupported extended namespace', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\A.ttf'],
    ['NUL', 'C:\\Fonts\\A.ttf\0secret'],
    ['control character', 'C:\\Fonts\\A.ttf\n'],
  ]
  for (const [id, candidate] of invalidPaths) {
    assert('P0.1', boundaryModule.canonicalizeAbsolutePath(candidate) === null, `invalid path accepted: ${id}`)
  }

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hfm-path-policy-'))
  const watchedRoot = path.join(tempRoot, 'watched')
  const appOwnedRoot = path.join(tempRoot, 'managed')
  const appOwnedSimilarRoot = `${appOwnedRoot}-copy`
  const indexedRoot = path.join(tempRoot, 'indexed-outside-roots')
  const outsideRoot = path.join(tempRoot, 'outside')
  const similarRoot = `${watchedRoot}-copy`
  const watchedChild = path.join(watchedRoot, 'child')
  const indexedRealPaths = new Set()
  let indexedLookups = 0

  try {
    await Promise.all([
      fs.promises.mkdir(watchedChild, { recursive: true }),
      fs.promises.mkdir(appOwnedRoot),
      fs.promises.mkdir(appOwnedSimilarRoot),
      fs.promises.mkdir(indexedRoot),
      fs.promises.mkdir(outsideRoot),
      fs.promises.mkdir(similarRoot),
    ])

    const watchedFont = path.join(watchedChild, 'legitimate.TTF')
    const unindexedWatchedFont = path.join(watchedChild, 'unindexed.otf')
    const managedFont = path.join(appOwnedRoot, 'HanFontManager_owned.otf')
    const managedPrefixCollision = path.join(appOwnedSimilarRoot, 'HanFontManager_prefix.ttf')
    const indexedFont = path.join(indexedRoot, 'indexed.ttc')
    const outsideFont = path.join(outsideRoot, 'outside.otc')
    const similarFont = path.join(similarRoot, 'prefix.ttf')
    const invalidExtension = path.join(watchedRoot, 'secret.pem')
    const unsupportedWebFont = path.join(watchedRoot, 'webfont.woff2')
    const directoryNamedFont = path.join(watchedRoot, 'directory.ttf')
    const oversizedFont = path.join(watchedRoot, 'oversized.ttf')
    const inRootAlias = path.join(watchedRoot, 'in-root-alias.ttf')
    const escapingAlias = path.join(watchedRoot, 'escape.ttf')
    const disguisedNonFontAlias = path.join(watchedRoot, 'disguised.ttf')
    const escapingDirectory = path.join(watchedRoot, 'escape-dir')

    await Promise.all([
      fs.promises.writeFile(watchedFont, 'font'),
      fs.promises.writeFile(unindexedWatchedFont, 'font'),
      fs.promises.writeFile(managedFont, 'font'),
      fs.promises.writeFile(managedPrefixCollision, 'font'),
      fs.promises.writeFile(indexedFont, 'font'),
      fs.promises.writeFile(outsideFont, 'font'),
      fs.promises.writeFile(similarFont, 'font'),
      fs.promises.writeFile(invalidExtension, 'secret'),
      fs.promises.writeFile(unsupportedWebFont, 'woff'),
      fs.promises.mkdir(directoryNamedFont),
      fs.promises.writeFile(oversizedFont, Buffer.alloc(1025)),
    ])
    await fs.promises.symlink(watchedFont, inRootAlias)
    await fs.promises.symlink(outsideFont, escapingAlias)
    await fs.promises.symlink(invalidExtension, disguisedNonFontAlias)
    await fs.promises.symlink(outsideRoot, escapingDirectory, 'dir')
    indexedRealPaths.add(await fs.promises.realpath(indexedFont))
    indexedRealPaths.add(await fs.promises.realpath(watchedFont))

    const policy = authorizationModule.createFontPathAuthorizationRuntime({
      fontExtensions,
      maxFontReadBytes: 1024,
      readRoots: () => [watchedRoot, appOwnedRoot],
      watchedRoots: () => [watchedRoot],
      appOwnedRoots: () => [appOwnedRoot],
      isMainProcessIndexedFont: async ({ realPath }) => {
        indexedLookups += 1
        return indexedRealPaths.has(realPath)
      },
    })

    for (const [id, candidate, expectedSource] of [
      ['watched root font', watchedFont, 'authorized-root'],
      ['in-root symlink', inRootAlias, 'authorized-root'],
      ['app-owned font', managedFont, 'authorized-root'],
      ['main-process indexed font', indexedFont, 'main-process-index'],
    ]) {
      const result = await policy.authorizeFontRead(candidate)
      assertResult('P0.2', result, true)
      assert('P0.2', result.value.source === expectedSource, `${id} used ${result.value.source}`)
    }

    for (const [id, candidate, reason] of [
      ['non-font extension', invalidExtension, 'unsupported-extension'],
      ['unsupported webfont', unsupportedWebFont, 'unsupported-extension'],
      ['font-named directory', directoryNamedFont, 'not-regular-file'],
      ['oversized font', oversizedFont, 'file-too-large'],
      ['root escaping symlink', escapingAlias, 'outside-authorized-roots'],
      ['font alias to non-font target', disguisedNonFontAlias, 'unsupported-extension'],
      ['similar prefix root', similarFont, 'outside-authorized-roots'],
      ['unindexed outside font', outsideFont, 'outside-authorized-roots'],
      ['renderer authorization claim', { path: outsideFont, authorized: true }, 'invalid-path'],
    ]) {
      const result = await policy.authorizeFontRead(candidate)
      assertResult('P0.3', result, false, reason)
    }

    assert('P0.3', indexedLookups > 0, 'main-process index lookup was not consulted')

    for (const candidate of [watchedRoot, watchedChild]) {
      assertResult('P0.4', await policy.authorizePhysicalFolderParent(candidate), true)
      assertResult('P0.4', await policy.authorizeFontMoveTarget(candidate), true)
    }
    assertResult('P0.4', await policy.authorizePhysicalFolderRename(watchedChild), true)
    assertResult('P0.4', await policy.authorizePhysicalFolderRename(watchedRoot), false, 'root-operation-forbidden')
    assertResult('P0.4', await policy.authorizePhysicalFolderParent(outsideRoot), false, 'outside-authorized-roots')
    assertResult('P0.4', await policy.authorizePhysicalFolderParent(escapingDirectory), false, 'outside-authorized-roots')

    assertResult('P0.5', await policy.authorizeFontMoveSource(watchedFont), true)
    assertResult('P0.5', await policy.authorizeFontMoveSource(unindexedWatchedFont), false, 'not-main-process-indexed')
    assertResult('P0.5', await policy.authorizeFontMoveSource(indexedFont), false, 'outside-authorized-roots')
    assertResult('P0.5', await policy.authorizeManagedFontDelete(managedFont), true)
    assertResult('P0.5', await policy.authorizeManagedFontDelete(managedPrefixCollision), false, 'outside-authorized-roots')

    const failClosedPolicy = authorizationModule.createFontPathAuthorizationRuntime({
      fontExtensions,
      readRoots: () => { throw new Error('root provider unavailable') },
      watchedRoots: () => [],
      appOwnedRoots: () => [],
      isMainProcessIndexedFont: async () => { throw new Error('index unavailable') },
    })
    assertResult('P0.5', await failClosedPolicy.authorizeFontRead(outsideFont), false, 'outside-authorized-roots')

    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P0.1: Windows drive/UNC/long-path boundaries are component-aware and reject device/control paths')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P0.2: authorized roots and main-process index identity admit regular supported fonts')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P0.3: extension, type, size, realpath escape, prefix collision, and renderer claims are rejected')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P0.4: watched-directory operations enforce real roots and operation-specific root rules')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P0.5: move sources and managed deletes use distinct indexed/watched/app-owned authority')
    console.log('[diagnostics:font-path-authorization] policy correctness passed: cases=5')
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true })
  }
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
  if (correctnessCase === 'POLICY') {
    await runPolicyCorrectness()
    return
  }

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
