'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const {DatabaseSync} = require('node:sqlite')
const {loader} = require('./check-operation-chain.cjs')
const {loadModules, font, plain} = require('./check-activation-entry.cjs')
const root = path.resolve(__dirname,'../..')
const virtualMetadataRoot = (name) => path.resolve(root, '.diagnostic-virtual', name)
let cases=0
async function metadata(transform=x=>x) {
  const file='src/main/library/sharedFontMetadataMutations.ts'
  const load=loader({}, {}, {[path.join(root,file)]:transform})
  const {createSharedMetadataMergedIndexSyncRuntime}=load('src/main/library/sharedMetadataMergedIndexSyncRuntime.ts')
  const {createSharedFontMetadataMutations}=load(file)
  const db=new DatabaseSync(':memory:')
  db.exec('CREATE TABLE font_metadata(font_id TEXT PRIMARY KEY,relative_path TEXT, tag_names_json TEXT)')
  const insert=db.prepare('INSERT INTO font_metadata VALUES(?,?,?)')
  for(let i=0;i<1499;i++)insert.run('f'+i,'f'+i+'.ttf','["old"]')
  let writes=0, rows=0, snapshots=0, notifications=0, failRead=false, failSync=false, catalogFail=false, catalog=[]
  const logs=[]
  const sync=createSharedMetadataMergedIndexSyncRuntime({
    uniqueResolvedFolders:x=>x,normalizePathForCacheCompare:x=>x,appendLog:x=>logs.push(x),
    openMetadataDb:async()=>{if(failRead)throw Error('offline');return db},closeMetadataDb(){},
    syncMergedIndexForRootIncremental:async(_root,p)=>{if(failSync)throw Error('sync-failed');rows+=p.upserts.length},
    syncMergedIndexForRootSnapshot:async()=>{snapshots++;rows+=1499},sendFontIndexChanged:()=>notifications++
  })
  const write=async ids=>{writes+=ids.length;return {updatedIds:ids,failed:[]}}
  const mutation=createSharedFontMetadataMutations({uniqueResolvedFolders:x=>x,appendLog:x=>logs.push(x),...sync,
    updateSharedFontMetadataEntries:async o=>write(o.items.map(x=>x.id)),
    removeSharedTagFromMetadataIndexes:async()=>write(['f1','f2','f3']),
    renameSharedTagInMetadataIndexes:async()=>write(['f1','f2','f3']),
    invalidateSharedFontRuntimeCaches(){},refreshKnownSharedTagsFromMetadata:async()=>{if(catalogFail)throw Error('catalog offline');return catalog}
  })
  const fontsRoot=virtualMetadataRoot('fonts')
  const a={id:'f1',path:path.join(fontsRoot,'f1.ttf')},b={id:'f2',path:path.join(fontsRoot,'f2.ttf')}
  assert.equal(path.isAbsolute(fontsRoot),true,'metadata fixture root must be platform-native absolute')
  await mutation.setSharedFontTagsInIndex([a],[fontsRoot],['new'])
  assert.equal(rows,1,'one committed shared tag must sync one of 1499 rows')
  assert.equal(snapshots,0);assert.equal(writes,1);assert.equal(notifications,0);cases++
  rows=0
  await mutation.setSharedFontTagsBatchInIndex([{item:a,tagNames:['new']},{item:b,tagNames:[]}],[fontsRoot])
  assert.equal(rows,2);cases++
  rows=0
  const deleted=await mutation.deleteSharedFontTagInIndex('old',[fontsRoot])
  assert.equal(rows,3,'catalog delete must cover all actual bindings');assert.deepEqual(plain(deleted.mutationProtocol.knownTags),[]);cases++
  rows=0
  catalog=['new']
  await mutation.renameSharedFontTagInIndex('old','new',[fontsRoot])
  assert.equal(rows,3);cases++
  rows=0
  await mutation.setFontDeleteProtectionInIndex([a],[fontsRoot],true)
  assert.equal(rows,1);assert.equal(notifications,1);cases++
  failRead=true;rows=0
  await mutation.setSharedFontTagsInIndex([a],[fontsRoot],[])
  assert.equal(snapshots,1);assert(logs.some(x=>x.includes('unknown')||x.includes('offline')));cases++
  failRead=false;failSync=true
  await mutation.setSharedFontTagsInIndex([a],[fontsRoot],[])
  assert.equal(snapshots,2,'failed incremental must recover with explicit reason');cases++
  failSync=false;catalogFail=true
  const before=writes
  const result=await mutation.deleteSharedFontTagInIndex('new',[fontsRoot])
  assert.equal(writes-before,3,'catalog read failure must not replay committed write')
  assert.equal(result.ok,true);assert.equal(result.mutationProtocol,undefined)
  assert(logs.some(x=>x.includes('do not retry committed write')));cases++
  db.close()
}
async function queueScopes() {
  const load=loader(), fields=[], writes=[]
  const queue=load('src/renderer/src/fontWriteQueue.ts').createEmptyQueuedFontWriteState()
  const item={id:'a',path:'/fonts/a.ttf'}
  queue.favorite.set('a',{font:item,favorite:true})
  queue.localTags.set('a',{item,tagNames:['local']})
  queue.sharedTags.set('a',{item,tagNames:['shared']})
  queue.protection.set('a',{font:item,protect:true})
  const done=kind=>async()=>{writes.push(kind);return{ok:true,updatedIds:['a'],failed:[]}}
  const runtime=load('src/renderer/src/fontWriteQueueRuntime.ts').createRendererFontWriteQueueRuntime({
    queueRef:{current:queue},timerRef:{current:null},retryTimerRef:{current:null},retryAttemptRef:{current:0},activeRef:{current:false},activePromiseRef:{current:null},
    hfm:{setFavorite:done('favorite'),setLocalTagsBatch:done('localTags'),setSharedTagsBatch:done('sharedTags'),setDeleteProtection:done('protection')},
    getFolders:()=>['/fonts'],setTimeout:fn=>{fn();return 1},clearTimeout(){},setStatus(){},scheduleDatabaseDerivedStateRefresh:(_delay,value)=>fields.push(value)
  })
  assert.equal(await runtime.flush('scope-check'),true)
  assert.deepEqual(writes,['localTags','sharedTags','favorite','protection'])
  assert.deepEqual(plain(fields),[['favorite','localTags','sharedTags','protection']]);cases++
}
async function multipleRoots() {
  const load=loader()
  const fontsRoot=virtualMetadataRoot('fonts'),otherRoot=virtualMetadataRoot('other')
  const databases=new Map([fontsRoot,otherRoot].map(r=>{const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE font_metadata(font_id TEXT PRIMARY KEY,relative_path TEXT)');return[r,db]}))
  databases.get(fontsRoot).prepare('INSERT INTO font_metadata VALUES(?,?)').run('a','a.ttf')
  databases.get(otherRoot).prepare('INSERT INTO font_metadata VALUES(?,?)').run('b','b.ttf')
  const synced=[],fallback=[],logs=[]
  const runtime=load('src/main/library/sharedMetadataMergedIndexSyncRuntime.ts').createSharedMetadataMergedIndexSyncRuntime({
    uniqueResolvedFolders:x=>x,normalizePathForCacheCompare:x=>x,appendLog:x=>logs.push(x),openMetadataDb:async r=>databases.get(r),closeMetadataDb(){},
    syncMergedIndexForRootIncremental:async(r,p)=>synced.push([r,p.upserts.map(f=>f.id)]),syncMergedIndexForRootSnapshot:async r=>fallback.push(r)
  })
  await runtime.syncSharedMetadataChangedIdsToMergedIndex(['a','b','a'],[fontsRoot,otherRoot],'shared-tags-batch-authority-refresh')
  assert.deepEqual(plain(synced),[[fontsRoot,['a']],[otherRoot,['b']]]);assert.equal(fallback.length,0);cases++
  await runtime.syncSharedMetadataChangedIdsToMergedIndex([],[fontsRoot,otherRoot],'shared-tag-delete:empty')
  assert.equal(synced.length,2);cases++
  await runtime.syncSharedMetadataChangedIdsToMergedIndex(['missing'],[fontsRoot,otherRoot],'shared-tag-delete:unknown')
  assert.equal(fallback.length,2);assert(logs.some(x=>x.includes('changed-id-locator-incomplete')));cases++
  databases.get(fontsRoot).prepare('UPDATE font_metadata SET relative_path=?').run('../outside.ttf')
  await runtime.syncSharedMetadataChangedIdsToMergedIndex(['a'],[fontsRoot],'shared-tags-set-authority-refresh')
  assert.equal(fallback.length,3);assert(logs.some(x=>x.includes('changed-id-path-outside-root')));cases++
  for(const db of databases.values())db.close()
}
function renderer() {
  const effects=[],timers=new Map();let cursor=0,slots=[],timerId=0,library,tagListener,indexListener
  const hooks={useState:init=>{const i=cursor++;if(!(i in slots))slots[i]=typeof init==='function'?init():init;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v]},useRef:init=>{const i=cursor++;if(!(i in slots))slots[i]={current:init};return slots[i]},useMemo:fn=>fn(),useEffect:fn=>effects.push(fn)}
  const window={setTimeout:fn=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id)}
  const load=loadModules({window},{react:hooks,
    [path.join(root,'src/renderer/src/runtime/app/effects/useLibraryAutosaveRuntime.ts')]:{libraryShellPersistenceKey:()=>'',useLibraryAutosaveRuntime:o=>({getCurrentLibrary:()=>library,commitLibraryUpdate:n=>library=typeof n==='function'?n(library):n,setLibrary:o.setLibrary,saveLibraryImmediately:async()=>true})},
    [path.join(root,'src/renderer/src/runtime/app/effects/useInitialLibraryShellRuntime.ts')]:{useInitialLibraryShellRuntime(){}},
    [path.join(root,'src/renderer/src/runtime/app/effects/useSharedMetadataSyncForegroundRuntime.ts')]:{useSharedMetadataSyncForegroundRuntime(){}},
    [path.join(root,'src/renderer/src/appRuntime.ts')]:{createEmptyLibrary:()=>({fonts:{},folders:[],tags:[],localTags:[]}),requestIdleWindow:fn=>fn(),normalizeFontMetricsResult:x=>x,
      applyFontIndexChangeToLibrary:(...args)=>load('src/renderer/src/library-normalize/libraryIndexChangeRuntime.ts').applyFontIndexChangeToLibrary(...args)}
  })
  const useLibrary=load('src/renderer/src/runtime/app/useLibraryController.ts').useLibraryController
  let clears=0
  const closingLifecycle={isClosing:()=>false,beginClosing(){},resume(){},subscribe:()=>()=>{}}
  const args={hfm:{},activeFilterKind:'all',database:{setDatabasePageResult:()=>clears++,setDatabaseQueryResult:()=>clears++,setDatabaseFontMetrics(){},databasePageRequestSeqRef:{current:0},fontMetricsRequestSeqRef:{current:0}},rendererUserActive:()=>false,appendDeveloperStatus(){},closingLifecycle}
  function render(){cursor=0;return useLibrary(args)}
  function drain(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn())}
  let ctl=render()
  ctl.scheduleDatabaseDerivedStateRefresh(0,['favorite']);drain();ctl=render()
  assert.equal(ctl.databaseRefreshToken,0);assert.equal(ctl.databaseMetricsRefreshToken,1);assert.equal(clears,0);cases++
  ctl.scheduleDatabaseDerivedStateRefresh(0,['protection']);drain();ctl=render()
  assert.equal(ctl.databaseRefreshToken,0);assert.equal(ctl.databaseMetricsRefreshToken,1);cases++
  args.activeFilterKind='favorites';ctl=render()
  ctl.scheduleDatabaseDerivedStateRefresh(0,['favorite']);drain();ctl=render()
  assert.equal(ctl.databaseRefreshToken,1);assert.equal(ctl.databaseMetricsRefreshToken,2);cases++
  args.activeFilterKind='all';ctl=render()
  ctl.scheduleDatabaseDerivedStateRefresh(80,['sharedTags']);ctl.scheduleDatabaseDerivedStateRefresh(80,['localTags']);ctl.scheduleDatabaseDerivedStateRefresh(0,['activation']);drain();ctl=render()
  assert.equal(ctl.databaseRefreshToken,2);assert.equal(ctl.databaseMetricsRefreshToken,3);assert.equal(clears,0);cases++
  ctl.refreshDatabaseDerivedState();ctl=render()
  assert.equal(clears,0,'same-scope refresh retains last page');assert.equal(args.database.databasePageRequestSeqRef.current,1);assert.equal(ctl.databaseMetricsRefreshToken,4);cases++
  ctl.setDatabaseRefreshToken(v=>v+1);ctl=render()
  assert.equal(ctl.databaseMetricsRefreshToken,5,'legacy structural/install invalidation must still refresh metrics');cases++
  args.hasDatabasePageSnapshot=false;ctl=render();ctl.scheduleDatabaseDerivedStateRefresh(0,['favorite']);drain();ctl=render()
  assert.equal(ctl.databaseRefreshToken,5,'missing page snapshot must get a replacement read');cases++
  const a={...font('a'),path:'/fonts/a.ttf',favorite:true,tagNames:['shared'],localTagNames:['local'],deleteProtected:false,active:true,previewKey:'unchanged'}
  const other={...font('b'),path:'/fonts/b.ttf'}
  library={fonts:{a,b:other},folders:['/fonts'],tags:['shared'],localTags:['local']}
  const base={hfm:{onFontTagStateSignal:fn=>{tagListener=fn;return()=>{}},onFontIndexChanged:fn=>{indexListener=fn;return()=>{}}},getCurrentLibrary:()=>library,commitLibraryUpdate:x=>library=typeof x==='function'?x(library):x,setStatus(){},saveLibraryImmediately:()=>{throw Error('metadata must not save library')},refreshDatabaseDerivedState:()=>{throw Error('unconditional clear')},scheduleDatabaseDerivedStateRefresh:()=>{notifications++},captureFontScrollSnapshot(){},restoreFontScrollSnapshot(){},cleanupRemovedFontState(){},requestPreviewFont:()=>{throw Error('metadata must not invalidate previews')},loadCacheStats:()=>{throw Error('metadata must not query cache')}}
  let notifications=0
  load('src/renderer/src/runtime/app/effects/useFontTagStateSignalEventRuntime.ts').useFontTagStateSignalEventRuntime(base)
  effects.splice(0).forEach(fn=>fn())
  tagListener({scope:'shared',changedIds:['a'],sharedRevision:5,knownTags:['shared']})
  const tags=library.tags
  tagListener({scope:'shared',changedIds:['a'],sharedRevision:4,knownTags:[]})
  assert.equal(notifications,1);assert.equal(library.tags,tags);cases++
  tagListener({scope:'shared',mutationKind:'catalogCommit',changedIds:[],sharedRevision:6,knownTags:['shared','empty']})
  assert.equal(notifications,1,'zero-bound catalog commit does not requery font page');assert.deepEqual(plain(library.tags),['empty','shared']);cases++
  load('src/renderer/src/runtime/app/effects/useFontIndexChangedEventRuntime.ts').useFontIndexChangedEventRuntime(base)
  effects.splice(0).forEach(fn=>fn())
  indexListener({folder:'/fonts',source:'shared-metadata',metadataFields:['deleteProtected'],upserts:[{...a,deleteProtected:true,favorite:false,tagNames:[],localTagNames:[],active:false}],deletes:[]})
  const next=library.fonts.a
  assert.equal(next.deleteProtected,true);assert.equal(next.favorite,true);assert.deepEqual(plain(next.tagNames),['shared']);assert.deepEqual(plain(next.localTagNames),['local']);assert.equal(next.active,true);assert.equal(next.previewKey,'unchanged');assert.equal(library.fonts.b,other);cases++
}
async function indexEventConvergence() {
  const effects=[],statuses=[];let listener,library={fonts:{},folders:['/fonts'],tags:[],localTags:[]},refreshes=0,saves=0,stats=0,previews=0,saveGate,saveOk=true;
  const baseLoader=require('./check-operation-chain.cjs').loader;
  const environmentPort={[path.join(root,'src/renderer/src/constants/environmentConstants.ts')]:{RENDERER_ENV:{DEV:false,PROD:true},IS_DEVELOPMENT:false}};
  const normalizationLoad=baseLoader(environmentPort);
  const normalize=normalizationLoad('src/renderer/src/library-normalize/libraryIndexChangeRuntime.ts');
  const hook=baseLoader({...environmentPort,react:{useRef:current=>({current}),useEffect:fn=>effects.push(fn)},'../../../appRuntime':normalize})('src/renderer/src/runtime/app/effects/useFontIndexChangedEventRuntime.ts').useFontIndexChangedEventRuntime;
  const saved=[];hook({hfm:{onFontIndexChanged:fn=>{listener=fn;return()=>{}}},getCurrentLibrary:()=>library,commitLibraryUpdate:next=>library=next,captureFontScrollSnapshot:()=>0,restoreFontScrollSnapshot(){},cleanupRemovedFontState(){},requestPreviewFont:()=>previews++,refreshDatabaseDerivedState:()=>refreshes++,setStatus:message=>statuses.push(message),saveLibraryImmediately:async latest=>{saves++;saved.push(latest);if(saveGate)await saveGate;return saveOk},loadCacheStats:()=>stats++});
  const cleanup=effects[0]();const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
  const fonts=Array.from({length:394},(_,i)=>({...font('f'+i),path:'/fonts/f'+i+'.ttf'}));
  const payload={folder:'/fonts',source:'watcher',upserts:fonts,deletes:[]};
  listener(payload);listener({folder:'/fonts',source:'watcher',upserts:[{...fonts[0],family:'latest'}],deletes:[]});await settle();
  assert.equal(previews,0,'394 index rows became foreground preview demands');assert.equal(refreshes,1);assert.equal(saves,1);assert.equal(stats,1);assert.equal(saved[0].fonts.f0.family,'latest');cases++;
  const before=[refreshes,saves,stats];listener({folder:'/fonts',upserts:[],deletes:[],errors:[{message:'offline'}]});listener({folder:'/other',upserts:fonts,deletes:[]});await settle();assert.deepEqual([refreshes,saves,stats],before,'empty/error-only or unrelated-root event restarted work');cases++;
  listener({...payload,upserts:Object.values(library.fonts),errors:[{message:'read failed'},{message:'other failed'}]});listener({...payload,upserts:[],deletes:[{id:'offscreen',path:'/fonts/offscreen.ttf',relativePath:'offscreen.ttf'}]});await settle();assert.equal(refreshes,before[0]+1,'off-window delete/recovery lost database invalidation');assert.equal(saves,before[1]);assert.equal(stats,before[2]+1);assert(statuses.some(message=>message.includes('错误 2 个')),'unchanged projection hid partial errors');cases++;
  let release;saveGate=new Promise(resolve=>release=resolve);listener({...payload,upserts:[{...fonts[0],family:'pending'}]});await settle();listener({...payload,upserts:[{...fonts[0],family:'newest'}]});await settle();assert.equal(stats,2);release();await settle();assert.equal(saved.at(-1).fonts.f0.family,'newest');assert.equal(stats,3,'coalesced save triggered repeated stats');cases++;
  saveGate=null;saveOk=false;listener({...payload,upserts:[{...fonts[0],family:'unsaved'}]});await settle();assert.equal(stats,3,'failed shell save queried stats');cases++;
  const settled=[refreshes,saves,stats];await settle();assert.deepEqual([refreshes,saves,stats],settled,'event processing self-triggered work');cleanup();
  const intents=normalizationLoad('src/renderer/src/fontUserIntentRuntime.ts');const blocked=intents.setUninstallIssue(library.fonts.f0,'retry pending');
  const withIntent={...library,fonts:{...library.fonts,f0:blocked}};const cleared=normalize.applyFontIndexChangeToLibrary(withIntent,{...payload,upserts:[{...library.fonts.f0,pendingUninstall:undefined}]});
  assert.notEqual(cleared.library,withIntent,'private intent change was discarded as an equal JSON projection');assert.equal(intents.getUninstallIssue(cleared.library.fonts.f0),undefined);assert.equal(cleared.library.fonts.f0.path,blocked.path);cases++;
}
async function cacheStatsConvergence() {
  const make=loader({'./deferredInstallStatusRefreshRuntime':{scheduleDeferredInstallStatusRefresh(){}}})('src/renderer/src/runtime/library/actions/fontLibraryIndexSharedRuntime.ts').createFontLibraryIndexSharedRuntime;
  const state={current:{active:null,requested:0}},calls=[],applied=[],subscribers=new Set();let closing=false;
  const lifecycle={isClosing:()=>closing,subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)}};
  const options={cacheStatsRequestState:state,closingLifecycle:lifecycle,hfm:{getCacheStats:()=>new Promise(resolve=>calls.push(resolve))},setCacheStats:value=>applied.push(value)};
  const first=make(options).loadCacheStats();const second=make({...options}).loadCacheStats();assert.equal(first,second);assert.equal(calls.length,1,'render recreation bypassed single-flight stats');
  calls[0]({version:1});for(let i=0;i<10;i++)await Promise.resolve();assert.equal(calls.length,2);assert.equal(applied.length,0,'superseded stats reply applied');calls[1]({version:2});await first;assert.equal(applied[0].version,2);cases++;
  const old=make(options).loadCacheStats();closing=true;for(const fn of subscribers)fn(true);closing=false;for(const fn of subscribers)fn(false);const resumed=make({...options}).loadCacheStats();calls[2]({version:3});for(let i=0;i<10;i++)await Promise.resolve();assert.equal(calls.length,4,'cancelled-close new intent was lost');assert.equal(applied.length,1);calls[3]({version:4});await Promise.all([old,resumed]);assert.equal(applied.at(-1).version,4);assert.equal(subscribers.size,0);cases++;
}
async function main(){await indexEventConvergence();await cacheStatsConvergence();await metadata();await queueScopes();await multipleRoots();renderer();await metadata(s=>s.replace(/\r?\n/g,'\r\n'));await assert.rejects(()=>metadata(s=>s.replace('if (deps.syncSharedMetadataChangedIdsToMergedIndex)', 'if (false)')),/one committed shared tag/);console.log(`[diagnostics:incremental-metadata-refresh] ${cases} SQLite 1499-row/commit/fallback/catalog, actual controller/event/preview isolation cases; original root snapshot mutant rejected`)}
main().catch(e=>{console.error(e);process.exitCode=1})
