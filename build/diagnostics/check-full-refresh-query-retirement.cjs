#!/usr/bin/env node
'use strict'
// Windows-only causal checks. Scripted I/O is labeled and never performance evidence.
const assert=require('node:assert/strict')
const path=require('node:path')
const {EventEmitter}=require('node:events')
const {PassThrough}=require('node:stream')
const {AsyncResource}=require('node:async_hooks')
const {createQueryRetirementObserver,validateQueryRetirements,inputDigest,tagDigest}=require('./lib/full-refresh-query-retirement.cjs')
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
  const at=relative=>path.join(root,'src/main/library',relative)
  const load=loader({
    // The real metadata client imports transport parsing/capability helpers;
    // transport eagerly imports the Electron-dependent path/build modules.
    // This fixture supplies their import binding only, never application startup.
    electron:{app:{get isPackaged(){throw Error('Unexpected Electron app use in query retirement fixture')},
      getAppPath(){throw Error('Unexpected Electron app use in query retirement fixture')}}},
    [at('tagRecoveryPathRuntime.ts')]:{createTagRecoveryPaths:async()=>({roots:['C:\\fixture'],compare:key,inside:()=>true,contains:()=>true})},
    [at('tagFontBindingRuntime.ts')]:{readTagFontBindings:async()=>({bindings:new Map(items.map(item=>[key(item.path),{id:item.id,path:item.path,tags:['FixtureTag'],pathResolved:true}])),legacyTags:new Map(),unavailableRoots:[]})},
    [at('tagFontSnapshotRuntime.ts')]:{openTagFontSnapshots:()=>({schedule() { return { queued: 0, coalesced: 0, historyWrites: 0 } },remember() { return { examined: 0, written: 0 } }, holdBackgroundCapture() { return () => {} },read(){}})},
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
    assert.equal(tags.stats.failed,0,'Retired query reached local-tag hydration')
    assert.equal(tags.stats.completed,1)
    assert.equal(liveQueries,2,'Retirement fixture did not retain upstream page work in both attempts')
    assert.equal(nativeCalls,1,'Retired query admitted native local-tag work')
    observer.restore()
    assert.equal(taskModule.createFontQueryTask,originalTask);assert.equal(tagModule.createTagFontQueryRuntime,originalFactory)
    const countBefore=observer.snapshot().hydrations.length,lateValue=Promise.resolve('late')
    const lateResult=lateContext.runInAsyncScope(()=>observer.runHydration({id:99,startedAt:performance.now(),requestedCount:1},()=>lateValue))
    assert.equal(lateResult,lateValue,'Stopped hydration Promise identity changed')
    assert.equal(observer.snapshot().hydrations.length,countBefore,'Stopped observer added partial hydration evidence')
    const sample={observation:observer.snapshot(),hydrationReceipts:clone(tags.receipts),processRequests:clone(processRequests)}
    const proof=validateQueryRetirements(sample)
    assert.deepEqual(proof.retiredHydrationIds,[]);assert.deepEqual(proof.retiredRequestOrdinals,[1])
    assert.equal(proof.certificates[0].kind,'retired-before-tag-hydration')
    {
      const oldSignal=sample.observation.signals[0].id
      assert.equal(sample.observation.hydrations.filter(row=>row.signalId===oldSignal).length,0)
      assert.equal(sample.observation.transports.filter(row=>row.signalId===oldSignal).length,0)
      assert.equal(Object.hasOwn(proof.certificates[0],'inputSha256'),false,'Early retirement fabricated an old native input digest')
    }
    assert.equal(proof.certificates[0].queuedMs,2);assert.equal(proof.certificates[0].executionMs,3)
    return sample
  } finally {io.sharedFileSystem.readdir=originalRead;observer.restore();lateContext?.emitDestroy()}
}

