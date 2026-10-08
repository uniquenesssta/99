#!/usr/bin/env node
'use strict'
// Windows-only causal checks. Scripted I/O is labeled and never performance evidence.
const assert=require('node:assert/strict')
const path=require('node:path')
const {EventEmitter}=require('node:events')
const {PassThrough}=require('node:stream')
const {AsyncResource}=require('node:async_hooks')
const {createQueryRetirementObserver,validateQueryRetirements,inputDigest}=require('./lib/full-refresh-query-retirement.cjs')
const clone=value=>JSON.parse(JSON.stringify(value))

async function actualQueryRetirementFixture(observerOptions={}, {bindingCount=1}={}) {
  assert.equal(process.platform,'win32','Query retirement fixture executes only on Windows')
  const {loader}=require('./check-operation-chain.cjs')
  const {createProductionLocalTagHydration,productionHostGlobals}=require('./lib/production-projection-host.cjs')
  const root=path.resolve(__dirname,'../..'),key=file=>path.win32.normalize(file).replaceAll('\\','/').toLowerCase()
  const items=Array.from({length:bindingCount},(_,index)=>{
    const fileName=bindingCount===1?'a.ttf':`source-${index}.ttf`
    return {id:bindingCount===1?'fixture-a':`fixture-${index}`,path:`C:\\fixture\\${fileName}`,fileName,family:'Fixture',fileSize:100,localTagNames:['FixtureTag']}
  })
  const early=bindingCount>8
  const at=relative=>path.join(root,'src/main/library',relative)
  const load=loader({
    // The real metadata client imports transport parsing/capability helpers;
    // transport eagerly imports the Electron-dependent path/build modules.
    // This fixture supplies their import binding only, never application startup.
    electron:{app:{get isPackaged(){throw Error('Unexpected Electron app use in query retirement fixture')},
      getAppPath(){throw Error('Unexpected Electron app use in query retirement fixture')}}},
    [at('tagRecoveryPathRuntime.ts')]:{createTagRecoveryPaths:async()=>({roots:['C:\\fixture'],compare:key,inside:()=>true,contains:()=>true})},
    [at('tagFontBindingRuntime.ts')]:{readTagFontBindings:async()=>({bindings:new Map(items.map(item=>[key(item.path),{id:item.id,path:item.path,tags:['FixtureTag'],pathResolved:true}])),legacyTags:new Map(),unavailableRoots:[]})},
    [at('tagFontSnapshotRuntime.ts')]:{openTagFontSnapshots:()=>({schedule(){},remember(){},read(){}})},
    [path.join(root,'src/main/fonts/fontRuntime.ts')]:{asFormat:()=> 'ttf',fontItemFromPath:()=>{throw Error('Unexpected parse')}},
  },productionHostGlobals())
  const observer=createQueryRetirementObserver({getContext:()=>({actionId:'foreground-browse:3'}),...observerOptions})
  const taskModule=load('src/main/library/fontQueryTaskRuntime.ts'),originalTask=taskModule.createFontQueryTask
  const tagModule=load('src/main/library/tagFontQueryRuntime.ts'),originalFactory=tagModule.createTagFontQueryRuntime
  observer.installSelectedSource(load)
  const io=load('src/main/path/sharedFileSystemRuntime.ts'),{SharedIoProcessError}=load('src/main/path/sharedIoProcessRuntime.ts')
  const originalRead=io.sharedFileSystem.readdir,processRequests=[]
  let entered,reads=0
  const pendingRead=new Promise(resolve=>{entered=resolve})
  io.sharedFileSystem.readdir=function(){
    if(++reads>1)return Promise.resolve(items.map(item=>({name:item.fileName,isFile:()=>true,isSymbolicLink:()=>false})))
    const signal=io.currentSharedIoSignal(),row={requestOrdinal:1,lane:'foreground-browse',actionId:'foreground-browse:3',
      command:'--shared-file-io',operation:'readdir',label:'shared-file-io:readdir',write:false,verifiedReadOnly:true,preflight:false,
      startedAt:performance.now(),queuedMs:2,executionMs:3}
    observer.observePoolRequest({signal},row);processRequests.push(row)
    return new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>{const error=new SharedIoProcessError('Scripted cancelled read','unknown','cancelled')
        row.error={name:error.name,reason:error.reason};row.closedAt=performance.now();reject(error)},{once:true})
      entered()
    })
  }
  const transportThis={},nativeArguments=[]
  let nativePromise,nativeCalls=0,lateContext
  const nativePort=observer.wrapTransport(function(...args){
    nativeCalls++;assert.equal(this,transportThis)
    lateContext ||= new AsyncResource('retirement-stopped-fixture')
    args.forEach((value,index)=>assert.equal(value,nativeArguments[index],'Observed native argument identity changed'))
    nativePromise=io.currentSharedIoSignal()?.aborted
      ?Promise.reject(Object.assign(new Error('Scripted native cancellation'),{name:'AbortError'}))
      :Promise.resolve({stdout:JSON.stringify({ok:true,tagMap:Object.fromEntries(items.map(item=>[item.id,['FixtureTag']])),knownTags:['FixtureTag'],timings:{elapsed:1}}),stderr:''})
    return nativePromise
  })
  const metadata=load('src/main/rust-core/clients/rustMetadataClientRuntime.ts').createRustMetadataClientRuntime({
    diagnoseRustCoreWorker:async()=>({available:true,path:'scripted-worker',capabilities:['local-tags-read']}),
    createTemporaryJsonFile:()=>({path:'fixture-input',writeJson:async()=>{},dispose:async()=>{}}),
    runRustCoreScheduledCommand(...args){nativeArguments.splice(0,nativeArguments.length,...args)
      const value=nativePort.apply(transportThis,args);assert.equal(value,nativePromise,'Eligible transport Promise identity changed');return value},appendStartupLog(){},
  })
  const tags=createProductionLocalTagHydration({load,openLibraryDb:async()=>({}),librarySqlitePath:()=> 'C:\\fixture\\library.sqlite',
    runRustLocalTagsRead:metadata.runRustLocalTagsRead,appendStartupLog(){},queryRetirement:observer})
  let liveQueries=0
  const owner=load('src/main/library/tagFontQueryRuntime.ts').createTagFontQueryRuntime({
    roots:async()=>['C:\\fixture'],openLibraryDb:async()=>({}),readShared:async()=>{throw Error('Unexpected shared read')},
    queryLive:async()=>{liveQueries++;return {items,total:items.length,workerMode:'rust-merged-index-page'}},hydrate:tags.hydrateLocalTagsForFonts,
    matches:()=>true,compare:()=>0,
  })
  const request={sidebarPage:'tags',selectedTagName:'FixtureTag'}
  try {
    const result=observer.runIpc({channel:'fonts:queryPage',args:[request],actionId:'foreground-browse:3'},()=>owner.query(request,100,0))
    await pendingRead
    owner.invalidate()
    const page=await result
    assert.equal(page.items.length,bindingCount)
    for(const item of page.items)assert.deepEqual(Array.from(item.localTagNames),['FixtureTag'])
    assert.equal(tags.stats.failed,early?0:1,'Cancelled hydration population changed')
    assert.equal(tags.stats.completed,1)
    assert.equal(liveQueries,2,'Retirement fixture did not retain upstream page work in both attempts')
    assert.equal(nativeCalls,early?1:2,'Observed native transport was not delegated exactly once per attempt')
    observer.restore()
    assert.equal(taskModule.createFontQueryTask,originalTask);assert.equal(tagModule.createTagFontQueryRuntime,originalFactory)
    const countBefore=observer.snapshot().hydrations.length,lateValue=Promise.resolve('late')
    const lateResult=lateContext.runInAsyncScope(()=>observer.runHydration({id:99,startedAt:performance.now(),requestedCount:1},()=>lateValue))
    assert.equal(lateResult,lateValue,'Stopped hydration Promise identity changed')
    assert.equal(observer.snapshot().hydrations.length,countBefore,'Stopped observer added partial hydration evidence')
    const sample={observation:observer.snapshot(),hydrationReceipts:clone(tags.receipts),processRequests:clone(processRequests)}
    const proof=validateQueryRetirements(sample)
    assert.deepEqual(proof.retiredHydrationIds,early?[]:[1]);assert.deepEqual(proof.retiredRequestOrdinals,[1])
    assert.equal(proof.certificates[0].kind,early?'retired-before-tag-hydration':'retired-before-native-admission')
    if(early){
      const oldSignal=sample.observation.signals[0].id
      assert.equal(sample.observation.hydrations.filter(row=>row.signalId===oldSignal).length,0)
      assert.equal(sample.observation.transports.filter(row=>row.signalId===oldSignal).length,0)
      assert.equal(Object.hasOwn(proof.certificates[0],'inputSha256'),false,'Early retirement fabricated an old native input digest')
    }
    assert.equal(proof.certificates[0].queuedMs,2);assert.equal(proof.certificates[0].executionMs,3)
    return sample
  } finally {io.sharedFileSystem.readdir=originalRead;observer.restore();lateContext?.emitDestroy()}
}

