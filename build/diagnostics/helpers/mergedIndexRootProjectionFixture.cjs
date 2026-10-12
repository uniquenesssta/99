'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('../check-operation-chain.cjs')
const root = path.resolve(__dirname, '../../..')
const tick = () => new Promise(resolve => setImmediate(resolve))
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }

function fixture({ native = false } = {}) {
  const a = path.join(root, '.diagnostic-virtual', 'healthy'), b = path.join(root, '.diagnostic-virtual', 'offline')
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE sources(root_path TEXT PRIMARY KEY,index_db_path TEXT,install_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT,synced_at TEXT);
    CREATE TABLE entries(root_path TEXT,relative_path TEXT,cache_key TEXT,file_size INTEGER,modified_at REAL,created_at REAL,status TEXT,font_json TEXT,message TEXT,cached_at TEXT,is_deleted INTEGER,installed INTEGER,installed_by TEXT,matches_json TEXT,category_index TEXT,search_text TEXT,PRIMARY KEY(root_path,relative_path));`)
  const adapter = { prepare: sql => db.prepare(sql), transaction: fn => () => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error } } }
  const states = new Map([a,b].map(root => [root, { rootId: root, state: 'online', generation: 1 }]))
  const probes = [], admissions = [], resolves = [], commits = [], logs = [], reads = []
  let readGate, beforeQueue, afterNative, nativeFailure, configured = [a,b], nativeCalls = 0
  const ports = {
    [path.join(root,'src/main/path/startupPathAvailabilityRuntime.ts')]: {
      assertStartupPathRootGuardCurrent() {},
      getStartupPathRootState: root => Object.freeze({...states.get(root)}),
      ensureStartupPathRootAvailable: async (root,_log,_reason,options) => { probes.push(root); admissions.push({root,background:options?.background===true}); return states.get(root).state === 'online' },
    },
    [path.join(root,'src/main/app/shutdownCoordinatorRuntime.ts')]: { applicationWorkEpoch: () => 1, assertApplicationOpen() {} },
    [path.join(root,'src/main/path/sharedIoProcessRuntime.ts')]: { rethrowSharedIoProcessError: error => { if (error?.sharedIo) throw error } },
    [path.join(root,'src/main/rust-core/rustCoreDaemonWriteBoundaryRuntime.ts')]: { rethrowRustCoreDaemonSubmittedWrite: error => { if (error?.daemonSubmitted) throw error } },
  }
  let clock = 1000
  class ControlledClock extends Date { static now() { return clock } }
  const load = loader(ports, {Date:ControlledClock})
  const normalize = value => value.toLowerCase().replaceAll('\\','/')
  const key = sources => JSON.stringify(sources.map(s => ({ ...s, root: normalize(s.root), indexDbPath: normalize(s.indexDbPath), installDbPath: s.installDbPath ? normalize(s.installDbPath) : '' })).sort((a,b) => a.root.localeCompare(b.root)))
  const fresh = new Map([a,b].map(root => [root,{root,indexDbPath:path.join(root,'index.sqlite'),installDbPath:undefined,indexSignature:'root-v3|1',installSignature:'none',sharedMetadataSignature:'metadata-v2|1'}]))
  const setMeta = (_,key,value) => db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,value)
  const getMeta = (_,key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value || ''
  function writeSource(_,s,now) { db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?)').run(s.root,s.indexDbPath,s.installDbPath || null,s.indexSignature,s.installSignature,s.sharedMetadataSignature,now) }
  function row(root, label) { return {root_path:root,relative_path:'a.ttf',cache_key:'a.ttf',file_size:5,modified_at:1,created_at:null,status:'ok',font_json:JSON.stringify({family:label}),message:null,cached_at:'now',is_deleted:0,installed:null,installed_by:null,matches_json:null,category_index:'sansSerif',search_text:label} }
  const insert = db.prepare('INSERT OR REPLACE INTO entries VALUES(@root_path,@relative_path,@cache_key,@file_size,@modified_at,@created_at,@status,@font_json,@message,@cached_at,@is_deleted,@installed,@installed_by,@matches_json,@category_index,@search_text)')
  for (const source of fresh.values()) { writeSource(null,source,'old'); insert.run(row(source.root,'old')) }
  setMeta(null,'schemaVersion','7'); setMeta(null,'sourcesKey',key([...fresh.values()]))
  const queue = load('src/main/indexing/merged-page/mergedIndexMutationCoordinatorRuntime.ts').createMergedIndexMutationCoordinatorRuntime({appendStartupLog: line => logs.push(line),onCommitted: receipt => commits.push(receipt)})
  const ctx = {
    schemaVersion:7, appendStartupLog: line => logs.push(line), appWatchedFolders:async()=>configured,
    normalizePathForCacheCompare:normalize, mergedIndexSourcesKey:key, mergedIndexRootsKey: roots => JSON.stringify([...new Set(roots.map(normalize))].sort()),
    sqliteTableExists:(_,table)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
    openMergedIndexDb:async()=>adapter, closeSqliteDb(){},getSqliteMeta:getMeta,setSqliteMeta:setMeta,
    mergedIndexSourcesMatchRoots:(_,roots)=>ctx.mergedIndexRootsKey(db.prepare('SELECT root_path FROM sources').all().map(row=>row.root_path))===ctx.mergedIndexRootsKey(roots),
    mergedIndexInsertStatement:()=>insert, bindMergedIndexRow:row=>row,writeMergedIndexSourceRow:writeSource,
    mergedIndexReadyProcessKeys:new Set(),mergedIndexDbPath:()=>'/local/merged.sqlite',delayToEventLoop:async()=>{},
    runMergedIndexMutation:async(label,fn)=>{if(beforeQueue)await beforeQueue(label);return queue.runMergedIndexMutation(label,fn)},
    rustCoreWorkerRuntime:{runRustMergedIndexSync:async input=>{
      if(!native)return null
      nativeCalls++;input.assertCurrent();if(nativeFailure)throw nativeFailure
      assert(Array.isArray(input.preparedRows),'native writer was asked to reopen remote sources')
      assert.equal(getMeta(null,'sourcesKey'),input.expectedSourcesKey)
      adapter.transaction(()=>{if(input.fullSnapshot)db.prepare('DELETE FROM entries WHERE root_path=?').run(input.source.root);else for(const relative of input.relativePaths)db.prepare('DELETE FROM entries WHERE root_path=? AND relative_path=?').run(input.source.root,relative);for(const row of input.preparedRows)insert.run(row);if(!input.preserveSourceCheckpoint)writeSource(null,input.source,input.syncedAt);setMeta(null,'sourcesKey',input.sourcesKey)})()
      afterNative?.();return {synced:true,rows:input.preparedRows.length}
    }},
  }
  const source = {
    mergedIndexSourcesForRoots:async roots=>{resolves.push([...roots]);return roots.map(root=>{if(states.get(root).state!=='online')throw Error('offline');return {...fresh.get(root)}})},
    relativePathsFromFontIndexPayload:()=>['a.ttf'],
    readMergedRowsForSource:async source=>{reads.push(source.root);if(readGate?.root===source.root)await readGate.promise;return [row(source.root,'fresh')]},
  }
  const build = { rebuildMergedIndexDb:async(_,sources,sourcesKey)=>{assert.equal(sources.length,configured.length);db.exec('DELETE FROM entries;DELETE FROM sources');for(const source of sources){writeSource(null,source,'repair');insert.run(row(source.root,'fresh'))}setMeta(null,'sourcesKey',sourcesKey)}, ensureMergedIndexBuilt:async()=>{throw Error('unexpected all-root ensure')} }
  const sync = load('src/main/indexing/merged-page/mergedIndexSyncRuntime.ts').createMergedIndexSyncRuntime(ctx,source,build)
  const poll = reason => load('src/main/indexing/merged-page/mergedIndexSharedMetadataExternalCheckRuntime.ts').checkMergedIndexSharedMetadataExternalChanges({ctx,sourceRuntime:source,buildRuntime:build,reason:reason || 'shared-metadata-poll'})
  return {a,b,db,adapter,ctx,source,build,load,states,probes,admissions,resolves,commits,logs,reads,fresh,sync,poll,key,writeSource,setMeta,
    count:root=>db.prepare('SELECT COUNT(*) AS n FROM entries WHERE root_path=?').get(root).n,
    advanceTime:ms=>{clock+=ms},setRoots:roots=>{configured=roots},setReadGate:value=>{readGate=value},setBeforeQueue:value=>{beforeQueue=value},setNativeFailure:error=>{nativeFailure=error},setAfterNative:fn=>{afterNative=fn},nativeCalls:()=>nativeCalls,
  }
}

async function runMergedRootProjectionCases() {
  for(const native of [false,true]) {
    const f=fixture({native})
    try {
      f.states.get(f.b).state='offline'
      f.fresh.get(f.a).sharedMetadataSignature='metadata-v2|2'
      const peer=JSON.stringify(f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.b))
      await f.sync.syncMergedIndexForRootIncremental(f.a,{upserts:[],deletes:[]},'shared-tags-set')
      assert(f.resolves.every(roots=>roots.length===1&&roots[0]===f.a),'healthy root resolved/probed an unrelated offline root')
      assert(f.probes.every(root=>root===f.a));assert.equal(f.count(f.b),1)
      assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.b)),peer,'offline peer checkpoint was changed')
      assert.equal(f.ctx.mergedIndexReadyProcessKeys.size,0,'root receipt became global freshness')
      assert.equal(f.commits.length,1);assert.equal(f.nativeCalls(),Number(native))
      // Same count but different peer revision must remain stale until its own projection.
      f.states.get(f.b).state='online';f.fresh.get(f.b).indexSignature='root-v3|2'
      const result=await f.poll();assert.equal(result.syncedRoots,2);assert.equal(result.status,'complete')
      assert.equal(f.db.prepare('SELECT index_signature FROM sources WHERE root_path=?').get(f.b).index_signature,'root-v3|2')
    } finally {f.db.close()}
  }
  for(const native of [false,true]) {
    const f=fixture({native})
    try {
      const prior=f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.a)
      const a={...f.db.prepare('SELECT * FROM entries WHERE root_path=?').get(f.a),font_json:'{"family":"A-current"}'}
      const b={...a,relative_path:'b.ttf',cache_key:'b.ttf',font_json:'{"family":"B-current"}'}
      f.ctx.mergedIndexInsertStatement().run({...b,font_json:'{"family":"B-old"}'})
      // Two source writes are already committed; only A reaches its projection
      // before a simulated restart interrupts B's separate projection request.
      f.fresh.get(f.a).sharedMetadataSignature='metadata-v2|both-A-and-B'
      f.source.readMergedRowsForSource=async(source,paths)=>source.root===f.a?(paths?[a]:[a,b]):[a].map(row=>({...row,root_path:source.root}))
      await f.sync.syncMergedIndexForRootIncremental(f.a,{upserts:[],deletes:[]},'shared-tags-set')
      assert.equal(f.count(f.a),2);assert.equal(f.db.prepare('SELECT font_json FROM entries WHERE root_path=? AND relative_path=?').get(f.a,'b.ttf').font_json,'{"family":"B-old"}','partial A replaced unrelated B row');assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.a)),JSON.stringify(prior),'partial A payload certified unprojected B revision')
      const restartedCtx={...f.ctx,mergedIndexReadyProcessKeys:new Set()}
      const result=await f.load('src/main/indexing/merged-page/mergedIndexSharedMetadataExternalCheckRuntime.ts').checkMergedIndexSharedMetadataExternalChanges({ctx:restartedCtx,sourceRuntime:f.source,buildRuntime:f.build,reason:'shared-metadata-poll'})
      assert.equal(result.syncedRoots,1);assert.equal(f.count(f.a),2,'restart lost B because partial A marked root current');assert.equal(f.db.prepare('SELECT font_json FROM entries WHERE root_path=? AND relative_path=?').get(f.a,'b.ttf').font_json,'{"family":"B-current"}','restart did not repair unprojected B')
      assert.equal(f.db.prepare('SELECT shared_metadata_signature FROM sources WHERE root_path=?').get(f.a).shared_metadata_signature,'metadata-v2|both-A-and-B')
      assert.equal(restartedCtx.mergedIndexReadyProcessKeys.size,0)
    } finally {f.db.close()}
  }
  {
    const f=fixture();const blocked=gate();f.setReadGate({root:f.b,...blocked})
    try {
      let bDone=false;const background=f.sync.syncMergedIndexForRootSnapshot(f.b,'shared-metadata-poll').then(()=>{bDone=true})
      await tick();await f.sync.syncMergedIndexForRootSnapshot(f.a,'shared-metadata-foreground')
      assert.equal(bDone,false,'offline preparation unexpectedly finished');assert.equal(f.commits.length,1,'remote preparation occupied the global commit lane')
      blocked.release();await background
    } finally {f.db.close()}
  }
  {
    const f=fixture();const blocked=gate();f.setReadGate({root:f.b,...blocked});f.fresh.get(f.b).indexSignature='root-v3|automatic-next'
    try {
      Object.assign(f.ctx,{staleFirstPageEnabled:true,backgroundValidateIntervalMs:0,mergedIndexValidateInFlight:new Map(),mergedIndexLastValidateAt:new Map(),mergedIndexLocalSnapshotUsable:()=>true})
      const validation=f.load('src/main/indexing/merged-page/mergedIndexValidationRuntime.ts').createMergedIndexValidationRuntime(f.ctx,f.source,f.build)
      validation.scheduleMergedIndexBackgroundValidation([f.a,f.b],'worker-ready-validation')
      const pending=f.ctx.mergedIndexValidateInFlight.get(f.ctx.mergedIndexRootsKey([f.a,f.b]));assert(pending)
      await tick();await f.sync.syncMergedIndexForRootSnapshot(f.a,'shared-tags-set')
      assert.equal(f.commits.length,1,'routine background validation held the global write lane across peer I/O')
      assert.equal(f.db.prepare('SELECT index_signature FROM sources WHERE root_path=?').get(f.b).index_signature,'root-v3|1')
      blocked.release();await pending
      assert.equal(f.db.prepare('SELECT index_signature FROM sources WHERE root_path=?').get(f.b).index_signature,'root-v3|automatic-next','automatic checkpoint refresh was dropped')
      assert.equal(f.ctx.mergedIndexReadyProcessKeys.size,0,'automatic partial validation claimed global freshness')
    } finally {f.db.close()}
  }
  for(const change of ['generation','target','roots']) {
    const f=fixture()
    try {
      f.setBeforeQueue(async()=>{
        if(change==='generation')f.states.get(f.a).generation++
        if(change==='roots')f.setRoots([f.b])
        if(change==='target'){const newer={...f.fresh.get(f.a),sharedMetadataSignature:'metadata-v2|newer'};f.writeSource(null,newer,'newer');f.setMeta(null,'sourcesKey',f.key([newer,f.fresh.get(f.b)]))}
      })
      const expected={generation:/generation-changed/,roots:/roots-changed/,target:/target-changed-in-queue/}[change]
      await assert.rejects(()=>f.sync.syncMergedIndexForRootSnapshot(f.a,'shared-metadata-poll'),expected, `queued ${change} change must reject before projection`)
      assert.equal(f.commits.length,0);assert.equal(f.db.prepare('SELECT font_json FROM entries WHERE root_path=?').get(f.a).font_json,'{"family":"old"}')
    } finally {f.db.close()}
  }
  {
    const f=fixture()
    try {
      f.setBeforeQueue(async()=>{const peer={...f.fresh.get(f.b),sharedMetadataSignature:'metadata-v2|peer-new'};f.writeSource(null,peer,'newer');f.setMeta(null,'sourcesKey',f.key([f.fresh.get(f.a),peer]));f.setBeforeQueue(null)})
      await f.sync.syncMergedIndexForRootSnapshot(f.a,'shared-metadata-foreground')
      assert.equal(f.db.prepare('SELECT shared_metadata_signature FROM sources WHERE root_path=?').get(f.b).shared_metadata_signature,'metadata-v2|peer-new','peer commit between prepare and apply was overwritten')
    } finally {f.db.close()}
  }
  {
    const f=fixture({native:true})
    try {
      f.setNativeFailure(Object.assign(Error('submitted outcome unknown'),{daemonSubmitted:true}))
      await assert.rejects(()=>f.sync.syncMergedIndexForRootSnapshot(f.a,'shared-metadata-poll'),/submitted outcome unknown/)
      assert.equal(f.commits.length,0);assert.equal(f.db.prepare('SELECT font_json FROM entries WHERE root_path=?').get(f.a).font_json,'{"family":"old"}')
    } finally {f.db.close()}
  }
  {
    const f=fixture()
    try {
      f.states.get(f.b).state='offline';f.fresh.get(f.a).indexSignature='root-v3|crash-checkpoint'
      let result=await f.poll();assert(f.admissions.every(entry=>entry.background),'periodic metadata check reset foreground availability TTL');assert.equal(result.status,'partial');assert.equal(result.syncedRoots,1);assert.equal(result.deferredRoots,1)
      const attempts=f.probes.filter(root=>root===f.b).length;result=await f.poll()
      assert.equal(f.probes.filter(root=>root===f.b).length,attempts,'periodic retry ignored per-root backoff');assert.equal(result.deferredRoots,1)
      f.states.get(f.b).state='online';f.states.get(f.b).generation++;f.fresh.get(f.b).sharedMetadataSignature='metadata-v2|recovered'
      result=await f.poll();assert.equal(result.syncedRoots,1,'online generation did not release backoff')
      f.setRoots([f.a]);result=await f.poll();assert.equal(result.reconciliationRequired,true);assert.equal(f.count(f.b),1,'ordinary poll silently removed retained peer')
      result=await f.poll('shared-metadata-manual-reconcile');assert.equal(result.rebuilt,true);assert.equal(f.count(f.b),0)
      f.setRoots([f.a,f.b]);result=await f.poll();assert.equal(result.syncedRoots,1);assert.equal(f.count(f.b),1,'re-added root was not restored')
      // Explicit repair cannot skip an identical-signature but damaged projection.
      f.db.prepare('DELETE FROM entries WHERE root_path=?').run(f.a);result=await f.poll('shared-metadata-manual-repair');assert.equal(f.count(f.a),1);assert.equal(result.rebuilt,true)
      f.setMeta(null,'sourcesKey','broken');result=await f.poll();assert.equal(result.status,'partial');assert.equal(result.reconciliationRequired,true)
      await assert.rejects(()=>f.sync.syncMergedIndexForRootSnapshot(f.a,'shared-metadata-poll'),/receipt-mismatch/)
      result=await f.poll('shared-metadata-manual-repair');assert.equal(result.rebuilt,true)
      f.setMeta(null,'schemaVersion','999');result=await f.poll();assert.equal(result.status,'partial');assert.equal(result.changed,false)
      assert(f.logs.filter(line=>line.startsWith('merged metadata poll')||line.startsWith('merged root projection')).every(line=>!line.includes(f.a)&&!line.includes(f.b)),'bounded evidence leaked raw paths')
    } finally {f.db.close()}
  }
  {
    const f=fixture()
    try {
      f.states.get(f.b).state='offline'
      for(let attempt=0;attempt<9;attempt++){await f.poll();f.advanceTime(15*60_000)}
      const delays=f.logs.filter(line=>line.includes('retryMs=')).map(line=>Number(line.match(/retryMs=(\d+)/)[1]))
      assert.deepEqual(delays.slice(0,5),[90_000,180_000,360_000,720_000,900_000]);assert(delays.every(delay=>delay<=900_000),'offline backoff is not bounded')
    } finally {f.db.close()}
  }
  for(const native of [false,true]) {
    const f=fixture({native})
    try {
      f.setBeforeQueue(async()=>{f.fresh.get(f.a).sharedMetadataSignature='metadata-v2|later-source'})
      await assert.rejects(()=>f.sync.syncMergedIndexForRootSnapshot(f.a,'shared-metadata-foreground'),error=>error.mergedProjectionCommitted&&/source-changed-after-commit/.test(error.message))
      assert.equal(f.commits.length,1,'real commit was not invalidated before rejecting stale ACK')
    } finally {f.db.close()}
  }
  {
    const f=fixture({native:true})
    try {
      f.setAfterNative(()=>{f.states.get(f.a).generation++})
      await assert.rejects(()=>f.sync.syncMergedIndexForRootSnapshot(f.a,'shared-metadata-foreground'),error=>error.mergedProjectionCommitted&&/generation-changed/.test(error.message))
      assert.equal(f.commits.length,1,'native commit followed by lost availability skipped invalidation')
      assert.equal(f.nativeCalls(),1,'committed write replayed after rejected ACK')
    } finally {f.db.close()}
  }
  {
    const f=fixture();const closed=gate();let settled=false
    try {
      const original=f.source.mergedIndexSourcesForRoots
      f.source.mergedIndexSourcesForRoots=async roots=>{if(roots[0]===f.a)throw Object.assign(Error('child timeout'),{sharedIo:true,reason:'execution-timeout',closed:closed.promise});return original(roots)}
      const pending=f.poll().then(result=>{settled=true;return result});await tick();assert.equal(settled,false,'partial result retired before failed child close')
      closed.release();const result=await pending;assert.equal(result.failedRoots,1);assert.equal(result.blockers['execution-timeout'],1)
    } finally {f.db.close()}
  }
  {
    const f=fixture()
    try {
      f.source.readMergedRowsForSource=async()=>[]
      await f.sync.syncMergedIndexForRootSnapshot(f.a,'shared-metadata-foreground')
      assert.equal(f.count(f.a),0,'authoritative empty index could not commit');assert.equal(f.count(f.b),1)
      f.setRoots([]);const empty=await f.poll();assert.equal(empty.status,'complete');assert.equal(empty.roots,0)
    } finally {f.db.close()}
  }
  {
    const f=fixture()
    try {
      const runtime=f.load('src/main/indexing/mergedIndexRuntime.ts').createMergedIndexRuntime({...f.ctx,dataPath:(...parts)=>path.join(root,'.diagnostic-virtual',...parts),exists:async()=>true,openStableSqliteDb:()=>f.adapter,staleFirstPageEnabled:true})
      f.setMeta(null,'installEvidenceVersion','content-v1')
      assert.equal(runtime.mergedIndexLocalSnapshotUsable(f.adapter,[f.a,f.b]),true)
      // Switch to the production key/binder for the pending initialization check.
      const persisted=[...f.fresh.values()];f.setMeta(null,'sourcesKey',runtime.mergedIndexSourcesKey(persisted))
      const c=path.join(root,'.diagnostic-virtual','new-unavailable')
      const peer=JSON.stringify(f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.b))
      runtime.ensureMergedIndexPendingSnapshotForRoots(f.adapter,[f.a,f.b,c])
      assert.equal(f.count(f.a),1);assert.equal(f.count(f.b),1);assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.b)),peer)
      assert.equal(f.db.prepare('SELECT index_signature FROM sources WHERE root_path=?').get(c).index_signature,'pending-snapshot')
      assert.equal(runtime.mergedIndexLocalSnapshotUsable(f.adapter,[f.a]),false,'removed retained root became visible as a usable current-root snapshot')
      const ctx={...f.ctx,mergedIndexLocalSnapshotUsable:runtime.mergedIndexLocalSnapshotUsable,staleFirstPageEnabled:true}
      const query=f.load('src/main/indexing/merged-page/mergedIndexPageQueryRuntime.ts').createMergedIndexPageQueryRuntime(ctx,f.source,f.build,()=>{})
      assert.equal(await query.openReadyMergedIndexForRoots([f.a],{allowLocalSnapshot:true,allowBlockingBuild:false}),null,'normal deferred query exposed a removed root')
      assert.equal(f.count(f.b),1,'deferred query destroyed recoverable peer rows')
    } finally {f.db.close()}
  }
  {
    const f=fixture();const blocked=gate();f.setReadGate({root:f.a,...blocked});f.fresh.get(f.a).indexSignature='root-v3|next'
    try {
      const validation=f.load('src/main/indexing/merged-page/mergedIndexValidationRuntime.ts').createMergedIndexValidationRuntime(f.ctx,f.source,f.build)
      const periodic=validation.checkMergedIndexExternalChanges('shared-metadata-poll');await tick()
      const manual=validation.checkMergedIndexExternalChanges('shared-metadata-manual-reconcile');blocked.release();await periodic
      const result=await manual;assert.equal(result.rebuilt,true,'manual repair merely joined periodic partial work')
    } finally {f.db.close()}
  }
  {
    const permission=Object.assign(Error('metadata denied'),{code:'EACCES'})
    const load=loader({
      [path.join(root,'src/main/path/sharedFileSystemRuntime.ts')]:{sharedFileSystem:{stat:async()=>{throw permission}}},
      [path.join(root,'src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{sharedIoResourceKeys:async()=>[]},
      [path.join(root,'src/main/rust-core/nodeStateFallbackCompatibilityRuntime.ts')]:{nodeStateFallbackCompatibilityAllowed:()=>true},
    })
    const overlay=load('src/main/indexing/shared-metadata/sharedMetadataOverlayRuntime.ts').createSharedMetadataOverlayRuntime({exists:async()=>false})
    await assert.rejects(()=>overlay.applySharedMetadataToMergedRows('/local',[{relative_path:'a.ttf'}],true),error=>error===permission)
    const signatures=load('src/main/indexing/shared-metadata/sharedMetadataSignatureRuntime.ts').createSharedMetadataSignatureRuntime({runtimeDeps:{exists:async()=>false}})
    await assert.rejects(()=>signatures.sharedMetadataSignatureForRoot('/local'),error=>error===permission)
  }

}
module.exports={runMergedRootProjectionCases}

// Opt-in Windows integration through the actual indexing client and worker.
// The caller supplies the just-built binary; this fixture never builds or installs it.
async function runNativeMergedProjectionCases(workerPath) {
  assert.equal(process.platform,'win32','native merged projection acceptance is Windows-only')
  const fs=require('node:fs'),os=require('node:os'),{execFile}=require('node:child_process'),{promisify}=require('node:util')
  const run=promisify(execFile),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-merged-prepared-'))
  let db,allocated=0,commands=0
  try {
    const handshake=JSON.parse((await run(workerPath,['--handshake'],{windowsHide:true})).stdout.trim())
    assert(handshake.capabilities.includes('merged-index-prepared-sync-v1'),'selected worker lacks the reviewed prepared-row protocol')
    const dbPath=path.join(dir,'merged.sqlite');db=new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE sources(root_path TEXT PRIMARY KEY,index_db_path TEXT,install_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT,synced_at TEXT);
      CREATE TABLE entries(root_path TEXT,relative_path TEXT,cache_key TEXT,file_size INTEGER,modified_at REAL,created_at REAL,status TEXT,font_json TEXT,message TEXT,cached_at TEXT,is_deleted INTEGER,installed INTEGER,installed_by TEXT,matches_json TEXT,category_index TEXT,search_text TEXT,PRIMARY KEY(root_path,relative_path));
      INSERT INTO meta VALUES('schemaVersion','7'),('sourcesKey','before');
      INSERT INTO sources VALUES('peer','offline',NULL,'old-index','old-install','old-metadata','old-time');`)
    const make=loader()('src/main/rust-core/clients/rustIndexingClientRuntime.ts').createRustIndexingClientRuntime
    const ports={appendStartupLog(){},diagnoseRustCoreWorker:async()=>({available:true,path:workerPath,capabilities:handshake.capabilities}),
      createTemporaryJsonFile:()=>{const file=path.join(dir,`input-${++allocated}.json`);return{path:file,writeJson:async value=>fs.writeFileSync(file,JSON.stringify(value)),dispose:async()=>fs.rmSync(file,{force:true})}},
      runRustCoreScheduledCommand:async(worker,args,options)=>{commands++;options.assertCurrent?.();return run(worker,args,{windowsHide:true,maxBuffer:1024*1024})}}
    const client=make(ports),owner='Z:/healthy'
    const production=loader()('src/main/indexing/mergedIndexRuntime.ts').createMergedIndexRuntime({dataPath:(...parts)=>path.join(dir,...parts)})
    const normalizeRows=loader()('src/main/indexing/merged-page/mergedIndexSyncRuntime.ts').normalizeMergedSyncRows
    const row={root_path:owner,relative_path:'a.ttf',cache_key:'a.ttf',file_size:1,modified_at:1,created_at:null,status:'ok',font_json:'{}',message:null,cached_at:'now',installed:null,installed_by:null,matches_json:null,category_index:'sansSerif',search_text:'a'}
    const input={mergedIndexDbPath:dbPath,schemaVersion:7,sourcesKey:'after',expectedSourcesKey:'before',syncedAt:'now',source:{root:owner,indexDbPath:'\\\\offline\\must-not-open\\index.sqlite',indexSignature:'root-v3|1',installSignature:'none',sharedMetadataSignature:'metadata:none'},preparedRows:normalizeRows({normalizePathForCacheCompare:value=>value.toLowerCase(),bindMergedIndexRow:production.bindMergedIndexRow},[row],owner,'now'),fullSnapshot:true}
    assert.equal((await client.runRustMergedIndexSync(input)).synced,true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get().n,1)
    assert.equal(db.prepare("SELECT synced_at FROM sources WHERE root_path='peer'").get().synced_at,'old-time')
    await assert.rejects(()=>client.runRustMergedIndexSync({...input,preparedRows:[]}),error=>error.daemonSubmitted===true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get().n,1,'native compare guard deleted target on stale input')
    const appliedSource=JSON.stringify(db.prepare('SELECT * FROM sources WHERE root_path=?').get(owner))
    const incremental={...input,expectedSourcesKey:'after',sourcesKey:'after',fullSnapshot:false,preserveSourceCheckpoint:true,relativePaths:['a.ttf'],preparedRows:[{...row,font_json:'{"family":"next"}'}]}
    assert.equal((await client.runRustMergedIndexSync(incremental)).synced,true)
    assert.equal(db.prepare('SELECT font_json FROM entries').get().font_json,'{"family":"next"}')
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM sources WHERE root_path=?').get(owner)),appliedSource,'real worker advanced a partial root certificate')
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='sourcesKey'").get().value,'after')
    for(const invalid of [{...incremental,preserveSourceCheckpoint:false},{...incremental,fullSnapshot:true},{...incremental,sourcesKey:'unproved-next'}]) {
      await assert.rejects(()=>client.runRustMergedIndexSync(invalid),error=>error.daemonSubmitted===true)
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM sources WHERE root_path=?').get(owner)),appliedSource)
      assert.equal(db.prepare("SELECT value FROM meta WHERE key='sourcesKey'").get().value,'after')
      assert.equal(db.prepare('SELECT font_json FROM entries').get().font_json,'{"family":"next"}')
    }
    for(const bad of [{...row,root_path:'peer'},{...row,relative_path:'../outside.ttf'},{...row,file_size:'not-a-number'}]) {
      await assert.rejects(()=>client.runRustMergedIndexSync({...input,expectedSourcesKey:'after',preparedRows:[bad]}),error=>error.daemonSubmitted===true)
      assert.equal(db.prepare('SELECT font_json FROM entries').get().font_json,'{"family":"next"}')
    }
    const before=commands,old=make({...ports,diagnoseRustCoreWorker:async()=>({available:true,path:workerPath,capabilities:['merged-index-sync']})})
    assert.equal(await old.runRustMergedIndexSync(input),null);assert.equal(commands,before,'old worker silently accepted guarded prepared rows')
  } finally {db?.close();fs.rmSync(dir,{recursive:true,force:true})}
}
module.exports.runNativeMergedProjectionCases=runNativeMergedProjectionCases
