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
