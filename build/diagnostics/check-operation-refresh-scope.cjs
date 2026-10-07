'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const refreshFile = 'src/renderer/src/databaseDerivedStateRuntime.ts'
const policyFile = 'src/main/indexing/merged-page/mergedIndexSourceChangeRuntime.ts'
const syncFile = 'src/main/indexing/merged-page/mergedIndexSyncRuntime.ts'
function refreshCheck(transform = x => x) {
  const runtime = loader({}, {}, { [path.join(root, refreshFile)]: transform })(refreshFile)
  const metrics = { installedCount: 295, notInstalledCount: 1204, favoriteCount: 4, activeCount: 1 }
  let current = metrics, token = 0, page = {}, query = {}, cancelled = 0
  const previousPage = page, previousQuery = query
  const pageSeq = { current: 3 }, metricsSeq = { current: 5 }, timer = { current: 9 }
  runtime.refreshDatabaseDerivedStateRuntime({ timerRef: timer, clearTimeout: () => cancelled++, setDatabasePageResult: v => page = v, setDatabaseQueryResult: v => query = v,
    setDatabaseFontMetrics: v => current = v, setDatabaseRefreshToken: fn => token = fn(token), databasePageRequestSeqRef: pageSeq, fontMetricsRequestSeqRef: metricsSeq })
  assert.equal(current, metrics, 'refresh must retain last authoritative installed/uninstalled counts')
  assert.equal(page,previousPage,'refresh must retain same-scope page'); assert.equal(query,previousQuery)
  assert.equal(pageSeq.current, 4); assert.equal(metricsSeq.current, 6); assert.equal(token, 1); assert.equal(cancelled, 1); assert.equal(timer.current, null)
}
async function syncCheck(transform = x => x) {
  const load = loader({electron:{app:{}}}, {}, {[path.join(root,policyFile)]:transform})
  const {createMergedIndexSyncRuntime} = load(syncFile)
  const a = {root:'/fonts',indexDbPath:'/a.db',installDbPath:'/ai.db',indexSignature:'i1',installSignature:'s1',sharedMetadataSignature:'m1'}
  const b = {...a,root:'/other',indexDbPath:'/b.db'}
  const reasons = ['shared-favorite-set','shared-favorite-clear','shared-delete-protection-set','shared-delete-protection-clear','shared-tags-batch-authority-refresh','shared-tag-delete:test']
  for (const snapshot of [false,true]) for (const reason of reasons) for (const mode of ['metadata','index-changed','install-changed','other-root','roots-changed']) {
    const next = {...a, sharedMetadataSignature:'m2', ...(mode==='index-changed'?{indexSignature:'i2'}:mode==='install-changed'?{installSignature:'s2'}:{})}
    const sources=[next,{...b,...(mode==='other-root'?{sharedMetadataSignature:'m2'}:{})}]
    let rebuild=0, sync=0, closed=0; const commits=[]
    const runtime=createMergedIndexSyncRuntime({
      normalizePathForCacheCompare:x=>x, appWatchedFolders:async()=>sources.map(x=>x.root),
      runMergedIndexMutation:async(_label,fn)=>fn({commit:r=>commits.push(r)}),
      mergedIndexSourcesKey:JSON.stringify,openMergedIndexDb:async()=>({}),getSqliteMeta:()=>JSON.stringify([a,b]),mergedIndexSourcesMatchRoots:()=>mode!=='roots-changed',
      appendStartupLog(){},mergedIndexReadyProcessKeys:new Set(),mergedIndexDbPath:()=>'/merged.db',schemaVersion:6,closeSqliteDb:()=>closed++,
      rustCoreWorkerRuntime:{runRustMergedIndexSync:async input=>{sync++;assert.equal(input.fullSnapshot,snapshot);assert.equal(input.source.root,a.root);return {synced:true,rows:1}}}
    },{mergedIndexSourcesForRoots:async()=>sources,relativePathsFromFontIndexPayload:()=>['a.ttf']},{rebuildMergedIndexDb:async()=>rebuild++})
    if(snapshot) await runtime.syncMergedIndexForRootSnapshot(a.root,reason)
    else await runtime.syncMergedIndexForRootIncremental(a.root,{upserts:[{id:'a'}],deletes:[]},reason)
    assert.equal(sync,mode==='metadata'?1:0,`${reason}/${snapshot}/${mode}: only affected root may take narrow sync`)
    assert.equal(rebuild,mode==='metadata'?0:1);assert.equal(closed,1);assert.equal(commits.length,1)
  }
}
async function metricsFailureCheck() {
  const effects=[],timers=[],stop={};let writes=0;const traces=[]
  const load=loader({react:{useState:()=>[0,()=>{}],useEffect:fn=>effects.push(fn),useMemo:()=>{throw stop}},'../../appRuntime':{normalizeFontMetricsResult:x=>x},'../../fontViewRuntime':{},'./rendererDatabasePageWindowRuntime':{}},{window:{setTimeout:fn=>{timers.push(fn);return 1},clearTimeout(){}}})
  const usePage=load('src/renderer/src/runtime/database/useRendererDatabasePageRuntime.ts').useRendererDatabasePageRuntime
  try { usePage({virtualViewport:{width:800,height:600,scrollTop:0},viewLayout:{rowHeight:80,minCardWidth:160},library:{folders:['/fonts'],fonts:{}},hfm:{getFontMetrics:async()=>{throw Error('temporarily unavailable')}},fontMetricsRequestSeqRef:{current:0},rendererUserActive:()=>false,reportTrace:e=>traces.push(e),setDatabaseFontMetrics:()=>writes++}) } catch(e) {assert.equal(e,stop)}
  effects[0]();timers[0]();for(let i=0;i<20;i++)await Promise.resolve()
  assert.equal(writes,0,'query failure must retain the last successful metrics')
  assert(traces.some(e=>e.kind==='db-metrics-error'),'failure must remain observable')
}

