#!/usr/bin/env node
// Controlled hook/clock ports; real derived functions, coalescer and metrics effect.
// This is a correctness/count gate, NOT a browser/paint benchmark.
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { loadModules, font, plain, tick } = require('./check-activation-entry.cjs')
const root = path.resolve(__dirname, '../..'), r = 'src/renderer/src/'
const browseFile = r + 'runtime/app/useBrowseDerivedRuntime.ts'
const baseline = '08c07c7ecd6b58c6fb24481cef5f8ccaaa173a5a'
const noop = () => {}, deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
let checks = 0
function eq(a,b,message) { assert.deepEqual(plain(a),plain(b),message); checks++ }
function same(a,b,message) { assert.equal(a,b,message); checks++ }
function hookPort() {
  const slots=[]; let index=0, effects=[]
  return {
    begin() { index=0; effects=[] }, flush() { for(const effect of effects)effect() }, cleanup() { for(const slot of slots)slot?.cleanup?.() },
    useMemo(fn,deps) { const i=index++, old=slots[i]; if(!old || deps.some((d,n)=>!Object.is(d,old.deps[n])))slots[i]={deps,value:fn()}; return slots[i].value },
    useRef(value) { const i=index++; return slots[i] ||= {current:value} },
    useState(value) { const i=index++; slots[i] ||= {value}; return [slots[i].value,v=>slots[i].value=typeof v==='function'?v(slots[i].value):v] },
    useEffect(fn,deps) { const i=index++,old=slots[i]; if(!old || !deps || deps.some((d,n)=>!Object.is(d,old.deps[n])))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()}}) }
  }
}
function setup({source,globals={}}={}) {
  const hook=hookPort(), app={}, mocks={react:hook,[path.join(root,r+'appRuntime.ts')]:app}
  const transforms=source ? {[path.join(root,browseFile)]:()=>source} : {}
  const load=loadModules({window:{},...globals},mocks,transforms)
  Object.assign(app,load(r+'appConstants.ts'),load(r+'fontFilteringMetrics.ts'),load(r+'libraryNormalize.ts'),{traceRendererSyncComputation:(_label,_details,fn)=>fn(),rendererFontQueryCacheKey:JSON.stringify})
  const fonts=Array.from({length:1499},(_,i)=>({...font(String(i)),family:`Family ${i}`,fullName:`Family ${i} Regular`,fileSize:100000+i,modifiedAt:1710000000000+i,favorite:false}))
  const library={...app.createEmptyLibrary(),fonts:Object.fromEntries(fonts.map(f=>[f.id,f])),localTags:['test'],tags:['shared']}
  const metrics=app.buildFontMetrics(fonts,new Map(fonts.map(f=>[f.id,app.buildFontComputedIndex(f)])),library)
  const opts={library,sidebarPage:'library',databasePageReady:true,databasePageResult:{items:fonts,total:fonts.length,offset:0,limit:fonts.length,queryKey:'test'},databaseFontMetrics:metrics,allFonts:fonts,activeFilter:{kind:'all'},selectedWatchedFolders:[],selectedFormats:[],selectedScripts:[],selectedCategory:'all',selectedTagName:'',selectedSharedTagName:'',selectedFolderId:'',installStatus:'all',timeSortMode:'created',sortMode:'nameAsc',deferredSearch:'',expandedFolderIds:{}}
  const derive=load(browseFile).useBrowseDerivedRuntime
  return {hook,load,app,opts,render(args=opts) {hook.begin();return derive(args)}}
}
function browse() {
  const old=execFileSync('git',['show',`${baseline}:${browseFile}`],{cwd:root,encoding:'utf8'})
  const counts={}
  for(const [name,source] of [['before',old],['after',undefined]]) {
    const h=setup({source}); let options=h.opts,last=h.render(),index=0,visible=0
    for(let i=0;i<40;i++) {
      options={...options,databaseFontMetrics:{...options.databaseFontMetrics,favoriteCount:i}}
      const next=h.render(options); index+=Number(last.fontIndexById!==next.fontIndexById); last=next
    }
    for(let i=0;i<40;i++) {
      options={...options,library:{...options.library,previewText:`text-${i}`}}
      const next=h.render(options); visible+=Number(last.visibleFonts!==next.visibleFonts);last=next
    }
    counts[name]={metricsIndexRebuilds:index,textVisibleRebuilds:visible}
  }
  eq(counts.before,{metricsIndexRebuilds:40,textVisibleRebuilds:40},'old source must reproduce the amplification')
  eq(counts.after,{metricsIndexRebuilds:0,textVisibleRebuilds:0},'unrelated changes rebuilt derived data')
  for(const databasePageReady of [true,false]) {
    const h=setup();let options={...h.opts,databasePageReady},last=h.render(options)
    const reference=args=>h.load(r+'fontViewRuntime.ts').buildVisibleFonts({...args,fontIndexById:new Map((args.databasePageReady && args.databaseFontMetrics ? args.databasePageResult?.items || [] : args.allFonts).map(f=>[f.id,h.app.buildFontComputedIndex(f)]))})
    const apply=patch=>{options={...options,...patch};last=h.render(options);eq(last.visibleFonts,reference(options),'memo differs from uncached real derivation')}
    apply({library:{...options.library,previewText:'new'}})
    const index=last.fontIndexById
    apply({databaseFontMetrics:{...options.databaseFontMetrics,favoriteCount:9}})
    same(last.fontIndexById,index,'count-only update rebuilt index')
    apply({deferredSearch:'0'})
    apply({deferredSearch:'',activeFilter:{kind:'favorites'}})
    const changed={...options.allFonts[0],favorite:true,active:true,deleteProtected:true,localTagNames:['changed']}
    const allFonts=[changed,...options.allFonts.slice(1)]
    apply({allFonts,library:{...options.library,fonts:{...options.library.fonts,[changed.id]:changed},localTags:['changed']}})
    same(last.visibleFonts[0].id,changed.id,'favorite overlay omitted')
    apply({activeFilter:{kind:'active'}})
    same(last.visibleFonts[0].id,changed.id,'active overlay omitted')
    apply({activeFilter:{kind:'all'},sidebarPage:'tags',selectedTagName:'changed'})
    same(last.visibleFonts.length,1,'tag membership stale')
    apply({sidebarPage:'library',selectedTagName:'',library:{...options.library,tags:[],localTags:[],__sharedTagAuthorityKnown:true,__localTagAuthorityKnown:true}})
    if(databasePageReady) {same(last.visibleFonts[0].tagNames.length,0,'deleted shared tags survived');same(last.visibleFonts[0].localTagNames.length,0,'deleted local tags survived')}
    if(databasePageReady) {
      apply({library:{...options.library,__sharedTagAuthorityKnown:false,__localTagAuthorityKnown:false}})
      same(last.visibleFonts[0].tagNames.length,1,'unknown shared authority unexpectedly removed tags')
      same(last.visibleFonts[0].localTagNames.length,1,'unknown local authority unexpectedly removed tags')
      apply({library:{...options.library,__sharedTagAuthorityKnown:true}})
      same(last.visibleFonts[0].tagNames.length,0,'shared authority flag alone was ignored')
      apply({library:{...options.library,__localTagAuthorityKnown:true}})
      same(last.visibleFonts[0].localTagNames.length,0,'local authority flag alone was ignored')
    }
    apply({installStatus:'notInstalled'})
    apply({installStatus:'installed'})
    same(last.visibleFonts.length,0,'installation filter stale')
    apply({installStatus:'all',databasePageReady:false,sidebarPage:'folders',selectedFolderId:'virtual',library:{...options.library,fontFolderIds:{[changed.id]:['virtual']}}})
    same(last.visibleFonts.length,1,'new folder binding missed')
    apply({library:{...options.library,fontFolderIds:{}}})
    same(last.visibleFonts.length,0,'removed folder binding missed')
    apply({sidebarPage:'library',databasePageReady:true,databasePageResult:{...options.databasePageResult,items:allFonts.slice(0,10)}})
    same(last.fontIndexById.size,10,'database source not selected')
    apply({databaseFontMetrics:null})
    same(last.fontIndexById.size,1499,'fallback must index the complete source')
    apply({databaseFontMetrics:h.opts.databaseFontMetrics,databasePageResult:null})
    same(last.fontIndexById.size,0,'missing page must use empty source')
    const emptyIndex=last.fontIndexById
    apply({library:{...options.library,previewMode:'grid'}})
    same(last.fontIndexById,emptyIndex,'unstable empty source')
  }
  console.log('U-08 controlled 1499-font / 40-update counts:',JSON.stringify(counts))
}
async function coalescer() {
  let now=1000; class Clock extends Date {static now(){return now}}
  const h=setup({globals:{Date:Clock}}),logs=[]
  const owner=h.load('src/main/library/fontMetricsRequestCoalescerRuntime.ts').createFontMetricsRequestCoalescerRuntime(2500)
  let loads=0,gate=deferred();const args={appendLog:s=>logs.push(s),load:()=>{loads++;return gate.promise},key:'metrics:test'}
  const a=owner.run(args),b=owner.run(args);same(loads,1,'same key not coalesced');now+=37;gate.resolve(h.opts.databaseFontMetrics);await Promise.all([a,b])
  await owner.run(args);same(loads,1,'warm result reloaded')
  assert(logs.some(s=>s.includes('stage=load-end, elapsed=37ms')));checks++
  assert(logs.some(s=>s.includes('stage=joined, elapsed=37ms')));checks++
  assert(logs.some(s=>s.includes('stage=cache-hit')));checks++
  now+=2501;gate=deferred();const stale=owner.run(args);owner.clear();const newest={...h.opts.databaseFontMetrics,favoriteCount:321};const newGate=deferred();args.load=()=>{loads++;return newGate.promise};const fresh=owner.run(args)
  gate.resolve(h.opts.databaseFontMetrics);await tick();newGate.resolve(newest)
  same((await stale).favoriteCount,321,'invalidated read returned stale counts');same((await fresh).favoriteCount,321)
  assert(logs.some(s=>s.includes('stage=invalidated-reread')));checks++
  owner.clear();args.load=async()=>{throw Error('read error')};await assert.rejects(owner.run(args),/read error/);checks++
  args.load=async()=>newest;await owner.run(args)
  assert(logs.some(s=>s.includes('stage=load-error')));checks++
  owner.clear();args.appendLog=()=>{throw Error('log failed')};same((await owner.run(args)).favoriteCount,321,'new tracing changed read result')
}
async function facadeTiming() {
  let now=0;class Clock extends Date {static now(){return now}}
  const h=setup({globals:{Date:Clock}}),logs=[]
  const options={appendLog:s=>logs.push(s),appWatchedFolders:async()=>{now+=10;return []},
    reconcileLocalUserMetrics:async metrics=>{now+=25;return {...metrics,favoriteCount:7}}}
  const runtime=h.load('src/main/library/fontQueryFacadeRuntime.ts').createFontQueryFacadeRuntime(options)
  same((await runtime.getFontMetricsFromLibrary()).favoriteCount,7)
  assert(logs.some(s=>s.includes('outcome=ok, query=10ms, localUser=25ms, total=35ms')));checks++
  const count=logs.filter(s=>s.startsWith('font metrics stages:')).length
  await runtime.getFontMetricsFromLibrary();same(logs.filter(s=>s.startsWith('font metrics stages:')).length,count,'cache hit did a new underlying read')
  runtime.clearFontMetricsQueryCache()
  options.reconcileLocalUserMetrics=async()=>{now+=8;throw Error('local user read failed')}
  await assert.rejects(runtime.getFontMetricsFromLibrary(),/local user read failed/);checks++
  assert(logs.some(s=>s.includes('outcome=error, query=10ms, localUser=8ms, total=18ms')));checks++
  options.reconcileLocalUserMetrics=async metrics=>metrics
  options.appendLog=()=>{throw Error('diagnostic sink failed')}
  await runtime.getFontMetricsFromLibrary();checks++
}
async function rendererMetrics() {
  let now=0,timerId=0;const timers=new Map(),traces=[],writes=[],pending=[]
  const window={setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId},clearTimeout:id=>timers.delete(id)}
  const h=setup({globals:{window,performance:{now:()=>now}}}),hook=h.hook
  const options={...h.opts,library:{...h.opts.library,folders:['C:/fixture']},hfm:{getFontMetrics:()=>{const gate=deferred();pending.push(gate);return gate.promise}},skipPageQuery:true,libraryLoadedRef:{current:true},databaseRefreshToken:0,databaseMetricsRefreshToken:0,databaseQueryFailedKey:'',virtualViewport:{width:600,height:400,scrollTop:0},viewLayout:{rowHeight:100,minCardWidth:100},allFontsLength:1499,indexingActive:false,selectedFontId:'',selectedFontIds:[],fontListScrollingRef:{current:false},fontMetricsRequestSeqRef:{current:0},databasePageRequestSeqRef:{current:0},rendererUserActive:()=>false,reportTrace:e=>traces.push(e),setDatabaseFontMetrics:x=>writes.push(x),setDatabasePageResult:noop,setDatabaseQueryResult:noop,setDatabaseQueryFailedKey:noop,setLibrary:noop,setStatus:noop}
  const render=()=>{hook.begin();h.load(r+'runtime/database/useRendererDatabasePageRuntime.ts').useRendererDatabasePageRuntime(options);hook.flush()}
  const dispatch=()=>{const [id,timer]=[...timers][0];timers.delete(id);now+=timer.delay+7;timer.fn();return timer.delay}
  render();const delay=dispatch();now+=34;pending[0].resolve({...h.opts.databaseFontMetrics,elapsedMs:12});await tick()
  const start=traces.find(e=>e.kind==='db-metrics-start'),end=traces.find(e=>e.kind==='db-metrics-end')
  same(start.details.queueMs,delay+7);same(start.details.scheduledDelayMs,delay);same(end.durationMs,34);same(end.details.totalMs,delay+7+34);same(end.details.elapsedMs,12);same(writes.length,1)
  options.databaseMetricsRefreshToken++;render();options.databaseMetricsRefreshToken++;render()
  assert(traces.some(e=>e.kind==='db-metrics-cancelled'&&e.label==='queued'));checks++
  dispatch();options.databaseMetricsRefreshToken++;render();pending[1].resolve(h.opts.databaseFontMetrics);await tick()
  same(writes.length,1,'old request was applied');assert(traces.some(e=>e.kind==='db-metrics-rejected'&&e.label==='obsolete-request'));checks++
  dispatch();pending[2].reject(Error('retryable'));await tick();same(writes.length,1,'failure replaced existing counts')
  hook.cleanup()
}
async function run(){browse();await coalescer();await facadeTiming();await rendererMetrics();console.log(`[diagnostics:browse-metrics-reuse] ${checks} checks passed (controlled ports; browser timings separate)`)}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1})
module.exports={setup,hookPort,browse,coalescer,rendererMetrics}
