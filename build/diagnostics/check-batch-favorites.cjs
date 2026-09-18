#!/usr/bin/env node
// U-03: actual UI/command/action/queue/preload + real local SQLite. React and native ports are controlled.
const assert=require('node:assert/strict'),path=require('node:path'),{DatabaseSync}=require('node:sqlite')
const {setup}=require('./check-font-command-entry.cjs')
const {loadModules,button,font,plain,noop,tick,renderer,root}=require('./check-activation-entry.cjs')
const {loader}=require('./check-operation-chain.cjs')
let cases=0
function database(load) {
  const db=new DatabaseSync(':memory:')
  db.transaction=fn=>()=>{db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}}
  load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(db)
  return db
}
async function fixture(config={}) {
  const s=setup(config),h=s.base,load=loader(),db=database(load),dbB=database(load),calls=[],refresh=[],deltas=[],timers=new Map()
  let serial=0,updates=0,invalidations=0,metrics=0
  const create=database=>load('src/main/library/runtime/localFontFavoritesRuntime.ts').createLocalFontFavoritesRuntime({openLibraryDb:async()=>database,loadLegacyLocalSnapshot:async()=>[],invalidate:()=>invalidations++,appendLog:noop})
  let store=create(db);const other=create(dbB);await store.initialize();await other.initialize()
  const persist=async(fonts,folders,value)=>store.setFavorite(fonts,folders,value)
  let response=persist
  h.handlers.set('fonts:setFavorite',(_,fonts,folders,value)=>{calls.push([fonts.map(f=>f.id),value]);return response(fonts,folders,value)})
  const queueRef={current:h.load(renderer+'fontWriteQueue.ts').createEmptyQueuedFontWriteState()}
  const q=h.load(renderer+'fontWriteQueueRuntime.ts').createRendererFontWriteQueueRuntime({queueRef,timerRef:{current:null},retryTimerRef:{current:null},retryAttemptRef:{current:0},activeRef:{current:false},activePromiseRef:{current:null},hfm:h.window.hfm,getFolders:()=>[],writeBehindDelayMs:360,writeBehindMaxItems:120,writeBehindMaxBufferBytes:999999,memoryPressure:()=> 'normal',setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,fn);if(ms<1000)Promise.resolve().then(()=>{if(timers.delete(id))fn()});return id},clearTimeout:id=>timers.delete(id),setStatus:x=>h.status.push(x),scheduleDatabaseDerivedStateRefresh:d=>refresh.push(d)})
  const actions=h.load(renderer+'runtime/system/actions/fontFavoriteActionRuntime.ts').createFontFavoriteActionRuntime({getCurrentLibrary:()=>h.library,setLibrary:update=>{updates++;h.setLibrary(update)},setStatus:x=>h.status.push(x),queueFavoriteWrites:q.queueFavoriteWrites,scheduleDatabaseDerivedStateRefresh:d=>refresh.push(d)}, {adjustDatabaseFavoriteCount:n=>{deltas.push(n);metrics+=n}})
  h.setCommandActions(actions)
  return {s,h,db,dbB,calls,refresh,deltas,timers,q,queueRef,actions,persist,response:fn=>response=fn,get updates(){return updates},get invalidations(){return invalidations},get count(){return metrics},async seed(ids){await persist(ids.map(font),[],true);h.setLibrary(p=>({...p,fonts:{...p.fonts,...Object.fromEntries(ids.map(id=>[id,{...p.fonts[id],favorite:true}]))}}));metrics=ids.length;invalidations=0},async saved(){return plain((await store.hydrate(h.all)).map(f=>f.favorite))},async restart(){store=create(db);return this.saved()},async isolated(){return plain((await other.hydrate(h.all.map(f=>({...f,favorite:true})))).map(f=>f.favorite))},close(){q.clearTimer();db.close();dbB.close()}}
}
function tree(f,entry){return entry==='context'?f.s.overlay():f.s.detail()}
async function entries(){
  for(const runtimePreload of [false,true])for(const entry of ['context','detail'])for(const initial of [[],['a'],['a','b','c']]){
    const f=await fixture({runtimePreload});await f.seed(initial);f.h.select().setSelectedFontIds(['a','b','c'])
    const before=plain(f.h.library.fonts),changed=3-initial.length
    if(initial.length===3){assert(button(tree(f,entry),'取消收藏'));await f.h.command()('favorite')}else button(tree(f,entry),'收藏').props.onClick();await tick()
    assert.deepEqual(await f.saved(),[true,true,true]);assert.equal(f.count,3)
    assert.equal(f.calls.length,changed?1:0);assert.equal(f.refresh.length,changed?1:0);assert.equal(f.updates,changed?2:0);assert.equal(f.invalidations,changed?1:0)
    if(changed)assert.equal(f.calls[0][0].length,changed)
    for(const id of ['a','b','c'])for(const key of ['tagNames','localTagNames','deleteProtected','active'])assert.deepEqual(plain({v:f.h.library.fonts[id][key]}),plain({v:before[id][key]}),key)
    await f.h.command()('favorite');assert.equal(f.calls.length,changed?1:0,'idempotent')
    button(tree(f,entry),'取消收藏').props.onClick();await tick();assert.deepEqual(await f.saved(),[false,false,false]);assert.equal(f.count,0)
    assert.deepEqual(await f.restart(),[false,false,false]);assert.deepEqual(await f.isolated(),[false,false,false]);f.close();cases++
  }
  const missing=await fixture({cache:[]});missing.h.select().setSelectedFontIds(['a','missing']);await missing.h.command()('favorite');assert.equal(missing.calls.length,0);assert.match(missing.h.status.at(-1),/本次操作未执行/);missing.close();cases++
  const duplicate=await fixture();await duplicate.actions.setFontsFavorite([duplicate.h.all[0],duplicate.h.all[0],duplicate.h.all[1]],true);assert.deepEqual(plain(duplicate.calls),[[['a','b'],true]]);assert.equal(duplicate.count,2);duplicate.close();cases++
}
async function failures(){
  for(const mode of ['throw','missing-receipt','sql-rollback','partial','retry']){
    const f=await fixture();let attempt=0
    if(mode==='sql-rollback')f.db.exec("CREATE TRIGGER deny_b BEFORE INSERT ON local_font_favorites WHEN NEW.font_id='b' BEGIN SELECT RAISE(ABORT,'disk'); END")
    else f.response(async(fonts,folders,value)=>{
      attempt++
      if(mode==='throw')throw Error('offline')
      if(mode==='missing-receipt')return {ok:true,updatedIds:[],failed:[]}
      if(mode==='retry'&&attempt===1)throw Error('temporary')
      if(mode==='partial'){const saved=fonts.filter(f=>f.id!=='b');if(saved.length)await f.persist(saved,folders,value);return {ok:false,updatedIds:saved.map(f=>f.id),failed:[{id:'b',message:'disk'}]}}
      return f.persist(fonts,folders,value)
    })
    f.h.select().setSelectedFontIds(['a','b','c']);await f.h.command()('favorite')
    const expected=mode==='retry'?[true,true,true]:mode==='partial'?[true,false,true]:[false,false,false]
    assert.deepEqual(await f.saved(),expected,mode);assert.deepEqual(Object.values(f.h.library.fonts).map(f=>!!f.favorite),expected,mode);assert.equal(f.count,expected.filter(Boolean).length)
    assert.equal(f.queueRef.current.favorite.size,0);assert.equal(f.timers.size,0,'failed request left a resurrection timer');assert.equal(f.calls.length,mode==='retry'?2:4)
    if(mode==='partial')assert.deepEqual(plain(f.calls.slice(1)),Array(3).fill([['b'],true]))
    assert.match(f.h.status.at(-1),mode==='retry'?/成功 3 个/:mode==='partial'?/成功 2 个，失败并回退 1 个/:/成功 0 个，失败并回退 3 个/)
    assert.deepEqual(await f.restart(),expected);f.close();cases++
  }
  // Real queue serialization: older success/failure + newer success/failure.
  for(const olderOK of [false,true])for(const newerOK of [false,true]){
    const f=await fixture();let release;const gate=new Promise(r=>release=r);let first=true
    f.response(async(fonts,folders,value)=>{if(first){first=false;await gate;if(!olderOK)throw Error('older failed')}else if(!newerOK)throw Error('newer failed');return f.persist(fonts,folders,value)})
    f.h.select().setSelectedFontIds(['a','b','c']);const a=f.h.command()('favorite');await tick();const b=f.h.command()('unfavorite');await tick()
    f.h.setLibrary(p=>({...p,fonts:{...p.fonts,a:{...p.fonts.a,tagNames:['later'],deleteProtected:true}}}))
    release();await Promise.all([a,b]);const value=olderOK&&!newerOK
    assert.deepEqual(await f.saved(),[value,value,value]);assert.deepEqual(Object.values(f.h.library.fonts).map(f=>!!f.favorite),[value,value,value]);assert.equal(f.count,value?3:0)
    assert.deepEqual(plain(f.h.library.fonts.a.tagNames),['later']);assert(f.h.library.fonts.a.deleteProtected);assert.equal(f.queueRef.current.favorite.size,0)
    assert.deepEqual(await f.restart(),[value,value,value]);f.close();cases++
  }
  const f=await fixture();let release;const gate=new Promise(r=>release=r);let first=true
  f.response(async(...args)=>{if(first){first=false;await gate}return f.persist(...args)})
  f.h.select().setSelectedFontIds(['a','b']);const a=f.h.command()('favorite');await tick();const b=f.h.command()('unfavorite');await tick();const c=f.h.command()('favorite');await tick();release();await Promise.all([a,b,c]);assert.deepEqual(await f.saved(),[true,true,false]);assert.equal(f.count,2);f.close();cases++
}
async function selection(){
  const effects=[],load=loadModules({}, {react:{useEffect:fn=>effects.push(fn)}}),intent=load(renderer+'fontUserIntentRuntime.ts')
  let ids=['a','b','missing'];const pending=intent.markFavoriteIntent({...font('a'),favorite:true},false)
  const library={__partialFonts:true,fonts:{a:pending,b:{...font('b'),favorite:true}}}
  const opts={favoritesOnly:true,library,selectedFontIds:ids,setLibrary:noop,visibleFonts:[],selectedFontId:'',detailVisible:false,setSelectedFontIds:fn=>ids=fn(ids),setSelectedFontId:noop,requestPreviewFont:noop,isBadFontRecord:()=>false}
  const run=()=>{effects.length=0;load(renderer+'runtime/app/useFontDetailSelectionEffectsRuntime.ts').useFontDetailSelectionEffectsRuntime({...opts,selectedFontIds:ids});effects.forEach(fn=>fn())}
  run();assert.deepEqual(ids,['a','b','missing'],'pending failure must retain selection');intent.settleFavoriteIntent(pending);run();assert.deepEqual(ids,['b','missing'],'remove only confirmed canceled favorite; keep partial cache misses');cases++
}
async function pagination(){
  for(const mode of ['refill','scope-change','late-intent']){
    const effects=[],timers=[],writes=[],calls=[],globals={window:{setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout:noop}}
    const base=loadModules(globals,{}),app={...base(renderer+'libraryNormalize.ts')}
    // Numeric layout and cache-key ports only; production page owner/request/merge are executed.
    app.getVirtualGridColumns=()=>1;app.rendererFontQueryCacheKey=r=>JSON.stringify(r)
    const mocks={react:{useState:()=>[0,noop],useMemo:fn=>fn(),useEffect:fn=>effects.push(fn)}}
    mocks[path.join(root,renderer+'appRuntime.ts')]=app
    const load=loadModules(globals,mocks),intent=load(renderer+'fontUserIntentRuntime.ts'),original=Array.from({length:380},(_,i)=>({...font('f'+i),favorite:true})),rows=original.slice(30)
    const opts={hfm:{queryFontPage:async request=>{calls.push(request.offset);if(mode==='late-intent'&&request.offset===100)intent.markFavoriteIntent(font('a'),true);return {queryKey:JSON.stringify(request),items:rows.slice(request.offset,request.offset+request.limit),total:rows.length,offset:request.offset,limit:request.limit,engine:'sql'}}},library:{folders:['C:/fixture'],fonts:{}},libraryLoadedRef:{current:true},databaseRefreshToken:2,databaseQueryFailedKey:'',virtualViewport:{width:600,height:400,scrollTop:19000},viewLayout:{rowHeight:100,minCardWidth:100},allFontsLength:0,sidebarPage:'library',activeFilter:{kind:'favorites'},deferredSearch:'',selectedWatchedFolders:[],selectedFormats:[],selectedScripts:[],selectedCategory:'all',selectedTagName:'',selectedSharedTagName:'',selectedFolderId:'',selectedFontId:'',selectedFontIds:[],installStatus:'all',timeSortMode:'all',sortMode:'name',fontListScrollingRef:{current:false},fontMetricsRequestSeqRef:{current:0},databasePageRequestSeqRef:{current:0},rendererUserActive:()=>false,reportTrace:noop,setDatabaseFontMetrics:noop,setDatabasePageResult:r=>writes.push(r),setDatabaseQueryResult:noop,setDatabaseQueryFailedKey:noop,setLibrary:noop,setStatus:noop}
    const request=load(renderer+'fontViewRuntime.ts').createRendererFontQueryRequest({...opts,databasePageLimit:100,databasePageOffset:0})
    opts.databasePageResult={items:original.slice(0,300),total:380,offset:0,queryKey:JSON.stringify({...request,...(mode==='scope-change'?{keyword:'different'}:{})})}
    load(renderer+'runtime/database/useRendererDatabasePageRuntime.ts').useRendererDatabasePageRuntime(opts);effects.forEach(fn=>fn());timers.forEach(fn=>fn());await tick()
    if(mode==='late-intent')assert.equal(writes.length,0,'stale refill overwrote newer intent')
    else {assert.equal(writes.length,1);assert.equal(writes[0].items.length,mode==='refill'?300:100);assert.deepEqual(calls,mode==='refill'?[0,100,200]:[0]);assert.equal(opts.virtualViewport.scrollTop,19000);assert.equal(writes[0].items[0].id,'f30');if(mode==='refill')assert.equal(writes[0].items.at(-1).id,'f329')}
    cases++
  }
}
async function regressions(){
  const firstItem=path.join(root,renderer+'runtime/system/actions/fontFavoriteActionRuntime.ts')
  const broken=await fixture({transforms:{[firstItem]:s=>{assert(s.includes('const changed = unique.filter'));return s.replace('const changed = unique.filter','const changed = unique.slice(0, 1).filter')}}})
  broken.h.select().setSelectedFontIds(['a','b']);await broken.h.command()('favorite');assert.throws(()=>assert.equal(broken.count,2),assert.AssertionError);broken.close();cases++
  const intentFile=path.join(root,renderer+'fontUserIntentRuntime.ts')
  const f=await fixture({transforms:{[intentFile]:s=>{const anchor="(font as IntentFont)[intentKey]?.favorite?.confirmed || { value: !!font.favorite }";assert(s.includes(anchor));return s.replace(anchor,'{ value: !!font.favorite }')}}})
  let release;const gate=new Promise(r=>release=r);let first=true
  f.response(async()=>{if(first){first=false;await gate}throw Error('both failed')})
  f.h.select().setSelectedFontIds(['a']);const a=f.h.command()('favorite');await tick();const b=f.h.command()('unfavorite');await tick();release();await Promise.all([a,b]);assert.throws(()=>assert.equal(f.h.library.fonts.a.favorite,false),assert.AssertionError);f.close();cases++
  const h=await fixture();await h.seed(['a','b','c']);h.h.select().setSelectedFontIds(['a','b']);await h.h.command()('unfavorite')
  const visible=h.h.load(renderer+'fontViewRuntime.ts').buildVisibleFonts({databasePageReady:true,databasePageResult:{items:h.h.all.map(f=>({...f,favorite:true}))},allFonts:Object.values(h.h.library.fonts),fontIndexById:new Map(),deferredSearch:'',activeFilter:{kind:'favorites'},sidebarPage:'library',library:h.h.library,timeSortMode:'all',sortMode:'name'})
  assert.deepEqual(plain(visible.map(f=>f.id)),['c'],'stale query resurrected canceled favorites');h.close();cases++
}
async function main(){await entries();await failures();await selection();await pagination();await regressions();console.log(`[diagnostics:batch-favorites] ${cases} scenarios passed: actual two UI entries/two preloads + action/queue + SQLite, mixed/idempotent/dedup, rollback/retry/reversal, A/B isolation/restart, selection and loaded-window refill. Controlled hooks; Windows/browser acceptance remains pending.`)}
main().catch(e=>{console.error(e);process.exitCode=1})
