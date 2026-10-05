#!/usr/bin/env node
// Windows CI: real query/recovery/snapshot code, SQLite, controlled filesystem/dialog ports.
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path').win32
const crypto = require('node:crypto')
const bytesFor = font => { const bytes = Buffer.alloc(font.fileSize || 100); if (['ttc','otc'].includes(font.format)) bytes.write('ttcf'); else if (font.format === 'otf') bytes.write('OTTO'); else bytes.writeUInt32BE(0x00010000); bytes.write(String(font.postscriptName || font.fileName), 4); return bytes }
const hashFor = font => crypto.createHash('sha256').update(bytesFor(font)).digest('hex')
const { load } = require('./check-decomposition-baseline.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
const key = value => String(value).replaceAll('/', '\\').toLowerCase()
const inside = (file, root) => key(file) === key(root) || key(file).startsWith(key(root) + '\\')
const root = 'C:\\Fonts'
const refreshReceipt = (folder, extra = {}) => ({ ok: true, folder, rootPath: folder, mode: 'cache-read', cacheRepairs: [], upserts: 0, deletes: 0, errors: 0, totalFiles: 0, parsed: 0, fromCache: 0, skippedBad: 0, elapsedMs: 0, message: 'done', ...extra })
const make = (name, folder = 'old') => ({ recoveryContentHash: hashFor({ postscriptName: name, fileSize: 100 }), id: `${folder}-${name}`, path: `${root}\\${folder}\\${name}.ttf`, fileName: `${name}.ttf`, family: name, fullName: name,
  postscriptName: name, style: 'Regular', format: 'ttf', fileSize: 100, modifiedAt: 1, addedAt: '', favorite: false,
  collectionIds: [], tagNames: [], localTagNames: [], systemInstalled: false, systemInstallMatches: [], active: false })

function harness() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE local_font_tags (font_id TEXT, font_path TEXT, tag_name TEXT)')
  const adapter = { exec: sql => db.exec(sql), prepare: sql => db.prepare(sql), transaction: fn => () => {
    db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value } catch (e) { db.exec('ROLLBACK'); throw e }
  } }
  const files = new Map(), parsed = new Map(), roots = [root], sharedRows = []
  const reads = [], queryRequests = [], mappings = new Map()
  const counts = { live: 0, hydrate: 0, parse: 0 }
  const contents = new Map()
  const filesystem = {
    realpath: async file => { await filesystem.stat(file); return file },
    readFile: async file => contents.get(key(file)) || bytesFor(parsed.get(key(file))),
    async stat(file) {
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
    '../path/pathCanonicalizer': { mappedDriveTableAsync: async () => mappings },
    '../path/pathBoundaryPolicy': load('src/main/path/pathBoundaryPolicy.ts'),
    '../path/cachePath': { normalizePathForCacheCompare: key },
    '../folders/physicalFolders': { pathInsideFolder: inside },
    '../path/sharedFileSystemRuntime': { sharedFileSystem: filesystem },
    '../fonts/fontRuntime': { hasValidFontSignature: async file => parsed.has(key(file)), asFormat: file => /\.(ttf|otf|ttc|otc)$/i.exec(file)?.[1].toLowerCase() || 'unknown', fontItemFromPath: async file => {
      counts.parse++
      if (!parsed.has(key(file))) throw Error('bad font')
      return { ...parsed.get(key(file)) }
    } },
    '../indexing/shared-metadata/sharedMetadataPathsRuntime': { sharedMetadataDbPathForRoot: root => root + '\\metadata.sqlite' },
    '../indexing/shared-metadata/sharedMetadataStateRuntime': { stateFromRow: row => ({ tagNames: JSON.parse(row.tag_names_json) }) },
    '../ipc/sharedActionAdmissionRuntime': { createSharedActionAdmission: () => async () => {} },
    '../app/shutdownCoordinatorRuntime': { applicationWorkEpoch: () => 0, assertApplicationOpen() {} },
  }
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
  const add = (font, tags) => { for (const tag of tags) db.prepare('INSERT INTO local_font_tags VALUES (?, ?, ?)').run(font.id, key(font.path), tag) }
  const put = font => { files.set(key(font.path), true); parsed.set(key(font.path), font) }
  let live = []
  const queryDeps = { canReadDetached: async () => true, openLibraryDb: async () => adapter, roots: async () => roots,
    readShared: async () => ({ preflight: { snapshot: { rows: sharedRows } } }),
    queryLive: async (_request, limit, offset) => { counts.live++; return { items: live.slice(offset, offset + limit), total: live.length, offset, limit, queryKey: 'tags', engine: 'sql', truncated: false, elapsedMs: 0 } },
    hydrate: async items => { counts.hydrate++; return items },
    matches: (font, request) => (!request.keyword || font.fileName.includes(request.keyword)) && (!request.selectedTagName || (request.sidebarPage === 'sharedTags' ? font.tagNames : font.localTagNames || []).includes(request.selectedTagName)),
    compare: (a, b) => a.fileName.localeCompare(b.fileName),
  }
  const query = queryModule.createTagFontQueryRuntime(queryDeps)
  const transactionModule = load('src/main/library/runtime/localFontRecoveryTransactionRuntime.ts', {
    '../../path/cachePath': { normalizePathForCacheCompare: key },
    './localFontTagIdentityRuntime': { localTagFontPath: font => key(font.path) },
    'node:fs': { realpathSync: file => file, readFileSync: file => contents.get(key(file)) || bytesFor(parsed.get(key(file))), statSync: file => { if (files.has(key(file))) return { isDirectory: () => files.get(key(file)) === 'directory' }; if (roots.includes(file)) return { isDirectory: () => true }; throw Object.assign(Error('missing'), { code: 'ENOENT' }) } },
  })
  const events = []
  const runtime = {
    loadLibraryShell: async () => ({ folders: roots }),
    queryFontPageInLibrary: async request => { queryRequests.push(request); return ['library', 'filters'].includes(request.sidebarPage)
      ? { items: [...parsed.values()].slice(request.offset, request.offset + request.limit), total: parsed.size }
      : query.query(request, request.limit || 500, request.offset || 0) },
    refreshWatchedFolder: async (_folder, _root, wait) => { assert.equal(wait, true); events.push('scan-complete'); return refreshReceipt(_root) },
    setLocalFontTagsBatch: async (entries, options) => {
      events.push('write')
      adapter.transaction(() => { transactionModule.validateRecoveryMissingSources(options?.recoveryMissingSources || []); transactionModule.validateRecoveryFiles(options?.recoveryFiles || []); transactionModule.validateRecoveryTagWrites(adapter, entries); transactionModule.preserveLocalRecoveryState(adapter, options?.recoveryMoves || []); for (const { item, tagNames } of entries) { db.prepare('DELETE FROM local_font_tags WHERE font_path = ?').run(key(item.path)); add(item, tagNames) } })()
      remember(entries.map(entry => entry.item)); query.invalidate()
      return { ok: true, failed: [], updatedIds: entries.map(entry => entry.item.id) }
    },
  }
  return { db, adapter, files, roots, parsed, sharedRows, reads, queryRequests, counts, put, add, remember, query, queryModule, recoveryModule, runtime, events,
    pathsModule, mappings, queryDeps, snapshots, filesystem, contents, transactionModule, live: fonts => { live = fonts; query.invalidate() }, close: () => db.close() }
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
    h.db.prepare('DELETE FROM local_font_tags WHERE font_path = ?').run(key(b.path)); h.query.invalidate()
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
        assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(key(a.path)).n, 2)
      } else {
        assert.equal(result.linked, 2); assert.equal(result.remaining, 0)
        assert.deepEqual(h.db.prepare('SELECT tag_name FROM local_font_tags WHERE font_path = ? ORDER BY tag_name').all(key(nextA.path)).map(row => row.tag_name), ['Existing', 'Keep', 'T'])
        assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(key(a.path)).n, 0)
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
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(key(c.path)).n, 1)
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
      assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(key(originals[0].path)).n, failWrite ? 2 : 0)
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
    assert.equal((await h.query.sharedTagCounts()).Shared, 1)
    const display = load('src/renderer/src/fontDisplay.ts', { './fontUserIntentRuntime': { getUninstallIssue: () => undefined } })
    assert.equal(display.installLabel(retained.items[0]), '共享标签暂不可读取')
    await assert.rejects(h.recoveryModule.createTagFontRecoveryRuntime(h.runtime, async () => { throw Error('must not open') })
      .recover({ mode: 'relink', scope: 'shared', fontPath: retained.items[0].path }), /此字体已恢复/)
    // A successful authoritative empty snapshot removes the old binding.
    h.sharedRows.length = 0
    h.queryDeps.readShared = async () => ({ preflight: { snapshot: { rows: h.sharedRows } } })
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
    stale.db.prepare('INSERT INTO local_font_tags VALUES (?, NULL, ?)').run(legacy.id, 'T'); stale.put(legacy)
    stale.live([{ ...liveFont, localTagNames: ['T'] }, { ...legacy, localTagNames: ['T'] }])
    assert.equal((await stale.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0)).total, 2)
    stale.db.prepare('DELETE FROM local_font_tags WHERE font_path = ?').run(key(liveFont.path)); stale.query.invalidate()
    const page = await stale.query.query({ sidebarPage: 'tags', selectedTagName: 'T' }, 10, 0)
    // The query returns a VM array; compare its data in this realm, as above.
    assert.deepEqual(plain(page.items.map(font => font.id)), [legacy.id], 'stale live pages and history must not resurrect a deleted path binding; ID-only legacy membership remains')
  } finally { stale.close() }
  const mixed = harness(), blocked = '\\\\server\\blocked'
  try {
    mixed.roots.push(blocked)
    mixed.queryDeps.readShared = async ({rootPath}) => {
      if (rootPath===blocked) throw Error('offline without historical metadata')
      return { preflight:{ snapshot:{ rows:[{font_id:'healthy',relative_path:'old/A.ttf',tag_names_json:'["Shared"]'}] } } }
    }
    mixed.queryDeps.queryLive = async request => {
      assert.deepEqual(plain(request.selectedWatchedFolders), [root], 'failed shared root must be excluded from the live page range')
      return {items:[],total:0}
    }
    assert.equal((await mixed.query.query({sidebarPage:'sharedTags',selectedTagName:'Shared',selectedWatchedFolders:[root,blocked]},10,0)).total,1)
    assert.equal(await mixed.query.sharedTagCounts(),undefined,'unknown membership on an unreadable root must not be reported as zero')
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
    assert.deepEqual(h.db.prepare('SELECT tag_name FROM local_font_tags WHERE font_path = ? ORDER BY tag_name').all(key(outside.path)).map(row => row.tag_name), ['Keep', 'T'], 'same-path confirmation must not append a clear-old operation')
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
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(key(nextB.path)).n,1)
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ?').get(key(make('Unrelated','new').path)).n,0)
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
        assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ? AND tag_name = ?').get(key(old.path),'T').n,1)
        assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM local_font_tags WHERE font_path = ? AND tag_name = ?').get(key(next.path),'T').n,0)
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

