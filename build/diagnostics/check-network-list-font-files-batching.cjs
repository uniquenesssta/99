#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')

const root = path.resolve(__dirname, '../..')
const scanListingPath = 'src/main/indexing/scan-orchestrator/scanListingRuntime.ts'
const manualListingPath = 'src/main/watcher/manual-refresh/manualFolderRustListingRuntime.ts'
const rustClientPath = 'src/main/rust-core/clients/rustIndexingClientRuntime.ts'
const sharedIoCommandPath = 'src/main/rust-core/rustSharedIoCommandRuntime.ts'
const sharedIoProcessPath = 'src/main/path/sharedIoProcessRuntime.ts'
const sharedFsPath = 'src/main/path/sharedFileSystemRuntime.ts'
const fontPathPolicyPath = 'src/main/path/fontPathPolicy.ts'
const cachePath = 'src/main/path/cachePath.ts'
const ioQueuePath = 'src/main/performance/ioQueue.ts'
const scanUtilsPath = 'src/main/indexing/scan-orchestrator/scanOrchestratorUtils.ts'
const transportPath = 'src/main/rust-core/rustCoreWorkerTransportRuntime.ts'

const abs = (value) => path.join(root, value)
const plain = (value) => JSON.parse(JSON.stringify(value))
const stat = () => ({ size: 123, mtimeMs: 456, birthtimeMs: 400, ctimeMs: 400 })
const sharedRoot = '\\\\NAS\\share\\fonts'
const localRoot = 'C:\\fonts'
const sharedResource = '\\\\nas\\share'

class TestSharedIoProcessError extends Error {
  constructor(message, outcome = 'unknown', reason = 'test') {
    super(message)
    this.sharedIo = true
    this.outcome = outcome
    this.reason = reason
  }
}

function createScanRuntime(resourceKeys) {
  const mocks = {
    [abs(sharedIoCommandPath)]: {
      sharedIoResourceKeys: resourceKeys || (async (paths) =>
        String(paths[0] || '').startsWith('\\\\') ? [sharedResource] : []),
    },
    [abs(sharedIoProcessPath)]: {
      SharedIoProcessError: TestSharedIoProcessError,
      rethrowSharedIoProcessError(error) {
        if (error && error.sharedIo === true) throw error
      },
    },
    [abs(sharedFsPath)]: { sharedFileSystem: {} },
    [abs(fontPathPolicyPath)]: {
      findBestWatchedRootForFile(filePath, folders) {
        const target = String(filePath).toLowerCase()
        return folders.find((folder) => target.startsWith(String(folder).toLowerCase())) || null
      },
    },
    [abs(cachePath)]: {
      normalizePathForCacheCompare(value) {
        return String(value).replaceAll('/', '\\').toLowerCase()
      },
    },
    [abs(ioQueuePath)]: {
      isOperationCancelledError: () => false,
      throwIfAborted(signal) {
        if (signal && signal.aborted) throw new Error('aborted')
      },
    },
    [abs(scanUtilsPath)]: { delayToEventLoop: async () => {} },
  }
  return loader(mocks, {
    process: {
      ...process,
      env: { ...process.env, HFM_RUST_SCAN_LISTING: '1', HFM_SCAN_EARLY_VISIBLE: '1' },
    },
  })(scanListingPath)
}

