#!/usr/bin/env node
const assert = require('node:assert/strict');
const { loader } = require('./check-operation-chain.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<70;i++) await Promise.resolve(); };
async function storage() {
 let calls=[], gate, fail=false, generation=1, online=true, closing=false, epoch=1;
 const rootState=()=>({rootId:'//nas/fonts',generation,state:online?'online':'offline'});
 const fs={mkdir:async p=>{calls.push(p);if(p==='/shared/images'&&gate)await gate.promise;if(fail&&p.startsWith('/shared'))throw Error('denied');}};
 const load=loader({
  '../../path/sharedFileSystemRuntime':{sharedFileSystem:fs},
  '../../path/startupPathAvailabilityRuntime':{getStartupPathRootState:rootState},
  '../../app/shutdownCoordinatorRuntime':{applicationWorkEpoch:()=>epoch,isApplicationClosing:()=>closing},
  '../../path/fontPathPolicy':{findBestWatchedRootForFile:()=>'/watched'},
 });
 const runtime=load('src/main/preview/runtime/previewStorageRoutingRuntime.ts').createPreviewStorageRoutingRuntime({
  loadLibraryShell:async()=>({folders:[]}),cacheKeyForRootFile:()=> 'identity',cacheKeyForPath:()=> 'path',
  rootPreviewCacheDir:()=>'/shared',rootPreviewImageDir:()=>'/shared/images',rootPreviewDbPath:()=>'/shared/db/index.sqlite',localPreviewImageDir:()=>'/local',
  hideDirectoryOnWindows:async()=>calls.push('hide'),writeRootPreviewCacheManifest:async()=>calls.push('manifest'),appendStartupLog(){},
 },{rootAvailability:{ensureRootPreviewCacheAvailable:async()=>online,markRootPreviewCacheUnavailable:()=>{online=false}},tierRuntime:{localPreviewDirForRoot:()=>'/local',localStorageForRoot:()=>({storage:'local',dir:'/local'}),localStorageForPath:()=>({storage:'local',dir:'/local'})},runRequiredRootPreviewCacheIo:(_r,_l,f)=>f()});
 gate=deferred();const first=runtime.ensureSharedPreviewCachePrepared('/watched');const duplicate=runtime.ensureSharedPreviewCachePrepared('//nas/fonts');await flush();
 for(let i=0;i<24;i++)assert.equal((await runtime.previewCacheStorageForFont('/watched/a.ttf')).storage,'local');
 assert.equal(calls.filter(x=>x.startsWith('/shared')).length,1,'hot local reads waited for or repeated shared preparation');
 gate.resolve();assert.equal(await first,true);assert.equal(await duplicate,true);assert.deepEqual(calls.filter(x=>x!='/local'),['/shared/images','/shared/db','hide','manifest']);
 // No permanent ready flag: next publication recreates directories, even if removed between calls.
 calls=[];gate=null;assert.equal(await runtime.ensureSharedPreviewCachePrepared('/watched'),true);assert.equal(calls.at(-1),'manifest');
 calls=[];gate=deferred();const stale=runtime.ensureSharedPreviewCachePrepared('/watched');await flush();generation++;gate.resolve();assert.equal(await stale,false);assert(!calls.includes('manifest'));
 gate=null;assert.equal(await runtime.ensureSharedPreviewCachePrepared('/watched'),true);
 calls=[];fail=true;assert.equal(await runtime.ensureSharedPreviewCachePrepared('/watched'),false);assert(!calls.includes('manifest'));assert.equal(online,false);
 assert.equal((await runtime.previewCacheStorageForFont('/watched/a.ttf')).storage,'local');
 fail=false;online=true;generation++;assert.equal(await runtime.ensureSharedPreviewCachePrepared('/watched'),true);
 calls=[];closing=true;assert.equal(await runtime.ensureSharedPreviewCachePrepared('/watched'),false);assert.equal(calls.length,0);
 closing=false;gate=deferred();const invalidated=runtime.ensureSharedPreviewCachePrepared('/watched');await flush();runtime.invalidateLibraryShellCache();gate.resolve();assert.equal(await invalidated,false);
 console.log('storage: 24 local routes add zero shared preparation operations; concurrent aliases share 4 preparation operations; deletion/failure/generation/invalidation/closing covered');
}
async function queue(mode) {
 const timers=new Map();let next=0;const window={setTimeout:(f,ms)=>{timers.set(++next,{f,ms});return next},clearTimeout:id=>timers.delete(id)};
 const cache=deferred(), rendered=[], applied=[];let cacheCalls=0, singleCacheCalls=0;
 const ref=current=>({current});
 const opt={previewText:'text',listPreviewFontSize:44,previewRequestTokenRef:ref('text::44'),selectedFontId:'',selectedFontIds:[],previewFamilies:{},nativePreviewImages:{},failedPreviewFontIds:{},loadingFonts:ref(new Set()),queuedPreviewFontIds:ref(new Set()),previewQueue:ref([]),activePreviewLoads:ref(0),fontListScrollingRef:ref(false),isBadFontRecord:()=>false,rendererUserActive:()=>false,
  setPreviewFamilies(fn){this.previewFamilies=fn(this.previewFamilies)},setNativePreviewImages(fn){this.nativePreviewImages=typeof fn === 'function' ? fn(this.nativePreviewImages) : fn;applied.push({...this.nativePreviewImages})},setFailedPreviewFontIds(){},setNativeDetailImage(){},updateFont(){},autoPreviewCacheQueue:ref([]),queuedAutoPreviewCacheIds:ref(new Set()),activeAutoPreviewCacheLoads:ref(0),autoPreviewCacheStats:ref({}),
  hfm:{getCachedPreviewImages:()=>{cacheCalls++;return cache.promise},getCachedPreviewImage:async()=>{singleCacheCalls++;return ''},renderPreviewImage:async f=>{rendered.push(f.id);return 'data:image/png;base64,native-'+f.id}}
 };
 const load=loader({
  '../../../appRuntime':{PREVIEW_STATE_LRU_LIMIT:800,pruneRecordByKeyLimit:x=>x,requestIdleWindow:f=>window.setTimeout(f,0),rendererMemoryPressure:()=> 'normal',INDEXING_PREVIEW_LOADS:1,SCROLLING_PREVIEW_LOADS:1,MAX_CONCURRENT_PREVIEW_LOADS:4},
  '../../../rendererPerformance':{reportRendererTrace(){}},
  './fontPreviewIndexCooldownRuntime':{previewQueueCooldownRemaining:()=>0},
  './fontPreviewRouteRuntime':{resolveFontPreviewRoute:()=>({shouldSkipWebFontFileLoad:true})},
  './fontPreviewQuickFallbackRuntime':{},
 },{window});
 load('src/renderer/src/runtime/preview/previewAvailabilitySnapshotRuntime.ts').rememberPreviewAvailability({roots:[{path:'C:/fonts',rootId:'c:/fonts',generation:1,state:'online',resourceKeys:[],tags:[]}],tags:[],unattributedTags:[]});
 const loads=load('src/renderer/src/runtime/preview/queue/fontPreviewLoadRuntime.ts').createFontPreviewLoadRuntime(opt);
 const state=load('src/renderer/src/runtime/preview/queue/fontPreviewStateRuntime.ts').createFontPreviewStateRuntime(opt);
 const q=load('src/renderer/src/runtime/preview/queue/fontVisiblePreviewQueueRuntime.ts').createFontVisiblePreviewQueueRuntime(opt,state,loads);
 const fonts=Array.from({length:8},(_,i)=>({id:'f'+i,path:'C:/fonts/'+i+'.ttf',systemInstalled:true}));
 for(const f of fonts){q.requestPreviewFont(f,'high');q.requestPreviewFont(f,'high');}
 assert.equal(cacheCalls,1);assert.equal(rendered.length,0);
 if(mode==='hit'){cache.resolve({f0:'data:image/png;base64,cache'});await flush();assert.equal(opt.nativePreviewImages.f0,'data:image/png;base64,cache');assert(!rendered.includes('f0'));}
 else {
  if(mode==='reject')cache.reject(Error('cache failed'));
  else if(mode==='reset'){
   q.resetVisiblePreviewQueue();loads.resetPreviewLoads();state.resetPreviewRuntimeState();opt.previewText='new';opt.previewRequestTokenRef.current='new::44';
   for(const f of fonts)q.requestPreviewFont(f,'high');
  } else {const timer=[...timers].find(([,t])=>t.ms===120);assert(timer);timers.delete(timer[0]);timer[1].f();}
  await flush();assert(rendered.includes('f7'),'other visible fonts stalled behind unresolved cache');assert.equal(new Set(rendered).size,8);assert.equal(rendered.length,8,'duplicate fallback');assert.equal(singleCacheCalls,0,'fallback re-entered slow cache');
  if(mode!=='reject'){assert.equal(cacheCalls,1,'reset/timeout freed physical cache slot');cache.resolve({f0:'data:image/png;base64,obsolete'});await flush();assert(!applied.some(x=>x.f0?.endsWith('obsolete')),'late cache overwrote native winner');}
 }
 q.disposePreviewQueue();assert(![...timers.values()].some(t=>t.ms===120),'cache wait timer leaked');
 console.log('queue:',mode,'bounded wait, no duplicate single reads/native work, late-result guard and timer cleanup');
}
async function availability() {
 let generation=1, probes=0, online=true;
 const load=loader({'../../path/startupPathAvailabilityRuntime':{getStartupPathRootState:()=>({rootId:'root',generation,state:online?'online':'offline'}),ensureStartupPathRootAvailable:async()=>{probes++;return online}},'../../path/ioDeadlineRuntime':{unavailableRootTtlMs:()=>30000}});
 const owner=load('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts').createPreviewCacheRootAvailabilityRuntime();
 assert.equal(await owner.ensureRootPreviewCacheAvailable('/root'),true);
 assert.equal(await owner.ensureRootPreviewCacheAvailable('/root'),true);assert.equal(probes,1);
 generation++;assert.equal(await owner.ensureRootPreviewCacheAvailable('/root'),true);assert.equal(probes,2,'cached success ignored root generation');
 online=false;generation++;assert.equal(await owner.ensureRootPreviewCacheAvailable('/root'),false);
}
async function publication() {
 let ready=false, calls=[], timer;
 const fs={mkdir:async()=>calls.push('mkdir'),open:async()=>{calls.push('lock');return{writeFile:async()=>{},close:async()=>{}}},access:async()=>{throw Error('missing')},copyFile:async()=>calls.push('copy'),rename:async()=>calls.push('rename'),unlink:async()=>{}};
 const load=loader({'../../path/sharedFileSystemRuntime':{sharedFileSystem:fs}},{setTimeout:f=>{timer=f;return 1}});
 const publish=load('src/main/preview/runtime/previewCachePublishRuntime.ts').createPreviewCachePublishRuntime({appendStartupLog(){},ensureSharedAvailable:async()=>{calls.push('prepare');return ready},previewCacheStorageToShared:s=>s,withIoDeadlineResult:async(_l,f)=>({ok:true,value:await f()}),writeSharedPreviewCacheMeta:async()=>{calls.push('meta')},validateSharedPreviewCacheMeta:async()=>({status:'valid'}),appendSharedPreviewCacheManifest:async()=>{calls.push('manifest')},writePreviewCacheIndex:async()=>{calls.push('index')}});
 const storage={rootPath:'/root',dir:'/shared',storage:'root'}, row={previewKey:'a',localOutputPath:'/local/a.png'};
 publish.enqueuePreviewCachePublish(storage,row);timer();await flush();assert.deepEqual(calls,['prepare'],'failed preparation still wrote shared files');
 ready=true;calls=[];publish.enqueuePreviewCachePublish(storage,row);timer();await flush();assert.deepEqual(calls,['prepare','mkdir','lock','copy','rename','meta','manifest','index']);
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../../src/main/preview/runtime/previewCacheStorageRuntime.ts'),'utf8');assert(/ensureSharedPreviewCacheAvailable:\s*ensureSharedPreviewCachePrepared/.test(source),'publisher bypassed preparation owner');
 console.log('publication: failed preparation writes nothing; successful publication keeps lock/copy/rename/meta/manifest/index order');
}
async function classification() {
 let mapping = new Map([['Z:', '\\\\nas\\share']]);
 const paths = ['Z:/fonts', '//nas/share/fonts', 'C:/fonts'];
 const load = loader({
  '../path/pathCanonicalizer': {mappedDriveTableAsync:async()=>mapping,normalizeNativePathText:p=>p.replaceAll('/', '\\')},
  '../path/sharedIoProcessRuntime': {SharedIoProcessError:class extends Error{}},
  './startupPathAvailabilityRuntime': {ensureStartupPathRootAvailable:async()=>true,getStartupPathRootState:p=>({rootId:p,state:'online',generation:1})},
  '../library/runtime/sharedRootCatalogRuntime': {readSharedRootCatalog:()=>({roots:[],unattributedTags:[]}),sharedCatalogRootId:p=>p},
 },{process:{...process,platform:'win32',env:{SystemDrive:'C:'}}});
 const read=load('src/main/path/sharedAvailabilityRuntime.ts').createSharedAvailabilityReader(async()=>({prepare:sql=>({all:()=>sql.includes('FROM folders')?paths.map(path=>({path})):[]})}));
 const snapshot=await read();
 assert.deepEqual(Array.from(snapshot.roots[0].resourceKeys),Array.from(snapshot.roots[1].resourceKeys));
 assert.equal(snapshot.roots[0].resourceKeys.length,1);assert.equal(snapshot.roots[2].resourceKeys.length,0);
 mapping=null;const unknown=await read();assert.equal(unknown.roots[0].resourceKeys,undefined);
 assert(load('src/shared/sharedAvailability.ts').isSharedAvailability(unknown));
 console.log('classification: actual main resource owner gives mapped/UNC same key; failed drive discovery stays unknown');
}
async function network() {
 let now=100;class Clock extends Date{static now(){return now}}
 const load=loader({}, {Date:Clock});
 const snapshot=load('src/renderer/src/runtime/preview/previewAvailabilitySnapshotRuntime.ts');
 const policy=load('src/renderer/src/runtime/preview/queue/fontPreviewNetworkPathRuntime.ts');
 const limit=path=>policy.networkAwarePreviewLimit([{path}],4);
 assert.equal(limit('C:/fonts/a.ttf'),1);
 snapshot.rememberPreviewAvailability({roots:[{path:'Z:/fonts',rootId:'//nas/share/fonts',state:'online',generation:1,tags:[],resourceKeys:['\\\\nas\\share']},{path:'C:/fonts',rootId:'c:/fonts',state:'online',generation:1,tags:[],resourceKeys:[]}],tags:[],unattributedTags:[]});
 assert.equal(limit('Z:/fonts/a.ttf'),1);assert.equal(limit('//nas/share/fonts/a.ttf'),1);assert.equal(limit('C:/fonts/a.ttf'),4);assert.equal(limit('X:/unknown.ttf'),1);
 now+=6001;assert.equal(limit('C:/fonts/a.ttf'),1);
 console.log('network: main-classified local only; mapped/UNC aliases and unknown/stale snapshots conservative');
}
(async()=>{await storage();for(const mode of ['held','reject','hit','reset'])await queue(mode);await network();await classification();await availability();await publication();})().catch(e=>{console.error(e);process.exitCode=1});