// Synthetic validator-compatibility evidence only, never a workload result.
// Older selected-source snapshots attempted native admission after cancellation.
// Keep their strict certificate and negative matrix while current-source fixtures
// above require that no obsolete hydration/native call is admitted at all.
function historicalNativeRetirementFixture(current) {
  const sample=clone(current),o=sample.observation,signal=o.signals[0]
  assert.equal(o.hydrations.length,1);assert.equal(o.transports.length,1);assert.equal(sample.hydrationReceipts.length,1)
  const replacement=o.hydrations[0],native=o.transports[0],receipt=sample.hydrationReceipts[0]
  replacement.hydrationId=2;native.hydrationId=2;receipt.id=2
  const span=signal.settledAt-signal.abortedAt
  assert(Number.isFinite(span)&&span>=0)
  const startedAt=signal.abortedAt+span/4,finishedAt=signal.settledAt
  const nextRowId=Math.max(...['signals','invalidations','transports','hydrations','ipcs'].flatMap(key=>o[key].map(row=>row.id)))+1
  const error={name:'AbortError',message:'Synthetic historical pre-admission cancellation'}
  const failed={id:nextRowId,hydrationId:1,actionId:replacement.actionId,intentSha256:replacement.intentSha256,ipcId:replacement.ipcId,
    signalId:signal.id,startedAt,finishedAt,requestedCount:replacement.requestedCount,inputSha256:replacement.inputSha256,
    inputCount:replacement.inputCount,ok:false,error}
  o.hydrations.unshift(failed)
  o.transports.unshift({...native,id:nextRowId+1,hydrationId:1,signalId:signal.id,signalAbortedAtStart:true,outcome:'rejected',error,
    startedAt:signal.abortedAt+span/2,finishedAt:signal.abortedAt+span*3/4})
  sample.hydrationReceipts.unshift({id:1,startedAt,finishedAt,ok:false,error,querySignalId:signal.id,
    queryInputSha256:replacement.inputSha256,requestedCount:replacement.inputCount,requestedUniqueIds:replacement.inputCount,
    nativeRequestedCount:replacement.inputCount,nativeUniqueIds:replacement.inputCount,nativeCalls:1})
  const proof=validateQueryRetirements(sample)
  assert.deepEqual(proof.retiredHydrationIds,[1]);assert.equal(proof.certificates[0].kind,'retired-before-native-admission')
  return sample
}

// Minimal invented validator evidence. No CI report, host paths or workload
// timing is embedded here, and this is never performance evidence.
function syntheticChainedRetirementFixture({middleChild=true}={}) {
  const identity={actionId:'fixture-query',intentSha256:'1'.repeat(64),ipcId:1}
  const inputSha256=inputDigest({dbPath:'fixture-db',rows:[{itemId:'fixture-font',fontPath:'fixture-font.ttf',aliases:['fixture-font']}]})
  const tagSha256=tagDigest([{id:'fixture-font',localTagNames:['FixtureTag']}])
  const cancelled={name:'SharedIoProcessError',reason:'query-superseded',outcome:'not-started'}
  const observation={version:1,taskProof:'selected-source-query-tasks',observerErrors:0,dropped:0,restorationConflicts:0,
    signals:[
      {id:2,...identity,ownerId:1,tagGeneration:0,firstObservedAt:110,firstObservedLive:true,abortedAt:200,invalidationId:3,settledAt:260,outcome:'rejected',error:{...cancelled}},
      {id:4,...identity,ownerId:1,tagGeneration:1,firstObservedAt:220,firstObservedLive:true,abortedAt:300,invalidationId:5,settledAt:360,outcome:'rejected',error:{...cancelled}},
      {id:6,...identity,ownerId:1,tagGeneration:2,firstObservedAt:320,firstObservedLive:true,settledAt:800,outcome:'returned'},
    ],
    invalidations:[
      {id:3,ownerId:1,generationBefore:0,generationAfter:1,cancelInFlight:true,startedAt:190,finishedAt:210,ok:true},
      {id:5,ownerId:1,generationBefore:1,generationAfter:2,cancelInFlight:true,startedAt:290,finishedAt:310,ok:true},
    ],
    ipcs:[{id:1,...identity,channel:'fonts:queryPage',tagPage:true,startedAt:100,finishedAt:900,ok:true,total:1,itemCount:1,tagSha256}],
    hydrations:[{id:7,...identity,hydrationId:1,signalId:6,startedAt:500,finishedAt:600,requestedCount:1,inputCount:1,inputSha256,
      ok:true,returnedCount:1,tagSha256,populationValidated:true,workerMode:'rust-local-tags-read'}],
    transports:[{id:8,...identity,hydrationId:1,signalId:6,inputSha256,command:'--local-tags-read',startedAt:510,finishedAt:590,
      signalAbortedAtStart:false,outcome:'returned'}],
  }
  const hydrationReceipts=[{id:1,ok:true,querySignalId:6,queryInputSha256:inputSha256,populationValidated:true,nativePopulationValidated:true,
    nativeCalls:1,workerMode:'rust-local-tags-read',requestedCount:1,requestedUniqueIds:1,nativeRequestedCount:1,nativeUniqueIds:1,returnedCount:1,returnedUniqueIds:1}]
  const child=(requestOrdinal,querySignalId,startedAt,closedAt,error)=>({requestOrdinal,querySignalId,startedAt,closedAt,error,
    lane:'foreground-browse',actionId:identity.actionId,queryIntentSha256:identity.intentSha256,command:'--shared-file-io',operation:'readdir',
    label:'shared-file-io:readdir',write:false,verifiedReadOnly:true,preflight:false,queuedMs:2,executionMs:3})
  const processRequests=[child(1,2,120,250,{reason:'cancelled'}),child(3,2,130,180)]
  if(middleChild)processRequests.push(child(2,4,230,350,{reason:'cancelled'}))
  return {observation,hydrationReceipts,processRequests}
}

