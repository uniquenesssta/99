const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const root=path.resolve(__dirname,'../..'),base='src/renderer/src/'
const plain=x=>JSON.parse(JSON.stringify(x))
function loader(mocks={},globals={},transforms={}){
 const cache=new Map()
 function load(file){
  if(cache.has(file))return cache.get(file)
  const exports={};cache.set(file,exports)
  let source=fs.readFileSync(path.join(root,file),'utf8')
  if(process.argv[2]==='favorite')source=source.replace("void flush('favorite-immediate')",'scheduleFlush()')
  if(process.argv[2]==='idle')source=source.replace('options.delay <= 0','false')
  if(process.argv[2]==='batch')source=source.replace('itemResult?.ok !== true','itemResult && itemResult.ok === false')
  if(process.argv[2]==='metrics')source=source.replaceAll('pendingFavorite || intentRevision !== fontUserIntentRevision()','false')
  if(transforms[file])source=transforms[file](source)
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,console,performance,...globals,require(id){if(id in mocks)return mocks[id];if(id.startsWith('node:'))return require(id);if(id.startsWith('.'))return load(path.relative(root,path.resolve(root,path.dirname(file),id+'.ts')));throw Error(id)}})
  return exports
 }return load
}
const drain=async()=>{for(let i=0;i<30;i++)await Promise.resolve()}
async function feedbackLatency(){
 const load=loader(),timers=[],refresh=[],calls=[]
 const q=load(base+'fontWriteQueue.ts')
 const opts={queueRef:{current:q.createEmptyQueuedFontWriteState()},timerRef:{current:null},retryTimerRef:{current:null},retryAttemptRef:{current:0},activeRef:{current:false},activePromiseRef:{current:null},getFolders:()=>[],writeBehindDelayMs:360,writeBehindMaxItems:120,writeBehindMaxBufferBytes:99999,memoryPressure:()=> 'normal',setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimeout(){},setStatus(){},scheduleDatabaseDerivedStateRefresh:d=>refresh.push(d),hfm:{setFavorite:async()=>{calls.push('write');return {ok:true,updatedIds:['a'],failed:[]}}}}
 const r=load(base+'fontWriteQueueRuntime.ts').createRendererFontWriteQueueRuntime(opts)
 r.queueFavoriteWrite({id:'a'},true)
 await drain()
 assert.equal(calls.length,1,'favorite write must start without 360ms timer')
 assert.equal(refresh[0],0,'committed favorite must not wait for idle refresh')
 let token=0,idle=0
 const d=load(base+'databaseDerivedStateRuntime.ts')
 d.scheduleDatabaseDerivedStateRefreshRuntime({timerRef:{current:null},delay:0,clearTimeout(){},setTimeout:fn=>{fn();return 1},requestIdleWindow(){idle++;},rendererUserActive:()=>true,scheduleAgain(){throw Error('must not defer explicit commit')},setDatabaseRefreshToken:fn=>token=fn(token)})
 assert.equal(token,1);assert.equal(idle,0)
}
async function batchSettlement(){
 const load=loader({'../../../appRuntime':{fontDisplayName:f=>f.id,isInstalled:f=>f.systemInstalled}})
 for(const mode of ['success','partial','missing','throw']){
  const f=id=>({id,active:true,activeSince:'before',favorite:true,systemInstalled:false,localTagNames:['L'],tagNames:['S'],deleteProtected:true})
  let library={fonts:{a:f('a'),b:f('b')}},metrics={activeCount:2};let refresh=0
  const messages=[],busy=new Set()
  const options={get library(){return library},activeOperationFontIds:{current:busy},setLibrary:fn=>library=fn(library),setDatabaseFontMetrics:fn=>metrics=fn(metrics),setStatus:s=>messages.push(s),refreshDatabaseDerivedState:()=>refresh++,hfm:{deactivateFonts:async()=>{if(mode==='throw')throw Error('fail');return {message:'done',results:mode==='missing'?{a:{ok:true}}:{a:{ok:true},b:{ok:mode==='success'}}}}}}
  const state=load(base+'runtime/system/actions/fontSystemStateRuntime.ts').createFontSystemStateRuntime(options)
  const r=load(base+'runtime/system/actions/fontActivationActionRuntime.ts').createFontActivationActionRuntime(options,state)
  await r.deactivateFontsBatch(Object.values(library.fonts),'test')
  const expected=mode==='success'?0:mode==='throw'?2:1
  assert.equal(metrics.activeCount,expected,mode)
  assert.equal(Object.values(library.fonts).filter(f=>f.active).length,expected,mode)
  assert.equal(refresh,1,mode+' must reconcile after batch')
  for(const f of Object.values(library.fonts)){assert(f.favorite&&f.deleteProtected);assert.deepEqual(plain(f.tagNames),['S']);assert.equal(f.activeSince,f.active?'before':undefined)}
  assert.equal(busy.size,0)
 }
}
async function main(){await feedbackLatency();await batchSettlement();await singleAndActivateBatch();await metricsRace();await restartPolicy();viewScopeMatrix();if(!process.argv[2])for(const mutant of ['favorite','idle','batch','metrics']){
 const r=require('node:child_process').spawnSync(process.execPath,[__filename,mutant],{encoding:'utf8'});assert.notEqual(r.status,0,mutant+' escaped');assert(r.stderr.includes('AssertionError'),r.stderr)
 }console.log('A-02 immediate favorite/no idle starvation, single/batch settlement, stale metrics, startup cleanup; four mutations rejected')}
