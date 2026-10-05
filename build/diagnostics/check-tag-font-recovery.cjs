#!/usr/bin/env node
// Windows CI: real query/recovery/snapshot code, SQLite, controlled filesystem/dialog ports.
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path').win32
const { load } = require('./check-decomposition-baseline.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
const key = value => String(value).replaceAll('/', '\\').toLowerCase()
const inside = (file, root) => key(file) === key(root) || key(file).startsWith(key(root) + '\\')
const root = 'C:\\Fonts'
const make = (name, folder = 'old') => ({ id: `${folder}-${name}`, path: `${root}\\${folder}\\${name}.ttf`, fileName: `${name}.ttf`, family: name, fullName: name,
  postscriptName: name, style: 'Regular', format: 'ttf', fileSize: 100, modifiedAt: 1, addedAt: '', favorite: false,
  collectionIds: [], tagNames: [], localTagNames: [], systemInstalled: false, systemInstallMatches: [], active: false })

function harness() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE local_font_tags (font_id TEXT, font_path TEXT, tag_name TEXT)')
  const adapter = { exec: sql => db.exec(sql), prepare: sql => db.prepare(sql), transaction: fn => () => {
    db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value } catch (e) { db.exec('ROLLBACK'); throw e }
  } }
  const files = new Map(), parsed = new Map(), roots = [root], sharedRows = []
  const reads = []
  const filesystem = {
    async stat(file) {
      if (files.get(key(file)) instanceof Error) throw files.get(key(file))
      if (files.has(key(file))) return { isDirectory: () => files.get(key(file)) === 'directory', isFile: () => files.get(key(file)) !== 'directory' }
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
    '../path/cachePath': { normalizePathForCacheCompare: key },
    '../folders/physicalFolders': { pathInsideFolder: inside },
    '../path/sharedFileSystemRuntime': { sharedFileSystem: filesystem },
    '../fonts/fontRuntime': { hasValidFontSignature: async file => parsed.has(key(file)), asFormat: file => /\.ttf$/i.test(file) ? 'ttf' : 'unknown', fontItemFromPath: async file => {
      if (!parsed.has(key(file))) throw Error('bad font')
      return { ...parsed.get(key(file)) }
    } },
    '../indexing/shared-metadata/sharedMetadataPathsRuntime': { sharedMetadataDbPathForRoot: root => root + '\\metadata.sqlite' },
    '../indexing/shared-metadata/sharedMetadataStateRuntime': { stateFromRow: row => ({ tagNames: JSON.parse(row.tag_names_json) }) },
    '../ipc/sharedActionAdmissionRuntime': { createSharedActionAdmission: () => async () => {} },
    '../app/shutdownCoordinatorRuntime': { applicationWorkEpoch: () => 0, assertApplicationOpen() {} },
  }
  const snapshots = load('src/main/library/tagFontSnapshotRuntime.ts', mocks)
  mocks['./tagFontSnapshotRuntime'] = snapshots
  const queryModule = load('src/main/library/tagFontQueryRuntime.ts', mocks)
  mocks['./tagFontQueryRuntime'] = queryModule
  const recoveryModule = load('src/main/library/tagFontRecoveryRuntime.ts', mocks)
  const remember = fonts => snapshots.openTagFontSnapshots(adapter).remember(fonts)
  const add = (font, tags) => { for (const tag of tags) db.prepare('INSERT INTO local_font_tags VALUES (?, ?, ?)').run(font.id, key(font.path), tag) }
  const put = font => { files.set(key(font.path), true); parsed.set(key(font.path), font) }
  let live = []
  const query = queryModule.createTagFontQueryRuntime({ canReadDetached: async () => true, openLibraryDb: async () => adapter, roots: async () => roots,
    readShared: async () => ({ preflight: { snapshot: { rows: sharedRows } } }),
    queryLive: async (_request, limit, offset) => ({ items: live.slice(offset, offset + limit), total: live.length, offset, limit, queryKey: 'tags', engine: 'sql', truncated: false, elapsedMs: 0 }),
    hydrate: async items => items,
    matches: (font, request) => (!request.keyword || font.fileName.includes(request.keyword)) && (!request.selectedTagName || (request.sidebarPage === 'sharedTags' ? font.tagNames : font.localTagNames || []).includes(request.selectedTagName)),
    compare: (a, b) => a.fileName.localeCompare(b.fileName),
  })
  const events = []
  const runtime = {
    loadLibraryShell: async () => ({ folders: roots }),
    queryFontPageInLibrary: async request => ['library', 'filters'].includes(request.sidebarPage)
      ? { items: [...parsed.values()].slice(request.offset, request.offset + request.limit), total: parsed.size }
      : query.query(request, request.limit || 500, request.offset || 0),
    refreshWatchedFolder: async (_folder, _root, wait) => { assert.equal(wait, true); events.push('scan-complete') },
    setLocalFontTagsBatch: async entries => {
      events.push('write')
      adapter.transaction(() => { for (const { item, tagNames } of entries) { db.prepare('DELETE FROM local_font_tags WHERE font_path = ?').run(key(item.path)); add(item, tagNames) } })()
      remember(entries.map(entry => entry.item)); query.invalidate()
      return { ok: true, failed: [], updatedIds: entries.map(entry => entry.item.id) }
    },
  }
  return { db, adapter, files, roots, parsed, sharedRows, reads, put, add, remember, query, queryModule, recoveryModule, runtime, events,
    live: fonts => { live = fonts; query.invalidate() }, close: () => db.close() }
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
      assert.equal(h.recoveryModule.sameRecoveryFont({ ...a, postscriptName: '' }, nextA), false)
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
  let modifiedAt = font.modifiedAt
  try {
    const module = load('src/main/library/tagRelinkAuthorizationRuntime.ts', {
      '../path/cachePath': { normalizePathForCacheCompare: key },
      '../path/sharedFileSystemRuntime': { sharedFileSystem: { realpath: async file => file, stat: async () => ({ isFile: () => true, size: font.fileSize, mtimeMs: modifiedAt }) } },
    })
    const service = module.createTagRelinkAuthorizationRuntime(async () => h.adapter)
    await service.rememberRelinkedFontFile(font)
    assert.equal(await service.contains(font.path), false, 'a credential without tag membership must not grant access')
    h.add(font, ['T'])
    assert.equal(await service.contains(font.path), true)
    const restored = module.createTagRelinkAuthorizationRuntime(async () => h.adapter)
    assert.equal(await restored.canReadDetached(font.path), true)
    modifiedAt++
    assert.equal(await restored.contains(font.path), false, 'replaced files require explicit authorization again')
    modifiedAt--
    h.db.exec('DELETE FROM local_font_tags')
    assert.equal(await restored.contains(font.path), false)
  } finally { h.close() }
}

