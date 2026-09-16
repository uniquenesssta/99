#!/usr/bin/env node
// Real SQLite transactions; the adapter only supplies better-sqlite3's synchronous callback shape.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { load } = require('./check-decomposition-baseline.cjs')
const file = 'src/main/library/runtime/localFontTagsRuntime.ts'
const nodeFile = 'src/main/library/runtime/localFontTagNodePersistenceRuntime.ts'
const plain = x => JSON.parse(JSON.stringify(x))
const item = id => ({ id, path: `/fonts/${id}.ttf`, fileName: id, favorite: true, deleteProtected: true, tagNames: ['shared'] })
function harness({ fault, logThrows = false, signalThrows = false, transform = x => x, nodeTransform = x => x } = {}) {
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
  const mocks = {
    './localFontTagIdentityRuntime': load('src/main/library/runtime/localFontTagIdentityRuntime.ts'),
    '../tagMutationProtocolResultRuntime': load('src/main/library/tagMutationProtocolResultRuntime.ts'),
    '../../rust-core/nodeStateFallbackCompatibilityRuntime': { nodeStateFallbackCompatibilityAllowed: () => true, logNodeStateFallbackUsed() {} }
  }
  mocks['./localFontTagNodePersistenceRuntime'] = load(nodeFile, mocks, nodeTransform)
  const runtime = load(file, mocks, transform).createLocalFontTagsRuntime({
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
      const byIds = await h.runtime.localTagsByFontIds(['a','b','a'])
      for (const id of ['a','b']) assert.deepEqual(plain(byIds[id] || []), after.bindings.filter(x=>x.font_id===id).map(x=>x.tag_name))
      const hydrated = await h.runtime.hydrateLocalTagsForFonts([item('a'),item('b')])
      for (const font of hydrated) {
        assert.deepEqual(plain(font.localTagNames), after.bindings.filter(x=>x.font_id===font.id).map(x=>x.tag_name))
        assert.equal(font.favorite, true); assert.equal(font.deleteProtected, true); assert.deepEqual(plain(font.tagNames), ['shared'])
      }
      assert.deepEqual(after.fonts, h.before.fonts)
      assert.equal(h.events[0], 'commit'); assert(h.events.includes('signal'), 'logger must not prevent signal')
      assert.deepEqual(plain(result.mutationProtocol.knownTags), JSON.parse(after.state.find(x => x.key === 'localTags').value))
    } finally { h.close() }
  }
}
async function rollbackAndLifecycle(nodeTransform) {
  for (const fault of ['second', 'catalog']) {
    const h = harness({ fault, nodeTransform })
    try {
      const r = await h.runtime.setLocalFontTagsBatch(['a','b'].map(id => ({ item: item(id), tagNames: ['new'] })))
      assert.equal(r.ok, false); assert.deepEqual(plain(r.updatedIds), []); assert.equal(r.failed.length, 2)
      assert.deepEqual(plain(r.mutationProtocol.knownTags), ['empty','old'], 'failed response must not publish uncommitted catalog');
      assert.deepEqual(h.snapshot(), h.before, 'real DB must fully roll back'); assert.deepEqual(h.events, ['rollback'])
    } finally { h.close() }
  }
  for (const method of ['single','delete']) {
    const h = harness({ fault: 'catalog', nodeTransform })
    try {
      if (method === 'single') await assert.rejects(() => h.runtime.setLocalFontTags(item('a'), ['new']), /catalog failure/)
      else { const r = await h.runtime.deleteLocalFontTag('old'); assert.equal(r.ok, false); assert.equal(r.updatedIds.length, 0) }
      assert.deepEqual(h.snapshot(), h.before); assert.deepEqual(h.events, ['rollback'])
    } finally { h.close() }
  }
  const h = harness({ nodeTransform })
  try {
    const input = ['a','b'].map(id => ({ item: item(id), tagNames: [] })); const original = plain(input)
    const r = await h.runtime.setLocalFontTagsBatch(input); assert.equal(r.ok, true); assert.deepEqual(input, original)
    const cleared = h.snapshot(); assert.equal(cleared.bindings.length, 0); assert.deepEqual(JSON.parse(cleared.state.find(x => x.key === 'localTags').value), ['empty','old'])
    const d = await h.runtime.deleteLocalFontTag('old'); assert.equal(d.ok, true); assert.equal(d.updatedIds.length, 0)
    const deleted = h.snapshot(); assert.deepEqual(JSON.parse(deleted.state.find(x => x.key === 'localTags').value), ['empty'])
    assert.deepEqual(deleted.fonts, h.before.fonts); assert.deepEqual(deleted.state.find(x=>x.key==='other'), h.before.state.find(x=>x.key==='other'))
  } finally { h.close() }
}
function transactionBodies(source) {
  const ts = require('typescript'), { bodies } = require('./check-preview-storage-routing.cjs')
  const ast = ts.createSourceFile('tags.ts', source.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true)
  const found = []
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'db.transaction') {
      found.push(bodies('function transaction() ' + node.arguments[0].body.getText(ast)).transaction)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast); return found
}
function checkStructure() {
  const { bodies } = require('./check-preview-storage-routing.cjs')
  const root = path.join(__dirname, '../..')
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/local-tag-node-persistence.fixture.json')))
  for (const [file, expected] of Object.entries(fixture.files)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    for (const text of [source, source.replace(/\r?\n/g, '\r\n')]) {
      const actual = bodies(text)
      for (const [name, hash] of Object.entries(expected)) assert.equal(actual[name], hash, 'frozen ' + name)
    }
  }
  assert.deepEqual(transactionBodies(fs.readFileSync(path.join(root, nodeFile), 'utf8')), fixture.transactions)
  const facade = fs.readFileSync(path.join(root, file), 'utf8')
  assert(!/db\.(prepare|transaction)/.test(facade), 'SQL must have one owner')
  const owner = fs.readFileSync(path.join(root, nodeFile), 'utf8')
  assert(!/runRust|appendStartupLog|emitLocalTags|nodeStateFallback/.test(owner), 'owner must not choose backend or notify')
}
async function concurrentOrder() {
  const h = harness()
  try {
    await Promise.all(['a','b'].map(id => h.runtime.setLocalFontTags(item(id), ['new-' + id])))
    assert.deepEqual(h.events.filter(x => x === 'commit' || x === 'signal'), ['commit','signal','commit','signal'], 'no await between commit and signal')
  } finally { h.close() }
}
async function main() {
  checkStructure()
  await postCommit(); await rollbackAndLifecycle(); await concurrentOrder()
  for (const mutate of [
    s => s.replaceAll('db.transaction(', '((work) => work)('),
    s => s.replaceAll('saveKnownLocalTags(db, knownTags);', ''),
    s => s.replace('knownTags = previousKnownTags;', '')
  ]) await assert.rejects(() => rollbackAndLifecycle(mutate), assert.AssertionError)
  await assert.rejects(() => postCommit(s => {
    const start = s.indexOf('  const appendStartupLog = (message: string): void => {')
    const end = s.indexOf('  const hasLifecycleBaseline', start)
    assert(start >= 0 && end > start)
    return s.slice(0, start) + '  const appendStartupLog = options.appendStartupLog;\n' + s.slice(end)
  }), /log failure/)
  console.log('[diagnostics:local-tag-node-persistence] real SQLite rollback/readback, Nth row/catalog failure, post-commit log/signal failure, empty catalog lifecycle, real reads and field isolation; four mutants, helper/read/transaction locks passed')
}
module.exports = { postCommit, rollbackAndLifecycle, harness, transactionBodies }
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1 })
