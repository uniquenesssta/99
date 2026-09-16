#!/usr/bin/env node
// Real SQLite transactions; the adapter only supplies better-sqlite3's synchronous callback shape.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { load } = require('./check-decomposition-baseline.cjs')
const file = 'src/main/library/runtime/localFontTagsRuntime.ts'
const plain = x => JSON.parse(JSON.stringify(x))
const item = id => ({ id, path: `/fonts/${id}.ttf`, fileName: id, favorite: true, deleteProtected: true, tagNames: ['shared'] })
function harness({ fault, logThrows = false, signalThrows = false, transform = x => x } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-tag-node-'))
  const dbPath = path.join(dir, 'test.sqlite')
  const db = new DatabaseSync(dbPath)
  const schema = fs.readFileSync(path.join(__dirname, '../../src/main/library/runtime/librarySchemaRuntime.ts'), 'utf8')
  for (const table of ['app_state', 'local_font_tags']) {
    const sql = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n    \\);`))
    assert(sql, table); db.exec(sql[0])
  }
  db.exec(`CREATE TABLE fonts (id TEXT PRIMARY KEY, favorite INTEGER, tag_names_json TEXT, delete_protected INTEGER);
    INSERT INTO fonts VALUES ('a',1,'["shared"]',1),('b',1,'["shared"]',1);
    INSERT INTO app_state VALUES ('localTags','["old","empty"]'),('other','{"untouched":true}');
    INSERT INTO local_font_tags VALUES ('a','\\fonts\\a.ttf','old','before'),('b','\\fonts\\b.ttf','old','before');`)
  if (fault === 'second') db.exec(`CREATE TRIGGER fail_row BEFORE INSERT ON local_font_tags WHEN NEW.font_id = 'b' BEGIN SELECT RAISE(ABORT,'second item failure'); END;`)
  if (fault === 'catalog') db.exec(`CREATE TRIGGER fail_catalog BEFORE INSERT ON app_state WHEN NEW.key = 'localTags' BEGIN SELECT RAISE(ABORT,'catalog failure'); END;`)
  const events = []
  const adapter = {
    prepare: sql => db.prepare(sql),
    transaction: fn => () => { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); events.push('commit'); return value } catch (error) { db.exec('ROLLBACK'); events.push('rollback'); throw error } }
  }
  function snapshot() {
    const reader = new DatabaseSync(dbPath)
    try { return plain({ bindings: reader.prepare('SELECT * FROM local_font_tags ORDER BY font_id, tag_name').all(), state: reader.prepare('SELECT * FROM app_state ORDER BY key').all(), fonts: reader.prepare('SELECT * FROM fonts ORDER BY id').all() }) } finally { reader.close() }
  }
  const before = snapshot()
  const runtime = load(file, {
    './localFontTagIdentityRuntime': load('src/main/library/runtime/localFontTagIdentityRuntime.ts'),
    '../tagMutationProtocolResultRuntime': load('src/main/library/tagMutationProtocolResultRuntime.ts'),
    '../../rust-core/nodeStateFallbackCompatibilityRuntime': { nodeStateFallbackCompatibilityAllowed: () => true, logNodeStateFallbackUsed() {} }
  }, transform).createLocalFontTagsRuntime({
    openLibraryDb: async () => adapter, librarySqlitePath: () => dbPath,
    appendStartupLog(message) { events.push('log'); if (logThrows) throw Error('log failure') },
    onLocalTagsMutationStateSignal(signal) { events.push('signal'); assert(events.includes('commit')); if (signalThrows) throw Error('signal failure') }
  })
  return { runtime, before, snapshot, events, close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}
async function postCommit(transform) {
  for (const method of ['single', 'batch', 'delete']) for (const fault of ['log', 'signal']) {
    const h = harness({ logThrows: fault === 'log', signalThrows: fault === 'signal', transform })
    try {
      const result = method === 'single' ? await h.runtime.setLocalFontTags(item('a'), ['new']) : method === 'batch' ? await h.runtime.setLocalFontTagsBatch(['a','b'].map(id => ({ item: item(id), tagNames: ['new'] }))) : await h.runtime.deleteLocalFontTag('old')
      assert.equal(result.ok, true, `${method}/${fault} committed result`)
      assert.equal(result.failed.length, 0); assert(result.updatedIds.length > 0); assert.equal(result.mutationProtocol.ok, true)
      const after = h.snapshot(); assert.notDeepEqual(after.bindings, h.before.bindings)
      assert.deepEqual(after.fonts, h.before.fonts)
      assert.equal(h.events[0], 'commit'); assert(h.events.includes('signal'), 'logger must not prevent signal')
      assert.deepEqual(plain(result.mutationProtocol.knownTags), JSON.parse(after.state.find(x => x.key === 'localTags').value))
    } finally { h.close() }
  }
}
async function rollbackAndLifecycle() {
  for (const fault of ['second', 'catalog']) {
    const h = harness({ fault })
    try {
      const r = await h.runtime.setLocalFontTagsBatch(['a','b'].map(id => ({ item: item(id), tagNames: ['new'] })))
      assert.equal(r.ok, false); assert.deepEqual(plain(r.updatedIds), []); assert.equal(r.failed.length, 2)
      assert.deepEqual(plain(r.mutationProtocol.knownTags), ['empty','old'], 'failed response must not publish uncommitted catalog');
      assert.deepEqual(h.snapshot(), h.before, 'real DB must fully roll back'); assert.deepEqual(h.events, ['rollback'])
    } finally { h.close() }
  }
  for (const method of ['single','delete']) {
    const h = harness({ fault: 'catalog' })
    try {
      if (method === 'single') await assert.rejects(() => h.runtime.setLocalFontTags(item('a'), ['new']), /catalog failure/)
      else { const r = await h.runtime.deleteLocalFontTag('old'); assert.equal(r.ok, false); assert.equal(r.updatedIds.length, 0) }
      assert.deepEqual(h.snapshot(), h.before); assert.deepEqual(h.events, ['rollback'])
    } finally { h.close() }
  }
  const h = harness()
  try {
    const input = ['a','b'].map(id => ({ item: item(id), tagNames: [] })); const original = plain(input)
    const r = await h.runtime.setLocalFontTagsBatch(input); assert.equal(r.ok, true); assert.deepEqual(input, original)
    const cleared = h.snapshot(); assert.equal(cleared.bindings.length, 0); assert.deepEqual(JSON.parse(cleared.state.find(x => x.key === 'localTags').value), ['empty','old'])
    const d = await h.runtime.deleteLocalFontTag('old'); assert.equal(d.ok, true); assert.equal(d.updatedIds.length, 0)
    const deleted = h.snapshot(); assert.deepEqual(JSON.parse(deleted.state.find(x => x.key === 'localTags').value), ['empty'])
    assert.deepEqual(deleted.fonts, h.before.fonts); assert.deepEqual(deleted.state.find(x=>x.key==='other'), h.before.state.find(x=>x.key==='other'))
  } finally { h.close() }
}
async function main() {
  await postCommit(); await rollbackAndLifecycle()
  await assert.rejects(() => postCommit(s => {
    const start = s.indexOf('  const appendStartupLog = (message: string): void => {')
    const end = s.indexOf('  const hasLifecycleBaseline', start)
    assert(start >= 0 && end > start)
    return s.slice(0, start) + '  const appendStartupLog = options.appendStartupLog;\n' + s.slice(end)
  }), /log failure/)
  console.log('[diagnostics:local-tag-node-persistence] real SQLite rollback/readback, Nth row/catalog failure, post-commit log/signal failure, empty catalog lifecycle and field isolation passed')
}
module.exports = { postCommit, rollbackAndLifecycle, harness }
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1 })
