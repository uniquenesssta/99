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
  let sub = Buffer.alloc(32), platform = 3, encoding = 1
  u16(sub, 0, 4); u16(sub, 2, 32); u16(sub, 6, 4)
  u16(sub, 14, 0x7e); u16(sub, 16, 0xffff)
  u16(sub, 20, 0x20); u16(sub, 22, 0xffff); u16(sub, 26, 1)
  // Preserve malformed segment coverage separately from a valid empty table.
  if (mode === 'overlapping-segments') { u16(sub, 14, 0xffff); u16(sub, 20, 0xffff) }
  if (mode === 'unsupported' || mode === 'unsupported8') {
    if (mode === 'unsupported') {
      sub = Buffer.alloc(526); u16(sub, 0, 2); u16(sub, 2, sub.length); encoding = 2
    } else {
      sub = Buffer.alloc(8208); u16(sub, 0, 8); u32(sub, 4, sub.length); platform = 0; encoding = 4
    }
  }
  if (mode === 'format12' || mode === 'format13' || mode === 'group-limit') {
    sub = Buffer.alloc(28); u16(sub, 0, mode === 'format13' ? 13 : 12)
    u32(sub, 4, 28); u32(sub, 12, 1); u32(sub, 16, 0x20); u32(sub, 20, 0x7e); u32(sub, 24, 1)
    if (mode === 'format13') { platform = 0; encoding = 6 } else encoding = 10
    if (mode === 'group-limit') u32(sub, 12, 65537)
  }
  if (mode === 'format0') {
    sub = Buffer.alloc(262); u16(sub, 2, 262); platform = 0; encoding = 0
    for (let code = 0x20; code <= 0x7e; code++) sub[6 + code] = 1
  }
  // The former unsupported format-6 fixture is now the all-zero glyph counterexample.
  if (['format6', 'format10', 'empty', 'glyph0'].includes(mode)) {
    const wide = mode === 'format10', count = mode === 'empty' ? 0 : mode === 'glyph0' ? 11 : 95, base = wide ? 20 : 10
    sub = Buffer.alloc(base + count * 2); u16(sub, 0, wide ? 10 : 6)
    if (wide) { u32(sub, 4, sub.length); u32(sub, 12, 0x20); u32(sub, 16, count); encoding = 10 }
    else { u16(sub, 2, sub.length); u16(sub, 6, 0x20); u16(sub, 8, count) }
    if (mode !== 'glyph0') for (let i = 0; i < count; i++) u16(sub, base + i * 2, i + 1)
  }
  const cmap = Buffer.alloc(12 + sub.length); u16(cmap, 2, 1); u16(cmap, 4, platform); u16(cmap, 6, encoding)
  u32(cmap, 8, mode === 'bad-offset' ? 900 : 12); sub.copy(cmap, 12)
  const head = Buffer.alloc(44); u32(head, 0, 0x10000); u16(head, 4, 2)
  head.write(mode === 'missing-name' ? 'test' : 'name', 12, 'ascii'); u32(head, 20, 44); u32(head, 24, mode === 'name-eof' ? name.length + 10000 : mode === 'name-resource-limit' ? 512 * 1024 + 1 : name.length)
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
  const supported = ['ok', 'format12', 'format0', 'format6', 'format10', 'format13']
  const modes = [...supported, 'unsupported', 'unsupported8', 'overlapping-segments', 'glyph0', 'bad-offset', 'empty', 'missing-name', 'version-only', 'io-eof', 'name-eof', 'table-eof', 'resource-limit', 'name-resource-limit', 'group-limit']
  const jobs = await Promise.all(modes.map(mode => makeJob(directory, mode)))
  const result = await client.run(jobs)
  assert.equal(result.results.length, modes.length); assert.equal(result.errors.length, 0)
  const byId = new Map(result.results.map(row => [row.jobId, row]))
  for (const [mode, kind] of [['unsupported', 'unsupported-format'], ['unsupported8', 'unsupported-format'], ['overlapping-segments', 'invalid-structure'], ['glyph0', 'empty-metadata'], ['bad-offset', 'invalid-structure'], ['empty', 'empty-metadata'],
    ['missing-name', 'missing-table'], ['io-eof', 'io-error'], ['name-eof', 'io-error'], ['table-eof', 'io-error'], ['resource-limit', 'resource-limit'], ['name-resource-limit', 'resource-limit'], ['group-limit', 'resource-limit']]) {
    assert(byId.get(mode).metadataDiagnostics.some(d => d.kind === kind), `${mode}: native diagnostic lost`)
    const raw = client.receipts[0].results.find(row => row.jobId === mode)
    assert.deepEqual(plain(byId.get(mode).metadataDiagnostics), raw.metadataDiagnostics, 'native JSON/normalizer changed diagnostic')
  }
  for (const [mode, stage] of [['io-eof', 'cmap'], ['name-eof', 'name'], ['table-eof', 'table-directory']]) assert(byId.get(mode).metadataDiagnostics.some(d => d.kind === 'io-error' && d.stage === stage))
  assert.equal(byId.get('ok').metadataDiagnostics, undefined, 'normal result bloated with diagnostics')
  const dispositions = {
    ok: 'complete', format0: 'complete', format6: 'complete', format10: 'complete', format12: 'complete', format13: 'complete',
    unsupported: 'unsupported', unsupported8: 'unsupported', 'bad-offset': 'malformed', 'overlapping-segments': 'malformed',
    empty: 'empty', glyph0: 'empty', 'missing-name': 'complete', 'version-only': 'complete',
    'io-eof': 'io-error', 'name-eof': 'io-error', 'table-eof': 'io-error', 'resource-limit': 'resource-limit', 'name-resource-limit': 'resource-limit', 'group-limit': 'resource-limit',
  }
  for (const mode of modes) {
    const row = byId.get(mode), raw = client.receipts[0].results.find(value => value.jobId === mode)
    assert.equal(raw.sourceStability, 'stable', `${mode}: source was not verified`)
    assert.equal(row.sourceStability, raw.sourceStability, `${mode}: client lost source stability`)
    assert.deepEqual(raw.parseDisposition, { scripts: dispositions[mode] }, `${mode}: native authoritative outcome`)
    assert.deepEqual(plain(row.parseDisposition), raw.parseDisposition, `${mode}: client lost authoritative outcome`)
    assert((row.metadataDiagnostics || []).length <= 16)
  }
  for (const mode of supported) assert.deepEqual(plain(byId.get(mode).scriptHint.scripts), [mode === 'format13' ? 'other' : 'latin'])
  assert.equal(byId.get('glyph0').scriptHint, undefined)
  // Exercise the actual memo owner with real Rust-to-client normalized results.
  const memoModule = client.load('src/main/indexing/scan-orchestrator/scanMetadataMemoRuntime.ts')
  for (const mode of [...supported, 'unsupported', 'unsupported8', 'bad-offset', 'empty', 'glyph0']) {
    const memo = memoModule.createScanMetadataMemoRuntime(), row = byId.get(mode)
    memo.remember(directory, 'native-fixture', row, 1)
    assert(memo.read(directory, 'native-fixture', row), `${mode}: verified reusable parse was not retained`)
  }
  for (const mode of ['io-eof', 'name-eof', 'table-eof', 'resource-limit', 'name-resource-limit', 'group-limit']) {
    const memo = memoModule.createScanMetadataMemoRuntime(), row = byId.get(mode)
    memo.remember(directory, 'native-fixture', row, 1)
    assert.equal(memo.read(directory, 'native-fixture', row), undefined, `${mode}: incomplete read was memoized`)
  }
  for (const stability of [undefined, 'unknown', 'changed']) {
    const memo = memoModule.createScanMetadataMemoRuntime(), row = { ...byId.get('unsupported'), sourceStability: stability }
    memo.remember(directory, 'native-fixture', row, 1)
    assert.equal(memo.size().entries, 0, 'unverified source was memoized')
  }
  const oldWorker = { ...byId.get('unsupported') }; delete oldWorker.parseDisposition; delete oldWorker.sourceStability
  const oldMemo = memoModule.createScanMetadataMemoRuntime()
  oldMemo.remember(directory, 'native-fixture', oldWorker, 1)
  assert.equal(oldMemo.size().entries, 0, 'old worker diagnostics invented cache authority')
  const fast = client.load('src/main/indexing/scan-orchestrator/rustParseBatchFastPathRuntime.ts')
  const accepted = [], logs = []
  const consumed = await fast.consumeRustFontParseBatchFastPath({ jobs, scriptDetectionVersion: 1, runRustFontParseBatch: async () => result,
    processResult: async value => accepted.push(value), appendStartupLog: text => logs.push(text), logPrefix: 'metadata-fixture' })
  const classifiedOther = ['unsupported', 'unsupported8', 'overlapping-segments', 'glyph0', 'bad-offset', 'empty', 'resource-limit', 'group-limit']
  const expected = modes.filter(mode => supported.includes(mode) || classifiedOther.includes(mode))
  assert.deepEqual(accepted.map(row => row.jobId), expected); assert.equal(consumed.remainingJobs.length, modes.length - expected.length)
  for (const mode of classifiedOther) assert.deepEqual(plain(accepted.find(row => row.jobId === mode).font.scripts), ['other'])
  assert(logs.some(line => line.includes('unusable-display-name'))); assert(logs.some(line => line.includes('io-error')))
  const legacy = { ...byId.get('unsupported') }; delete legacy.metadataDiagnostics; delete legacy.parseDisposition; delete legacy.sourceStability
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
    assert.equal(result.stats.skippedBad, 0)
    if (['unsupported', 'bad-offset', 'empty', 'resource-limit'].includes(mode)) {
      assert.equal(result.errors.length, 0)
      assert.deepEqual(plain(result.committedFolders), [a, b])
      assert.deepEqual(plain((await f.read(a)).entries['change.ttf'].font.scripts), ['other'])
      assert.deepEqual(await fs.readFile(path.join(a, 'change.ttf')), sourceBefore)
      return
    }
    assert(result.errors.length > 0)
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
    for (const mode of ['unsupported', 'bad-offset', 'empty', 'resource-limit', 'io-eof', 'version-only']) await recovery(mode)
    console.log('[diagnostics:rust-metadata-diagnostics] native JSON/client/fastpath, typed reasons, old worker, bounded logging, source provenance and real SQLite recovery/peer preservation passed')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}
const watchdog = setTimeout(() => { console.error('metadata diagnostics watchdog'); process.exit(1) }, 120000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(watchdog))
