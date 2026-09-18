'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const plain = x => JSON.parse(JSON.stringify(x))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((r,j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const baseline = process.argv.find(x => x.startsWith('--baseline='))?.slice(11)
const selected = process.argv.find(x => x.startsWith('--case='))?.slice(7)
const crlf = process.argv.includes('--crlf')
const mutant = process.argv.find(x => x.startsWith('--mutant='))?.slice(9)
const files = {
  activation: 'src/main/activation/activationInstallStatusSaveQueue.ts',
  incremental: 'src/main/indexing/merged-page/mergedIndexSyncRuntime.ts',
  storage: 'src/main/performance/storageProfileRuntime.ts',
  preview: 'src/renderer/src/runtime/app/usePreviewController.ts',
}
function loadFor(mocks = {}, globals = {}) {
  const transforms = {}
  for (const [key, file] of Object.entries(files)) transforms[path.join(root,file)] = source => {
    source = source.replace(/\r\n/g,'\n')
    if (baseline) source = execFileSync('git', ['show', `${baseline}:${file}`], { cwd:root,encoding:'utf8' })
    if (mutant === key) {
      const [from,to] = {
        activation: ['pendingResults[item.id] || inFlightResults[item.id]', 'inFlightResults[item.id] || pendingResults[item.id]'],
        incremental: ['!rootIndexOnlySourceChange &&\n              !installStatusOnlySourceChange', '!rootIndexOnlySourceChange'],
        storage: ["if (base.reason === 'env-override' || base.isNetwork", "if (base.reason === 'env-override' || false"],
        preview: ['if (!queueRuntimeRef.current) queueRuntimeRef.current =', 'queueRuntimeRef.current ='],
      }[key]
      assert(source.includes(from), 'mutation anchor missing')
      source = source.replace(from,to)
    }
    return crlf ? source.replace(/\r?\n/g,'\r\n') : source
  }
  return loader(mocks, globals, transforms)
}
async function activation() {
  const no = { installed:false, by:'none', matches:[] }, yes = { installed:true, by:'managed', matches:[] }
  const font = { id:'a', path:'/audit/a.ttf', fileName:'a.ttf', active:true, favorite:true, localTagNames:['L'], tagNames:['S'], deleteProtected:true }
  let db = yes, fail = false, readGate, blockedRead, invalidations = 0
  const load = loadFor({}, { setTimeout: (fn,ms) => { if ([120,360,900].includes(ms)) queueMicrotask(fn); return {unref(){}} }, clearTimeout(){} })
  let memory, page
  const queue = load(files.activation).createActivationInstallStatusSaveQueue({
    readInstallStatusIndex: async () => { if (readGate) { const g=readGate; readGate=null; await g.promise } return {results:{a:db},misses:[]} },
    saveInstallStatusIndex: async rows => { if (fail) throw Error('disk'); db=rows.a },
    appWatchedFolders: async()=>['/audit'], rootForFontPath:async()=>'/audit', syncMergedIndexAfterInstallStatusRefresh:async()=>{},
    clearFontQueryCaches(){ invalidations++; memory?.invalidateFontQueryResultCache(); page?.invalidateFontQueryPageCache() }, appendStartupLog(){},
  })
  const facade = load('src/main/library/fontQueryFacadeRuntime.ts').createFontQueryFacadeRuntime({
    applyPendingActivationState: fonts => queue.applyPendingState?.(fonts) || fonts,
    readInstallStatusIndex: async()=>{ const captured=db; if(blockedRead){const g=blockedRead;blockedRead=null;await g.promise} return {results:{a:captured}} }, appendLog(){},
  })
  memory = load('src/main/library/fontMemoryQueryRuntime.ts').createFontMemoryQueryRuntime({resultCacheMax:10,resultCacheTtlMs:1800,appWatchedFolders:async()=>['/audit'],loadSharedFontsForFolders:async()=>[{...font}],hydrateLocalTagsForFonts:async x=>x,hydrateInstallStatusForFonts:facade.hydrateInstallStatusForFonts,normalizePathForCacheCompare:x=>x,isSystemInstalledRecord:()=>false,isPathInWindowsFonts:()=>false,inferFontSearchCategory:()=>''})
  const request={sidebarPage:'library',activeFilter:{kind:'active'}}
  page=load('src/main/library/fontPageQueryCacheRuntime.ts').createFontPageQueryCacheRuntime({pageCacheMax:10,pageCacheTtlMs:1800,appendStartupLog(){},queryUncached:async r=>{const items=await memory.cleanSharedFontsForQuery(r);return {items,total:items.length}}})
  assert.equal((await page.queryFontPageInLibrary(request)).total,1)
  queue.schedule({a:no},new Map([['a',font]]),'deactivate')
  assert.equal((await page.queryFontPageInLibrary(request)).total,0,'warm query returned deactivated font')
  memory.invalidateFontQueryResultCache();page.invalidateFontQueryPageCache()
  assert.equal((await page.queryFontPageInLibrary(request)).total,0,'cold read resurrected old DB state')
  const untouched=queue.applyPendingState([font])[0]
  for(const key of ['favorite','localTagNames','tagNames','deleteProtected'])assert.deepEqual(plain(untouched[key]),plain(font[key]))
  // A newer success must win while an older batch awaits its comparison read.
  readGate=deferred();const gate=readGate;const flushing=queue.flush('audit')
  queue.schedule({a:yes},new Map([['a',font]]),'reactivate')
  assert.equal(queue.applyPendingState([font])[0].active,true,'older in-flight state won over newest intent')
  gate.resolve();await flushing
  assert.equal(db.by,'managed');assert.equal(queue.hasPending(),false)
  fail=true;queue.schedule({a:no},new Map([['a',font]]),'failed-save')
  await assert.rejects(queue.flush('audit'),/disk/)
  assert.equal(queue.applyPendingState([font])[0].active,false,'save retry lost successful OS state')
  fail=false
  memory.invalidateFontQueryResultCache();page.invalidateFontQueryPageCache()
  blockedRead=deferred();const late=blockedRead;const pendingQuery=page.queryFontPageInLibrary(request);await tick()
  await queue.flush('recovery');late.resolve()
  assert.equal((await pendingQuery).total,0,'old DB read escaped after overlay retired')
  assert.equal((await page.queryFontPageInLibrary(request)).total,0,'persisted none must override stale item.active')
  assert(invalidations>=4)
  console.log('W-01 warm/cold, newest intent, failed save/recovery, late read, unrelated fields: passed')
}
async function incremental() {
  const auditRoot=path.resolve('/audit'), otherRoot=path.resolve('/other')
  const load=loadFor(), a={root:auditRoot,indexDbPath:'/i',installDbPath:'/s',indexSignature:'i1',installSignature:'s1',sharedMetadataSignature:'m1'}
  for(const mode of ['install','unchanged','index','other-root','roots']) {
    const b={...a,root:otherRoot}, before=[a,b], after=[{...a,installSignature:mode==='unchanged'?'s1':'s2',...(mode==='index'?{indexSignature:'i2'}:{})},{...b,...(mode==='other-root'?{installSignature:'s2'}:{})}]
    const calls=[];const ctx={normalizePathForCacheCompare:x=>x,runMergedIndexMutation:async(_,fn)=>fn({commit(){}}),appWatchedFolders:async()=>[auditRoot,otherRoot],mergedIndexSourcesKey:()=>JSON.stringify(after),openMergedIndexDb:async()=>({}),getSqliteMeta:()=>JSON.stringify(before),mergedIndexSourcesMatchRoots:()=>mode!=='roots',mergedIndexReadyProcessKeys:new Set(),appendStartupLog(){},closeSqliteDb(){},mergedIndexDbPath:()=>'/merged',schemaVersion:1,rustCoreWorkerRuntime:{runRustMergedIndexSync:async x=>{calls.push(x);return{synced:true,rows:1}}}}
    const runtime=load(files.incremental).createMergedIndexSyncRuntime(ctx,{mergedIndexSourcesForRoots:async()=>after,relativePathsFromFontIndexPayload:(_,p)=>p.upserts.map(x=>path.basename(x.path))},{rebuildMergedIndexDb:async()=>calls.push('rebuild')})
    const validation=load('src/main/indexing/merged-page/mergedIndexValidationRuntime.ts').createMergedIndexValidationRuntime({appendStartupLog(){},delayToEventLoop:async()=>{}},{},{})
    await validation.syncMergedIndexAfterInstallStatusRefresh([auditRoot,auditRoot],async()=>calls.push('snapshot'),[{id:'a',path:path.join(auditRoot,'a.ttf')}],runtime.syncMergedIndexForRootIncremental)
    assert.equal(calls.length,1)
    if(['install','unchanged'].includes(mode)){assert.equal(calls[0].fullSnapshot,false,'single font became full rebuild');assert.deepEqual(plain(calls[0].relativePaths),['a.ttf']);assert.equal(calls[0].source.installDbPath,'/s')}
    else assert.equal(calls[0],'rebuild',mode+' must remain conservative')
  }
  console.log('W-02 one-row install sync, deduped roots, index/other-root/root-set fallback: passed')
}
async function storage() {
  let clock=10000,sync=0;const commands=[]
  class Clock extends Date { static now(){return clock} }
  const load=loadFor({'node:child_process':{execFile:(cmd,args,opts,done)=>{commands.push({cmd,args,opts,done})},execFileSync:()=>{sync++;return ''}}},{Date:Clock})
  const factory=load(files.storage).createStorageProfileRuntime
  const runtime=factory({platform:'win32',env:{},localWorkers:6,networkWorkers:2,windowsMediaDetectEnabled:true,windowsMediaDetectTimeoutMs:2500,verbose:true,logger(){throw Error('log')}})
  const first = runtime.storageProfileForPath('O:\\fonts\\a.ttf')
  assert.equal(sync,0,'foreground synchronous command')
  assert.equal(first.type,'network')
  runtime.storageProfileForPath('O:\\fonts\\b.ttf');assert.equal(sync,0,'foreground synchronous command')
  assert.equal(commands.length,1,'mapping requests not coalesced');assert.equal(commands[0].cmd,'net')
  let heartbeat=false;queueMicrotask(()=>{heartbeat=true});await tick();assert(heartbeat,'probe blocked event loop')
  commands[0].done(null,'OK O: \\\\server\\fonts')
  assert.equal(runtime.storageProfileForPath('O:\\fonts\\a.ttf').reason,'mapped-network-drive','network drive fell into media probing')
  assert.equal(commands.length,1,'mapped drive launched local media probe')
  runtime.storageProfileForPath('C:\\fonts\\a.ttf');runtime.storageProfileForPath('C:\\fonts\\b.ttf')
  assert.equal(commands.length,2);assert.equal(commands[1].cmd,'powershell.exe')
  commands[1].done(Error('timeout'),'');clock+=5001;runtime.storageProfileForPath('C:\\fonts\\a.ttf');assert.equal(commands.length,3)
  commands[2].done(null,'{"MediaType":"SSD","BusType":"NVMe"}')
  assert.equal(runtime.storageProfileForPath('C:\\fonts\\a.ttf').type,'ssd')
  clock+=30001;runtime.storageProfileForPath('O:\\fonts\\a.ttf');commands.at(-1).done(null,'')
  runtime.storageProfileForPath('O:\\fonts\\a.ttf');assert.equal(commands.at(-1).cmd,'powershell.exe','changed mapping never recovered')
  const override=factory({platform:'win32',env:{HFM_STORAGE_PROFILE_C:'ssd'},localWorkers:6,networkWorkers:2,windowsMediaDetectEnabled:true,windowsMediaDetectTimeoutMs:2500})
  assert.equal(override.storageProfileForPath('C:\\x').type,'ssd')
  console.log('W-03 nonblocking/coalesced probes, mapped drive, failure retry, mapping refresh, explicit override: passed')
}
async function preview() {
  let cursor=0;const slots=[],effects=[],timers=new Map();let timerId=0
  const react = {
    useRef(v) { const i=cursor++; return slots[i] || (slots[i]={current:v}) },
    useState(v) { const i=cursor++; if(!slots[i]) slots[i]={value:v}; return [slots[i].value,x=>{slots[i].value=typeof x==='function'?x(slots[i].value):x}] },
    useEffect(fn,deps) {
      const i=cursor++,old=slots[i]
      if(!old || deps.some((x,j)=>x!==old.deps[j])) effects.push(()=>{old?.cleanup?.();slots[i]={deps,setup:fn,cleanup:fn()}})
    },
  }
  const app={PREVIEW_STATE_LRU_LIMIT:800,pruneRecordByKeyLimit:x=>x,rendererMemoryPressure:()=> 'normal',requestIdleWindow:fn=>{timers.set(++timerId,fn);return timerId},MAX_CONCURRENT_PREVIEW_LOADS:3,SCROLLING_PREVIEW_LOADS:1,INDEXING_PREVIEW_LOADS:1}
  const window={setTimeout:fn=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id),cancelIdleCallback:id=>timers.delete(id)}
  const load=loadFor({react,'../../../appRuntime':app,'../../../rendererPerformance':{reportRendererTrace(){}},'./fontPreviewQuickFallbackRuntime':{},'../../appRuntime':app},{window})
  const calls=[],font={id:'a',path:'/audit/a.ttf',fileName:'a.ttf'}, options={previewText:'audit',listPreviewFontSize:39,selectedFontId:'',selectedFontIds:[],indexingActive:false,rendererUserActive:()=>false,isBadFontRecord:()=>false,setStatus(){},updateFont(){},hfm:{getCachedPreviewImages:(fonts,text,fontSize)=>{const g=deferred();calls.push({g,text,fontSize,ids:fonts.map(f=>f.id)});return g.promise}}}
  const hook=load(files.preview).usePreviewController
  const render=()=>{cursor=0;const value=hook(options);while(effects.length)effects.shift()();return value}
  let controller=render();controller.requestPreviewFont(font,'high');controller.processPreviewQueue();assert.equal(calls.length,1)
  controller=render();controller.processPreviewQueue();assert.equal(calls.length,1,'rerender duplicated pending batch')
  options.previewText='new';controller=render();controller.requestPreviewFont(font,'high');assert.equal(calls.length,2)
  calls[0].g.resolve({a:'old-image'});await tick();controller=render();assert.equal(controller.nativePreviewImages.a,undefined,'old token applied image')
  controller.processPreviewQueue();assert.equal(calls.length,2,'old completion released new in-flight gate')
  calls[1].g.resolve({a:'new-image'});await tick();controller=render();assert.equal(controller.nativePreviewImages.a,'new-image')
  // U-08: revisiting and user-state changes reuse the existing image in this owner.
  for (const active of [false, true, false]) {
    options.selectedFontIds = active ? ['a'] : []
    controller = render()
    controller.requestPreviewFont({ ...font, active, favorite: active }, 'high')
    controller.processPreviewQueue()
    assert.equal(calls.length, 2, 'unchanged text/size regenerated an in-memory preview')
    assert.equal(controller.nativePreviewImages.a, 'new-image')
  }
  // An IPC error is not a persistent cache miss: defer, then re-read the batch.
  controller.requestPreviewFont({...font,id:'b'},'high');assert.equal(calls.length,3)
  calls[2].g.reject(Error('temporary IPC failure'));await tick();assert(timers.size>0)
  const retry=[...timers.values()].at(-1);timers.clear();retry();assert.equal(calls.length,4,'batch error lost retry')
  // StrictMode cleanup/setup keeps the owner but invalidates its old work.
  for(const slot of slots)if(slot?.setup){slot.cleanup?.();slot.cleanup=slot.setup()}
  controller.processPreviewQueue();assert.equal(calls.length,5,'cleanup/setup did not resume pending queue')
  calls[3].g.resolve({b:'disposed-image'});await tick();controller=render()
  assert.equal(controller.nativePreviewImages.b,undefined,'disposed request applied after resume')
  controller.processPreviewQueue();assert.equal(calls.length,5,'disposed completion released resumed batch')
  controller.requestPreviewFont({...font,id:'c'},'normal');assert(timers.size>0)
  for(const slot of slots)slot?.cleanup?.()
  calls[4].g.resolve({b:'unmounted-image'});await tick();controller=render()
  assert.equal(controller.nativePreviewImages.b,undefined,'unmounted request applied image')
  assert.equal(timers.size,0,'unmount left scheduled work')
  const before=calls.length;controller.processPreviewQueue();assert.equal(calls.length,before)
  // The per-font fallback path must also stop at await boundaries after reset.
  for(const boundary of ['cache','url','webfont']) {
    const gate=deferred(), effects=[]
    const quick={QUICK_WEBFONT_URL_TIMEOUT_MS:100,remainingQuickPreviewBudget:()=>100,loadFontFaceFromUrlWithinBudget:async()=>{effects.push('webfont');if(boundary==='webfont')await gate.promise},isFontCollectionOrLargeFont:()=>true}
    const perFontLoad=loadFor({'../../../appRuntime':app,'../../../rendererPerformance':{reportRendererTrace(){}},'./fontPreviewQuickFallbackRuntime':quick})
    const o={...options,previewText:'audit',previewFamilies:{},nativePreviewImages:{},failedPreviewFontIds:{},loadingFonts:{current:new Set()},previewRequestTokenRef:{current:'audit::39'},
      setPreviewFamilies:()=>effects.push('state'),setFailedPreviewFontIds:()=>effects.push('state'),setNativePreviewImages:()=>effects.push('state'),updateFont:()=>effects.push('update'),
      hfm:{getCachedPreviewImage:async()=>{effects.push('cache');if(boundary==='cache')await gate.promise;return ''},toFontUrl:async()=>{effects.push('url');if(boundary==='url')await gate.promise;return 'font://test'},renderPreviewImage:async()=>{effects.push('native');return 'image'}}}
    const perFont=perFontLoad('src/renderer/src/runtime/preview/queue/fontPreviewLoadRuntime.ts').createFontPreviewLoadRuntime(o)
    const pending=perFont.ensurePreviewFont(font);await tick();const before=[...effects]
    perFont.resetPreviewLoads();o.loadingFonts.current.clear();o.loadingFonts.current.add(font.id)
    if(boundary==='webfont')gate.reject(Error('late font load failure'));else gate.resolve()
    await pending
    assert.deepEqual(effects,before,`${boundary} completion continued obsolete fallback work`)
    assert(o.loadingFonts.current.has(font.id),'old load cleared newer loading ownership')
  }
  // A size change is a new complete request; its old completion cannot win.
  slots.length = 0; calls.length = 0; timers.clear()
  options.previewText = 'size-test'; options.listPreviewFontSize = 39
  controller = render(); controller.requestPreviewFont(font, 'high')
  options.listPreviewFontSize = 52
  controller = render(); controller.requestPreviewFont(font, 'high')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].fontSize, 39); assert.equal(calls[1].fontSize, 52)
  calls[0].g.resolve({ a: 'wrong-size' }); await tick(); controller = render()
  assert.equal(controller.nativePreviewImages.a, undefined, 'old size applied after reset')
  calls[1].g.resolve({ a: 'right-size' }); await tick(); controller = render()
  assert.equal(controller.nativePreviewImages.a, 'right-size')
  for (const slot of slots) slot?.cleanup?.()
  console.log('W-04 real controller rerender, latest options, old token, failed batch retry, cleanup/setup, in-flight ownership, unmount cleanup, per-font await boundaries: passed')
}
async function run(){for(const [key,fn]of Object.entries({activation,incremental,storage,preview}))if(!selected||key===selected)await fn()}
async function main(){
  await run()
  if(selected || mutant || baseline || crlf)return
  const positive=spawnSync(process.execPath,[__filename,'--crlf'],{cwd:root,encoding:'utf8',timeout:60000})
  assert.equal(positive.status,0,positive.stdout+positive.stderr)
  const expected={activation:'older in-flight state won',incremental:'single font became full rebuild',storage:'network drive fell into media probing',preview:'rerender duplicated pending batch'}
  for(const newline of [[],['--crlf']])for(const [key,needle]of Object.entries(expected)){
    const result=spawnSync(process.execPath,[__filename,`--case=${key}`,`--mutant=${key}`,...newline],{cwd:root,encoding:'utf8',timeout:60000})
    assert.equal(result.status,1,`mutation ${key} did not exit with assertion: ${result.error || result.stdout}`)
    assert.match(result.stderr,/AssertionError/);assert(result.stderr.includes(needle),result.stderr)
  }
  console.log('[diagnostics:runtime-feedback] 4 real chains LF/CRLF passed; 8 causal mutations rejected by business assertions')
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
module.exports={activation,incremental,storage,preview}
