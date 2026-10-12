#!/usr/bin/env node
// Windows CI: real query/recovery/snapshot code, SQLite, controlled filesystem/dialog ports.
const assert = require('node:assert/strict')
process.env.HFM_LOG_DETAIL = 'debug'
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path').win32
const crypto = require('node:crypto')
const bytesFor = font => { const bytes = Buffer.alloc(font.fileSize || 100); if (['ttc','otc'].includes(font.format)) bytes.write('ttcf'); else if (font.format === 'otf') bytes.write('OTTO'); else bytes.writeUInt32BE(0x00010000); bytes.write(String(font.postscriptName || font.fileName), 4); return bytes }
const hashFor = font => crypto.createHash('sha256').update(bytesFor(font)).digest('hex')
const { load } = require('./check-decomposition-baseline.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
const identity = load('src/main/library/runtime/localFontTagIdentityRuntime.ts')
const storageKey = value => identity.normalizeLocalTagFontPath(value)
const key = load('src/main/path/pathCanonicalizer.ts').normalizePathCompareText
const inside = (file, root) => key(file) === key(root) || key(file).startsWith(key(root) + '\\')
const root = 'C:\\Fonts'
const refreshReceipt = (folder, extra = {}) => ({ ok: true, folder, rootPath: folder, mode: 'cache-read', cacheRepairs: [], upserts: 0, deletes: 0, errors: 0, totalFiles: 0, parsed: 0, fromCache: 0, skippedBad: 0, elapsedMs: 0, message: 'done', ...extra })
const make = (name, folder = 'old') => ({ recoveryContentHash: hashFor({ postscriptName: name, fileSize: 100 }), id: `${folder}-${name}`, path: `${root}\\${folder}\\${name}.ttf`, fileName: `${name}.ttf`, family: name, fullName: name,
  postscriptName: name, style: 'Regular', format: 'ttf', fileSize: 100, modifiedAt: 1, addedAt: '', favorite: false,
  collectionIds: [], tagNames: [], localTagNames: [], systemInstalled: false, systemInstallMatches: [], active: false })

function harness() {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE local_font_tags (font_id TEXT, font_path TEXT, tag_name TEXT, updated_at TEXT DEFAULT 'historical'); CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT)")
  const counts = { live: 0, hydrate: 0, parse: 0, contentReads: 0, collections: 0, bindingRows: 0,
    snapshotReads: 0, snapshotWrites: 0, stats: 0, realpaths: 0, backgroundStats: 0, backgroundRealpaths: 0, backgroundContentReads: 0 }
  const faults = { snapshotReadError: undefined }
  const adapter = { exec: sql => db.exec(sql), prepare: sql => {
    const statement = db.prepare(sql)
    if (/^SELECT font_id, font_path, tag_name FROM local_font_tags/.test(sql)) return { all: (...args) => {
      counts.collections++; const rows = statement.all(...args); counts.bindingRows += rows.length; return rows
    } }
    if (/^SELECT font_json FROM tag_font_snapshots WHERE font_path/.test(sql)) return { get: (...args) => {
      counts.snapshotReads++; if (faults.snapshotReadError) throw faults.snapshotReadError
      return statement.get(...args)
    } }
    if (/^(INSERT|REPLACE|UPDATE)\b.*\btag_font_snapshots\b/i.test(sql)) return { run: (...args) => { counts.snapshotWrites++; return statement.run(...args) } }
    return statement
  }, transaction: fn => () => {
    db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value } catch (e) { db.exec('ROLLBACK'); throw e }
  } }
  const files = new Map(), parsed = new Map(), roots = [root], sharedRows = []
  const reads = [], queryRequests = [], mappings = new Map(), logs = []
  const contents = new Map()
  const filesystem = {
    realpath: async file => { counts.realpaths++; if (sharedIo.currentSharedIoPriority() === 'background') counts.backgroundRealpaths++; await filesystem.stat(file); return file },
    readFile: async file => { counts.contentReads++; if (sharedIo.currentSharedIoPriority() === 'background') counts.backgroundContentReads++; return contents.get(key(file)) || bytesFor(parsed.get(key(file))) },
    async stat(file) {
      counts.stats++; if (sharedIo.currentSharedIoPriority() === 'background') counts.backgroundStats++
      if (files.get(key(file)) instanceof Error) throw files.get(key(file))
      if (files.has(key(file))) return { size: parsed.get(key(file))?.fileSize, mtimeMs: parsed.get(key(file))?.modifiedAt,
        isDirectory: () => files.get(key(file)) === 'directory', isFile: () => files.get(key(file)) !== 'directory' }
      if (roots.includes(file)) return { isDirectory: () => true, isFile: () => false }
      throw Object.assign(Error('missing'), { code: 'ENOENT' })
    },
    async readdir(folder) {
      reads.push(folder)
      const blocked = [...files].find(([file, state]) => inside(folder, file) && state instanceof Error)
      if (blocked) throw blocked[1]
      const entries = [...files].filter(([file, state]) => key(path.dirname(file)) === key(folder) && !(state instanceof Error))
      if (!entries.length) throw Object.assign(Error('missing directory'), { code: 'ENOENT' })
      return entries.map(([file, state]) => ({ name: path.basename(file), isFile: () => state !== 'directory', isSymbolicLink: () => false }))
    },
  }
  const mocks = {
    'node:path': path,
    './runtime/localFontTagIdentityRuntime': identity,
    './localFontTagIdentityRuntime': identity,
    '../path/pathCanonicalizer': { mappedDriveTableAsync: async () => mappings },
    '../path/pathBoundaryPolicy': load('src/main/path/pathBoundaryPolicy.ts'),
    '../path/cachePath': { normalizePathForCacheCompare: key },
    '../folders/physicalFolders': { pathInsideFolder: inside },
    '../path/sharedFileSystemRuntime': { sharedFileSystem: filesystem, withSharedIoPriority: (_priority, run) => run() },
    '../fonts/fontRuntime': { hasValidFontSignature: async file => parsed.has(key(file)), asFormat: file => /\.(ttf|otf|ttc|otc)$/i.exec(file)?.[1].toLowerCase() || 'unknown', fontItemFromPath: async file => {
      counts.parse++
      if (!parsed.has(key(file))) throw Error('bad font')
      return { ...parsed.get(key(file)) }
    } },
    '../indexing/shared-metadata/sharedMetadataPathsRuntime': { sharedMetadataDbPathForRoot: root => root + '\\metadata.sqlite' },
    '../indexing/shared-metadata/sharedMetadataStateRuntime': { stateFromRow: row => ({ tagNames: JSON.parse(row.tag_names_json) }) },
    '../ipc/sharedActionAdmissionRuntime': { createSharedActionAdmission: () => async () => () => undefined },
    '../app/shutdownCoordinatorRuntime': { applicationWorkEpoch: () => 0, assertApplicationOpen() {} },
  }
  const sharedOwners = require('./check-operation-chain.cjs').loader()
  const sharedIo = sharedOwners('src/main/path/sharedFileSystemRuntime.ts')
  mocks['../path/sharedFileSystemRuntime'] = { ...sharedIo, sharedFileSystem: filesystem }
  mocks['../path/startupPathAvailabilityRuntime'] = sharedOwners('src/main/path/startupPathAvailabilityRuntime.ts')
  const shutdown = sharedOwners('src/main/app/shutdownCoordinatorRuntime.ts')
  mocks['../app/shutdownCoordinatorRuntime'] = shutdown
  mocks['./fontQueryTaskRuntime'] = sharedOwners('src/main/library/fontQueryTaskRuntime.ts')
  const pathsModule = load('src/main/library/tagRecoveryPathRuntime.ts', mocks)
  mocks['./tagRecoveryPathRuntime'] = pathsModule
  mocks['./tagFontBindingRuntime'] = load('src/main/library/tagFontBindingRuntime.ts', mocks)
  const snapshots = load('src/main/library/tagFontSnapshotRuntime.ts', mocks)
  mocks['./tagFontSnapshotRuntime'] = snapshots
  const queryModule = load('src/main/library/tagFontQueryRuntime.ts', mocks)
  mocks['./tagFontQueryRuntime'] = queryModule
  const recoveryModule = load('src/main/library/tagFontRecoveryRuntime.ts', mocks)
  const remember = fonts => {
    snapshots.openTagFontSnapshots(adapter).remember(fonts)
    // Persisted, previously captured whole-file evidence; missing files cannot be hashed now.
    for (const font of fonts) if (font.recoveryContentHash) {
      const row = db.prepare('SELECT font_json FROM tag_font_snapshots WHERE font_path = ?').get(key(font.path))
      if (row) db.prepare('UPDATE tag_font_snapshots SET font_json = ? WHERE font_path = ?').run(JSON.stringify({ ...JSON.parse(row.font_json), recoveryContentHash: font.recoveryContentHash }), key(font.path))
    }
  }
  const add = (font, tags) => { for (const tag of tags) db.prepare('INSERT INTO local_font_tags(font_id, font_path, tag_name) VALUES (?, ?, ?)').run(identity.localTagFontStorageId(font), storageKey(font.path), tag) }
  const put = font => { files.set(key(font.path), true); parsed.set(key(font.path), font) }
  let live = []
  const queryDeps = { appendLog: message => logs.push(message), canReadDetached: async () => true, openLibraryDb: async () => adapter, roots: async () => roots,
    readShared: async input => input.bindingSnapshot ? {bindingSnapshot:{version:1,rows:sharedRows}} : {preflight:{snapshot:{rows:sharedRows}}},
    queryLive: async (_request, limit, offset) => { counts.live++; return { items: live.slice(offset, offset + limit), total: live.length, offset, limit, queryKey: 'tags', engine: 'sql', truncated: false, elapsedMs: 0 } },
    hydrate: async items => { counts.hydrate++; assert(items.every(item => !item.recoveryPlaceholder), 'display-only rows reached install hydration'); return items },
    matches: (font, request) => (!request.keyword || font.fileName.includes(request.keyword)) && (!request.selectedTagName || (request.sidebarPage === 'sharedTags' ? font.tagNames : font.localTagNames || []).includes(request.selectedTagName)),
    compare: (a, b) => a.fileName.localeCompare(b.fileName),
  }
  const query = queryModule.createTagFontQueryRuntime(queryDeps)
  const transactionModule = load('src/main/library/runtime/localFontRecoveryTransactionRuntime.ts', {
    '../../path/cachePath': { normalizePathForCacheCompare: key },
    './localFontTagIdentityRuntime': identity,
    'node:fs': { realpathSync: file => file, readFileSync: file => contents.get(key(file)) || bytesFor(parsed.get(key(file))), statSync: file => { if (files.has(key(file))) return { isDirectory: () => files.get(key(file)) === 'directory' }; if (roots.includes(file)) return { isDirectory: () => true }; throw Object.assign(Error('missing'), { code: 'ENOENT' }) } },
  })
  const persistence = load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts', { ...mocks,
    './localFontRecoveryTransactionRuntime': transactionModule,
  }).createLocalFontTagNodePersistenceRuntime(async () => adapter)
  const persist = async (font, tags) => (await persistence.openWriter()).setLocalFontTags(font, tags, 'historical')
  const events = []
  const runtime = {
    loadLibraryShell: async () => ({ folders: roots }),
    queryFontPageInLibrary: async request => { queryRequests.push(request); return ['library', 'filters'].includes(request.sidebarPage)
      ? { items: [...parsed.values()].slice(request.offset, request.offset + request.limit), total: parsed.size }
      : query.query(request, request.limit || 500, request.offset || 0) },
    refreshWatchedFolder: async (_folder, _root, wait) => { assert.equal(wait, true); events.push('scan-complete'); return refreshReceipt(_root) },
    setLocalFontTagsBatch: async (entries, options) => {
      events.push('write')
      const result = (await persistence.openWriter()).setLocalFontTagsBatch(entries, 'recovery', options)
      if (!result.failed.length) remember(entries.map(entry => entry.item))
      query.invalidate()
      return { ...result, ok: !result.failed.length }
    },
  }
  return { db, adapter, files, roots, parsed, sharedRows, reads, queryRequests, counts, faults, put, add, remember, query, queryModule, recoveryModule, runtime, events,
    pathsModule, mappings, queryDeps, snapshots, filesystem, contents, transactionModule, persistence, persist, sharedIo, shutdown, logs,
    live: fonts => { live = fonts; query.invalidate() }, close: () => { snapshots.disposeTagFontSnapshots(adapter); db.close() } }
}

async function queryCases() {
  const h = harness(), a = make('A'), b = make('B'), c = make('C')
  try {
    h.add(a, ['T']); h.add(b, ['T', 'Other']); h.add(c, ['T']); h.remember([a, b]); h.put(a)
    h.live([{ ...a, localTagNames: ['T'] }])
    assert.equal(h.queryModule.tagQueryScope({ sidebarPage: 'folders', activeFilter: { kind: 'tag', name: 'T' } }), undefined)
    const request = { sidebarPage: 'tags', selectedTagName: 'T' }
    const first = await h.query.query(request, 2, 0), second = await h.query.query(request, 2, 2)
    assert.equal(first.total, 3); assert.equal(second.total, 3)
    assert.deepEqual([...first.items, ...second.items].map(font => font.fileAvailability), ['available', 'missing', 'missing'])
    assert.equal(first.items[1].postscriptName, 'B'); assert.equal(second.items[0].fileName.toLowerCase(), 'c.ttf')
    assert.equal((await h.query.query({ ...request, keyword: 'B' }, 10, 0)).total, 1)
    h.db.prepare('DELETE FROM local_font_tags WHERE font_path = ?').run(storageKey(b.path)); h.query.invalidate()
    assert.equal((await h.query.query(request, 10, 0)).total, 2, 'snapshots cannot resurrect removed bindings')
    h.files.set(key(root), Object.assign(Error('offline'), { code: 'EACCES' })); h.query.invalidate()
    assert.equal((await h.query.query(request, 10, 0)).items.find(font => key(font.path) === key(c.path)).fileAvailability, 'unavailable')
    h.files.set(key(root), Object.assign(Error('moved root'), { code: 'ENOENT' })); h.files.set(key('C:\\'), 'directory')
    assert.equal(await h.queryModule.fontFileAvailability(c.path, [root]), 'missing', 'renaming the watched folder on an online drive is a missing file')
    h.files.delete(key(root)); h.files.delete(key('C:\\')); h.files.set(key(c.path), true); h.query.invalidate()
    assert.equal((await h.query.query(request, 10, 0)).items.length, 2, 'corrupt replacement must not blank the tag')
    h.sharedRows.push({ font_id: 'shared-source', relative_path: 'old/B.ttf', tag_names_json: '["Shared"]' }); h.live([])
    const shared = await h.query.query({ sidebarPage: 'sharedTags', selectedTagName: 'Shared' }, 10, 0)
    assert.equal(shared.total, 1); assert.equal(shared.items[0].sourceId, 'shared-source'); assert.equal(shared.items[0].fileAvailability, 'missing')
  } finally { h.close() }
}

