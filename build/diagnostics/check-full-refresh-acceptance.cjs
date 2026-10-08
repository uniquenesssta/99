#!/usr/bin/env node
// Acceptance-logic counterexamples only. Synthetic numbers are never workload evidence.
const assert=require('node:assert/strict')
const {compareRuns}=require('./check-full-refresh-work.cjs')
const clone=value=>JSON.parse(JSON.stringify(value))
const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {count:values.length,values,p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)}}
function sample(caseId,changed){
 const processRequests=[],foreground={queries:[],previewReceipts:[],enumeration:[],failures:[]}
 for(let i=0;i<16;i++){
  const actionId=`foreground-browse:${i}`;foreground.queries.push({index:i,actionId,kind:['all','installed','notInstalled','tags'][i%4],elapsedMs:200})
  for(let j=0;j<(changed?1:40);j++)processRequests.push({lane:'foreground-browse',actionId,label:'shared-file-io:stat',queuedMs:1})
 }
 for(let i=0;i<10;i++){
  const actionId=`foreground-preview:${i}`;foreground.previewReceipts.push({index:i,actionId,elapsedMs:30+i*10})
  processRequests.push({lane:'foreground-preview',actionId,label:'preview-render-image',queuedMs:i*10})
 }
 for(let i=0;i<4;i++){
  const actionId=`foreground-enumeration:${i}`;foreground.enumeration.push({index:i*4,actionId})
  processRequests.push({lane:'foreground-enumeration',actionId,label:'shared-file-io:treeSnapshot',operation:'treeSnapshot',queuedMs:10})
 }
 return {caseId,changed,passed:true,comparable:true,fullRefreshMs:1000,foreground,
  work:{tasks:processRequests.length,processRequests,foregroundQueue:stats(processRequests.map(row=>row.queuedMs)),foregroundEndToEnd:stats(Array(16).fill(200))},
  previewEndToEnd:stats(foreground.previewReceipts.map(row=>row.elapsedMs))}
}
const original=[sample('A1',false),sample('B1',true),sample('B2',true),sample('A2',false)]
const equalWork=compareRuns(clone(original))
assert.equal(equalWork.passed,true,'Removing cheap child work rejected unchanged fixed operations')
assert(equalWork.rawMixedQueue.originalCandidates.every(row=>row.p95NoRegression===false),'Counterexample did not expose the mixed-population quantile defect')
const regression=clone(original),bad=regression[2]
bad.work.processRequests.findLast(row=>row.lane==='foreground-preview').queuedMs+=18
bad.foreground.previewReceipts.at(-1).elapsedMs+=18
bad.previewEndToEnd=stats(bad.foreground.previewReceipts.map(row=>row.elapsedMs))
bad.work.foregroundQueue=stats(bad.work.processRequests.map(row=>row.queuedMs))
const rejected=compareRuns(regression);assert.equal(rejected.passed,false)
assert.equal(rejected.candidates[1].previewQueueP95NoRegression,false,'Same-preview queue regression escaped')
assert.equal(rejected.candidates[1].previewEndToEndMaxNoRegression,false,'Same-preview E2E regression escaped')
for(const mutate of [
 row=>{row.foreground.queries.pop()},
 row=>{row.foreground.queries[0].kind='tags'},
 row=>{row.work.processRequests.splice(row.work.processRequests.findIndex(value=>value.lane==='foreground-preview'),1);row.work.tasks--},
 row=>{row.work.processRequests.find(value=>value.lane==='foreground-preview').lane='foreground-browse'},
 row=>{row.work.processRequests.find(value=>value.lane==='foreground-preview').lane='background-refresh'},
 row=>{row.foreground.previewReceipts[1].actionId=row.foreground.previewReceipts[0].actionId},
 row=>{row.work.processRequests[0].queuedMs=undefined},
 row=>{row.work.tasks++},
]){
 const altered=clone(original);mutate(altered[1]);const value=compareRuns(altered)
 assert.equal(value.passed,false,'Missing/misclassified observation silently shrank the fixed cohort')
 assert(value.populationFailure)
}
// Publication cost belongs to the same fixed preview action, never a hidden cohort.
function stagedSample() {
 const runs=clone(original),row=runs[1],render=row.work.processRequests.findLast(value=>value.lane==='foreground-preview')
 render.sharedReadOnlyPreview=true
 render.previewStageProof={id:'proof-one',base:'C:\\Temp',openedAt:0,joinedAt:0.5}
 row.work.processRequests.push({lane:render.lane,actionId:render.actionId,label:'shared-file-io:copyFile',operation:'copyFile',queuedMs:0},
   {lane:render.lane,actionId:render.actionId,label:'preview-stage-locality',queuedMs:0,previewStageProof:{id:'proof-one',base:'C:\\Temp',openedAt:0},proofPhysicalPath:'C:\\Temp',proofDirectory:true,closedAt:1})
 row.work.tasks+=2
 return runs
}
assert.equal(compareRuns(stagedSample()).passed,true,'Same total staged queue cost rejected')
const sharedProof=stagedSample(),sharedRow=sharedProof[1],secondRender=sharedRow.work.processRequests.filter(value=>value.lane==='foreground-preview'&&value.label==='preview-render-image').at(-2)
secondRender.sharedReadOnlyPreview=true;secondRender.previewStageProof={id:'proof-one',base:'C:\\Temp',openedAt:0,joinedAt:0.75}
sharedRow.work.processRequests.push({lane:secondRender.lane,actionId:secondRender.actionId,label:'shared-file-io:copyFile',operation:'copyFile',queuedMs:0});sharedRow.work.tasks++
assert.equal(compareRuns(clone(sharedProof)).passed,true,'Two renders sharing one actual proof rejected')
const wrongProofOwner=clone(sharedProof);wrongProofOwner[1].work.processRequests.find(value=>value.label==='preview-stage-locality').actionId=secondRender.actionId
assert(compareRuns(wrongProofOwner).populationFailure,'Shared proof cost moved away from its initiator')