async function checkMixedRootBatchingAndEarlyVisible() {
  const logs = []
  const rustCalls = []
  const directoryCalls = []
  const visibleRoots = []
  const contexts = new Map()
  const runtime = createScanRuntime()

  const deps = {
    appendStartupLog: (message) => logs.push(message),
    fontExtensions: new Set(['.ttf', '.otf']),
    runRustFontIndexListWorker: async (folders) => {
      rustCalls.push([...folders])
      assert.deepEqual(plain(folders), [sharedRoot], 'shared batch must not include local roots')
      return {
        files: [{ file: sharedRoot + '\\shared.ttf', rootPath: sharedRoot, stat: stat(), signatureValid: true }],
        directories: [{ path: sharedRoot, modifiedMs: 111, fileCount: 1, dirCount: 0 }],
        errors: [],
        foldersScanned: 1,
        truncated: false,
      }
    },
    runFontIndexListWorker: async () => {
      throw new Error('worker walk must not be used in this controlled scenario')
    },
  }
  const ensureRootContext = async (rootPath) => {
    if (!contexts.has(rootPath)) contexts.set(rootPath, { rootPath, directoryUpdates: [] })
    return contexts.get(rootPath)
  }
  const directoryCacheRuntime = {
    listFontFilesWithDirectoryCache: async (context, _errors, _progress, _signal, _startDir, onListedBatch) => {
      directoryCalls.push(context.rootPath)
      const rows = [{ file: context.rootPath + '\\local.ttf', rootPath: context.rootPath, stat: stat(), error: '' }]
      if (onListedBatch) onListedBatch(rows)
      return rows
    },
  }

  const result = await runtime.listScanStatJobs({
    deps,
    directoryCacheRuntime,
    folders: [sharedRoot, localRoot],
    errors: [],
    ensureRootContext,
    reportProgress: () => {},
    onListedBatch: (items) => items.forEach((item) => visibleRoots.push(item.rootPath)),
  })

  assert.deepEqual(plain(rustCalls), [[sharedRoot]])
  assert.deepEqual(plain(directoryCalls), [localRoot])
  assert.deepEqual(result.map((item) => item.rootPath).sort(), [localRoot, sharedRoot].sort())
  assert(visibleRoots.includes(sharedRoot), 'shared Rust batch was not forwarded to existing early-visible consumer')
  assert(visibleRoots.includes(localRoot), 'local early-visible directory stream changed')
  assert(logs.some((line) => line.includes('scan listing network batch source=rust')), 'network batch route missing from diagnostics')
}

async function checkIdentityFailureDoesNotDowngradeToNetworkNodeWalk() {
  const identityError = new TestSharedIoProcessError('identity unavailable', 'not-started', 'identity-unavailable')
  const runtime = createScanRuntime(async () => { throw identityError })
  const deps = {
    appendStartupLog: () => {},
    fontExtensions: new Set(['.ttf']),
    runRustFontIndexListWorker: async () => ({ files: [], directories: [], errors: [], foldersScanned: 0, truncated: false }),
    runFontIndexListWorker: async () => ({ files: [], errors: [] }),
  }
  await assert.rejects(
    runtime.listScanStatJobs({
      deps,
      directoryCacheRuntime: {
        listFontFilesWithDirectoryCache: async () => {
          throw new Error('identity failure must not enter per-directory network fallback')
        },
      },
      folders: [sharedRoot],
      errors: [],
      ensureRootContext: async (rootPath) => ({ rootPath, directoryUpdates: [] }),
      reportProgress: () => {},
      onListedBatch: () => {},
    }),
    (error) => error === identityError,
  )
}

async function checkManualNetworkRefreshUsesRustBatch() {
  let rustCalls = 0
  const runtime = loader({
    [abs(sharedIoProcessPath)]: {
      rethrowSharedIoProcessError(error) {
        if (error && error.sharedIo === true) throw error
      },
    },
  }, {
    process: { ...process, env: { ...process.env, HFM_RUST_MANUAL_REFRESH_LISTING: 'auto' } },
  })(manualListingPath)

  const listing = runtime.createManualFolderRustListingRuntime(
    {
      fontExtensions: new Set(['.ttf']),
      storageProfileForPath: () => ({ isNetwork: true, type: 'network', reason: 'diagnostic' }),
      appendStartupLog: () => {},
      runRustFontIndexListWorker: async (folders) => {
        rustCalls += 1
        assert.deepEqual(plain(folders), [sharedRoot])
        return {
          files: [{ file: sharedRoot + '\\manual.ttf', rootPath: sharedRoot, stat: stat(), signatureValid: true }],
          directories: [{ path: sharedRoot, modifiedMs: 222, fileCount: 1, dirCount: 0 }],
          errors: [],
          foldersScanned: 1,
          truncated: false,
        }
      },
    },
    () => '',
  )

  const result = await listing.tryListManualRefreshWithRust({
    rootPath: sharedRoot,
    targetFolder: sharedRoot,
    context: { rootPath: sharedRoot, directoryUpdates: [] },
    errors: [],
  })
  assert.equal(rustCalls, 1)
  assert.equal(result && result.rows.length, 1)
}

