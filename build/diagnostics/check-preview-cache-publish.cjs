#!/usr/bin/env node
/**
 * Regression checks for local-to-shared preview cache publish.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertIncludes(relativePath, needle) {
  const text = readText(relativePath)
  assert(text.includes(needle), `${relativePath} missing ${needle}`)
}

function testPublishRuntimeExistsAndIsLowPriority() {
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'createPreviewCachePublishRuntime')
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'DEFAULT_PUBLISH_DELAY_MS = 7000')
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'DEFAULT_PUBLISH_MAX_IN_FLIGHT = 1')
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'HFM_PREVIEW_PUBLISH_DELAY_MS')
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'enqueuePreviewCachePublish')
}

function testPublishUsesLockTmpAndSharedIndex() {
  const text = readText('src/main/preview/runtime/previewCachePublishRuntime.ts')
  assert(text.includes('preview-cache-publish-mkdir'), 'publish runtime must create shared directory before acquiring lock')
  assert(text.includes('.publish.lock'), 'publish runtime missing per-preview lock')
  assert(text.includes('.tmp.'), 'publish runtime missing temporary file write')
  assert(text.includes('await lock.rename(tmpPath, sharedOutputPath)'), 'publish runtime does not finalize via rename')
  assert(text.includes('published-from-local-preview-cache'), 'publish runtime does not mark shared index source')
  assert(text.includes('preview cache publish summary'), 'publish runtime missing publish summary log')
}

function testRenderPathPublishesAfterLocalWrite() {
  const text = readText('src/main/preview/previewRuntime.ts')
  assert(text.includes('createPreviewCachePublishRuntime'), 'preview runtime missing publish runtime')
  assert(text.includes('previewCachePublishRuntime.enqueuePreviewCachePublish(previewCache'), 'render path does not enqueue shared publish after local render')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-publish'] === 'node build/diagnostics/check-preview-cache-publish.cjs', 'missing diagnostics:preview-cache-publish script')
}

const tests = [
  testPublishRuntimeExistsAndIsLowPriority,
  testPublishUsesLockTmpAndSharedIndex,
  testRenderPathPublishesAfterLocalWrite,
  testPackageScriptAndVersion,
]

async function testOwnedPublicationCoalescesAndReusesExactBytes() {
  const check = require('node:assert/strict'), os = require('node:os')
  const { loader } = require('./check-operation-chain.cjs'), png = require('./fixtures/preview-png.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-publish-'))
  const sharedDir = path.join(dir, 'shared'), localPath = path.join(dir, 'local.png'), output = path.join(sharedDir, 'one.png')
  fs.writeFileSync(localPath, png)
  let networkPngReads = 0, startMeta = false, releaseMeta, writes = 0, closing = false, closeListener
  const metaGate = new Promise(resolve => { releaseMeta = resolve }), timers = new Map(), logs = []
  const fsp = { ...fs.promises, readFile: async (...args) => { if (String(args[0]).startsWith(sharedDir) && String(args[0]).endsWith('.png')) networkPngReads++; return fs.promises.readFile(...args) } }
  const load = loader({
    '../../path/sharedFileSystemRuntime': { sharedFileSystem: fsp },
    '../native-renderer/directwrite/directWritePreviewHelperPathRuntime': { hasDirectWritePreviewHelper: () => false },
    '../../rust-core/rustSharedIoCommandRuntime': { sharedIoResourceKeys: async () => [] },
    '../../path/startupPathAvailabilityRuntime': { getStartupPathRootState: () => ({ generation: 1, state: 'online' }) },
    '../../app/shutdownCoordinatorRuntime': { isApplicationClosing: () => closing, applicationWorkEpoch: () => 1, onApplicationClosing: fn => { closeListener = fn } },
  }, { setTimeout: fn => { const id = {}; timers.set(id, fn); return id }, clearTimeout: id => timers.delete(id) })
  const meta = load('src/main/preview/runtime/previewCacheMetaRuntime.ts').createPreviewCacheMetaRuntime({ appendStartupLog: line => logs.push(line) })
  const shared = { storage: 'root', rootPath: sharedDir, dir: sharedDir }
  const runtime = load('src/main/preview/runtime/previewCachePublishRuntime.ts').createPreviewCachePublishRuntime({
    appendStartupLog: line => logs.push(line), previewCacheStorageToShared: () => shared, ensureSharedAvailable: async () => true,
    withIoDeadlineResult: async (_label, operation) => { try { return {ok:true,value:await operation()} } catch(error) { return {ok:false,error} } },
    writePreviewCacheIndex: async () => { writes++ },
    writeSharedPreviewCacheMeta: async (...args) => { startMeta = true; await metaGate; return meta.writePreviewCacheMeta(...args) },
    validateSharedPreviewCacheMeta: meta.validatePreviewCacheMeta,
  })
  const local = { storage: 'local' }, row = { previewKey: 'one', localOutputPath: localPath, fontSignature: 'file', textHash: 'text', fontSize: 36, width: 300, height: 100 }
  const pump = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } }
  const waitFor = async condition => { for (let i=0; i<200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); check(condition(), 'publication did not complete') }
  try {
    runtime.enqueuePreviewCachePublish(local, row); runtime.enqueuePreviewCachePublish(local, row); pump()
    await waitFor(() => startMeta)
    runtime.enqueuePreviewCachePublish(local, row)
    fs.writeFileSync(localPath, 'changed after image publication')
    releaseMeta(); await waitFor(() => writes === 1)
    check(fs.readFileSync(output).equals(png)); check.equal(networkPngReads, 0, 'new publication reread the shared PNG for checksums')
    const payload = JSON.parse(fs.readFileSync(output + '.meta.json', 'utf8'))
    check.equal(payload.size, png.length); check.equal(payload.checksum, require('node:crypto').createHash('sha1').update(png).digest('hex'))
    await new Promise(resolve => setTimeout(resolve, 20)); pump()
    check.equal(writes, 1); check.equal(timers.size, 0, 'same-key publication was queued while active')
    runtime.logStats(true); check(logs.some(line => line.includes('coalesced=2')))
    runtime.enqueuePreviewCachePublish(local, {...row, previewKey: 'invalid'}); pump()
    await waitFor(() => logs.some(line => line.includes('invalid local PNG')))
    check.equal(writes, 1); check(!fs.existsSync(path.join(sharedDir, 'invalid.png')), 'corrupt local bytes were published')
    await new Promise(resolve => setTimeout(resolve, 20))
    check(!fs.readdirSync(sharedDir).some(name => name.includes('.lock') || name.includes('.tmp.')), 'publication left temporary files or a lock')
  } finally { closing = true; closeListener(); fs.rmSync(dir, { recursive: true, force: true }) }
}

async function testRootManifestReusesOnlyMatchingMetadata() {
  const check = require('node:assert/strict'), os = require('node:os'), { loader } = require('./check-operation-chain.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-manifest-')), writes = []
  const load = loader({
    '../../path/sharedFileSystemRuntime': { sharedFileSystem: fs.promises },
    '../jsonAtomic': { writeJsonAtomic: async (file, data) => { writes.push(file); fs.writeFileSync(file, JSON.stringify(data)) } },
  })
  const runtime = load('src/main/cache/scan-storage/rootPreviewManifestRuntime.ts').createRootPreviewManifestRuntime({
    appName:'HFM',previewSqliteSchemaVersion:1,sha1:x=>x,appendStartupLog(){},exists:async file=>fs.existsSync(file),
  })
  const write = () => runtime.writeRootPreviewCacheManifest(dir, 'C:\\fonts', 'root', path.join(dir,'database','preview.sqlite'), path.join(dir,'images'))
  try {
    await write(); check.equal(writes.length, 2)
    await write(); check.equal(writes.length, 2, 'identical root manifest was rewritten')
    fs.unlinkSync(path.join(dir,'identity.json')); await write(); check.equal(writes.length, 3, 'deleted identity was not recreated')
    fs.writeFileSync(path.join(dir,'manifest.json'), '{invalid'); await write(); check.equal(writes.length, 4, 'corrupt manifest stayed cached')
    const manifest = JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));manifest.schemaVersion=0;fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest))
    await write(); check.equal(writes.length, 5, 'outdated manifest schema stayed cached')
    fs.unlinkSync(path.join(dir,'manifest.json')); await write(); check.equal(writes.length, 6, 'deleted manifest was not recreated')
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
}

async function main() {
  for (const test of tests) test()
  await testOwnedPublicationCoalescesAndReusesExactBytes()
  await testRootManifestReusesOnlyMatchingMetadata()
  console.log(`preview cache publish checks passed (${tests.length} structural checks; real PNG/checksum/coalescing/invalid-byte cleanup and manifest repair scenarios)`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
