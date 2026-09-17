#!/usr/bin/env node
// Real renderer modules and queue; only API/React/timers/logging ports are controlled.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { loader, chain } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const dir = 'src/renderer/src/'
const authorityFile = dir + 'fontTagStateAuthorityRuntime.ts'
const plain = v => JSON.parse(JSON.stringify(v))
const tick = () => new Promise(resolve => setImmediate(resolve))
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return {promise, resolve} }
function environment(transform = x => x, extra = {}, globals = {}) {
  const events = []
  const load = loader({[path.join(root,dir+'constants/environmentConstants.ts')]:{STARTUP_AUTO_SYSTEM_FONT_IMPORT_ENABLED:false,APP_VERSION:'3.0.0',RENDERER_ENV:{DEV:false,PROD:true},IS_DEVELOPMENT:false},...extra}, { window: { hfm: { reportPerformanceEvent: async e => events.push(JSON.parse(e.details.event)) } }, ...globals }, { [path.join(root, authorityFile)]: transform })
  return { load, a: load(authorityFile), events }
}
const font = id => ({id, path:`/fonts/${id}.ttf`, fileName:`${id}.ttf`, localTagNames:['old'], tagNames:['shared'], favorite:true, deleteProtected:true})
function basic(transform) {
  const {a} = environment(transform), original = font('a')
  const first = a.markFontTagsOptimistic(original,'local',['first'],100)
  const second = a.markFontTagsOptimistic(first,'local',['second'],200)
  const library = {fonts:{a:second},localTags:['old'],tags:['shared']}
  for (const signal of [
    {scope:'local',changedIds:['a'],localRevision:1,knownTags:['old']},
    {scope:'local',changedIds:['b'],localRevision:2,knownTags:['old']},
    {scope:'local',changedIds:[],knownTags:[]}
  ]) {
    const next = a.applyFontTagMutationSignalToLibrary(library,signal,300)
    assert.deepEqual(plain(next.fonts.a.localTagNames),['second'],'F-01 old/other/legacy signal must retain intent')
    assert(a.isFontTagStateDirty(next.fonts.a,'local',300))
    assert(next.localTags.includes('second'))
  }
  for (const time of [20201,600200]) {
    assert.deepEqual(plain(a.mergeFontTagState(second,original,'local',time).localTagNames),['second'],'F-02 pending intent cannot expire')
  }
  assert.equal(a.isFontTagStateDirty(plain(second),'local',300),false,'reload cannot recover session intent')
  assert.equal(a.isFontTagStateDirty(structuredClone(second),'local',300),false,'IPC clone cannot carry renderer pending state')
  assert.equal(second.__localTagRevision,undefined,'edit generation cannot be a backend revision')
  assert.equal(second.favorite,true);assert.equal(second.deleteProtected,true);assert.deepEqual(plain(second.tagNames),['shared'])
}
async function queueCases(transform) {
  const {a,load,events} = environment(transform), q = load(dir+'fontWriteQueue.ts')
  const original = font('a'), first = a.markFontTagsOptimistic(original,'local',['first'])
  const state = q.createEmptyQueuedFontWriteState(), pending = gate()
  const trace = load(dir+'fontOperationTrace.ts')
  state.localTags.set('a',trace.trackFontWrite({item:first,tagNames:['first']},'localTags'))
  const flushing = q.flushQueuedFontWriteQueue({queue:state,folders:[],hfm:{setLocalTagsBatch:()=>pending.promise}})
  const second = a.markFontTagsOptimistic(first,'local',['second'])
  pending.resolve({ok:true,updatedIds:['a'],failed:[]});await flushing
  const still = a.mergeFontWithTagAuthority(second,{...original,localTagNames:['second']})
  assert(a.isFontTagStateDirty(still,'local'),'old response cannot confirm second edit, even matching read')
  const confirmed = a.mergeFontWithTagAuthority(first,{...original,localTagNames:['first']})
  assert(!a.isFontTagStateDirty(confirmed,'local'),'own successful response plus matching read confirms')
  const external = a.applyFontTagMutationSignalToLibrary({fonts:{a:confirmed},localTags:['first'],tags:['shared']},{scope:'local',knownTags:[],localRevision:9})
  assert.deepEqual(plain(external.fonts.a.localTagNames),[],'external explicit delete after confirmation')
  const b = a.markFontTagsOptimistic(font('b'),'local',['B']), c = a.markFontTagsOptimistic(font('c'),'local',['C'])
  const batch = q.createEmptyQueuedFontWriteState();for(const f of [b,c]) batch.localTags.set(f.id,trace.trackFontWrite({item:f,tagNames:f.localTagNames},'localTags'))
  const partial = await q.flushQueuedFontWriteQueue({queue:batch,folders:[],hfm:{setLocalTagsBatch:async()=>({ok:false,updatedIds:['b'],failed:[{id:'c',message:'offline'}]})}})
  assert.deepEqual([...partial.retryQueue.localTags.keys()],['c'])
  assert(!a.isFontTagStateDirty(a.mergeFontWithTagAuthority(b,{...font('b'),localTagNames:['B']}),'local'))
  assert(a.isFontTagStateDirty(a.mergeFontWithTagAuthority(c,{...font('c'),localTagNames:['C']}),'local',600000))
  const retry = await q.flushQueuedFontWriteQueue({queue:partial.retryQueue,folders:[],hfm:{setLocalTagsBatch:async items=>{assert.equal(items.length,1);return {ok:true,updatedIds:['c'],failed:[]}}}})
  assert.equal(retry.wroteCount,1)
  assert(!a.isFontTagStateDirty(a.mergeFontWithTagAuthority(c,{...font('c'),localTagNames:['C']}),'local'))
  const newer = a.markFontTagsOptimistic(c,'local',['D']), target=q.createEmptyQueuedFontWriteState()
  target.localTags.set('c',{item:newer,tagNames:['D']});q.mergeQueuedFontWritesPreservingNewer(target,partial.retryQueue)
  assert.equal(target.localTags.get('c').item,newer)
  const both=a.markFontTagsOptimistic(a.markFontTagsOptimistic(original,'local',[]),'shared',['new-shared'])
  a.settleFontTagWrite(both,'shared',true)
  const sharedConfirmed=a.mergeFontWithTagAuthority(both,{...original,tagNames:['new-shared']})
  assert(!a.isFontTagStateDirty(sharedConfirmed,'shared'));assert(a.isFontTagStateDirty(sharedConfirmed,'local'))
  for(const tags of [[],['new']]) {
    const edit=a.markFontTagsOptimistic(second,'local',tags);a.settleFontTagWrite(edit,'local',true)
    const read=a.mergeFontWithTagAuthority(edit,{...original,localTagNames:tags})
    assert.deepEqual(plain(read.localTagNames),tags);assert(!a.isFontTagStateDirty(read,'local'))
  }
  const unavailable=q.createEmptyQueuedFontWriteState();unavailable.localTags.set('a',{item:second,tagNames:['second']})
  const missing=await q.flushQueuedFontWriteQueue({queue:unavailable,folders:[],hfm:{}})
  assert.equal(missing.retryQueue.localTags.size,1);assert(a.isFontTagStateDirty(second,'local',600000))
  const single=await q.flushQueuedFontWriteQueue({queue:missing.retryQueue,folders:[],hfm:{setLocalTags:async()=>({ok:true,updatedIds:['a'],failed:[]})}})
  assert.equal(single.wroteCount,1);assert.equal(single.retryQueue.localTags.size,0)
  assert(events.some(e=>e.reason?.includes('own-write-ack') && e.trace),'ack must have chain identity and generation reason')
  assert(events.some(e=>e.reason?.includes('matching-read-confirmed')))
  const members=events.filter(e=>e.stage==='intent-dispatch').map(e=>e.trace?.operationId).filter(Boolean)
  assert(new Set(members).size>=3,'batch members must retain distinct diagnostic operation identities')
}
function readConfirmationCases(transform) {
  const {a}=environment(transform)
  const original=font('a'), edit=a.markFontTagsOptimistic(original,'local',['saved'])
  let library={fonts:{a:edit},localTags:['saved'],tags:['shared']}
  const oldRead=a.captureFontTagReadConfirmation(library)
  a.settleFontTagWrite(edit,'local',true)
  oldRead(library)
  assert(a.isFontTagStateDirty(edit,'local'),'request started before ack cannot confirm')
  const freshRead=a.captureFontTagReadConfirmation(library)
  const newer=a.markFontTagsOptimistic(edit,'local',['newer'])
  freshRead({...library,fonts:{a:newer}})
  assert(a.isFontTagStateDirty(newer,'local'),'fresh response for old generation cannot confirm newer')
  freshRead(library)
  assert(!a.isFontTagStateDirty(edit,'local'),'accepted post-ack empty page must release protection')
  const external=a.mergeFontWithTagAuthority(edit,{...original,localTagNames:[]})
  assert.deepEqual(plain(external.localTagNames),[],'external delete before first matching read accepted')
}
function draftCatalogCase() {
  const {a}=environment(), edit=a.markFontTagsOptimistic(font('a'),'local',['draft'])
  let library=a.applyFontTagMutationSignalToLibrary({fonts:{a:edit},localTags:['old'],tags:['shared']},{scope:'local',knownTags:[]})
  assert(library.localTags.includes('draft'))
  library=a.ensureLibraryTagNamesContainFontTags(library)
  assert(library.localTags.includes('draft'),'repeated normalization retains draft while pending')
  a.settleFontTagWrite(edit,'local',true)
  library=a.applyFontTagMutationSignalToLibrary(library,{scope:'local',knownTags:[]})
  library=a.captureFontTagReadConfirmation(library)(library)
  assert.deepEqual(plain(library.fonts.a.localTagNames),[],'last external empty catalog applies when protection ends')
  assert.deepEqual(plain(library.localTags),[],'draft does not permanently pollute authoritative catalog')
}
function successfulReadCatalogCases(transform) {
  for (const scope of ['local','shared']) for (const returned of [true,false]) {
    const {a,load}=environment(transform), key=scope==='local'?'localTagNames':'tagNames'
    const catalog=scope==='local'?'localTags':'tags'
    let library=a.applyFontTagMutationSignalToLibrary({fonts:{a:font('a')},localTags:['old'],tags:['shared']},{scope,knownTags:[]})
    const edit=a.markFontTagsOptimistic(library.fonts.a,scope,['saved'])
    library=a.ensureLibraryTagNamesContainFontTags({...library,fonts:{a:edit}})
    a.settleFontTagWrite(edit,scope,true)
    const items=returned?[{...font('a'),[key]:['saved']}]:[]
    library=a.captureFontTagReadConfirmation(library)(library,items)
    library=load(dir+'library-normalize/libraryNormalizeStateRuntime.ts').libraryWithMergedFonts(library,items)
    assert.deepEqual(plain(library.fonts.a[key]),['saved'],'successful write/read cannot be erased by an older empty catalog')
    assert(library[catalog].includes('saved'))
    assert(!a.isFontTagStateDirty(library.fonts.a,scope))
    library=a.applyFontTagMutationSignalToLibrary(library,{scope,knownTags:[]})
    assert.deepEqual(plain(library.fonts.a[key]),[],'later external catalog deletion must still apply')
    assert.deepEqual(plain(library[catalog]),[])
  }
}
async function pageConfirmationCase(stale = false) {
  const effects=[],timers=[],pending=gate()
  let normalize
  const appPort={rendererFontQueryCacheKey:JSON.stringify,libraryWithMergedFonts:(...args)=>normalize.libraryWithMergedFonts(...args)}
  const {a,load}=environment(x=>x,{
    react:{useEffect:fn=>effects.push(fn),useMemo:fn=>fn(),useState:()=>[0,()=>{}]},
    [path.join(root,dir+'appRuntime.ts')]:appPort
  },{window:{setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout(){}}})
  appPort.getVirtualGridColumns=load(dir+'constants/layoutConstants.ts').getVirtualGridColumns
  normalize=load(dir+'library-normalize/libraryNormalizeStateRuntime.ts')
  const edit=a.markFontTagsOptimistic(font('a'),'local',[]);a.settleFontTagWrite(edit,'local',true)
  let library={fonts:{a:edit},folders:['/fonts'],localTags:['old'],tags:['shared']}
  const beforeLibrary=library
  const seq={current:0}
  load(dir+'runtime/database/useRendererDatabasePageRuntime.ts').useRendererDatabasePageRuntime({
    library,libraryLoadedRef:{current:true},hfm:{queryFontPage:()=>pending.promise},
    databasePageResult:null,databaseQueryFailedKey:'',databaseRefreshToken:1,
    databasePageRequestSeqRef:seq,fontListScrollingRef:{current:false},
    virtualViewport:{width:500,height:500,scrollTop:0},viewLayout:{rowHeight:100,minCardWidth:100},
    sidebarPage:'tags',deferredSearch:'',activeFilter:{kind:'all'},selectedWatchedFolders:[],selectedFormats:[],selectedScripts:[],selectedCategory:'all',selectedTagName:'old',selectedSharedTagName:'',selectedFolderId:'',selectedFontId:'',selectedFontIds:[],installStatus:'all',timeSortMode:'all',sortMode:'name',
    reportTrace(){},setDatabasePageResult(){},setDatabaseQueryResult(){},setDatabaseQueryFailedKey(){},setStatus(){},setLibrary:u=>{library=u(library)}
  })
  const cleanup=effects.map(fn=>fn());for(const timer of timers)timer()
  if(stale)seq.current++
  pending.resolve({items:[],total:0,offset:0,limit:100})
  await tick()
  assert.equal(library === beforeLibrary,stale,'empty accepted page must publish changed intent to memoized views')
  assert.equal(a.isFontTagStateDirty(library.fonts.a,'local'),stale,'real page hook must confirm only accepted post-ack response, including empty results')
  for(const fn of cleanup)if(typeof fn==='function')fn()
}
async function closeFailureCase() {
  const {a,load}=environment(), q=load(dir+'fontWriteQueue.ts')
  const edit=a.markFontTagsOptimistic(font('a'),'local',['unsaved']), queue=q.createEmptyQueuedFontWriteState()
  queue.localTags.set('a',{item:edit,tagNames:['unsaved']})
  const queueRef={current:queue}, statuses=[]
  const runtime=load(dir+'fontWriteQueueRuntime.ts').createRendererFontWriteQueueRuntime({
    queueRef,timerRef:{current:null},retryTimerRef:{current:null},retryAttemptRef:{current:0},activeRef:{current:false},activePromiseRef:{current:null},
    hfm:{setLocalTagsBatch:async()=>{throw Error('offline')}},getFolders:()=>[],writeBehindDelayMs:1,writeBehindMaxItems:10,writeBehindMaxBufferBytes:10000,memoryPressure:()=> 'normal',
    setTimeout:(fn,ms)=>{if(ms<1800)queueMicrotask(fn);return 1},clearTimeout(){},setStatus:s=>statuses.push(s),scheduleDatabaseDerivedStateRefresh(){}
  })
  assert.equal(await runtime.flush('close'),false)
  assert.equal(queueRef.current.localTags.size,1)
  assert(a.isFontTagStateDirty(edit,'local',600000))
  assert(statuses.some(s=>s.includes('未保存')))
}
async function dialogCases() {
  const mocks = { [path.join(root,dir+'appRuntime.ts')]: {fontDisplayName:f=>f.id}, [path.join(root,dir+'fontDialogContextActionsRuntime.ts')]:{createFontDialogContextActions:()=>({})} }
  const {a,load}=environment(x=>x,mocks), q=load(dir+'fontWriteQueue.ts')
  let library={fonts:{a:font('a')},localTags:['old'],tags:['shared']}, queued=[],messages=[]
  const commit=u=>(library=typeof u==='function'?u(library):u)
  const base=()=>({library,selectedFont:library.fonts.a,setLibrary:commit,commitLibraryUpdate:commit,setStatus:x=>messages.push(x),queueLocalTagsWrite:(item,tagNames)=>queued.push({item,tagNames}),queueSharedTagsWrite:(item,tagNames)=>queued.push({item,tagNames}),setAssignTagName(){},setAssignSharedTagName(){},refreshDatabaseDerivedState(){},fontsForTag:()=>[library.fonts.a],setRenameTarget(){},setRenameValue(){},setSelectedTagName(){},setSelectedSharedTagName(){},setDeleteTarget(){},watchedFolders:[]})
  const tags=load(dir+'fontDialogTagActionsRuntime.ts').createFontDialogTagActions(base(),()=>{})
  tags.addTagToSelectedByName('new')
  const item=queued[0].item
  assert(a.isSameFontTagIntent(library.fonts.a,item,'local'),'dialog/queue must share token')
  const queue=q.createEmptyQueuedFontWriteState();queue.localTags.set('a',queued[0])
  await q.flushQueuedFontWriteQueue({queue,folders:[],hfm:{setLocalTagsBatch:async()=>({ok:true,updatedIds:['a'],failed:[]})}})
  assert(!a.isFontTagStateDirty(a.mergeFontWithTagAuthority(library.fonts.a,{...font('a'),localTagNames:item.localTagNames}),'local'))
  const factory=load(dir+'fontDialogRuntime.ts').createFontDialogRuntime
  const before=plain(library)
  // Direct catalog failures must not become per-font unbind retries or orphan dirty states.
  let called=0
  await factory({...base(),deleteTarget:{kind:'tag',scope:'local',name:'old'},hfm:{deleteLocalTag:async()=>{called++;throw Error('disk')}},flushFontWriteQueue:async()=>false}).confirmDelete()
  assert.equal(called,0);assert.deepEqual(plain(library),before)
  await factory({...base(),deleteTarget:{kind:'tag',scope:'local',name:'old'},hfm:{deleteLocalTag:async()=>{called++;return {ok:false,updatedIds:[],failed:[],message:'failed'}}},flushFontWriteQueue:async()=>true}).confirmDelete()
  assert.equal(called,1);assert.deepEqual(plain(library),before)
  assert.equal(queued.length,1,'catalog failure is not an unbind retry')
  tags.addSharedTagToSelectedByName('shared-new')
  tags.removeTagFromSelected('new')
  assert.deepEqual(plain(library.fonts.a.localTagNames),['old'])
  assert(library.fonts.a.tagNames.includes('shared-new'),'stale dialog closure cannot replace other field')
  assert(a.isSameFontTagIntent(library.fonts.a,queued.at(-1).item,'local'))
  assert(a.isSameFontTagIntent(library.fonts.a,queued.at(-2).item,'shared'))
  // Rename must queue every token it creates, even when query-derived affected IDs are partial.
  library={...library,fonts:{a:font('a'),b:font('b')}};queued=[]
  await factory({...base(),renameTarget:{kind:'tag',scope:'local',name:'old'},renameValue:'renamed',hfm:{}}).confirmRename()
  assert.deepEqual(queued.map(e=>e.item.id).sort(),['a','b'])
  for(const entry of queued)assert(a.isSameFontTagIntent(library.fonts[entry.item.id],entry.item,'local'))
  assert(messages.some(m=>m.includes('失败')))
}
function lruCase() {
  const {a,load}=environment(x=>x,{[path.join(root,dir+'appConstants.ts')]:{FONT_OBJECT_LRU_LIMIT:1}})
  const edited=a.markFontTagsOptimistic({...font('a'),favorite:false,deleteProtected:false},'local',['pending'])
  const normalize=load(dir+'library-normalize/libraryNormalizeStateRuntime.ts')
  const next=normalize.libraryWithMergedFonts({fonts:{a:edited},localTags:['pending'],tags:[]},[font('b'),font('c')])
  assert(next.fonts.a,'LRU must retain pending intent owner')
}
async function main() {
  basic(); lruCase(); draftCatalogCase(); successfulReadCatalogCases(); await queueCases(); readConfirmationCases(); await pageConfirmationCase(); await pageConfirmationCase(true); await closeFailureCase(); await dialogCases()
  for (const ending of ['\n','\r\n']) {
    const normalize=s=>s.replace(/\r?\n/g,ending)
    basic(normalize);await queueCases(normalize)
    assert.throws(()=>basic(s=>normalize(s).replace("return !!intent && intent.phase !== 'confirmed' && intent.phase !== 'cancelled'", "return !!intent && _nowMs < 20000")),assert.AssertionError)
    assert.throws(()=>basic(s=>normalize(s).replace("report(intent, scope, 'view-reject', 'broadcast-cannot-ack-intent')", "intent.phase = 'confirmed'")),assert.AssertionError)
    await assert.rejects(()=>queueCases(s=>normalize(s).replace("intent?.phase === 'committed' && incomingHasTags", "intent && incomingHasTags")),assert.AssertionError)
    assert.throws(()=>readConfirmationCases(s=>normalize(s).replace("if (intent?.phase === 'committed') pending.push", "if (intent) pending.push")),assert.AssertionError)
    assert.throws(()=>successfulReadCatalogCases(s=>normalize(s).replace('for (const tag of intentOf(font, scope)?.readTags || []) tags.add(tag)','/* discarded read evidence */')),assert.AssertionError)
  }
  const logDetail=process.env.HFM_LOG_DETAIL
  process.env.HFM_LOG_DETAIL='debug'
  try { await chain({tagIntent:true});await chain({tagIntent:true,failures:2,runtimePreload:true}) }
  finally { if(logDetail===undefined)delete process.env.HFM_LOG_DETAIL;else process.env.HFM_LOG_DETAIL=logDetail }
  console.log('[diagnostics:tag-intent-lifecycle] F-01a/b F-02, real queue/dialog/page/LRU/close, successful read versus old catalog, external delete; real preload/IPC/SQLite confirmation and retry; LF/CRLF and 10 mutation runs passed')
}
function baseline(ref) {
  const source=execFileSync('git',['show',`${ref}:${authorityFile}`],{cwd:root,encoding:'utf8'})
  const {a}=environment(()=>source), edit=a.markFontTagsOptimistic(font('a'),'local',['new'],2000)
  const library={fonts:{a:edit},localTags:['old','new'],tags:['shared']}
  const results=[
    ['F-01a',()=>a.applyFontTagMutationSignalToLibrary(library,{scope:'local',changedIds:['a'],localRevision:1,knownTags:['old']},3000).fonts.a.localTagNames],
    ['F-01b',()=>a.applyFontTagMutationSignalToLibrary(library,{scope:'local',changedIds:['b'],localRevision:1,knownTags:['old']},3000).fonts.a.localTagNames],
    ['F-02',()=>a.mergeFontTagState(edit,font('a'),'local',22001).localTagNames]
  ]
  let failed=0
  for(const [name,run] of results) {
    const actual=plain(run()), pass=actual.includes('new')
    console.log(`${name}: ${pass?'PASS':'FAIL'} expected=new actual=${JSON.stringify(actual)}`)
    if(!pass)failed++
  }
  process.exitCode=failed?1:0
}
if(require.main===module) {
  const ref=process.argv.find(arg=>arg.startsWith('--baseline='))?.slice('--baseline='.length)
  if(ref)baseline(ref)
  else main().catch(e=>{console.error(e);process.exitCode=1})
}
module.exports={basic,queueCases}
