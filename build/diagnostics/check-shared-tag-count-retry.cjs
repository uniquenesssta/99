#!/usr/bin/env node
// Deterministic owner/clock faults; real Windows pins are tested in native and IPC gates.
const assert = require('node:assert/strict'), path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const tick = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { for (let i=0;i<4;i++) await tick() }
const deferred = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject} }
const metrics={total:8,sharedTagCounts:{Known:8},localTagCounts:{Local:1},tagCounts:{Known:8,Local:1}}
function fixture(throwNotification = false) {
 const timers=new Map(), delays=[], notifications=[], statuses=[], logs=[], listeners=[];let sequence=0,revision=0,calls=0,closing=false,read=async()=>({Known:9})
 const load=loader({[path.join(root,'src/main/app/shutdownCoordinatorRuntime.ts')]:{
  isApplicationClosing:()=>closing,onApplicationClosing:fn=>{listeners.push(fn);return ()=>{const at=listeners.indexOf(fn);if(at>=0)listeners.splice(at,1)}},
  assertLocalShutdownWorkAllowed(){},applicationWorkEpoch:()=>0,
 }},{setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,()=>{timers.delete(id);fn()});delays.push(delay);return id},clearTimeout:id=>timers.delete(id)})
 const {SharedIoProcessError}=load('src/main/path/sharedIoProcessRuntime.ts')
 const failure=load('src/main/indexing/shared-metadata/sharedMetadataSnapshotFailureRuntime.ts')
 const busy=(closed)=>{const e=new SharedIoProcessError('Shared I/O process failed: code=2, signal=null, message=[HFM_BINDING_SNAPSHOT_BUSY:wal:32] binding snapshot wal pin unavailable','unknown','process-exit');e.closed=closed;try{failure.rethrowSharedMetadataSnapshotBusy(e,'C:/private-root')}catch(value){return value}throw Error('busy not classified')}
 const owner=load('src/main/library/sharedTagMetricsSnapshotRuntime.ts').createSharedTagMetricsSnapshotRuntime({roots:async()=>['C:/private-root'],revision:()=>revision,read:()=>{calls++;return read()},changed:x=>{notifications.push(x);statuses.push(owner.apply(metrics).sharedTagCountsStatus);if(throwNotification)throw Error('observer fault')},appendLog:x=>logs.push(x)})
 return {owner,timers,delays,notifications,statuses,logs,busy,SharedIoProcessError,failure,load,get calls(){return calls},setRead:fn=>read=fn,bump:()=>revision++,close:()=>{closing=true;listeners.forEach(fn=>fn())},resume:()=>closing=false,
  fire:()=>{assert.equal(timers.size,1);const [id,fn]=timers.entries().next().value;timers.delete(id);fn()},
  seed:async()=>{owner.apply(metrics);await settle();assert.equal(owner.apply(metrics).sharedTagCounts.Known,9)}}
}
async function main(){
 {
  const f=fixture(true);await f.seed();assert.equal(f.owner.apply(metrics).sharedTagCountsStatus,'current');assert.equal(f.timers.size,0);assert(!f.logs.some(x=>x.includes('counts retained')),'observer fault reclassified a successful snapshot');assert(f.logs.some(x=>x.includes('notification failed')));await f.owner.dispose()
 }

 {
  const f=fixture();await f.seed();const closed=deferred();f.bump();f.setRead(async()=>{throw f.busy(closed.promise)});f.owner.apply(metrics);await settle()
  assert.equal(f.calls,2);assert.equal(f.timers.size,0,'retry scheduled before physical close');assert.equal(f.owner.apply(metrics).sharedTagCounts.Known,9)
  closed.resolve();await settle();assert.equal(f.notifications.length,2,'unavailable transition did not notify without a new query');assert.equal(f.statuses.at(-1),'unavailable');assert.equal(f.timers.size,1);assert.equal(f.owner.apply(metrics).sharedTagCountsStatus,'unavailable')
  for(let i=0;i<20;i++)f.owner.apply(metrics);assert.equal(f.calls,2,'demand bypassed retry backoff')
  f.setRead(async()=>({Known:9}));f.fire();await settle();assert.equal(f.owner.apply(metrics).sharedTagCountsStatus,'current');assert.equal(f.calls,3);assert.equal(f.notifications.length,3,'same-count recovery did not notify exactly once');assert.equal(f.timers.size,0)
  assert(f.logs.some(x=>x.includes('pin=wal')&&/root=[a-f0-9]{16}/.test(x)));assert(!f.logs.some(x=>x.includes('private-root')));await f.owner.dispose()
 }
 {
  const f=fixture();await f.seed();f.bump();f.setRead(async()=>{throw f.busy()});f.owner.apply(metrics);await settle()
  for(let i=0;i<3;i++){f.fire();await settle()}
  assert.deepEqual(f.delays,[250,1000,3000]);assert.equal(f.calls,5);assert.equal(f.timers.size,0);assert.equal(f.owner.apply(metrics).sharedTagCounts.Known,9);assert.equal(f.owner.apply(metrics).sharedTagCountsStatus,'unavailable')
  for(let i=0;i<20;i++)f.owner.apply(metrics);assert.equal(f.calls,5,'exhausted revision restarted itself');assert(f.logs.some(x=>x.includes('retry exhausted')));assert.equal(f.notifications.length,2,'repeated busy attempts must not notify repeatedly');await f.owner.dispose()
 }
 for(const reason of ['process-exit','invalid-receipt','permission-denied','root-offline','timeout','cancelled']){
  const f=fixture();await f.seed();f.bump();f.setRead(async()=>{throw new f.SharedIoProcessError('binding snapshot WAL checksum invalid (os error 32)','unknown',reason)});f.owner.apply(metrics);await settle();assert.equal(f.timers.size,0,reason+' retried');assert.equal(f.owner.apply(metrics).sharedTagCounts.Known,9);await f.owner.dispose()
 }
 for(const change of ['invalidate','revision','root-generation','shutdown','dispose']){
  const f=fixture();await f.seed();f.bump();f.setRead(async()=>{throw f.busy()});f.owner.apply(metrics);await settle();const old=f.timers.values().next().value;assert(old)
  if(change==='invalidate')f.owner.invalidate()
  if(change==='revision')f.bump()
  if(change==='root-generation')f.load('src/main/path/startupPathAvailabilityRuntime.ts').markStartupPathRootUnavailable('C:/private-root',Error('offline'))
  if(change==='shutdown')f.close()
  if(change==='dispose')await f.owner.dispose()
  old();await settle();assert.equal(f.calls,2,change+' resumed stale retry');assert.equal(f.notifications.length,2)
  if(change==='shutdown'){f.resume();f.setRead(async()=>({Known:10}));f.owner.apply(metrics);await settle();assert.equal(f.calls,3);assert.equal(f.owner.apply(metrics).sharedTagCounts.Known,10)}
  await f.owner.dispose();assert.equal(f.timers.size,0)
 }
 {
  const f=fixture();await f.seed();f.bump();f.setRead(async()=>{throw f.busy()});f.owner.apply(metrics);await settle();const gate=deferred();f.setRead(()=>gate.promise);f.fire();await settle();f.owner.invalidate();gate.resolve({Known:100});await settle();assert.equal(f.notifications.length,2,'superseded retry published');await f.owner.dispose()
 }
 {
  const f=fixture();await f.seed();f.bump();const gate=deferred(),closed=deferred();f.setRead(()=>gate.promise);f.owner.apply(metrics);await settle();let done=false;const stop=f.owner.dispose().then(()=>done=true);gate.reject(f.busy(closed.promise));await settle();assert.equal(done,false,'dispose abandoned physical close');closed.resolve();await stop;assert.equal(f.timers.size,0)
 }
 console.log('[diagnostics:shared-tag-count-retry] initial+3 bounded busy retries; physical close, same-count recovery, genuine failures, generations, shutdown and exhaustion passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
