'use strict'
// Bounded observation of actual query ownership. It never retires runtime work,
// retries a request, or changes the original value, error or Promise.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { AsyncLocalStorage } = require('node:async_hooks')
const { isPromise } = require('node:util').types
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const errorView = error => ({ name:error?.name, code:error?.code, reason:error?.reason, outcome:error?.outcome,
  message:String(error?.message ?? error).slice(0,320) })
function inputDigest(input) {
  assert.deepEqual(Object.keys(input).sort(),['dbPath','rows'])
  assert.equal(typeof input.dbPath,'string')
  assert(Array.isArray(input.rows))
  return hash({dbPath:input.dbPath,rows:Array.from(input.rows,row=>{
    assert.deepEqual(Object.keys(row).sort(),['aliases','fontPath','itemId'])
    assert.equal(typeof row.itemId,'string');assert.equal(typeof row.fontPath,'string')
    assert(Array.isArray(row.aliases)&&row.aliases.every(alias=>typeof alias==='string'))
    return {itemId:row.itemId,fontPath:row.fontPath,aliases:Array.from(row.aliases)}
  })})
}
function tagDigest(items) {
  assert(Array.isArray(items))
  const rows=Array.from(items,item=>{
    assert.equal(typeof item.id,'string')
    assert(Array.isArray(item.localTagNames)&&item.localTagNames.every(tag=>typeof tag==='string'))
    return JSON.stringify([item.id,Array.from(item.localTagNames)])
  }).sort()
  return hash(rows)
}

