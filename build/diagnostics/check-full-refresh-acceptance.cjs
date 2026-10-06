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
const failedBaseline=clone(original);failedBaseline[0].passed=false;failedBaseline[0].comparable=false
assert.equal(compareRuns(failedBaseline).comparable,false,'Failed full baseline was made comparable')
console.log('[diagnostics:full-refresh-acceptance] fixed-cohort equality, observed +18ms regression, missing/misclassified/duplicate samples and failed baseline rejection passed')