async function recoveryCases() {
  for (const mode of ['reindex', 'relink', 'cancel', 'failure']) {
    const h = harness(), a = make('A'), b = make('B'), nextA = make('A', 'new'), nextB = make('B', 'new')
    try {
      h.add(a, ['T', 'Keep']); h.add(b, ['T']); h.remember([a, b]); h.put(nextA); h.put(nextB); h.add(nextA, ['Existing'])
      let picks = 0
      const service = h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => { picks++; return mode === 'cancel' ? undefined : nextA.path })
      if (mode === 'failure') h.runtime.setLocalFontTagsBatch = async () => ({ ok: false, failed: [{}], message: 'injected disk error' })
      const result = await service.recover(mode === 'reindex' || mode === 'failure' ? { tagName: 'T', scope: 'local', mode: 'reindex' } : { fontPath: a.path, scope: 'local', mode: 'relink' })
      if (mode === 'cancel' || mode === 'failure') {
        assert.equal(result.linked, 0); assert.equal(result.remaining, 2)
        assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(storageKey(a.path)).n, 2)
      } else {
        assert.equal(result.linked, 2); assert.equal(result.remaining, 0)
        assert.deepEqual(h.db.prepare('SELECT tag_name FROM local_font_tags WHERE font_path = ? ORDER BY tag_name').all(storageKey(nextA.path)).map(row => row.tag_name), ['Existing', 'Keep', 'T'])
        assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(storageKey(a.path)).n, 0)
        if (mode === 'relink') assert.equal(picks, 1, 'same-directory siblings should be matched without another dialog')
        else assert.equal(h.events[0], 'scan-complete')
      }
      assert.equal(h.recoveryModule.uniqueRecoveryPairs([a], [nextA, make('A', 'duplicate')]).length, 0)
      assert.equal(h.recoveryModule.uniqueRecoveryPairs([a, make('A', 'other')], [nextA]).length, 0)
      assert.equal(h.recoveryModule.sameRecoveryFont({ ...a, recoveryContentHash: undefined }, nextA), false, 'metadata alone must not confirm recovery')
      assert.equal(h.recoveryModule.sameRecoveryFont({ ...a, postscriptName: '' }, nextA), true, 'whole-file evidence can confirm a legacy name omission')
      assert.equal(h.recoveryModule.sameRecoveryFont(a, { ...nextA, fileSize: 101 }), false)
    } finally { h.close() }
  }
}

async function targetedRecoveryCases() {
  const nas = '\\\\server\\fonts'
  for (const scenario of ['own-root', 'expanded-root', 'own-root-failure']) {
    const h = harness(), old = make('A'), next = make('A', 'new'), scanned = []
    try {
      h.roots.unshift(nas); h.add(old, ['T']); h.remember([old])
      if (scenario !== 'own-root') next.path = nas + '\\new\\A.ttf'
      h.put(next)
      h.runtime.refreshWatchedFolder = async (folder, _root, wait) => {
        assert.equal(wait, true); scanned.push(folder)
        if (scenario === 'own-root-failure' && folder === root) throw Error('root index sync failed')
        if (scenario === 'own-root' && folder === nas) throw Error('unrelated NAS must not run')
        return refreshReceipt(folder)
      }
      const service = h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => { throw Error('reindex opened picker') })
      const result = await service.recover({ mode: 'reindex', scope: 'local', tagName: 'T' })
      assert.equal(result.linked, 1); assert.equal(result.remaining, 0)
      assert.deepEqual(scanned, scenario === 'own-root' ? [root] : [root, nas])
      assert.equal(result.failures.length, scenario === 'own-root-failure' ? 1 : 0)
    } finally { h.close() }
  }
  const h = harness(), a = make('A'), b = make('B'), c = make('C', 'elsewhere'), nextB = make('B', 'new'), chosen = []
  try {
    for (const font of [a, b, c]) { h.add(font, ['T']); h.remember([font]) }
    h.put(nextB)
    const service = h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async font => { chosen.push(font.path); return nextB.path })
    const result = await service.recover({ mode: 'relink', scope: 'local', fontPath: b.path })
    assert.deepEqual(chosen.map(key), [key(b.path)], 'only the clicked card opens a dialog')
    assert.equal(result.linked, 1); assert.equal(result.remaining, 1, 'unmatched sibling stays without a second picker')
    assert.match(result.message, /未全部完成/, 'unmatched files must not claim complete recovery')
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(storageKey(c.path)).n, 1)
    await assert.rejects(service.recover({ mode: 'relink', scope: 'local', fontPath: 'C:\\invented.ttf' }), /此字体已恢复/)
    assert.equal(chosen.length, 1, 'unknown renderer path must not open a picker')
  } finally { h.close() }
}

async function batchedAvailabilityCase() {
  const h = harness()
  try {
    const fonts = Array.from({ length: 26 }, (_, i) => make('Missing' + i))
    for (const font of fonts) { h.add(font, ['T']); h.remember([font]) }
    const request = { sidebarPage: 'tags', selectedTagName: 'T' }
    const pages = await Promise.all([h.query.query(request, 10, 0), h.query.query(request, 10, 10)])
    assert(pages.every(page => page.total === 26)); assert.equal(h.reads.length, 1, 'siblings and simultaneous pages share one directory read')
    h.put(fonts[0]); h.query.invalidate()
    const refreshed = await h.query.query(request, 100, 0)
    assert.equal(refreshed.items.find(font => key(font.path) === key(fonts[0].path)).fileAvailability, 'available')
    assert.equal(h.reads.length, 2, 'invalidation must recheck restored files')
  } finally { h.close() }
}

async function bulkRecoveryCases() {
  for (const failWrite of [false, true]) {
    const h = harness(), originals = Array.from({ length: 26 }, (_, i) => make('W' + i)), replacements = originals.map(font => make(font.family, 'new'))
    try {
      for (const font of originals) { h.add(font, ['T', 'Keep']); h.remember([font]) }
      for (const font of replacements) h.put(font)
      const unrelated = make('Unrelated', 'elsewhere'); h.add(unrelated, ['Other']); h.remember([unrelated]); h.put(unrelated)
      let writes = 0
      const originalWrite = h.runtime.setLocalFontTagsBatch
      h.runtime.setLocalFontTagsBatch = async (entries, options) => {
        writes++; assert.equal(entries.length, 52)
        return failWrite ? { ok: false, failed: [{}], message: 'disk denied' } : originalWrite(entries, options)
      }
      const service = h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async font => {
        assert.equal(key(font.path), key(originals[8].path))
        assert.equal(h.counts.live, 0, 'picker must not wait for a full live index query')
        assert.equal(h.counts.hydrate, 0, 'picker must not wait for install/preview hydration')
        assert(h.reads.every(folder => key(folder) === key(path.dirname(font.path))), 'unrelated font directories read before picker')
        return replacements[8].path
      })
      const result = await service.recover({ mode: 'relink', scope: 'local', fontPath: originals[8].path })
      assert.equal(writes, 1, '26 files must use one local tag transaction/notification')
      assert.equal(result.linked, failWrite ? 0 : 26); assert.equal(result.remaining, failWrite ? 26 : 0)
      assert.equal(h.counts.parse, 0, 'unchanged indexed candidates must not be reparsed')
      assert.equal(h.counts.live, 0); assert.equal(h.counts.hydrate, 0)
      assert.equal(h.queryRequests.filter(r => r.tagBindingsOnly && r.sidebarPage === 'tags').length, 3, 'source/destination tags must not be reread per file')
      assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(storageKey(originals[0].path)).n, failWrite ? 2 : 0)
    } finally { h.close() }
  }
  const h = harness(), old = make('A'), next = make('A', 'new')
  try {
    h.add(old, ['T']); h.remember([old]); h.put(next)
    const originalQuery = h.runtime.queryFontPageInLibrary
    h.runtime.queryFontPageInLibrary = async request => {
      const result = await originalQuery(request)
      return request.sidebarPage === 'filters' ? { ...result, items: result.items.map(font => ({ ...font, modifiedAt: 0 })) } : result
    }
    let release, opened
    let ready = new Promise(resolve => { opened = resolve })
    const service = h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => { opened(); return new Promise(resolve => { release = resolve }) })
    const request = { mode: 'relink', scope: 'local', fontPath: old.path }
    const first = service.recover(request); await ready
    const busy = await service.recover(request)
    assert.equal(busy.busy, true); assert.equal(h.events.length, 0)
    release(undefined); assert.equal((await first).canceled, true)
    ready = new Promise(resolve => { opened = resolve })
    const second = service.recover(request); await ready
    release(undefined); assert.equal((await second).canceled, true, 'cancel must release the in-flight guard')
    const finishService = h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => next.path)
    const result = await finishService.recover(request)
    assert.equal(result.linked, 1); assert.equal(h.counts.parse, 1, 'stale index metadata must trigger actual parsing')
  } finally { h.close() }
}

async function sharedRecoveryCases() {
  for (const failDestination of [false, true]) {
    const h = harness(), old = make('A'), next = make('A', 'new'), writes = []
    try {
      h.remember([old]); h.put(next)
      h.sharedRows.push({ font_id: 'old-metadata-id', relative_path: path.relative(root, old.path), tag_names_json: '["T","Keep"]' })
      h.sharedRows.push({ font_id: 'target-metadata-id', relative_path: path.relative(root, next.path), tag_names_json: '["Existing"]' })
      h.runtime.setSharedFontTagsBatchInIndex = async entries => {
        for (const { item } of entries) {
          const mode = item.__sharedTagWriteMode, tag = item.__sharedTagWriteTag
          writes.push(mode)
          if (failDestination && mode === 'add') return { ok: false, failed: [{}], message: 'target denied' }
          const row = h.sharedRows.find(row => key(path.resolve(root, row.relative_path)) === key(item.path))
          const tags = new Set(JSON.parse(row.tag_names_json))
          if (mode === 'add') tags.add(tag)
          else { assert.equal(item.sourceId, 'old-metadata-id'); tags.delete(tag) }
          row.tag_names_json = JSON.stringify([...tags])
        }
        h.query.invalidate(); return { ok: true, failed: [], updatedIds: entries.map(entry => entry.item.id) }
      }
      const service = h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => next.path)
      const result = await service.recover({ fontPath: old.path, scope: 'shared', mode: 'relink' })
      if (failDestination) {
        assert.equal(result.linked, 0); assert(!writes.includes('remove'))
        assert.deepEqual(JSON.parse(h.sharedRows[0].tag_names_json), ['T', 'Keep'])
      } else {
        assert.equal(result.linked, 1); assert.equal(result.remaining, 0)
        assert.deepEqual(writes, ['add', 'add', 'remove', 'remove'])
        assert.deepEqual(JSON.parse(h.sharedRows[0].tag_names_json), [])
        assert.deepEqual(JSON.parse(h.sharedRows[1].tag_names_json).sort(), ['Existing', 'Keep', 'T'])
      }
    } finally { h.close() }
  }
  const matcher = load('src/main/indexing/shared-metadata/sharedMetadataEntryMatchRuntime.ts', { 'node:path': path })
  const old = { ...make('A'), sourceId: 'persisted-source-id', fileAvailability: 'missing' }
  const matched = matcher.findSharedMetadataMatchedEntry({ cacheEntryRuntimePath: (root, relative) => path.resolve(root, relative), cacheKeyForRootFile: (root, file) => path.relative(root, file), normalizePathForCacheCompare: key }, root, { cache: { entries: {} } }, old)
  assert.equal(matched.font.id, 'persisted-source-id', 'orphan cleanup must address its original metadata row')
}

async function detachedAuthorizationCase() {
  const h = harness(), font = make('A')
  let modifiedAt = font.modifiedAt, real = font.path, denied = false, bytes = bytesFor(font)
  try {
    const module = load('src/main/library/tagRelinkAuthorizationRuntime.ts', {
      '../path/cachePath': { normalizePathForCacheCompare: key },
      '../path/sharedFileSystemRuntime': { sharedFileSystem: { realpath: async () => real, readFile: async () => bytes, stat: async () => {
        if (denied) throw Object.assign(Error('offline'), { code: 'EACCES' })
        return { isFile: () => true, size: font.fileSize, mtimeMs: modifiedAt }
      } } },
    })
    const service = module.createTagRelinkAuthorizationRuntime(async () => h.adapter)
    await service.rememberRelinkedFontFile(font)
    assert.equal(await service.contains(font.path), false, 'a credential without tag membership must not grant access')
    assert.equal(await service.readDetachedState(font.path), 'unknown')
    h.add(font, ['T'])
    assert.equal(await service.contains(font.path), true)
    const restored = module.createTagRelinkAuthorizationRuntime(async () => h.adapter)
    assert.equal(await restored.canReadDetached(font.path), true)
    assert.equal(await restored.readDetachedState(font.path), 'authorized')
    modifiedAt++
    assert.equal(await restored.contains(font.path), false, 'replaced files require explicit authorization again')
    assert.equal(await restored.readDetachedState(font.path), 'changed')
    modifiedAt--
    bytes = Buffer.from(bytes); bytes[bytes.length - 1] = 1
    assert.equal(await restored.readDetachedState(font.path), 'changed', 'same-size/same-time content replacement needs new authorization')
    bytes = bytesFor(font)
    denied = true; assert.equal(await restored.readDetachedState(font.path), 'unknown', 'offline is not reauthorization'); denied = false
    real = 'D:\\new-target.ttf'
    assert.equal(await restored.readDetachedState(font.path), 'changed', 'changed real-path target needs a new picker')
    assert.equal(await restored.contains(real), false, 'changed real path must not grant file access')
    await restored.rememberRelinkedFontFile(font)
    assert.equal(await restored.contains(real),true)
    assert.equal(await restored.contains(font.path),false,'same-path renewed credential must retire its superseded real target')
    real = font.path
    h.db.exec('DELETE FROM local_font_tags')
    assert.equal(await restored.contains(font.path), false)
    assert.equal(await restored.readDetachedState(font.path), 'unknown')
  } finally { h.close() }
}