async function backgroundWaitCase() {
  const { createManualFolderRefreshBackgroundRuntime } = load('src/main/watcher/manual-refresh/manualFolderRefreshBackgroundRuntime.ts')
  const runtime = createManualFolderRefreshBackgroundRuntime({ appendStartupLog() {} })
  let finish, done = false
  runtime.scheduleRefresh('root', 'job', () => new Promise(resolve => { finish = resolve }))
  const waiting = runtime.waitForRefresh('root').then(() => { done = true })
  await Promise.resolve(); assert.equal(done, false); finish(); await waiting; assert.equal(done, true)
  const error = Error('failed scan')
  runtime.scheduleRefresh('other', 'failed', async () => { throw error })
  await assert.rejects(runtime.waitForRefresh('other'), value => value === error)
}

async function main() {
  const display = load('src/renderer/src/fontDisplay.ts', { './fontUserIntentRuntime': { getUninstallIssue: () => undefined } })
  assert.equal(display.installLabel({ ...make('A'), systemInstalled: true, fileAvailability: 'missing' }), '文件丢失')
  await queryCases(); await recoveryCases(); await targetedRecoveryCases(); await batchedAvailabilityCase(); await sharedRecoveryCases(); await detachedAuthorizationCase(); await backgroundWaitCase()
  console.log('[diagnostics:tag-font-recovery] retained local/shared rows, batched directory availability/concurrent pages, root ownership before NAS/fallback/failure, clicked anchor and one picker, unmatched siblings, cancellation, failed write, tag union, completed scan barrier')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
