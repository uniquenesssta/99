#!/usr/bin/env node
'use strict'
// Windows-only regression for production metadata-first manual refresh. Native
// fixture coverage is also called by check-watcher-noop-freshness.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const drain = async () => { for(let i=0;i<40;i++) await Promise.resolve() }
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`Controlled diagnostic deadline: ${label}`)),5000)})]) }
  finally { clearTimeout(timer) }
}
const signature = (key,size,time) => `${key}|${size}|${Math.round(time)}`
function fixture() {
  const folder = path.resolve('/manual-fonts'), cache = { version: 1, entries: {} }, writes = [], logs = [], parsed = []
  const state = { inventory: {}, local: false, error: null, parseGate: null, parseEntered: deferred(), legacy: false, redirect: false, incomplete: false, saveError:null, beforeSave:null, afterSave:null }
  const shutdown = { listeners: new Set(), closing: false, epoch: 0 }
  const load = loader({
    [path.join(root, 'src/main/path/sharedFileSystemRuntime.ts')]: {
      currentSharedIoSignal: () => undefined, withSharedIoSignal: (_signal,work) => work(),
      sharedFileSystem: { stat: async () => ({ isDirectory: () => true }) },
      executeSharedFile: async request => { assert.equal(request.operation, 'treeSnapshot'); if(state.error)throw state.error; return { result:{ok:true,operation:'treeSnapshot',value:state.inventory} } },
    },
    [path.join(root, 'src/main/rust-core/rustSharedIoCommandRuntime.ts')]: { sharedIoResourceKeys: async () => state.local ? [] : ['fixture'] },
    [path.join(root, 'src/main/app/shutdownCoordinatorRuntime.ts')]: {
      applicationWorkEpoch: () => shutdown.epoch,
      assertApplicationOpen: epoch => { if(shutdown.closing || epoch !== shutdown.epoch)throw Error('closing') },
      onApplicationClosing: fn => { shutdown.listeners.add(fn); return () => shutdown.listeners.delete(fn) },
    },
  }, { Error })
  const stat = (size=10,mtimeMs=1000) => ({size,mtimeMs})
  const row = (key,size=10,time=1000) => { state.inventory[key] = [size,String(BigInt(Math.round(time*1e6)))] }
  const entry = (key,size=10,time=1000,status='ok') => cache.entries[key] = {path:key,cacheKey:signature(key,size,time),fileSize:size,modifiedAt:time,createdAt:1,status,cachedAt:'old',...(status==='ok'?{font:{id:key,path:path.join(folder,key),scripts:['latin'],scriptVersion:1}}:{})}
  const deps = {
    fontExtensions:new Set(['.ttf']),scriptDetectionVersion:1,fontScanCacheVersion:1,
    appendStartupLog:line=>logs.push(line),fileCacheSignature:signature,
    cacheKeyForRootFile:(_root,file)=>path.relative(folder,file).replaceAll('\\','/').toLowerCase(),cacheEntryRuntimePath:(_root,key)=>path.join(folder,key),
    sanitizeCachedFont:(font)=>font,cachedFontForRuntime:font=>font,
    ensureRootScanCacheStorage:async(_root,options)=>{assert.equal(options.reuseExisting,true);return{cache,cachePath:'/index.sqlite',cacheDir:'/cache',storage:'root'}},
    saveRootIndexSqliteChanges:async(_db,_root,_storage,changed,deleted,guard)=>{guard?.();state.beforeSave?.();if(state.saveError)throw state.saveError;writes.push(plain({changed,deleted}));state.afterSave?.()},
    isRootIndexDbPath:()=>true,invalidateSharedFontRuntimeCaches(){},emitFontIndexProgress(){},delayToEventLoop:async()=>{},
    runRustFontParseBatch:async jobs=>{
      parsed.push(...plain(jobs));assert(jobs.every(job=>job.requireSourceStability===true));state.parseEntered.resolve();
      if(state.parseGate)await state.parseGate.promise;
      if(state.legacy)return null;
      return{results:jobs.map(job=>({...job,...(state.redirect?{filePath:path.join(folder,'other.ttf')} : {}),signatureValid:true,nameHint:{familyName:'Fixture'},scriptHint:{scripts:['latin']},contentHash:'controlled-content'}))}
    },
    runFontParseWorkerPool:async()=>{throw Error('unsafe legacy parser fallback')},
    scanFoldersRuntime:()=>({readRootDirectorySignatures:async()=>new Map(),saveRootDirectorySignatures:async()=>{},
      listFontFilesWithDirectoryCache:async(context,errors)=>{assert.equal(context.requireFreshFileStats,true);if(state.incomplete)errors.push({path:folder,message:'incomplete'});return Object.entries(state.inventory).map(([key,[size,time]])=>({file:path.join(folder,key),stat:stat(size,Number(BigInt(time))/1e6),rootPath:folder,error:''}))}}),
  }
  const index = load('src/main/watcher/manual-refresh/manualFolderIndexEntryRuntime.ts').createManualFolderIndexEntryRuntime(deps)
  const manual = load('src/main/watcher/manual-refresh/manualFolderIndexApplyRuntime.ts').createManualFolderIndexApplyRuntime(deps,index)
  return { folder,cache,writes,logs,parsed,state,shutdown,load,deps,index,manual,row,entry }
}
async function checkControlled() {
  let f=fixture();f.entry('a.ttf');f.row('a.ttf');let result=await f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder)
  assert.equal(result.fromCache,1);assert.equal(result.parsed,0);assert.equal(f.parsed.length,0);assert.equal(f.writes.length,0)
  f.row('a.ttf',11);f.row('new.ttf');result=await f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder)
  assert.equal(result.parsed,2);assert.equal(f.parsed.length,2);assert.equal(result.payload.upserts.length,2)
  assert(f.logs.at(-1).includes('addedFiles=1, changedFiles=1, metadataRepairs=0'))
  f=fixture();f.entry('a.ttf');f.row('a.ttf');f.cache.entries['a.ttf'].font.scripts=[]
  result=await f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder);assert.equal(result.parsed,1)
  assert(f.logs.at(-1).includes('changedFiles=0, metadataRepairs=1'))
  f=fixture();f.entry('bad.ttf',10,1000,'bad');f.row('bad.ttf')
  result=await f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder)
  assert.equal(result.payload.deletes.length,1);assert.equal(f.writes.length,0);assert.equal(f.parsed.length,0)
  assert(f.logs.at(-1).includes('sourceDeletes=0, projectionDeletes=1'))
  f=fixture();f.entry('sub/old.ttf');f.entry('outside.ttf');f.row('new.ttf')
  result=await f.manual.applyManualFolderRefreshToIndex(f.folder,path.join(f.folder,'sub'))
  assert.deepEqual(plain(result.payload.deletes.map(row=>row.relativePath)),['sub/old.ttf'])
  assert(f.cache.entries['outside.ttf']);assert(f.cache.entries['sub/new.ttf']);assert(!f.cache.entries['sub/old.ttf'])
  f=fixture();f.entry('a.ttf');f.state.local=true;f.state.incomplete=true
  result=await f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder)
  assert.equal(result.payload.deletes.length,0);assert.equal(f.writes.length,0);assert(f.cache.entries['a.ttf'])
  for(const inventory of [{'A.ttf':[10,'1000000000'],'a.ttf':[10,'1000000000']},{'../outside.ttf':[10,'1000000000']},{'bad.ttf':[10,'NaN']}]) {
    f=fixture();f.entry('old.ttf');f.state.inventory=inventory
    await assert.rejects(()=>f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder));assert.equal(f.writes.length,0);assert.equal(f.parsed.length,0)
  }
  for(const mode of ['legacy','redirect']) {
    f=fixture();f.entry('a.ttf');f.row('a.ttf',11);f.state[mode]=true
    result=await f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder)
    assert.equal(result.payload.errors.length,1);assert.equal(f.writes.length,0);assert.equal(f.cache.entries['a.ttf'].fileSize,10)
  }
  f=fixture();f.entry('a.ttf');f.row('a.ttf',11);f.state.parseGate=deferred();const controller=new AbortController()
  const pending=f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder,undefined,{signal:controller.signal});await bounded(f.state.parseEntered.promise,'cancel parse entered')
  controller.abort();f.state.parseGate.resolve();await assert.rejects(()=>pending,/cancel|取消/i)
  assert.equal(f.writes.length,0);assert.equal(f.cache.entries['a.ttf'].fileSize,10)
  f=fixture();f.entry('a.ttf');f.row('a.ttf',11);f.state.parseGate=deferred();let current=true
  const stale=f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder,undefined,{assertCurrent:()=>{if(!current)throw Error('stale-owner')}});void stale.catch(()=>{})
  await bounded(f.state.parseEntered.promise,'stale parse entered');current=false;f.state.parseGate.resolve();await assert.rejects(()=>stale,/stale-owner/)
  assert.equal(f.writes.length,0);assert.equal(f.cache.entries['a.ttf'].fileSize,10)
  f=fixture();f.entry('a.ttf');const close=deferred();const closeEntered=deferred();f.state.error=Object.assign(Error('offline'),{sharedIo:true,closed:{then(resolve,reject){closeEntered.resolve();return close.promise.then(resolve,reject)}}})
  let settled=false;const closed=f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder).finally(()=>{settled=true});void closed.catch(()=>{})
  await bounded(closeEntered.promise,'physical close awaited');assert.equal(settled,false);assert.equal(f.writes.length,0);close.resolve();await assert.rejects(()=>closed,/offline/);assert(f.cache.entries['a.ttf'])
  f=fixture();f.entry('a.ttf');f.row('a.ttf',11);f.state.beforeSave=()=>assert.equal(f.cache.entries['a.ttf'].fileSize,10,'staged row leaked before source receipt')
  f.state.saveError=Error('controlled-source-write-failed')
  await assert.rejects(()=>f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder),/controlled-source-write-failed/)
  assert.equal(f.writes.length,0);assert.equal(f.cache.entries['a.ttf'].fileSize,10)
  f=fixture();f.entry('a.ttf');f.row('a.ttf',11);const afterCommit=new AbortController()
  f.state.beforeSave=()=>assert.equal(f.cache.entries['a.ttf'].fileSize,10)
  f.state.afterSave=()=>afterCommit.abort()
  await assert.rejects(()=>f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder,undefined,{signal:afterCommit.signal}),/cancel|取消/i)
  assert.equal(f.writes.length,1);assert.equal(f.cache.entries['a.ttf'].fileSize,11,'confirmed source receipt was rolled back after cancellation')
  // Metadata equality is not byte equality: real watcher concrete evidence must
  // still force stable verification, while canonical rounded-ms reuse remains.
  f=fixture();f.entry('a.ttf',10,1000.1);f.row('a.ttf',10,1000.2)
  result=await f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder);assert.equal(result.parsed,0)
  const forced=await f.index.upsertFontIndexEntries(f.folder,[{file:path.join(f.folder,'a.ttf'),freshStat:{size:10,mtimeMs:1000.2},forceVerify:true,requireSourceStability:true}],f.cache)
  assert.equal(forced.parsed,1);assert.equal(forced.misses['concrete-event'],1)
  const decoded=f.load('src/main/watcher/sharedWatcherInventoryRuntime.ts').sharedWatcherInventory(f.folder,{'a.ttf':[10,'1000123456']})
  assert.equal(decoded.files.get('a.ttf').mtimeMs,1000.123456)
  f=fixture();f.entry('a.ttf');f.row('a.ttf',11);f.state.parseGate=deferred()
  const background=f.load('src/main/watcher/manual-refresh/manualFolderRefreshBackgroundRuntime.ts').createManualFolderRefreshBackgroundRuntime(f.deps)
  background.scheduleRefresh('root','job',lifetime=>f.manual.applyManualFolderRefreshToIndex(f.folder,f.folder,undefined,lifetime))
  const stopped=background.waitForRefresh('root');void stopped.catch(()=>{});await bounded(f.state.parseEntered.promise,'shutdown parse entered')
  f.shutdown.closing=true;f.shutdown.epoch++;for(const fn of f.shutdown.listeners)fn()
  f.state.parseGate.resolve();await assert.rejects(()=>stopped,/cancel|取消|closing/i);assert.equal(f.writes.length,0);assert.equal(f.shutdown.listeners.size,0)
  // A durable prior source write followed by projection failure is retried from
  // the current source, even when the next comparison has no structural delta.
  f=fixture();let attempt=0,snapshots=0,incrementals=0;const notifications=[], projectionCommits=[]
  const refreshDeps={...f.deps,withGlobalIo:(_name,work)=>work(),appWatchedFolders:async()=>[f.folder],findBestWatchedRootForFile:()=>f.folder,
    createFontScanJobId:()=>`manual-${++attempt}`,sendFontIndexChanged:payload=>notifications.push(payload),
    syncMergedIndexForRootSnapshot:async target=>{assert.equal(target,f.folder);snapshots++;if(snapshots===1)throw Error('projection-unavailable');projectionCommits.push({source:'projection',projectionRevision:snapshots})},
    syncMergedIndexForRootIncremental:async()=>incrementals++}
  const backgroundOwner=f.load('src/main/watcher/manual-refresh/manualFolderRefreshBackgroundRuntime.ts').createManualFolderRefreshBackgroundRuntime(refreshDeps)
  const repair={repairRootIndexCacheIfNeeded:async()=>({ok:true,rebuildRequired:false}),repairRootPreviewCacheIfNeeded:async()=>({ok:true})}
  let partial=false
  const applying={applyManualFolderRefreshToIndex:async()=>({payload:{folder:f.folder,upserts:[],deletes:[],errors:partial?[{message:'incomplete'}]:[]},totalFiles:1,parsed:0,fromCache:1,skippedBad:0,workerCount:0,sourceDeletes:0,projectionDeletes:0,metadataRepairs:0})}
  const refresh=f.load('src/main/watcher/manual-refresh/manualWatchedFolderRefreshRuntime.ts').createManualWatchedFolderRefreshRuntime(refreshDeps,repair,applying,backgroundOwner)
  await assert.rejects(()=>refresh.refreshWatchedFolder(f.folder,undefined,true),/projection-unavailable/)
  await drain();assert.equal(notifications.length,0)
  const recovered=await refresh.refreshWatchedFolder(f.folder,undefined,true);await drain()
  assert.equal(recovered.ok,true);assert.equal(snapshots,2);assert.equal(incrementals,0);assert.equal(notifications.at(-1).source,'watcher');assert.deepEqual(projectionCommits,[{source:'projection',projectionRevision:2}])
  partial=true;const incomplete=await refresh.refreshWatchedFolder(f.folder,undefined,true)
  assert.equal(incomplete.ok,false);assert.equal(snapshots,2,'incomplete refresh acknowledged a full projection')
  return { ok:true, coverage:['unchanged','new-and-size-change','metadata-repair','bad-projection-replay','same-count-subfolder-rename','partial-retains-old','malformed-inventory','legacy-stable-unavailable','redirected-result','cancelled-parse','stale-parse-owner','physical-close','source-write-failure','confirmed-commit-then-cancel','rounded-time','concrete-force','nanosecond-decoding','background-shutdown','failed-projection-recovery','incomplete-projection'] }
}

