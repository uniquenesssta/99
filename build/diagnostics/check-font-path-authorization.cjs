#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
const stagedObservation = process.argv.includes('--observe-destructive')
const correctnessCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length) || ''

const validCorrectnessCases = new Set(['POLICY', 'READ'])
if ((stagedObservation ? 1 : 0) + (correctnessCase ? 1 : 0) !== 1 || (correctnessCase && !validCorrectnessCases.has(correctnessCase))) {
  console.error('[diagnostics:font-path-authorization] use exactly one selector: --case=POLICY, --case=READ, or --observe-destructive')
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

async function runReadCorrectness() {
  const boundaryModule = loadTypeScriptModule('src/main/path/pathBoundaryPolicy.ts')
  const authorizationModule = loadTypeScriptModule(
    'src/main/path/fontPathAuthorizationRuntime.ts',
    (id) => (id === './pathBoundaryPolicy' ? boundaryModule : require(id)),
  )
  const protocolReads = []
  const previewReads = []
  const protocolModule = loadTypeScriptModule(
    'src/main/app/fontProtocolRuntime.ts',
    (id) => {
      if (id === 'node:fs') {
        return {
          promises: {
            readFile: async (filePath) => {
              protocolReads.push(filePath)
              return fs.promises.readFile(filePath)
            },
          },
        }
      }
      return require(id)
    },
  )
  let registeredProtocolHandler = null
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
        if (scheme === 'hfm-font') registeredProtocolHandler = handler
      },
    },
  }
  const windowModule = loadTypeScriptModule(
    'src/main/app/windowRuntime.ts',
    (id) => {
      if (id === 'electron') return electronStub
      if (id === './fontProtocolRuntime') return protocolModule
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
  const isolatedPreviewModule = loadTypeScriptModule(
    'src/main/preview/runtime/previewFontDataRuntime.ts',
    (id) => {
      if (id === 'node:fs') {
        return {
          promises: {
            readFile: async (filePath) => {
              previewReads.push(filePath)
              return fs.promises.readFile(filePath)
            },
          },
        }
      }
      if (id === '../../path/ioDeadlineRuntime') return deadlineStub
      return require(id)
    },
  )

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hfm-font-read-'))
  const watchedRoot = path.join(tempRoot, 'watched')
  const windowsFontsRoot = path.join(tempRoot, 'windows-fonts')
  const currentUserFontsRoot = path.join(tempRoot, 'current-user-fonts')
  const indexedRoot = path.join(tempRoot, 'indexed')
  const outsideRoot = path.join(tempRoot, 'outside')
  let authorizationCalls = 0

  try {
    await Promise.all([
      fs.promises.mkdir(watchedRoot),
      fs.promises.mkdir(windowsFontsRoot),
      fs.promises.mkdir(currentUserFontsRoot),
      fs.promises.mkdir(indexedRoot),
      fs.promises.mkdir(outsideRoot),
    ])

    const ordinaryFonts = [
      path.join(watchedRoot, '普通 字体.ttf'),
      path.join(windowsFontsRoot, 'system.otf'),
      path.join(currentUserFontsRoot, 'user.ttc'),
      path.join(currentUserFontsRoot, 'HanFontManager_temporary.otc'),
      path.join(indexedRoot, 'indexed.ttf'),
    ]
    const unsupportedFiles = ['notes.txt', 'library.db', 'signing-key.pem', 'webfont.woff', 'webfont.woff2']
      .map((name) => path.join(watchedRoot, name))
    const directoryNamedFont = path.join(watchedRoot, 'directory.ttf')
    const outsideFont = path.join(outsideRoot, 'outside.otc')
    const escapingAlias = path.join(watchedRoot, 'escape.ttf')
    const oversizedFont = path.join(watchedRoot, 'oversized.ttf')

    await Promise.all([
      ...ordinaryFonts.map((filePath, index) => fs.promises.writeFile(filePath, `font-${index}`)),
      ...unsupportedFiles.map((filePath) => fs.promises.writeFile(filePath, 'not-font-data')),
      fs.promises.mkdir(directoryNamedFont),
      fs.promises.writeFile(outsideFont, 'outside-font-data'),
      fs.promises.writeFile(oversizedFont, Buffer.alloc(1025)),
    ])
    await fs.promises.symlink(outsideFont, escapingAlias)

    const indexedRealPath = await fs.promises.realpath(ordinaryFonts[4])
    const policy = authorizationModule.createFontPathAuthorizationRuntime({
      fontExtensions,
      maxFontReadBytes: 1024,
      readRoots: async () => [watchedRoot, windowsFontsRoot, currentUserFontsRoot],
      watchedRoots: async () => [watchedRoot],
      appOwnedRoots: async () => [currentUserFontsRoot],
      isMainProcessIndexedFont: async ({ realPath }) => realPath === indexedRealPath,
    })
    const authorizeFontRead = async (rawPath) => {
      authorizationCalls += 1
      return policy.authorizeFontRead(rawPath)
    }
    const windowRuntime = windowModule.createWindowRuntime({
      appName: 'HanFontManager',
      appInstallDir: () => root,
      dataPath: (...parts) => path.join(root, ...parts),
      runtimePreloadSource: '',
      loadErrorHtml: () => '',
      authorizeFontRead,
      appendLog: () => undefined,
      verboseRendererLogs: false,
    })
    windowRuntime.registerFontProtocol()
    assert('P1', typeof registeredProtocolHandler === 'function', 'window runtime did not register the secured hfm-font handler')
    const readPreviewFontData = isolatedPreviewModule.createPreviewFontDataRuntime({
      ensureWindows: () => undefined,
      authorizeFontRead,
      withGlobalIo: async (_label, task) => task(),
    })
    const request = (url) => registeredProtocolHandler({ url })

    for (const [index, filePath] of ordinaryFonts.entries()) {
      const url = index === 0
        ? `hfm-font://local/${encodeURIComponent(filePath)}`
        : protocolUrl(filePath)
      const response = await request(url)
      assert('P1', response.status === 200, `${path.basename(filePath)} protocol returned ${response.status}`)
      assert('P1', Buffer.from(await response.arrayBuffer()).toString('utf8') === `font-${index}`, `${path.basename(filePath)} protocol bytes changed`)
      const previewBytes = await readPreviewFontData(fontItem(`ordinary-${index}`, filePath))
      assert('P1', Buffer.from(previewBytes).toString('utf8') === `font-${index}`, `${path.basename(filePath)} preview bytes changed`)
    }
    assert('P1', protocolReads.length === ordinaryFonts.length && previewReads.length === ordinaryFonts.length, 'authorized reads did not use both consumers exactly once')

    for (const filePath of unsupportedFiles) {
      const protocolReadCount = protocolReads.length
      const previewReadCount = previewReads.length
      const response = await request(protocolUrl(filePath))
      assert('P2', response.status === 403 || response.status === 404, `${path.basename(filePath)} protocol leaked status ${response.status}`)
      await expectReject('P2', () => readPreviewFontData(fontItem(`unsupported-${path.basename(filePath)}`, filePath)), '未经授权')
      assert('P2', protocolReads.length === protocolReadCount && previewReads.length === previewReadCount, `${path.basename(filePath)} reached file read`)
    }

    const p3ProtocolReads = protocolReads.length
    const p3PreviewReads = previewReads.length
    const directoryResponse = await request(protocolUrl(directoryNamedFont))
    assert('P3', directoryResponse.status === 404, `font-named directory returned ${directoryResponse.status}`)
    await expectReject('P3', () => readPreviewFontData(fontItem('directory', directoryNamedFont)), '未经授权')
    assert('P3', protocolReads.length === p3ProtocolReads && previewReads.length === p3PreviewReads, 'font-named directory reached file read')

    const p4ProtocolReads = protocolReads.length
    const p4PreviewReads = previewReads.length
    const escapeResponse = await request(protocolUrl(escapingAlias))
    assert('P4', escapeResponse.status === 403 || escapeResponse.status === 404, `root-escaping symlink returned ${escapeResponse.status}`)
    await expectReject('P4', () => readPreviewFontData(fontItem('escape', escapingAlias)), '未经授权')
    assert('P4', protocolReads.length === p4ProtocolReads && previewReads.length === p4PreviewReads, 'root-escaping symlink reached file read')

    const authorizationCallsBeforeMalformed = authorizationCalls
    const protocolReadsBeforeMalformed = protocolReads.length
    const malformedUrls = [
      'hfm-font://local/%E0%A4%A',
      'hfm-font://local/b64/%%%',
      'hfm-font://local/b64/_w',
      `hfm-font://local/${encodeURIComponent(encodeURIComponent(ordinaryFonts[0]))}`,
      `hfm-font://local/${encodeURIComponent(`${ordinaryFonts[0]}\0`)}`,
      `hfm-font://local/${encodeURIComponent(`${ordinaryFonts[0]}\n`)}`,
    ]
    for (const url of malformedUrls) {
      const response = await request(url)
      assert('P5', response.status === 400, `malformed token returned ${response.status}: ${url}`)
    }
    assert('P5', authorizationCalls === authorizationCallsBeforeMalformed, 'malformed token reached central authorization')
    assert('P5', protocolReads.length === protocolReadsBeforeMalformed, 'malformed token reached file read')

    const protocolReadsBeforeLarge = protocolReads.length
    const previewReadsBeforeLarge = previewReads.length
    const oversizedResponse = await request(protocolUrl(oversizedFont))
    assert('P5', oversizedResponse.status === 413, `oversized protocol request returned ${oversizedResponse.status}`)
    await expectReject('P5', () => readPreviewFontData(fontItem('oversized', oversizedFont)), '字体文件过大')
    assert('P5', protocolReads.length === protocolReadsBeforeLarge && previewReads.length === previewReadsBeforeLarge, 'oversized font reached file read')

    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P1: watched, system, current-user, temporary, and main-index fonts remain readable')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P2: unsupported extensions are denied by protocol and preview before readFile')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P3: font-named directories are denied before readFile')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P4: realpath escapes are denied before readFile')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P5: malformed/double/control tokens and oversized files fail closed')
    console.log('[diagnostics:font-path-authorization] read correctness passed: cases=5')
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true })
  }
}

