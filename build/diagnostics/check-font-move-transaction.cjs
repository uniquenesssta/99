#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const { execFileSync,spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..', '..')
const moveRuntimePath = 'src/main/folders/fontMoveTransactionRuntime.ts'
const legacyRuntimePath = 'src/main/folders/physicalFolders.ts'
const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11)
const crashStage = process.argv.find((arg) => arg.startsWith('--crash='))?.slice(8)
const crashRoot = process.argv.find((arg) => arg.startsWith('--fixture='))?.slice(10)
let completedCases = 0

function read(rel) {
  if (baseline && rel === legacyRuntimePath) {
    assert(/^[a-f0-9]{7,40}$/.test(baseline), 'invalid baseline SHA')
    return execFileSync('git', ['show', `${baseline}:${rel}`], { cwd: root, encoding: 'utf8' })
  }
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function loadTypeScriptModule(rel, localRequire) {
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

function errno(code, message) {
  return Object.assign(new Error(message), { code })
}

function comparePath(value) {
  return path.resolve(value).replaceAll('/', '\\').toLowerCase()
}

function directoryAuthorization(requestedPath, rootPath) {
  return {
    ok: true,
    value: {
      requestedPath,
      ioPath: path.resolve(requestedPath),
      realPath: path.resolve(requestedPath),
      realComparePath: comparePath(requestedPath),
      rootPath,
      rootComparePath: comparePath(rootPath),
    },
  }
}

function fileAuthorization(requestedPath, rootPath) {
  return {
    ok: true,
    value: {
      ...directoryAuthorization(requestedPath, rootPath).value,
      size: fs.existsSync(requestedPath) ? fs.statSync(requestedPath).size : 0,
    },
  }
}

async function createScenario(label, faults = {}) {
  const scenarioRoot = crashRoot || await fs.promises.mkdtemp(path.join(os.tmpdir(), `hfm-move-${label}-`))
  const sourceRoot = path.join(scenarioRoot, 'source')
  const targetRoot = path.join(scenarioRoot, 'target')
  const sourcePath = path.join(sourceRoot, 'font.ttf')
  const expectedDestination = path.join(targetRoot, faults.existingTarget ? 'font (1).ttf' : 'font.ttf')
  const events = []
  const reconciledRoots = []
  const interruptAt = (stage) => { if (crashStage === stage) process.exit(91) }

  await Promise.all([
    fs.promises.mkdir(sourceRoot, { recursive: true }),
    fs.promises.mkdir(targetRoot, { recursive: true }),
  ])
  await fs.promises.writeFile(sourcePath, `font-${label}`)
  if (faults.existingTarget) await fs.promises.writeFile(path.join(targetRoot, 'font.ttf'), 'existing-target')
  if (faults.tempCollision) await fs.promises.writeFile(path.join(targetRoot, `.hfm-move-${label}-transaction.tmp`), 'foreign-temp')

  const promises = {
    ...fs.promises,
    async link(from, to) {
      events.push(`link:${path.basename(from)}->${path.basename(to)}`)
      if (faults.unsupported) throw errno('ENOTSUP', 'atomic publication unsupported')
      if (from === sourcePath && !faults.sameVolume) throw errno('EXDEV', 'simulated cross-device move')
      if (faults.targetRename) throw errno('EACCES', 'simulated target commit failure')
      if (faults.race) await fs.promises.writeFile(to, 'external-writer', { flag: 'wx' })
      await fs.promises.link(from, to)
      if (faults.ambiguousCommit) throw errno('EIO', 'NAS acknowledgement lost after commit')
      if (faults.sourceChanged) await fs.promises.writeFile(sourcePath, 'changed-source')
      if (faults.destinationChanged) await fs.promises.writeFile(to, 'changed-target')
      interruptAt('after-commit')
    },
    async rename(from, to) {
      events.push(`rename:${path.basename(from)}->${path.basename(to)}`)
      if (from === sourcePath) throw errno('EXDEV', 'simulated cross-device move')
      if (faults.targetRename) throw errno('EACCES', 'simulated target commit failure')
      return fs.promises.rename(from, to)
    },
    async copyFile(from, to, mode) {
      events.push(`copy:${path.basename(to)}:${mode ?? 'none'}`)
      if (faults.copy || crashStage === 'during-copy') {
        await fs.promises.writeFile(to, 'partial', { flag: 'wx' })
        interruptAt('during-copy')
        throw errno('EIO', 'simulated copy failure')
      }
      await fs.promises.copyFile(from, to, mode)
      interruptAt('after-copy')
    },
    async open(filePath, flags) {
      events.push(`open:${path.basename(filePath)}:${flags}`)
      const handle = await fs.promises.open(filePath, flags)
      return {
        async sync() {
          events.push(`sync:${path.basename(filePath)}`)
          if (faults.sync) throw errno('EIO', 'simulated flush failure')
          await handle.sync()
          interruptAt('after-flush')
        },
        async close() {
          events.push(`close:${path.basename(filePath)}`)
          await handle.close()
          if (faults.close) throw errno('EIO', 'simulated close failure')
        },
      }
    },
    async lstat(filePath) {
      if (faults.sourceUnknown && filePath === sourcePath && fs.existsSync(expectedDestination)) throw errno('EACCES', 'source became inaccessible')
      const stat = await fs.promises.lstat(filePath)
      if (faults.size && filePath !== sourcePath && filePath.endsWith('.tmp')) {
        return Object.assign(stat, { size: stat.size + 1 })
      }
      return stat
    },
    async unlink(filePath) {
      events.push(`unlink:${path.basename(filePath)}`)
      if (filePath.endsWith('.tmp') && faults.cleanup) throw errno('EPERM', 'simulated temp cleanup failure')
      if (faults.unlink && filePath === sourcePath) throw errno('EPERM', 'simulated source unlink failure')
      if (faults.sourceDisappeared && filePath === sourcePath) {
        await fs.promises.unlink(filePath)
        throw errno('ENOENT', 'source disappeared concurrently')
      }
      if (filePath === sourcePath) interruptAt('before-source-unlink')
      await fs.promises.unlink(filePath)
      if (filePath === sourcePath) interruptAt('after-source-unlink')
    },
  }

  const fsStub = { ...fs, promises }
  const runtimeRel = baseline ? legacyRuntimePath : moveRuntimePath
  const fileCommitModule = loadTypeScriptModule('src/main/folders/fontFileMoveCommitRuntime.ts', (id) => id === 'node:fs' ? fsStub : require(id))
  const runtimeModule = loadTypeScriptModule(runtimeRel, (id) => {
    if (id === './fontFileMoveCommitRuntime') return fileCommitModule
    if (id === 'node:fs') return fsStub
    if (id === '../cache/cachePaths') return { isIgnoredInternalDirectoryName: () => false }
    if (id === '../storage/runtime/sharedLeaseLockRuntime') {
      return {
        withSharedLeaseLock: async (_options, task) => task(),
        withSharedLeaseLocks: async (_options, task) => {
          if (faults.lock) throw new Error('shared lease conflict')
          return task()
        },
      }
    }
    return require(id)
  })
  const factory = runtimeModule.createFontMoveTransactionRuntime || runtimeModule.createPhysicalFolderActions
  const runtime = factory({
    ensureWindows: () => undefined,
    resolveExistingFontFilePath: async (rawPath) => rawPath,
    windowsFontsDir: () => path.join(scenarioRoot, 'windows-fonts'),
    isProtectedFontPath: () => false,
    appendStartupLog: () => undefined,
    fontExtensions: new Set(['.ttf', '.otf', '.ttc', '.otc']),
    authorizePhysicalFolderParent: (rawPath) => directoryAuthorization(rawPath, sourceRoot),
    authorizePhysicalFolderRename: (rawPath) => directoryAuthorization(rawPath, sourceRoot),
    authorizeFontMoveSource: (rawPath) => fileAuthorization(rawPath, sourceRoot),
    authorizeFontMoveTarget: (rawPath) => directoryAuthorization(rawPath, targetRoot),
    authorizeFontMoveDestination: (rawPath) => fileAuthorization(rawPath, targetRoot),
    reconcileWatchedRoot: async (rootPath) => { reconciledRoots.push(rootPath) },
    fileCommitRuntime: fileCommitModule.createFontFileMoveCommitRuntime({
      fileSystem: promises,
      createTempId: () => `${label}-transaction`,
      ...(faults.digest ? { digestFile: async (filePath) => filePath === sourcePath ? 'source-digest' : 'different-digest' } : {}),
    }),
  })

  return {
    sourceRoot,
    targetRoot,
    sourcePath,
    expectedDestination,
    events,
    reconciledRoots,
    runtime,
    async cleanup() {
      await fs.promises.rm(scenarioRoot, { recursive: true, force: true })
    },
  }
}

function tempEntries(targetRoot) {
  return fs.readdirSync(targetRoot).filter((name) => name.endsWith('.tmp'))
}

async function runScenario(label, faults, verify) {
  const scenario = await createScenario(label, faults)
  try {
    const item = { id: label, fileName: 'font.ttf', path: scenario.sourcePath, format: 'ttf' }
    const result = await scenario.runtime.moveFontFileToFolder(item, scenario.targetRoot)
    await verify(scenario, result)
    completedCases += 1
  } finally {
    await scenario.cleanup()
  }
}

async function main() {
  if (crashStage) {
    await runScenario('crash', {}, () => { throw new Error('expected abrupt process exit') })
    return
  }
  await runScenario('success', {}, async (scenario, result) => {
    const copyEvent = scenario.events.find((event) => event.startsWith('copy:')) || ''
    assert(copyEvent.includes('.tmp:'), `cross-device copy was published directly: ${copyEvent}`)
    assert(result.ok === true && result.outcome === 'moved', `cross-device success result is incomplete: ${JSON.stringify(result)}`)
    assert(!fs.existsSync(scenario.sourcePath), 'successful move retained the source')
    assert(fs.readFileSync(scenario.expectedDestination, 'utf8') === 'font-success', 'successful move did not publish verified content')
    assert(tempEntries(scenario.targetRoot).length === 0, 'successful move retained a temporary file')
    const syncIndex = scenario.events.findIndex((event) => event.startsWith('sync:'))
    const closeIndex = scenario.events.findIndex((event) => event.startsWith('close:'))
    const commitIndex = scenario.events.findIndex((event) => event.startsWith('link:.hfm-move-'))
    const unlinkIndex = scenario.events.findIndex((event) => event === 'unlink:font.ttf')
    assert(syncIndex >= 0 && closeIndex > syncIndex && commitIndex > closeIndex && unlinkIndex > commitIndex, `copy/flush/close/commit/unlink order is invalid: ${scenario.events.join(', ')}`)
    assert(copyEvent.endsWith(`:${fs.constants.COPYFILE_EXCL}`), 'temporary copy did not request exclusive creation')
  })

  for (const [label, faults, messagePart] of [
    ['copy-failure', { copy: true }, 'copy'],
    ['flush-failure', { sync: true }, 'flush'],
    ['close-failure', { close: true }, 'close'],
    ['size-mismatch', { size: true }, 'size'],
    ['digest-mismatch', { digest: true }, 'digest'],
    ['commit-failure', { targetRename: true }, 'commit'],
    ['unsupported', { unsupported: true }, 'unsupported'],
  ]) {
    await runScenario(label, faults, async (scenario, result) => {
      assert(result.ok === false && result.outcome === 'not-moved', `${messagePart} failure was not reported as not-moved: ${JSON.stringify(result)}`)
      assert(fs.existsSync(scenario.sourcePath), `${messagePart} failure removed the source`)
      assert(!fs.existsSync(scenario.expectedDestination), `${messagePart} failure published the final destination`)
      assert(tempEntries(scenario.targetRoot).length === 0, `${messagePart} failure retained a temporary file`)
      assert(scenario.reconciledRoots.length === 0, `${messagePart} precommit failure scheduled index reconciliation`)
    })
  }

  await runScenario('unlink-failure', { unlink: true }, async (scenario, result) => {
    assert(result.ok === false && result.outcome === 'target-committed-source-retained', `source unlink failure lost partial-success state: ${JSON.stringify(result)}`)
    assert(result.newPath === scenario.expectedDestination, 'partial-success result omitted the committed destination')
    assert(fs.existsSync(scenario.sourcePath) && fs.existsSync(scenario.expectedDestination), 'partial-success recovery pair is incomplete')
    assert(scenario.reconciledRoots.includes(scenario.sourceRoot) && scenario.reconciledRoots.includes(scenario.targetRoot), 'partial success did not reconcile both authoritative roots')
  })

  await runScenario('existing-target', { existingTarget: true }, async (scenario, result) => {
    assert(result.ok === true && result.newPath === scenario.expectedDestination, `existing target did not select a non-overwriting destination: ${JSON.stringify(result)}`)
    assert(fs.readFileSync(path.join(scenario.targetRoot, 'font.ttf'), 'utf8') === 'existing-target', 'existing target was overwritten')
  })

  for (const sameVolume of [false, true]) {
    await runScenario('racing-target', { race: true, sameVolume }, async (scenario, result) => {
      assert(result.ok === false && result.outcome === 'not-moved', 'target race was not safely rejected')
      assert(fs.readFileSync(scenario.expectedDestination, 'utf8') === 'external-writer', 'racing external target was overwritten')
      assert(fs.existsSync(scenario.sourcePath) && tempEntries(scenario.targetRoot).length === 0, 'target race lost source or temp cleanup')
    })
  }
  for (const fault of ['sourceChanged', 'destinationChanged']) {
    await runScenario(fault, { [fault]: true }, async (scenario, result) => {
      assert(!result.ok && result.outcome === 'target-committed-source-retained', 'post-commit content change permitted source deletion')
      assert(fs.existsSync(scenario.sourcePath) && fs.existsSync(scenario.expectedDestination), 'post-commit changed content lost a recovery path')
    })
  }
  await runScenario('cleanup-failure', { copy: true, cleanup: true }, async (scenario, result) => {
    assert(!result.ok && result.outcome === 'not-moved' && result.recoveryPath, 'failed temp cleanup omitted its exact recovery path')
    assert(fs.existsSync(result.recoveryPath) && fs.existsSync(scenario.sourcePath), 'failed cleanup lost recoverable files')
  })
  await runScenario('same-volume', { sameVolume: true }, async (scenario, result) => {
    assert(result.ok && result.outcome === 'moved', 'same-volume move failed')
    assert(!scenario.events.some((event) => event.startsWith('copy:')), 'same-volume move unnecessarily copied content')
  })
  await runScenario('same-volume-unlink-failure', { sameVolume: true, unlink: true }, async (scenario, result) => {
    assert(!result.ok && result.outcome === 'target-committed-source-retained', 'same-volume unlink failure lost partial state')
    assert(fs.existsSync(scenario.sourcePath) && fs.existsSync(scenario.expectedDestination), 'same-volume failure lost recovery pair')
  })
  await runScenario('temp-collision', { tempCollision: true }, async (scenario, result) => {
    const foreign = path.join(scenario.targetRoot, '.hfm-move-temp-collision-transaction.tmp')
    assert(!result.ok && !result.recoveryPath && fs.readFileSync(foreign, 'utf8') === 'foreign-temp', 'exclusive temp collision deleted or claimed somebody else’s file')
  })
  await runScenario('lock-failure', { lock: true }, async (scenario, result) => {
    assert(!result.ok && scenario.events.length === 0, 'lease conflict caused file effects')
    assert(result.message.includes('lease conflict'), 'lease conflict reason was lost')
  })
  for (const fault of ['sourceDisappeared', 'sourceUnknown']) {
    await runScenario(fault, { [fault]: true }, async (scenario, result) => {
      const expected = fault === 'sourceUnknown' ? 'target-committed-source-unknown' : 'target-committed-source-removed'
      assert(!result.ok && result.outcome === expected, `source state was falsely reported: ${JSON.stringify(result)}`)
      assert(fs.existsSync(scenario.expectedDestination), 'source uncertainty lost committed destination')
    })
  }
  await runScenario('ambiguous-commit', { ambiguousCommit: true }, async (scenario, result) => {
    assert(!result.ok && result.outcome === 'commit-uncertain', 'lost NAS acknowledgement fabricated commit status')
    assert(fs.existsSync(scenario.sourcePath) && fs.existsSync(scenario.expectedDestination), 'uncertain commit removed a recovery path')
    assert(scenario.reconciledRoots.length === 2, 'uncertain commit did not schedule reconciliation')
  })

  await runBatchChecks()
  await runCrashChecks()

  console.log(`[diagnostics:font-move-transaction] ok (${completedCases} cases): copy/flush/verify/atomic-publish/unlink ordering and recoverable failure states are locked`)
}

async function runBatchChecks() {
  const scenario = await createScenario('batch', { unlink: true })
  try {
    const secondPath = path.join(scenario.sourceRoot, 'second.otf')
    await fs.promises.writeFile(secondPath, 'second-font')
    const first = { id: 'first', fileName: 'font.ttf', path: scenario.sourcePath }
    const second = { id: 'second', fileName: 'second.otf', path: secondPath }
    const result = await scenario.runtime.moveFontFilesToFolder([first, first, second], scenario.targetRoot)
    assert(!result.ok && result.movedCount === 1 && result.moved.length === 1 && result.failed.length === 1, 'batch partial settlement or ID deduplication failed')
    assert(result.failed[0].result.outcome === 'target-committed-source-retained', 'batch discarded partial result paths/state')
    assert(result.failed[0].result.newPath === scenario.expectedDestination, 'batch partial failure lost destination')
    assert(result.message.includes('源仍保留 1'), 'batch summary hid committed-but-retained files')
    assert(new Set(scenario.reconciledRoots).size === 2 && scenario.reconciledRoots.length === 2, 'batch must reconcile both roots once')
    completedCases += 1
  } finally { await scenario.cleanup() }
}

async function runCrashChecks() {
  for (const stage of ['during-copy', 'after-copy', 'after-flush', 'after-commit', 'before-source-unlink', 'after-source-unlink']) {
    const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hfm-move-crash-'))
    try {
      const child = spawnSync(process.execPath, [__filename, `--crash=${stage}`, `--fixture=${fixture}`], { encoding: 'utf8', timeout: 15000 })
      assert(child.status === 91, `child did not interrupt at ${stage}: ${child.stderr}`)
      const source = path.join(fixture, 'source', 'font.ttf')
      const target = path.join(fixture, 'target', 'font.ttf')
      const precommit = ['during-copy', 'after-copy', 'after-flush'].includes(stage)
      if (precommit) {
        assert(fs.readFileSync(source, 'utf8') === 'font-crash' && !fs.existsSync(target), `${stage} exposed an incomplete font or lost source`)
        assert(tempEntries(path.dirname(target)).length === 1, `${stage} must leave an identifiable non-font temporary file`)
      } else {
        assert(fs.readFileSync(target, 'utf8') === 'font-crash', `${stage} lost the complete committed target`)
        assert(fs.existsSync(source) === (stage !== 'after-source-unlink'), `${stage} violated commit-before-source-removal ordering`)
      }
      completedCases += 1
    } finally { await fs.promises.rm(fixture, { recursive: true, force: true }) }
  }
}

main().catch((error) => {
  console.error(`[diagnostics:font-move-transaction] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
