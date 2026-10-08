#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const indexFile = 'src/main/watcher/watchedFolderIndexRuntime.ts'
const plain = x => JSON.parse(JSON.stringify(x))
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const drain = async () => { for (let i=0;i<30;i++) await Promise.resolve() }
function load(file, mocks = {}, globals = {}, transform = s => s) {
  const exports = {}
  const code = ts.transpileModule(transform(read(file)), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  vm.runInNewContext(code, { exports, console, process, performance, ...globals, require(id) {
    if (Object.hasOwn(mocks,id)) return mocks[id]
    if (id.endsWith('/sharedFileSystemRuntime')) return { sharedFileSystem: (mocks['node:fs'] || fs).promises }
    if (id.endsWith('/rustSharedIoCommandRuntime')) return { sharedIoResourceKeys: async () => [] }
    if (id==='node:path') return path
    if (['node:async_hooks', 'node:perf_hooks', 'node:crypto'].includes(id)) return require(id)
    if (id.startsWith('.')) return load(path.relative(root,path.resolve(root,path.dirname(file),id+'.ts')),mocks,globals)
    throw Error(`Unmocked dependency ${file} -> ${id}`)
  } }, { filename:file })
  return exports
}
const fail = code => Object.assign(Error(code), { code })
async function indexCase(mode, transform = s => s, replayUnchanged = false) {
  const folder = path.resolve('/fonts'), file = path.join(folder,'a.ttf')
  const existing = { status:'ok', font:{ id:'a',path:file,favorite:true },cacheKey:'old' }
  const cache = { entries: mode==='no-cache-missing'?{}:{ 'a.ttf':existing } }, writes = [], directoryWrites = []
  const context = { cache, directoryUpdates:[] }
  const freshStat = { size: 10, mtimeMs: 20, birthtimeMs: 10 }
  const stat = async p => {
    if (p===folder) { if(mode==='offline') throw fail('ENOENT'); return { isDirectory:()=>true, isFile:()=>false,mtimeMs:2 } }
    if(['ENOENT','ENOTDIR','EACCES','ETIMEDOUT','offline','no-cache-missing','save-throw'].includes(mode)) throw fail(['offline','no-cache-missing','save-throw'].includes(mode)?'ENOENT':mode)
    return { isDirectory:()=>false,isFile:()=>true }
  }
  const runtime = load(indexFile, {
    'node:fs':{promises:{stat,readdir:async()=>[]}},
    '../cache/cachePaths':{fileCacheSignature:()=>'',isIgnoredInternalDirectoryName:()=>false,isRootIndexDbPath:()=>true}
  },{},transform).createWatchedFolderIndexRuntime({
    isIgnoredWatcherPath:()=>false, fontExtensions:new Set(['.ttf']), withGlobalIo:(_label,fn)=>fn(),
    ensureRootScanCacheStorage:async()=>({cachePath:'/index.db',storage:'root'}),makeRootScanCacheContext:()=>context,
    readRootDirectorySignatures:async()=>new Map(),relativeDirectoryPathForRoot:()=>'',
    cacheKeyForRootFile:()=> 'a.ttf',cacheKeyInsideDirectory:()=>true,
    listFontFilesWithDirectoryCache:async (_ctx,errors)=>{ context.directoryUpdates.push({relativePath:''}); if(mode==='partial-list')errors.push({path:folder,message:'EACCES'});return mode.startsWith('unchanged') && mode.includes('list') ? [{file, stat:freshStat, freshStat:mode==='unchanged-fresh-list'}] : [] },
    upsertFontIndexEntry:async(_root,_file,workingCache,receivedStat)=>{ assert.equal(receivedStat,mode==='unchanged-fresh-list'?freshStat:undefined,'only fresh directory attributes may bypass stat'); if(mode==='parse-ENOENT')throw fail('ENOENT'); if(mode==='parse')throw Error('metadata'); if(!mode.startsWith('unchanged'))workingCache.entries['a.ttf']={...existing,cacheKey:'new'};return existing.font },
    fontIndexEntryChanged:(a,b)=>a!==b,fontIndexDeleteRecord:(_root,key)=>({path:file,relativePath:key,id:'a'}),
    removeFontIndexEntriesForPath:()=>mode==='no-cache-missing'?[]:[{path:file,relativePath:'a.ttf',id:'a'}],
    saveRootIndexSqliteChanges:async(_db,_root,_storage,changed,deleted)=>{writes.push(plain({changed,deleted}));if(mode==='save-throw'){assert(cache.entries['a.ttf'],'uncommitted changes leaked into source cache');throw Error('committed then failed')}},
    saveRootDirectorySignatures:async()=>directoryWrites.push(true),appendStartupLog(){}
  })
  const payload = await runtime.applyWatchedFolderChangesToIndex([{folder,eventType:'rename',fileName:mode.includes('list')?'.':'a.ttf',receivedAt:0}], replayUnchanged)
  return {payload:plain(payload),writes,directoryWrites,remaining:Object.keys(cache.entries)}
}
async function deletionCheck(transform = s => s) {
  for(const mode of ['EACCES','ETIMEDOUT','offline','parse','parse-ENOENT','partial-list']) {
    const r=await indexCase(mode,transform)
    assert.deepEqual(r.payload.deletes,[],mode)
    assert.deepEqual(r.remaining,['a.ttf'],mode)
    assert.equal(r.writes.length,0,mode)
    assert.equal(r.directoryWrites.length,0,mode)
    assert(r.payload.errors.length>0,mode+' must surface error')
  }
  for(const mode of ['ENOENT','ENOTDIR','complete-list']) {
    const r=await indexCase(mode,transform);assert.equal(r.payload.deletes.length,1,mode);assert.deepEqual(r.remaining,[])
  }
  for(const mode of ['unchanged','unchanged-list','unchanged-fresh-list'])for(const recovery of [false,true]){const r=await indexCase(mode,transform,recovery);assert.equal(r.payload.errors.length,0);assert.equal(r.payload.upserts.length,recovery?1:0,'unchanged broadcasts only during recovery');assert.equal(r.writes.length,0)}
  const missing=await indexCase('no-cache-missing',transform);assert.equal(missing.payload.deletes.length,1);assert.equal(missing.writes.length,0)
  await assert.rejects(()=>indexCase('save-throw',transform),e=>e.watcherRecoveryDisposition==='defer'&&e.watcherRecoveryChanges?.[0]?.fileName==='a.ttf')
  const r=await indexCase('changed',transform);assert.equal(r.payload.source,'watcher');assert.equal(r.payload.upserts.length,1);assert.equal(r.writes.length,1)
}
const watcherFile = 'src/main/watcher/folderWatcherRuntime.ts'
function broadcastRevisionCheck(transform = s => s) {
  const delivered = []
  const r = load(watcherFile, {
    electron: { BrowserWindow: { getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send(channel, payload) { assert.equal(channel, 'font-index:changed'); delivered.push(plain(payload)) } } },
      { isDestroyed: () => true, webContents: { send() { throw Error('Destroyed window received a broadcast') } } },
    ] } },
    'node:fs': { promises: {}, watch() { throw Error('Broadcast diagnostic must not start watching') } },
    '../path/cachePath': { normalizePathForCacheCompare: value => value.toLowerCase() },
    '../path/startupPathAvailabilityRuntime': { ensureStartupPathRootAvailable: async () => true },
  }, { setTimeout, clearTimeout }, transform).createFolderWatcherRuntime({
    startupGraceMs: 0, flushDebounceMs: 10, closeRuntimeDatabases() {}, isIgnoredWatcherPath: () => false, appendStartupLog() {},
    watcherChangeBatchLooksUnchanged: async () => false,
    applyWatchedFolderChangesToIndex: async () => { throw Error('Broadcast diagnostic must not mutate the index') },
  })
  const empty = { folder: '', at: '2026-10-07T00:00:00Z', upserts: [], deletes: [] }
  try {
    for (const source of [undefined, 'watcher', 'manual', 'shared-metadata']) r.sendFontIndexChanged({ ...empty, source, metricsRevision: 1 })
    assert.equal(delivered.length, 0, 'An empty ordinary payload bypassed the broadcast filter')
    r.sendFontIndexChanged({ ...empty, source: 'projection', projectionRevision: 1 })
    assert.equal(delivered.length, 1, 'Existing empty projection invalidation was lost')
    for (const metricsRevision of [undefined, null, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
      r.sendFontIndexChanged({ ...empty, source: 'metrics', metricsRevision })
      r.sendFontIndexChanged({ ...empty, source: 'metrics', metricsRevision, upserts: [{ id: 'untrusted-revision', path: '/a.ttf' }] })
    }
    assert.equal(delivered.length, 1, 'Invalid metrics revision was broadcast')
    for (const metricsRevision of [1, Number.MAX_SAFE_INTEGER]) r.sendFontIndexChanged({ ...empty, source: 'metrics', metricsRevision })
    assert.deepEqual(delivered.slice(1).map(event => [event.source, event.metricsRevision, event.upserts.length, event.deletes.length]),
      [['metrics', 1, 0, 0], ['metrics', Number.MAX_SAFE_INTEGER, 0, 0]], 'Valid metrics-only invalidation was dropped')
    r.sendFontIndexChanged({ ...empty, source: 'watcher', upserts: [{ id: 'actual-change', path: '/a.ttf' }] })
    assert.equal(delivered.at(-1).upserts[0].id, 'actual-change', 'Ordinary nonempty index broadcasts were lost')
  } finally { r.stopFolderWatchers() }
}
async function recoveryCheck(transform=s=>s) {
  for(const mode of ['apply','sync','send','errors','permanent','grace','restart','persistence']) {
    let apply=0,sync=0,snapshot=0,sends=0,now=0,scanning=false
    const timers=new Map(),logs=[],delivered=[],gate=deferred()
    const r=load(watcherFile,{
      electron:{BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{send(_channel,payload){sends++;if(mode==='send'&&sends===1)throw Error('notify');delivered.push(plain(payload))}}}]}},
      'node:fs':{promises:{stat:async()=>({isDirectory:()=>true})},watch:()=>({on(){},close(){}})},
      '../path/cachePath':{normalizePathForCacheCompare:x=>x.toLowerCase()},
      '../path/startupPathAvailabilityRuntime':{ensureStartupPathRootAvailable:async()=>true}
    },{Date:class extends Date{static now(){return now}},setTimeout(fn,ms){const token={unref(){}};timers.set(token,{fn,ms});return token},clearTimeout:token=>timers.delete(token)},transform).createFolderWatcherRuntime({
      startupGraceMs:100,flushDebounceMs:10,closeRuntimeDatabases(){},isIgnoredWatcherPath:()=>false,appendStartupLog:x=>logs.push(x),isScanActive:()=>scanning,
      watcherChangeBatchLooksUnchanged:async()=>false,
      applyWatchedFolderChangesToIndex:async (changes,replayUnchanged)=>{apply++;assert.equal(replayUnchanged,apply>1,'recovery must explicitly replay unchanged entries');if(mode==='restart'&&apply===1)await gate.promise;if(mode==='persistence'&&apply===1)throw Object.assign(Error('persist'),{watcherRecoveryDisposition:'defer'});if(mode==='permanent'||(mode==='apply'&&apply===1))throw Error('read');return {folder:path.resolve('/fonts'),upserts:[{id:'a',path:'/fonts/a.ttf',fileName:'fresh'}],deletes:[],errors:mode==='errors'&&apply===1?[{path:'/fonts/a.ttf',message:'denied'}]:[]}},
      syncMergedIndexForRootIncremental:async()=>{sync++;if(mode==='sync'&&sync===1)throw Error('merged')},
      syncMergedIndexForRootSnapshot:async()=>{snapshot++}
    })
    const folder=path.resolve('/fonts');await r.startWatchingFolders([folder]);if(mode!=='grace')now=101
    r.notifyFolderChanged(folder,'rename','a.ttf')
    if(mode==='grace'){assert.equal(apply,0);assert.equal(timers.size,1);assert([...timers.values()][0].ms>=100);now=101}
    const tick=async()=>{assert(timers.size>0);const[token,timer]=timers.entries().next().value;timers.delete(token);timer.fn();await drain()}
    if(mode==='restart') {
      const task=r.flushPendingFolderChanges();await drain();r.stopFolderWatchers();await r.startWatchingFolders([folder]);now=202;gate.resolve();await task
      assert.equal(delivered.length,0);assert(timers.size>0)
    } else await tick()
    if(mode==='persistence'){
      assert.equal(apply,1);assert.equal(timers.size,0,'persistence failure must not schedule immediate retry');assert(logs.some(s=>s.includes('recovery deferred')))
      r.notifyFolderChanged(folder,'rename','a.ttf');assert.equal(timers.size,1,'concrete event must release deferred recovery');await tick();assert.equal(apply,2);assert.equal(snapshot,1);assert.equal(timers.size,0);assert(delivered.length>0)
    } else if(!['grace'].includes(mode)) {
      assert(timers.size>0,mode+' needs bounded recovery')
      scanning=true;await tick();assert.equal(apply,1)
      scanning=false;await tick()
      assert.equal(apply,2,mode)
      assert.equal(timers.size,0,mode+' must not retry forever')
      if(mode==='permanent')assert(logs.some(s=>s.includes('recovery exhausted')))
      else {assert.equal(snapshot,1,mode);assert(delivered.length>0);assert.equal(delivered.at(-1).upserts[0].fileName,'fresh')}
    } else {assert.equal(apply,1);assert.equal(delivered.length,1)}
    r.stopFolderWatchers();assert.equal(timers.size,0)
  }
}