async function main() {
  const display = load('src/renderer/src/fontDisplay.ts', { './fontUserIntentRuntime': { getUninstallIssue: () => undefined } })
  assert.equal(display.installLabel({ ...make('A'), systemInstalled: true, fileAvailability: 'missing' }), '文件丢失')
  const failures = []
  // Each group owns and closes its fixtures; collect errors without hiding later groups.
  for (const run of [queryCases, recoveryCases, targetedRecoveryCases, batchedAvailabilityCase, bulkRecoveryCases,
    sharedRecoveryCases, detachedAuthorizationCase, backgroundWaitCase, f08QueryCases, f08RecoveryCases, f08RefreshCases,
    f09MatchCases, f09AliasCase, f09CommitCases, f09SharedCases, f09EvidenceCases]) {
    try { await run() } catch (error) { failures.push(`${run.name}: ${error?.stack || String(error)}`) }
  }
  assert.equal(failures.length, 0, failures.join('\n\n'))
  console.log('[diagnostics:tag-font-recovery] retained local/shared rows and counts, deleted binding cannot resurrect from stale live/history, read-only shared metadata isolation/legacy alias cache, mapped longest root ownership, changed detached credential/native re-confirmation, batched pages, one clicked picker, tag union, actual complete/partial/cancelled/failed scan barriers')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
