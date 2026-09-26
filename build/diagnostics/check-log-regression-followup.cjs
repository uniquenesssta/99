#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const arg = (name) => process.argv.find((v) => v.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const baseline = arg('baseline'), mutation = arg('mutation'), only = arg('case')
if (baseline) assert.match(baseline, /^[a-f0-9]{7,40}$/)
const files = {
  folder: 'src/renderer/src/library-normalize/libraryIndexChangeRuntime.ts',
  activation: 'src/main/activation/activationInstallStatusSaveQueue.ts',
  health: 'src/main/maintenance/databaseMaintenance.ts',
  preview: 'src/main/preview/previewRuntime.ts',
}
const mutants = {
  folder: [files.folder, 'folderNodes: Array.from(folderNodes.values()),', 'folderNodes: tree.nodes,'],
  activation: [files.activation, 'if (unchangedIds.length === rowCount)', 'if (false)'],
  health: ['src/main/maintenance/databaseMaintenanceHelpers.ts', "spec.label === 'preview' || spec.label === 'metrics'", "spec.label === 'preview'"],
  corruption: ['src/main/maintenance/databaseMaintenanceHelpers.ts', 'await fsp.stat(filePath)\n    return false', 'return true'],
  preview: [files.preview, "installedRoute?.reason === 'active'", 'false'],
}