async function recoveryPageObservation() {
  const events=[],window={hfm:{reportPerformanceEvent:async payload=>events.push(JSON.parse(payload.details.event))}}
  const load=loader({}, {window}),trace=load('src/renderer/src/fontOperationTrace.ts'),owner={current:0}
  trace.noteFontQueryScope(owner,'tags')
  const begin=()=>{const t=trace.createFontOperationTrace('tag-recovery');owner.current++;trace.withFontRefreshTrace(t,()=>trace.noteFontRefreshRequest(owner));return t}
  const first=begin(),bound=trace.bindFontRefreshQuery(owner,++owner.current,'tags'),page={items:[]}
  trace.dispatchFontRefreshQuery(bound);trace.finishFontRefreshQuery(bound,page)
  assert(!events.some(e=>e.stage==='page-view-observed'),'query acceptance was mislabeled as committed view')
  trace.observeFontRefreshPage(page,true);trace.observeFontRefreshPage(page,true)
  assert.equal(events.filter(e=>e.stage==='page-view-observed'&&e.trace.operationId===first.operationId).length,1)
  for(const reason of ['closing','query-failed','query-rejected','query-disposed','superseded-refresh']) {
    const t=begin(),b=trace.bindFontRefreshQuery(owner,++owner.current,'tags'),value={items:[]}
    if(reason==='superseded-refresh')trace.noteFontRefreshRequest(owner)
    else if(reason==='closing')trace.cancelFontRefreshObservation(owner,reason)
    else trace.finishFontRefreshQuery(b,undefined,reason)
    trace.finishFontRefreshQuery(b,value);trace.observeFontRefreshPage(value,true)
    assert(events.some(e=>e.trace?.operationId===t.operationId&&e.reason===reason));assert(!events.some(e=>e.trace?.operationId===t.operationId&&e.stage==='page-view-observed'))
  }
  const closed=trace.createFontOperationTrace('tag-recovery');trace.withFontRefreshTrace(closed,()=>trace.noteFontRefreshRequest(owner,'closing'));assert(events.some(e=>e.trace?.operationId===closed.operationId&&e.reason==='closing'),'recovery returning after close needs its own terminal')
  const changed=begin();trace.noteFontQueryScope(owner,'other');assert(events.some(e=>e.trace?.operationId===changed.operationId&&e.reason==='view-scope-changed'))
  const absent=trace.createFontOperationTrace('tag-recovery');trace.noteFontQueryScope(owner,undefined);trace.withFontRefreshTrace(absent,()=>trace.noteFontRefreshRequest(owner));assert(events.some(e=>e.trace?.operationId===absent.operationId&&e.reason==='no-query'))
  trace.noteFontQueryScope(owner,'tags');const old=begin(),oldRequest=trace.bindFontRefreshQuery(owner,++owner.current,'tags'),latest=begin();trace.finishFontRefreshQuery(oldRequest,{},'late');assert(!events.some(e=>e.trace?.operationId===latest.operationId&&e.stage==='page-observation-ended'),'late old owner canceled latest observation')
  trace.cancelFontRefreshObservation(owner,'closing')
  // Actual query hook must attach only its accepted result, then await the view owner.
  const {setup}=require('./check-browse-metrics-reuse.cjs'),timers=new Map();let timer=0
  const browser={hfm:window.hfm,setTimeout:fn=>{timers.set(++timer,fn);return timer},clearTimeout:id=>timers.delete(id)}
  const h=setup({globals:{window:browser}}),noop=()=>{},runtime=h.load('src/renderer/src/fontOperationTrace.ts')
  const key=h.load('src/renderer/src/constants/queryCacheRuntime.ts').rendererFontQueryCacheKey
  h.app.rendererFontQueryCacheKey=key
  const options={...h.opts,library:{...h.opts.library,folders:['C:/fixture']},hfm:{queryFontPage:async request=>({items:[],total:0,offset:request.offset,limit:request.limit,queryKey:key(request),engine:'sql',elapsedMs:0,truncated:false})},libraryLoadedRef:{current:true},databaseRefreshToken:0,databaseQueryFailedKey:'',virtualViewport:{width:600,height:400,scrollTop:0},viewLayout:{rowHeight:100,minCardWidth:100},allFontsLength:0,indexingActive:false,selectedFontId:'',selectedFontIds:[],fontListScrollingRef:{current:false},fontMetricsRequestSeqRef:{current:0},databasePageRequestSeqRef:{current:0},rendererUserActive:()=>false,reportTrace:noop,setDatabaseFontMetrics:noop,setDatabaseQueryResult:noop,setDatabaseQueryFailedKey:noop,setLibrary:noop,setStatus:noop,setDatabasePageResult:value=>{options.databasePageResult=value}}
  const render=()=>{h.hook.begin();h.load('src/renderer/src/runtime/database/useRendererDatabasePageRuntime.ts').useRendererDatabasePageRuntime(options);h.hook.flush()}
  const dispatch=async()=>{for(const [id,fn] of timers){timers.delete(id);fn()}for(let i=0;i<40;i++)await Promise.resolve()}
  render();await dispatch()
  const operation=runtime.createFontOperationTrace('tag-recovery');options.databasePageRequestSeqRef.current++;runtime.withFontRefreshTrace(operation,()=>runtime.noteFontRefreshRequest(options.databasePageRequestSeqRef));options.databaseRefreshToken++;render();await dispatch()
  assert(events.some(e=>e.trace?.operationId===operation.operationId&&e.stage==='page-query-accepted'),'real query hook omitted accepted-page association')
  runtime.observeFontRefreshPage(options.databasePageResult,true);assert(events.some(e=>e.trace?.operationId===operation.operationId&&e.stage==='page-view-observed'))
  h.hook.cleanup()
}

