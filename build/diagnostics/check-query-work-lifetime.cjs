#!/usr/bin/env node
// Deterministic cancellation faults; these are not performance measurements.
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events')
const {loader}=require('./check-operation-chain.cjs')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
async function physicalOwnership(){
 const load=loader(),io=load('src/main/path/sharedFileSystemRuntime.ts'),tasks=load('src/main/library/fontQueryTaskRuntime.ts'),{SharedIoProcessError}=load('src/main/path/sharedIoProcessRuntime.ts')
 for(const keepSecond of [true,false]){
  const complete=deferred(),closed=deferred();let kills=0
  const task=tasks.createFontQueryTask(()=>{io.currentSharedIoSignal().addEventListener('abort',()=>{kills++;const error=new SharedIoProcessError('cancelled','unknown','cancelled');error.closed=closed.promise;complete.reject(error)},{once:true});return complete.promise})
  const a=new AbortController(),b=new AbortController()
  const first=io.withSharedIoSignal(a.signal,()=>tasks.joinFontQueryTask(task)).then(()=>({ok:true}),error=>({error}))
  const second=io.withSharedIoSignal(b.signal,()=>tasks.joinFontQueryTask(task)).then(value=>({value}),error=>({error}))
  a.abort();assert((await first).error);assert.equal(kills,0);assert.equal(task.subscribers,1)
  if(keepSecond){complete.resolve('current');assert.equal((await second).value,'current');assert.equal(kills,0)}
  else{b.abort();assert((await second).error);assert.equal(kills,1);assert.equal(task.settled,false);closed.resolve();await assert.rejects(task.pending);assert.equal(task.settled,true)}
 }
}
async function publicationOwnership(){
 for(const kind of ['page','metrics']){
  const load=loader(),io=load('src/main/path/sharedFileSystemRuntime.ts'),gate=deferred();let reads=0
  const value=kind==='page'?{items:[],total:3,queryKey:'published',offset:0,limit:1,engine:'sql',elapsedMs:0}:{total:3,installedCount:1,notInstalledCount:2}
  const read=()=>{reads++;return gate.promise}
  const owner=kind==='page'?load('src/main/library/fontPageQueryCacheRuntime.ts').createFontPageQueryCacheRuntime({pageCacheMax:5,pageCacheTtlMs:5000,appendStartupLog(){},queryUncached:read}):load('src/main/library/fontMetricsRequestCoalescerRuntime.ts').createFontMetricsRequestCoalescerRuntime(5000)
  const request=()=>kind==='page'?owner.queryFontPageInLibrary({limit:1}):owner.run({key:'published',load:read,appendLog(){}})
  const a=new AbortController(),b=new AbortController()
  const first=io.withSharedIoSignal(a.signal,request).then(()=>({ok:true}),error=>({error}))
  const second=io.withSharedIoSignal(b.signal,request)
  const atSettlement=gate.promise.then(request)
  a.abort();assert((await first).error);assert.equal(reads,1)
  gate.resolve(value)
  for(const result of await Promise.all([second,atSettlement]))assert.equal(result.total,3)
  assert.equal((await request()).total,3)
  assert.equal(reads,1,kind+': creator cancellation or settlement gap lost the physical result cache')
 }
}
async function ipcOwnership(){
 const handlers=new Map(),sender=Object.assign(new EventEmitter(),{id:17,getURL:()=> 'http://localhost:39217/',isDestroyed:()=>false})
 const electron={app:{isPackaged:false},ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn)}}
 const load=loader({electron}),io=load('src/main/path/sharedFileSystemRuntime.ts')
 let availability=async()=>({roots:[],tags:[],unattributedTags:[]}),read=async request=>request.name
 const reads=[]
 const runtime=new Proxy({getSharedAvailability:()=>availability(),appendLog(){},assertFeatureForChannel(){},reportPerformanceEvent(){},queryFontPageInLibrary:async request=>{reads.push(request.name);return read(request)},getFontMetricsFromLibrary:()=>read({name:'metrics'})},{get:(value,key)=>value[key]||(()=>undefined)})
 load('src/main/ipc/ipcHandlers.ts').registerIpcHandlers(runtime)
 const invoke=(name,...args)=>handlers.get(name)({sender},...args)
 const gate=deferred(),entered=deferred();let admissions=0
 availability=()=>{if(++admissions===1){entered.resolve();return gate.promise}return Promise.resolve({roots:[],tags:[],unattributedTags:[]})}
 const old=invoke('fonts:queryPage',{name:'A'},'A').then(()=>({ok:true}),error=>({error}))
 await entered.promise;await invoke('fonts:cancelQuery','A')
 assert.equal(await invoke('fonts:queryPage',{name:'B'},'B'),'B')
 gate.resolve({roots:[],tags:[],unattributedTags:[]});assert.match(String((await old).error),/替换|关闭/);assert.deepEqual(reads,['B'])
 availability=async()=>({roots:[],tags:[],unattributedTags:[]})
 for(const event of ['destroyed','render-process-gone','did-start-navigation']){
  const started=deferred();let signal
  read=()=>new Promise((resolve,reject)=>{signal=io.currentSharedIoSignal();signal.addEventListener('abort',()=>reject(Error('consumer aborted')),{once:true});started.resolve()})
  const pending=invoke('fonts:queryPage',{name:event},event).then(()=>({ok:true}),error=>({error}))
  await started.promise
  sender.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false});sender.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});assert.equal(signal.aborted,false)
  await invoke('fonts:cancelQuery','A');assert.equal(signal.aborted,false,'old token cancelled new reader')
  sender.emit(event,{isMainFrame:true,isSameDocument:false});assert((await pending).error);assert.equal(signal.aborted,true)
  for(const name of ['destroyed','render-process-gone','did-start-navigation'])assert.equal(sender.listenerCount(name),0,'sender listener leaked')
 }
}
async function cacheCancellation(){
 const load=loader(),io=load('src/main/path/sharedFileSystemRuntime.ts'),{createFontPageQueryCacheRuntime}=load('src/main/library/fontPageQueryCacheRuntime.ts')
 const closed=deferred(),started=deferred();let calls=0
 const cache=createFontPageQueryCacheRuntime({pageCacheMax:5,pageCacheTtlMs:5000,appendStartupLog(){},queryUncached:async()=>{calls++;if(calls===1){started.resolve();return new Promise((_,reject)=>io.currentSharedIoSignal().addEventListener('abort',()=>{const error=Error('stopped');error.closed=closed.promise;reject(error)},{once:true}))}return {queryKey:'current',items:[],total:0,offset:0,limit:1,engine:'sql',truncated:false,elapsedMs:0}}})
 const a=new AbortController(),b=new AbortController()
 const first=io.withSharedIoSignal(a.signal,()=>cache.queryFontPageInLibrary({limit:1})).then(()=>({ok:true}),error=>({error}))
 await started.promise;a.abort();assert((await first).error)
 const next=io.withSharedIoSignal(b.signal,()=>cache.queryFontPageInLibrary({limit:1}))
 await tick();assert.equal(calls,1,'new physical reader bypassed old close owner')
 closed.resolve();assert.equal((await next).queryKey,'current');assert.equal(calls,2,'obsolete subscriber restarted work')
}
async function tagCancellation(){
 const {DatabaseSync}=require('node:sqlite'),raw=new DatabaseSync(':memory:')
 raw.exec('CREATE TABLE local_font_tags(font_id TEXT,font_path TEXT,tag_name TEXT)')
 const db={exec:s=>raw.exec(s),prepare:s=>raw.prepare(s),transaction:fn=>()=>{raw.exec('BEGIN');try{const v=fn();raw.exec('COMMIT');return v}catch(e){raw.exec('ROLLBACK');throw e}}}
 const load=loader({fontkit:require('fontkit')}),io=load('src/main/path/sharedFileSystemRuntime.ts')
 load('src/main/path/pathCanonicalizer.ts').mappedDriveTableAsync=async()=>new Map()
 const started=deferred(),closed=deferred();let calls=0
 const tags=load('src/main/library/tagFontQueryRuntime.ts').createTagFontQueryRuntime({openLibraryDb:async()=>db,roots:async()=>[],readShared:async()=>{throw Error('unexpected shared tag port')},hydrate:async items=>items,matches:()=>true,compare:()=>0,
  queryLive:async()=>{calls++;if(calls===1){started.resolve();return new Promise((_,reject)=>io.currentSharedIoSignal().addEventListener('abort',()=>{const error=Error('tag read cancelled');error.closed=closed.promise;reject(error)},{once:true}))}return {items:[],total:0,offset:0,limit:500,queryKey:'tag-current',engine:'sql',elapsedMs:0,truncated:false}}})
 const pages=load('src/main/library/fontPageQueryCacheRuntime.ts').createFontPageQueryCacheRuntime({pageCacheMax:5,pageCacheTtlMs:5000,appendStartupLog(){},queryUncached:(request,limit,offset)=>tags.query(request,limit,offset)})
 const a=new AbortController(),b=new AbortController(),request={sidebarPage:'tags',selectedTagName:'Tag',limit:1}
 const first=io.withSharedIoSignal(a.signal,()=>pages.queryFontPageInLibrary(request)).then(()=>({ok:true}),error=>({error}))
 try{
  await started.promise;a.abort();assert((await first).error)
  const second=io.withSharedIoSignal(b.signal,()=>pages.queryFontPageInLibrary(request))
  await tick();assert.equal(calls,1,'tag read slot was reused before physical close')
  closed.resolve();assert.equal((await second).total,0);assert.equal(calls,2,'new tag view failed to replace retired read exactly once')
 }finally{load('src/main/library/tagFontSnapshotRuntime.ts').disposeTagFontSnapshots(db);raw.close()}
}
async function sharedAuthorityLifetime(){
 const load=loader(),io=load('src/main/path/sharedFileSystemRuntime.ts'),tasks=load('src/main/library/fontQueryTaskRuntime.ts')
 const started=deferred(),finish=deferred();let usable=false,sourceReads=0
 const ctx={staleFirstPageEnabled:true,backgroundValidateIntervalMs:60000,mergedIndexRootsKey:JSON.stringify,mergedIndexLastValidateAt:new Map(),mergedIndexValidateInFlight:new Map(),mergedIndexSourcesKey:JSON.stringify,openMergedIndexDb:async()=>({}),closeSqliteDb(){},appendStartupLog(){},mergedIndexLocalSnapshotUsable:()=>usable}
 const source={mergedIndexSourcesForRoots:async()=>{sourceReads++;assert.equal(io.currentSharedIoSignal(),undefined,'shared validation inherited first consumer cancellation');started.resolve();await finish.promise;return [{root:'C:/fixture'}]}}
 const build={ensureMergedIndexBuilt:async()=>{assert.equal(io.currentSharedIoSignal(),undefined);usable=true}}
 const validation=load('src/main/indexing/merged-page/mergedIndexValidationRuntime.ts').createMergedIndexValidationRuntime(ctx,source,build)
 const ready=load('src/main/indexing/merged-page/mergedIndexPageQueryRuntime.ts').createMergedIndexPageQueryRuntime(ctx,source,build,validation.scheduleMergedIndexBackgroundValidation)
 const pages=load('src/main/library/fontPageQueryCacheRuntime.ts').createFontPageQueryCacheRuntime({pageCacheMax:3,pageCacheTtlMs:1000,appendStartupLog(){},queryUncached:async()=>{assert.equal(await ready.ensureMergedIndexReadyForWorker(['C:/fixture']),true);tasks.assertFontQueryActive();return {items:[],total:0,queryKey:'ready',offset:0,limit:1,engine:'sql',elapsedMs:0}}})
 const controller=new AbortController(),old=io.withSharedIoSignal(controller.signal,()=>pages.queryFontPageInLibrary({limit:1})).then(()=>({ok:true}),error=>({error}))
 await started.promise;controller.abort();assert((await old).error)
 const next=pages.queryFontPageInLibrary({limit:1}),metricsReady=ready.ensureMergedIndexReadyForWorker(['C:/fixture'])
 finish.resolve();assert.equal((await next).queryKey,'ready');assert.equal(await metricsReady,true);assert.equal(sourceReads,1,'cancelled first view restarted shared authority work')
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{DatabaseSync}=require('node:sqlite'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-init-owner-'))
 const prepared=deferred(),release=deferred();let opens=0
 const db=load('src/main/library/runtime/libraryDbConnectionRuntime.ts').createLibraryDbConnectionRuntime({librarySqlitePath:()=>path.join(dir,'app.sqlite'),openRecoverableApplicationSqliteDb:async file=>{opens++;const db=new DatabaseSync(file);db.transaction=fn=>()=>{db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}};return db},closeSqliteDb:db=>db?.close(),prepareLocalFontIdentity:async()=>{assert.equal(io.currentSharedIoSignal(),undefined,'DB preparation inherited transient view signal');prepared.resolve();await release.promise}})
 const caller=new AbortController(),first=io.withSharedIoSignal(caller.signal,()=>db.openLibraryDb())
 try{await prepared.promise;caller.abort();const second=db.openLibraryDb();release.resolve();assert.equal(await first,await second);assert.equal(opens,1)}finally{db.closeLibraryDb();fs.rmSync(dir,{recursive:true,force:true})}
}
async function main(){await physicalOwnership();await publicationOwnership();await ipcOwnership();await cacheCancellation();await tagCancellation();await sharedAuthorityLifetime();console.log('[diagnostics:query-work-lifetime] physical subscribers, admission cancellation, renderer lifecycle and close ownership passed')}
let completed=false
process.once('beforeExit',()=>{if(!completed){console.error('Query lifetime diagnostic did not complete');process.exitCode=1}})
main().then(()=>{completed=true}).catch(error=>{console.error(error);process.exitCode=1})