main().catch(e=>{console.error(e);process.exitCode=1})

async function singleAndActivateBatch(){
 const pure=loader(),app={...pure(base+'fontDisplay.ts'),...pure(base+'fontSelectionRuntime.ts')}
 const load=loader({'../../../appRuntime':app})
 for(const mode of ['single-ok','single-reject','batch-partial','batch-missing']){
  let library={fonts:{a:{id:'a',fileName:'a.ttf',path:'/a.ttf',active:false,systemInstalled:false,favorite:true},b:{id:'b',fileName:'b.ttf',path:'/b.ttf',active:false,systemInstalled:false,favorite:false}}},metrics={activeCount:0}
  let resolve;const response=new Promise(r=>resolve=r),busy=new Set();let nativeCalls=0
  const options={get library(){return library},activeOperationFontIds:{current:busy},setLibrary:fn=>library=fn(library),setDatabaseFontMetrics:fn=>metrics=fn(metrics),setStatus(){},refreshDatabaseDerivedState(){},hfm:{activateFont:()=>{nativeCalls++;return response},activateFonts:()=>response}}
  const state=load(base+'runtime/system/actions/fontSystemStateRuntime.ts').createFontSystemStateRuntime(options)
  const action=load(base+'runtime/system/actions/fontActivationActionRuntime.ts').createFontActivationActionRuntime(options,state)
  const batch=mode.startsWith('batch')
  const task=batch?action.activateFontsBatch(Object.values(library.fonts),'batch'):action.activateFontByCard(library.fonts.a)
  assert.equal(metrics.activeCount,batch?2:1,'optimistic active count')
  assert(library.fonts.a.activeSince,'detail timestamp available during pending')
  if(!batch){await action.activateFontByCard(library.fonts.a);assert.equal(nativeCalls,1,'duplicate click must not dispatch twice')}
  resolve(batch?{message:'batch',results:{a:{ok:true,temporaryActivated:true},...(mode==='batch-partial'?{b:{ok:false}}:{})}}:{message:'single',temporaryActivated:mode==='single-ok'})
  await task
  assert.equal(metrics.activeCount,mode==='single-reject'?0:1)
  assert.equal(library.fonts.a.active,mode!=='single-reject');assert.equal(library.fonts.b.active,false)
  assert.equal(busy.size,0)
 }
}
async function metricsRace(){
 for(const mode of ['old-success','old-error','pending-favorite','current']){
  const effects=[],timers=[],stop={},traces=[];let resolve,reject,writes=0
  const response=new Promise((a,b)=>{resolve=a;reject=b})
  const load=loader({react:{useState:()=>[0,()=>{}],useEffect:fn=>effects.push(fn),useMemo:()=>{throw stop}},'../../appRuntime':{normalizeFontMetricsResult:x=>x},'../../fontViewRuntime':{},'./rendererDatabasePageWindowRuntime':{}},{window:{setTimeout:fn=>{timers.push(fn);return 1},clearTimeout(){}}})
  const intent=load(base+'fontUserIntentRuntime.ts')
  const font=mode==='pending-favorite'?intent.markFavoriteIntent({id:'a'},true):{id:'a'}
  const options={virtualViewport:{width:500,height:500,scrollTop:0},viewLayout:{rowHeight:100,minCardWidth:100},library:{folders:['/fonts'],fonts:{a:font}},hfm:{getFontMetrics:()=>response},fontMetricsRequestSeqRef:{current:0},rendererUserActive:()=>false,reportTrace:e=>traces.push(e),setDatabaseFontMetrics:()=>writes++}
  try{load(base+'runtime/database/useRendererDatabasePageRuntime.ts').useRendererDatabasePageRuntime(options)}catch(e){assert.equal(e,stop)}
  effects[0]();timers[0]()
  if(mode.startsWith('old'))intent.markActiveIntent({id:'a',active:false})
  if(mode==='old-error')reject(Error('old failure'));else resolve({activeCount:4})
  await drain();assert.equal(writes,mode==='current'?1:0,mode)
  if(mode!=='current')assert(traces.some(e=>e.kind==='db-metrics-rejected'))
 }
}