async function main() {
  const only = process.argv[2]
  if(!only || only==='refresh')refreshCheck()
  if(!only || only==='sync')await syncCheck()
  if(!only){
    await metricsFailureCheck()
    await recoveryPageObservation()
    refreshCheck(s=>s.replace(/\r?\n/g,'\r\n'))
    await syncCheck(s=>s.replace(/\r?\n/g,'\r\n'))
    assert.throws(()=>refreshCheck(s=>s.replace('options.setDatabaseRefreshToken((value) => value + 1)','options.setDatabaseFontMetrics(null)\n  options.setDatabaseRefreshToken((value) => value + 1)')),/retain last authoritative/)
    assert.throws(()=>refreshCheck(s=>s.replace('options.setDatabaseRefreshToken((value) => value + 1)','options.setDatabasePageResult(null)\n  options.setDatabaseRefreshToken((value) => value + 1)')),/retain same-scope/)
    await assert.rejects(()=>syncCheck(s=>s.replace("value.startsWith('shared-favorite-')","false")),/only affected root/)
    await assert.rejects(()=>syncCheck(s=>s.replace('changedRoot !== undefined && nextEntry.root !== changedRoot','false')),/only affected root/)
  }
  console.log('[diagnostics:operation-refresh-scope] retained metrics/request invalidation, 60 real sync routing cases, LF/CRLF and four mutants passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