async function backgroundWaitCase() {
  const { createManualFolderRefreshBackgroundRuntime } = load('src/main/watcher/manual-refresh/manualFolderRefreshBackgroundRuntime.ts')
  const runtime = createManualFolderRefreshBackgroundRuntime({ appendStartupLog() {} })
  let finish, done = false
  runtime.scheduleRefresh('root', 'job', () => new Promise(resolve => { finish = resolve }))
  const waiting = runtime.waitForRefresh('root').then(result => { done = true; return result })
  const receipt = refreshReceipt('root', { ok: false, errors: 2 })
  await Promise.resolve(); assert.equal(done, false); finish(receipt); assert.equal(await waiting, receipt); assert.equal(done, true)
  const error = Error('failed scan')
  runtime.scheduleRefresh('other', 'failed', async () => { throw error })
  await assert.rejects(runtime.waitForRefresh('other'), value => value === error)
}

async function f08QueryCases() {
  const h = harness(), font = make('History')
  try {
    h.sharedRows.push({ font_id: 'history', relative_path: 'old/History.ttf', tag_names_json: '["Shared"]' })
    const request = { sidebarPage: 'sharedTags', selectedTagName: 'Shared' }
    const first = await h.query.query(request, 10, 0)
    assert.equal(first.total, 1); assert.equal(first.items[0].fileAvailability, 'missing')
    assert.equal((await h.query.sharedTagCounts()).Shared, 1, 'missing shared bindings must remain in sidebar counts')
    h.queryDeps.readShared = async () => { throw Error('metadata busy') }
    h.queryDeps.queryLive = async () => { throw Error('unavailable root must not reach live query') }
    h.query.invalidate()
    const retained = await h.query.query(request, 10, 0)
    assert.equal(retained.total, 1); assert.equal(retained.items[0].tagBindingReadOnly, true)
    assert.equal(retained.items[0].fileAvailability, 'unavailable')
    await assert.rejects(h.query.sharedTagCounts(), /metadata busy/, 'offline cache cannot certify fresh counts')
    const display = load('src/renderer/src/fontDisplay.ts', { './fontUserIntentRuntime': { getUninstallIssue: () => undefined } })
    assert.equal(display.installLabel(retained.items[0]), '共享标签暂不可读取')
    await assert.rejects(h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => { throw Error('must not open') })
      .recover({ mode: 'relink', scope: 'shared', fontPath: retained.items[0].path }), /此字体已恢复/)
    // A successful authoritative empty snapshot removes the old binding.
    h.sharedRows.length = 0
    h.queryDeps.readShared = async input => input.bindingSnapshot ? {bindingSnapshot:{version:1,rows:h.sharedRows}} : {preflight:{snapshot:{rows:h.sharedRows}}}
    h.queryDeps.queryLive = async () => ({ items: [], total: 0 })
    h.query.invalidate(); assert.equal((await h.query.query(request, 10, 0)).total, 0)
    assert.deepEqual(plain(await h.query.sharedTagCounts()), {})
  } finally { h.close() }
  const d = harness(), outside = { ...make('Outside'), path: 'D:\\Outside\\Outside.ttf' }
  try {
    d.add(outside, ['T']); d.remember([outside]); d.put(outside)
    d.queryDeps.readDetachedState = async () => 'changed'
    const page = await d.query.query({ sidebarPage: 'tags', selectedTagName: 'T', tagBindingsOnly: true }, 10, 0)
    assert.equal(page.total, 1); assert.equal(page.items[0].fileRelinkRequired, true)
    assert.equal(page.items[0].fileAvailability, 'unavailable')
    assert.equal(d.counts.parse, 0, 'unconfirmed changed file must not be parsed/previewed by a query')
    d.files.set(key(outside.path), Object.assign(Error('denied'), { code: 'EACCES' })); d.query.invalidate()
    const offline = await d.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0)
    assert.equal(offline.items[0].fileRelinkRequired, false, 'access failure is not permission to reauthorize')
  } finally { d.close() }
  const stale = harness(), liveFont = make('Stale'), legacy = make('Legacy')
  try {
    stale.add(liveFont, ['T']); stale.remember([liveFont]); stale.put(liveFont)
    stale.db.prepare('INSERT INTO local_font_tags(font_id, font_path, tag_name) VALUES (?, NULL, ?)').run(legacy.id, 'T'); stale.put(legacy)
    stale.live([{ ...liveFont, localTagNames: ['T'] }, { ...legacy, localTagNames: ['T'] }])
    assert.equal((await stale.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0)).total, 2)
    stale.db.prepare('DELETE FROM local_font_tags WHERE font_path = ?').run(storageKey(liveFont.path)); stale.query.invalidate()
    const page = await stale.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0)
    // The query returns a VM array; compare its data in this realm, as above.
    assert.deepEqual(plain(page.items.map(font => font.id)), [legacy.id], 'stale live pages and history must not resurrect a deleted path binding; ID-only legacy membership remains')
  } finally { stale.close() }
  const mixed = harness(), blocked = '\\\\server\\blocked'
  try {
    mixed.roots.push(blocked)
    mixed.queryDeps.readShared = async ({rootPath,bindingSnapshot}) => {
      if (rootPath===blocked) throw Error('offline without historical metadata')
      const rows=[{font_id:'healthy',relative_path:'old/A.ttf',tag_names_json:'["Shared"]'}]
      return bindingSnapshot ? {bindingSnapshot:{version:1,rows}} : {preflight:{snapshot:{rows}}}
    }
    mixed.queryDeps.queryLive = async request => {
      assert.deepEqual(plain(request.selectedWatchedFolders), [root], 'failed shared root must be excluded from the live page range')
      return {items:[],total:0}
    }
    assert.equal((await mixed.query.query({sidebarPage:'sharedTags',selectedTagName:'Shared',selectedWatchedFolders:[root,blocked]},10,0)).total,1)
    await assert.rejects(mixed.query.sharedTagCounts(), /offline/, 'unknown membership must not become zero')
  } finally { mixed.close() }
  const p = harness()
  try {
    p.mappings.set('R:', '\\\\server\\share')
    const paths = await p.pathsModule.createTagRecoveryPaths(['R:\\Fonts', '\\\\server\\share\\Fonts', '\\\\server\\share\\Fonts\\Nested'])
    assert.equal(paths.roots.length, 2, 'proven aliases should scan once')
    assert.equal(paths.owner('R:\\Fonts\\Nested\\gone.ttf'), '\\\\server\\share\\Fonts\\Nested')
    assert.equal(paths.contains('\\\\?\\UNC\\server\\share\\Fonts\\A.ttf'), true)
    assert.equal(paths.contains('R:\\FontsElsewhere\\A.ttf'), false)
    p.roots.splice(0,p.roots.length,'\\\\server\\share\\Fonts')
    p.db.exec('CREATE TABLE tag_shared_binding_snapshots (root_path TEXT PRIMARY KEY, rows_json TEXT NOT NULL)')
    p.db.prepare('INSERT INTO tag_shared_binding_snapshots VALUES (?, ?)').run(key('R:\\Fonts'),JSON.stringify([{font_id:'legacy-alias',relative_path:'A.ttf',tag_names_json:'["Shared"]'}]))
    p.queryDeps.readShared=async()=>{throw Error('offline')}
    const retained=await p.query.query({sidebarPage:'sharedTags',selectedTagName:'Shared'},10,0)
    assert.equal(retained.total,1);assert.equal(retained.items[0].tagBindingReadOnly,true,'legacy snapshot root keys must survive a proven alias change')
    p.mappings.clear()
    assert.equal((await p.pathsModule.createTagRecoveryPaths(['\\\\server\\share\\Fonts'])).owner('R:\\Fonts\\A.ttf'), undefined, 'unverified drive identity must not guess a root')
  } finally { p.close() }
}

async function f08RecoveryCases() {
  const alias = harness(), old = make('A'), next = make('A','new'), scanned=[]
  try {
    alias.mappings.set('R:','\\\\server\\share')
    alias.roots.splice(0,alias.roots.length,'\\\\unrelated\\nas','R:\\Fonts','\\\\server\\share\\Fonts','\\\\server\\share\\Fonts\\Nested')
    old.path='R:\\Fonts\\Nested\\old\\A.ttf';next.path='R:\\Fonts\\Nested\\new\\A.ttf'
    alias.add(old,['T']);alias.remember([old]);alias.put(next)
    alias.runtime.refreshWatchedFolder=async folder=>{scanned.push(folder);return refreshReceipt(folder)}
    const result=await alias.recoveryModule.createTagFontRecoveryRuntime(alias.runtime,async()=>undefined).recover({mode:'reindex',scope:'local',tagName:'T'})
    assert.equal(result.linked,1);assert.deepEqual(scanned,['\\\\server\\share\\Fonts\\Nested'],'the longest proven owner is scanned first, and unrelated roots are not scanned after recovery')
  } finally { alias.close() }
  for (const cancelled of [false, true]) {
    const h = harness(), old = make('A'), next = make('A', 'new')
    try {
      h.add(old, ['T']); h.remember([old]); h.put(next)
      h.runtime.refreshWatchedFolder = async () => refreshReceipt(root, { ok: false, errors: cancelled ? 0 : 2, cancelled, message: 'partial scan' })
      const result = await h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => undefined).recover({ mode: 'reindex', scope: 'local', tagName: 'T' })
      assert.equal(result.canceled, cancelled)
      assert.equal(result.linked, cancelled ? 0 : 1)
      assert.equal(result.failures.length, cancelled ? 0 : 1, 'partial scan errors must not turn into clean success')
      if (cancelled) assert(!h.events.includes('write'))
      else assert.match(result.message, /未全部完成/)
    } finally { h.close() }
  }
  const partial = harness(), a = make('A'), b = make('B'), replacement = make('A','new'), nas = '\\\\server\\fallback'
  try {
    partial.roots.push(nas);partial.add(a,['T']);partial.add(b,['T']);partial.remember([a,b]);partial.put(replacement)
    partial.runtime.refreshWatchedFolder=async folder=>refreshReceipt(folder,folder===nas?{ok:false,cancelled:true}:{})
    const result=await partial.recoveryModule.createTagFontRecoveryRuntime(partial.runtime,async()=>undefined).recover({mode:'reindex',scope:'local',tagName:'T'})
    assert.equal(result.linked,1);assert.equal(result.remaining,1);assert.equal(result.canceled,true)
    assert.match(result.message,/已取消重新索引/)
  } finally { partial.close() }
  const h = harness(), outside = { ...make('Changed'), path: 'D:\\Outside\\Changed.ttf' }
  try {
    h.add(outside, ['T', 'Keep']); h.remember([outside]); h.put(outside)
    h.queryDeps.readDetachedState = async () => 'changed'
    let renewals = 0, picks = 0
    h.runtime.rememberRelinkedFontFile = async font => {
      renewals++; assert.equal(key(font.path), key(outside.path)); h.queryDeps.readDetachedState = async () => 'authorized'
    }
    const result = await h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => { picks++; return outside.path })
      .recover({ mode: 'relink', scope: 'local', fontPath: outside.path })
    assert.equal(result.linked, 1); assert.equal(result.remaining, 0); assert.equal(renewals, 1); assert.equal(picks, 1)
    assert.deepEqual(h.db.prepare('SELECT tag_name FROM local_font_tags WHERE font_path = ? ORDER BY tag_name').all(storageKey(outside.path)).map(row => row.tag_name), ['Keep', 'T'], 'same-path confirmation must not append a clear-old operation')
    const page = await h.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0)
    assert.equal(page.items[0].fileRelinkRequired, false); assert.equal(page.items[0].fileAvailability, 'available')
  } finally { h.close() }
}

async function f08RefreshCases() {
  const backgroundModule = load('src/main/watcher/manual-refresh/manualFolderRefreshBackgroundRuntime.ts')
  const module = load('src/main/watcher/manual-refresh/manualWatchedFolderRefreshRuntime.ts', {
    'node:path': path,
    '../../path/sharedFileSystemRuntime': { sharedFileSystem: { stat: async () => ({ isDirectory: () => true }) } },
    '../../folders/physicalFolders': { pathInsideFolder: inside },
  })
  for (const scenario of ['complete', 'partial', 'cancelled', 'failed']) {
    let release, runs = 0
    const gate = new Promise(resolve => { release = resolve }), log = [], progress = []
    let snapshots = 0
    const deps = { appendStartupLog: message => log.push(message), withGlobalIo: (_name, run) => run(), emitFontIndexProgress: p => progress.push(p),
      createFontScanJobId: () => 'job', appWatchedFolders: async () => [root], findBestWatchedRootForFile: () => root,
      scanFoldersRuntime: () => ({ scanFoldersManaged: async () => { runs++; await gate; return { fonts: [make('A')], errors: [], stats: { cancelled: true } } } }),
      sendFontIndexChanged() {}, syncMergedIndexForRootSnapshot: async () => { snapshots++ }, syncMergedIndexForRootIncremental: async () => {} }
    const runtime = module.createManualWatchedFolderRefreshRuntime(deps,
      { repairRootIndexCacheIfNeeded: async () => ({ rebuildRequired: scenario === 'cancelled' }), repairRootPreviewCacheIfNeeded: async () => ({}) },
      { applyManualFolderRefreshToIndex: async () => { runs++; await gate; if (scenario === 'failed') throw Error('injected scan failure')
        return { payload: { upserts: [], deletes: [], errors: scenario==='partial'?[{ path: 'bad', message: 'denied' }]:[] }, totalFiles: 12, parsed: 2, fromCache: 10, skippedBad: 0, workerCount: 1 } } },
      backgroundModule.createManualFolderRefreshBackgroundRuntime(deps))
    const first = runtime.refreshWatchedFolder(root, root, true)
    // Wait for scheduling without completing the controlled scan.
    for (let i = 0; i < 12; i++) await Promise.resolve()
    const second = runtime.refreshWatchedFolder(root, root, true)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    release()
    if (scenario === 'failed') {
      const settled = await Promise.allSettled([first, second]); assert(settled.every(item => item.status === 'rejected')); assert.equal(runs, 1)
    } else {
      const [a, b] = await Promise.all([first, second]); assert.equal(runs, 1); assert.equal(a, b)
      assert.notEqual(a.mode, 'background'); assert.equal(a.ok, scenario==='complete')
      assert.equal(a.errors, scenario === 'partial' ? 1 : 0); assert.equal(!!a.cancelled, scenario === 'cancelled')
      assert.equal(a.totalFiles, scenario === 'cancelled' ? 0 : 12)
      assert.equal(snapshots,0,'cancelled rebuild must not publish a complete merged snapshot')
      assert(progress.some(p => p.stage === (scenario === 'cancelled' ? 'cancelled' : 'done')))
    }
  }
}

