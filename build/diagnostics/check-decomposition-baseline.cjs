#!/usr/bin/env node
// D-01: production code is loaded verbatim; only external I/O is replaced.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const fixturePath = path.join(__dirname, 'fixtures/decomposition-baseline.fixture.json')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function load(file, mocks = {}, transform = x => x) {
  const exports = {}
  const source = transform(read(file))
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  vm.runInNewContext(code, { exports, require(id) {
    if (Object.hasOwn(mocks, id)) return mocks[id]
    if (id.endsWith('/sharedFileSystemRuntime')) return { sharedFileSystem: (mocks['node:fs'] || fs).promises, sharedSqliteReadSnapshot: async () => undefined }
    if (id.endsWith('/rustSharedIoCommandRuntime')) return { sharedIoResourceKeys: async () => [] }
    if (id.endsWith('/sharedIoProcessRuntime')) return require('./check-operation-chain.cjs').loader()('src/main/path/sharedIoProcessRuntime.ts')
    if (['./previewBatchRowsRuntime', './previewBatchReadRuntime', './previewStorageIoRuntime'].includes(id)) return load('src/main/preview/runtime/' + id.slice(2) + '.ts', mocks)
    if (['./localFontTagRustAdapterRuntime', './localFontTagMutationEffectsRuntime'].includes(id)) return load('src/main/library/runtime/' + id.slice(2) + '.ts', mocks)
    if (id === './localFontTagNodePersistenceRuntime') return load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts', mocks)
    if (id === './previewIndexAccessRuntime') return load('src/main/preview/runtime/previewIndexAccessRuntime.ts', mocks)
    if (id === './previewStorageRoutingRuntime') return load('src/main/preview/runtime/previewStorageRoutingRuntime.ts', mocks)
    if (/\/(operationTraceContext|fontOperationTrace|operationTrace)$/.test(id)) {
      const target = path.resolve(path.dirname(path.join(root, file)), id + '.ts')
      return require('./check-operation-chain.cjs').loader()(target)
    }
    if (id.startsWith('node:')) return require(id)
    if (id === './fontTagStateAuthorityRuntime') return load('src/renderer/src/fontTagStateAuthorityRuntime.ts')
    if (id === './tagMutationSignalIdentityRuntime') return require('./check-operation-chain.cjs').loader()('src/main/library/tagMutationSignalIdentityRuntime.ts')
    if (id === './fontUserIntentRuntime') return load('src/renderer/src/fontUserIntentRuntime.ts')
    throw new Error(`Unmocked dependency: ${file} -> ${id}`)
  }, console, Date, Map, Set, process, setTimeout, clearTimeout }, { filename: file })
  return exports
}
function inventory(file, source = read(file)) {
  source = source.replace(/\r\n/g, "\n")
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const functions = [], owners = [], exports = [], surfaces = {}, viewGroups = [], ipcChannels = []
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "handle" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) ipcChannels.push(node.arguments[0].text)
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.push(node.name.text)
      if (node.parent === ast && node.body) {
        const lastReturn = [...node.body.statements].reverse().find(ts.isReturnStatement)
        if (lastReturn?.expression && ts.isObjectLiteralExpression(lastReturn.expression)) surfaces[node.name.text] = lastReturn.expression.properties.map(p => p.name?.getText(ast) || p.getText(ast))
      }
    }
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'AppRootView') viewGroups.push(...node.attributes.properties.map(p => p.name?.getText(ast) || 'spread'))
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression.getText(ast)
      if (/^use(State|Ref)$/.test(callee)) owners.push({ binding: node.name.getText(ast).replace(/\s/g, ''), kind: callee })
    }
    if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && node.name) exports.push(node.name.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source)
  const tokens = []; while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText())
  return { functions, owners, exports, surfaces, viewGroups, ipcChannels, tokenHash: crypto.createHash('sha256').update(JSON.stringify(tokens)).digest('hex') }
}
function checkInventory() {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  for (const [file, expected] of Object.entries(fixture.files)) {
    assert.deepEqual(inventory(file), expected, `D-01 frozen contract changed: ${file}; migrate evidence explicitly`)
    assert.deepEqual(inventory(file, read(file).replace(/\r?\n/g, '\r\n')), expected)
  }
  // A real ownership mutation must be rejected, independent of line endings.
  const app = 'src/renderer/src/App.tsx'
  assert.notDeepEqual(inventory(app, read(app) + '\nconst [mirror, setMirror] = useState(null)\n'), fixture.files[app])
}
const queueFile = 'src/renderer/src/fontWriteQueue.ts'
async function queueCheck(transform = x => x) {
  const q = load(queueFile, {}, transform)
  const state = q.createEmptyQueuedFontWriteState()
  const font = { id: 'a', path: '/a.ttf', localTagNames: ['local-old'], tagNames: ['shared-old'], favorite: true, deleteProtected: true }
  state.localTags.set('a', { item: font, tagNames: ['local-new'] })
  state.sharedTags.set('a', { item: font, tagNames: ['shared-new'] })
  state.favorite.set('a', { font, favorite: false })
  state.protection.set('a', { font, protect: false })
  const calls = [], pending = Array.from({ length: 4 }, gate)
  const argsSeen = []
  const response = { ok: true, updatedIds: ['a'], failed: [], message: 'ok' }
  function call(name, index, args) { calls.push(name); argsSeen.push(plain(args)); return pending[index].promise }
  const resultPromise = q.flushQueuedFontWriteQueue({ queue: state, folders: ['/fonts'], hfm: {
    setLocalTagsBatch: (...args) => call('local', 0, args),
    setSharedTagsBatch: (...args) => call('shared', 1, args),
    setFavorite: (...args) => call('favorite', 2, args),
    setDeleteProtection: (...args) => call('protection', 3, args)
  } })
  // Resolving later gates early cannot reorder the real serial executor.
  pending[3].resolve(response); pending[2].resolve(response); pending[1].resolve(response)
  await Promise.resolve()
  assert.deepEqual(calls, ['local'])
  pending[0].resolve({ ok: false, updatedIds: [], failed: [{ id: 'a', message: 'injected' }], message: 'fail' })
  const result = await resultPromise
  assert.deepEqual(calls, ['local', 'shared', 'favorite', 'protection'])
  assert.equal(result.wroteCount, 3)
  assert.equal(result.retryQueue.localTags.size, 1)
  for (const domain of ['sharedTags', 'favorite', 'protection']) assert.equal(result.retryQueue[domain].size, 0)
  assert.deepEqual(argsSeen[0][0][0].tagNames, ['local-new'])
  assert.deepEqual(argsSeen[1][0][0].tagNames, ['shared-new'])
  assert.equal(argsSeen[2][2], false); assert.equal(argsSeen[3][2], false)
  assert.deepEqual(font, { id: 'a', path: '/a.ttf', localTagNames: ['local-old'], tagNames: ['shared-old'], favorite: true, deleteProtected: true })
  const newer = q.createEmptyQueuedFontWriteState()
  newer.localTags.set('a', { item: font, tagNames: ['newest'] })
  q.mergeQueuedFontWritesPreservingNewer(newer, result.retryQueue)
  assert.deepEqual(newer.localTags.get('a').tagNames, ['newest'])
  const replay = []
  await q.flushQueuedFontWriteQueue({ queue: result.retryQueue, folders: [], hfm: { setLocalTagsBatch: async () => { replay.push('local'); return response } } })
  assert.deepEqual(replay, ['local'])
}
function authorityCheck() {
  const a = load('src/renderer/src/fontTagStateAuthorityRuntime.ts')
  const original = { id: 'a', localTagNames: ['L'], tagNames: ['S'], favorite: true, deleteProtected: true }
  for (const scope of ['local', 'shared']) {
    const next = a.markFontTagsOptimistic(original, scope, ['new'], 100)
    assert.equal(next.favorite, true); assert.equal(next.deleteProtected, true)
    assert.deepEqual(plain(next[scope === 'local' ? 'tagNames' : 'localTagNames']), [scope === 'local' ? 'S' : 'L'])
    const merged = a.mergeFontWithTagAuthority(next, original, 101)
    assert.deepEqual(plain(merged[scope === 'local' ? 'localTagNames' : 'tagNames']), ['new'])
  }
}
function fieldPermutationCheck(transform = x => x) {
  const state = load('src/main/indexing/shared-metadata/sharedMetadataStateRuntime.ts')
  const merge = load('src/main/indexing/shared-metadata/sharedMetadataFieldMergeRuntime.ts', { './sharedMetadataStateRuntime': state }, transform).mergeSharedMetadataState
  const tags = load('src/renderer/src/fontTagStateAuthorityRuntime.ts')
  const permutations = xs => xs.length ? xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map(rest => [x, ...rest])) : [[]]
  const original = { id: 'a', localTagNames: ['L'], tagNames: ['S'], favorite: true, deleteProtected: true }
  for (const order of permutations(['local', 'tags', 'favorite', 'deleteProtected'])) {
    let current = { ...original }
    for (const policy of order) {
      if (policy === 'local') { current = tags.markFontTagsOptimistic(current, 'local', ['L-new'], 100); continue }
      const requestedState = { tagNames: policy === 'tags' ? ['S-new'] : ['S'], favorite: false, deleteProtected: false }
      const result = merge({ policy, existingRow: { tag_names_json: JSON.stringify(current.tagNames), favorite: +current.favorite, delete_protected: +current.deleteProtected, revision: 5 }, baseState: original, requestedState })
      current = { ...current, ...result.state }
    }
    assert.deepEqual(plain({ localTagNames: current.localTagNames, tagNames: current.tagNames, favorite: current.favorite, deleteProtected: current.deleteProtected }), { localTagNames: ['L-new'], tagNames: ['S-new'], favorite: false, deleteProtected: false }, order.join(' -> '))
  }
}