const copyOnly=stagedSample();copyOnly[1].work.processRequests.find(value=>value.operation==='copyFile').queuedMs=18
assert.equal(compareRuns(copyOnly).candidates[0].previewQueueP95NoRegression,false,'Copy-only queue regression escaped')
for(const mutate of [
 row=>{row.work.processRequests.splice(row.work.processRequests.findIndex(value=>value.operation==='copyFile'),1);row.work.tasks--},
 row=>{row.work.processRequests.push({...row.work.processRequests.find(value=>value.operation==='copyFile')});row.work.tasks++},
 row=>{row.work.processRequests.find(value=>value.operation==='copyFile').operation='rename'},
 row=>{row.work.processRequests.find(value=>value.label==='preview-stage-locality').previewStageProof.id='unowned'},
 row=>{row.work.processRequests.push({...row.work.processRequests.find(value=>value.label==='preview-stage-locality')});row.work.tasks++},
 row=>{const proof={...row.work.processRequests.find(value=>value.label==='preview-stage-locality'),actionId:'foreground-preview:0',previewStageProof:{id:'orphan',base:'C:\\Temp',openedAt:0}};row.work.processRequests.push(proof);row.work.tasks++},
 row=>{row.work.processRequests.find(value=>value.label==='preview-stage-locality').proofDirectory=false},
 row=>{row.work.processRequests.find(value=>value.sharedReadOnlyPreview).previewStageProof.joinedAt=2},
 row=>{row.work.processRequests.find(value=>value.sharedReadOnlyPreview).previewStageProof.base='C:\\elsewhere'},
 row=>{row.work.processRequests.splice(row.work.processRequests.findIndex(value=>value.label==='preview-stage-locality'),1);row.work.tasks--},
 row=>{row.work.processRequests.find(value=>value.operation==='copyFile').actionId='foreground-preview:0'},
 row=>{row.work.processRequests.push({lane:'foreground-preview',actionId:'foreground-preview:9',label:'hidden-child',queuedMs:0});row.work.tasks++},
]) {
 const altered=stagedSample();mutate(altered[1]);assert(compareRuns(altered).populationFailure,'Unowned/omitted staged child escaped')
}
function nativeSample() {
 const runs=clone(original),row=runs[1],render=row.work.processRequests.findLast(value=>value.lane==='foreground-preview')
 const drive=String(process.env.SystemDrive||'C:'),token='00000000-0000-4000-8000-000000000001',basePath=drive+'\\Temp'
 const directoryPath=basePath+'\\.hfm-preview-stage-'+token,outputPath=directoryPath+'\\preview.png'
 Object.assign(render,{label:'preview-render-owned-stage',sharedReadOnlyPreview:true,write:true,processLane:'preview-read',accesses:null,
  roots:['configured-root:owned-preview-stage'],previewStageProof:{mode:'native',id:token},startedAt:0,stageReadyAt:1,closedAt:2,
  nativeStageInput:{basePath,token,excludedRoots:[]},nativeStageReceipt:{version:1,token,basePath,directoryPath,outputPath}})
 render.stageReadyReceipt=clone(render.nativeStageReceipt)
 row.work.processRequests.push({lane:render.lane,actionId:render.actionId,label:'shared-file-io:copyFile',operation:'copyFile',queuedMs:0});row.work.tasks++
 return runs
}
assert.equal(compareRuns(nativeSample()).passed,true,'Folded native proof changed semantic population')
for(const mutate of [
 render=>{render.roots=[]},render=>{render.write=false},render=>{render.stageReadyReceipt.token='wrong'},
 render=>{delete render.nativeStageReceipt},render=>{render.stageReadyAt=3},render=>{render.nativeStageInput.excludedRoots=[render.nativeStageReceipt.basePath]},
]) {
 const value=nativeSample();mutate(value[1].work.processRequests.find(row=>row.label==='preview-render-owned-stage'))
 assert(compareRuns(value).populationFailure,'Invalid native ownership/cost attribution accepted')
}
// Full production foreground composition adds source stat and four metrics IPCs.
// These remain synthetic acceptance-counterexamples, never measured performance.
function fullIpcSamples() {
 const runs=clone(original)
 for(const row of runs) {
  row.foreground.invocationBoundary='production-ipc-preview-composition'
  row.foreground.metrics=[];row.foreground.invocations=[]
  for(const query of row.foreground.queries) {
   query.channel='fonts:queryPage'
   row.foreground.invocations.push({channel:query.channel,actionId:query.actionId,ok:true,elapsedMs:query.elapsedMs})
  }
  for(const preview of row.foreground.previewReceipts) {
   preview.channel='fonts:renderPreviewImage';preview.sourcePath=`C:\\fixture\\font-${preview.index}.ttf`
   row.foreground.invocations.push({channel:preview.channel,actionId:preview.actionId,ok:true,elapsedMs:preview.elapsedMs})
   row.work.processRequests.push({lane:'foreground-preview',actionId:preview.actionId,label:'shared-file-io:stat',operation:'stat',path:preview.sourcePath,queuedMs:0})
   row.work.tasks++
  }
  for(let i=0;i<4;i++) {
   const value={index:i*4,actionId:`foreground-metrics:${i}`,channel:'fonts:getMetrics',elapsedMs:100}
   row.foreground.metrics.push(value)
   row.foreground.invocations.push({channel:value.channel,actionId:value.actionId,ok:true,elapsedMs:value.elapsedMs})
   row.work.processRequests.push({lane:'foreground-metrics',actionId:value.actionId,label:'merged-index-query-metrics',queuedMs:10})
   row.work.tasks++
  }
  row.metricsEndToEnd=stats(row.foreground.metrics.map(value=>value.elapsedMs))
 }
 return runs
}
assert.equal(compareRuns(fullIpcSamples()).passed,true,'Equal full IPC composition rejected')
for(const mutate of [
 row=>{const at=row.work.processRequests.findIndex(value=>value.lane==='foreground-preview'&&value.operation==='stat');row.work.processRequests.splice(at,1);row.work.tasks--},
 row=>{row.work.processRequests.find(value=>value.lane==='foreground-preview'&&value.operation==='stat').path='C:\\wrong.ttf'},
 row=>{row.foreground.metrics.pop()},
 row=>{row.metricsEndToEnd.values.pop()},
 row=>{row.foreground.invocations.pop()},
 row=>{row.foreground.invocations[0].ok=false},
 row=>{row.foreground.invocations[0].actionId=row.foreground.invocations[1].actionId},
 row=>{row.foreground.invocations[0].elapsedMs=row.foreground.queries[0].elapsedMs+1},
 row=>{row.foreground.previewReceipts[0].channel='rust-client-only'},
 row=>{row.foreground.invocationBoundary=undefined},
 row=>{row.work.processRequests.push({lane:'foreground-preview',actionId:'foreground-preview:0',label:'hidden-child',queuedMs:0});row.work.tasks++},
]) {
 const runs=fullIpcSamples();mutate(runs[1]);assert(compareRuns(runs).populationFailure,'Incomplete/bypassed/misattributed full IPC evidence accepted')
}
const metricRegression=fullIpcSamples();metricRegression[1].metricsEndToEnd=stats([100,100,100,101])
assert.equal(compareRuns(metricRegression).candidates[0].metricsEndToEndMaxNoRegression,false,'Full metrics IPC latency regression escaped')
const statRegression=fullIpcSamples();statRegression[1].work.processRequests.findLast(value=>value.lane==='foreground-preview'&&value.operation==='stat').queuedMs=18
assert.equal(compareRuns(statRegression).candidates[0].previewQueueMaxNoRegression,false,'Pre-stat queue cost was omitted from full preview')
// Detached read-only count cancellation is not a failed returned metrics IPC.
// Exact input/effect/priority evidence is required, and all its cost stays visible.
function detachedCountsSample() {
 const runs=fullIpcSamples(),row=runs[1]
 row.work.processRequests.push({lane:'background-shared-counts',actionId:'foreground-metrics:0',priority:'background',
  label:'shared-metadata-overlay-read',command:'--shared-metadata-overlay-read',bindingSnapshot:true,preflight:false,entryCount:0,
  verifiedReadOnly:true,write:false,queuedMs:17,executionMs:3,error:{reason:'cancelled'}})
 row.work.tasks++
 return runs
}
const detached=compareRuns(detachedCountsSample())
assert.equal(detached.passed,true,'Detached count cancellation invalidated successful metrics IPC')
const detachedRows=detachedCountsSample();compareRuns(detachedRows)
assert.equal(detachedRows[1].semanticQueue.backgroundSharedCounts.totalQueuedMs,17,'Detached count cost disappeared')
for(const mutate of [
 row=>{row.bindingSnapshot=false},row=>{row.preflight=true},row=>{row.entryCount=1},row=>{row.write=true},
 row=>{row.verifiedReadOnly=false},row=>{row.priority='foreground'},row=>{row.actionId='foreground-preview:0'},row=>{row.actionId='foreground-metrics:99'},
 row=>{row.command='--shared-metadata-apply'},row=>{row.error.reason='timeout'},row=>{row.queuedMs=undefined},
]) {
 const runs=detachedCountsSample();mutate(runs[1].work.processRequests.at(-1));assert(compareRuns(runs).populationFailure,'Unproved/erroring foreground work hidden as detached counts')
}
// Byte-only success is a different, fully proved native output route. It may
// omit publication only when the same bounded PNG reaches the full IPC result.
function byteOnlySample() {
 const runs=fullIpcSamples(),row=runs[1],render=row.work.processRequests.findLast(value=>value.lane==='foreground-preview'&&value.label==='preview-render-image')
 const native=nativeSample()[1].work.processRequests.find(value=>value.label==='preview-render-owned-stage')
 Object.assign(render,native,{foregroundBytes:true,nativePreviewBytes:{valid:true,png:true,bytes:1024,sha256:'a'.repeat(64),width:600,height:100}})
 const action=row.foreground.previewReceipts.find(value=>value.actionId===render.actionId)
 Object.assign(action,{bytes:1024,sha256:'a'.repeat(64),width:600,height:100,receipt:{ok:true,transient:true,bytes:{diagnosticByteLength:1024,diagnosticSha256:'a'.repeat(64)}}})
 return runs
}
assert.equal(compareRuns(byteOnlySample()).passed,true,'Proved transient native bytes require an unrequested persistence write')
for(const mutate of [
 (row,render)=>{delete render.nativePreviewBytes},
 (row,render)=>{render.nativePreviewBytes.valid=false},
 (row,render)=>{render.nativePreviewBytes.bytes=2*1024*1024+1},
 (row,render)=>{render.nativePreviewBytes.sha256='b'.repeat(64)},
 (row,render)=>{render.foregroundBytes=false},
 (row,render)=>{render.label='preview-render-image'},
 (row,render)=>{row.foreground.previewReceipts.at(-1).receipt.transient=false},
 (row,render)=>{delete row.foreground.previewReceipts.at(-1).receipt.bytes},
 (row,render)=>{row.work.processRequests.push({lane:render.lane,actionId:render.actionId,label:'shared-file-io:copyFile',operation:'copyFile',queuedMs:0});row.work.tasks++},
]) {
 const runs=byteOnlySample(),row=runs[1];mutate(row,row.work.processRequests.find(value=>value.foregroundBytes));assert(compareRuns(runs).populationFailure,'Invalid or secretly persisted transient route accepted')
}
const failedBaseline=clone(original);failedBaseline[0].passed=false;failedBaseline[0].comparable=false
assert.equal(compareRuns(failedBaseline).comparable,false,'Failed full baseline was made comparable')
console.log('[diagnostics:full-refresh-acceptance] fixed-cohort equality, observed +18ms regression, missing/misclassified/duplicate samples copy-only cost/ownership and failed baseline rejection passed')