async function f09MatchCases() {
  for (const scenario of ['renamed', 'collection', 'insufficient', 'quick-only', 'different-bytes', 'ambiguous', 'different-weight']) {
    const h = harness(), old = make('A'), next = { ...make('A', 'new'), fileName: 'renamed.ttf', path: `${root}\\new\\renamed.ttf` }
    try {
      if (scenario === 'collection') {
        old.format = next.format = 'ttc'
        old.fileName = 'A.ttc'; old.path = `${root}\\old\\A.ttc`
        next.fileName = 'renamed.ttc'; next.path = `${root}\\new\\renamed.ttc`
        old.recoveryContentHash = hashFor(old)
      }
      if (scenario === 'insufficient') old.recoveryContentHash = undefined
      if (scenario === 'quick-only') old.recoveryContentHash = 'fnv1a64:1234567890abcdef'
      if (scenario === 'different-weight') next.style = 'Bold'
      h.add(old, ['T']); h.remember([old]); h.put(next)
      if (scenario === 'different-bytes') { const bytes = bytesFor(next); bytes[bytes.length - 1] = 1; h.contents.set(key(next.path), bytes) }
      if (scenario === 'ambiguous') h.put({ ...next, id: 'duplicate', path: `${root}\\copy\\renamed.ttf` })
      const before = h.db.prepare('SELECT * FROM local_font_tags').all()
      const result = await h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => { throw Error('automatic recovery must not open a picker') })
        .recover({ mode: 'reindex', scope: 'local', tagName: 'T' })
      const success = ['renamed', 'collection'].includes(scenario)
      assert.equal(result.linked, success ? 1 : 0, scenario)
      assert.equal(result.remaining, success ? 0 : 1, scenario)
      if (!success) {
        assert.deepEqual(h.db.prepare('SELECT * FROM local_font_tags').all(), before, `${scenario}: preserve original membership`)
        assert.match(result.unresolved[0].reason, ['insufficient','quick-only'].includes(scenario) ? /证据不足/ : scenario === 'ambiguous' ? /多个候选/ : /未找到/)
      }
    } finally { h.close() }
  }
  const h = harness(), a = make('A'), b = make('B'), nextA = make('A','new'), nextB = { ...make('B','new'), path: `${root}\\new\\renamed-B.ttf`, fileName: 'renamed-B.ttf' }
  try {
    for (const font of [a,b]) { h.add(font,['T']); h.remember([font]) }
    for (const font of [nextA,nextB,make('Unrelated','new')]) h.put(font)
    let picks = 0, writes = 0
    const write = h.runtime.setLocalFontTagsBatch
    h.runtime.setLocalFontTagsBatch = (entries, options) => { writes++; return write(entries, options) }
    const result = await h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => { picks++; return nextA.path })
      .recover({ mode:'relink',scope:'local',fontPath:a.path })
    assert.equal(result.linked,2); assert.equal(picks,1); assert.equal(writes,1)
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(storageKey(nextB.path)).n,1)
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(storageKey(make('Unrelated','new').path)).n,0)
  } finally { h.close() }
}

async function f09AliasCase() {
  const h=harness(), old=make('A'), mapped=make('A','new'), unc=make('A','new')
  try {
    h.mappings.set('R:','\\\\server\\share')
    h.roots.splice(0,h.roots.length,'R:\\Fonts','\\\\server\\share\\Fonts')
    old.path='R:\\Fonts\\old\\A.ttf'
    mapped.path='R:\\Fonts\\new\\A.ttf';unc.path='\\\\server\\share\\Fonts\\new\\A.ttf';unc.id='unc-target'
    h.add(old,['T']);h.remember([old]);h.put(mapped);h.put(unc)
    const realpath=h.filesystem.realpath
    h.filesystem.realpath=async file=>/^r:/i.test(file)?file.replace(/^r:/i,'\\\\server\\share'):realpath(file)
    const result=await h.recoveryModule.createTagFontRecoveryRuntime(h.runtime,async()=>undefined).recover({mode:'reindex',scope:'local',tagName:'T'})
    assert.equal(result.linked,1,'proven mapped/UNC aliases are one candidate, independent content copies remain ambiguous')
    assert.equal(result.remaining,0)
  } finally { h.close() }
}

async function f09CommitCases() {
  for (const scenario of ['source-edit', 'target-edit', 'target-replaced', 'source-reappeared', 'same-content', 'existing-favorite', 'manual-substitute']) {
    const h = harness(), old = make('A'), next = make(scenario === 'manual-substitute' ? 'Other' : 'A','new')
    try {
      h.add(old,['T']); h.remember([old]); h.put(next)
      h.db.exec('CREATE TABLE local_font_favorites(font_id TEXT PRIMARY KEY,font_path TEXT,favorite INTEGER); CREATE TABLE local_font_protection(font_path TEXT PRIMARY KEY,protected INTEGER)')
      h.db.prepare('INSERT INTO local_font_favorites VALUES (?,?,1)').run('source',key(old.path))
      h.db.prepare('INSERT INTO local_font_protection VALUES (?,1)').run(key(old.path))
      if (scenario === 'existing-favorite') h.db.prepare('INSERT INTO local_font_favorites VALUES (?,?,0)').run('legacy-target',key(next.path))
      const write = h.runtime.setLocalFontTagsBatch
      h.runtime.setLocalFontTagsBatch = async (entries, options) => {
        if (scenario === 'source-edit') h.add(old,['Concurrent'])
        if (scenario === 'target-edit') h.add(next,['Concurrent'])
        if (scenario === 'target-replaced') { const bytes = bytesFor(next); bytes[bytes.length-1] = 1; h.contents.set(key(next.path),bytes) }
        if (scenario === 'source-reappeared') h.put(old)
        return write(entries,options)
      }
      const result = await h.recoveryModule.createTagFontRecoveryRuntime(h.runtime,async()=>next.path).recover({mode:'relink',scope:'local',fontPath:old.path})
      const success = ['same-content','existing-favorite','manual-substitute'].includes(scenario)
      assert.equal(result.linked, success ? 1 : 0, scenario)
      if (!success) {
        assert(result.failures.length,scenario)
        assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ? AND tag_name = ?').get(storageKey(old.path),'T').n,1)
        assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ? AND tag_name = ?').get(storageKey(next.path),'T').n,0)
      }
      const favorite = h.db.prepare('SELECT favorite FROM local_font_favorites WHERE font_path = ?').get(key(next.path))
      const protection = h.db.prepare('SELECT protected FROM local_font_protection WHERE font_path = ?').get(key(next.path))
      assert.equal(!!favorite, ['same-content','existing-favorite'].includes(scenario)); assert.equal(!!protection, ['same-content','existing-favorite'].includes(scenario))
      if (scenario === 'existing-favorite') {
        assert.equal(favorite.favorite,0,'explicit target cancellation must not be overwritten')
        assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_favorites WHERE font_path = ?').get(key(next.path)).n,1)
      }
      assert.equal(h.db.prepare('SELECT favorite FROM local_font_favorites WHERE font_path = ?').get(key(old.path)).favorite,1,'retain source state for another scope/retry')
      assert.equal(h.db.prepare('SELECT protected FROM local_font_protection WHERE font_path = ?').get(key(old.path)).protected,1)
    } finally { h.close() }
  }
}

async function f09SharedCases() {
  const h = harness(), old = make('A'), next = make('A','new')
  try {
    h.add(old,['Local']);h.remember([old]);h.put(next)
    h.sharedRows.push({font_id:'source',relative_path:path.relative(root,old.path),tag_names_json:'["T","Keep"]'})
    h.sharedRows.push({font_id:'target',relative_path:path.relative(root,next.path),tag_names_json:'["Existing"]'})
    let failRemove = true
    h.runtime.setSharedFontTagsBatchInIndex = async entries => {
      for (const {item} of entries) {
        if (failRemove && item.__sharedTagWriteMode==='remove') { failRemove=false; return {ok:false,failed:[{}],message:'source temporarily denied'} }
        const row=h.sharedRows.find(row=>key(path.resolve(root,row.relative_path))===key(item.path))
        const tags=new Set(JSON.parse(row.tag_names_json))
        if (item.__sharedTagWriteMode==='add') tags.add(item.__sharedTagWriteTag); else tags.delete(item.__sharedTagWriteTag)
        row.tag_names_json=JSON.stringify([...tags]);h.query.invalidate()
      }
      return {ok:true,failed:[],updatedIds:entries.map(entry=>entry.item.id)}
    }
    const service=h.recoveryModule.createTagFontRecoveryRuntime(h.runtime,async()=>next.path)
    const request={mode:'relink',scope:'shared',fontPath:old.path}
    const partial=await service.recover(request)
    assert.equal(partial.linked,0);assert.equal(partial.remaining,1);assert(partial.failures.length)
    assert.deepEqual(JSON.parse(h.sharedRows[0].tag_names_json),['T','Keep'])
    assert.deepEqual(JSON.parse(h.sharedRows[1].tag_names_json).sort(),['Existing','Keep','T'])
    const retry=await service.recover(request)
    assert.equal(retry.linked,1);assert.equal(retry.remaining,0);assert.equal(retry.scope,'shared')
    assert.equal(retry.pendingAssociations.length,1);assert.match(retry.message,/本地标签仍在原路径/)
    assert.equal((await h.query.query({sidebarPage:'tags',selectedTagName:'Local'},10,0)).total,1,'other scope remains reachable from its original card')
    assert.deepEqual(JSON.parse(h.sharedRows[1].tag_names_json).sort(),['Existing','Keep','T'])
  } finally { h.close() }

  for (const scenario of ['source-edit','target-readback','target-replaced','source-reappeared','state-failed']) {
    const h=harness(), old=make('A'), next=make('A','new')
    try {
      h.remember([old]);h.put(next)
      h.sharedRows.push({font_id:'source',relative_path:path.relative(root,old.path),tag_names_json:'["T","Keep"]'})
      h.sharedRows.push({font_id:'target',relative_path:path.relative(root,next.path),tag_names_json:'[]'})
      let additions=0, removals=0
      h.runtime.setSharedFontTagsBatchInIndex=async entries=>{
        for (const {item} of entries) {
          const row=h.sharedRows[item.__sharedTagWriteMode==='add'?1:0]
          if(item.__sharedTagWriteMode==='remove') removals++
          else {
            additions++
            if(scenario!=='target-readback') row.tag_names_json=JSON.stringify([...new Set([...JSON.parse(row.tag_names_json),item.__sharedTagWriteTag])])
            if(additions===2) {
              if(scenario==='source-edit') h.sharedRows[0].tag_names_json='["T","Keep","Concurrent"]'
              if(scenario==='source-reappeared') h.put(old)
              if(scenario==='target-replaced') { const bytes=bytesFor(next);bytes[99]=1;h.contents.set(key(next.path),bytes) }
            }
          }
          h.query.invalidate()
        }
        return {ok:true,failed:[],updatedIds:[]}
      }
      if(scenario==='state-failed') h.runtime.setLocalFontTagsBatch=async()=>({ok:false,failed:[],message:'state transaction denied'})
      const result=await h.recoveryModule.createTagFontRecoveryRuntime(h.runtime,async()=>next.path).recover({mode:'relink',scope:'shared',fontPath:old.path})
      assert.equal(result.linked,0,scenario);assert(result.failures.length,scenario);assert.equal(removals,0,scenario)
      assert(JSON.parse(h.sharedRows[0].tag_names_json).includes('T'),`${scenario}: do not remove source before all confirmations`)
    } finally { h.close() }
  }
}