async function observePreview() {
  const mocks = {}
  // Unused sibling services must not silently accept calls.
  const factories = { previewCacheRootAvailabilityRuntime: 'createPreviewCacheRootAvailabilityRuntime', previewCacheTierRuntime: 'createPreviewCacheTierRuntime', previewCacheSharedPresenceRuntime: 'createPreviewCacheSharedPresenceRuntime', previewCachePresenceIndexRuntime: 'createPreviewCacheSharedPresenceIndexRuntime', previewCacheMetaRuntime: 'createPreviewCacheMetaRuntime', previewCacheHydrationRuntime: 'createPreviewCacheHydrationRuntime', previewCachePrefetchRuntime: 'createPreviewCachePrefetchRuntime' }
  for (const [file, factory] of Object.entries(factories)) mocks[`./${file}`] = { [factory]: () => ({}) }
  mocks['./previewLocalCacheEvictionRuntime'] = { createPreviewLocalCacheEvictionRuntime: () => ({ schedulePreviewLocalCacheEviction() {} }) }
  for (const id of ['./previewInputPolicy', '../../path/fontPathPolicy', './previewCacheKeyRuntime', './previewCachedImageReadBatchRuntime', './previewInstalledFontRouteRuntime']) mocks[id] = {}
  mocks['../../path/ioDeadlineRuntime'] = { previewCacheQueryTimeoutMs: () => 1000 }
  let stored = 'missing', opens = 0
  const pending = gate()
  const db = { prepare: () => ({ get: () => ({ output_path: '/preview.png', status: stored }), run() {} }) }
  const r = load('src/main/preview/runtime/previewCacheStorageRuntime.ts', mocks).createPreviewCacheStorageRuntime({
    openPreviewDb: () => ++opens === 1 ? pending.promise : Promise.resolve(db), normalizePathForCacheCompare: x => x,
    normalizePreviewCacheIndexStatus: x => x, upsertPreviewCacheRows(_db, rows) { stored = rows[0].status }
  })
  const storage = { storage: 'local', identity: 'a', dir: '/' }
  const writing = r.writePreviewCacheIndex(storage, 'key', { outputPath: '/preview.png', status: 'ok' })
  await r.readPreviewCacheIndexStatus(storage, 'key', '/preview.png')
  pending.resolve(db); await writing
  const after = await r.readPreviewCacheIndexStatus(storage, 'key', '/preview.png')
  assert.equal(stored, 'ok')
  return { expected: 'ok', actual: after }
}
async function observeTags() {
  const identity = load('src/main/library/runtime/localFontTagIdentityRuntime.ts')
  const mocks = {
    './localFontTagIdentityRuntime': identity,
    '../tagMutationProtocolResultRuntime': {},
    '../../rust-core/nodeStateFallbackCompatibilityRuntime': { nodeStateFallbackCompatibilityAllowed: () => true, logNodeStateFallbackUsed() {} }
  }
  const db = { prepare(sql) { return { all() {
    if (sql.includes('SELECT font_id')) return [{ font_id: 'shared', tag_name: 'tag' }]
    if (sql.includes('SELECT font_path')) return [{ font_path: identity.localTagFontPath({ path: '/font.ttf' }), tag_name: 'tag' }]
    throw new Error(`Unexpected SQL ${sql}`)
  } } } }
  const r = load('src/main/library/runtime/localFontTagsRuntime.ts', mocks).createLocalFontTagsRuntime({ openLibraryDb: async () => db, librarySqlitePath: () => '/isolated-db' })
  const result = await r.hydrateLocalTagsForFonts([{ id: 'a', sourceId: 'shared', path: '/font.ttf' }, { id: 'b', sourceId: 'shared', path: '/font.ttf' }])
  return { expected: [['tag'], ['tag']], actual: plain(result.map(f => f.localTagNames)) }
}
async function main() {
  if (process.argv.includes('--observe') || process.argv.includes('--probe')) {
    const results = { 'F-P1': await observePreview(), 'F-T1': await observeTags() }
    for (const [id, result] of Object.entries(results)) {
      console.log(id, JSON.stringify(result))
      assert.deepEqual(result.actual, result.expected, id)
    }
    return
  }
  const preview = await observePreview(); assert.equal(preview.actual, preview.expected, "F-P1");
  const tags = await observeTags(); assert.deepEqual(tags.actual, tags.expected, "F-T1");
  checkInventory(); await queueCheck(); authorityCheck(); fieldPermutationCheck()
  assert.throws(() => fieldPermutationCheck(s => s.replace("const policy = options.policy || 'replace'", "const policy = 'replace'")), assert.AssertionError)
  const mutant = source => {
    const target = 'if (!target.localTags.has(id)) target.localTags.set(id, entry)'
    assert(source.includes(target))
    return source.replace(target, 'target.localTags.set(id, entry)')
  }
  await assert.rejects(() => queueCheck(mutant), assert.AssertionError)
  console.log('[diagnostics:decomposition-baseline] ownership/token inventory LF/CRLF, real serial executor, domain arguments, retry isolation, newer intent, tag authority, 24 field permutations, two mutations rejected')
}
module.exports = { load, inventory, observePreview };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