async function restartPolicy(){
 let saved={version:1,records:[{fontId:'a',installPath:'/managed/a.ttf',registryName:'a'}]},disk=null,removed=0,installedRows={},temporary=new Map()
 const load=loader({
  'node:fs':{promises:{mkdir:async()=>{},readFile:async()=>{if(disk===null)throw Object.assign(Error('missing'),{code:'ENOENT'});return disk},open:async p=>({writeFile:async s=>temporary.set(p,s),sync:async()=>{},close:async()=>{}}),rename:async p=>{disk=temporary.get(p);temporary.delete(p)},rm:async p=>temporary.delete(p)}},
  '../temporaryFontDeleteQueue':{createTemporaryFontDeleteQueue:()=>({isSafeTemporaryActiveFontPath:()=>true,queueTemporaryFontFileDeletes:async()=>({}),flushPendingTemporaryFontDeletes:async()=>{}})},
  '../../rust-core/nodeBridgeFallbackCompatibilityRuntime':{}
 },{process:{platform:'win32',env:{}}})
 const deps={normalizePathForCacheCompare:x=>x||'',getSystemInstalledFontsCached:async()=>[],compareFontInstalledWithList:()=>({installed:false,by:'none',matches:[]}),scheduleActivationInstallStatusSave:rows=>{installedRows=rows},isTemporaryActiveInstalledRecord:()=>false,appName:'test',dataRoot:()=>'/data',dataPath:()=>'/data/session.json',currentUserFontsDir:()=>'/managed',removeFontResourceSession:async()=>{removed++},deleteRegistryValueHKCU:async()=>{},advancedFontRefresh:async()=>{},clearInstalledFontsMemoryCache(){},appendStartupLog(){},loadTemporaryActiveFonts:async()=>saved,saveTemporaryActiveFonts:async s=>saved=s,runRustFontActivationFiles:async()=>({deleteResults:[{ok:true}]})}
 const cleanup=load('src/main/activation/runtime/fontActivationCleanupRuntime.ts').createFontActivationCleanupRuntime(deps,{temporaryActiveRecordStillVisible:async()=>false})
 const result=await cleanup.cleanupTemporaryActiveFonts('startup')
 assert.equal(result.remaining,0);assert.equal(removed,1);assert.equal(saved.records.length,0);assert.equal(installedRows.a.by,'none','startup cleanup left persisted active state stale')
 const store=load('src/main/windows/runtime/temporaryActiveFontsStoreRuntime.ts').createTemporaryActiveFontsStoreRuntime(deps)
 await store.saveTemporaryActiveFonts(saved)
 assert.equal((await store.loadTemporaryActiveFonts()).records.length,0,'restart must use cleaned persisted session')
 const lifecycle=fs.readFileSync(path.join(root,'src/main/app/mainProcessLifecycleRuntime.ts'),'utf8')
 assert(lifecycle.includes('cleanupTemporaryActiveFontsUntilEmpty("startup", 6)'))
 assert(lifecycle.includes('cleanupTemporaryActiveFontsUntilEmpty("quit")'))
}

function viewScopeMatrix(){
 const load=loader({
 './appConstants':{FONT_CATEGORY_FILTERS:[],FONT_CATEGORY_LABELS:{},SCRIPT_LANGUAGE_LABELS:{},SCRIPT_LANGUAGE_ORDER:['latin']},
 './libraryNormalize':{normalizeFolderPathForCompare:x=>x.toLowerCase(),isDefinitelyBadFontRecord:()=>false},
 '@shared/legacy/legacyCollectionCompatibility':{legacyCollectionIdsForFont:f=>f.collectionIds||[]}
 })
 const filter=load(base+'fontFilteringMetrics.ts'),view=load(base+'fontViewRuntime.ts'),install=load(base+'fontInstallStateRuntime.ts')
 const f=(id,active,systemInstalled)=>({id,path:'/fonts/'+id+'.ttf',fileName:id+'.ttf',family:id,format:'ttf',scripts:['latin'],modifiedAt:1,active,systemInstalled,installStatusKnown:true,systemInstallMatches:[],favorite:true,collectionIds:[],tagNames:[]})
 let fonts=[f('alpha',true,false),f('beta',true,false),f('system',false,true)]
 const library={fonts:Object.fromEntries(fonts.map(f=>[f.id,f])),folders:[],collections:[],tags:[],localTags:[]}
 const indexes=new Map(fonts.map(f=>[f.id,filter.buildFontComputedIndex(f)]))
 const options={databasePageReady:false,databasePageResult:null,allFonts:fonts,fontIndexById:indexes,deferredSearch:'alpha',sidebarPage:'library',activeFilter:{kind:'active'},timeSortMode:'all',sortMode:'name',library}
 assert.equal(view.buildVisibleFonts(options).length,1)
 assert.equal(filter.buildFontMetrics(fonts,indexes,library).activeCount,2,'global count need not equal search result count')
 library.fonts.alpha=install.applyFontActiveRuntimePatch(library.fonts.alpha,false)
 fonts=Object.values(library.fonts)
 const common={...options,allFonts:fonts,deferredSearch:'',databasePageReady:true,databasePageResult:{items:fonts}}
 assert.deepEqual(plain(view.buildVisibleFonts(common).map(f=>f.id)),['beta'])
 const favorites=view.buildVisibleFonts({...common,activeFilter:{kind:'favorites'}})
 assert.equal(favorites.find(f=>f.id==='alpha').active,false)
 assert.equal(favorites.find(f=>f.id==='system').active,false)
 assert.equal(favorites.find(f=>f.id==='system').systemInstalled,true)
 assert.equal(library.fonts.alpha.activeSince,undefined)
}
