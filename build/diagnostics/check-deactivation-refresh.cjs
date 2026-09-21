#!/usr/bin/env node
// U-06: execute real cache, batch settlement, reconciliation and renderer owners.
// Native/IO ports are controlled; call counts are not Windows latency measurements.
const assert = require('node:assert/strict')
const path = require('node:path')
const {loader} = require('./check-operation-chain.cjs')
const {loadModules, font, plain, tick} = require('./check-activation-entry.cjs')
const root = path.resolve(__dirname, '../..')
const ownerFile = 'src/main/install/systemInstalledFontsRuntime.ts'
const batchFile = 'src/main/activation/runtime/fontDeactivationBatchRuntime.ts'
const settlementFile = 'src/main/activation/runtime/fontDeactivationSettlementRuntime.ts'
const statusFile = 'src/main/activation/runtime/fontActivationInstallStatusRuntime.ts'
const actionFile = 'src/renderer/src/runtime/system/actions/fontActivationActionRuntime.ts'
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject} }
let cases = 0
function check(fn) { fn(); cases++ }
const normalize = value => value.toLowerCase().replace(/\\/g, '/')
const installed = name => ({source:'HKLM',registryName:name,path:`C:/Windows/Fonts/${name}.ttf`,value:name,fileName:name+'.ttf'})
function cacheHarness(transform=x=>x) {
  const reads=[],logs=[],ioFailures=[]
  let failIo=false
  const runtime=loader({}, {}, {[path.join(root,ownerFile)]:transform})(ownerFile).createSystemInstalledFontsRuntime({
    platform:'win32',fontExtensions:new Set(['.ttf']),installedFontsTtlMs:10000,
    windowsFontsDir:()=>'/windows-fonts',currentUserFontsDir:()=>'/user-fonts',
    runRustSystemInstalledFonts:()=>{const read=deferred();reads.push(read);return read.promise},
    withGlobalIo:(_,fn)=>{if(failIo)return Promise.reject(Error('system IO unavailable'));const failure=deferred();ioFailures.push(failure);return Promise.race([fn(),failure.promise])},appendStartupLog:line=>logs.push(line)
  })
  return {runtime,reads,logs,ioFailures,fail(value){failIo=value}}
}
async function snapshotBoundaries(transform=x=>x) {
  const h=cacheHarness(transform),old=h.runtime.getSystemInstalledFontsCached(true)
  await tick(); assert.equal(h.reads.length,1)
  h.runtime.clearInstalledFontsMemoryCache()
  const current=h.runtime.getSystemInstalledFontsCached(true)
  await tick(); assert.equal(h.reads.length,2,'post-mutation read joined pre-mutation enumeration');cases++
  h.reads[0].resolve({items:[installed('old')]});await tick()
  const joined=h.runtime.getSystemInstalledFontsCached(true)
  await tick();check(()=>assert.equal(h.reads.length,2,'old finally detached newer in-flight read'))
  h.reads[1].resolve({items:[installed('new')]})
  const results=await Promise.all([old,current,joined])
  check(()=>assert(results.every(items=>items[0].registryName==='new'),'a caller received a stale snapshot'))
  const cached=await h.runtime.getSystemInstalledFontsCached(false)
  check(()=>{assert.equal(cached[0].registryName,'new');assert.equal(h.reads.length,2)})
  const forced=h.runtime.getSystemInstalledFontsCached(true)
  await tick();check(()=>assert.equal(h.reads.length,3,'force reused completed snapshot'))
  h.reads[2].resolve({items:[installed('external-install')]});await forced
  check(()=>assert(h.logs.some(line=>line.includes('discarded: generation=0, current=1'))))
  check(()=>assert(h.logs.some(line=>line.includes('accepted: generation=1, startedAt=')&&line.includes('elapsed='))))
  h.runtime.clearInstalledFontsMemoryCache();h.fail(true)
  await assert.rejects(h.runtime.getSystemInstalledFontsCached(true),/system IO unavailable/);cases++
  h.fail(false);const retried=h.runtime.getSystemInstalledFontsCached(true);await tick()
  h.reads[3].resolve({items:[installed('retry')]});await retried
  check(()=>assert.equal(h.reads.length,4,'failed gate blocked retry'))
}
async function consecutiveMutations() {
  const h=cacheHarness(),reads=[]
  for(let i=0;i<3;i++){h.runtime.clearInstalledFontsMemoryCache();reads.push(h.runtime.getSystemInstalledFontsCached(true));await tick()}
  h.reads[1].resolve({items:[installed('second')]});h.reads[0].resolve({items:[installed('first')]});await tick()
  check(()=>assert.equal(h.reads.length,3))
  h.reads[2].resolve({items:[installed('latest')]})
  const values=await Promise.all(reads)
  check(()=>assert(values.every(items=>items[0].registryName==='latest')))
}
async function obsoleteFailure() {
  const h=cacheHarness(),old=h.runtime.getSystemInstalledFontsCached(true)
  const failed=assert.rejects(old,/old IO failure/)
  h.runtime.clearInstalledFontsMemoryCache()
  const current=h.runtime.getSystemInstalledFontsCached(true)
  h.ioFailures[0].reject(Error('old IO failure'));await failed;await tick()
  const joined=h.runtime.getSystemInstalledFontsCached(true);await tick()
  check(()=>assert.equal(h.reads.length,2,'obsolete failed read detached new request'))
  h.reads[1].resolve({items:[installed('current')]})
  const values=await Promise.all([current,joined])
  check(()=>assert(values.every(items=>items[0].registryName==='current')))
}
function batchHarness({count=3,registryFail=false,resourceFail=false,queueFail=false,readFail=false,missing=false,orphan=false,permanent=false,transforms={}}={}) {
  const load=loader({}, {}, transforms),logs=[],order=[],registry=[],queued=[],saved=[],statuses=[]
  const fonts=Array.from({length:count},(_,i)=>({...font('f'+i),active:true,managedInstallPath:`C:/Managed/f${i}.ttf`}))
  const records=fonts.map(item=>({fontId:item.id,sourcePath:item.path,installPath:item.managedInstallPath,registryName:'HFM_'+item.id,fileName:item.fileName,activatedAt:'2026-09-18'}))
  let enumerations=0,resources=0,comparisons=0
  const system=[]
  if(permanent)system.push(installed('permanent'))
  if(orphan)system.push({source:'HKCU',registryName:'HFM_f0',path:'C:/Managed/orphan.ttf',value:'C:/Managed/orphan.ttf',fileName:'other.ttf'})
  const deps={ensureWindows(){},appendStartupLog:line=>logs.push(line),normalizePathForCacheCompare:normalize,
    loadTemporaryActiveFonts:async()=>({version:1,records:missing?[]:records}),
    saveTemporaryActiveFonts:async state=>{order.push('save');saved.push(plain(state))},
    removeFontResourceSessionBatch:async paths=>{resources++;order.push('remove');return Object.fromEntries(paths.map((p,i)=>[p,{ok:!(resourceFail&&i===0),count:1,message:'controlled resource'}]))},
    clearInstalledFontsMemoryCache:()=>order.push('invalidate'),
    getSystemInstalledFontsCached:async force=>{assert.equal(force,true);enumerations++;order.push('enumerate');if(readFail)throw Error('enumeration failed');return system},
    compareFontInstalledWithList:()=>{comparisons++;return {installed:permanent,by:permanent?'system':'none',matches:system.filter(x=>x.source==='HKLM')}},
    isTemporaryActiveInstalledRecord:record=>record.registryName.startsWith('HFM_'),
    safeTemporaryActiveFontName:item=>item.id+'.ttf',temporaryActiveRegistryNameFor:item=>'HFM_'+item.id,
    scheduleActivationInstallStatusSave:values=>statuses.push(plain(values)),scheduleBackgroundFontRefreshTail:()=>order.push('tail')
  }
  const cleanup={
    verifyManagedRecord:async()=>true,
    persistRecordStage:async(record,stage)=>{record.stage=stage},
    deleteManagedRegistryRecords:async values=>{const names=Array.from(values,record=>record.registryName);registry.push(names);order.push('registry');if(registryFail&&names.includes('HFM_f0'))throw Error('registry denied')},
    queueTemporaryFontFileDeletes:async values=>{queued.push(values.map(x=>x.fontId));order.push('queue');return Object.fromEntries(values.map(record=>[record.installPath,{ok:!(queueFail&&record.fontId==='f0'),message:'durable queue'}]))}
  }
  const runtime=load(batchFile).createFontDeactivationBatchRuntime(deps,cleanup)
  return {runtime,fonts,records,deps,logs,order,registry,queued,saved,statuses,counts:()=>({enumerations,resources,comparisons})}
}
async function batchCases(transforms={}) {
  const h=batchHarness({count:40,transforms})
  const result=await h.runtime.deactivateFontSessionsBatch(h.fonts)
  check(()=>{assert.equal(result.deactivated,40);assert.equal(result.failed,0);assert.equal(result.ok,true)})
  check(()=>{assert.deepEqual(h.counts(),{enumerations:1,resources:1,comparisons:40});assert.equal(h.registry.length,1);assert.equal(h.registry[0].length,40)})
  check(()=>{assert.deepEqual(h.order,['remove','registry','queue','save','invalidate','enumerate','tail']);assert.equal(h.queued.length,1);assert.equal(h.saved[0].records.length,0)})
  for(const stage of ['resource-remove','registry-settlement','file-queue','session-load','session-save','system-enumerate','status-compare','status-save-enqueue','batch-total'])
    check(()=>assert(h.logs.some(line=>line.includes('deactivate:'+stage)&&line.includes('elapsed=')),stage))
  for(const failure of ['registryFail','resourceFail','queueFail']) {
    const h=batchHarness({[failure]:true}),result=await h.runtime.deactivateFontSessionsBatch(h.fonts)
    check(()=>{assert.equal(result.deactivated,2);assert.equal(result.failed,1);assert.equal(result.results.f0.ok,false);assert.equal(result.results.f0.temporaryActivated,true);assert.equal(h.saved[0].records[0].fontId,'f0');assert.equal(h.counts().resources,1)})
    if(failure==='registryFail')check(()=>{assert.equal(h.registry.length,4);assert.deepEqual(h.registry.slice(1),[['HFM_f0'],['HFM_f1'],['HFM_f2']]);assert.deepEqual(plain(h.queued),[['f1','f2']])})
  }
  for(const mode of [{readFail:true},{missing:true,readFail:true},{missing:true,orphan:true},{orphan:true}]) {
    const h=batchHarness({...mode,count:1,transforms}),result=await h.runtime.deactivateFontSessionsBatch(h.fonts)
    check(()=>{assert.equal(result.ok,false);assert.equal(result.deactivated,0);assert.equal(result.failed,1);assert.equal(result.skippedAlreadyActive,0);assert(result.results.f0.message);if(mode.readFail)assert.equal(h.statuses.length,0)})
  }
  for(const missing of [true,false]) {
    const h=batchHarness({permanent:true,missing,count:1}),result=await h.runtime.deactivateFontSessionsBatch(h.fonts)
    check(()=>{assert.equal(result.ok,true);assert.equal(h.statuses[0].f0.by,'system');assert.equal(h.statuses[0].f0.installed,true);assert.equal(h.counts().enumerations,1);assert.equal(h.counts().resources,missing?0:1)})
  }
  const empty=batchHarness({count:0});await empty.runtime.deactivateFontSessionsBatch([])
  check(()=>assert.deepEqual(empty.counts(),{resources:0,enumerations:0,comparisons:0}))
}
async function temporaryIndex() {
  const h=batchHarness({count:3,missing:true}),a=h.fonts[0],b=h.fonts[1]
  const temporary=(registryName,fileName,p)=>({source:'HKCU',registryName,fileName,path:p,value:p})
  const records=[installed('permanent'),temporary('HFM_OTHER','OTHER.TTF',a.managedInstallPath.toUpperCase()),temporary('HFM_f0','f0.ttf','C:/other/a.ttf'),temporary('HFM_other2','F1.TTF','C:/other/b.ttf'),temporary('HFM_f1','f1.ttf','C:/removed.ttf')]
  h.deps.getSystemInstalledFontsCached=async()=>records
  h.deps.isTemporaryActiveInstalledRecord=x=>x.registryName.startsWith('HFM_')
  h.deps.compareFontInstalledWithList=()=>({installed:true,by:'system',matches:[records[0]]})
  const actual=await loader()(statusFile).createFontActivationInstallStatusRuntime(h.deps).reconcileDeactivatedInstallStatus(h.fonts,['c:/removed.ttf'])
  check(()=>{assert.deepEqual(plain(actual[a.id].matches),[records[0],records[1],records[2]]);assert.equal(actual[a.id].by,'both')})
  check(()=>{assert.deepEqual(plain(actual[b.id].matches),[records[0],records[3]]);assert.equal(actual[b.id].by,'both');assert.equal(actual.f2.by,'system')})
}
async function rendererTiming() {
  for(const batch of [true,false])for(const fail of [true,false]) {
    const events=[],a={...font('a'),active:true},busy=new Set();let current=a,count=1
    const hfm={reportPerformanceEvent:async payload=>events.push(JSON.parse(payload.details.event)),deactivateFont:async()=>({ok:!fail,message:'controlled'}),deactivateFonts:async()=>({ok:!fail,message:'controlled',results:{a:{ok:!fail}}})}
    const load=loadModules({window:{hfm}},{}),runtime=load(actionFile).createFontActivationActionRuntime({hfm,library:{fonts:{a}},getCurrentLibrary:()=>({fonts:{a:current}}),activeOperationFontIds:{current:busy},setStatus(){},refreshDatabaseDerivedState(){}},
      {setFontActiveRuntime:(_,active,patch)=>{current={...current,...patch,active}},setFontsActiveRuntimeBulk:updates=>{if(updates.a)current={...current,...updates.a.patch,active:updates.a.active}},adjustDatabaseActiveCount:n=>count+=n})
    await (batch?runtime.deactivateFontsBatch([a],'test'):runtime.deactivateFontByCard(a));await tick()
    check(()=>{assert.equal(current.active,fail);assert.equal(count,fail?1:0);assert.equal(busy.size,0);assert.equal(events.length,1);assert.equal(events[0].reason,batch?'deactivation-batch':'deactivation-single');assert.equal(events[0].outcome,fail?'rolled-back':'confirmed');assert(events[0].elapsedMs>=0)})
  }
}
async function main() {
  if (process.argv.includes('--c05-batch-only')) {
    await batchCases()
    await assert.rejects(batchCases({[path.join(root,settlementFile)]:source=>source.replace('() => deps.deleteManagedRegistryRecords(registryRecords)', 'async () => { for (const record of registryRecords) await deps.deleteManagedRegistryRecords([record]); }')}),/strictly equal/);cases++
    await assert.rejects(batchCases({[path.join(root,batchFile)]:source=>source.replace('recordsByItemId.has(item.id) && results[item.id]?.ok','recordsByItemId.has(item.id)')}),/strictly equal/);cases++
    console.log(`[diagnostics:deactivation-refresh] C-05 batch settlement passed: batch counts, ownership-checked registry isolation, queue boundaries and 2 rejected regressions; renderer timing intentionally not entered`)
    return
  }
  await snapshotBoundaries();await consecutiveMutations();await obsoleteFailure();await batchCases();await temporaryIndex();await rendererTiming()
  await assert.rejects(snapshotBoundaries(source=>source.replace('installedFontsGeneration += 1','installedFontsGeneration += 0').replace('    installedFontsReadInFlight = null\n  }','  }')),/post-mutation read joined/);cases++
  await assert.rejects(batchCases({[path.join(root,settlementFile)]:source=>source.replace('() => deps.deleteManagedRegistryRecords(registryRecords)', 'async () => { for (const record of registryRecords) await deps.deleteManagedRegistryRecords([record]); }')}),/strictly equal/);cases++
  await assert.rejects(batchCases({[path.join(root,batchFile)]:source=>source.replace('recordsByItemId.has(item.id) && results[item.id]?.ok','recordsByItemId.has(item.id)')}),/strictly equal/);cases++
  await snapshotBoundaries(source=>source.replace(/\r?\n/g,'\r\n'))
  const trace=loader()('src/main/activation/runtime/fontActivationTraceRuntime.ts').createFontActivationTraceRuntime({appendStartupLog(){throw Error('log offline')}})
  check(()=>assert.equal(trace.activationTraceSync('sync',undefined,()=>42),42))
  assert.equal(await trace.activationTraceStep('async',undefined,async()=>42),42);cases++
  await assert.rejects(trace.activationTraceStep('failure',undefined,async()=>{throw Error('real failure')}),/real failure/);cases++
  console.log(`[diagnostics:deactivation-refresh] ${cases} controlled checks passed: fresh snapshots, batch counts, failure boundaries, temporary/permanent matching, renderer rollback/timing, 3 rejected regressions; Windows timing remains unmeasured`)
}
main().catch(error=>{console.error(error);process.exitCode=1})