function chainedRetirementRegressions() {
  for(const middleChild of [false,true]){
    const sample=syntheticChainedRetirementFixture({middleChild}),proof=validateQueryRetirements(sample)
    assert.equal(proof.certificates.length,1,'A chained attempt must have one final certificate')
    assert.deepEqual(proof.retiredHydrationIds,[])
    assert.deepEqual(proof.retiredRequestOrdinals,middleChild?[1,2]:[1],'Only failed physical reads may receive retirement exclusion')
    const certificate=proof.certificates[0]
    assert.deepEqual(certificate.retiredSignalIds,[2,4]);assert.deepEqual(certificate.invalidationIds,[3,5])
    assert.equal(certificate.replacementSignalId,6)
    assert.equal(certificate.queuedMs,middleChild?4:2);assert.equal(certificate.executionMs,middleChild?6:3)
  }
  const sample=syntheticChainedRetirementFixture()
  const negatives=[
    ['missing generation',s=>s.observation.signals.splice(1,1),/generation span is invalid/],
    ['skipped generation',s=>s.observation.signals[1].tagGeneration++,/generation gap or branch/],
    ['branch',s=>s.observation.signals.push({...s.observation.signals[1],id:99}),/generation gap or branch/],
    ['cycle',s=>s.observation.signals[1].id=2,/Invalid\/duplicate/],
    ['wrong owner',s=>s.observation.signals[1].ownerId=9,/chain identity changed/],
    ['wrong IPC',s=>s.observation.signals[1].ipcId=9,/generation gap or branch/],
    ['wrong action',s=>s.observation.signals[1].actionId='unrelated',/chain identity changed/],
    ['wrong intent',s=>s.observation.signals[1].intentSha256='0'.repeat(64),/chain identity changed/],
    ['not initially live',s=>s.observation.signals[1].firstObservedLive=false,/not originally live/],
    ['missing invalidation',s=>s.observation.signals[1].invalidationId=99,/exact owned invalidation/],
    ['wrong invalidation owner',s=>s.observation.invalidations[1].ownerId=9,/exact owned invalidation/],
    ['skipped invalidation',s=>s.observation.invalidations[1].generationAfter++,/exact owned invalidation/],
    ['non-cancelling invalidation',s=>s.observation.invalidations[1].cancelInFlight=false,/exact owned invalidation/],
    ['ambiguous invalidation',s=>s.observation.invalidations.push({...s.observation.invalidations[1],id:99}),/invalidation is ambiguous/],
    ['skipped intervening invalidation',s=>s.observation.invalidations.push({id:99,ownerId:1,generationBefore:2,generationAfter:3,cancelInFlight:true,ok:true,startedAt:315,finishedAt:316}),/skipped an owned invalidation/],
    ['pre-invalidation replacement',s=>s.observation.signals[1].firstObservedAt=205,/invalidation order changed/],
    ['revived intermediate',s=>s.observation.signals[1].outcome='returned',/not superseded and settled/],
    ['unowned failure',s=>s.observation.signals[1].error.reason='timeout',/not superseded and settled/],
    ['missing settlement',s=>delete s.observation.signals[1].settledAt,/not superseded and settled/],
    ['late settlement',s=>s.observation.signals[1].settledAt=501,/not superseded and settled/],
    ['stale hydration',s=>s.observation.hydrations.push({...s.observation.hydrations[0],id:99,hydrationId:99,signalId:4,ok:false}),/obsolete hydration or transport/],
    ['stale transport',s=>s.observation.transports.push({...s.observation.transports[0],id:99,signalId:4}),/obsolete hydration or transport/],
    ['stale native receipt',s=>s.hydrationReceipts.push({...s.hydrationReceipts[0],id:99,querySignalId:4}),/obsolete hydration or transport/],
    ['missing child close',s=>delete s.processRequests[2].closedAt,/physically closed before task settlement/],
    ['late child close',s=>s.processRequests[2].closedAt=361,/physically closed before task settlement/],
    ['unknown failed operation',s=>s.processRequests[2].operation='stat',/Unapproved early retired physical operation/],
    ['unknown successful operation',s=>s.processRequests[1].operation='stat',/Unapproved early retired physical operation/],
    ['unclosed successful read',s=>delete s.processRequests[1].closedAt,/physically closed before task settlement/],
    ['unknown failure',s=>s.processRequests[2].error.reason='timeout',/Unapproved early retired physical operation/],
    ['write',s=>s.processRequests[2].write=true,/Unapproved early retired physical operation/],
    ['preflight',s=>s.processRequests[2].preflight=true,/Unapproved early retired physical operation/],
    ['unverified read',s=>s.processRequests[2].verifiedReadOnly=false,/Unapproved early retired physical operation/],
    ['duplicate physical identity',s=>s.processRequests[2].requestOrdinal=1,/physical request identity changed/],
    ['current generation changed',s=>s.observation.invalidations.push({id:99,ownerId:1,generationBefore:2,generationAfter:3,cancelInFlight:false,ok:true,startedAt:700,finishedAt:710}),/current generation through IPC/],
    ['multiple final hydrations',s=>s.observation.hydrations.push({...s.observation.hydrations[0],id:99,hydrationId:99}),/one same-intent native hydration replacement/],
    ['out-of-window extra hydration',s=>s.observation.hydrations.push({...s.observation.hydrations[0],id:99,hydrationId:99,startedAt:101,finishedAt:109}),/one same-intent native hydration replacement/],
    ['unbounded generation jump',s=>s.observation.signals[2].tagGeneration=Number.MAX_SAFE_INTEGER,/generation span is invalid/],
    ['retired final',s=>s.observation.signals[2].abortedAt=850,/live next query generation/],
    ['unsuccessful consumer',s=>s.observation.ipcs[0].ok=false,/successful tagged IPC/],
  ]
  for(const [name,mutate,cause]of negatives){const changed=clone(sample);mutate(changed);assert.throws(()=>validateQueryRetirements(changed),cause,`Invalid chained retirement accepted: ${name}`)}
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
    chainedRetirementRegressions()
    const currentSample=await actualQueryRetirementFixture()
    const sample=historicalNativeRetirementFixture(currentSample)
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
    ]){for(const actual of [currentSample,earlySample]){const changed=clone(actual);mutate(changed);assert.throws(()=>validateQueryRetirements(changed),'Invalid early retirement proof accepted')}}
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
    console.log('[diagnostics:full-refresh-query-retirement] actual query cancellation before hydration/replacement, historical validator compatibility, bounded synthetic generation chains and causal negatives, strict negative proofs, observer identity and daemon Error realm passed')
    return {...currentSample,earlySample,historicalSample:sample}
  }finally{if(prior===undefined)delete process.env.HFM_NODE_STATE_FALLBACK;else process.env.HFM_NODE_STATE_FALLBACK=prior}
}
module.exports={runQueryRetirementRegressions,actualQueryRetirementFixture}
if(require.main===module)runQueryRetirementRegressions().catch(error=>{console.error(error);process.exitCode=1})