// Observer mechanics only. These deterministic fixtures are never timing evidence.
// Exercise the actual bounded helper, not a replacement deadline/acceptance path.
function observationFixture(factory, options = {}) {
 const pending = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes;reject=no });return {promise,resolve,reject} }
 const state={clock:0,scope:{lane:'foreground-preview',actionId:'preview:0'},enabled:0,disabled:0,resets:0,rootReads:0,calls:[],fault:false}
 const perfHooks={performance:{now:()=>{if(state.fault)throw Error('observer clock failure');return ++state.clock},
  eventLoopUtilization:()=>({idle:1,active:2,utilization:2/3})},monitorEventLoopDelay:()=>({count:2,max:2000000,mean:1000000,
   percentile:()=>2000000,enable(){state.enabled++},disable(){state.disabled++},reset(){state.resets++}})}
 const processInfo={memoryUsage:()=>({rss:4096,heapUsed:1024,heapTotal:2048}),cpuUsage:()=>({user:1000,system:100})}
 const root={rootId:'fixture-root',state:'online',generation:1,lastProbeQueuedMs:2,lastProbeExecutionMs:3}
 const deadline={withIoDeadlineResult:function(label,operation,timeout){state.calls.push({thisValue:this,args:[label,operation,timeout]});return operation}}
 const preview={tracePreviewPhase:function(label,operation){state.calls.push({thisValue:this,args:[label,operation]});return operation()}}
 const availability={ensureStartupPathRootAvailable:function(rootId,probe,reason){return probe},getStartupPathRootState:function(){state.rootReads++;return root}}
 const modules={'src/main/path/ioDeadlineRuntime.ts':deadline,'src/main/preview/runtime/previewTraceRuntime.ts':preview,'src/main/path/startupPathAvailabilityRuntime.ts':availability}
 const originals=Object.fromEntries(Object.entries(modules).map(([file,value])=>[file,{...value}]))
 const observer=factory({getScope:()=>state.scope,perfHooks,processInfo,...options})
 observer.installSelectedSource(file=>{assert(Object.hasOwn(modules,file),'Unexpected observer dependency');return modules[file]})
 return {observer,state,deadline,preview,availability,modules,originals,root,pending}
}
async function assertObservationContract(factory) {
 const f=observationFixture(factory),{observer,state,deadline,preview,availability,pending}=f
 try {
  assert.equal(state.enabled,1,'Observer needs one histogram per case')
  observer.installSelectedSource(file=>f.modules[file])
  assert.equal(observer.snapshot().hooks.length,4,'Observation install must be idempotent')
  const receiver={},operation=pending(),deadlineResult=Object.freeze({ok:false,timedOut:true,error:Object.freeze(Error('controlled timeout'))})
  const returned=deadline.withIoDeadlineResult.call(receiver,'preview-cache-validate',operation.promise,500)
  assert.equal(returned,operation.promise,'Observer changed original Promise identity')
  assert.equal(state.calls[0].thisValue,receiver);assert.equal(state.calls[0].args[1],operation.promise);assert.equal(state.calls[0].args[2],500)
  operation.resolve(deadlineResult);assert.equal(await returned,deadlineResult)
  const deadlineRow=observer.snapshot().rows.deadlines[0]
  assert.equal(deadlineRow.requestedTimeoutMs,500);assert.equal(deadlineRow.timedOut,true);assert.equal(deadlineRow.ok,false)
  assert.equal(deadlineRow.systemAtFinish.rssBytes,4096);assert.equal(deadlineRow.systemAtFinish.eventLoopDelay.maxMs,2)
  const vmPromise=require('node:vm').runInNewContext('Promise.resolve(17)')
  assert.equal(deadline.withIoDeadlineResult('vm',vmPromise,500),vmPromise,'Cross-realm Promise identity changed');await vmPromise
  const thenable=Object.defineProperty({},'then',{get(){throw Error('Observer assimilated a thenable')}})
  assert.equal(preview.tracePreviewPhase('thenable',()=>thenable),thenable)
  for(const thrown of [Object.freeze(Error('frozen original')),'primitive original',null]) {
   let caught;try{preview.tracePreviewPhase('throws',()=>{throw thrown})}catch(error){caught=error}
   assert.equal(caught,thrown,'Observer changed synchronous throw identity')
   const failure=pending(),receipt=deadline.withIoDeadlineResult('reject',failure.promise,500)
   assert.equal(receipt,failure.promise,'Observer changed rejected Promise identity')
   failure.reject(thrown);let rejected;try{await receipt}catch(error){rejected=error}
   assert.equal(rejected,thrown,'Observer changed rejection identity')
  }
  const rootResult=availability.getStartupPathRootState('fixture-root')
  assert.equal(rootResult,f.root);assert.equal(state.rootReads,1,'Observer added a root-state read')
  f.root.state='offline';f.root.generation++;availability.getStartupPathRootState('fixture-root')
  assert.equal(observer.snapshot().rows.roots.length,2)
  let admissionCalls=0;const admissionThis={},admissionArg={}
  const originalAdmission=function(arg){admissionCalls++;assert.equal(this,admissionThis);assert.equal(arg,admissionArg);return false}
  const admit=observer.wrapAdmission(originalAdmission,{command:'--read',requestOrdinal:7})
  assert.equal(admit.call(admissionThis,admissionArg),false);assert.equal(admissionCalls,1,'Admission callback invoked more than once')
  const admissionError=Object.freeze(Error('same admission error'))
  let admissionCaught;try{observer.wrapAdmission(()=>{throw admissionError})()}catch(error){admissionCaught=error}
  assert.equal(admissionCaught,admissionError);assert.equal(observer.wrapAdmission(undefined),undefined)
  const admissionRow=observer.snapshot().rows.admissions[0]
  assert.equal(admissionRow.rootRevisionBefore,2);assert.equal(admissionRow.rootRevisionAfter,2);assert.equal(admissionRow.result,false)
  observer.setStage('timed');state.scope={stage:'validation',lane:'foreground-browse',actionId:'page:1'}
  preview.tracePreviewPhase('scope',()=>19)
  assert.equal(observer.snapshot().rows.phases.at(-1).stage,'validation','Validation attribution leaked into timed scope')
  state.scope={lane:'foreground-preview',actionId:'preview:1'}
  const physical=pending()
  const physicalReceipt=preview.tracePreviewPhase('outer',()=>preview.tracePreviewPhase('image-read',()=>physical.promise))
  assert.equal(physicalReceipt,physical.promise,'Physical completion promise changed')
  const lastRows=observer.snapshot().rows.phases.slice(-2)
  assert.equal(lastRows[1].parentId,lastRows[0].id,'Nested physical read lost selected-source parent')
  const payload=Object.defineProperty({total:3},'fontBytes',{get(){throw Error('Payload copied')}})
  observer.recordProjection(()=>({label:'failed-acceptance-snapshot',rawSql:payload,pages:{installed:1},metrics:{installed:2},native:[{total:3,inputCategory:{rootCount:2},context:{stage:'validation'}}]}))
  const projection=observer.snapshot().rows.projections[0]
  assert.equal(projection.rawSql.total,3);assert.equal(projection.pages.installed,1);assert.equal(projection.metrics.installed,2)
  assert(!Object.hasOwn(projection.rawSql,'fontBytes'),'Observer copied payload')
  observer.recordProjection(()=>{throw Error('observer summary failure')})
  assert(observer.snapshot().observerErrors>0,'Observer errors were hidden')
  observer.restore();observer.restore()
  for(const [file,originals] of Object.entries(f.originals))for(const [key,original]of Object.entries(originals))assert.equal(f.modules[file][key],original,'Patched export was not restored')
  assert.equal(state.disabled,1,'Histogram must stop exactly once')
  assert.equal(observer.snapshot().histogramDisabled,true)
  const bytes=Buffer.from([1,2,3]);physical.resolve(bytes);assert.equal(await physicalReceipt,bytes)
  assert.equal(observer.snapshot().lateCompletions,2,'Late physical completion was lost after restore')
  assert.equal(lastRows[1].returnedBytes,3);assert.equal(lastRows[1].completedAfterRestore,true)
  const before=observer.snapshot().rows.admissions.length;admit.call(admissionThis,admissionArg)
  assert.equal(admissionCalls,2);assert.equal(observer.snapshot().rows.admissions.length,before,'Restored admission still observed')
 }finally{observer.restore()}
}
async function observationRegressions() {
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
 const file=path.join(__dirname,'lib/full-refresh-observation.cjs'),source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n')
 const factory=require(file).createFullRefreshObservation
 await assertObservationContract(factory)
 const bounded=observationFixture(factory,{limits:{phases:1,projections:1,admissions:1,roots:1}})
 try {
  for(let index=0;index<3;index++){bounded.preview.tracePreviewPhase('bounded',()=>index);bounded.observer.recordProjection({label:'bounded'});bounded.observer.wrapAdmission(()=>true)()}
  const value=bounded.observer.snapshot()
  for(const key of ['phases','projections','admissions']){assert.equal(value.rows[key].length,1);assert.equal(value.dropped[key],2,'Bounded overflow must be explicit')}
 }finally{bounded.observer.restore()}
 const failed=observationFixture(factory)
 failed.state.fault=true
 assert.equal(failed.preview.tracePreviewPhase('clock-failed',()=>42),42,'Observer clock fault blocked business call')
 failed.observer.restore()
 for(const [file,originals]of Object.entries(failed.originals))for(const [key,original]of Object.entries(originals))assert.equal(failed.modules[file][key],original,'Observer fault prevented restoration')
 assert.equal(failed.state.disabled,1,'Observer fault prevented histogram shutdown')
 failed.state.fault=false;assert(failed.observer.snapshot().observerErrors>0)
 const badScope=observationFixture(factory,{getScope:()=>{throw Error('observer context failure')}})
 try{assert.equal(badScope.preview.tracePreviewPhase('context-failed',()=>23),23);assert(badScope.observer.snapshot().observerErrors>0)}finally{badScope.observer.restore()}
 const partial=observationFixture(factory)
 partial.observer.restore()
 const partialObserver=factory({perfHooks:{performance:{now:()=>0,eventLoopUtilization:()=>({})},monitorEventLoopDelay:()=>({enable(){},disable(){},reset(){},count:0})},processInfo:{memoryUsage:()=>({}),cpuUsage:()=>({})}})
 try {
  partialObserver.installSelectedSource(file=>{if(file.includes('startupPathAvailability'))throw Error('missing optional observation hook');return partial.modules[file]})
  assert(partialObserver.snapshot().observerErrors>0,'Unavailable observation hook was hidden')
 }finally{partialObserver.restore()}
 for(const [file,originals]of Object.entries(partial.originals))for(const [key,original]of Object.entries(originals))assert.equal(partial.modules[file][key],original,'Partial installation was not restored')
 // Exercise the actual stage adapter without constructing a host or running I/O.
 const workSource=fs.readFileSync(path.join(__dirname,'check-full-refresh-work.cjs'),'utf8').replace(/\r\n/g,'\n')
 const stageAssignments=[...workSource.matchAll(/host\.withObservationStage = ([^\n]+)/g)]
 assert.equal(stageAssignments.length,1,'Observation stage adapter must have one owner')
 async function assertStageLifetime(expression) {
  const {AsyncLocalStorage}=require('node:async_hooks'),scope=new AsyncLocalStorage(),observationStageScope=new AsyncLocalStorage()
  const runStage=new Function('observationStageScope','scope',`return (${expression})`)(observationStageScope,scope)
  const owner={active:true,lane:'foreground-browse',actionId:'held-query'},held={}
  held.promise=new Promise(resolve=>{held.resolve=resolve})
  let original
  const returned=scope.run(owner,()=>runStage('validation',()=>{
   original=held.promise.then(()=>({active:scope.getStore().active,stage:observationStageScope.getStore()}));return original
  }))
  assert.equal(returned,original,'Observation stage changed Promise identity')
  owner.active=false;held.resolve();const result=await returned
  assert.equal(result.active,false,'Validation detached the original meter lifetime')
  assert.equal(result.stage,'validation','Validation lost its separate observation stage')
 }
 await assertStageLifetime(stageAssignments[0][1])
 await assert.rejects(()=>assertStageLifetime('(stage, run) => scope.run({ ...scope.getStore(), stage }, run)'),/Validation detached the original meter lifetime/)
 // Exact, causally checked mutations. These do not update any acceptance gate.
 for(const [before,after,expected]of [
  ['      return result\n    }\n    guard(() => Object.defineProperty', '      return isPromise(result) ? result.then(value => value) : result\n    }\n    guard(() => Object.defineProperty', /Observer changed original Promise identity/],
  ['try { result = Reflect.apply(original, this, args) }','try { Reflect.apply(original, this, args); result = Reflect.apply(original, this, args) }',/Admission callback invoked more than once/],
  ['saved.module[saved.key] = saved.original','saved.module[saved.key] = saved.wrapped',/Patched export was not restored/],
 ]) {
  assert.equal(source.split(before).length,2,'Observer mutation anchor must be unique')
  const box={module:{exports:{}},exports:{},Buffer,require:name=>{assert(['node:async_hooks','node:util','node:perf_hooks'].includes(name));return require(name)}}
  vm.runInNewContext(source.replace(before,after),box,{filename:file})
  await assert.rejects(()=>assertObservationContract(box.module.exports.createFullRefreshObservation),expected)
 }
 console.log('[diagnostics:full-refresh-acceptance] observer identity, deadline/physical completion, admission, bounds, errors and restoration counterexamples passed')
}
observationRegressions().then(localTagHydrationRegressions).then(taggedPageRealmRegressions).then(sqlitePolicyRegressions)
 .then(()=>require('./check-full-refresh-fixture-lifecycle.cjs').runFixtureLifecycleRegressions()).then(timedOwnerRegressions)
 .then(()=>require('./check-font-metrics-fairness.cjs').runFontMetricsFairnessRegressions())
 .then(()=>require('./check-full-refresh-query-retirement.cjs').runQueryRetirementRegressions())
 .then(queryRetirementAcceptanceRegressions)
 .catch(error=>{console.error(error);process.exitCode=1})

