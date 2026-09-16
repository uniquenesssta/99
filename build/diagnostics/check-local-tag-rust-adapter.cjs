#!/usr/bin/env node
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { load } = require('./check-decomposition-baseline.cjs')
const { bodies } = require('./check-preview-storage-routing.cjs')
const base = 'src/main/library/runtime/', facade = base + 'localFontTagsRuntime.ts', adapter = base + 'localFontTagRustAdapterRuntime.ts'
const plain = x => JSON.parse(JSON.stringify(x))
const font = { id: 'a', sourceId: 's', path: ' C:/F/A.ttf ', fileName: 'A.ttf', favorite: true, tagNames: ['shared'], deleteProtected: true, localTagNames: ['old'] }
const methods = ['localTagsByFontIds','hydrateLocalTagsForFonts','setLocalFontTags','setLocalFontTagsBatch','deleteLocalFontTag']
const input = method => method === methods[0] ? [['a','a','']] : method === methods[1] ? [[font]] : method === methods[2] ? [font,[' z ','z','a','']] : method === methods[3] ? [[{ item: font, tagNames: ['discard'] },{ item: font, tagNames: [' z ','a','z'] }]] : [' z ']
const policy = load('src/main/rust-core/nodeStateFallbackCompatibilityRuntime.ts', { './rustFullMigrationPolicyRuntime': load('src/main/rust-core/rustFullMigrationPolicyRuntime.ts') })
function harness({ outcome = 'null', transform = x=>x, result, logThrows = false } = {}) {
  const calls = { node: [], rust: [], events: [], broadcasts: [] }, failure = Error('Rust write failed')
  const identity = load(base + 'localFontTagIdentityRuntime.ts')
  const node = load(base + 'localFontTagNodePersistenceRuntime.ts', { './localFontTagIdentityRuntime': identity })
  const barrier = load('src/main/library/tagMetadataRevisionBarrierRuntime.ts', { './tagQueryFreshnessRuntime': load('src/main/library/tagQueryFreshnessRuntime.ts') }).createTagMetadataRevisionBarrierRuntime({ appendStartupLog() { calls.events.push('revision') } })
  const signal = load('src/main/library/tagMutationStateSignalRuntime.ts', { electron: { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send(channel,payload) { calls.events.push('broadcast'); calls.broadcasts.push(plain(payload)); assert.equal(channel,'font-tags:stateSignal'); assert.equal(payload.localRevision,barrier.snapshot().localRevision) } } }] } } }).createTagMutationStateSignalRuntime({ tagMetadataRevisionBarrier: barrier, clearFontQueryCaches() { calls.events.push('clear') }, appendStartupLog() {} })
  const mocks = {
    './localFontTagIdentityRuntime': identity,
    '../tagMutationProtocolResultRuntime': load('src/main/library/tagMutationProtocolResultRuntime.ts'),
    '../../rust-core/nodeStateFallbackCompatibilityRuntime': policy,
    './localFontTagNodePersistenceRuntime': { ...node, createLocalFontTagNodePersistenceRuntime: () => ({
      localTagsByFontIds: async () => { calls.node.push('read'); return { a: ['node'] } },
      hydrateLocalTagsForFonts: async items => { calls.node.push('hydrate'); return items.map(x=>({...x,localTagNames:['node']})) },
      openWriter: async () => { calls.node.push('open'); return {
        setLocalFontTags() { calls.node.push('single'); calls.events.push('commit'); return { previousKnownTags:['old'],knownTags:['node'],retainedEmptyTags:[] } },
        setLocalFontTagsBatch() { calls.node.push('batch'); calls.events.push('commit'); return { updatedIds:['a'],failed:[],previousKnownTags:['old'],knownTags:['node'],retainedEmptyTags:[] } },
        deleteLocalFontTag() { calls.node.push('delete'); calls.events.push('commit'); return { ok:true,updatedIds:['a'],previousKnownTags:['old'],knownTags:[] } }
      } }
    }) }
  }
  mocks['./localFontTagRustAdapterRuntime'] = load(adapter,mocks,transform)
  function worker(kind) { return async request => { calls.rust.push({kind,request:plain(request)}); if(outcome==='throw') throw failure; if(outcome==='null') return null; calls.events.push('rust-result'); return result || (kind==='read'?{tagMap:{a:['rust']}}:{ updatedIds:['a'],written:1,updated:1,previousKnownTags:['old'],knownTags:['rust'],mutationProtocol:{ok:true,source:'rust-worker'} }) } }
  const runtime = load(facade,mocks).createLocalFontTagsRuntime({ librarySqlitePath:()=>'/test.db',openLibraryDb:async()=>{throw Error('unexpected raw database access')},
    ...(outcome==='missing'?{}:{runRustLocalTagsRead:worker('read'),runRustLocalTagsSet:worker('set'),runRustLocalTagsDeleteTag:worker('delete')}),
    appendStartupLog(message){ if(message.startsWith('local known tag')){calls.events.push('lifecycle');if(logThrows)throw Error('postcommit log')} },
    onLocalTagsMutationStateSignal: signal.handleLocalTagsMutationStateSignal
  })
  return {runtime,calls,failure,signal,barrier}
}
async function withMode(mode, fn) {
  const keys=['HFM_RUST_FULL_MIGRATION','HFM_NODE_STATE_FALLBACK'], old=keys.map(k=>process.env[k])
  process.env[keys[0]]=mode==='legacy'?'0':'1';process.env[keys[1]]=mode==='explicit'?'1':'0'
  try { await fn() } finally { keys.forEach((k,i)=>old[i]===undefined?delete process.env[k]:process.env[k]=old[i]) }
}
async function matrix(transform) {
  for(const mode of ['disabled','explicit','legacy']) await withMode(mode,async()=>{
    for(const outcome of ['missing','null','throw','success']) for(const method of methods) {
      const h=harness({outcome,transform});assert.deepEqual(Object.keys(h.runtime),methods)
      const original=plain(font);const writing=methods.indexOf(method)>=2
      if(outcome==='throw'&&writing) {
        await assert.rejects(()=>h.runtime[method](...input(method)),e=>e===h.failure)
        assert.deepEqual(h.calls.node,[]);assert.deepEqual(h.calls.broadcasts,[]);continue
      }
      const r=await h.runtime[method](...input(method));assert.deepEqual(font,original)
      if(outcome==='success') {
        assert.deepEqual(h.calls.node,[])
        if(writing){assert.equal(r.ok,true);assert.deepEqual(plain(r.updatedIds),['a']);assert.equal(r.mutationProtocol.source,'rust-worker')}
        else assert.deepEqual(plain(method===methods[0]?r:r[0].localTagNames),method===methods[0]?{a:['rust']}:['rust'])
      } else if(mode==='disabled') {
        assert.deepEqual(h.calls.node,[]);assert.deepEqual(h.calls.broadcasts,[])
        if(writing){assert.equal(r.ok,false);assert.equal(r.updatedIds.length,0);assert.equal(r.failed.length,1);assert.match(r.message,/fallback disabled/)}
        else if(method===methods[0])assert.deepEqual(plain(r),{});else assert.equal(r[0],font)
      } else {
        assert(h.calls.node.length>0);if(writing){assert.equal(r.ok,true);assert.equal(h.calls.node.filter(x=>x==='open').length,1);assert.equal(r.mutationProtocol.source,'node-fallback')}
      }
      if(writing&&(outcome==='success'||mode!=='disabled')){
        const e=h.calls.events;assert(e.indexOf('revision')>=0);assert(e.indexOf('revision')<e.indexOf('clear'));assert(e.indexOf('clear')<e.indexOf('broadcast'))
        assert(e.indexOf(outcome==='success'?'rust-result':'commit')<e.indexOf('revision'));assert.equal(h.calls.broadcasts.length,1)
      }
      if(outcome==='success' && [methods[1],methods[2],methods[3]].includes(method)) {
        const row=h.calls.rust[0].request.rows[0];assert.equal(row.itemId,'a');assert.deepEqual(row.aliases,['a','s']);assert.equal(row.fontPath,'c:\\f\\a.ttf')
        if(writing)assert.deepEqual(row.tagNames,['a','z'])
        assert.equal(h.calls.rust[0].request.rows.length,1)
      }
    }
  })
}
async function resultsAndSignals() {
  await withMode('disabled',async()=>{
    for(const method of methods.slice(2)) {
      const h=harness({outcome:'success',logThrows:true});const r=await h.runtime[method](...input(method));assert.equal(r.ok,true);assert.equal(h.calls.broadcasts.length,1)
      const expected=method===methods[2]?'本地标签已更新：A.ttf':method===methods[3]?'本地标签批量更新 1 个。':'已删除本地标签“z”，更新 1 个字体。';assert.equal(r.message,expected)
    }
    for(const method of methods.slice(2)) {
      const h=harness({outcome:'success',result:{updatedIds:[],written:0,updated:0,knownTags:[]}});const r=await h.runtime[method](...input(method))
      assert.deepEqual(plain(r.updatedIds),method===methods[2]?['a']:[]);assert.equal(h.calls.broadcasts.length,method===methods[2]?1:0)
      if(method===methods[4])assert.equal(r.message,'已删除本地标签“z”。')
    }
    const h=harness({outcome:'success'});assert.equal((await h.runtime.setLocalFontTagsBatch([])).ok,true);assert.equal((await h.runtime.deleteLocalFontTag(' ')).ok,false)
    assert.deepEqual(plain(await h.runtime.localTagsByFontIds([])),{});const empty=[];assert.equal(await h.runtime.hydrateLocalTagsForFonts(empty),empty);assert.equal(h.calls.rust.length,0);assert.equal(h.calls.node.length,0)
    const s={mutationKind:'deleteTag',updatedAt:'fixed',changedIds:[],knownTags:[],localTagsChanged:true,cacheInvalidated:true,pageQueryDirty:true,metricsDirty:true}
    h.signal.handleLocalTagsMutationStateSignal(s);assert.equal(h.barrier.snapshot().localRevision,1);assert.deepEqual(h.calls.broadcasts[0].knownTags,[])
    h.signal.handleLocalTagsMutationStateSignal(s);assert.equal(h.calls.broadcasts.length,1)
    h.signal.handleLocalTagsMutationStateSignal({...s,updatedAt:'noop',localTagsChanged:false,cacheInvalidated:false,pageQueryDirty:false,metricsDirty:false});assert.equal(h.barrier.snapshot().localRevision,1)
  })
}
function structure() {
  const root=path.join(__dirname,'../..'),fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/local-tag-rust-adapter.fixture.json')))
  for(const [f,entries] of Object.entries(fixture.files)){
    const text=fs.readFileSync(path.join(root,f),'utf8');for(const source of [text,text.replace(/\r?\n/g,'\r\n')]){const actual=bodies(source);for(const [name,hash]of Object.entries(entries))assert.equal(actual[name],hash,name)}
  }
  assert(!fs.readFileSync(path.join(root,adapter),'utf8').includes('openLibraryDb'),'adapter cannot write Node')
}
async function main(){
  structure();await matrix();await resultsAndSignals()
  for(const mutate of [s=>s.replaceAll('throw error;','return null;'),s=>s.replace('if (!nodeStateFallbackCompatibilityAllowed())','if (false)'),s=>s.replace('if (!nodeStateFallbackCompatibilityAllowed())','if (true)')])await assert.rejects(()=>matrix(mutate),assert.AssertionError)
  console.log('[diagnostics:local-tag-rust-adapter] five contracts; success/null/missing/error x 3 policies; row identity; real revision/cache/broadcast order, dedupe/no-op/catalog; 9 moved bodies and 3 mutants passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