function createQueryRetirementObserver({getContext=()=>undefined,limits={}}={}) {
  const signalOwners=new WeakMap(), listeners=new Map(), patches=[]
  const ipcScope=new AsyncLocalStorage(), tagScope=new AsyncLocalStorage(), hydrationScope=new AsyncLocalStorage()
  const rows={signals:[],invalidations:[],transports:[],hydrations:[],ipcs:[]}
  const caps={signals:1024,invalidations:256,transports:256,hydrations:256,ipcs:256}
  for(const key of Object.keys(caps))if(Number.isInteger(limits[key]))caps[key]=Math.max(0,Math.min(caps[key],limits[key]))
  let sequence=0,ownerSequence=0,observerErrors=0,dropped=0,restorationConflicts=0,stopped=false,installed=false,currentInvalidation,taskProof='not-installed'
  let currentSignal=()=>undefined
  const guard=fn=>{try{return fn()}catch{observerErrors++;return undefined}}
  const add=(kind,value)=>{if(rows[kind].length>=caps[kind]){dropped++;return undefined}const row={id:++sequence,...value};rows[kind].push(row);return row}
  const context=()=>{const outer=ipcScope.getStore(), value=getContext();return {actionId:outer?.actionId||value?.actionId,intentSha256:outer?.intentSha256,ipcId:outer?.id}}
  function watch(value,ok,fail) {
    if(isPromise(value))guard(()=>{Promise.prototype.then.call(value,v=>guard(()=>ok(v)),e=>guard(()=>fail(e)))})
    else guard(()=>ok(value))
    return value
  }
  function observeSignal(signal) {
    if(!signal||stopped)return undefined
    let row=signalOwners.get(signal)
    if(row)return row
    const owner=tagScope.getStore(),ipc=ipcScope.getStore()
    if(!owner||!ipc?.tagPage)return undefined
    row=add('signals',{...context(),ownerId:owner?.id,tagGeneration:owner?.generation,
      firstObservedAt:performance.now(),firstObservedLive:signal.aborted===false})
    if(!row)return undefined
    signalOwners.set(signal,row)
    const abort=()=>guard(()=>{
      row.abortedAt=performance.now()
      if(currentInvalidation?.ownerId===row.ownerId&&currentInvalidation.cancelInFlight===true)row.invalidationId=currentInvalidation.id
    })
    if(!signal.aborted){signal.addEventListener('abort',abort,{once:true});listeners.set(signal,abort)}
    return row
  }
  function patch(object,key,make) {
    assert.equal(typeof object[key],'function',`Missing retirement observation port: ${key}`)
    const original=object[key],wrapped=make(original)
    object[key]=wrapped;patches.push({object,key,original,wrapped})
  }
  function installSelectedSource(load,{supportsQueryTasks=true}={}) {
    if(installed||stopped)return
    installed=true
    if(!supportsQueryTasks){taskProof='unsupported-legacy-source';return}
    taskProof='selected-source-query-tasks'
    guard(()=>{
      currentSignal=load('src/main/path/sharedFileSystemRuntime.ts').currentSharedIoSignal
      patch(load('src/main/library/fontQueryTaskRuntime.ts'),'createFontQueryTask',original=>function(...args){
        let row
        const wrapped=function(...values){row=guard(()=>observeSignal(currentSignal()));return Reflect.apply(args[0],this,values)}
        const task=Reflect.apply(original,this,[wrapped,...args.slice(1)])
        if(row)guard(()=>watch(task.pending,()=>{row.settledAt=performance.now();row.outcome='returned'},error=>{row.settledAt=performance.now();row.outcome='rejected';row.error=errorView(error)}))
        return task
      })
      patch(load('src/main/library/tagFontQueryRuntime.ts'),'createTagFontQueryRuntime',original=>function(...args){
        const runtime=Reflect.apply(original,this,args)
        if(stopped)return runtime
        if(ownerSequence>=caps.invalidations){dropped++;return runtime}
        const owner={id:++ownerSequence,generation:0}
        guard(()=>patch(runtime,'query',query=>function(...values){return tagScope.run(owner,()=>Reflect.apply(query,this,values))}))
        guard(()=>patch(runtime,'invalidate',invalidate=>function(...values){
          if(stopped)return Reflect.apply(invalidate,this,values)
          const prior=currentInvalidation,row=guard(()=>add('invalidations',{ownerId:owner.id,generationBefore:owner.generation,
            cancelInFlight:values[0]!==false,startedAt:performance.now()}))
          currentInvalidation=row
          try{const result=Reflect.apply(invalidate,this,values);owner.generation++;guard(()=>{if(row){row.ok=true;row.generationAfter=owner.generation;row.finishedAt=performance.now()}});return result}
          catch(error){guard(()=>{if(row){row.ok=false;row.error=errorView(error);row.finishedAt=performance.now()}});throw error}
          finally{currentInvalidation=prior}
        }))
        return runtime
      })
    })
  }
  function runIpc({channel,args,actionId},run) {
    if(stopped||channel!=='fonts:queryPage')return run()
    const row=guard(()=>add('ipcs',{channel,actionId,intentSha256:hash(args),startedAt:performance.now(),
      tagPage:args?.[0]?.sidebarPage==='tags'}))
    const invoke=()=>{
      let result
      try{result=run()}catch(error){guard(()=>{if(row){row.ok=false;row.error=errorView(error);row.finishedAt=performance.now()}});throw error}
      return watch(result,value=>{if(row){row.ok=true;row.finishedAt=performance.now();row.total=value?.total;row.workerMode=value?.workerMode
        if(row.tagPage){row.itemCount=value.items.length;row.tagSha256=tagDigest(value.items)}}},error=>{if(row){row.ok=false;row.finishedAt=performance.now();row.error=errorView(error)}})
    }
    return row?ipcScope.run(row,invoke):invoke()
  }
  function runHydration(receipt,run) {
    if(stopped)return run()
    const row=guard(()=>{
      const signal=signalOwners.get(currentSignal()),ipc=ipcScope.getStore()
      // Retirement can only explain an observed tagged-page query attempt.
      // Ordinary metrics/setup hydration keeps its existing raw native proof,
      // without adding another whole-population hash or copied summary here.
      if(!signal?.ownerId||!ipc?.tagPage||signal.ipcId!==ipc.id||signal.actionId!==ipc.actionId||signal.intentSha256!==ipc.intentSha256)return undefined
      return add('hydrations',{hydrationId:receipt.id,...context(),signalId:signal.id,startedAt:receipt.startedAt,requestedCount:receipt.requestedCount})
    })
    return hydrationScope.run(row,run)
  }
  function recordHydrationInput(receipt,input) {
    const row=hydrationScope.getStore()
    if(stopped||!row)return
    guard(()=>{assert.equal(row.hydrationId,receipt.id)
      row.inputSha256=inputDigest(input);row.inputCount=input.rows.length
      receipt.querySignalId=row.signalId;receipt.queryInputSha256=row.inputSha256
    })
  }
  function finishHydration(receipt,items,error,failed) {
    const row=hydrationScope.getStore()
    if(stopped||!row)return
    guard(()=>{assert.equal(row.hydrationId,receipt.id)
      row.finishedAt=performance.now();row.ok=!failed
      if(failed)row.error=errorView(error)
      else {row.tagSha256=tagDigest(items);row.returnedCount=items.length;row.populationValidated=receipt.populationValidated===true;row.workerMode=receipt.workerMode}
    })
  }
  function wrapTransport(original) {
    return function(...args){
      if(stopped||!hydrationScope.getStore()||args[1]?.[0]!=='--local-tags-read')return Reflect.apply(original,this,args)
      const row=guard(()=>{const h=hydrationScope.getStore(),signal=signalOwners.get(args[2]?.signal||currentSignal())
        return add('transports',{...context(),command:'--local-tags-read',hydrationId:h?.hydrationId,inputSha256:h?.inputSha256,
          signalId:signal?.id,startedAt:performance.now(),signalAbortedAtStart:(args[2]?.signal||currentSignal())?.aborted===true})})
      let result
      try{result=Reflect.apply(original,this,args)}catch(error){guard(()=>{if(row){row.outcome='rejected';row.finishedAt=performance.now();row.error=errorView(error)}});throw error}
      return watch(result,()=>{if(row){row.outcome='returned';row.finishedAt=performance.now();row.elapsedMs=row.finishedAt-row.startedAt}},error=>{if(row){row.outcome='rejected';row.finishedAt=performance.now();row.elapsedMs=row.finishedAt-row.startedAt;row.error=errorView(error)}})
    }
  }
  function observePoolRequest(request,row) {
    if(stopped)return
    guard(()=>{const signal=signalOwners.get(request.signal);if(signal){row.querySignalId=signal.id;row.queryIntentSha256=signal.intentSha256}})
  }
  function restore() {
    if(stopped)return
    stopped=true
    for(const [signal,listener]of listeners)guard(()=>signal.removeEventListener('abort',listener))
    listeners.clear()
    for(const entry of patches.reverse())guard(()=>{if(entry.object[entry.key]!==entry.wrapped){restorationConflicts++;return}entry.object[entry.key]=entry.original})
  }
  function snapshot(){return guard(()=>JSON.parse(JSON.stringify({version:1,taskProof,
    scope:'owned tag-query signal within matching tagged-page IPC only; ordinary metrics/setup native receipts remain in host evidence',
    stopped,observerErrors,dropped,restorationConflicts,limits:caps,...rows})))||{version:1,observerErrors:observerErrors+1,dropped,restorationConflicts}}
  return {installSelectedSource,runIpc,runHydration,recordHydrationInput,finishHydration,wrapTransport,observePoolRequest,snapshot,restore}
}

