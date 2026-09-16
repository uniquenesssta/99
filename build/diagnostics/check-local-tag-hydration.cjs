#!/usr/bin/env node
const assert = require('node:assert/strict')
const { load } = require('./check-decomposition-baseline.cjs')
const file = 'src/main/library/runtime/localFontTagsRuntime.ts'
const identity = load('src/main/library/runtime/localFontTagIdentityRuntime.ts')
const plain = value => JSON.parse(JSON.stringify(value))
function harness({ rows = [], allowed = true, rust, transform = x => x } = {}) {
  const calls = { opens: 0, queries: [], rust: [], used: 0, disabled: 0 }
  const mocks = {
    './localFontTagIdentityRuntime': identity,
    '../tagMutationProtocolResultRuntime': {},
    '../../rust-core/nodeStateFallbackCompatibilityRuntime': {
      nodeStateFallbackCompatibilityAllowed: () => allowed,
      logNodeStateFallbackUsed() { calls.used++ }, logNodeStateFallbackDisabled() { calls.disabled++ }
    }
  }
  mocks['./localFontTagNodePersistenceRuntime'] = load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts', mocks, transform)
  const runtime = load(file, mocks).createLocalFontTagsRuntime({
    librarySqlitePath: () => '/isolated.db',
    runRustLocalTagsRead: rust && (async input => { calls.rust.push(plain(input)); return rust(input) }),
    openLibraryDb: async () => {
      calls.opens++
      return { prepare(sql) { return { all(...args) {
        const field = sql.includes('SELECT font_id,') ? 'font_id' : 'font_path'
        calls.queries.push({ field, args })
        assert(args.length <= 500)
        assert.equal(new Set(args).size, args.length)
        return rows.filter(row => args.includes(row[field]))
      } } } }
    }
  })
  return { calls, read: runtime.hydrateLocalTagsForFonts }
}
async function identityCases(transform) {
  const items = [
    { id: 'a', sourceId: 'shared', path: ' C:/F/ONE.ttf/ ', favorite: true, tagNames: ['shared-tag'], deleteProtected: true },
    { id: 'b', sourceId: 'shared', path: 'c:/f/two.ttf' },
    { id: 'c', path: 'c:\\f\\ONE.ttf' },
    { id: 'independent', path: '/else.ttf' },
    { id: 'no-path', sourceId: 'shared' },
    { id: 'a', sourceId: 'shared', path: 'C:/f/one.ttf' }
  ]
  const original = plain(items)
  const h = harness({ transform, rows: [
    { font_id: 'shared', font_path: '', tag_name: 'common' },
    { font_id: 'a', font_path: '', tag_name: 'only-a' },
    { font_id: '', font_path: 'c:\\f\\one.ttf', tag_name: 'path' },
    { font_id: '', font_path: 'c:\\f\\one.ttf', tag_name: 'path' },
    { font_id: 'independent', font_path: '', tag_name: 'isolated' }
  ] })
  const result = await h.read(items)
  assert.deepEqual(plain(result.map(x => x.localTagNames)), [ ['common', 'only-a', 'path'], ['common'], ['path'], ['isolated'], ['common'], ['common', 'only-a', 'path'] ])
  assert.deepEqual(items, original)
  for (let i = 0; i < items.length; i++) { assert.notEqual(result[i], items[i]); const { localTagNames, ...rest } = result[i]; assert.deepEqual(plain(rest), items[i]) }
  assert.equal(h.calls.opens, 1)
  assert.equal(h.calls.queries.length, 2)
  const empty = []; const e = harness(); assert.equal(await e.read(empty), empty); assert.equal(e.calls.opens, 0)
}
async function chunks() {
  const items = Array.from({ length: 1001 }, (_, i) => ({ id: `i${i}`, path: `/fonts/${i}.ttf` }))
  const rows = items.map(x => ({ font_id: x.id, font_path: identity.localTagFontPath(x), tag_name: x.id }))
  const h = harness({ rows }); const result = await h.read(items)
  assert.deepEqual(plain(result.map(x => x.localTagNames)), items.map(x => [x.id]))
  for (const field of ['font_id', 'font_path']) assert.deepEqual(h.calls.queries.filter(x => x.field === field).map(x => x.args.length), [500, 500, 1])
}
async function backendCases() {
  const items = [{ id: 'a', sourceId: 'shared', path: 'C:/A.ttf', localTagNames: ['old'] }, { id: 'b', sourceId: 'shared', path: 'c:\\a.ttf' }]
  const snapshot = plain(items)
  for (const allowed of [false, true]) {
    for (const tagMap of [{ a: ['tag'], b: ['tag'] }, {}]) {
      const h = harness({ allowed, rust: async () => ({ tagMap }) })
      const out = await h.read(items)
      assert.deepEqual(plain(out.map(x => x.localTagNames)), [tagMap.a || [], tagMap.b || []])
      assert.equal(h.calls.opens, 0); assert.equal(h.calls.used, 0); assert.equal(h.calls.disabled, 0)
      assert.deepEqual(h.calls.rust[0].rows, [ { itemId: 'a', aliases: ['a', 'shared'], fontPath: 'c:\\a.ttf' }, { itemId: 'b', aliases: ['b', 'shared'], fontPath: 'c:\\a.ttf' } ])
    }
    for (const rust of [undefined, async () => null, async () => { throw Error('Rust read failed') }]) {
      const h = harness({ allowed, rust, rows: [{ font_id: 'shared', font_path: '', tag_name: 'tag' }] })
      const out = await h.read(items)
      if (allowed) assert.deepEqual(plain(out.map(x => x.localTagNames)), [['tag'], ['tag']])
      else assert.equal(out, items)
      assert.equal(h.calls.opens, +allowed); assert.equal(h.calls.disabled, +!allowed); assert.equal(h.calls.used, +allowed)
    }
  }
  assert.deepEqual(items, snapshot)
}
async function main() {
  await identityCases(); await chunks(); await backendCases()
  for (const target of ['aliasToRuntimeIds.get(id)!.add(runtimeId);', 'pathToRuntimeIds.get(fontPath)!.add(runtimeId);']) {
    await assert.rejects(() => identityCases(s => {
      assert(s.includes(target)); return s.replace(target, target.replace('.add(runtimeId);', '.clear();') + target)
    }), assert.AssertionError)
  }
  console.log('[diagnostics:local-tag-hydration] real Node aliases/paths, no transitive leakage, duplicates, missing path, empty, 1001 items, input preservation; Rust request/result/fallback boundaries; two mutants rejected (native Rust tests separate)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
