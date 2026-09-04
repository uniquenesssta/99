#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
const correctnessCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length) || ''

const validCorrectnessCases = new Set(['POLICY', 'READ', 'PHYSICAL', 'MANAGED'])
if (!correctnessCase || !validCorrectnessCases.has(correctnessCase)) {
  console.error('[diagnostics:font-path-authorization] use exactly one selector: --case=POLICY, --case=READ, --case=PHYSICAL, or --case=MANAGED')
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

function loadPhysicalFolderModule(lockHooks = {}) {
  return loadTypeScriptModule(
    'src/main/folders/physicalFolders.ts',
    (id) => {
      if (id === '../cache/cachePaths') return { isIgnoredInternalDirectoryName: () => false }
      if (id === '../storage/runtime/sharedLeaseLockRuntime') {
        return {
          withSharedLeaseLock: async (options, task) => {
            await lockHooks.beforeSingle?.(options)
            return task()
          },
          withSharedLeaseLocks: async (options, task) => {
            await lockHooks.beforeMany?.(options)
            return task()
          },
        }
      }
      return require(id)
    },
  )
}

function authorizationDenied(message = '文件系统状态已变化，请重试。') {
  return { ok: false, reason: 'outside-authorized-roots', message }
}

async function runPhysicalCorrectness() {
  const boundaryModule = loadTypeScriptModule('src/main/path/pathBoundaryPolicy.ts')
  const authorizationModule = loadTypeScriptModule(
    'src/main/path/fontPathAuthorizationRuntime.ts',
    (id) => (id === './pathBoundaryPolicy' ? boundaryModule : require(id)),
  )
  const observedLockOptions = []
  const physicalModule = loadPhysicalFolderModule({
    beforeSingle: async (options) => { observedLockOptions.push(options) },
    beforeMany: async (options) => { observedLockOptions.push(options) },
  })
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hfm-font-physical-'))
  const watchedRoot = path.join(tempRoot, 'watched')
  const protectedRoot = path.join(tempRoot, 'protected-root')
  const sourceFolder = path.join(watchedRoot, 'source')
  const targetFolder = path.join(watchedRoot, 'target')
  const outsideRoot = path.join(tempRoot, 'outside')
  const outsideTarget = path.join(outsideRoot, 'target')
  const similarTarget = path.join(`${watchedRoot}-copy`, 'target')
  const escapingTarget = path.join(watchedRoot, 'escape-target')
  const indexedRealPaths = new Set()
  const reconciledRoots = []

  try {
    await Promise.all([
      fs.promises.mkdir(sourceFolder, { recursive: true }),
      fs.promises.mkdir(targetFolder, { recursive: true }),
      fs.promises.mkdir(protectedRoot),
      fs.promises.mkdir(outsideTarget, { recursive: true }),
      fs.promises.mkdir(similarTarget, { recursive: true }),
    ])
    await fs.promises.symlink(outsideTarget, escapingTarget, 'dir')

    const sourcePaths = {
      legitimate: path.join(sourceFolder, 'legitimate.ttf'),
      unindexed: path.join(sourceFolder, 'unindexed.otf'),
      outside: path.join(outsideRoot, 'outside.ttc'),
      prefixTarget: path.join(sourceFolder, 'prefix-target.otc'),
      escapeTarget: path.join(sourceFolder, 'escape-target.ttf'),
      lockChanged: path.join(sourceFolder, 'lock-changed.ttf'),
      lockTargetChanged: path.join(sourceFolder, 'lock-target-changed.ttf'),
      postVerify: path.join(sourceFolder, 'post-verify.ttf'),
      batchA: path.join(sourceFolder, 'batch-a.ttf'),
      batchB: path.join(sourceFolder, 'batch-b.otf'),
      nonFont: path.join(sourceFolder, 'notes.txt'),
    }
    await Promise.all(Object.entries(sourcePaths).map(([name, filePath]) =>
      fs.promises.writeFile(filePath, name === 'nonFont' ? 'not-font' : `font-${name}`)
    ))
    for (const [name, filePath] of Object.entries(sourcePaths)) {
      if (name !== 'unindexed' && name !== 'outside' && name !== 'nonFont') {
        indexedRealPaths.add(await fs.promises.realpath(filePath))
      }
    }

    const policy = authorizationModule.createFontPathAuthorizationRuntime({
      fontExtensions,
      readRoots: () => [watchedRoot],
      watchedRoots: () => [watchedRoot, protectedRoot],
      appOwnedRoots: () => [],
      isMainProcessIndexedFont: async ({ realPath }) => indexedRealPaths.has(realPath),
    })
    const deps = {
      ensureWindows: () => undefined,
      resolveExistingFontFilePath: async (rawPath) => rawPath,
      windowsFontsDir: () => path.join(tempRoot, 'system-fonts'),
      appendStartupLog: () => undefined,
      fontExtensions,
      ...policy,
      reconcileWatchedRoot: async (rootPath) => { reconciledRoots.push(rootPath) },
    }
    const actions = physicalModule.createPhysicalFolderActions(deps)

    const outsideCreated = path.join(outsideRoot, 'renderer-created')
    await expectReject('P6', () => actions.createPhysicalFolder(outsideRoot, 'renderer-created'), '授权')
    assert('P6', !fs.existsSync(outsideCreated), 'arbitrary renderer parent caused mkdir outside watched roots')

    const escapedCreated = path.join(outsideTarget, 'escaped-created')
    await expectReject('P6', () => actions.createPhysicalFolder(escapingTarget, 'escaped-created'), '授权')
    assert('P6', !fs.existsSync(escapedCreated), 'root-escaping directory link caused mkdir outside watched roots')

    const escapedRename = await actions.renamePhysicalFolder(escapingTarget, 'escaped-renamed')
    assert('P6', escapedRename.ok === false && fs.lstatSync(escapingTarget).isSymbolicLink(), 'root-escaping directory link was renamed')

    const created = await actions.createPhysicalFolder(watchedRoot, 'created-safe')
    assert('P6', created === path.join(watchedRoot, 'created-safe') && fs.statSync(created).isDirectory(), 'authorized folder create failed')

    const rootRename = await actions.renamePhysicalFolder(protectedRoot, 'renamed-root')
    assert('P6', rootRename.ok === false && fs.statSync(protectedRoot).isDirectory(), 'watched root itself was renamed')

    const renameSource = await actions.createPhysicalFolder(watchedRoot, 'rename-source')
    const renamed = await actions.renamePhysicalFolder(renameSource, 'rename-safe')
    assert('P6', renamed.ok === true && fs.statSync(path.join(watchedRoot, 'rename-safe')).isDirectory(), 'authorized child rename failed')

    let createAuthorizationCalls = 0
    const raceActions = loadPhysicalFolderModule().createPhysicalFolderActions({
      ...deps,
      authorizePhysicalFolderParent: async (rawPath) => {
        createAuthorizationCalls += 1
        if (createAuthorizationCalls === 2) return authorizationDenied()
        return policy.authorizePhysicalFolderParent(rawPath)
      },
    })
    await expectReject('P6', () => raceActions.createPhysicalFolder(watchedRoot, 'lock-race-create'), '重试')
    assert('P6', !fs.existsSync(path.join(watchedRoot, 'lock-race-create')), 'lock-time parent authorization failure still caused mkdir')

    const renameRaceSource = await actions.createPhysicalFolder(watchedRoot, 'lock-race-rename')
    let renameAuthorizationCalls = 0
    const renameRaceActions = loadPhysicalFolderModule().createPhysicalFolderActions({
      ...deps,
      authorizePhysicalFolderRename: async (rawPath) => {
        renameAuthorizationCalls += 1
        if (renameAuthorizationCalls === 2) return authorizationDenied()
        return policy.authorizePhysicalFolderRename(rawPath)
      },
    })
    const renameRace = await renameRaceActions.renamePhysicalFolder(renameRaceSource, 'lock-race-renamed')
    assert('P6', renameRace.ok === false && renameRace.message.includes('重试'), 'lock-time rename replacement did not return retryable failure')
    assert('P6', fs.existsSync(renameRaceSource) && !fs.existsSync(path.join(watchedRoot, 'lock-race-renamed')), 'lock-time rename authorization failure still caused rename')
    assert('P6', reconciledRoots.includes(watchedRoot), 'successful folder mutation did not request watched-root reconciliation')

    const legitimateMove = await actions.moveFontFileToFolder(fontItem('legitimate', sourcePaths.legitimate), targetFolder)
    assert('P7', legitimateMove.ok === true && legitimateMove.newPath && fs.existsSync(legitimateMove.newPath), 'authorized indexed font move failed')

    const unindexedMove = await actions.moveFontFileToFolder(fontItem('unindexed', sourcePaths.unindexed), targetFolder)
    assert('P7', unindexedMove.ok === false && fs.existsSync(sourcePaths.unindexed), 'unindexed watched font caused rename/copy/unlink')

    const outsideMove = await actions.moveFontFileToFolder(fontItem('outside', sourcePaths.outside), targetFolder)
    assert('P7', outsideMove.ok === false && fs.existsSync(sourcePaths.outside), 'outside source caused rename/copy/unlink')

    const prefixMove = await actions.moveFontFileToFolder(fontItem('prefix-target', sourcePaths.prefixTarget), similarTarget)
    assert('P7', prefixMove.ok === false && fs.existsSync(sourcePaths.prefixTarget), 'similar-prefix target caused rename/copy/unlink')

    const escapedMove = await actions.moveFontFileToFolder(fontItem('escape-target', sourcePaths.escapeTarget), escapingTarget)
    assert('P7', escapedMove.ok === false && fs.existsSync(sourcePaths.escapeTarget), 'root-escaping target link caused rename/copy/unlink')

    const nonFontMove = await actions.moveFontFileToFolder(fontItem('non-font', sourcePaths.nonFont), targetFolder)
    assert('P7', nonFontMove.ok === false && fs.existsSync(sourcePaths.nonFont), 'non-font source caused rename/copy/unlink')

    let moveSourceAuthorizationCalls = 0
    const moveRaceActions = loadPhysicalFolderModule().createPhysicalFolderActions({
      ...deps,
      authorizeFontMoveSource: async (rawPath) => {
        moveSourceAuthorizationCalls += 1
        if (moveSourceAuthorizationCalls === 2) return authorizationDenied()
        return policy.authorizeFontMoveSource(rawPath)
      },
    })
    const raceMove = await moveRaceActions.moveFontFileToFolder(fontItem('lock-changed', sourcePaths.lockChanged), targetFolder)
    assert('P7', raceMove.ok === false && raceMove.message.includes('重试'), 'lock-time source replacement did not return retryable failure')
    assert('P7', fs.existsSync(sourcePaths.lockChanged), 'lock-time source authorization failure still caused rename/copy/unlink')

    let moveTargetAuthorizationCalls = 0
    const targetRaceActions = loadPhysicalFolderModule().createPhysicalFolderActions({
      ...deps,
      authorizeFontMoveTarget: async (rawPath) => {
        moveTargetAuthorizationCalls += 1
        if (moveTargetAuthorizationCalls === 2) return authorizationDenied()
        return policy.authorizeFontMoveTarget(rawPath)
      },
    })
    const targetRaceMove = await targetRaceActions.moveFontFileToFolder(fontItem('lock-target-changed', sourcePaths.lockTargetChanged), targetFolder)
    assert('P7', targetRaceMove.ok === false && targetRaceMove.message.includes('重试'), 'lock-time target replacement did not return retryable failure')
    assert('P7', fs.existsSync(sourcePaths.lockTargetChanged), 'lock-time target authorization failure still caused rename/copy/unlink')

    const reconciliationCountBeforePostFailure = reconciledRoots.length
    const postVerifyActions = loadPhysicalFolderModule().createPhysicalFolderActions({
      ...deps,
      authorizeFontMoveDestination: async () => authorizationDenied(),
    })
    const postVerifyMove = await postVerifyActions.moveFontFileToFolder(fontItem('post-verify', sourcePaths.postVerify), targetFolder)
    const postVerifyDestination = path.join(targetFolder, path.basename(sourcePaths.postVerify))
    assert('P7', postVerifyMove.ok === false && postVerifyMove.message.includes('重试'), 'post-move boundary change did not return retryable failure')
    assert('P7', !fs.existsSync(sourcePaths.postVerify) && fs.existsSync(postVerifyDestination), 'post-verification fixture did not commit the expected rename before failing closed')
    assert('P7', reconciledRoots.length > reconciliationCountBeforePostFailure, 'post-verification failure did not trigger authoritative root reconciliation')

    const batchMove = await actions.moveFontFilesToFolder([
      fontItem('batch-a', sourcePaths.batchA),
      fontItem('batch-b', sourcePaths.batchB),
    ], targetFolder)
    assert('P7', batchMove.ok === true && batchMove.movedCount === 2, 'authorized indexed batch move failed')
    assert('P7', reconciledRoots.filter((rootPath) => rootPath === watchedRoot).length >= 3, 'physical moves did not request authoritative root reconciliation')
    assert('P7', observedLockOptions.length >= 5, 'physical mutations did not acquire the expected lease locks')
    assert('P7', observedLockOptions.every((options) => Array.isArray(options.roots) && options.roots.length > 0), 'lease lock storage was not anchored to authoritative watched roots')

    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P6: create/rename use watched-directory authority, forbid root rename, reauthorize under lock, and reconcile authoritative roots')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P7: single/batch moves require indexed watched sources, authorized real targets, lock-time reauthorization, post-verification, and reconciliation')
    console.log('[diagnostics:font-path-authorization] physical correctness passed: cases=2')
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true })
  }
}