async function createContext() {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hfm-path-auth-'))
  const untrustedRoot = path.join(tempRoot, 'renderer-root')
  const untrustedTarget = path.join(tempRoot, 'renderer-target')
  await Promise.all([
    fs.promises.mkdir(untrustedRoot),
    fs.promises.mkdir(untrustedTarget),
  ])

  const untrustedSource = path.join(tempRoot, 'renderer-source.ttf')
  const nonFontSource = path.join(tempRoot, 'renderer-source.txt')
  await fs.promises.writeFile(untrustedSource, 'move-me')
  await fs.promises.writeFile(nonFontSource, 'do-not-move')

  return {
    tempRoot,
    untrustedRoot,
    untrustedTarget,
    untrustedSource,
    nonFontSource,
  }
}

async function main() {
  if (correctnessCase === 'POLICY') {
    await runPolicyCorrectness()
    return
  }
  if (correctnessCase === 'READ') {
    await runReadCorrectness()
    return
  }

  const context = await createContext()
  const cases = [
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
    console.log(`[diagnostics:font-path-authorization] destructive observations retained: knownDefects=${defects}, behaviorLocks=${locks}, windowsPending=1, cases=${cases.length}`)
  } finally {
    await fs.promises.rm(context.tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[diagnostics:font-path-authorization] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