function validateQueryRetirements({observation,hydrationReceipts,processRequests=[]}) {
  const o=observation
  assert(o&&o.version===1,'Query retirement observation missing')
  assert.equal(o.observerErrors,0,'Query retirement observer failed');assert.equal(o.dropped,0,'Query retirement evidence overflowed')
  assert.equal(o.restorationConflicts,0,'Query retirement restoration conflicted')
  const unique=(rows,key)=>{const map=new Map();for(const row of rows){assert(Number.isSafeInteger(row[key])&&row[key]>0&&!map.has(row[key]),'Invalid/duplicate query retirement identity');map.set(row[key],row)}return map}
  const signals=unique(o.signals,'id'),invalidations=unique(o.invalidations,'id'),ipcs=unique(o.ipcs,'id')
  const hydrations=unique(o.hydrations,'hydrationId'),receipts=unique(hydrationReceipts,'id')
  const certificates=[],retiredHydrationIds=[],retiredRequestOrdinals=[]
  const cancelled=error=>error&&(!error.reason||['cancelled','query-superseded'].includes(error.reason))
    &&(!error.code||error.code==='ABORT_ERR')&&(error.name==='AbortError'||error.code==='ABORT_ERR'||['cancelled','query-superseded'].includes(error.reason))
  function priorHydrationHistory(candidates,signal,ipc) {
    // Older successful work is still raw paid work, never a retirement exclusion.
    // Generation is only a proposed classification: prove every owner, edge,
    // native receipt and lifetime before removing a row from replacement matching.
    const history=candidates.filter(row=>signals.get(row.signalId)?.tagGeneration<signal.tagGeneration)
    if(!history.length)return history
    const first=Math.min(...history.map(row=>signals.get(row.signalId).tagGeneration))
    assert(Number.isSafeInteger(first)&&first>=0&&Number.isSafeInteger(signal.tagGeneration)
      &&signal.tagGeneration-first<o.signals.length,'Prior hydration generation span is invalid')
    const chain=o.signals.filter(row=>row.ipcId===ipc.id&&row.tagGeneration>=first&&row.tagGeneration<=signal.tagGeneration)
      .sort((a,b)=>a.tagGeneration-b.tagGeneration)
    assert(chain.length===signal.tagGeneration-first+1&&chain.at(-1).id===signal.id,'Prior hydration chain has a generation gap or branch')
    for(let index=0;index<chain.length-1;index++){
      const current=chain[index],following=chain[index+1],edge=invalidations.get(current.invalidationId)
      assert(current.tagGeneration===first+index&&current.ownerId===signal.ownerId&&current.actionId===signal.actionId
        &&current.intentSha256===signal.intentSha256&&current.firstObservedLive===true
        &&Number.isFinite(current.firstObservedAt)&&current.firstObservedAt>=ipc.startedAt,'Prior hydration query ownership changed')
      assert(edge?.ok===true&&edge.cancelInFlight===true&&edge.ownerId===current.ownerId
        &&edge.generationBefore===current.tagGeneration&&edge.generationAfter===following.tagGeneration
        &&following.tagGeneration===current.tagGeneration+1,'Prior hydration lacks an exact owned invalidation')
      assert.equal(o.invalidations.filter(row=>row.ownerId===current.ownerId&&row.generationBefore===current.tagGeneration).length,1,
        'Prior hydration invalidation is ambiguous')
      assert(current.firstObservedAt<=edge.startedAt&&edge.startedAt<=current.abortedAt&&current.abortedAt<=edge.finishedAt
        &&edge.finishedAt<=following.firstObservedAt,'Prior hydration invalidation order changed')
      assert(!o.invalidations.some(row=>row.ownerId===current.ownerId&&row.id!==edge.id
        &&row.startedAt>=edge.startedAt&&row.startedAt<=following.firstObservedAt),'Prior hydration skipped an owned invalidation')
      assert(current.outcome==='rejected'&&current.error?.reason==='query-superseded'&&Number.isFinite(current.settledAt)
        &&current.settledAt>=current.abortedAt&&current.settledAt<=signal.settledAt,'Prior hydration task settlement changed')
      const owned=o.hydrations.filter(row=>row.signalId===current.id)
      assert(owned.length<=1,'Prior hydration is duplicated')
      if(!owned.length){
        assert(!o.transports.some(row=>row.signalId===current.id)&&!hydrationReceipts.some(row=>row.querySignalId===current.id),
          'Prior hydration chain has unowned native evidence')
        continue
      }
      const hydration=owned[0],receipt=receipts.get(hydration.hydrationId)
      assert(history.includes(hydration)&&hydration.ok===true&&hydration.error===undefined
        &&hydration.ipcId===ipc.id&&hydration.actionId===signal.actionId&&hydration.intentSha256===signal.intentSha256,
        'Prior hydration identity changed')
      assert(hydration.startedAt>=current.firstObservedAt&&hydration.finishedAt>=hydration.startedAt
        &&hydration.finishedAt<=edge.startedAt,'Prior hydration was not completed before invalidation')
      assert(/^[a-f0-9]{64}$/.test(hydration.inputSha256||'')&&Number.isSafeInteger(hydration.inputCount)&&hydration.inputCount>0
        &&hydration.requestedCount===hydration.inputCount,'Prior hydration native input proof missing')
      assert(receipt?.ok===true&&receipt.error===undefined&&receipt.querySignalId===current.id&&receipt.queryInputSha256===hydration.inputSha256
        &&receipt.populationValidated===true&&receipt.nativePopulationValidated===true&&receipt.nativeCalls===1&&receipt.workerMode==='rust-local-tags-read'
        &&receipt.startedAt===hydration.startedAt&&receipt.finishedAt>=hydration.finishedAt&&receipt.finishedAt<=edge.startedAt,
        'Prior hydration native receipt proof missing')
      assert.equal(hydrationReceipts.filter(row=>row.querySignalId===current.id).length,1,'Prior hydration native receipt is duplicated')
      for(const key of ['requestedCount','requestedUniqueIds','nativeRequestedCount','nativeUniqueIds','returnedCount','returnedUniqueIds'])
        assert.equal(receipt[key],hydration.inputCount,'Prior hydration native population changed')
      const completed=o.transports.filter(row=>row.hydrationId===hydration.hydrationId||row.signalId===current.id)
      assert.equal(completed.length,1,'Prior hydration native attempt count changed')
      const native=completed[0]
      assert(native.command==='--local-tags-read'&&native.hydrationId===hydration.hydrationId&&native.signalId===current.id
        &&native.outcome==='returned'&&native.error===undefined&&native.signalAbortedAtStart===false
        &&native.inputSha256===hydration.inputSha256&&native.actionId===signal.actionId&&native.intentSha256===signal.intentSha256&&native.ipcId===ipc.id
        &&native.startedAt>=hydration.startedAt&&native.finishedAt>=native.startedAt&&native.finishedAt<=hydration.finishedAt,
        'Prior hydration native transport proof missing')
      assert(hydration.populationValidated===true&&hydration.workerMode==='rust-local-tags-read'
        &&hydration.returnedCount===hydration.inputCount&&/^[a-f0-9]{64}$/.test(hydration.tagSha256||''),'Prior hydration returned tags proof missing')
    }
    assert(history.every(row=>chain.slice(0,-1).some(owner=>owner.id===row.signalId)),'Prior hydration owner is outside its generation chain')
    return history
  }
  for(const receipt of hydrationReceipts.filter(row=>row.ok===false)) {
    assert.equal(o.taskProof,'selected-source-query-tasks','Legacy source has no query retirement proof')
    const failed=hydrations.get(receipt.id),signal=signals.get(failed?.signalId),invalidation=invalidations.get(signal?.invalidationId),ipc=ipcs.get(failed?.ipcId)
    assert(failed&&failed.ok===false&&signal?.firstObservedLive===true,'Failed hydration lacks a previously live query signal')
    assert(Number.isSafeInteger(signal.ownerId)&&invalidation?.ok===true&&invalidation.cancelInFlight===true&&invalidation.ownerId===signal.ownerId,'Failed hydration lacks owned query invalidation')
    assert(signal.firstObservedAt<=invalidation.startedAt&&invalidation.startedAt<=signal.abortedAt&&signal.abortedAt<=invalidation.finishedAt,'Invalid query retirement order')
    assert(signal.outcome==='rejected'&&signal.error?.reason==='query-superseded','Query attempt was not actually retired')
    assert(ipc?.ok===true&&ipc.tagPage===true&&ipc.channel==='fonts:queryPage'&&ipc.actionId===failed.actionId&&ipc.intentSha256===failed.intentSha256,'Retired attempt lacks its successful tagged IPC')
    assert(signal.actionId===failed.actionId&&signal.intentSha256===failed.intentSha256&&signal.ipcId===ipc.id,'Retired query ownership changed')
    assert(receipt.querySignalId===signal.id&&receipt.queryInputSha256===failed.inputSha256&&/^[a-f0-9]{64}$/.test(failed.inputSha256||''),'Failed native input identity missing')
    assert(Number.isSafeInteger(failed.inputCount)&&failed.inputCount>0&&failed.requestedCount===failed.inputCount&&receipt.requestedCount===failed.inputCount
      &&receipt.nativeRequestedCount===failed.inputCount&&receipt.nativeCalls===1,'Retired native request population changed')
    const rejected=o.transports.filter(row=>row.hydrationId===failed.hydrationId)
    assert.equal(rejected.length,1,'Retired hydration native attempt count changed')
    const native=rejected[0]
    assert(native.command==='--local-tags-read'&&native.signalId===signal.id&&native.inputSha256===failed.inputSha256
      &&native.actionId===failed.actionId&&native.intentSha256===failed.intentSha256&&native.ipcId===ipc.id
      &&native.signalAbortedAtStart===true&&native.outcome==='rejected'&&cancelled(native.error),'Retired hydration lacks explicit pre-admission native cancellation')
    assert(native.startedAt>=failed.startedAt&&native.startedAt>=signal.abortedAt&&native.finishedAt>=native.startedAt&&native.finishedAt<=failed.finishedAt,'Native cancellation lifetime changed')
    const matches=o.hydrations.filter(row=>row.ok===true&&row.actionId===failed.actionId&&row.intentSha256===failed.intentSha256&&row.ipcId===ipc.id
      &&row.inputSha256===failed.inputSha256&&row.signalId!==failed.signalId&&row.startedAt>=failed.finishedAt&&row.finishedAt<=ipc.finishedAt)
    assert.equal(matches.length,1,'Retired hydration lacks one exact-input replacement')
    const replacement=matches[0],replacementSignal=signals.get(replacement.signalId),replacementReceipt=receipts.get(replacement.hydrationId)
    assert(Number.isFinite(signal.settledAt)&&signal.settledAt>=failed.finishedAt&&signal.settledAt<=replacement.startedAt,'Retired task settlement was not proved before replacement hydration')
    assert(replacementSignal?.firstObservedLive===true&&replacementSignal.abortedAt===undefined&&replacementSignal.ownerId===signal.ownerId
      &&replacementSignal.actionId===failed.actionId&&replacementSignal.intentSha256===failed.intentSha256&&replacementSignal.ipcId===ipc.id
      &&replacementSignal.firstObservedAt>=invalidation.finishedAt&&replacementSignal.firstObservedAt<=replacement.startedAt
      &&replacementSignal.tagGeneration===invalidation.generationAfter&&replacementSignal.outcome==='returned','Replacement query signal is not the live next generation')
    assert(Number.isFinite(replacementSignal.settledAt)&&replacementSignal.settledAt>=replacement.finishedAt&&replacementSignal.settledAt<=ipc.finishedAt,'Replacement task did not settle before its IPC')
    assert(replacementReceipt?.ok===true&&replacementReceipt.querySignalId===replacement.signalId&&replacementReceipt.queryInputSha256===failed.inputSha256
      &&replacementReceipt.populationValidated===true&&replacementReceipt.nativePopulationValidated===true
      &&replacementReceipt.nativeCalls===1&&replacementReceipt.workerMode==='rust-local-tags-read','Replacement native hydration proof missing')
    for(const key of ['requestedCount','requestedUniqueIds','nativeRequestedCount','nativeUniqueIds','returnedCount','returnedUniqueIds'])assert.equal(replacementReceipt[key],failed.inputCount,'Replacement native population changed')
    const completed=o.transports.filter(row=>row.hydrationId===replacement.hydrationId)
    assert.equal(completed.length,1,'Replacement native attempt count changed')
    assert(completed[0].outcome==='returned'&&completed[0].signalAbortedAtStart===false&&completed[0].signalId===replacement.signalId
      &&completed[0].inputSha256===failed.inputSha256&&completed[0].actionId===failed.actionId&&completed[0].intentSha256===failed.intentSha256&&completed[0].ipcId===ipc.id
      &&completed[0].startedAt>=replacement.startedAt&&completed[0].finishedAt>=completed[0].startedAt&&completed[0].finishedAt<=replacement.finishedAt,'Replacement native transport proof missing')
    assert(replacement.populationValidated===true&&replacement.workerMode==='rust-local-tags-read'&&replacement.tagSha256===ipc.tagSha256
      &&replacement.returnedCount===ipc.itemCount&&ipc.total===ipc.itemCount,'Replacement exact tags did not reach the successful IPC')
    const children=processRequests.filter(row=>row.error&&row.querySignalId===signal.id)
    assert(children.length>0,'Retired query lacks its observed cancelled read')
    for(const row of children){
      assert(row.lane==='foreground-browse'&&row.actionId===failed.actionId&&row.queryIntentSha256===failed.intentSha256,'Retired child ownership changed')
      assert(row.command==='--shared-file-io'&&row.operation==='readdir'&&row.label==='shared-file-io:readdir'
        &&row.write===false&&row.verifiedReadOnly===true&&row.preflight===false&&row.error.reason==='cancelled','Unapproved retired physical operation')
      assert(Number.isFinite(row.queuedMs)&&row.queuedMs>=0&&Number.isFinite(row.executionMs)&&row.executionMs>=0,'Retired child lost queue/execution cost')
      assert(Number.isFinite(row.closedAt)&&row.startedAt<=signal.abortedAt&&signal.abortedAt<=row.closedAt&&row.closedAt<=ipc.finishedAt,'Retired child physical cancellation lifetime changed')
      assert(Number.isSafeInteger(row.requestOrdinal)&&row.requestOrdinal>0&&!retiredRequestOrdinals.includes(row.requestOrdinal),'Retired physical request identity changed')
      retiredRequestOrdinals.push(row.requestOrdinal)
    }
    retiredHydrationIds.push(receipt.id)
    certificates.push({kind:'retired-before-native-admission',hydrationId:receipt.id,signalId:signal.id,invalidationId:invalidation.id,replacementHydrationId:replacement.hydrationId,
      replacementSignalId:replacement.signalId,ipcId:ipc.id,actionId:failed.actionId,intentSha256:failed.intentSha256,inputSha256:failed.inputSha256,
      requestOrdinals:children.map(row=>row.requestOrdinal),queuedMs:children.reduce((n,row)=>n+row.queuedMs,0),executionMs:children.reduce((n,row)=>n+row.executionMs,0)})
  }
  // An earlier binding batch can retire before it reaches local-tag hydration.
  // Upstream page/native work may already exist. There is no old local-tag
  // input to hash, and this branch must never invent a failed hydration receipt.
  const earlySignals=[...new Set(processRequests.filter(row=>row.error&&row.lane==='foreground-browse'
    &&!retiredRequestOrdinals.includes(row.requestOrdinal)).map(row=>row.querySignalId))]
    .sort((a,b)=>(signals.get(a)?.firstObservedAt??Infinity)-(signals.get(b)?.firstObservedAt??Infinity))
  const certifiedEarlySignals=new Set()
  for(const signalId of earlySignals){
    if(certifiedEarlySignals.has(signalId))continue
    assert.equal(o.taskProof,'selected-source-query-tasks','Legacy source has no early query retirement proof')
    const signal=signals.get(signalId),invalidation=invalidations.get(signal?.invalidationId),ipc=ipcs.get(signal?.ipcId)
    assert(signal?.firstObservedLive===true&&Number.isSafeInteger(signal.ownerId),'Early retired read lacks a previously live owned signal')
    assert(invalidation?.ok===true&&invalidation.cancelInFlight===true&&invalidation.ownerId===signal.ownerId
      &&invalidation.generationBefore===signal.tagGeneration&&invalidation.generationAfter===signal.tagGeneration+1,'Early retired read lacks owned query invalidation')
    assert(signal.firstObservedAt<=invalidation.startedAt&&invalidation.startedAt<=signal.abortedAt&&signal.abortedAt<=invalidation.finishedAt,'Invalid early query retirement order')
    assert(signal.outcome==='rejected'&&signal.error?.reason==='query-superseded'&&Number.isFinite(signal.settledAt)&&signal.settledAt>=signal.abortedAt,'Early query task settlement missing')
    assert(!o.hydrations.some(row=>row.signalId===signal.id)&&!o.transports.some(row=>row.signalId===signal.id)
      &&!hydrationReceipts.some(row=>row.querySignalId===signal.id),'Early retirement already reached local-tag hydration or transport')
    assert(ipc?.ok===true&&ipc.tagPage===true&&ipc.channel==='fonts:queryPage'&&ipc.actionId===signal.actionId
      &&ipc.intentSha256===signal.intentSha256,'Early retired attempt lacks its successful tagged IPC')
    const candidates=o.hydrations.filter(row=>row.ok===true&&(row.ipcId===ipc.id||signals.get(row.signalId)?.ipcId===ipc.id))
    for(const row of candidates)assert(row.ipcId===ipc.id&&row.actionId===signal.actionId&&row.intentSha256===signal.intentSha256,
      'Early hydration IPC or intent changed')
    const history=priorHydrationHistory(candidates,signal,ipc)
    const matches=candidates.filter(row=>!history.includes(row))
    assert.equal(matches.length,1,'Early retired read lacks one same-intent native hydration replacement')
    const replacement=matches[0],next=signals.get(replacement.signalId),receipt=receipts.get(replacement.hydrationId)
    for(const prior of history)assert(prior.inputSha256===replacement.inputSha256&&prior.inputCount===replacement.inputCount
      &&prior.tagSha256===replacement.tagSha256&&prior.returnedCount===replacement.returnedCount,
      'Prior hydration and replacement native input or returned tags changed')
    assert(replacement.startedAt>=signal.settledAt&&replacement.finishedAt>=replacement.startedAt&&replacement.finishedAt<=ipc.finishedAt,
      'Early replacement hydration lifetime changed')
    assert(next?.firstObservedLive===true&&next.abortedAt===undefined&&next.error===undefined&&next.ownerId===signal.ownerId
      &&next.actionId===signal.actionId&&next.intentSha256===signal.intentSha256&&next.ipcId===ipc.id
      &&next.firstObservedAt>=invalidation.finishedAt&&next.firstObservedAt<=replacement.startedAt&&next.outcome==='returned','Early replacement is not the live next query generation')
    // A second committed projection can retire the immediate replacement before
    // it reaches hydration. Prove every link instead of treating any later
    // successful generation as a substitute for the missing next generation.
    assert(Number.isSafeInteger(signal.tagGeneration)&&signal.tagGeneration>=0&&Number.isSafeInteger(next.tagGeneration)
      &&next.tagGeneration>signal.tagGeneration&&next.tagGeneration-signal.tagGeneration<o.signals.length,'Early retirement generation span is invalid')
    const chain=o.signals.filter(row=>row.ipcId===ipc.id&&row.tagGeneration>=signal.tagGeneration&&row.tagGeneration<=next.tagGeneration)
      .sort((a,b)=>a.tagGeneration-b.tagGeneration)
    assert.equal(chain.length,next.tagGeneration-signal.tagGeneration+1,'Early retirement chain has a generation gap or branch')
    assert(chain[0].id===signal.id&&chain.at(-1).id===next.id,'Early retirement chain endpoints changed')
    const retired=chain.slice(0,-1),chainInvalidations=[]
    for(let index=0;index<chain.length;index++){
      const current=chain[index]
      assert(current.tagGeneration===signal.tagGeneration+index,'Early retirement chain has a generation gap or branch')
      assert(current.ownerId===signal.ownerId&&current.ipcId===ipc.id&&current.actionId===signal.actionId&&current.intentSha256===signal.intentSha256,
        'Early retirement chain identity changed')
      assert(current.firstObservedLive===true&&Number.isFinite(current.firstObservedAt)&&current.firstObservedAt>=ipc.startedAt,
        'Early retirement chain signal was not originally live')
      if(current===next)break
      const edge=invalidations.get(current.invalidationId),following=chain[index+1]
      assert(edge?.ok===true&&edge.cancelInFlight===true&&edge.ownerId===current.ownerId
        &&edge.generationBefore===current.tagGeneration&&edge.generationAfter===current.tagGeneration+1,
        'Early retirement chain lacks an exact owned invalidation')
      assert.equal(o.invalidations.filter(row=>row.ownerId===current.ownerId&&row.generationBefore===current.tagGeneration).length,1,
        'Early retirement chain invalidation is ambiguous')
      assert(current.firstObservedAt<=edge.startedAt&&edge.startedAt<=current.abortedAt&&current.abortedAt<=edge.finishedAt
        &&edge.finishedAt<=following.firstObservedAt,'Early retirement chain invalidation order changed')
      assert(!o.invalidations.some(row=>row.ownerId===current.ownerId&&row.id!==edge.id
        &&row.startedAt>=edge.startedAt&&row.startedAt<=following.firstObservedAt),'Early retirement chain skipped an owned invalidation')
      assert(current.outcome==='rejected'&&current.error?.reason==='query-superseded'&&Number.isFinite(current.settledAt)
        &&current.settledAt>=current.abortedAt&&current.settledAt<=replacement.startedAt,'Early retirement chain task was not superseded and settled before final hydration')
      assert(!o.hydrations.some(row=>row.signalId===current.id)&&!o.transports.some(row=>row.signalId===current.id)
        &&!hydrationReceipts.some(row=>row.querySignalId===current.id),'Early retirement chain admitted obsolete hydration or transport')
      chainInvalidations.push(edge.id)
    }
    assert(!o.invalidations.some(row=>row.ownerId===next.ownerId&&row.startedAt>=next.firstObservedAt&&row.startedAt<=ipc.finishedAt),
      'Early replacement was not the current generation through IPC completion')
    assert(Number.isFinite(next.settledAt)&&next.settledAt>=replacement.finishedAt&&next.settledAt<=ipc.finishedAt,'Early replacement task did not settle before IPC')
    assert(/^[a-f0-9]{64}$/.test(replacement.inputSha256||'')&&Number.isSafeInteger(replacement.inputCount)&&replacement.inputCount>0
      &&replacement.requestedCount===replacement.inputCount,'Early replacement actual native input proof missing')
    assert(receipt?.ok===true&&receipt.error===undefined&&receipt.querySignalId===next.id&&receipt.queryInputSha256===replacement.inputSha256
      &&receipt.populationValidated===true&&receipt.nativePopulationValidated===true&&receipt.nativeCalls===1&&receipt.workerMode==='rust-local-tags-read','Early replacement native hydration proof missing')
    for(const key of ['requestedCount','requestedUniqueIds','nativeRequestedCount','nativeUniqueIds','returnedCount','returnedUniqueIds'])
      assert.equal(receipt[key],replacement.inputCount,'Early replacement native population changed')
    const completed=o.transports.filter(row=>row.hydrationId===replacement.hydrationId)
    assert.equal(completed.length,1,'Early replacement native attempt count changed')
    const native=completed[0]
    assert(native.command==='--local-tags-read'&&native.outcome==='returned'&&native.error===undefined&&native.signalAbortedAtStart===false&&native.signalId===next.id
      &&native.inputSha256===replacement.inputSha256&&native.actionId===signal.actionId&&native.intentSha256===signal.intentSha256&&native.ipcId===ipc.id
      &&native.startedAt>=replacement.startedAt&&native.finishedAt>=native.startedAt&&native.finishedAt<=replacement.finishedAt,'Early replacement native transport proof missing')
    assert(replacement.populationValidated===true&&replacement.error===undefined&&replacement.workerMode==='rust-local-tags-read'
      &&/^[a-f0-9]{64}$/.test(replacement.tagSha256||'')&&replacement.tagSha256===ipc.tagSha256
      &&replacement.returnedCount===replacement.inputCount&&replacement.returnedCount===ipc.itemCount&&ipc.total===ipc.itemCount,'Early replacement exact tags did not reach the successful IPC')
    const retiredIds=new Set(retired.map(row=>row.id)),childOrdinals=new Set()
    const allChildren=processRequests.filter(row=>retiredIds.has(row.querySignalId))
    const children=allChildren.filter(row=>row.error)
    for(const row of allChildren){
      const parent=signals.get(row.querySignalId)
      assert(row.lane==='foreground-browse'&&row.actionId===signal.actionId&&row.queryIntentSha256===signal.intentSha256,'Early retired child ownership changed')
      assert(row.command==='--shared-file-io'&&row.operation==='readdir'&&row.label==='shared-file-io:readdir'
        &&row.write===false&&row.verifiedReadOnly===true&&row.preflight===false&&(!row.error||row.error.reason==='cancelled'),'Unapproved early retired physical operation')
      assert(Number.isFinite(row.queuedMs)&&row.queuedMs>=0&&Number.isFinite(row.executionMs)&&row.executionMs>=0,'Early retired child lost queue/execution cost')
      assert(Number.isFinite(row.closedAt)&&row.startedAt>=parent.firstObservedAt&&row.startedAt<=parent.abortedAt&&row.startedAt<=row.closedAt
        &&(!row.error||parent.abortedAt<=row.closedAt)&&row.closedAt<=parent.settledAt,'Early retired read was not physically closed before task settlement')
      assert(Number.isSafeInteger(row.requestOrdinal)&&row.requestOrdinal>0&&!childOrdinals.has(row.requestOrdinal)
        &&!retiredRequestOrdinals.includes(row.requestOrdinal),'Early retired physical request identity changed')
      childOrdinals.add(row.requestOrdinal)
      if(row.error)retiredRequestOrdinals.push(row.requestOrdinal)
    }
    for(const current of retired)certifiedEarlySignals.add(current.id)
    certificates.push({kind:'retired-before-tag-hydration',signalId:signal.id,invalidationId:invalidation.id,replacementHydrationId:replacement.hydrationId,
      replacementSignalId:next.id,ipcId:ipc.id,actionId:signal.actionId,intentSha256:signal.intentSha256,replacementInputSha256:replacement.inputSha256,
      ...(retired.length>1?{retiredSignalIds:retired.map(row=>row.id),invalidationIds:chainInvalidations}:{}),
      requestOrdinals:children.map(row=>row.requestOrdinal),queuedMs:children.reduce((n,row)=>n+row.queuedMs,0),executionMs:children.reduce((n,row)=>n+row.executionMs,0)})
  }
  return {retiredHydrationIds,retiredRequestOrdinals,certificates}
}
module.exports={createQueryRetirementObserver,validateQueryRetirements,inputDigest,tagDigest}
