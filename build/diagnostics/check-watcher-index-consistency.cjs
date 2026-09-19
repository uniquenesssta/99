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
  vm.runInNewContext(code, { exports, console, process, ...globals, require(id) {
    if (Object.hasOwn(mocks,id)) return mocks[id]
    if (id.endsWith('/sharedFileSystemRuntime')) return { sharedFileSystem: (mocks['node:fs'] || fs).promises }
    if (id.endsWith('/rustSharedIoCommandRuntime')) return { sharedIoResourceKeys: async () => [] }
    if (id==='node:path') return path
    if (['node:async_hooks', 'node:perf_hooks'].includes(id)) return require(id)
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
    listFontFilesWithDirectoryCache:async (_ctx,errors)=>{ context.directoryUpdates.push({relativePath:''}); if(mode==='partial-list')errors.push({path:folder,message:'EACCES'});return mode==='unchanged-list'?[{file}]:[] },
    upsertFontIndexEntry:async(_root,_file,workingCache)=>{ if(mode==='parse-ENOENT')throw fail('ENOENT'); if(mode==='parse')throw Error('metadata'); if(!mode.startsWith('unchanged'))workingCache.entries['a.ttf']={...existing,cacheKey:'new'};return existing.font },
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
  for(const mode of ['unchanged','unchanged-list'])for(const recovery of [false,true]){const r=await indexCase(mode,transform,recovery);assert.equal(r.payload.upserts.length,recovery?1:0,'unchanged broadcasts only during recovery');assert.equal(r.writes.length,0)}
  const missing=await indexCase('no-cache-missing',transform);assert.equal(missing.payload.deletes.length,1);assert.equal(missing.writes.length,0)
  await assert.rejects(()=>indexCase('save-throw',transform),e=>e.watcherRecoveryChanges?.[0]?.fileName==='a.ttf')
  const r=await indexCase('changed',transform);assert.equal(r.payload.source,'watcher');assert.equal(r.payload.upserts.length,1);assert.equal(r.writes.length,1)
}
const watcherFile = 'src/main/watcher/folderWatcherRuntime.ts'
async function recoveryCheck(transform=s=>s) {
  for(const mode of ['apply','sync','send','errors','permanent','grace','restart']) {
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
      applyWatchedFolderChangesToIndex:async (changes,replayUnchanged)=>{apply++;assert.equal(replayUnchanged,apply>1,'recovery must explicitly replay unchanged entries');if(mode==='restart'&&apply===1)await gate.promise;if(mode==='permanent'||(mode==='apply'&&apply===1))throw Error('read');return {folder:path.resolve('/fonts'),upserts:[{id:'a',path:'/fonts/a.ttf',fileName:'fresh'}],deletes:[],errors:mode==='errors'&&apply===1?[{path:'/fonts/a.ttf',message:'denied'}]:[]}},
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
    if(!['grace'].includes(mode)) {
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
async function main(){ authorityCheck();
  assert.throws(()=>authorityCheck(s=>s.replace("source === 'watcher'", "source === 'never'")),assert.AssertionError); await manualIncompleteCheck();
  await assert.rejects(()=>manualIncompleteCheck(s=>s.replace('if (payload.errors?.length) break;','')),assert.AssertionError)
 await recoveryCheck();
  await assert.rejects(()=>recoveryCheck(s=>s.replaceAll('if (!recovery)', 'if (false)')),assert.AssertionError)
  await assert.rejects(()=>recoveryCheck(s=>s.replace('if (recovery && options.syncMergedIndexForRootSnapshot)', 'if (false && options.syncMergedIndexForRootSnapshot)')),assert.AssertionError)
 await deletionCheck();
  await assert.rejects(()=>deletionCheck(s=>s.replace('replayUnchanged && font','font')),/unchanged broadcasts/)
  await assert.rejects(()=>deletionCheck(s=>s.replace('replayUnchanged && font','false && font')),/unchanged broadcasts/)
  await assert.rejects(()=>deletionCheck(s=>s.replace('if (!confirmedMissing) {','if (false) {')),assert.AssertionError)
  await assert.rejects(()=>deletionCheck(s=>s.replace('if (errors.length > errorCount) return false','')),assert.AssertionError)
console.log('[diagnostics:watcher-index-consistency] deletion evidence, bounded recovery, grace/restart and safe manual fallback; source-scoped field authority; eight mutations rejected') }
main().catch(e=>{console.error(e);process.exitCode=1})