async function daemonErrorRealmRegression() {
  const {loader}=require('./check-operation-chain.cjs'),{productionHostGlobals}=require('./lib/production-projection-host.cjs')
  const root=path.resolve(__dirname,'../..'),core=relative=>path.join(root,'src/main/rust-core',relative)
  async function run(sharedError) {
    let oneShots=0,daemonSpawns=0
    const proc=new EventEmitter();proc.env={HFM_RUST_CORE_DAEMON:'1'};proc.pid=process.pid;proc.platform='win32'
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough()
    child.killed=false;child.kill=()=>{child.killed=true;child.emit('exit',0,null);child.emit('close',0,null);return true}
    child.stdin.on('data',bytes=>{for(const line of String(bytes).trim().split('\n'))if(JSON.parse(line).type==='shutdown')child.kill()})
    const mocks={
      'node:child_process':{spawn:()=>{daemonSpawns++;return child},execFile(...args){oneShots++;const callback=args.at(-1),one=new EventEmitter()
        one.kill=()=>true;queueMicrotask(()=>{callback(Object.assign(Error('Scripted one-shot abort'),{name:'AbortError'}),'','');one.emit('close',null,'SIGKILL')});return one}},
      [core('rustCoreSchedulerRuntime.ts')]:{createRustCoreSchedulerRuntime:()=>({run:(_args,read)=>read(new AbortController().signal),stop(){}})},
      [core('rustCoreWorkerAutoBuildRuntime.ts')]:{tryBuildRustCoreWorkerForDevelopment(){}},
      [core('rustCoreWorkerPathRuntime.ts')]:{resolveRustCoreWorkerPathWithDiagnostics:()=>({path:null})},
    }
    const globals=productionHostGlobals();if(!sharedError)delete globals.Error
    const load=loader(mocks,{...globals,process:proc}),controller=new AbortController()
    const transport=load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({appendStartupLog(){}})
    controller.abort()
    try {
      await assert.rejects(transport.runRustCoreScheduledCommand('scripted-worker',['--local-tags-read','--input','fixture-input'],{signal:controller.signal}),error=>error.name==='AbortError')
      assert.equal(daemonSpawns,1,'Actual selected daemon abort path was bypassed')
      return oneShots
    }finally{transport.stopRustCoreDaemon();child.kill();child.stdout.destroy();child.stderr.destroy();child.stdin.destroy()}
  }
  assert.equal(await run(true),0,'Daemon AbortError reached one-shot fallback')
  assert.equal(await run(false),1,'Old isolated Error mutant did not expose one-shot fallback')
  // Only explicit Error construction is unified. VM intrinsic errors remain VM errors.
  const vm=require('node:vm'),globals=productionHostGlobals()
  assert(vm.runInNewContext('new Error("explicit")',globals) instanceof Error)
  assert.equal(vm.runInNewContext('try { null.x } catch (error) { error instanceof Error }',globals),false)
}