async function structuralRecoveryConvergenceCheck(transform=s=>s) {
  const folder=path.resolve('/fonts'),fixtureFiles=4096,logs=[],timers=new Map();let apply=0,rowsRead=0,now=1000
  const r=load(watcherFile,{
    electron:{BrowserWindow:{getAllWindows:()=>[]}},
    'node:fs':{promises:{stat:async()=>({isDirectory:()=>true})},watch:()=>({on(){},close(){}})},
    '../path/cachePath':{normalizePathForCacheCompare:x=>x.toLowerCase()},
    '../path/startupPathAvailabilityRuntime':{ensureStartupPathRootAvailable:async()=>true}
  },{Date:class extends Date{static now(){return now}},setTimeout(fn,ms){const token={unref(){}};timers.set(token,{fn,ms});return token},clearTimeout:token=>timers.delete(token)},transform).createFolderWatcherRuntime({
    startupGraceMs:0,flushDebounceMs:10,closeRuntimeDatabases(){},isIgnoredWatcherPath:()=>false,appendStartupLog:x=>logs.push(x),isScanActive:()=>false,
    watcherChangeBatchLooksUnchanged:async()=>false,
    applyWatchedFolderChangesToIndex:async()=>{apply++;rowsRead+=fixtureFiles;if(apply===1)throw Object.assign(Error('structural persistence failure'),{watcherRecoveryDisposition:'defer'});return{folder,upserts:[],deletes:[],errors:[]}},
    syncMergedIndexForRootIncremental:async()=>{},syncMergedIndexForRootSnapshot:async()=>{}
  })
  await r.startWatchingFolders([folder]);r.notifyFolderChanged(folder,'rescan')
  const tick=async()=>{assert(timers.size>0);const[token,timer]=timers.entries().next().value;timers.delete(token);timer.fn();await drain()}
  await tick();assert.equal(apply,1);assert.equal(rowsRead,fixtureFiles);assert.equal(timers.size,0)
  for(let i=0;i<fixtureFiles;i++)r.notifyFolderChanged(folder,'rescan')
  assert.equal(timers.size,0,'deferred root must not spin on repeated root-level signals');assert.equal(apply,1)
  r.notifyFolderChanged(folder,'rename','changed.ttf');assert.equal(timers.size,1);await tick()
  assert.equal(apply,2,'next concrete event must allow exactly one deferred replay');assert.equal(rowsRead,fixtureFiles*2);assert.equal(timers.size,0)
  assert(logs.some(x=>x.includes('root diff suppressed while recovery is deferred')))
  r.stopFolderWatchers()
}
async function multiRootIsolationCheck(transform=s=>s){
  const a=path.resolve('/fonts-a'),b=path.resolve('/fonts-b'),logs=[],delivered=[];let now=1000
  const r=load(watcherFile,{
    electron:{BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{send(_c,p){delivered.push(plain(p))}}}]}},
    'node:fs':{promises:{stat:async()=>({isDirectory:()=>true})},watch:()=>({on(){},close(){}})},
    '../path/cachePath':{normalizePathForCacheCompare:x=>x.toLowerCase()},
    '../path/startupPathAvailabilityRuntime':{ensureStartupPathRootAvailable:async()=>true}
  },{Date:class extends Date{static now(){return now}},setTimeout,clearTimeout},transform).createFolderWatcherRuntime({
    startupGraceMs:0,flushDebounceMs:60000,closeRuntimeDatabases(){},isIgnoredWatcherPath:()=>false,appendStartupLog:x=>logs.push(x),isScanActive:()=>false,
    watcherChangeBatchLooksUnchanged:async()=>false,
    applyWatchedFolderChangesToIndex:async changes=>{const root=path.resolve(changes[0].folder);if(root===a)throw Object.assign(Error('persist-a'),{watcherRecoveryDisposition:'defer'});return{folder:root,upserts:[{id:'b',path:path.join(root,'b.ttf')}],deletes:[],errors:[]}},
    syncMergedIndexForRootIncremental:async()=>{},syncMergedIndexForRootSnapshot:async()=>{}
  })
  await r.startWatchingFolders([a,b]);r.notifyFolderChanged(a,'rename','a.ttf');r.notifyFolderChanged(b,'rename','b.ttf');await r.flushPendingFolderChanges()
  assert(delivered.some(x=>path.resolve(x.folder)===b),'one root failure must not stop another root');assert(logs.some(x=>x.includes('recovery deferred')&&x.includes(a)))
  r.stopFolderWatchers()
}