async function f09EvidenceCases() {
  const h=harness(), font=make('Capture')
  try {
    h.put(font)
    const snapshots=h.snapshots.openTagFontSnapshots(h.adapter)
    snapshots.remember([{...font,recoveryContentHash:'f'.repeat(64)}])
    assert.equal(snapshots.read(font.path).recoveryContentHash,undefined,'renderer metadata cannot manufacture evidence')
    await snapshots.capture([font])
    assert.equal(snapshots.read(font.path).recoveryContentHash,hashFor(font))
    snapshots.remember([{...font,recoveryContentHash:'f'.repeat(64)}])
    assert.equal(snapshots.read(font.path).recoveryContentHash,hashFor(font),'untrusted metadata cannot replace stored proof')
    const changed=bytesFor(font);changed[99]=1;h.contents.set(key(font.path),changed)
    const stat=h.filesystem.stat;h.filesystem.stat=async file=>({...await stat(file),ctimeMs:2})
    await snapshots.capture([font])
    const changedHash=crypto.createHash('sha256').update(changed).digest('hex')
    assert.equal(snapshots.read(font.path).recoveryContentHash,changedHash,'a changed file stamp must renew evidence even with identical size and mtime')
    h.files.delete(key(font.path))
    await snapshots.capture([{...font,recoveryContentHash:'f'.repeat(64)}])
    assert.equal(snapshots.read(font.path).recoveryContentHash,changedHash,'missing files retain known evidence')
  } finally { h.close() }
}

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const timerTurn = () => new Promise(resolve => setTimeout(resolve, 0))
const backgroundWork = h => h.counts.backgroundStats + h.counts.backgroundRealpaths + h.counts.backgroundContentReads
const queryWorkFont = name => { const font = make(name); return { ...font, path: key(font.path) } }
const queryStageRecords = h => h.logs.filter(message => message.startsWith('tag query stages: ')).map(message => {
  assert(message.length <= 2048, 'per-query stage summary is not bounded')
  const record = JSON.parse(message.slice('tag query stages: '.length))
  assert.deepEqual(Object.keys(record).sort(), ['bindingsOnly', 'counts', 'outcome', 'scope', 'stages', 'totalMs'])
  assert(['local', 'shared'].includes(record.scope)); assert(['ok', 'failed', 'cancelled', 'superseded'].includes(record.outcome))
  assert.equal(typeof record.bindingsOnly, 'boolean')
  assert.deepEqual(Object.keys(record.stages).sort(), ['bindings', 'filterSort', 'history', 'hydrate', 'liveQuery', 'prepare', 'queueCapture', 'remainingAvailability', 'resolveBindings'])
  assert.deepEqual(Object.keys(record.counts).sort(), ['bindings', 'captureCandidates', 'captureCoalesced', 'captureQueued', 'directoryJoins', 'directoryReads', 'fileStats', 'livePages', 'liveRows', 'resultRows', 'snapshotRememberMs', 'snapshotWrites'])
  for (const value of [record.totalMs, ...Object.values(record.stages), ...Object.values(record.counts)]) assert(Number.isFinite(value) && value >= 0, 'stage summary must contain finite nonnegative counters only')
  return record
})

async function snapshotRememberWorkCases() {
  const h = harness(), font = queryWorkFont('RememberWork')
  try {
    h.put(font)
    const owner = h.snapshots.openTagFontSnapshots(h.adapter)
    const persisted = () => h.db.prepare('SELECT font_json FROM tag_font_snapshots WHERE font_path = ?').get(key(font.path)).font_json
    assert.deepEqual(plain(owner.remember([font])), { examined: 1, written: 1 })
    const coldJson = persisted()
    const untrusted = { ...font, recoveryContentHash: 'f'.repeat(64), recoveryFileStamp: 'renderer-stamp', tagNames: ['Renderer'], localTagNames: ['Renderer'] }
    assert.deepEqual(plain(owner.remember([untrusted, untrusted])), { examined: 2, written: 0 })
    assert.equal(persisted(), coldJson, 'identical normalized history must remain byte-identical')
    assert.equal(h.counts.snapshotWrites, 1, 'identical history must not execute INSERT/REPLACE')
    assert.equal(owner.read(font.path).recoveryContentHash, undefined, 'renderer hash was accepted as proof')
    assert.equal(owner.read(font.path).recoveryFileStamp, undefined, 'renderer stamp was accepted as proof')
    assert.equal(h.counts.contentReads, 0, 'remember must not read font bytes')

    await owner.capture([font])
    const proven = owner.read(font.path), provenJson = persisted(), coldStats = h.counts.stats
    assert.equal(proven.recoveryContentHash, hashFor(font)); assert.equal(typeof proven.recoveryFileStamp, 'string')
    assert.equal(h.counts.contentReads, 1, 'cold capture must establish whole-file proof exactly once')
    assert.equal(h.counts.snapshotWrites, 2, 'cold capture must persist its new proof')
    assert(coldStats > 0, 'cold capture skipped metadata verification')
    assert.deepEqual(plain(owner.remember([untrusted])), { examined: 1, written: 0 })
    await owner.capture([untrusted])
    assert.equal(h.counts.contentReads, 1, 'unchanged proof should avoid another whole-file read')
    assert(h.counts.stats > coldStats, 'warm capture must still verify the current file stamp')
    assert.equal(h.counts.snapshotWrites, 2, 'warm remember/capture dirtied identical history')
    assert.equal(persisted(), provenJson, 'valid stored proof was changed by renderer metadata')

    const edited = { ...untrusted, fullName: 'Updated display metadata', favorite: true }
    assert.deepEqual(plain(owner.remember([edited])), { examined: 1, written: 1 })
    assert.equal(owner.read(font.path).fullName, edited.fullName)
    assert.equal(owner.read(font.path).recoveryContentHash, proven.recoveryContentHash)
    assert.equal(owner.read(font.path).recoveryFileStamp, proven.recoveryFileStamp)
    assert.deepEqual(plain(owner.remember([edited])), { examined: 1, written: 0 })
    const changed = { ...edited, id: 'new-font-identity', modifiedAt: font.modifiedAt + 1 }
    assert.deepEqual(plain(owner.remember([changed])), { examined: 1, written: 1 })
    assert.equal(owner.read(font.path).recoveryContentHash, undefined, 'new identity inherited old proof')
    assert.equal(owner.read(font.path).recoveryFileStamp, undefined)
    assert.equal(h.counts.snapshotWrites, 4, 'only initial history, proof, metadata and identity changes should write')
    assert.deepEqual(plain(owner.remember([{ ...changed, fileAvailability: 'missing' }, { ...changed, fileAvailability: 'unavailable' }])), { examined: 0, written: 0 })

    h.db.prepare('UPDATE tag_font_snapshots SET font_json = ? WHERE font_path = ?').run('{"truncated":', key(font.path))
    assert.deepEqual(plain(owner.remember([changed])), { examined: 1, written: 1 }, 'malformed history must be repaired rather than treated as an identical row')
    const repaired = owner.read(font.path), repairedJson = persisted()
    assert.equal(repaired.id, changed.id); assert.equal(repaired.fullName, changed.fullName)
    assert.equal(repaired.recoveryContentHash, undefined, 'malformed history repair accepted renderer proof')
    assert.equal(repaired.recoveryFileStamp, undefined, 'malformed history repair accepted renderer stamp')
    assert.equal(h.counts.snapshotWrites, 5, 'malformed history repair must perform one real write')
    assert.deepEqual(plain(owner.remember([changed])), { examined: 1, written: 0 })
    assert.equal(persisted(), repairedJson); assert.equal(h.counts.snapshotWrites, 5)

    const readFailure = Error('snapshot SELECT unavailable'), readsBeforeFailure = h.counts.snapshotReads
    h.faults.snapshotReadError = readFailure
    try {
      assert.throws(() => owner.remember([{ ...changed, fullName: 'Unconfirmed display edit' }]), error => error === readFailure,
        'unreadable history must propagate the original SELECT error')
      assert.equal(h.counts.snapshotReads, readsBeforeFailure + 1)
      assert.equal(h.counts.snapshotWrites, 5, 'failed history read must not execute INSERT/REPLACE')
      assert.equal(persisted(), repairedJson, 'failed history read changed durable history')
    } finally { h.faults.snapshotReadError = undefined }
    assert.deepEqual(plain(owner.remember([changed])), { examined: 1, written: 0 }, 'failed SELECT did not roll back its transaction')
  } finally { h.close() }
}

async function delayedQueryCaptureWorkCases() {
  const h = harness(), fonts = [queryWorkFont('WorkB'), queryWorkFont('WorkA')]
  const availability = deferred(), availabilityEntered = deferred(), hydration = deferred(), hydrationEntered = deferred()
  const owner = h.snapshots.openTagFontSnapshots(h.adapter)
  let pending, comparisons = 0
  try {
    for (const font of fonts) { h.add(font, ['PrivateQueryTag']); h.put(font) }
    h.live(fonts)
    const readdir = h.filesystem.readdir, hydrate = h.queryDeps.hydrate, compare = h.queryDeps.compare
    h.filesystem.readdir = async folder => { availabilityEntered.resolve(); await availability.promise; return readdir(folder) }
    h.queryDeps.hydrate = async items => { hydrationEntered.resolve(); await hydration.promise; return hydrate(items) }
    h.queryDeps.compare = (a, b) => { comparisons++; assert.equal(backgroundWork(h), 0, 'capture started before sorting completed'); return compare(a, b) }
    const request = { sidebarPage: 'tags', selectedTagName: 'PrivateQueryTag' }
    pending = h.query.query(request, 10, 0)
    await availabilityEntered.promise; await timerTurn()
    assert.equal(backgroundWork(h), 0, 'capture ran while fresh availability was blocked')
    assert.equal(h.counts.contentReads, 0)
    assert.equal(owner.read(fonts[0].path).id, fonts[0].id, 'display history should be remembered before blocked availability')
    availability.resolve(); await hydrationEntered.promise; await timerTurn()
    assert.equal(backgroundWork(h), 0, 'capture ran while install hydration was blocked')
    assert.equal(h.counts.contentReads, 0)
    hydration.resolve()
    const first = await pending
    assert(comparisons > 0); assert.equal(first.total, fonts.length)
    assert.deepEqual(plain(first.items.map(font => font.fileName)), ['WorkA.ttf', 'WorkB.ttf'])
    assert.equal(backgroundWork(h), 0, 'background work must start after the query settles')
    await owner.whenIdle()
    assert.equal(h.counts.backgroundContentReads, fonts.length, 'settled query did not capture each fresh available font')
    for (const font of fonts) assert.equal(owner.read(font.path).recoveryContentHash, hashFor(font))
    const cold = { ...h.counts }, coldDirectories = h.reads.length
    assert.equal(coldDirectories, 1, 'siblings should share one fresh parent listing')

    h.queryDeps.compare = compare
    h.query.invalidate()
    const second = await h.query.query(request, 10, 0)
    await owner.whenIdle()
    assert.equal(second.total, first.total)
    assert.equal(h.reads.length, coldDirectories + 1, 'a fresh query must list the parent again')
    assert.equal(h.counts.live, cold.live + 1); assert.equal(h.counts.hydrate, cold.hydrate + 1)
    assert.equal(h.counts.snapshotWrites, cold.snapshotWrites, 'a repeated identical query rewrote durable history')
    assert.equal(h.counts.contentReads, cold.contentReads, 'warm proof caused redundant whole-file reads')
    assert(h.counts.backgroundStats > cold.backgroundStats, 'warm query skipped required stamp verification')
    assert(h.counts.snapshotReads > cold.snapshotReads, 'repeated query must still read authoritative stored history')
    const records = queryStageRecords(h)
    assert.equal(records.length, 2, 'one bounded stage summary should be emitted per physical collection')
    for (const record of records) {
      assert.equal(record.outcome, 'ok'); assert.equal(record.bindingsOnly, false)
      for (const [name, expected] of Object.entries({ livePages: 1, liveRows: 2, bindings: 2, directoryReads: 1, directoryJoins: 1, fileStats: 0, captureCandidates: 2, captureQueued: 2, captureCoalesced: 0, resultRows: 2 })) assert.equal(record.counts[name], expected, name)
    }
    assert.equal(records[0].counts.snapshotWrites, 2); assert.equal(records[1].counts.snapshotWrites, 0)
    assert(h.logs.every(message => !/PrivateQueryTag|WorkA|WorkB|[a-z]:\\/i.test(message)), 'stage logging leaked a tag name or font path')
  } finally {
    availability.resolve(); hydration.resolve(); await pending?.catch(() => undefined); await owner.whenIdle(); h.close()
  }
}

async function cancelledQueryCaptureWorkCases() {
  for (const stage of ['availability', 'hydrate', 'sort']) {
    const h = harness(), font = queryWorkFont('CancelWork'), sibling = queryWorkFont('CancelSibling')
    const entered = deferred(), release = deferred(), controller = new AbortController()
    const owner = h.snapshots.openTagFontSnapshots(h.adapter)
    let pending
    try {
      for (const item of [font, sibling]) { h.add(item, ['T']); h.put(item) }
      h.live([font, sibling])
      if (stage === 'availability') {
        const read = h.filesystem.readdir
        h.filesystem.readdir = async folder => { entered.resolve(); await release.promise; return read(folder) }
      } else if (stage === 'hydrate') {
        const hydrate = h.queryDeps.hydrate
        h.queryDeps.hydrate = async items => { entered.resolve(); await release.promise; return hydrate(items) }
      } else h.queryDeps.compare = () => { h.query.invalidate(); controller.abort(); entered.resolve(); return 0 }
      pending = h.sharedIo.withSharedIoSignal(controller.signal, () => h.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0))
        .then(value => ({ value }), error => ({ error }))
      await entered.promise; await timerTurn()
      assert.equal(backgroundWork(h), 0, `${stage}: pre-cancel query queued capture`)
      controller.abort(); release.resolve()
      const result = await pending
      assert(result.error, `${stage}: cancelled query published a result`)
      assert.match(String(result.error), /替换|关闭|修订/)
      await timerTurn(); await owner.whenIdle()
      assert.equal(backgroundWork(h), 0, `${stage}: cancelled query created background identity work`)
      assert.equal(owner.read(font.path).recoveryContentHash, undefined)
      const record = queryStageRecords(h).at(-1)
      assert.equal(record?.outcome, 'cancelled')
      for (const name of ['captureCandidates', 'captureQueued', 'captureCoalesced']) assert.equal(record.counts[name], 0, name)
    } finally { release.resolve(); await pending; await owner.whenIdle(); h.close() }
  }
}

async function supersededQueryCaptureWorkCase() {
  const h = harness(), font = queryWorkFont('SupersededWork'), owner = h.snapshots.openTagFontSnapshots(h.adapter)
  const entered = [deferred(), deferred()], release = [deferred(), deferred()]
  let pending, hydrations = 0
  try {
    h.add(font, ['T']); h.put(font); h.live([font])
    const hydrate = h.queryDeps.hydrate
    h.queryDeps.hydrate = async items => {
      const index = hydrations++
      assert(index < 2, 'superseded query restarted more than once')
      entered[index].resolve(); await release[index].promise; return hydrate(items)
    }
    pending = h.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0)
    await entered[0].promise
    h.query.invalidate(false); release[0].resolve()
    await entered[1].promise; await timerTurn()
    assert.equal(backgroundWork(h), 0, 'superseded generation queued evidence before replacement query settled')
    const old = queryStageRecords(h)
    assert.equal(old.length, 1); assert.equal(old[0].outcome, 'superseded')
    for (const name of ['captureCandidates', 'captureQueued', 'captureCoalesced']) assert.equal(old[0].counts[name], 0, name)
    release[1].resolve(); assert.equal((await pending).total, 1); await owner.whenIdle()
    assert.equal(h.counts.backgroundContentReads, 1)
    assert.equal(queryStageRecords(h).at(-1).outcome, 'ok')
  } finally { release.forEach(gate => gate.resolve()); await pending?.catch(() => undefined); await owner.whenIdle(); h.close() }
}