async function runManagedUninstallCorrectness() {
  const boundaryModule = loadTypeScriptModule('src/main/path/pathBoundaryPolicy.ts')
  const authorizationModule = loadTypeScriptModule(
    'src/main/path/fontPathAuthorizationRuntime.ts',
    (id) => (id === './pathBoundaryPolicy' ? boundaryModule : require(id)),
  )
  const effects = { registryDeletes: [], registryWrites: [], unlinks: [], broadcasts: 0 }
  const failures = { registryDelete: null, registryWrite: null, unlink: null }
  const installFsStub = {
    promises: {
      access: async () => undefined,
      mkdir: async () => undefined,
      copyFile: async () => undefined,
      unlink: async (filePath) => {
        effects.unlinks.push(filePath)
        if (failures.unlink) throw failures.unlink
      },
    },
  }
  const installModule = loadTypeScriptModule(
    'src/main/install/currentUserManagedInstallRuntime.ts',
    (id) => (id === 'node:fs' ? installFsStub : require(id)),
  )
  const ownershipModule = loadTypeScriptModule('src/main/install/managedFontOwnershipRuntime.ts')
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hfm-font-managed-uninstall-'))
  const currentUserFontsRoot = path.join(tempRoot, 'current-user-fonts')
  const windowsFontsRoot = path.join(tempRoot, 'windows-fonts')
  const outsideRoot = path.join(tempRoot, 'outside')
  const sourceRoot = path.join(tempRoot, 'source')
  const nestedRoot = path.join(currentUserFontsRoot, 'nested')
  const authoritative = {
    ...fontItem('0123456789abcdef-managed', path.join(sourceRoot, 'Authoritative.ttf')),
    family: 'Authoritative Family',
    fullName: 'Authoritative Font',
  }
  const safeManagedFontName = (item) => `HanFontManager_${item.id.slice(0, 12)}_Authoritative.ttf`
  const registryNameFor = (item) => `${item.fullName} (TrueType)`
  const expectedName = safeManagedFontName(authoritative)
  const expectedRegistryName = registryNameFor(authoritative)
  const managedPath = path.join(currentUserFontsRoot, expectedName)
  const outsidePrefixPath = path.join(outsideRoot, expectedName)
  const systemSameNamePath = path.join(windowsFontsRoot, expectedName)
  const nestedManagedPath = path.join(nestedRoot, expectedName)
  const wrongManagedNamePath = path.join(currentUserFontsRoot, 'HanFontManager_unrelated.ttf')

  function resetEffects() {
    effects.registryDeletes.length = 0
    effects.registryWrites.length = 0
    effects.unlinks.length = 0
    effects.broadcasts = 0
    failures.registryDelete = null
    failures.registryWrite = null
    failures.unlink = null
  }

  function assertNoEffects(label) {
    assert('P8', effects.registryDeletes.length === 0, `${label} reached registry delete`)
    assert('P8', effects.registryWrites.length === 0, `${label} reached registry write`)
    assert('P8', effects.unlinks.length === 0, `${label} reached unlink`)
    assert('P8', effects.broadcasts === 0, `${label} reached broadcast`)
  }

  try {
    await Promise.all([
      fs.promises.mkdir(currentUserFontsRoot, { recursive: true }),
      fs.promises.mkdir(windowsFontsRoot, { recursive: true }),
      fs.promises.mkdir(outsideRoot, { recursive: true }),
      fs.promises.mkdir(sourceRoot, { recursive: true }),
      fs.promises.mkdir(nestedRoot, { recursive: true }),
    ])
    await Promise.all([
      fs.promises.writeFile(authoritative.path, 'source-font'),
      fs.promises.writeFile(managedPath, 'managed-font'),
      fs.promises.writeFile(outsidePrefixPath, 'outside-font'),
      fs.promises.writeFile(systemSameNamePath, 'system-font'),
      fs.promises.writeFile(nestedManagedPath, 'nested-font'),
      fs.promises.writeFile(wrongManagedNamePath, 'wrong-managed-font'),
    ])

    const policy = authorizationModule.createFontPathAuthorizationRuntime({
      fontExtensions,
      readRoots: async () => [],
      watchedRoots: async () => [],
      appOwnedRoots: async () => [currentUserFontsRoot],
    })
    const ownershipRuntime = ownershipModule.createManagedFontOwnershipRuntime({
      currentUserFontsDir: () => currentUserFontsRoot,
      safeManagedFontName,
      registryNameFor,
      normalizePathForCompare: (filePath) => path.resolve(filePath),
      findFontItemInRootIndexes: async (_fontId, normalizedPath) => normalizedPath === path.resolve(authoritative.path) ? authoritative : null,
      authorizeManagedFontDelete: (filePath) => policy.authorizeManagedFontDelete(filePath),
    })
    const runtime = installModule.createCurrentUserManagedInstallRuntime({
      ensureWindows: () => undefined,
      currentUserFontsDir: () => currentUserFontsRoot,
      safeManagedFontName,
      registryNameFor,
      authorizeManagedFontRemoval: ownershipRuntime.authorizeManagedFontRemoval,
      writeFontRegistryValuesHKCUBatch: async (values) => {
        effects.registryWrites.push(...values)
        if (failures.registryWrite) throw failures.registryWrite
      },
      deleteFontRegistryValuesHKCUBatch: async (names) => {
        effects.registryDeletes.push(...names)
        if (failures.registryDelete) throw failures.registryDelete
      },
      broadcastFontChange: async () => { effects.broadcasts += 1 },
    })
    const managedItem = {
      ...authoritative,
      managedInstallPath: managedPath,
      managedRegistryName: expectedRegistryName,
    }

    for (const [label, item, messagePart] of [
      ['missing managed identity', authoritative, '不是由本工具安装'],
      ['outside prefix file', { ...managedItem, managedInstallPath: outsidePrefixPath }, '应用自有目录'],
      ['same-named system font', { ...managedItem, managedInstallPath: systemSameNamePath }, '应用自有目录'],
      ['nested prefix file', { ...managedItem, managedInstallPath: nestedManagedPath }, '安装路径不一致'],
      ['wrong managed basename', { ...managedItem, managedInstallPath: wrongManagedNamePath }, '文件名不一致'],
      ['forged registry name', { ...managedItem, managedRegistryName: 'Forged System Font (TrueType)' }, '注册表身份不一致'],
      ['forged renderer font fields', { ...managedItem, fullName: 'Forged System Font', managedRegistryName: 'Forged System Font (TrueType)' }, '注册表身份不一致'],
      ['missing authoritative source', { ...managedItem, id: 'not-indexed' }, '主进程字体索引'],
    ]) {
      resetEffects()
      await expectReject('P8', () => runtime.uninstallManagedFont(item), messagePart)
      assertNoEffects(label)
    }

    resetEffects()
    const success = await runtime.uninstallManagedFont(managedItem)
    assert('P8', success.ok === true, `authorized managed uninstall failed: ${JSON.stringify(success)}`)
    assert('P8', effects.registryDeletes.length === 1 && effects.registryDeletes[0] === expectedRegistryName, 'authorized uninstall deleted the wrong registry identity')
    assert('P8', effects.unlinks.length === 1 && effects.unlinks[0] === managedPath, 'authorized uninstall did not use the authorized real path')
    assert('P8', effects.broadcasts === 1 && effects.registryWrites.length === 0, 'authorized uninstall side effects changed')

    resetEffects()
    failures.registryDelete = new Error('registry locked')
    const registryFailure = await runtime.uninstallManagedFont(managedItem)
    assert('P8', registryFailure.ok === false && registryFailure.message.includes('注册表'), 'registry failure was not returned truthfully')
    assert('P8', effects.registryDeletes.length === 1 && effects.unlinks.length === 0 && effects.broadcasts === 0, 'registry failure did not stop before file removal')

    resetEffects()
    failures.unlink = new Error('file in use')
    const fileFailure = await runtime.uninstallManagedFont(managedItem)
    assert('P8', fileFailure.ok === false && fileFailure.message.includes('文件'), 'file failure was not returned truthfully')
    assert('P8', effects.registryDeletes.length === 1 && effects.unlinks.length === 1, 'file failure did not preserve cleanup stage results')
    assert('P8', effects.registryWrites.length === 1 && effects.registryWrites[0].name === expectedRegistryName && effects.registryWrites[0].path === managedPath, 'file failure did not restore the removed registry identity')
    assert('P8', effects.broadcasts === 1, 'file failure compensation did not broadcast the final registry state')

    resetEffects()
    failures.unlink = new Error('file in use')
    failures.registryWrite = new Error('registry restore failed')
    const partialFailure = await runtime.uninstallManagedFont(managedItem)
    assert('P8', partialFailure.ok === false && partialFailure.message.includes('恢复失败'), 'partial cleanup failure was reported as success')
    assert('P8', effects.registryDeletes.length === 1 && effects.unlinks.length === 1 && effects.registryWrites.length === 1 && effects.broadcasts === 1, 'partial cleanup result did not reflect attempted compensation')

    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P8: managed uninstall requires main-index identity, authorized exact install path/name, and derived registry identity before side effects')
    console.log('[diagnostics:font-path-authorization] CORRECTNESS_LOCK P8.1: registry/file failures return false; file failure restores registry when possible and reports incomplete compensation')
    console.log('[diagnostics:font-path-authorization] managed uninstall correctness passed: cases=12')
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true })
  }
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
    assertResult('P0.5', await policy.authorizeFontMoveDestination(watchedFont), true)
    assertResult('P0.5', await policy.authorizeFontMoveDestination(unindexedWatchedFont), true)
    assertResult('P0.5', await policy.authorizeFontMoveDestination(indexedFont), false, 'outside-authorized-roots')
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

async function main() {
  if (correctnessCase === 'POLICY') {
    await runPolicyCorrectness()
    return
  }
  if (correctnessCase === 'READ') {
    await runReadCorrectness()
    return
  }
  if (correctnessCase === 'PHYSICAL') {
    await runPhysicalCorrectness()
    return
  }
  if (correctnessCase === 'MANAGED') {
    await runManagedUninstallCorrectness()
    return
  }
}

main().catch((error) => {
  console.error(`[diagnostics:font-path-authorization] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