function loader(mocks = {}) {
  const cache = new Map()
  function load(rel) {
    if (Object.hasOwn(mocks, rel)) return mocks[rel]
    if (cache.has(rel)) return cache.get(rel)
    let source = baseline ? execFileSync('git', ['show', `${baseline}:${rel}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, rel), 'utf8')
    if (process.argv.includes('--crlf')) source = source.replace(/\r?\n/g, '\r\n')
    if (mutation && mutants[mutation][0] === rel) {
      const [, before, after] = mutants[mutation]
      source = source.replace(/\r\n/g, '\n')
      assert.ok(source.includes(before), `mutation anchor missing: ${mutation}`)
      source = source.replace(before, after)
    }
    const mod = { exports: {} }; cache.set(rel, mod.exports)
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    new Function('require', 'module', 'exports', code)((id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), id)) + '.ts')
      if (id.startsWith('@shared/')) return load(id.replace('@shared/', 'src/shared/') + '.ts')
      return require(id)
    }, mod, mod.exports)
    return mod.exports
  }
  return load
}

async function folder() {
  const load = loader({ 'src/renderer/src/appConstants.ts': { FONT_OBJECT_LRU_LIMIT: 1000 }, 'src/renderer/src/fontClassification.ts': {} })
  const { applyFontIndexChangeToLibrary: apply } = load(files.folder)
  const { applyFolderTreeToLibrary } = load('src/renderer/src/library-normalize/libraryFolderTreeRuntime.ts')
  const rootPath = 'O:\\Fonts'
  const nodes = Array.from({ length: 173 }, (_, i) => ({ id: `${rootPath}\\dir${i}`, rootPath, parentId: rootPath, name: `dir${i}`, createdAt: 'original' }))
  const font = { id: 'a', path: `${nodes[0].id}\\a.ttf`, fileName: 'a.ttf', fileSize: 100, tagNames: [], localTagNames: [], collectionIds: [] }
  let state = { folders: [rootPath], folderNodes: nodes, fonts: { a: font }, fontFolderIds: {}, tags: [], localTags: [] }
  for (const source of ['mutation', 'watcher', 'scan-stream']) {
    const next = apply(state, { folder: rootPath, source, upserts: [{ ...font, favorite: true }], deletes: [] }).library
    assert.equal(next.folderNodes.length, 173, `${source}: partial fonts erased unloaded/empty folders`)
    assert.equal(next.folderNodes[172].createdAt, 'original')
  }
  const added = { ...font, id: 'b', path: `${rootPath}\\new\\b.ttf` }
  state = apply(state, { folder: rootPath, source: 'watcher', upserts: [added], deletes: [] }).library
  assert.equal(state.folderNodes.length, 174)
  state = apply(state, { folder: 'o:/fonts/', source: 'watcher', upserts: [{ ...added, path: 'o:/fonts/NEW/b.ttf' }], deletes: [] }).library
  assert.equal(state.folderNodes.length, 174, 'slash/case aliases duplicated folders')
  state = apply(state, { folder: rootPath, source: 'watcher', upserts: [], deletes: [{ id: 'b', path: added.path }] }).library
  assert.equal(state.fonts.b, undefined, 'font deletion must still apply')
  assert.equal(state.folderNodes.length, 174, 'font deletion is not physical directory deletion')
  const replaced = applyFolderTreeToLibrary(state, { folders: [rootPath], nodes: [nodes[0]] })
  assert.equal(replaced.folderNodes.length, 1, 'authoritative physical tree must still remove deleted directories')
  assert.equal(apply(state, { folder: 'Z:/Other', upserts: [added], deletes: [] }).library, state)
}

async function activation() {
  const load = loader()
  const { createMainActivationInstallStatusSaveRuntime } = load('src/main/activation/mainActivationInstallStatusSaveRuntime.ts')
  const make = (read) => {
    const calls = [], logs = []
    const queue = createMainActivationInstallStatusSaveRuntime({
      batchDelayMs: 100000, readInstallStatusIndex: read,
      saveInstallStatusIndex: async (results) => calls.push(['save', Object.keys(results)]),
      appWatchedFolders: async () => ['O:/Fonts'], rootForFontPath: async () => 'O:/Fonts',
      syncMergedIndexAfterInstallStatusRefresh: async () => calls.push(['sync']),
      clearFontQueryCaches: () => calls.push(['clear']), appendStartupLog: (v) => logs.push(v),
    })
    return { queue, calls, logs }
  }
  const font = { id: 'a', path: 'O:/Fonts/a.ttf' }, other = { id: 'b', path: 'O:/Fonts/b.ttf' }
  const no = { installed: false, by: 'none', matches: [] }
  const yes = { installed: true, by: 'system', matches: [{ source: 'HKLM', registryName: 'Family', value: 'a.ttf' }] }
  const items = new Map([['a', font], ['b', other]])
  for (const result of [no, yes]) {
    const { queue, calls, logs } = make(async () => ({ results: { a: structuredClone(result) }, misses: [] }))
    queue.scheduleActivationInstallStatusSave({ a: result }, items, 'unchanged')
    await queue.flushActivationInstallStatusSave('test')
    assert.deepEqual(calls, [['clear'], ['clear']], 'overlay entry/retirement invalidate queries; unchanged persisted status must not write or sync')
    assert.ok(logs.some((v) => v.includes('unchanged=1')))
    assert.equal(queue.hasPendingActivationInstallStatusSave(), false)
  }
  for (const read of [async () => ({ results: {}, misses: [font] }), async () => { throw Error('read failed') }, async () => ({ results: { a: no }, misses: [] })]) {
    const { queue, calls } = make(read)
    queue.scheduleActivationInstallStatusSave({ a: yes }, items, 'changed-or-unknown')
    await queue.flushActivationInstallStatusSave('test')
    assert.deepEqual(calls, [['clear'], ['save', ['a']], ['sync'], ['clear'], ['clear']], 'missing/changed/unreadable status must persist before sync')
  }
  const { queue, calls } = make(async () => ({ results: { a: no, b: no }, misses: [] }))
  queue.scheduleActivationInstallStatusSave({ a: no, b: yes }, items, 'mixed')
  await queue.flushActivationInstallStatusSave('test')
  assert.deepEqual(calls, [['clear'], ['save', ['b']], ['sync'], ['clear'], ['clear']], 'mixed batch must write changed rows only')
  // A matching boolean alone is insufficient; source and matched records affect installation truth.
  for (const changed of [{ ...yes, by: 'user' }, { ...yes, matches: [{ ...yes.matches[0], value: 'other.ttf' }] }]) {
    const { queue, calls } = make(async () => ({ results: { a: yes }, misses: [] }))
    queue.scheduleActivationInstallStatusSave({ a: changed }, items, 'match-changed')
    await queue.flushActivationInstallStatusSave('test')
    assert.deepEqual(calls.filter(([kind]) => kind === 'save'), [['save', ['a']]])
  }
  let releaseRead
  const reading = new Promise((resolve) => { releaseRead = resolve })
  let reads = 0
  const racing = make(async () => {
    if (++reads === 1) await reading
    return { results: { a: no }, misses: [] }
  })
  racing.queue.scheduleActivationInstallStatusSave({ a: no }, items, 'first')
  const flush = racing.queue.flushActivationInstallStatusSave('close')
  racing.queue.scheduleActivationInstallStatusSave({ a: yes }, items, 'new-during-read')
  releaseRead()
  await flush
  assert.deepEqual(racing.calls, [['clear'], ['clear'], ['clear'], ['save', ['a']], ['sync'], ['clear'], ['clear']], 'skipping old batch must still drain newer pending state')
  assert.equal(racing.queue.hasPendingActivationInstallStatusSave(), false)
  assert.equal(racing.queue.hasInFlightActivationInstallStatusSave(), false)
}

async function health() {
  for (const rust of [true, false]) for (const [label, present, ok, expected, errno] of [['metrics', false, false, true], ['preview', false, false, true], ['metrics', true, false, false], ['library', false, false, false], ['metrics', true, true, true], ['metrics', false, false, false, 'EACCES'], ['metrics', false, false, false, 'EIO']]) {
    const load = loader({
      'node:fs': { ...fs, promises: { ...fs.promises, stat: async () => { if (!present) throw Object.assign(Error('stat failure'), { code: errno || 'ENOENT' }); return {} } } },
      'src/main/maintenance/databaseBackupRuntime.ts': { createDatabaseBackupRuntime: () => ({ createAutomaticDatabaseBackupIfNeeded: async () => undefined }) },
      'src/main/maintenance/previewCacheMaintenanceRuntime.ts': { createPreviewCacheMaintenanceRuntime: () => ({ runPreviewCacheMaintenance: async () => ({ staleRows: 0, removedFiles: 0, removedOrphanFiles: 0, errors: [] }) }) },
    })
    const { createDatabaseMaintenanceRuntime } = load(files.health)
    let opens = 0
    const runtime = createDatabaseMaintenanceRuntime({
      dbFileSpecs: () => [{ label, filePath: `${label}.sqlite`, open: async () => { opens++; if (!ok) throw Error('corrupt or missing'); return { prepare: () => ({ get: () => ({ quick_check: 'ok' }) }) } } }],
      exists: async () => present, appendStartupLog() {},
      runRustDatabaseHealthCheck: rust ? async () => ({ items: [{ label, filePath: `${label}.sqlite`, ok, message: ok ? 'ok' : 'bad' }], elapsedMs: 1 }) : undefined,
      runTaskMaintenance: async () => ({ removedCompleted: 0, removedFailed: 0 }), checkpointApplicationDatabases: async () => {},
    })
    const report = await runtime.runDatabaseMaintenance()
    assert.equal(report.ok, expected, `${rust ? 'Rust' : 'Node'} ${label} present=${present} health=${ok}`)
    if (!present && expected) {
      assert.match(report.health[0].message, /optional/)
      assert.equal(opens, 0, 'health check must not create unused optional cache')
    }
  }
}

async function preview() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-preview-route-'))
  try {
    const fontPath = path.join(dir, 'font.ttf'); fs.writeFileSync(fontPath, 'font fixture')
    for (const scenario of ['active', 'system', 'active-offline', 'system-fallback', 'render-failed']) {
      const calls = [], writes = [], logs = []
      const load = loader({
        'src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts': { hasDirectWritePreviewHelper: () => false },
        'src/main/preview/runtime/previewCacheStorageRuntime.ts': { createPreviewCacheStorageRuntime: () => ({
          previewCacheStorageForFont: async () => ({ dir, identity: 'original', storage: 'local' }),
          readPreviewCacheIndexStatus: async () => null, writePreviewCacheIndex: async (_, __, row) => writes.push(row), rememberPreviewCacheRenderQueued() {},
        }) },
        'src/main/preview/runtime/previewCachePublishRuntime.ts': { createPreviewCachePublishRuntime: () => ({ enqueuePreviewCachePublish() {} }) },
        'src/main/preview/runtime/previewCacheMetaRuntime.ts': { createPreviewCacheMetaRuntime: () => ({}) },
        'src/main/preview/runtime/previewCacheManifestRuntime.ts': { createPreviewCacheManifestRuntime: () => ({}) },
        'src/main/preview/runtime/cachedPreviewReadRuntime.ts': { createCachedPreviewReadRuntime: () => ({}) },
        'src/main/preview/runtime/previewFontDataRuntime.ts': { createPreviewFontDataRuntime: () => ({}) },
        'src/main/preview/native-renderer/previewNativeRendererRuntime.ts': { createPreviewNativeRenderer: () => ({ activeEngineLabel: () => 'rust-directwrite', renderNativePreview: async (request) => {
          calls.push(request)
          if (scenario === 'render-failed' || (request.preferSystemFont && ['active', 'system-fallback'].includes(scenario))) throw Error('family status=14')
          fs.writeFileSync(request.outputPath, require('./fixtures/preview-png.cjs'))
          return { ok: true, engine: 'rust-directwrite', outputPath: request.outputPath }
        } }) },
      })
      const runtime = load(files.preview).createPreviewRuntime({
        appendStartupLog: (v) => logs.push(v), sha1: (v) => require('node:crypto').createHash('sha1').update(v).digest('hex'), ensureWindows() {},
        resolveExistingFontFilePath: async () => scenario === 'active-offline' ? null : fontPath,
        previewTaskKey: (v) => v, completeBackgroundTask: async () => {}, skipBackgroundTask: async () => {},
        upsertBackgroundTask: async () => {}, startBackgroundTask: async () => {}, heartbeatBackgroundTask: async () => {}, failBackgroundTask: async () => {},
      })
      const item = { id: 'a', path: fontPath, fileName: 'font.ttf', family: 'Family', active: !scenario.startsWith('system'), systemInstalled: scenario.startsWith('system'), fileSize: 100, modifiedAt: 1 }
      if (scenario === 'render-failed') {
        await assert.rejects(runtime.ensureFontPreviewImageFile(item, scenario), /HFM_PREVIEW:failed/)
        assert.equal(writes.at(-1).status, 'failed')
      } else {
        const result = await runtime.ensureFontPreviewImageFile(item, scenario)
        assert.equal(result.cached, false)
        assert.equal(writes.at(-1).status, 'ok')
        if (scenario === 'active') {
          assert.equal(calls.length, 1, 'active font must not first fail family lookup')
          assert.equal(calls[0].fontPath, fontPath)
          assert.ok(logs.some((v) => v.includes('active font preview file route')))
        } else {
          assert.equal(calls[0].preferSystemFont, true, 'system or offline route must retain name lookup')
          assert.equal(calls.length, scenario === 'system-fallback' ? 2 : 1)
        }
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

async function main() {
  const failures = []
  for (const [name, run] of Object.entries({ folder, activation, health, preview })) {
    if (only && name !== only) continue
    try { await run(); console.log(`ok ${name}`) } catch (error) { failures.push(`${name}: ${error.stack}`) }
  }
  assert.equal(failures.length, 0, failures.join('\n'))
  if (!baseline && !mutation && !only) {
    for (const name of Object.keys(mutants)) for (const eol of [[], ['--crlf']]) {
      const result = spawnSync(process.execPath, [__filename, `--mutation=${name}`, `--case=${name === 'corruption' ? 'health' : name}`, ...eol], { cwd: root, encoding: 'utf8' })
      assert.notEqual(result.status, 0, `escaped mutation ${name} ${eol}`)
      assert.doesNotMatch(result.stderr, /mutation anchor missing|Cannot find module|SyntaxError/, 'mutation must fail a behavior assertion')
    }
    console.log('[diagnostics:log-regression-followup] four real runtime suites and 10 LF/CRLF mutants passed')
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