function queryRetirementAcceptanceRegressions(input) {
 const {validateQueryRetirements}=require('./lib/full-refresh-query-retirement.cjs')
 const {assertLocalTagHydrationEvidence}=require('./check-full-refresh-work.cjs')
 const certificate=validateQueryRetirements(input)
 const runs=fullIpcSamples(),candidate=runs[1]
 candidate.queryRetirementObservation=clone(input.observation)
 candidate.localTagHydration={provenance:{mode:'selected-source-rust-first-local-tag-hydration'},
  stats:{failed:input.hydrationReceipts.filter(row=>row.ok===false).length,receiptOverflow:0},receipts:clone(input.hydrationReceipts)}
 candidate.work.processRequests.push(...clone(input.processRequests));candidate.work.tasks+=input.processRequests.length
 candidate.work.foregroundQueue=stats(candidate.work.processRequests.filter(row=>row.lane.startsWith('foreground')).map(row=>row.queuedMs))
 assert.equal(compareRuns(clone(runs)).passed,true,'Exact query retirement was rejected by the physical cohort gate')
 assert.equal(candidate.localTagHydration.stats.failed,1,'Retirement erased the failed native attempt')
 const retained=candidate.work.processRequests.filter(row=>certificate.retiredRequestOrdinals.includes(row.requestOrdinal))
 assert.equal(retained.length,1);assert.equal(retained[0].queuedMs,2);assert.equal(retained[0].executionMs,3)
 for(const mutate of [
  row=>{delete row.queryRetirementObservation},
  row=>{row.queryRetirementObservation.transports[0].error={name:'AbortError',reason:'timeout'}},
  row=>{row.queryRetirementObservation.hydrations[1].inputSha256='0'.repeat(64)},
  row=>{row.work.processRequests.at(-1).querySignalId=999},
  row=>{row.work.processRequests.at(-1).error.reason='stale-generation'},
  row=>{row.work.processRequests.at(-1).closedAt=Infinity},
  row=>{row.work.foregroundQueue.values.pop();row.work.foregroundQueue.count--},
  row=>{row.work.foregroundQueue.values[row.work.foregroundQueue.values.length-1]=0},
  row=>{row.work.foregroundQueue.maxMs=0},
  row=>{row.work.processRequests.push({...row.work.processRequests.at(-1),querySignalId:999,requestOrdinal:999});row.work.tasks++},
 ]) {
  const altered=clone(runs);mutate(altered[1])
  altered[1].queryRetirementProof={...certificate,retiredRequestOrdinals:[1,999]}
  assert(compareRuns(altered).populationFailure,'Saved or unrelated cancellation certificate waived a physical failure')
 }
 const slower=clone(runs),slowerCandidate=slower[1]
 slowerCandidate.work.processRequests.at(-1).queuedMs=10000
 slowerCandidate.work.foregroundQueue=stats(slowerCandidate.work.processRequests.filter(row=>row.lane.startsWith('foreground')).map(row=>row.queuedMs))
 const slowerResult=compareRuns(slower)
 assert.equal(slowerResult.passed,false,'A retired query queue regression escaped')
 assert.equal(slowerResult.candidates[0].foregroundMaxNoRegression,false,'Retirement removed the raw maximum gate')
 assert.equal(slowerResult.candidates[0].browseQueueCostNoRegression,false,'Retirement removed the browse queue total gate')
 // A successful full-population hydration remains independently mandatory.
 // This is synthetic acceptance evidence, not another timed/native workload.
 const hydration=clone(candidate.localTagHydration),replacement=hydration.receipts.find(row=>row.ok===true)
 const full={...clone(replacement),id:999,context:{stage:'timed',lane:'foreground-metrics'}}
 hydration.receipts.push(full)
 const expected=full.taggedRows.map(row=>row.id)
 assert.equal(assertLocalTagHydrationEvidence(hydration,expected,full.requestedCount,certificate.retiredHydrationIds).failedAttempts,1)
 assert.throws(()=>assertLocalTagHydrationEvidence(hydration,expected,full.requestedCount),/without an exact query retirement certificate/)
 for(const mutate of [
  row=>{row.stats.failed=0},row=>{row.receipts.find(item=>item.id===999).workerMode='node-fallback'},
  row=>{row.receipts.find(item=>item.id===999).nativePopulationValidated=false},
 ]) {
  const altered=clone(hydration);mutate(altered)
  assert.throws(()=>assertLocalTagHydrationEvidence(altered,expected,full.requestedCount,certificate.retiredHydrationIds),'Retirement waived native count or population proof')
 }
 console.log('[diagnostics:full-refresh-acceptance] query retirement is recomputed, failed attempts/costs retained, unrelated physical failures and incomplete native populations rejected')
}