async function checkNativeManualInventory({host,makeManual,fontRoot,files,state}) {
  const sourceFiles=files.filter(file=>fs.existsSync(file))
  const before=new Map(sourceFiles.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))
  const nativeParse=host.indexing.runRustFontParseBatch, jobs=[]
  const shared=host.load('src/main/path/sharedFileSystemRuntime.ts'), execute=shared.executeSharedFile, requests=[]
  shared.executeSharedFile=async (...args)=>{requests.push({operation:args[0].operation,path:args[0].path});return execute(...args)}
  try {
  const manual=makeManual({runRustFontParseBatch:async (...args)=>{jobs.push(...args[0]);return nativeParse(...args)}})
  state.phase='manual-metadata-noop'
  host.observer.reset()
  let result=await manual.applyManualFolderRefreshToIndex(fontRoot,fontRoot)
  assert.equal(result.payload.errors.length,0);assert.equal(result.parsed,0);assert.equal(jobs.length,0,'no-op manual refresh parsed font contents')
  assert.equal(host.observer.bytes.source,0,'no-op manual refresh read font contents through Node')
  assert.equal(result.payload.upserts.length,0)
  assert.equal(requests.filter(row=>row.operation==='treeSnapshot'&&row.path===fontRoot).length,1,'manual no-op did not use one complete native metadata inventory')
  assert(!requests.some(row=>row.operation==='readFile'&&/\.(ttf|otf|ttc|otc)$/i.test(row.path)),'manual no-op requested native font content reads')
  const changed=sourceFiles[0],stat=fs.statSync(changed)
  fs.utimesSync(changed,stat.atimeMs/1000,(stat.mtimeMs+2000)/1000)
  state.phase='manual-metadata-one-change'
  result=await manual.applyManualFolderRefreshToIndex(fontRoot,fontRoot)
  assert.equal(result.payload.errors.length,0);assert.equal(result.parsed,1);assert.equal(jobs.length,1,'manual refresh did not parse only the changed file')
  assert.equal(path.resolve(jobs[0].filePath),path.resolve(changed));assert.equal(jobs[0].requireSourceStability,true)
  for(const [file,digest] of before)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),digest,'manual refresh changed source bytes')
  return { noOpFontContentReads:0, noOpParses:0, noOpNativeInventories:1, changedParses:1, immutableSources:before.size,
    evidence:'Production manual apply + complete native metadata inventory + source-stable native parser; Node byte observation plus native metadata-only command contract' }
  } finally { shared.executeSharedFile=execute }
}
module.exports={checkControlled,checkNativeManualInventory}
if(require.main===module) {
  assert.equal(process.platform,'win32','Execute this regression only on Windows')
  const watchdog=setTimeout(()=>{console.error('[diagnostics:manual-refresh-inventory] controlled suite did not settle');process.exitCode=1;process.exit(1)},30000)
  checkControlled().then(result=>console.log('[diagnostics:manual-refresh-inventory] '+JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>clearTimeout(watchdog))
}
