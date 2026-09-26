#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const abs = p => path.join(root, p)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-directory-'))
const networkRoot = path.join(dir, 'network')
const localRoot = path.join(dir, 'local')
const plain = v => JSON.parse(JSON.stringify(v))
let generation = 1, calls = [], response, signalSeen
const load = loader({
  [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: {
    sharedIoResourceKeys: async paths => paths[0].startsWith(networkRoot) ? ['network'] : [],
    sharedIoAvailabilityRoot: p => p.startsWith(networkRoot) ? networkRoot : '',
  },
  [abs('src/main/path/startupPathAvailabilityRuntime.ts')]: {
    getStartupPathRootState: () => ({ state: 'online', generation }),
    markStartupPathRootUnavailable: () => { throw Error('ordinary failure must not mark root offline') },
  },
})
const shared = load('src/main/path/sharedFileSystemRuntime.ts')
const { SharedIoProcessError } = load('src/main/path/sharedIoProcessRuntime.ts')
const { readSharedDirectoryMetadata } = load('src/main/path/sharedDirectoryMetadataRuntime.ts')
const { createRootDirectoryCacheRuntime } = load('src/main/indexing/scan-orchestrator/rootDirectoryCacheRuntime.ts')
const { createManualFolderIndexEntryRuntime } = load('src/main/watcher/manual-refresh/manualFolderIndexEntryRuntime.ts')
const metadata = (size = 17, mtimeMs = 100) => ({ size, mtimeMs, birthtimeMs: 50 })
const receipt = (count = 4096) => ({ stat: { ...metadata(), isDirectory: true }, entries: Array.from({ length: count }, (_, i) => ({ name: `font-${i}.ttf`, isFile: true, isDirectory: false, isSymbolicLink: false, stat: metadata() })) })
const cacheKey = (_root, file) => path.basename(file)
const signature = (key, size, mtime) => `${key}:${size}:${mtime}`
const context = rootPath => ({ rootPath, cachePath: 'fixture.json', cache: { entries: {} }, seenKeys: new Set(), directoryUpdates: [], directorySkipped: 0 })
const deps = {
  openRootIndexDb: async () => ({ prepare: () => ({ all: () => [{ relative_path: '', modified_at: 100, file_count: 1, dir_count: 0 }] }) }),
  closeSqliteDb() {},
  fontExtensions: new Set(['.ttf']), withGlobalIo: (_label, fn) => fn(), appendStartupLog() {}, cacheEntryRuntimePath: (r, key) => path.join(r, key) }
const directory = createRootDirectoryCacheRuntime(deps)
shared.configureSharedFileExecutor(async (request, _bytes, signal) => {
  calls.push(request); signalSeen = signal
  if (response instanceof Error || response?.sharedIo === true) throw response
  const value = typeof response === 'function' ? await response(request) : response
  return { result: { ok: true, operation: request.operation, value } }
})
async function checkBatchAndCache() {
  calls = []; response = receipt()
  const controller = new AbortController(), ctx = context(networkRoot), errors = []
  const rows = await directory.listFontFilesWithDirectoryCache(ctx, errors, undefined, controller.signal)
  assert.equal(rows.length, 4096); assert.equal(errors.length, 0)
  assert.deepEqual(calls.map(c => c.operation), ['directoryMetadata'])
  assert.equal(signalSeen, controller.signal, 'directory cancellation must reach the isolated executor')
  assert(rows.every(row => row.freshStat === true))
  let contentReads = 0
  const upsert = createManualFolderIndexEntryRuntime({ ...deps, scriptDetectionVersion: 1,
    cacheKeyForRootFile: cacheKey, fileCacheSignature: signature,
    cachedFontForRuntime: font => font, sanitizeCachedFont: font => font,
    hasValidFontSignature: async () => { contentReads++; return false },
  }).upsertFontIndexEntry
  for (const row of rows) ctx.cache.entries[cacheKey('', row.file)] = { status: 'bad', cacheKey: signature(cacheKey('', row.file), 17, 100) }
  for (const row of rows) await upsert(networkRoot, row.file, ctx.cache, row.freshStat ? row.stat : undefined)
  assert.equal(calls.length, 1, 'watcher cache reuse must not add per-file isolated stats')
  assert.equal(contentReads, 0, 'unchanged cached fonts must not reopen contents')
  ctx.cachePath = "fixture.sqlite"
  response = receipt(1); response.entries[0].stat.mtimeMs = 200
  const changed = await directory.listFontFilesWithDirectoryCache(ctx, errors)
  await upsert(networkRoot, changed[0].file, ctx.cache, changed[0].stat)
  assert.equal(contentReads, 1, 'changed file must be parsed even when its parent timestamp is unchanged')
  response = metadata()
  // Historical cached attributes are never passed as fresh; the original stat is retained.
  await upsert(networkRoot, changed[0].file, ctx.cache)
  assert.equal(calls.at(-1).operation, 'stat')
}
async function checkFailures() {
  for (const mutate of [v => { delete v.entries[0].stat }, v => { v.entries[0].name = '../escape.ttf' }, v => { v.entries.push(v.entries[0]) }, v => { v.entries[0].stat.mtimeMs = NaN }]) {
    response = receipt(1); mutate(response)
    await assert.rejects(readSharedDirectoryMetadata(networkRoot), e => e.reason === 'invalid-receipt')
  }
  response = async () => { generation++; return receipt(1) }
  await assert.rejects(readSharedDirectoryMetadata(networkRoot), e => e.reason === 'stale-generation')
  response = new SharedIoProcessError('timeout', 'unknown', 'timeout')
  const ctx = context(networkRoot); ctx.cache.entries.keep = { status: 'ok' }
  await assert.rejects(directory.listFontFilesWithDirectoryCache(ctx, []), e => e.reason === 'timeout')
  assert.deepEqual(Object.keys(ctx.cache.entries), ['keep']); assert.equal(ctx.directoryUpdates.length, 0)
  response = receipt(1)
  const controller = new AbortController(); controller.abort()
  const before = calls.length
  await assert.rejects(directory.listFontFilesWithDirectoryCache(context(networkRoot), [], undefined, controller.signal))
  assert.equal(calls.length, before, 'already cancelled scan must not dispatch I/O')
  const active = new AbortController()
  response = async () => {
    active.abort()
    throw new SharedIoProcessError('cancelled', 'unknown', 'cancelled')
  }
  await assert.rejects(directory.listFontFilesWithDirectoryCache(context(networkRoot), [], undefined, active.signal), e => e.name === 'OperationCancelledError')

}
async function checkLocal() {
  fs.mkdirSync(localRoot); fs.writeFileSync(path.join(localRoot, 'local.ttf'), 'font')
  calls = []
  const rows = await directory.listFontFilesWithDirectoryCache(context(localRoot), [])
  assert.equal(rows.length, 1); assert.equal(rows[0].stat.size, 4); assert.equal(calls.length, 0)
}
async function checkNative() {
  const worker = process.env.HFM_TEST_NATIVE_WORKER
  if (!worker) { console.log('[network-directory-metadata] native executable not supplied; Rust/Windows check must run in CI'); return }
  const handshake = JSON.parse(execFileSync(path.resolve(worker), ['--handshake'], { encoding: 'utf8', timeout: 10000 }))
  assert(handshake.capabilities.includes('shared-directory-metadata-v1'), 'new worker must advertise its required capability')
  fs.mkdirSync(networkRoot)
  for (let i = 0; i < 4096; i++) fs.writeFileSync(path.join(networkRoot, `font-${i}.ttf`), 'not a font')
  const input = path.join(dir, 'input.json')
  const invoke = request => {
    fs.writeFileSync(input, JSON.stringify(request))
    return JSON.parse(execFileSync(path.resolve(worker), ['--shared-file-io', '--input', input], { encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 }))
  }
  calls = []; response = request => { const out = invoke(request); assert(out.ok); return out.value }
  const rows = await directory.listFontFilesWithDirectoryCache(context(networkRoot), [])
  assert.equal(rows.length, 4096); assert.equal(calls.length, 1)
  for (const row of rows) {
    const real = fs.statSync(row.file)
    assert.equal(row.stat.size, real.size)
    assert(Math.abs(row.stat.mtimeMs - real.mtimeMs) < 1)
  }
  assert.equal(invoke({ operation: 'directoryMetadata', path: path.join(networkRoot, 'missing') }).ok, false)
  console.log('[network-directory-metadata] real native executable: 4096 files, one directory request, sizes/times and missing-directory failure passed')
}
async function main() {
  try { await checkBatchAndCache(); await checkFailures(); await checkLocal(); await checkNative() }
  finally { fs.rmSync(dir, { recursive: true, force: true }) }
  console.log('[diagnostics:network-directory-metadata] batch, cache reuse/change, failure, cancellation, generation and local controls passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