async function queryStageLoggingIsolationCase() {
  const h = harness(), font = queryWorkFont('LoggingWork'), owner = h.snapshots.openTagFontSnapshots(h.adapter)
  try {
    h.add(font, ['PrivateLoggingTag']); h.put(font); h.live([font])
    const request = { sidebarPage: 'tags', selectedTagName: 'PrivateLoggingTag' }
    h.queryDeps.appendLog = () => { throw Error('log sink unavailable') }
    assert.equal((await h.query.query(request, 10, 0)).total, 1); await owner.whenIdle()
    assert.equal(owner.read(font.path).recoveryContentHash, hashFor(font), 'throwing logger prevented capture')
    const failure = Error('private hydration failure'), hydrate = h.queryDeps.hydrate
    h.queryDeps.hydrate = async () => { throw failure }; h.query.invalidate()
    await assert.rejects(h.query.query(request, 10, 0), error => error === failure, 'logger changed business error identity')
    h.queryDeps.hydrate = hydrate; delete h.queryDeps.appendLog; h.query.invalidate()
    assert.equal((await h.query.query(request, 10, 0)).total, 1); await owner.whenIdle()
    const captures = backgroundWork(h)
    assert.equal((await h.query.query({ ...request, tagBindingsOnly: true }, 10, 0)).total, 1); await timerTurn(); await owner.whenIdle()
    assert.equal(backgroundWork(h), captures, 'binding-only authority query scheduled ordinary recovery capture')
  } finally { await owner.whenIdle(); h.close() }
}

async function backgroundCaptureLeaseWorkCases() {
  const h = harness(), fonts = [queryWorkFont('HeldA'), queryWorkFont('HeldB')], explicit = queryWorkFont('ExplicitCapture')
  const owner = h.snapshots.openTagFontSnapshots(h.adapter), releaseA = owner.holdBackgroundCapture(), releaseB = owner.holdBackgroundCapture()
  let idle = false
  try {
    for (const font of [...fonts, explicit]) h.put(font)
    assert.deepEqual(plain(owner.schedule(fonts)), { queued: 2, coalesced: 0, historyWrites: 2 })
    assert.deepEqual(plain(owner.schedule(fonts)), { queued: 0, coalesced: 2, historyWrites: 0 }, 'held queue should report actual coalescing, not new work')
    const waiting = owner.whenIdle().then(() => { idle = true })
    await timerTurn(); assert.equal(backgroundWork(h), 0); assert.equal(idle, false, 'paused pending work was reported idle')
    releaseA(); releaseA(); await timerTurn()
    assert.equal(backgroundWork(h), 0, 'one reader or a duplicate release resumed another reader\'s capture queue')
    await owner.capture([explicit])
    assert.equal(owner.read(explicit.path).recoveryContentHash, hashFor(explicit), 'foreground lease blocked explicit mutation capture')
    assert.equal(backgroundWork(h), 0); assert.equal(idle, false)
    releaseB(); await waiting
    assert.equal(h.counts.backgroundContentReads, 2)
    for (const font of fonts) assert.equal(owner.read(font.path).recoveryContentHash, hashFor(font))
  } finally { releaseA(); releaseB(); h.snapshots.disposeTagFontSnapshots(h.adapter); await owner.whenIdle(); h.close() }

  const replacement = harness(), old = queryWorkFont('QueuedOld'), next = { ...old, id: 'queued-new', fileSize: 101, modifiedAt: 2, postscriptName: 'QueuedNew' }
  const snapshots = replacement.snapshots.openTagFontSnapshots(replacement.adapter), release = snapshots.holdBackgroundCapture()
  try {
    replacement.put(old)
    assert.deepEqual(plain(snapshots.schedule([old])), { queued: 1, coalesced: 0, historyWrites: 1 })
    replacement.put(next)
    assert.deepEqual(plain(snapshots.schedule([next])), { queued: 0, coalesced: 1, historyWrites: 1 }, 'queued replacement must report its history write and existing queue slot')
    assert.equal(snapshots.read(old.path).id, next.id)
    await timerTurn(); assert.equal(backgroundWork(replacement), 0)
    release(); await snapshots.whenIdle()
    assert.equal(replacement.counts.backgroundContentReads, 1, 'queued replacement did not coalesce by current identity')
    assert.equal(snapshots.read(old.path).recoveryContentHash, hashFor(next))
  } finally { release(); replacement.snapshots.disposeTagFontSnapshots(replacement.adapter); await snapshots.whenIdle(); replacement.close() }

  const disposed = harness(), item = queryWorkFont('DisposeHeld'), stopped = disposed.snapshots.openTagFontSnapshots(disposed.adapter)
  const releaseStopped = stopped.holdBackgroundCapture()
  try {
    disposed.put(item); stopped.schedule([item]); const waiting = stopped.whenIdle()
    disposed.snapshots.disposeTagFontSnapshots(disposed.adapter); await waiting
    releaseStopped(); releaseStopped(); await timerTurn()
    assert.deepEqual(plain(stopped.schedule([item])), { queued: 0, coalesced: 0, historyWrites: 0 })
    assert.equal(backgroundWork(disposed), 0, 'releasing a disposed owner restarted queued work')
  } finally { releaseStopped(); disposed.snapshots.disposeTagFontSnapshots(disposed.adapter); await stopped.whenIdle(); disposed.close() }
}

async function overlappingQueryCaptureLeaseCase() {
  const h = harness(), prior = queryWorkFont('PriorActive'), queued = queryWorkFont('PriorQueued'), font = queryWorkFont('CurrentView')
  const owner = h.snapshots.openTagFontSnapshots(h.adapter), readEntered = deferred(), readRelease = deferred()
  const entered = [deferred(), deferred()], release = [deferred(), deferred()], controller = new AbortController(), reads = []
  let first, second, hydrations = 0, idle = false
  try {
    for (const item of [prior, queued, font]) h.put(item)
    h.add(font, ['T', 'U']); h.live([font])
    const read = h.filesystem.readFile, hydrate = h.queryDeps.hydrate
    h.filesystem.readFile = async file => {
      reads.push(key(file))
      if (key(file) === key(prior.path)) { readEntered.resolve(h.sharedIo.currentSharedIoSignal()); await readRelease.promise }
      return read(file)
    }
    h.queryDeps.hydrate = async items => {
      const index = hydrations++; assert(index < 2)
      entered[index].resolve(); await release[index].promise; return hydrate(items)
    }
    assert.deepEqual(plain(owner.schedule([prior, queued, font])), { queued: 3, coalesced: 0, historyWrites: 3 })
    const activeSignal = await readEntered.promise
    assert.deepEqual(plain(owner.schedule([prior])), { queued: 0, coalesced: 1, historyWrites: 0 }, 'active identity should coalesce without a new queue slot')
    const waiting = owner.whenIdle().then(() => { idle = true })
    first = h.sharedIo.withSharedIoSignal(controller.signal, () => h.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0))
      .then(value => ({ value }), error => ({ error }))
    await entered[0].promise
    second = h.query.query({ sidebarPage: 'tags', selectedTagName: 'U' }, 10, 0)
    await entered[1].promise
    assert.equal(activeSignal.aborted, false, 'foreground query aborted an already-owned background child')
    readRelease.resolve(); await timerTurn()
    assert.deepEqual(reads, [key(prior.path)], 'old queue started its next item during foreground hydration')
    assert.equal(idle, false, 'paused old queue lost its idle waiter')
    controller.abort(); release[0].resolve(); assert((await first).error); await timerTurn()
    assert.deepEqual(reads, [key(prior.path)], 'cancelling one view released another view\'s capture lease')
    assert.equal(activeSignal.aborted, false)
    release[1].resolve(); assert.equal((await second).total, 1)
    assert.deepEqual(reads, [key(prior.path)], 'queued work resumed before the surviving query settled')
    await waiting
    assert.deepEqual(reads, [key(prior.path), key(queued.path), key(font.path)])
    assert.equal(h.counts.backgroundContentReads, 3)
    const records = queryStageRecords(h), cancelled = records.filter(record => record.outcome === 'cancelled'), completed = records.filter(record => record.outcome === 'ok')
    assert.equal(cancelled.length, 1); assert.equal(completed.length, 1)
    for (const name of ['captureCandidates', 'captureQueued', 'captureCoalesced']) assert.equal(cancelled[0].counts[name], 0, name)
    assert.equal(completed[0].counts.captureCandidates, 1)
    assert.equal(completed[0].counts.captureQueued, 0, 'overlapping query reported an existing pending item as newly queued')
    assert.equal(completed[0].counts.captureCoalesced, 1)
    assert.equal(completed[0].counts.snapshotWrites, 0, 'coalescing an unchanged pending item wrote history')
  } finally {
    controller.abort(); readRelease.resolve(); release.forEach(gate => gate.resolve())
    await first; await second?.catch(() => undefined); h.snapshots.disposeTagFontSnapshots(h.adapter); await owner.whenIdle(); h.close()
  }
}

async function queryCaptureLeasePhysicalCloseCases() {
  for (const mode of ['failed', 'cancelled']) {
    const h = harness(), queued = [queryWorkFont('CloseQueuedA'), queryWorkFont('CloseQueuedB')], font = queryWorkFont('ClosingView')
    const owner = h.snapshots.openTagFontSnapshots(h.adapter), releaseSetup = owner.holdBackgroundCapture()
    const entered = deferred(), failNow = deferred(), portRejected = deferred(), physicallyClosed = deferred(), controller = new AbortController()
    const failure = Object.assign(Error('foreground hydration stopped'), { closed: physicallyClosed.promise, ...(mode === 'cancelled' ? { name: 'AbortError' } : {}) })
    let pending, settled = false, idle = false
    try {
      for (const item of [...queued, font]) h.put(item)
      h.add(font, ['T']); h.live([font]); owner.schedule(queued)
      const waiting = owner.whenIdle().then(() => { idle = true }), hydrate = h.queryDeps.hydrate
      h.queryDeps.hydrate = async items => {
        await hydrate(items)
        const signal = h.sharedIo.currentSharedIoSignal(); assert(signal)
        entered.resolve()
        if (mode === 'cancelled') {
          await new Promise((resolve, reject) => {
            const abort = () => { portRejected.resolve(); reject(failure) }
            signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
          })
        } else { await failNow.promise; portRejected.resolve(); throw failure }
        throw Error('failed hydration published items')
      }
      pending = h.sharedIo.withSharedIoSignal(controller.signal, () => h.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0))
        .then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
      await entered.promise; releaseSetup()
      let cancelledResult
      if (mode === 'cancelled') {
        controller.abort(); cancelledResult = await pending
        assert.equal(cancelledResult.error?.reason, 'query-superseded', 'subscriber cancellation lost its terminal query classification')
        assert.match(String(cancelledResult.error), /替换|关闭|修订/)
      } else failNow.resolve()
      await portRejected.promise; await timerTurn()
      assert.equal(settled, mode === 'cancelled', 'non-cancelled subscriber retired before the hydration child closed')
      assert.equal(backgroundWork(h), 0, `${mode}: foreground logical rejection released queued capture before physical close`)
      assert.equal(idle, false, `${mode}: paused background owner reported idle while foreground child was closing`)
      assert.equal(queryStageRecords(h).length, 0, 'foreground collection finalized before its physical-close receipt')
      physicallyClosed.resolve()
      const terminal = await pending; await waiting
      if (mode === 'failed') {
        assert.equal(terminal.error, failure, 'physical-close wait changed the original hydration failure')
        assert.equal(terminal.error.closed, physicallyClosed.promise)
      } else assert.equal(terminal, cancelledResult, 'closed child replaced the already-terminal subscriber cancellation')
      assert.equal(h.counts.live, 1); assert.equal(h.counts.hydrate, 1, 'terminal foreground work restarted after physical close')
      assert.equal(h.counts.backgroundContentReads, queued.length, 'physical close did not resume exactly the prior queued captures')
      for (const item of queued) assert.equal(owner.read(item.path).recoveryContentHash, hashFor(item))
      assert.equal(owner.read(font.path).recoveryContentHash, undefined, 'failed foreground query queued its own new evidence')
      const records = queryStageRecords(h)
      assert.equal(records.length, 1); assert.equal(records[0].outcome, mode)
      for (const name of ['captureCandidates', 'captureQueued', 'captureCoalesced']) assert.equal(records[0].counts[name], 0, name)
    } finally {
      controller.abort(); failNow.resolve(); physicallyClosed.resolve(); releaseSetup(); await pending
      h.snapshots.disposeTagFontSnapshots(h.adapter); await owner.whenIdle(); h.close()
    }
  }
}