// These mechanics fixtures exercise the actual source hydration owner with a
// controlled native port. Real A/B workers additionally prove alias parity in
// the correctness lane after the unchanged full-refresh ABBA sequence.
async function localTagHydrationRegressions() {
 const fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
 const {DatabaseSync}=require('node:sqlite'),{AsyncLocalStorage}=require('node:async_hooks')
 const {loader}=require('./check-operation-chain.cjs')
 const hostFile=path.join(__dirname,'lib/production-projection-host.cjs')
 const hostModule=require(hostFile),factory=hostModule.createProductionLocalTagHydration
 const {assertLocalTagHydrationEvidence}=require('./check-full-refresh-work.cjs')
 const saved=process.env.HFM_NODE_STATE_FALLBACK
 process.env.HFM_NODE_STATE_FALLBACK='0'
 const fixture=selectedFactory=>{
  const db=new DatabaseSync(':memory:')
  db.exec('CREATE TABLE local_font_tags(font_id TEXT,font_path TEXT,tag_name TEXT)')
  db.prepare('INSERT INTO local_font_tags VALUES(?,?,?)').run('local-path:'+String.raw`c:\fixture\tag.ttf`,String.raw`c:\fixture\tag.ttf`,'FixtureTag')
  const canonical={id:'file-v2:canonical',path:String.raw`C:\fixture\tag.ttf`,sourceId:'historical-tag-id'}
  const legacy={...canonical,id:'legacy-display-id',sourceId:canonical.id},untagged={id:'file-v2:untagged',path:String.raw`C:\fixture\untagged.ttf`}
  const state={calls:[],opens:0,read:undefined},items=[canonical,legacy,untagged],load=loader()
  state.read=async input=>({workerMode:'rust-local-tags-read',tagMap:Object.fromEntries(input.rows.map(row=>[row.itemId,row.fontPath===String.raw`c:\fixture\tag.ttf`?['FixtureTag']:[]]))})
  const owner=selectedFactory({load,openLibraryDb:async()=>{state.opens++;return db},librarySqlitePath:()=>String.raw`C:\fixture\library.sqlite`,
   appendStartupLog:()=>{},getObservationContext:()=>({stage:'timed',lane:'foreground-metrics',actionId:'metrics:fixture'}),
   runRustLocalTagsRead:input=>{state.calls.push(input);return state.read(input)}})
  return {db,state,items,owner}
 }
 try {
  const f=fixture(factory)
  try {
   const value=await f.owner.hydrateLocalTagsForFonts(f.items)
   assert.deepEqual(value.map(item=>item.id),f.items.map(item=>item.id))
   assert.deepEqual(value.map(item=>[...item.localTagNames]),[['FixtureTag'],['FixtureTag'],[]])
   assert.equal(f.state.calls.length,1);assert.equal(f.state.opens,1,'Production read preparation boundary changed')
   assert(f.state.calls[0].rows[1].aliases.includes('file-v2:canonical'),'Legacy display ID lost canonical alias')
   assert.equal(f.state.calls[0].rows[0].fontPath,f.state.calls[0].rows[1].fontPath)
   const evidence={provenance:f.owner.provenance,stats:f.owner.stats,receipts:f.owner.receipts}
   assert.equal(assertLocalTagHydrationEvidence(evidence,f.items.slice(0,2).map(item=>item.id),3).fullPopulationReceipts,1)
   for(const mutate of [row=>{row.nativeCalls=0},row=>{row.requestedUniqueIds=2},row=>{row.nativeRequestedCount=2},row=>{row.nativeUniqueIds=2},
    row=>{row.returnedCount=2},row=>{row.returnedUniqueIds=2},row=>{row.taggedRows[0].tagNames=[]},row=>{row.taggedRows[0].id='wrong-id'},
    row=>{row.context.stage='setup'},row=>{row.taggedRowsOverflow=1},row=>{row.untaggedCount=0},row=>{row.workerMode='node-fallback'}]) {
    const changed=clone(evidence);mutate(changed.receipts[0])
    assert.throws(()=>assertLocalTagHydrationEvidence(changed,f.items.slice(0,2).map(item=>item.id),3),'Invalid native hydration evidence accepted')
   }
   const before=f.state.calls.length,empty=[]
   assert.equal(await f.owner.hydrateLocalTagsForFonts(empty),empty);assert.equal(f.state.calls.length,before)
  } finally {f.db.close()}
  for(const result of [null,undefined,{tagMap:{},workerMode:'node-fallback'}, {workerMode:'rust-local-tags-read',tagMap:{unrequested:['FixtureTag']}}]) {
   const f=fixture(factory)
   try {f.state.read=async()=>result;await assert.rejects(f.owner.hydrateLocalTagsForFonts(f.items),/actual native local-tag receipt missing|unrequested identity/);assert.equal(f.owner.stats.failed,1)}finally{f.db.close()}
  }
  for(const failure of [Object.freeze(Error('native tag failure')),null,0]) {
   const f=fixture(factory)
   try {f.state.read=async()=>{throw failure};await assert.rejects(f.owner.hydrateLocalTagsForFonts(f.items),error=>error===failure);assert.equal(f.owner.stats.failed,1)}finally{f.db.close()}
  }
  const root=path.resolve(__dirname,'../..'),wiring=hostModule.assertProductionLocalTagHydrationWiring
  assert.equal(wiring(root,require).length,2,'Local-tag source wiring provenance missing')
  for(const [relative,before,after]of [
   ['src/main/bootstrap/mainDataStorageCompositionRuntime.ts','runRustLocalTagsRead: rustCoreWorkerRuntime.runRustLocalTagsRead','runRustLocalTagsRead: undefined'],
   ['src/main/library/libraryRuntime.ts','runRustLocalTagsRead: options.runRustLocalTagsRead','runRustLocalTagsRead: undefined'],
   ['src/main/library/libraryRuntime.ts','prepareIdentity: options.prepareLocalFontIdentity ? async () => { await openLibraryDb(); } : undefined','prepareIdentity: undefined'],
   ['src/main/bootstrap/mainDataStorageCompositionRuntime.ts','return localProtection.hydrate(await localFavorites.hydrate(await hydrateLocalTagsForFontsBase(items)));','return localFavorites.hydrate(await localProtection.hydrate(await hydrateLocalTagsForFontsBase(items)));'],
  ]) {
   const original=fs.readFileSync(path.join(root,relative),'utf8')
   assert.equal(original.split(before).length,2,'Source wiring mutation anchor must be unique')
   assert.throws(()=>wiring(root,require,{[relative]:original.replace(before,after)}),'Non-production local-tag wiring was accepted')
  }
  process.env.HFM_NODE_STATE_FALLBACK='1'
  assert.throws(()=>factory({load:loader(),openLibraryDb:async()=>{throw Error('Unexpected DB open')},librarySqlitePath:()=>'',appendStartupLog:()=>{}}),/requires Node fallback disabled/)
  process.env.HFM_NODE_STATE_FALLBACK='0'
  // Mutate the exact actual owner initializer back to the historical direct
  // Node path. It can return correct tags but still lacks the required receipt.
  const source=fs.readFileSync(hostFile,'utf8').replace(/\r\n/g,'\n'),tree=ts.createSourceFile(hostFile,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  assert.equal(tree.parseDiagnostics.length,0)
  const helpers=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createProductionLocalTagHydration')
  assert.equal(helpers.length,1)
  const helper=helpers[0],owners=helper.body.statements.filter(ts.isVariableStatement).flatMap(node=>[...node.declarationList.declarations]).filter(node=>node.name.getText(tree)==='owner')
  assert.equal(owners.length,1)
  const initializer=owners[0].initializer
  assert(initializer.getText(tree).includes("load('src/main/library/runtime/localFontTagsRuntime.ts').createLocalFontTagsRuntime"),'Direct-Node mutation owner changed')
  const text=helper.getText(tree),at=initializer.getStart(tree)-helper.getStart(tree),end=initializer.end-helper.getStart(tree)
  const mutant=text.slice(0,at)+"load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts').createLocalFontTagNodePersistenceRuntime(openLibraryDb)"+text.slice(end)
  const mutated=new Function('assert','AsyncLocalStorage','performance',mutant+';return createProductionLocalTagHydration')(assert,AsyncLocalStorage,require('node:perf_hooks').performance)
  const mutantFixture=fixture(mutated)
  try {
   const historicalNode=loader()('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts').createLocalFontTagNodePersistenceRuntime(async()=>mutantFixture.db)
   const nodeResult=await historicalNode.hydrateLocalTagsForFonts(mutantFixture.items)
   assert.deepEqual(nodeResult.map(item=>[...item.localTagNames]),[['FixtureTag'],['FixtureTag'],[]],'Direct-Node counterfactual fixture failed before receipt proof')
   await assert.rejects(mutantFixture.owner.hydrateLocalTagsForFonts(mutantFixture.items),/Hydration bypassed the real Rust local-tag owner/)
   assert.equal(mutantFixture.state.calls.length,0)
  }finally{mutantFixture.db.close()}
 }finally{if(saved===undefined)delete process.env.HFM_NODE_STATE_FALLBACK;else process.env.HFM_NODE_STATE_FALLBACK=saved}
 console.log('[diagnostics:full-refresh-acceptance] actual Rust-first hydration owner, native population/tags, failure refusal and direct-Node mutant passed')
}


function taggedPageRealmRegressions() {
 const vm=require('node:vm'),{assertTaggedPageIdentities}=require('./check-full-refresh-work.cjs')
 const expected=[{id:'file-v2:first'},{id:'file-v2:second'},{id:'file-v2:third'}]
 const actual=vm.runInNewContext('[{id:"file-v2:third"},{id:"file-v2:first"},{id:"file-v2:second"}]')
 assert(Array.isArray(actual));assert.notEqual(Object.getPrototypeOf(actual),Array.prototype)
 // The exact former comparison rejects identical values solely at the realm
 // boundary. The actual diagnostic now preserves IDs and normalizes containers.
 assert.throws(()=>assert.deepEqual(actual.map(item=>item.id).sort(),expected.map(item=>item.id).sort()),{code:'ERR_ASSERTION'})
 assertTaggedPageIdentities(actual,expected)
 assertTaggedPageIdentities(expected,actual)
 for(const expression of [
  '[{id:"file-v2:first"},{id:"file-v2:second"}]',
  '[{id:"file-v2:first"},{id:"file-v2:second"},{id:"file-v2:second"}]',
  '[{id:"file-v2:first"},{id:"file-v2:second"},{id:"file-v2:wrong"}]',
  '[{id:"file-v2:first"},{id:"file-v2:second"},{id:3}]',
  '[{id:"file-v2:first"},{id:"file-v2:second"},{id:"FILE-V2:THIRD"}]',
 ]) assert.throws(()=>assertTaggedPageIdentities(vm.runInNewContext(expression),expected),/Tagged page changed identities/)
 assert.throws(()=>assertTaggedPageIdentities(vm.runInNewContext('[{id:3}]'),[{id:'3'}]),/Tagged page changed identities/)
 assert.throws(()=>assertTaggedPageIdentities(vm.runInNewContext('[{id:"a"},{id:"b"},{id:"b"}]'),[{id:'a'},{id:'a'},{id:'b'}]),/Tagged page changed identities/)
 console.log('[diagnostics:full-refresh-acceptance] cross-realm tagged IDs preserve exact values and duplicate multiplicity')
}

async function sqlitePolicyRegressions() {
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript')
 const {DatabaseSync}=require('node:sqlite'),{loader}=require('./check-operation-chain.cjs')
 const file=path.join(__dirname,'lib/production-projection-host.cjs'),hostModule=require(file)
 const {createDiagnosticSqliteDatabase,createProductionSqlitePorts,assertProductionSqliteWiring}=hostModule
 const sourceRoot=path.resolve(__dirname,'../..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-sqlite-policy-')),opened=new Set()
 const dataPath=(...parts)=>path.join(directory,...parts)
 const openRawDb=(file,options)=>{const db=createDiagnosticSqliteDatabase(DatabaseSync,file,options);db.exec('PRAGMA busy_timeout=5000;');opened.add(db);return db}
 const options={load:loader(),sourceRoot,requireProject:require,openRawDb,dataPath,exists:async file=>fs.existsSync(file),appendStartupLog:()=>{}}
 const close=db=>{db.close();opened.delete(db)}
 function assertPolicy(ports,db) {
  const actual=ports.inspectPolicy(db),configured=ports.provenance.configuredOptions
  assert.equal(actual.journal_mode,'wal','Selected SQLite journal mode missing')
  assert.equal(actual.synchronous,1,'Selected SQLite synchronous mode missing')
  assert.equal(actual.busy_timeout,configured.busyTimeoutMs,'Selected SQLite busy timeout missing')
  assert.equal(actual.temp_store,2,'Selected SQLite temporary-store mode missing')
  assert.equal(actual.foreign_keys,1,'Selected SQLite foreign-key mode missing')
  assert.equal(actual.mmap_size,configured.mmapSizeBytes,'Selected SQLite mmap size missing')
 }
 try {
  const ports=createProductionSqlitePorts(options)
  assert.equal(ports.provenance.mode,'selected-source-sqlite-open-policy')
  assert.equal(ports.provenance.configuredOptions.busyTimeoutMs,60000,'Production SQLite lock-wait profile changed')
  assert.equal(ports.provenance.configuredOptions.mmapSizeBytes,268435456)
  for(const label of ['install-identity-items','machine-install:fallback','root-index:root','merged-index','install-signature','preview:shared']) {
   const db=ports.openStableSqliteDb(dataPath(label.replaceAll(':','-')+'.sqlite'),label)
   try{db.exec('CREATE TABLE sample(value TEXT)');assertPolicy(ports,db)}finally{close(db)}
  }
  for(const label of ['library','preview','tasks']) {
   const db=await ports.openRecoverableApplicationSqliteDb(dataPath(label+'.sqlite'),label)
   try{db.exec('CREATE TABLE sample(value TEXT)');assertPolicy(ports,db)}finally{close(db)}
  }
  // Explicit rollback fixtures/audits retain raw constructor semantics; the
  // selected production policy must not be globally applied to their opens.
  const rollbackPath=dataPath('rollback.sqlite'),raw=openRawDb(rollbackPath)
  raw.exec('CREATE TABLE sample(value TEXT)')
  const rawPolicy=ports.inspectPolicy(raw)
  assert.equal(rawPolicy.journal_mode,'delete');assert.equal(rawPolicy.synchronous,2);assert.equal(rawPolicy.busy_timeout,5000)
  close(raw);assert.deepEqual([...fs.readFileSync(rollbackPath).subarray(18,20)],[1,1])
  const before=fs.readFileSync(rollbackPath)
  const readOnly=createDiagnosticSqliteDatabase(DatabaseSync,rollbackPath,{readonly:true,fileMustExist:true})
  try{assert.throws(()=>readOnly.exec("INSERT INTO sample VALUES('blocked')"),/readonly|read-only/i);assert.equal(readOnly.prepare('SELECT COUNT(*) AS n FROM sample').get().n,0)}finally{readOnly.close()}
  assert.deepEqual(fs.readFileSync(rollbackPath),before,'Readonly health open changed fixture bytes')
  const missing=dataPath('absent-directory','missing.sqlite')
  assert.throws(()=>createDiagnosticSqliteDatabase(DatabaseSync,missing,{readonly:true,fileMustExist:true}))
  assert(!fs.existsSync(path.dirname(missing)),'Readonly/must-exist open created its missing directory')
  assert.throws(()=>createDiagnosticSqliteDatabase(DatabaseSync,rollbackPath,{fileMustExist:true}),/fileMustExist/)
  for(const unsupported of [{readOnly:true},{readonly:'true'},{timeout:1}])assert.throws(()=>createDiagnosticSqliteDatabase(DatabaseSync,rollbackPath,unsupported),/Unsupported|boolean/)
  ports.assertSqliteFileHealthy(rollbackPath,'readonly-health')
  assert.deepEqual(fs.readFileSync(rollbackPath),before)
  const corruptPath=dataPath('corrupt.sqlite'),corrupt=Buffer.from('deliberately invalid diagnostic SQLite fixture')
  fs.writeFileSync(corruptPath,corrupt)
  await assert.rejects(ports.openRecoverableApplicationSqliteDb(corruptPath,'library'))
  assert.deepEqual(fs.readFileSync(corruptPath),corrupt,'Corrupt benchmark data was replaced or quarantined')
  assert(!fs.existsSync(ports.provenance.fixtureBackupRoot));assert(!fs.existsSync(ports.provenance.fixtureCorruptRoot))
  const storage='src/main/bootstrap/mainDataStorageCompositionRuntime.ts',source=fs.readFileSync(path.join(sourceRoot,storage),'utf8')
  for(const [before,after]of [['busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS','busyTimeoutMs: 5000'],['mmapSizeBytes: SQLITE_MMAP_SIZE_BYTES','mmapSizeBytes: 0']]) {
   assert.equal(source.split(before).length,2)
   assert.throws(()=>assertProductionSqliteWiring(sourceRoot,require,{[storage]:source.replace(before,after)}),/configuration wiring changed/)
  }
  // Exact helper mutation reintroduces the historical raw-open policy bypass.
  const helperSource=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'),tree=ts.createSourceFile(file,helperSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  const matches=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createProductionSqlitePorts')
  assert.equal(matches.length,1)
  const helper=matches[0].getText(tree),anchor='openStableSqliteDb:runtime.openStableSqliteDb'
  assert.equal(helper.split(anchor).length,2,'Raw SQLite bypass mutation anchor changed')
  // The old raw opener accepted only a filename and ignored the source label;
  // a direct alias would instead misread that label as constructor options.
  const mutated=new Function('assert','assertProductionSqliteWiring','forbidden',helper.replace(anchor,'openStableSqliteDb:(file,_label)=>openRawDb(file)')+';return createProductionSqlitePorts')(
   assert,assertProductionSqliteWiring,name=>()=>{throw Error(name)})
  const bypass=mutated(options),bypassed=bypass.openStableSqliteDb(dataPath('raw-bypass.sqlite'),'install-identity-items')
  try{
   const policy=bypass.inspectPolicy(bypassed)
   assert.equal(policy.journal_mode,'delete');assert.equal(policy.busy_timeout,5000)
   assert.throws(()=>assertPolicy(bypass,bypassed),/Selected SQLite journal mode missing/)
  }finally{close(bypassed)}
 }finally{
  for(const db of opened)try{db.close()}catch{}
  fs.rmSync(directory,{recursive:true,force:true})
 }
 console.log('[diagnostics:full-refresh-acceptance] selected SQLite policy, readonly/missing safeguards, rollback control and raw-open bypass mutant passed')
}

