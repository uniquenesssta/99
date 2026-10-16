#!/usr/bin/env node
'use strict'
// Windows-only. Synthetic private SFNT files, real release worker JSON, actual
// client/fast-path/orchestrator and SQLite recovery owner. No user fonts/profile.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
const { promisify } = require('node:util'), execFile = promisify(require('node:child_process').execFile)
const { loader } = require('./check-operation-chain.cjs')
const { fixture } = require('./check-scan-partial-retention.cjs')
const h = require('./helpers/rustWorkerTransportHarness.cjs')
const root = path.resolve(__dirname, '../..'), plain = value => JSON.parse(JSON.stringify(value))
const u16 = (b, o, n) => b.writeUInt16BE(n, o), u32 = (b, o, n) => b.writeUInt32BE(n, o)
function font(mode = 'ok') {
  if (mode === 'table-eof') { const b = Buffer.alloc(12); u32(b, 0, 0x10000); u16(b, 4, 10); return b }
  const text = Buffer.from('Fixture', 'utf16le'); text.swap16()
  const name = Buffer.alloc(18 + text.length)
  u16(name, 2, 1); u16(name, 4, 18); u16(name, 6, 3); u16(name, 8, 1); u16(name, 10, 0x409)
  u16(name, 12, mode === 'version-only' ? 5 : 1); u16(name, 14, text.length); text.copy(name, 18)
  const sub = Buffer.alloc(32)
  u16(sub, 0, 4); u16(sub, 2, 32); u16(sub, 6, 4)
  u16(sub, 14, mode === 'empty' ? 0xffff : 0x7e); u16(sub, 16, 0xffff)
  u16(sub, 20, mode === 'empty' ? 0xffff : 0x20); u16(sub, 22, 0xffff); u16(sub, 26, 1)
  if (mode === 'unsupported') { sub.fill(0); u16(sub, 0, 6); u16(sub, 2, 32); u16(sub, 8, 11) }
  if (mode === 'format12') { sub.fill(0); u16(sub, 0, 12); u32(sub, 4, 32); u32(sub, 12, 1); u32(sub, 16, 0x20); u32(sub, 20, 0x7e); u32(sub, 24, 1) }
  const cmap = Buffer.alloc(12 + sub.length); u16(cmap, 2, 1); u16(cmap, 4, 3); u16(cmap, 6, 1)
  u32(cmap, 8, mode === 'bad-offset' ? 900 : 12); sub.copy(cmap, 12)
  const head = Buffer.alloc(44); u32(head, 0, 0x10000); u16(head, 4, 2)
  head.write(mode === 'missing-name' ? 'test' : 'name', 12, 'ascii'); u32(head, 20, 44); u32(head, 24, mode === 'name-eof' ? name.length + 10000 : name.length)
  head.write('cmap', 28, 'ascii'); u32(head, 36, 44 + name.length)
  u32(head, 40, mode === 'io-eof' ? cmap.length + 100 : mode === 'resource-limit' ? 2 * 1024 * 1024 + 1 : cmap.length)
  return Buffer.concat([head, name, cmap])
}
let nativeHandshake
async function nativeClient(directory) {
  nativeHandshake ||= execFile(path.join(root, 'build/native/hfm-core-worker.exe'), ['--handshake'], { timeout: 30000 }).then(({ stdout }) => JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('{'))))
  const handshake = await nativeHandshake
  assert.equal(handshake.ok, true)
  assert(handshake.capabilities.includes('font-parse-batch-source-stability-v1'))
  const payloads = {}, receipts = [], logs = []
  const env = h.createHarness({ parseTransport: true,
    capabilities: handshake.capabilities, payloads,
    sharedHook: async ({ request, files }) => {
      if (request.args[0] !== '--font-parse-batch') return
      const input = path.join(directory, 'native-input.json')
      await fs.writeFile(input, files.get(request.args[2]))
      try {
        const { stdout } = await execFile(path.join(root, 'build/native/hfm-core-worker.exe'), ['--font-parse-batch', '--input', input], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
        const receipt = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('{')))
        assert.equal(receipt.ok, true); receipts.push(receipt); payloads['--font-parse-batch'] = receipt
      } finally { await fs.rm(input, { force: true }) }
    },
  })
  return { run: env.runtime.runRustFontParseBatch, receipts, logs, load: env.load }
}
async function makeJob(directory, mode) {
  const filePath = path.join(directory, mode + '.ttf'); await fs.writeFile(filePath, font(mode))
  const stat = await fs.stat(filePath)
  return { jobId: mode, rootPath: directory, filePath, cacheKey: mode + '.ttf', signature: mode + '|' + stat.size,
    fileSize: stat.size, modifiedAt: stat.mtimeMs, createdAt: stat.birthtimeMs }
}
async function nativeAndCompatibility(directory) {
  const client = await nativeClient(directory)
  const modes = ['ok', 'format12', 'unsupported', 'bad-offset', 'empty', 'missing-name', 'version-only', 'io-eof', 'name-eof', 'table-eof', 'resource-limit']
  const jobs = await Promise.all(modes.map(mode => makeJob(directory, mode)))
  const result = await client.run(jobs)
  assert.equal(result.results.length, modes.length); assert.equal(result.errors.length, 0)
  const byId = new Map(result.results.map(row => [row.jobId, row]))
  for (const [mode, kind] of [['unsupported', 'unsupported-format'], ['bad-offset', 'invalid-structure'], ['empty', 'empty-metadata'],
    ['missing-name', 'missing-table'], ['io-eof', 'io-error'], ['name-eof', 'io-error'], ['table-eof', 'io-error'], ['resource-limit', 'resource-limit']]) {
    assert(byId.get(mode).metadataDiagnostics.some(d => d.kind === kind), `${mode}: native diagnostic lost`)
    const raw = client.receipts[0].results.find(row => row.jobId === mode)
    assert.deepEqual(plain(byId.get(mode).metadataDiagnostics), raw.metadataDiagnostics, 'native JSON/normalizer changed diagnostic')
  }
  for (const [mode, stage] of [['io-eof', 'cmap'], ['name-eof', 'name'], ['table-eof', 'table-directory']]) assert(byId.get(mode).metadataDiagnostics.some(d => d.kind === 'io-error' && d.stage === stage))
  assert.equal(byId.get('ok').metadataDiagnostics, undefined, 'normal result bloated with diagnostics')
  const fast = client.load('src/main/indexing/scan-orchestrator/rustParseBatchFastPathRuntime.ts')
  const accepted = [], logs = []
  const consumed = await fast.consumeRustFontParseBatchFastPath({ jobs, scriptDetectionVersion: 1, runRustFontParseBatch: async () => result,
    processResult: async value => accepted.push(value), appendStartupLog: text => logs.push(text), logPrefix: 'metadata-fixture' })
  assert.deepEqual(accepted.map(row => row.jobId), ['ok', 'format12']); assert.equal(consumed.remainingJobs.length, modes.length - 2)
  assert(logs.some(line => line.includes('unusable-display-name'))); assert(logs.some(line => line.includes('io-error')))
  const legacy = { ...byId.get('unsupported') }; delete legacy.metadataDiagnostics
  const legacyLogs = []
  await fast.consumeRustFontParseBatchFastPath({ jobs: [legacy], scriptDetectionVersion: 1, runRustFontParseBatch: async () => ({ results: [legacy] }),
    processResult: async () => assert.fail('legacy incomplete result admitted'), appendStartupLog: line => legacyLogs.push(line), logPrefix: 'legacy' })
  assert(legacyLogs.some(line => line.includes('missing-script-hint')))
  assert(legacyLogs.every(line => !line.includes('io-error')), 'old worker acquired invented native I/O evidence')
  const diagnostic = client.load('src/main/indexing/scan-orchestrator/rustMetadataDiagnosticsRuntime.ts')
  const large = client.load('src/main/rust-core/fontMetadataDiagnostics.ts').normalizeRustMetadataDiagnostics(Array.from({ length: 100 }, () => ({ stage: 'name', kind: 'io-error', detail: 'x'.repeat(200), ioKind: 'y'.repeat(200), sourceIndex: 7 })))
  assert.equal(large.length, 16); assert.equal(large[0].detail.length, 96); assert.equal(large[0].ioKind.length, 64)
  const bounded = [], reporter = diagnostic.createRustMetadataRejectionReporter(line => bounded.push(line), 'bounded')
  for (let i = 0; i < 4122; i++) reporter.reject(jobs[0], 'missing-script-hint', large)
  reporter.flush(); assert.equal(bounded.length, 4); assert(bounded[0].includes('4122'))
  assert(bounded[0].includes('diagnosticLimitPerFont=16') && bounded[0].includes('not exhaustive'), 'bounded evidence was presented as a complete list')
  // Earlier collection faces retain their provenance without enabling admission.
  const ttc = Buffer.alloc(20); ttc.write('ttcf'); u32(ttc, 4, 0x10000); u32(ttc, 8, 2); u32(ttc, 12, 20); u32(ttc, 16, 32)
  const emptyFace = Buffer.alloc(12); u32(emptyFace, 0, 0x10000)
  const multi = await makeJob(directory, 'multi'); await fs.writeFile(multi.filePath, Buffer.concat([ttc, emptyFace, emptyFace]));
  const stat = await fs.stat(multi.filePath); multi.fileSize = stat.size; multi.modifiedAt = stat.mtimeMs
  const multiple = await client.run([multi]); assert.deepEqual(plain(multiple.results[0].metadataDiagnostics.map(d => d.sourceIndex)), [0, 1])
  // Preserve existing collection aggregation: script from face 0, name from 1.
  const first = font('missing-name'), second = font('ok')
  const relocate = (bytes, base) => { for (const offset of [20, 36]) u32(bytes, offset, bytes.readUInt32BE(offset) + base) }
  relocate(first, 20); relocate(second, 20 + first.length)
  u32(ttc, 12, 20); u32(ttc, 16, 20 + first.length)
  await fs.writeFile(multi.filePath, Buffer.concat([ttc, first, second]))
  const changed = await fs.stat(multi.filePath); multi.fileSize = changed.size; multi.modifiedAt = changed.mtimeMs
  const mixed = (await client.run([multi])).results[0]
  assert.equal(mixed.nameHint.sourceIndex, 1); assert.equal(mixed.scriptHint.sourceIndex, 0)
  assert(mixed.metadataDiagnostics.some(d => d.stage === 'name' && d.sourceIndex === 0))
  const builder = client.load('src/main/indexing/scan-orchestrator/rustMetadataFastPathRuntime.ts')
  assert.equal(builder.buildFontParseResultFromRustMetadata(mixed, 1).status, 'ok', 'diagnostic changed successful collection admission')
}
async function recovery(mode) {
  const f = await fixture()
  try {
    const [a, b] = f.folders, client = await nativeClient(f.directory)
    for (const folder of f.folders) for (const name of ['child/retained.ttf', 'change.ttf', 'removed.ttf']) {
      await fs.writeFile(path.join(folder, name), font(folder === a && name === 'change.ttf' ? mode : 'ok'))
    }
    const before = plain((await f.read(a)).entries)
    const sourceBefore = await fs.readFile(path.join(a, 'change.ttf'))
    const originalStorage = f.deps.ensureRootScanCacheStorage
    f.deps.ensureRootScanCacheStorage = async folder => {
      const value = await originalStorage(folder)
      value.cache.rebuildRequired = true; value.cache.rebuildRequestId = 'metadata-fixture'
      return value
    }
    f.deps.runRustFontParseBatch = client.run
    const result = await f.scan.scanFolders(f.folders)
    assert(result.errors.length > 0); assert.equal(result.stats.skippedBad, 0)
    assert.deepEqual(plain(result.committedFolders), [b], 'incomplete recovery root published or complete peer blocked')
    assert.deepEqual(plain((await f.read(a)).entries), before, 'incomplete metadata changed previous rows/tags')
    assert.deepEqual(await fs.readFile(path.join(a, 'change.ttf')), sourceBefore, 'diagnostic changed source bytes')
    assert.equal((await f.read(b)).entries['change.ttf'].font.family, 'Fixture')
    assert(f.state.logs.some(line => line.includes('publication deferred')))
    assert(f.state.logs.some(line => line.includes('rejected metadata sample')))
  } finally { await f.close() }
}
async function main() {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  const keys = ['HFM_RUST_SCAN_LISTING', 'HFM_NODE_STATE_FALLBACK', 'HFM_NODE_FONTKIT_SCAN_FALLBACK']
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hfm-metadata-diagnostics-'))
  process.env.HFM_RUST_SCAN_LISTING = '0'; process.env.HFM_NODE_STATE_FALLBACK = '1'; process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK = '0'
  try {
    await nativeAndCompatibility(directory)
    for (const mode of ['unsupported', 'io-eof', 'version-only']) await recovery(mode)
    console.log('[diagnostics:rust-metadata-diagnostics] native JSON/client/fastpath, typed reasons, old worker, bounded logging, source provenance and real SQLite recovery/peer preservation passed')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}
const watchdog = setTimeout(() => { console.error('metadata diagnostics watchdog'); process.exit(1) }, 120000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(watchdog))