async function captureLeaseGenerationRaceCase() {
  const h = harness(), old = queryWorkFont('ActiveOld'), next = { ...old, id: 'active-new', postscriptName: 'ActiveNew' }
  const owner = h.snapshots.openTagFontSnapshots(h.adapter), entered = deferred(), finishRead = deferred(), paused = deferred()
  let release
  try {
    h.put(old)
    const read = h.filesystem.readFile
    let reads = 0
    h.filesystem.readFile = async file => {
      const bytes = await read(file)
      if (++reads === 1) { entered.resolve(h.sharedIo.currentSharedIoSignal()); await finishRead.promise }
      return bytes
    }
    owner.schedule([old], message => { if (message.startsWith('tag recovery evidence background settled:')) paused.resolve() })
    const activeSignal = await entered.promise
    release = owner.holdBackgroundCapture(); h.put(next)
    assert.deepEqual(plain(owner.schedule([next])), { queued: 1, coalesced: 0, historyWrites: 1 }, 'replacement of an active identity needs a new pending slot')
    finishRead.resolve(); await paused.promise
    assert.equal(activeSignal.aborted, false); assert.equal(reads, 1)
    assert.equal(owner.read(old.path).id, next.id)
    assert.equal(owner.read(old.path).recoveryContentHash, undefined, 'late old capture overwrote a newer remembered identity')
    release(); await owner.whenIdle()
    assert.equal(reads, 2); assert.equal(owner.read(old.path).recoveryContentHash, hashFor(next))
  } finally { finishRead.resolve(); release?.(); h.snapshots.disposeTagFontSnapshots(h.adapter); await owner.whenIdle(); h.close() }

  const r = harness(), fonts = [queryWorkFont('FinallyA'), queryWorkFont('FinallyB'), queryWorkFont('FinallyC')]
  const snapshots = r.snapshots.openTagFontSnapshots(r.adapter), started = deferred(), done = deferred()
  let resume, settlements = 0, active = 0, maxActive = 0
  const reads = []
  try {
    for (const font of fonts) r.put(font)
    const read = r.filesystem.readFile
    r.filesystem.readFile = async file => {
      reads.push(key(file)); maxActive = Math.max(maxActive, ++active)
      try {
        if (reads.length === 1) { started.resolve(); await done.promise } else await timerTurn()
        return await read(file)
      } finally { active-- }
    }
    snapshots.schedule(fonts, message => {
      if (message.startsWith('tag recovery evidence background settled:') && ++settlements === 1) resume()
    })
    await started.promise; resume = snapshots.holdBackgroundCapture(); done.resolve()
    await snapshots.whenIdle()
    assert.deepEqual(reads, fonts.map(font => key(font.path)), 'release during drain finalization lost or duplicated a queued item')
    assert.equal(maxActive, 1, 'release/finally race created overlapping background drain owners')
    assert.equal(settlements, 2)
  } finally { done.resolve(); resume?.(); r.snapshots.disposeTagFontSnapshots(r.adapter); await snapshots.whenIdle(); r.close() }
}

async function shutdownCaptureWorkCase() {
  const h = harness(), fonts = [queryWorkFont('ClosingA'), queryWorkFont('ClosingB')]
  const owner = h.snapshots.openTagFontSnapshots(h.adapter), entered = deferred(), aborted = deferred(), closed = deferred()
  const reads = []
  let stopping, idle = false, outcome
  try {
    for (const font of fonts) h.put(font)
    h.filesystem.readFile = async file => {
      reads.push(key(file))
      assert.equal(h.sharedIo.currentSharedIoPriority(), 'background')
      const signal = h.sharedIo.currentSharedIoSignal(); assert(signal)
      entered.resolve(signal)
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        aborted.resolve(); reject(Object.assign(Error('capture closed'), { name: 'AbortError', closed: closed.promise }))
      }, { once: true }))
      throw Error('cancelled capture returned font bytes')
    }
    owner.schedule(fonts)
    const signal = await entered.promise
    const drained = owner.whenIdle().then(() => { idle = true })
    const shutdown = h.shutdown.createShutdownCoordinator({ log() {}, freeze() {}, restore() { throw Error('shutdown unexpectedly restored') },
      closeRenderers: async () => { await drained; return true }, cleanup: async () => ({ remaining: 0 }), save: async () => {},
      confirmLoss: async () => false, drainLogs: async () => {}, terminate: result => { outcome = result } })
    stopping = shutdown.request(); await aborted.promise; await timerTurn()
    assert.equal(signal.aborted, true); assert.equal(idle, false, 'capture owner retired before its physical read closed')
    closed.resolve(); await stopping; await drained
    assert.deepEqual(reads, [key(fonts[0].path)], 'shutdown started another queued capture')
    assert.equal(outcome.reason, 'complete'); assert.equal(outcome.processExitClean, true)
    for (const font of fonts) assert.equal(owner.read(font.path).recoveryContentHash, undefined, 'aborted capture persisted unconfirmed proof')
    owner.schedule(fonts); await owner.whenIdle()
    assert.equal(reads.length, 1, 'closing application admitted new background capture')
  } finally { closed.resolve(); h.snapshots.disposeTagFontSnapshots(h.adapter); await stopping; await owner.whenIdle(); h.close() }
}

async function freshQueryAvailabilityWorkCases() {
  const h = harness(), font = queryWorkFont('FreshAvailability'), owner = h.snapshots.openTagFontSnapshots(h.adapter)
  try {
    h.add(font, ['T']); h.put(font); h.live([font])
    const request = { sidebarPage: 'tags', selectedTagName: 'T' }
    const fresh = async () => { h.query.invalidate(); const page = await h.query.query(request, 10, 0); await owner.whenIdle(); return page.items[0] }
    assert.equal((await fresh()).fileAvailability, 'available')
    const captured = h.counts.backgroundStats
    h.files.delete(key(font.path))
    assert.equal((await fresh()).fileAvailability, 'missing', 'fresh query reused a stale live available row')
    assert.equal(h.counts.backgroundStats, captured, 'freshly missing file was still queued for capture')
    h.files.set(key(root), Object.assign(Error('offline'), { code: 'EACCES' }))
    assert.equal((await fresh()).fileAvailability, 'unavailable', 'offline must not become missing')
    assert.equal(h.counts.backgroundStats, captured, 'freshly unavailable file was still queued for capture')
    h.files.delete(key(root)); h.files.set(key(font.path), 'directory')
    assert.equal((await fresh()).fileAvailability, 'missing', 'directory replacement was accepted as a font')
    h.put(font)
    assert.equal((await fresh()).fileAvailability, 'available', 'restored file was not rechecked')
    assert.equal(h.reads.length, 5, 'each fresh query needs one parent listing')
  } finally { await owner.whenIdle(); h.close() }

  const d = harness(), detached = { ...queryWorkFont('Replaced'), path: 'd:\\outside\\replaced.ttf' }
  const snapshots = d.snapshots.openTagFontSnapshots(d.adapter)
  try {
    d.add(detached, ['T']); d.put(detached); d.live([detached])
    const authorization = load('src/main/library/tagRelinkAuthorizationRuntime.ts', {
      'node:path': path, '../path/cachePath': { normalizePathForCacheCompare: key },
      '../path/pathBoundaryPolicy': load('src/main/path/pathBoundaryPolicy.ts'),
      '../path/sharedFileSystemRuntime': { ...d.sharedIo, sharedFileSystem: d.filesystem },
    }).createTagRelinkAuthorizationRuntime(async () => d.adapter)
    await authorization.rememberRelinkedFontFile(detached)
    d.queryDeps.readDetachedState = authorization.readDetachedState
    const request = { sidebarPage: 'tags', selectedTagName: 'T' }
    assert.equal((await d.query.query(request, 10, 0)).items[0].fileAvailability, 'available'); await snapshots.whenIdle()
    const bytes = bytesFor(detached); bytes[bytes.length - 1] = 1; d.contents.set(key(detached.path), bytes)
    const contentReads = d.counts.contentReads, captures = d.counts.backgroundStats
    d.query.invalidate()
    const changed = (await d.query.query(request, 10, 0)).items[0]; await snapshots.whenIdle()
    assert.equal(changed.fileAvailability, 'unavailable'); assert.equal(changed.fileRelinkRequired, true)
    assert(d.counts.contentReads > contentReads, 'same-size/same-time replacement was not freshly hashed for authorization')
    assert.equal(d.counts.backgroundStats, captures, 'unconfirmed replacement was queued for ordinary background capture')
    assert.equal(snapshots.read(detached.path).recoveryContentHash, hashFor(detached), 'unconfirmed replacement overwrote historical proof')
  } finally { await snapshots.whenIdle(); d.close() }
}


async function f13ScopedWorkCases() {
  const h=harness()
  try {
    for(let i=0;i<1001;i++)h.add(make('Page'+i,'page'),['P'])
    for(let i=0;i<512;i++)h.add(make('Other'+i,'other'),['P'])
    const request={sidebarPage:'tags',tagBindingsOnly:true,selectedWatchedFolders:[root+'\\page']}
    await h.queryModule.withTagFontQuerySnapshot(async()=>{
      const pages=[];for(const offset of [0,500,1000])pages.push(await h.query.query(request,500,offset))
      assert.deepEqual(pages.map(p=>p.items.length),[500,500,1]);assert(pages.every(p=>p.total===1001))
      assert.equal(h.counts.collections,1);assert.equal(h.counts.bindingRows,1001)
    })
    await h.queryModule.withTagFontQuerySnapshot(()=>h.query.query(request,500,0));assert.equal(h.counts.collections,2,'a new authority phase must recollect')
    await h.queryModule.withTagFontQuerySnapshot(async()=>{await h.query.query(request,500,0);h.query.invalidate();await assert.rejects(h.query.query(request,500,500),/分页读取期间发生变化/)})
    await h.query.query(request,500,0);await h.query.query(request,500,0);assert.equal(h.counts.collections,5,'unscoped authority reads cannot reuse snapshots')
  } finally {h.close()}
  const scoped=harness()
  try {
    scoped.mappings.set('R:','\\\\server\\share')
    const values=['R:\\Fonts%_\\a.ttf','\\\\server\\share\\Fonts%_\\b.ttf','\\\\?\\UNC\\server\\share\\Fonts%_\\c.ttf','R:/Fonts%_/D.ttf','R:\\ignored\\..\\Fonts%_\\e.ttf','R:\\FontsXX\\bad.ttf','R:\\Fonts%_sibling\\bad.ttf']
    for(const [i,file] of values.entries())scoped.db.prepare('INSERT INTO local_font_tags(font_id, font_path, tag_name) VALUES(?,?,?)').run('row'+i,file,'P')
    scoped.db.prepare('INSERT INTO local_font_tags(font_id, font_path, tag_name) VALUES(?,?,?)').run('legacy',null,'P')
    const result=await scoped.query.query({sidebarPage:'tags',tagBindingsOnly:true,selectedWatchedFolders:['\\\\server\\share\\Fonts%_']},500,0)
    assert.equal(result.total,5,'SQL scoping lost verified alias/device/slash/dot/wildcard paths or admitted sibling')
  } finally {scoped.close()}
  const prep=harness()
  try {
    const old=Array.from({length:8},(_,i)=>make('Unique'+i)),next=old.map(font=>({...font,id:font.id+'-new',path:root+'\\new\\'+font.fileName}))
    for(const font of old){prep.add(font,['T']);prep.remember([font])}for(const font of next)prep.put(font)
    // The actual candidate index is empty; enumeration and parsing must prepare siblings.
    const query=prep.runtime.queryFontPageInLibrary;prep.runtime.queryFontPageInLibrary=request=>request.sidebarPage==='filters'?Promise.resolve({items:[],total:0}):query(request)
    const result=await prep.recoveryModule.createTagFontRecoveryRuntime(prep.runtime,async()=>next[0].path).recover({mode:'relink',scope:'local',fontPath:old[0].path})
    assert.equal(result.linked,8);assert.equal(prep.counts.contentReads,16,'preparation reads must be eight; eight fresh link reads remain')
  } finally {prep.close()}
  const collision=harness()
  try {
    const a=make('A'),b=make('B'),anchor=make('A','new'),one=make('B','new'),two={...one,id:'independent',path:root+'\\new\\independent.ttf'}
    for(const old of [a,b]){collision.add(old,['T']);collision.remember([old])}for(const font of [anchor,one,two])collision.put(font)
    const stat=collision.filesystem.stat
    collision.filesystem.stat=async(file,options)=>{const value=await stat(file);const ino=key(file)===key(two.path)?9007199254740993n:key(file)===key(one.path)?9007199254740992n:42n;return {...value,dev:options?.bigint?1n:1,ino:options?.bigint?ino:Number(ino)}}
    const result=await collision.recoveryModule.createTagFontRecoveryRuntime(collision.runtime,async()=>anchor.path).recover({mode:'relink',scope:'local',fontPath:a.path})
    assert.equal(result.linked,1,'rounded 64-bit IDs collapsed two independent candidate copies');assert.equal(result.remaining,1)
  }finally{collision.close()}
}

async function missingHistoricalCardsRemainVisible() {
  const h = harness()
  try {
    for (let index=0; index<8; index++) h.add(make('Historical'+index), ['模板'])
    const page = await h.query.query({ sidebarPage:'tags', selectedTagName:'模板' }, 100, 0)
    assert.equal(page.total,8); assert(page.items.every(item=>item.recoveryPlaceholder&&item.fileAvailability==='missing'))
    const rootPath=require('node:path').resolve(__dirname,'../..')
    const render=require('./check-operation-chain.cjs').loader({ [require('node:path').join(rootPath,'src/renderer/src/constants/environmentConstants.ts')]: { RENDERER_ENV:{DEV:false,PROD:true},IS_DEVELOPMENT:false } })
    const library=render('src/renderer/src/library-normalize/libraryNormalizeBase.ts').createEmptyLibrary()
    library.folders=[root];library.localTags=['模板'];library.fonts=Object.fromEntries(page.items.map(font=>[font.id,font]))
    const visible=render('src/renderer/src/fontViewRuntime.ts').buildVisibleFonts({databasePageReady:true,databasePageResult:page,
      allFonts:page.items,fontIndexById:new Map(),deferredSearch:'',activeFilter:{kind:'all'},selectedWatchedFolders:[],selectedFormats:[],selectedScripts:[],
      selectedCategory:'all',selectedTagName:'模板',selectedSharedTagName:'',selectedFolderId:'',installStatus:'all',timeSortMode:'all',sortMode:'nameAsc',sidebarPage:'tags',library})
    assert.equal(visible.length,8,'backend eight historical bindings disappeared in renderer')
    assert(visible.every(font=>font.installStatusKnown===false&&!font.systemInstalled&&!font.active))
  } finally {h.close()}
}