async function timedOwnerRegressions() {
 const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),{loader}=require('./check-operation-chain.cjs')
 const sourceRoot=path.resolve(__dirname,'../..'),hostModule=require('./lib/production-projection-host.cjs')
 const {exactSelectedStorageReadPorts,assertProductionReadOwnerPorts}=hostModule
 function storage(sourceOverride) {
  const calls=[],cached=[{id:'cached'}],fresh=[{id:'fresh'}],rows=[{path:'watched-b'},{path:'watched-a'}]
  const db={prepare(sql){assert.equal(sql,'SELECT path FROM folders ORDER BY sort_order');return {all(){calls.push('folder-sql');return rows}}}}
  const extracted=exactSelectedStorageReadPorts({sourceRoot,requireProject:require,sourceOverride,dependencies:{
   openLibraryDbBase:async()=>{calls.push('base-db');return db},
   localFavorites:{initialize:async()=>{calls.push('favorites-init')},hydrate:async value=>{calls.push('favorites-hydrate');return value.map(item=>({...item,favorite:true}))}},
   requireFolderCacheRuntime:()=>({loadSharedFontsForFolders:async value=>{calls.push('cached');assert.equal(value,'roots');return cached},
    loadSharedFontsForFoldersFresh:async value=>{calls.push('fresh');assert.equal(value,'roots');return fresh}}),
   normalizeWatchedFontFolders:value=>{calls.push('normalize-roots');assert.deepEqual(Array.from(value),rows.map(row=>row.path));return ['normalized-root']},appendStartupLog:()=>{},
  }})
  return {...extracted,calls,db}
 }
 const selected=storage()
 assert.equal((await selected.ports.openLibraryDb()),selected.db)
 assert.deepEqual(selected.calls.splice(0),['base-db','favorites-init'])
 assert.deepEqual(Array.from(await selected.ports.appWatchedFolders()),['normalized-root'])
 assert.deepEqual(selected.calls.splice(0),['base-db','folder-sql','normalize-roots'],'Watched roots depended on derived favorite import')
 assert.deepEqual(await selected.ports.loadSharedFontsForFolders('roots'),[{id:'cached',favorite:true}])
 assert.deepEqual(selected.calls.splice(0),['favorites-init','cached','favorites-hydrate'])
 async function checkFresh(value) {
  assert.deepEqual(await value.ports.loadSharedFontsForFoldersFresh('roots'),[{id:'fresh',favorite:true}],'Fresh owner was bypassed')
  assert.deepEqual(value.calls.splice(0),['favorites-init','fresh','favorites-hydrate'])
 }
 await checkFresh(selected)
 const storagePath=path.join(sourceRoot,'src/main/bootstrap/mainDataStorageCompositionRuntime.ts'),storageSource=fs.readFileSync(storagePath,'utf8')
 const freshAnchor='runtime.loadSharedFontsForFoldersFresh(folders)'
 assert.equal(storageSource.split(freshAnchor).length,2)
 await assert.rejects(()=>checkFresh(storage(storageSource.replace(freshAnchor,'runtime.loadSharedFontsForFolders(folders)'))),/Fresh owner was bypassed/)
 const expected={appWatchedFolders:selected.ports.appWatchedFolders,loadSharedFontsForFolders:selected.ports.loadSharedFontsForFolders,
  loadSharedFontsForFoldersFresh:selected.ports.loadSharedFontsForFoldersFresh,exists:async()=>false,resolveActiveRootIndexDbPath:async()=>'',
  applySharedMetadataToMergedRows:async()=>[],sharedMetadataSignatureForRoot:async()=>'',saveMetricsSnapshot:async()=>{},migrationDiagnosticsRuntime:{record(){}}}
 assertProductionReadOwnerPorts({...expected},expected)
 for(const name of Object.keys(expected)) {
  const substitute=name==='migrationDiagnosticsRuntime'?{record(){}}:async()=>undefined
  assert.throws(()=>assertProductionReadOwnerPorts({...expected,[name]:substitute},expected),new RegExp(`Production read owner bypassed: ${name}`))
 }
 assert.throws(()=>assertProductionReadOwnerPorts({...expected,loadSharedFontsForFoldersFresh:expected.loadSharedFontsForFolders},
  {...expected,loadSharedFontsForFoldersFresh:expected.loadSharedFontsForFolders}),/Fresh folder reads aliased/)
 const load=loader({}, {setImmediate,clearImmediate})
 const metrics=load('src/main/cache/cacheArchitectureRuntime.ts').createCacheArchitectureRuntime(new Proxy({}, {get(){throw Error('Metrics snapshot introduced persistence work')}}))
 await metrics.saveMetricsSnapshot('font_metrics',{total:5490})
 const logs=[],migration=load('src/main/diagnostics/migrationDiagnosticsRuntime.ts').createMigrationDiagnosticsRuntime({appendStartupLog:line=>logs.push(line)})
 for(let index=0;index<200;index++)migration.record({source:'fixture',kind:'accepted'})
 assert.equal(logs.length,0,'Migration reporting introduced per-event logging')
 const snapshot=migration.snapshot();assert.equal(snapshot.summary.accepted,200);assert.equal(snapshot.recentEvents.length,160)
 // Exercise the actual exists owner with only its filesystem boundary controlled.
 let accessFailure,accessCalls=0
 const appLoad=loader({electron:{app:{}},[path.join(sourceRoot,'src/main/path/sharedFileSystemRuntime.ts')]:{
  sharedFileSystem:{access:async()=>{accessCalls++;if(accessFailure)throw accessFailure}},
 }},{setImmediate,clearImmediate})
 const appPaths=appLoad('src/main/app/appDataPaths.ts').createAppDataPaths({appName:'Fixture',dataDirName:'fixture',dataLayoutVersion:1,cacheArchitectureVersion:1,appendLog:()=>{}})
 assert.equal(await appPaths.exists('fixture-file'),true)
 accessFailure=Object.assign(Error('missing'),{code:'ENOENT'});assert.equal(await appPaths.exists('fixture-file'),false)
 const {SharedIoProcessError}=appLoad('src/main/path/sharedIoProcessRuntime.ts')
 accessFailure=new SharedIoProcessError('controlled unavailable','not-started','stale-generation')
 await assert.rejects(appPaths.exists('fixture-file'),error=>error===accessFailure);assert.equal(accessCalls,3)
 // Use the actual selected performance owner with its sampler unstarted.
 const {createFixturePerformanceRuntime,assertFixtureCacheCanContinue}=require('./check-full-refresh-work.cjs')
 assertFixtureCacheCanContinue({fixtureCacheLifecycle:{snapshot:()=>({blocked:false,activeCaseId:null})}})
 for(const state of [{blocked:true,activeCaseId:null,failure:{message:'archive failed'}},{blocked:false,activeCaseId:'setup-failed-before-host'}])
  assert.throws(()=>assertFixtureCacheCanContinue({fixtureCacheLifecycle:{snapshot:()=>state}}),/blocked subsequent cases/)

 function performanceFixture(factory) {
  let nativeNudges=0
  const host={load:loader({}, {setImmediate,clearImmediate,setInterval(){throw Error('Unexpected sampler start')},clearInterval}),appendStartupLog:()=>{},
   transport:{noteRustCoreSchedulerInteractiveActivity(){nativeNudges++}}}
  const runtime=factory(host)
  try{runtime.markRendererUserActivity(undefined,'fixture-activity');assert.equal(nativeNudges,0,'Unexpected native activity nudge')}
  finally{runtime.stopPerformanceLogSampler();runtime.flushPerformanceLogs('fixture-close')}
 }
 performanceFixture(createFixturePerformanceRuntime)
 const workFile=path.join(__dirname,'check-full-refresh-work.cjs'),workSource=fs.readFileSync(workFile,'utf8').replace(/\r\n/g,'\n')
 const tree=ts.createSourceFile(workFile,workSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
 const helpers=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createFixturePerformanceRuntime')
 assert.equal(helpers.length,1)
 const helper=helpers[0].getText(tree),ownerAnchor='return host.load',endAnchor='  })\n}'
 assert.equal(helper.split(ownerAnchor).length,2);assert.equal(helper.split(endAnchor).length,2)
 const mutated=helper.replace(ownerAnchor,'const owner = host.load').replace(endAnchor,"  })\n  const original = owner.markRendererUserActivity\n  owner.markRendererUserActivity = (...args) => { host.transport.noteRustCoreSchedulerInteractiveActivity('benchmark-foreground'); return original(...args) }\n  return owner\n}")
 const nudged=new Function('path','process',mutated+';return createFixturePerformanceRuntime')(path,process)
 assert.throws(()=>performanceFixture(nudged),/Unexpected native activity nudge/)
 console.log('[diagnostics:full-refresh-acceptance] selected watched/cached/fresh/read/metrics/diagnostic/activity owners and prior-substitute negatives passed')
}