const manualFile='src/main/watcher/manual-refresh/manualFolderIndexApplyRuntime.ts'
async function manualIncompleteCheck(transform=s=>s) {
  let writes=0,signatures=0
  const cache={entries:{'a.ttf':{font:{id:'a'}}}}
  const r=load(manualFile,{
    '../../rust-core/rustFullMigrationPolicyRuntime':{rustFullMigrationEnabled:()=>false},
    '../../indexing/scan-orchestrator/rustMetadataFastPathRuntime':{},
    '../../indexing/scan-orchestrator/rustParseBatchFastPathRuntime':{consumeRustFontParseBatchFastPath:async()=>({remainingJobs:[],consumed:0,errors:0})},
    './manualFolderRustListingRuntime':{createManualFolderRustListingRuntime:()=>({tryListManualRefreshWithRust:async()=>null})}
  },{},transform).createManualFolderIndexApplyRuntime({
    ensureRootScanCacheStorage:async()=>({cachePath:'/index.db',storage:'root'}),
    appendStartupLog(){},scanWorkerCount:()=>1,runFontParseWorkerPool:async jobs=>{assert.equal(jobs.length,0);return {workerCount:0}},invalidateSharedFontRuntimeCaches(){},isRootIndexDbPath:()=>true,
    saveRootIndexSqliteChanges:async()=>{writes++}
  },{
    makeRootScanCacheContext:()=>({cache,directoryUpdates:[]}),relativeDirectoryPathForRoot:()=>'',cacheKeyInsideDirectory:()=>true,
    fontIndexDeleteRecord:()=>({path:'/fonts/a.ttf',relativePath:'a.ttf'}),saveRootDirectorySignatures:async()=>{signatures++},
    listFontFilesWithDirectoryCache:async(_context,errors)=>{errors.push({path:'/fonts',message:'EACCES'});return []}
  })
  const result=await r.applyManualFolderRefreshToIndex('/fonts','/fonts')
  assert.equal(result.payload.deletes.length,0);assert.equal(writes,0);assert.equal(signatures,0);assert(cache.entries['a.ttf'])
}
const rendererFile='src/renderer/src/library-normalize/libraryIndexChangeRuntime.ts'
function authorityCheck(transform=s=>s) {
  const r=load(rendererFile,{
    './libraryFolderTreeRuntime':{buildFolderTreeFromCachedFonts:()=>({nodes:[]})},
    './libraryNormalizeStateRuntime':{pruneFontFolderIds:ids=>ids},
    './libraryNormalizeBase':{normalizeFolderPathForCompare:p=>p.toLowerCase(),normalizeFontPathForCompare:p=>p.toLowerCase()}
  },{},transform)
  for(const active of [false,true]) {
    const old={id:'a',path:'/fonts/a.ttf',family:'old',favorite:active,deleteProtected:active,active,activeSince:active?'today':undefined,managedInstallPath:active?'managed':undefined,managedRegistryName:active?'reg':undefined,systemInstalled:active,systemInstallMatches:active?['system']:[],installStatusKnown:true,collectionIds:['c'],localTagNames:['local'],tagNames:['shared'],__localTagRevision:30,__sharedTagRevision:40}
    const incoming={...old,family:'new',favorite:!active,deleteProtected:!active,active:!active,activeSince:'stale',managedInstallPath:'stale',managedRegistryName:'stale',systemInstalled:!active,systemInstallMatches:[],installStatusKnown:false,collectionIds:[],localTagNames:[],tagNames:[],__localTagRevision:0,__sharedTagRevision:0}
    const other={id:'b',path:'/fonts/b.ttf',favorite:true}
    const state={folders:['/fonts'],fonts:{a:old,b:other},tags:['shared'],localTags:['local']}
    const result=r.applyFontIndexChangeToLibrary(state,{folder:'/fonts',source:'watcher',upserts:[incoming],deletes:[]})
    const font=result.library.fonts.a
    for(const key of ['favorite','deleteProtected','active','activeSince','managedInstallPath','managedRegistryName','systemInstalled','systemInstallMatches','installStatusKnown','collectionIds','localTagNames','tagNames','__localTagRevision','__sharedTagRevision'])assert.deepEqual(plain([font[key]]),plain([old[key]]),key)
    assert.equal(font.family,'new');assert.equal(result.library.fonts.b,other)
    const shared=r.mergeIncrementalIndexedFont(old,{...incoming,tagNames:['updated']},'shared-metadata')
    assert.equal(shared.favorite,!active);assert.deepEqual(plain(shared.tagNames),['updated'])
    const legacy=r.mergeIncrementalIndexedFont(old,incoming);assert.equal(legacy.active,true)
    assert.equal(r.mergeIncrementalIndexedFont(undefined,incoming,'watcher').favorite,!active)
  }
}
async function semanticDiffCheck() {
  const baseLoad = require('./check-operation-chain.cjs').loader;
  const helper = baseLoad({'../../path/sharedFileSystemRuntime':{sharedFileSystem:{}}})('src/main/watcher/manual-refresh/manualFolderIndexEntryRuntime.ts').createManualFolderIndexEntryRuntime({});
  const entry = {path:'a.ttf',cacheKey:'a|10|1',status:'ok',cachedAt:'old',font:{id:'a',scripts:['latin'],scriptVersion:1}};
  assert.equal(helper.fontIndexEntryChanged(entry,{...entry,cachedAt:'new'}),false,'bookkeeping timestamp became a semantic update');
  assert.equal(helper.fontIndexEntryChanged(entry,{...entry,font:{scriptVersion:1,scripts:['latin'],id:'a'}}),false,'property order became a semantic update');
  for(const changed of [{cacheKey:'a|11|2'},{status:'bad'},{contentHash:'new'},{font:{...entry.font,scriptVersion:2}}]) assert.equal(helper.fontIndexEntryChanged(entry,{...entry,...changed}),true);
  const folder=path.resolve('/f12-fonts'), logs=[], writes=[];
  const entries=Object.fromEntries(Array.from({length:394},(_,i)=>['f'+i+'.ttf',{...entry,path:'f'+i+'.ttf',font:{...entry.font,id:'f'+i,path:path.join(folder,'f'+i+'.ttf')}}]));
  const cache={entries}; let changed='',invalid=false, visits=0;
  const options={appendStartupLog:s=>logs.push(s),isIgnoredWatcherPath:()=>false,fontExtensions:new Set(['.ttf']),withGlobalIo:(_l,fn)=>fn(),
    rootIndexDbPath:()=>'/db',rootCacheDir:()=>'/cache',resolveActiveRootIndexDbPath:async()=>'/db',exists:async()=>true,
    ensureRootScanCacheStorage:async()=>({cachePath:'/db',cache,storage:'root'}),makeRootScanCacheContext:()=>({cache,directoryUpdates:[],directorySkipped:0}),
    readRootDirectorySignatures:async()=>new Map([['',{modifiedAt:1,fileCount:394,dirCount:0}]]),saveRootDirectorySignatures:async()=>{},
    cacheKeyForRootFile:(_root,file)=>path.basename(file),relativeDirectoryPathForRoot:(_root,file)=>file===folder?'':path.relative(folder,file),cacheKeyInsideDirectory:()=>true,
    listFontFilesWithDirectoryCache:async context=>{assert.equal(context.requireFreshFileStats,true);return Object.keys(cache.entries).map(key=>({file:path.join(folder,key),stat:{size:10,mtimeMs:1},freshStat:true,error:''}))},
    upsertFontIndexEntry:async(_root,file,working)=>{visits++;const key=path.basename(file);if(key===changed)working.entries[key]={...working.entries[key],cacheKey:'updated',status:invalid?'bad':'ok',font:invalid?undefined:{...working.entries[key].font,modifiedAt:2}};return working.entries[key].font||null},
    fontIndexEntryChanged:helper.fontIndexEntryChanged,fontIndexDeleteRecord:(_root,key,e)=>({path:path.join(folder,key),relativePath:key,id:e?.font?.id}),removeFontIndexEntriesForPath:()=>[],
    saveRootIndexSqliteChanges:async(_p,_root,_store,upserts,deletes)=>writes.push({upserts:upserts.length,deletes:deletes.length})};
  const instance=load(indexFile,{'node:fs':{promises:{stat:async file=>({isDirectory:()=>file===folder,isFile:()=>file!==folder,mtimeMs:1,size:10}),readdir:async()=>[]}},'../cache/cachePaths':{fileCacheSignature:()=>'',isIgnoredInternalDirectoryName:()=>false,isRootIndexDbPath:()=>true}}).createWatchedFolderIndexRuntime(options);
  const events=[{folder,fileName:'.',eventType:'change',origin:'shared-poll-initial',triggerEventType:'rename',receivedAt:1},{folder,fileName:'f0.ttf',eventType:'change',receivedAt:1},{folder,fileName:'f0.ttf',eventType:'rename',receivedAt:1}];
  assert.equal(instance.normalizePendingFolderChanges([{...events[1],eventType:'rename'},events[1]])[0].eventType,'rename','later change erased stronger rename evidence');
  assert.equal(await instance.watcherChangeBatchLooksUnchanged(folder,[events[0]]),false,'unchanged directory parent suppressed child enumeration');
  let result=await instance.applyWatchedFolderChangesToIndex(events);
  assert.equal(visits,394,'overlapping root/file events repeated work');assert.equal(result.upserts.length,0);assert.equal(writes.length,0);
  let summary=JSON.parse(logs.at(-1).split('font index watcher diff: ')[1]);assert.equal(summary.unchanged,394);assert.equal(summary.examined,394);assert.equal(summary.expansion,'root-enumeration');assert.equal(summary.samples[0].origin,'shared-poll-initial');assert.equal(summary.samples[0].trigger,'rename');
  changed='f0.ttf';visits=0;result=await instance.applyWatchedFolderChangesToIndex(events);assert.equal(result.upserts.length,1);assert.equal(visits,394);assert.equal(writes.at(-1).upserts,1);
  changed='';result=await instance.applyWatchedFolderChangesToIndex(events,true);assert.equal(result.upserts.length,394,'recovery replay was lost');
  changed='f1.ttf';invalid=true;result=await instance.applyWatchedFolderChangesToIndex([{...events[1],fileName:changed}]);assert.equal(result.deletes.length,1);assert.equal(cache.entries[changed].status,'bad','invalid entry evidence was deleted');assert.equal(writes.at(-1).deletes,0);
  changed='';result=await instance.applyWatchedFolderChangesToIndex([{...events[1],fileName:'f1.ttf'}],true);assert.equal(result.deletes.length,1,'recovery lost persisted bad-row withdrawal');
}
async function freshDirectoryListingCheck() {
  const folder=path.resolve('/fresh-fonts'), stale=path.join(folder,'old.ttf'), actual=path.join(folder,'new.ttf');let denied=false;
  const stat=async file=>{if(file===folder)return{mtimeMs:1};if(denied)throw Object.assign(Error('denied'),{code:'EACCES'});assert.equal(file,actual,'cached stale filename was statted');return{size:5,mtimeMs:2,birthtimeMs:1,ctimeMs:1}};
  const baseLoad=require('./check-operation-chain.cjs').loader;
  const instance=baseLoad({[path.join(root,'src/main/path/sharedFileSystemRuntime.ts')]:{sharedFileSystem:{stat,readdir:async()=>[{name:'new.ttf',isDirectory:()=>false,isFile:()=>true}]}},'../../path/sharedDirectoryMetadataRuntime':{readSharedDirectoryMetadata:async()=>null}})('src/main/indexing/scan-orchestrator/rootDirectoryCacheRuntime.ts').createRootDirectoryCacheRuntime({fontExtensions:new Set(['.ttf']),appendStartupLog(){},cacheEntryRuntimePath:(_r,key)=>path.join(folder,key),withGlobalIo:(_l,fn)=>fn(),openRootIndexDb:async()=>({prepare:()=>({all:()=>[{relative_path:'',modified_at:1,file_count:1,dir_count:0}]})}),closeSqliteDb(){}});
  const context=()=>({rootPath:folder,cachePath:'/test/index.sqlite',storage:'root',requireFreshFileStats:true,cache:{entries:{'old.ttf':{status:'ok',fileSize:5,modifiedAt:1}}},seenKeys:new Set(),directoryUpdates:[],directorySkipped:0});
  const errors=[];let rows=await instance.listFontFilesWithDirectoryCache(context(),errors);assert.deepEqual(plain(rows.map(row=>row.file)),[actual]);assert.equal(rows[0].freshStat,true);assert.equal(errors.length,0);assert(!rows.some(row=>row.file===stale));
  denied=true;const failures=[];rows=await instance.listFontFilesWithDirectoryCache(context(),failures);assert.equal(rows.length,0);assert.equal(failures.length,1,'fresh listing reused inaccessible cached stat without error');
}
async function main(){
  broadcastRevisionCheck(); broadcastRevisionCheck(s => s.replace(/\r?\n/g, '\r\n'));
  const metricsAdmission = "const metricsOnly = payload.source === 'metrics' && Number.isSafeInteger(payload.metricsRevision) && Number(payload.metricsRevision) > 0;";
  const invalidMetricsGuard = "if (payload.source === 'metrics' && !metricsOnly) return;";
  assert(read(watcherFile).includes(metricsAdmission), 'Metrics admission mutation anchor missing');
  assert(read(watcherFile).includes(invalidMetricsGuard), 'Invalid metrics mutation anchor missing');
  assert.throws(() => broadcastRevisionCheck(s => s.replace(metricsAdmission, 'const metricsOnly = false;')), assert.AssertionError);
  assert.throws(() => broadcastRevisionCheck(s => s.replace(invalidMetricsGuard, '')), assert.AssertionError);
  await semanticDiffCheck(); await freshDirectoryListingCheck(); authorityCheck();
  assert.throws(()=>authorityCheck(s=>s.replace("source === 'watcher'", "source === 'never'")),assert.AssertionError); await manualIncompleteCheck();
  await assert.rejects(()=>manualIncompleteCheck(s=>s.replace('if (payload.errors?.length) break;','')),assert.AssertionError)
 await recoveryCheck(); await structuralRecoveryConvergenceCheck(); await multiRootIsolationCheck();
  await assert.rejects(()=>recoveryCheck(s=>s.replaceAll('if (!recovery)', 'if (false)')),assert.AssertionError)
  await assert.rejects(()=>recoveryCheck(s=>s.replace('if (recovery && options.syncMergedIndexForRootSnapshot)', 'if (false && options.syncMergedIndexForRootSnapshot)')),assert.AssertionError)
  await assert.rejects(()=>recoveryCheck(s=>s.replace('if (recoveryError?.watcherRecoveryDisposition === "defer")', 'if (false)')),assert.AssertionError)
  await assert.rejects(()=>structuralRecoveryConvergenceCheck(s=>s.replace('if (deferredRecoveryBatches.has(rootKey)) {', 'if (false) {')),assert.AssertionError)
 await deletionCheck();
  await assert.rejects(()=>deletionCheck(s=>s.replace('replayUnchanged && font','font')),/unchanged broadcasts/)
  await assert.rejects(()=>deletionCheck(s=>s.replace('replayUnchanged && font','false && font')),/unchanged broadcasts/)
  await assert.rejects(()=>deletionCheck(s=>s.replace('if (!confirmedMissing) {','if (false) {')),assert.AssertionError)
  await assert.rejects(()=>deletionCheck(s=>s.replace('if (errors.length > errorCount) return false','')),assert.AssertionError)
  await assert.rejects(()=>deletionCheck(s=>s.replace("watcherRecoveryDisposition: 'defer' as const,","")),assert.AssertionError)
console.log('[diagnostics:watcher-index-consistency] deletion evidence, deferred persistence recovery, 4096-row convergence, multi-root isolation, grace/restart and safe manual fallback; source-scoped field authority; metrics-only broadcasts and invalid-revision filtering; thirteen mutations rejected') }
main().catch(e=>{console.error(e);process.exitCode=1})