async function sharedCountsRequireCompleteReadonlyEvidence() {
  const h=harness()
  try {
    const read=h.queryDeps.readShared
    h.queryDeps.readShared=async input=>{assert.equal(input.bindingSnapshot,true);assert.equal(input.preflight,undefined);assert.deepEqual(plain(input.entries),[]);return read(input)}
    h.sharedRows.push({font_id:'valid',relative_path:'one.ttf',tag_names_json:'["Shared"]'})
    assert.equal((await h.query.sharedTagCounts()).Shared,1)
    assert.equal(h.db.prepare("SELECT 1 FROM sqlite_master WHERE name='tag_shared_binding_snapshots'").get(),undefined)
    for(const invalid of [
      {relative_path:'one.ttf',tag_names_json:'invalid'},
      {relative_path:'one.ttf',tag_names_json:'{"tag":"Shared"}'},
      {relative_path:null,tag_names_json:'["Shared"]'},
      {relative_path:'..\\outside.ttf',tag_names_json:'["Shared"]'},
    ]){h.sharedRows.splice(0,h.sharedRows.length,invalid);await assert.rejects(h.query.sharedTagCounts(),/JSON|Unexpected|共享标签/)}
  }finally{h.close()}
}

async function extendedTagWriteCompatibility() {
  const h=harness()
  try {
    for (const [extended,canonical] of [
      ['\\\\?\\UNC\\server\\share\\one.ttf','\\\\server\\share\\one.ttf'],
      ['\\\\?\\C:\\Fonts\\one.ttf','C:\\Fonts\\one.ttf'],
    ]) {
      const font={...make('Extended'),path:extended}, item={...font,path:canonical}
      const other={...font,id:'unrelated',path:canonical.replace('one.ttf','other.ttf')}
      await h.persist(font,['Old']);await h.persist(other,['Unrelated'])
      assert.deepEqual(plain((await h.persistence.hydrateLocalTagsForFonts([item]))[0].localTagNames),['Old'])
      const writer=await h.persistence.openWriter()
      const conflict=writer.setLocalFontTagsBatch([{item,tagNames:['New'],expectedTagNames:['Changed']}],'conflict')
      assert.equal(conflict.failed.length,1)
      assert.equal(h.db.prepare('SELECT tag_name FROM local_font_tags WHERE font_path=?').get(storageKey(extended)).tag_name,'Old')
      const update=writer.setLocalFontTagsBatch([{item,tagNames:['New'],expectedTagNames:['Old']}],'updated')
      assert.equal(update.failed.length,0)
      assert.equal(h.db.prepare('SELECT COUNT(*) n FROM local_font_tags WHERE font_path=?').get(storageKey(extended)).n,0)
      assert.deepEqual(plain((await h.persistence.hydrateLocalTagsForFonts([font]))[0].localTagNames),['New'])
      writer.setLocalFontTags(item,[],'removed')
      assert.deepEqual(plain((await h.persistence.hydrateLocalTagsForFonts([font,item])).map(row=>row.localTagNames)),[[],[]])
      assert.deepEqual(plain((await h.persistence.hydrateLocalTagsForFonts([other]))[0].localTagNames),['Unrelated'])
    }
  } finally {h.close()}
}

async function legacyUncStorageRecoveryChain() {
  const unc='\\\\nas\\share\\Fonts',variants=[unc,'\\\\?\\UNC\\nas\\share\\Fonts','R:\\Fonts']
  const render=require('./check-operation-chain.cjs').loader({
    [require('node:path').resolve(__dirname,'../../src/renderer/src/constants/environmentConstants.ts')]:{RENDERER_ENV:{DEV:false,PROD:true},IS_DEVELOPMENT:false},
  })
  const admission=require('./check-operation-chain.cjs').loader()('src/main/ipc/sharedActionAdmissionRuntime.ts').createSharedActionAdmission()
  const visible=(h,page)=>{
    const library=render('src/renderer/src/library-normalize/libraryNormalizeBase.ts').createEmptyLibrary()
    library.folders=h.roots;library.localTags=['模板'];library.fonts=Object.fromEntries(page.items.map(font=>[font.id,font]))
    return render('src/renderer/src/fontViewRuntime.ts').buildVisibleFonts({databasePageReady:true,databasePageResult:page,
      allFonts:page.items,fontIndexById:new Map(),deferredSearch:'',activeFilter:{kind:'all'},selectedWatchedFolders:[],selectedFormats:[],selectedScripts:[],
      selectedCategory:'all',selectedTagName:'模板',selectedSharedTagName:'',selectedFolderId:'',installStatus:'all',timeSortMode:'all',sortMode:'nameAsc',sidebarPage:'tags',library})
  }
  for(const base of variants)for(const history of [false,true]){
    const h=harness()
    try{
      h.roots.splice(0,h.roots.length,unc);h.mappings.set('R:','\\\\nas\\share')
      const old=Array.from({length:8},(_,i)=>({...make('Unc'+i),path:base+'\\old\\Unc'+i+'.ttf'}))
      const next=old.map(font=>({...font,id:font.id+'-new',path:unc+'\\new\\'+font.fileName}))
      for(const font of old)await h.persist(font,['模板','Keep'])
      const original=plain(h.db.prepare('SELECT * FROM local_font_tags ORDER BY font_id,tag_name').all())
      for(const row of original){
        assert.equal(row.font_path,storageKey(old.find(font=>identity.localTagFontStorageId(font)===row.font_id).path))
        if(base!=='R:\\Fonts')assert.equal(row.font_path.startsWith('\\\\'),false,'fixture bypassed production storage key')
      }
      h.queryDeps.hydrate=async items=>{h.counts.hydrate++;assert(items.every(font=>!font.recoveryPlaceholder));return h.persistence.hydrateLocalTagsForFonts(items)}
      if(history){
        for(const font of old)h.put(font)
        await h.snapshots.openTagFontSnapshots(h.adapter).capture(old)
        h.live(old.map(font=>({...font,path:unc+'\\old\\'+font.fileName})))
        const livePage=await h.query.query({sidebarPage:'tags',selectedTagName:'模板'},100,0)
        assert.equal(livePage.total,8);assert(livePage.items.every(font=>font.fileAvailability==='available'&&!font.recoveryPlaceholder&&font.localTagNames.includes('模板')))
        await h.snapshots.openTagFontSnapshots(h.adapter).whenIdle()
        for(const font of old)h.files.delete(key(font.path))
        h.parsed.clear();h.live([])
        const row=h.db.prepare('SELECT font_json FROM tag_font_snapshots WHERE font_path=?').get(key(old[0].path))
        h.db.prepare('UPDATE tag_font_snapshots SET font_json=? WHERE font_path=?').run(JSON.stringify({...JSON.parse(row.font_json),path:storageKey(old[0].path)}),key(old[0].path))
      }
      const page=await h.query.query({sidebarPage:'tags',selectedTagName:'模板'},100,0)
      assert.equal(page.total,8);assert.equal(visible(h,page).length,8);assert(page.items.every(font=>font.fileAvailability==='missing'))
      assert(page.items.every(font=>font.path.startsWith('\\\\')||/^[a-z]:\\/i.test(font.path)),'storage key used as I/O path')
      assert.deepEqual(plain(h.db.prepare('SELECT * FROM local_font_tags ORDER BY font_id,tag_name').all()),original,'query rewrote storage rows')
      assert.equal((await h.query.query({sidebarPage:'tags',tagBindingsOnly:true,selectedTagName:'模板',selectedWatchedFolders:[unc+'\\old']},100,0)).total,8)
      if(!history){
        assert.equal(h.counts.hydrate,0)
        for(const channel of ['fonts:installSystem','fonts:uninstallSystem','fonts:activateFont','fonts:deleteFiles','fonts:moveFilesToFolder'])await assert.rejects(()=>admission(channel,[[page.items[0]]]),/历史字体记录/)
      }
      for(const font of next)h.put(font)
      let compatibilityPicks=0
      const cancelled=await h.recoveryModule.createTagFontRecoveryRuntime(h.runtime,async()=>{compatibilityPicks++;return undefined}).recover({mode:'relink',scope:'local',fontPath:storageKey(old[0].path)})
      assert.equal(cancelled.canceled,true);assert.equal(compatibilityPicks,1)
      const entry=require('./check-activation-entry.cjs'),ui=entry.harness({runtimePreload:true})
      const cards=visible(h,page),clicked=cards.find(font=>font.fileName.toLowerCase()==='unc0.ttf')
      ui.all.splice(0,ui.all.length,...cards);ui.select().setSelectedFontIds(cards.slice(0,2).map(font=>font.id));ui.context().openFontMenu(ui.event(),clicked)
      let picks=0,pending,dispatched
      const service=h.recoveryModule.createTagFontRecoveryRuntime(h.runtime,async anchor=>{picks++;assert.equal(key(anchor.path),key(clicked.path));return next[0].path})
      ui.handlers.set('fonts:recoverTagFiles',(_event,input,envelope)=>{dispatched=plain(input);assert.equal(envelope?.__hfmOperationTrace?.domain,'tag-recovery');pending=service.recover(input);return pending})
      const actions=ui.load(entry.renderer+'fontDialogContextActionsRuntime.ts').createFontDialogContextActions({contextMenu:ui.menu,sidebarPage:'tags',hfm:ui.window.hfm,setContextMenu:()=>{},setStatus:()=>{},refreshDatabaseDerivedState:()=>{},flushFontWriteQueue:async()=>true})
      const menu=ui.load(entry.renderer+'components/app/AppOverlays.tsx').AppOverlays({contextMenu:ui.menu,contextSelectedFonts:cards.slice(0,2),contextTargetCount:2,...actions})
      entry.button(menu,'重新链接文件').props.onClick();await entry.tick()
      assert.deepEqual(dispatched,{mode:'relink',fontPath:clicked.path,scope:'local'})
      const result=await pending
      assert.equal(picks,1);assert.equal(result.linked,history?8:1);assert.equal(result.remaining,history?0:7);assert.equal(result.failures.length,0,JSON.stringify(result))
      assert.equal(h.events.filter(event=>event==='write').length,1)
      const after=await h.query.query({sidebarPage:'tags',selectedTagName:'模板'},100,0)
      assert.equal(after.total,8);assert.equal(visible(h,after).length,8);assert.equal(after.items.filter(font=>font.fileAvailability==='available').length,history?8:1)
      assert.equal(h.db.prepare('SELECT COUNT(*) n FROM local_font_tags').get().n,16)
      for(const font of next)assert.deepEqual(await h.filesystem.readFile(font.path),bytesFor(font))
    }finally{h.close()}
  }
  for(const collision of [false,true]){
    const h=harness()
    try{
      h.roots.splice(0,h.roots.length,unc);h.mappings.set('R:','\\\\nas\\share')
      const one={...make('Unknown'),path:collision?unc+'\\old\\Unknown.ttf':'\\\\outside\\unregistered\\Unknown.ttf'}
      await h.persist(one,['模板'])
      if(collision)await h.persist({...one,path:'R:\\Fonts\\old\\Unknown.ttf'},['Other'])
      const before=plain(h.db.prepare('SELECT * FROM local_font_tags ORDER BY font_id').all())
      const page=await h.query.query({sidebarPage:'tags',selectedTagName:'模板'},100,0)
      assert.equal(page.total,1);assert.equal(visible(h,page).length,1);assert.equal(page.items[0].fileAvailability,'unavailable');assert.equal(page.items[0].recoveryPlaceholder,true)
      assert.equal(page.items[0].tagBindingReadOnly,true);assert.equal(render('src/renderer/src/fontDisplay.ts').installLabel(page.items[0]),'历史路径待确认');assert.equal(h.reads.length,0)
      let picks=0
      await assert.rejects(()=>h.recoveryModule.createTagFontRecoveryRuntime(h.runtime,async()=>{picks++;return undefined}).recover({mode:'relink',scope:'local',fontPath:collision?one.path:storageKey(one.path)}),/历史路径无法唯一确认|暂不可访问或标签关联已变化/)
      assert.equal(picks,0);assert.deepEqual(plain(h.db.prepare('SELECT * FROM local_font_tags ORDER BY font_id').all()),before)
    }finally{h.close()}
  }
}

async function main() {
  const display = load('src/renderer/src/fontDisplay.ts', { './fontUserIntentRuntime': { getUninstallIssue: () => undefined } })
  assert.equal(display.installLabel({ ...make('A'), systemInstalled: true, fileAvailability: 'missing' }), '文件丢失')
  const failures = []
  // Each group owns and closes its fixtures; collect errors without hiding later groups.
  for (const run of [sharedCountsRequireCompleteReadonlyEvidence, extendedTagWriteCompatibility, legacyUncStorageRecoveryChain, missingHistoricalCardsRemainVisible, queryCases, recoveryCases, targetedRecoveryCases, batchedAvailabilityCase, bulkRecoveryCases,
    sharedRecoveryCases, detachedAuthorizationCase, backgroundWaitCase, f08QueryCases, f08RecoveryCases, f08RefreshCases,
    f09MatchCases, f09AliasCase, f09CommitCases, f09SharedCases, f09EvidenceCases, snapshotRememberWorkCases,
    delayedQueryCaptureWorkCases, cancelledQueryCaptureWorkCases, supersededQueryCaptureWorkCase, queryStageLoggingIsolationCase,
    backgroundCaptureLeaseWorkCases, overlappingQueryCaptureLeaseCase, queryCaptureLeasePhysicalCloseCases, captureLeaseGenerationRaceCase,
    shutdownCaptureWorkCase, freshQueryAvailabilityWorkCases, f13ScopedWorkCases]) {
    try { await run() } catch (error) { failures.push(`${run.name}: ${error?.stack || String(error)}`) }
  }
  assert.equal(failures.length, 0, failures.join('\n\n'))
  console.log('[diagnostics:tag-font-recovery] retained local/shared rows and counts, deleted binding cannot resurrect from stale live/history, read-only shared metadata isolation/legacy alias cache, mapped longest root ownership, changed detached credential/native re-confirmation, batched pages, one clicked picker, tag union, actual complete/partial/cancelled/failed scan barriers')
}
if (require.main === module) {
  let completed=false
  process.once('beforeExit',()=>{if(!completed){console.error('Tag recovery diagnostic did not complete');process.exitCode=1}})
  main().then(()=>{completed=true}).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { harness, main }