async function runQueryRetirementRegressions() {
  assert.equal(process.platform,'win32','Query retirement regression executes only on Windows')
  const prior=process.env.HFM_NODE_STATE_FALLBACK;process.env.HFM_NODE_STATE_FALLBACK='0'
  try {
    const sample=await actualQueryRetirementFixture()
    const earlySample=await actualQueryRetirementFixture({}, {bindingCount:26})
    for(const mutate of [
      s=>{s.observation.signals[0].firstObservedLive=false},
      s=>{s.observation.signals[0].invalidationId=999},
      s=>{s.observation.invalidations[0].ownerId=999},
      s=>{s.observation.invalidations[0].cancelInFlight=false},
      s=>{s.observation.invalidations[0].generationBefore++},
      s=>{s.observation.signals[0].error.reason='timeout'},
      s=>{s.observation.signals[0].outcome='returned'},
      s=>{delete s.observation.signals[0].settledAt},
      s=>{s.observation.signals[0].settledAt=s.processRequests[0].closedAt-1},
      s=>{s.observation.signals[0].settledAt=s.observation.hydrations[0].startedAt+1},
      s=>{s.observation.hydrations.push({...s.observation.hydrations[0],hydrationId:99,signalId:s.observation.signals[0].id})},
      s=>{s.observation.transports.push({...s.observation.transports[0],signalId:s.observation.signals[0].id})},
      s=>{s.hydrationReceipts.push({...s.hydrationReceipts[0],id:99,querySignalId:s.observation.signals[0].id})},
      s=>{s.observation.signals[1].id=999},
      s=>{s.observation.signals[1].tagGeneration++},
      s=>{s.observation.signals[1].ownerId=999},
      s=>{s.observation.signals[1].firstObservedLive=false},
      s=>{s.observation.signals[1].abortedAt=s.observation.ipcs[0].finishedAt},
      s=>{delete s.observation.signals[1].settledAt},
      s=>{s.observation.signals[1].settledAt=s.observation.ipcs[0].finishedAt+1},
      s=>{s.observation.hydrations[0].actionId='unrelated'},
      s=>{s.observation.hydrations[0].intentSha256='0'.repeat(64)},
      s=>{s.observation.hydrations[0].inputSha256='0'.repeat(64)},
      s=>{s.observation.hydrations[0].inputCount--},
      s=>{s.observation.hydrations[0].returnedCount--;s.observation.ipcs[0].itemCount--;s.observation.ipcs[0].total--},
      s=>{s.observation.hydrations[0].tagSha256='0'.repeat(64)},
      s=>{delete s.observation.hydrations[0].tagSha256;delete s.observation.ipcs[0].tagSha256},
      s=>{s.observation.transports[0].outcome='rejected'},
      s=>{s.observation.transports[0].error={name:'AbortError',reason:'timeout'}},
      s=>{s.observation.transports[0].signalAbortedAtStart=true},
      s=>{s.observation.transports[0].inputSha256='0'.repeat(64)},
      s=>{s.observation.transports[0].signalId=999},
      s=>{s.observation.ipcs[0].ok=false},
      s=>{s.observation.ipcs[0].tagSha256='0'.repeat(64)},
      s=>{s.observation.ipcs[0].total++},
      s=>{s.hydrationReceipts[0].populationValidated=false},
      s=>{s.hydrationReceipts[0].nativeCalls=0},
      s=>{s.processRequests[0].write=true},
      s=>{s.processRequests[0].preflight=true},
      s=>{s.processRequests[0].verifiedReadOnly=false},
      s=>{s.processRequests[0].operation='stat'},
      s=>{s.processRequests[0].error.reason='timeout'},
      s=>{s.processRequests[0].error.reason='stale-generation'},
      s=>{s.processRequests[0].querySignalId=999},
      s=>{s.processRequests[0].queryIntentSha256='0'.repeat(64)},
      s=>{s.processRequests[0].actionId='unrelated'},
      s=>{s.processRequests[0].requestOrdinal=0},
      s=>{delete s.processRequests[0].queuedMs},
      s=>{delete s.processRequests[0].executionMs},
      s=>{s.processRequests[0].closedAt=s.observation.signals[0].abortedAt-1},
      s=>{s.processRequests[0].closedAt=s.observation.signals[0].settledAt+1},
      s=>{s.observation.observerErrors++},s=>{s.observation.dropped++},s=>{s.observation.restorationConflicts++},
      s=>{s.observation.taskProof='unsupported-legacy-source'},
    ]){const changed=clone(earlySample);mutate(changed);assert.throws(()=>validateQueryRetirements(changed),'Invalid early retirement proof accepted')}
    for(const mutate of [
      s=>{s.observation.signals[0].firstObservedLive=false},
      s=>{s.observation.signals[0].invalidationId=999},
      s=>{s.observation.signals[0].abortedAt=s.observation.signals[0].firstObservedAt-1},
      s=>{delete s.observation.signals[0].settledAt},
      s=>{s.observation.signals[0].settledAt=s.observation.hydrations[0].finishedAt-1},
      s=>{s.observation.signals[0].settledAt=s.observation.hydrations[1].startedAt+1},
      s=>{s.observation.invalidations[0].cancelInFlight=false},
      s=>{s.observation.invalidations[0].ownerId=999},
      s=>{s.observation.transports[0].error={name:'Error',message:'null only'}},
      s=>{s.observation.transports[0].error={name:'AbortError',reason:'timeout'}},
      s=>{s.observation.transports[0].error={name:'AbortError',reason:'stale-generation'}},
      s=>{s.observation.transports[0].signalId=999},
      s=>{s.observation.transports[0].signalAbortedAtStart=false},
      s=>{delete s.observation.transports[0].signalAbortedAtStart},
      s=>{s.observation.transports[0].outcome='returned';delete s.observation.transports[0].error},
      s=>{s.observation.hydrations[1].inputSha256='f'.repeat(64)},
      s=>{s.observation.hydrations[1].actionId='unrelated'},
      s=>{s.observation.hydrations[1].intentSha256='f'.repeat(64)},
      s=>{s.observation.hydrations[1].signalId=s.observation.hydrations[0].signalId},
      s=>{s.observation.hydrations[1].tagSha256='f'.repeat(64)},
      s=>{s.observation.signals[1].abortedAt=s.observation.ipcs[0].finishedAt},
      s=>{s.observation.signals[1].ownerId=999},
      s=>{s.observation.signals[1].tagGeneration++},
      s=>{delete s.observation.signals[1].settledAt},
      s=>{s.observation.signals[1].settledAt=s.observation.ipcs[0].finishedAt+1},
      s=>{s.observation.ipcs[0].ok=false},
      s=>{s.observation.ipcs[0].tagSha256='f'.repeat(64)},
      s=>{s.observation.ipcs[0].finishedAt=s.observation.hydrations[1].startedAt-1},
      s=>{s.processRequests[0].write=true},
      s=>{s.processRequests[0].preflight=true},
      s=>{s.processRequests[0].verifiedReadOnly=false},
      s=>{s.processRequests[0].operation='stat'},
      s=>{s.processRequests[0].error.reason='timeout'},
      s=>{s.processRequests[0].querySignalId=999},
      s=>{s.processRequests[0].requestOrdinal=0},
      s=>{s.processRequests[0].requestOrdinal=-1},
      s=>{s.processRequests[0].queuedMs=undefined},
      s=>{s.processRequests[0].executionMs=undefined},
      s=>{s.processRequests[0].closedAt=s.observation.ipcs[0].finishedAt+1},
      s=>{s.processRequests[0].closedAt=s.observation.signals[0].abortedAt-1},
      s=>{s.observation.observerErrors++},s=>{s.observation.dropped++},s=>{s.observation.restorationConflicts++},
      s=>{s.observation.taskProof='unsupported-legacy-source'},
      s=>{s.hydrationReceipts[1].populationValidated=false},
    ]){const changed=clone(sample);mutate(changed);assert.throws(()=>validateQueryRetirements(changed),'Invalid retirement proof accepted')}
    const input={dbPath:'library',rows:[{itemId:'id',fontPath:'font',aliases:['id','legacy']}]},digest=inputDigest(input)
    for(const changed of [{...input,dbPath:'other'},{...input,rows:[{...input.rows[0],itemId:'other'}]},
      {...input,rows:[{...input.rows[0],fontPath:'other'}]},{...input,rows:[{...input.rows[0],aliases:['legacy','id']}]}])assert.notEqual(inputDigest(changed),digest)
    const legacy=createQueryRetirementObserver();legacy.installSelectedSource(()=>{throw Error('Legacy module was loaded')},{supportsQueryTasks:false})
    assert.deepEqual(validateQueryRetirements({observation:legacy.snapshot(),hydrationReceipts:[]}).certificates,[]);legacy.restore()
    const observer=createQueryRetirementObserver(),token={},sentinel=Error('original'),args=['worker',['--local-tags-read'],{}]
    const pending=Promise.resolve(token),wrapped=observer.wrapTransport(function(...actual){assert.equal(this,token);assert.deepEqual(actual,args);return pending})
    assert.equal(wrapped.apply(token,args),pending,'Transport Promise identity changed');await pending
    const rejected=Promise.reject(sentinel);const failure=observer.wrapTransport(()=>rejected)
    assert.equal(failure(...args),rejected);await assert.rejects(rejected,error=>error===sentinel)
    observer.restore()
    const returned=Promise.resolve(token)
    let contextReads=0
    await assert.rejects(actualQueryRetirementFixture({getContext(){
      if(++contextReads===3)throw Error('Eligible native observer fault')
      return {actionId:'foreground-browse:3'}
    }}),/observer failed/)
    await assert.rejects(actualQueryRetirementFixture({limits:{transports:0}}),/evidence overflowed/)
    const outside=createQueryRetirementObserver(),large=Array.from({length:5490},()=>Object.defineProperty({},'itemId',{get(){throw Error('Outside-scope input was hashed')}}))
    const ordinaryReceipt={id:1,startedAt:performance.now(),requestedCount:5490,ok:true}
    function ordinary(){return outside.runHydration(ordinaryReceipt,()=>{
      outside.recordHydrationInput(ordinaryReceipt,{dbPath:'fixture',rows:large})
      outside.finishHydration(ordinaryReceipt,large,undefined,false)
      return outside.wrapTransport(()=>returned)(...args)
    })}
    assert.equal(ordinary(),returned,'Setup hydration Promise changed')
    assert.equal(outside.runIpc({channel:'fonts:getMetrics',args:[],actionId:'foreground-metrics:0'},ordinary),returned,'Metrics hydration Promise changed')
    await returned
    const unobserved=outside.snapshot()
    for(const key of ['hydrations','transports','signals','ipcs'])assert.equal(unobserved[key].length,0,'Outside-scope certificate work was recorded')
    assert.equal(unobserved.observerErrors,0);assert.equal(unobserved.dropped,0)
    assert.throws(()=>validateQueryRetirements({observation:unobserved,hydrationReceipts:[{...ordinaryReceipt,ok:false}]}),/Legacy source|previously live/)
    assert.throws(()=>validateQueryRetirements({observation:{...unobserved,taskProof:'selected-source-query-tasks'},hydrationReceipts:[{...ordinaryReceipt,ok:false}]}),/previously live/)
    outside.restore()
    await daemonErrorRealmRegression()
    console.log('[diagnostics:full-refresh-query-retirement] actual query invalidation/native cancellation/replacement, strict negative proofs, observer identity and daemon Error realm passed')
    return {...sample,earlySample}
  }finally{if(prior===undefined)delete process.env.HFM_NODE_STATE_FALLBACK;else process.env.HFM_NODE_STATE_FALLBACK=prior}
}
module.exports={runQueryRetirementRegressions,actualQueryRetirementFixture}
if(require.main===module)runQueryRetirementRegressions().catch(error=>{console.error(error);process.exitCode=1})
