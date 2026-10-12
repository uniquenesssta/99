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
async function syncCheck(transform = x => x, syncTransform = x => x) {
  const {createMergedRootProjectionFixture}=require('./helpers/mergedIndexRootProjectionFixture.cjs')
  const f=createMergedRootProjectionFixture({native:true,transforms:{[path.join(root,policyFile)]:transform,[path.join(root,syncFile)]:syncTransform}})
  const a={...f.fresh.get(f.a)},b={...f.fresh.get(f.b)},before=f.key([a,b])
  const originalRows=f.db.prepare('SELECT * FROM entries').all(),read=f.source.readMergedRowsForSource,readScopes=[]
  f.source.readMergedRowsForSource=async(source,paths)=>{readScopes.push({root:source.root,paths});return read(source,paths)}
  f.build.rebuildMergedIndexDb=async()=>assert.fail('root operation escaped to a whole-library rebuild')
  let opened=0,closed=0;const open=f.ctx.openMergedIndexDb
  f.ctx.openMergedIndexDb=async()=>{opened++;return open()};f.ctx.closeSqliteDb=()=>closed++
  const reasons = ['shared-favorite-set','shared-favorite-clear','shared-delete-protection-set','shared-delete-protection-clear','shared-tags-batch-authority-refresh','shared-tag-delete:test']
  try {
    for (const snapshot of [false,true]) for (const reason of reasons) for (const mode of ['metadata','index-changed','install-changed','other-root','roots-changed']) {
      f.setRoots([f.a,f.b]);f.setBeforeQueue(null)
      f.fresh.set(f.a,{...a,sharedMetadataSignature:'metadata-v2|2',...(mode==='index-changed'?{indexSignature:'root-v3|2'}:mode==='install-changed'?{installSignature:'install-content-v1|2'}:{})})
      f.fresh.set(f.b,{...b,...(mode==='other-root'?{sharedMetadataSignature:'metadata-v2|peer-new'}:{})})
      f.writeSource(null,a,'before');f.writeSource(null,b,'before');f.setMeta(null,'sourcesKey',before)
      f.db.exec('DELETE FROM entries');for(const row of originalRows)f.ctx.mergedIndexInsertStatement().run(row)
      for(const list of [f.nativeInputs,f.commits,f.resolves,readScopes])list.length=0
      opened=closed=0
      const retainedPeer=JSON.stringify(f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.b))
      const retainedTarget=JSON.stringify(f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.a))
      if(mode==='roots-changed')f.setBeforeQueue(async()=>f.setRoots([f.b]))
      const operation=()=>snapshot?f.sync.syncMergedIndexForRootSnapshot(f.a,reason):f.sync.syncMergedIndexForRootIncremental(f.a,{upserts:[{id:'a',path:path.join(f.a,'a.ttf')}],deletes:[]},reason)
      if(mode==='roots-changed') {
        await assert.rejects(operation,/roots-changed/,'changed root configuration was acknowledged')
        assert.equal(f.nativeInputs.length,0);assert.equal(f.commits.length,0)
        assert.equal(f.ctx.getSqliteMeta(null,'sourcesKey'),before)
        assert.deepEqual(f.db.prepare('SELECT * FROM entries').all(),originalRows)
      } else {
        await operation()
        const fullSnapshot=snapshot||['index-changed','install-changed'].includes(mode)
        assert.equal(f.nativeInputs.length,1,`${reason}/${snapshot}/${mode}: only affected root may be projected`)
        const input=f.nativeInputs[0]
        assert.equal(input.source.root,f.a);assert.equal(input.fullSnapshot,fullSnapshot,`${reason}/${snapshot}/${mode}: only affected root must use its compatible projection`)
        assert.equal(input.preserveSourceCheckpoint,!fullSnapshot,'partial metadata projection must preserve whole-root checkpoint')
        assert.equal(readScopes.length,1);assert.equal(readScopes[0].root,f.a)
        assert.deepEqual(readScopes[0].paths,fullSnapshot?undefined:['a.ttf'])
        assert.equal(f.commits.length,1)
        if(fullSnapshot)assert.equal(f.ctx.getSqliteMeta(null,'sourcesKey'),f.key([f.fresh.get(f.a),b]),'target snapshot certified an unverified peer')
        else {
          assert.equal(f.ctx.getSqliteMeta(null,'sourcesKey'),before,'partial metadata rows advanced whole-root certificate')
          assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.a)),retainedTarget)
        }
      }
      assert(f.resolves.every(roots=>roots.length===1&&roots[0]===f.a),'only affected root may be resolved')
      assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sources WHERE root_path=?').get(f.b)),retainedPeer,'unrelated peer receipt was changed')
      assert.equal(f.ctx.mergedIndexReadyProcessKeys.size,0);assert.equal(closed,opened,'projection leaked a local handle')
    }
    // Root-local application no longer feeds peer receipts into its eligibility
    // check; retain the multi-source policy's independent scope boundary too.
    const policy=f.load(policyFile)
    const target=f.ctx.normalizePathForCacheCompare(f.a)
    assert.equal(policy.sourceKeyChangedOnlyBySharedMetadata(f.key([a,b]),f.key([{...a,sharedMetadataSignature:'metadata-v2|target-new'},b]),target),true,'only affected root must retain its metadata policy')
    assert.equal(policy.sourceKeyChangedOnlyBySharedMetadata(f.key([a,b]),f.key([a,{...b,sharedMetadataSignature:'metadata-v2|peer-new'}]),target),false,'only affected root may qualify a multi-source metadata change')
  } finally {f.db.close()}
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
    await assert.rejects(()=>syncCheck(s=>s,s=>{const before='preserveSourceCheckpoint: !fullSnapshot';assert(s.includes(before),'partial checkpoint mutation anchor missing');return s.replace(before,'preserveSourceCheckpoint: false')}),/partial metadata projection must preserve whole-root checkpoint/)
  }
  console.log('[diagnostics:operation-refresh-scope] retained metrics/request invalidation, 60 real SQLite target-scope routing cases, partial checkpoint/peer preservation, LF/CRLF and five mutants passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