async function checkListCommandIsReadOnlySharedIo() {
  const calls = []
  const mocks = {
    [abs(sharedIoProcessPath)]: {
      rethrowSharedIoProcessError(error) {
        if (error && error.sharedIo === true) throw error
      },
    },
    [abs(transportPath)]: {
      parseJsonLine(value) {
        return JSON.parse(String(value).trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}')
      },
      hasCapability(status, capability) {
        return Array.isArray(status && status.capabilities) && status.capabilities.includes(capability)
      },
    },
    [abs('src/main/rust-core/rustCoreDaemonRuntime.ts')]: { isRustCoreDaemonSubmittedError: () => false },
    [abs('src/main/rust-core/rustCoreDaemonWriteBoundaryRuntime.ts')]: { markRustCoreDaemonSubmittedError: (error) => error },
    [abs('src/main/rust-core/rustStateFallbackFailureProtocolRuntime.ts')]: { rustStateFallbackFailureLogSuffix: () => '' },
    [abs('src/main/rust-core/nodeFontkitScanFallbackCompatibilityRuntime.ts')]: { nodeFontkitScanFallbackFailureLogSuffix: () => '' },
  }
  const runtime = loader(mocks, {
    process: {
      ...process,
      env: {
        ...process.env,
        HFM_RUST_NAME_PROBE: '0',
        HFM_RUST_SCRIPT_PROBE: '0',
        HFM_RUST_STYLE_PROBE: '0',
        HFM_RUST_FAMILY_PROBE: '0',
        HFM_RUST_FULL_HASH: '0',
      },
    },
  })(rustClientPath)
  const client = runtime.createRustIndexingClientRuntime({
    diagnoseRustCoreWorker: async () => ({ available: true, path: 'worker.exe', capabilities: ['list-font-files'] }),
    runRustCoreScheduledCommand: async (_worker, _args, options) => {
      calls.push(options)
      return { stdout: JSON.stringify({ ok: true }), stderr: '' }
    },
    createTemporaryJsonFile: () => ({
      path: 'C:\\Temp\\hfm-rust-list.json',
      readText: async () => JSON.stringify({ ok: true, files: [], directories: [], errors: [], foldersScanned: 1, truncated: false }),
      writeJson: async () => {},
      dispose: async () => {},
    }),
    appendStartupLog: () => {},
  })

  await client.runRustFontIndexListWorker([sharedRoot], ['ttf'])
  assert.equal(calls.length, 1)
  assert.deepEqual(plain(calls[0].sharedIo), { paths: [sharedRoot], write: false })
  const transport = fs.readFileSync(abs(transportPath), 'utf8').replace(/\r\n/g, '\n')
  assert(
    transport.includes("if (!target!.write && !admit()) throw new SharedIoProcessError('共享根状态已变化，旧读取结果已丢弃。','unknown','stale-generation')"),
    'transport read-only generation gate changed',
  )
}

async function main() {
  await checkMixedRootBatchingAndEarlyVisible()
  await checkIdentityFailureDoesNotDowngradeToNetworkNodeWalk()
  await checkManualNetworkRefreshUsesRustBatch()
  await checkListCommandIsReadOnlySharedIo()
  console.log('[diagnostics:network-list-font-files-batching] mixed roots, early-visible, fail-closed identity, manual network refresh and read-only generation routing passed')
}

main().catch((error) => {
  console.error('[diagnostics:network-list-font-files-batching]', error.stack || error)
  process.exitCode = 1
})
