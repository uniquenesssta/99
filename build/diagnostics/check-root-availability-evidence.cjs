#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os')
const {loader}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'),abs=p=>path.join(root,p),tick=ms=>new Promise(r=>setTimeout(r,ms))
async function until(test){const end=Date.now()+5000;while(!test()){assert(Date.now()<end,'condition timed out');await tick(10)}}
async function requestTimeoutDoesNotOffline(){
 let state={state:'online',generation:7},marks=0
 const l=loader({
  [abs('src/main/path/startupPathAvailabilityRuntime.ts')]:{getStartupPathRootState:()=>({rootId:'r',...state}),markStartupPathRootUnavailable:()=>{marks++;state={state:'offline',generation:state.generation+1}}},
  [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{sharedIoAvailabilityRoot:()=> 'r',sharedIoResourceKeys:async()=>['r']}
 })
 const {SharedIoProcessError}=l('src/main/path/sharedIoProcessRuntime.ts'),io=l('src/main/path/sharedFileSystemRuntime.ts')
 io.configureSharedFileExecutor(async()=>{throw new SharedIoProcessError('slow file','unknown','timeout')})
 await assert.rejects(io.executeSharedFile({operation:'stat',path:'\\\\nas\\share\\slow.ttf'}),e=>e.reason==='timeout')
 assert.equal(marks,0);assert.equal(state.state,'online');assert.equal(state.generation,7)
 io.configureSharedFileExecutor(async req=>({result:{ok:false,operation:req.operation,code:'ENETUNREACH',message:'network unreachable'}}))
 await assert.rejects(io.executeSharedFile({operation:'stat',path:'\\\\nas\\share\\gone.ttf'}),e=>e.reason==='ENETUNREACH')
 assert.equal(marks,1)
}
async function reservedProbeLane(){
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'hfm-c04-lane-')),logs=[]
 const create=loader()('src/main/path/sharedIoProcessRuntime.ts').createSharedIoProcessRuntime,runtime=create(x=>logs.push(x))
 const holdCode=marker=>`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`
 const a=path.join(dir,'a'),b=path.join(dir,'b'),probeMarker=path.join(dir,'probe')
 const stopA=new AbortController(),stopB=new AbortController()
 try{
  const one=runtime.run({file:process.execPath,args:['-e',holdCode(a)],roots:['root-a'],timeoutMs:5000,write:false,signal:stopA.signal}).catch(e=>e)
  const two=runtime.run({file:process.execPath,args:['-e',holdCode(b)],roots:['root-b'],timeoutMs:5000,write:false,signal:stopB.signal}).catch(e=>e)
  await until(()=>fs.existsSync(a)&&fs.existsSync(b));assert.equal(runtime.status().activeDefault,2)
  const probe=await runtime.run({file:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(probeMarker)},'ok')`],roots:['root-a'],lane:'root-probe',timeoutMs:500,queueTimeoutMs:1000,write:false})
  assert(fs.existsSync(probeMarker));assert(probe.queuedMs>=0);assert(probe.executionMs>=0);assert(logs.some(x=>x.includes('lane=root-probe')))
  stopA.abort();stopB.abort();await Promise.all([one,two]);await runtime.whenIdle()
 }finally{runtime.stop();await runtime.whenIdle();await fsp.rm(dir,{recursive:true,force:true})}
}
async function queueAndExecutionAreSeparate(){
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'hfm-c04-timing-')),create=loader()('src/main/path/sharedIoProcessRuntime.ts').createSharedIoProcessRuntime,runtime=create(()=>{})
 const marker=path.join(dir,'writer'),stop=new AbortController()
 try{
  const writer=runtime.run({file:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],roots:['same'],timeoutMs:5000,write:true,signal:stop.signal}).catch(e=>e)
  await until(()=>fs.existsSync(marker))
  const queued=await runtime.run({file:process.execPath,args:['-e',''],roots:['same'],lane:'root-probe',timeoutMs:500,queueTimeoutMs:100,write:false}).catch(e=>e)
  assert.equal(queued.reason,'queue-timeout');assert.equal(queued.outcome,'not-started');assert(queued.queuedMs>=80);assert.equal(queued.executionMs,0)
  stop.abort();await writer;await runtime.whenIdle()
 }finally{runtime.stop();await runtime.whenIdle();await fsp.rm(dir,{recursive:true,force:true})}
}
async function availabilityEpochs(){
 let now=0,mode='ok',calls=0
 const mocks={
  [abs('src/main/app/shutdownCoordinatorRuntime.ts')]:{isApplicationClosing:()=>false,applicationWorkEpoch:()=>1},
  [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{registerIsolatedRoot(){},sharedIoResourceKeys:async()=>['r']},
  [abs('src/main/path/pathCanonicalizer.ts')]:{normalizeNativePathText:x=>x,mappedDriveTableAsync:async()=>new Map()},
  [abs('src/main/path/cachePath.ts')]:{normalizePathForCacheCompare:x=>String(x).toLowerCase()},
  [abs('src/main/path/ioDeadlineRuntime.ts')]:{unavailableRootTtlMs:()=>1000,uncRootProbeTimeoutMs:()=>500},
  [abs('src/main/path/sharedPathProbeRuntime.ts')]:{probeStartupDirectory:async()=>{calls++;if(mode==='queue')throw Object.assign(Error('busy'),{reason:'queue-timeout',queuedMs:3000,executionMs:0});if(mode==='timeout')throw Object.assign(Error('root timeout'),{reason:'timeout',queuedMs:0,executionMs:500});if(mode==='identity')throw Object.assign(Error('identity changed'),{reason:'identity-changed',queuedMs:0,executionMs:20});return{directory:true,physicalPath:'\\\\nas\\share',queuedMs:5,executionMs:25}}}
 }
 const l=loader(mocks,{Date:class extends Date{static now(){return now}},process:{...process,platform:'linux'}}),a=l('src/main/path/startupPathAvailabilityRuntime.ts'),rootPath='//nas/share/fonts'
 assert.equal(await a.ensureStartupPathRootAvailable(rootPath),true);let s=a.getStartupPathRootState(rootPath),g=s.generation;assert.equal(s.state,'online');assert.equal(s.lastProbeQueuedMs,5);assert.equal(s.lastProbeExecutionMs,25)
 now=2000;assert.equal(await a.ensureStartupPathRootAvailable(rootPath),true);s=a.getStartupPathRootState(rootPath);assert.equal(s.generation,g,'healthy recheck changed generation')
 now=4000;mode='queue';assert.equal(await a.ensureStartupPathRootAvailable(rootPath),true);s=a.getStartupPathRootState(rootPath);assert.equal(s.state,'online');assert.equal(s.generation,g);assert.equal(s.lastProbeQueuedMs,3000);assert.equal(s.lastProbeExecutionMs,0)
 now=6000;mode='timeout';assert.equal(await a.ensureStartupPathRootAvailable(rootPath),false);s=a.getStartupPathRootState(rootPath);assert.equal(s.state,'offline');assert(s.generation>g);const offlineGen=s.generation
 now=8000;mode='ok';assert.equal(await a.ensureStartupPathRootAvailable(rootPath),true);s=a.getStartupPathRootState(rootPath);assert.equal(s.state,'online');assert(s.generation>offlineGen,'recovering epoch did not advance')
 const recoveredGen=s.generation;now=10000;mode='identity';assert.equal(await a.ensureStartupPathRootAvailable(rootPath),false);s=a.getStartupPathRootState(rootPath);assert.equal(s.state,'offline');assert(s.generation>recoveredGen)
 assert(calls>=5)
}
async function localFixedDriveIsNotIsolated(){
 let registrations=0
 const mocks={
  [abs('src/main/app/shutdownCoordinatorRuntime.ts')]:{isApplicationClosing:()=>false,applicationWorkEpoch:()=>1},
  [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{registerIsolatedRoot(){registrations++}},
  [abs('src/main/path/pathCanonicalizer.ts')]:{normalizeNativePathText:x=>x,mappedDriveTableAsync:async()=>new Map()},
  [abs('src/main/path/cachePath.ts')]:{normalizePathForCacheCompare:x=>String(x).toLowerCase()},
  [abs('src/main/path/ioDeadlineRuntime.ts')]:{unavailableRootTtlMs:()=>1000,uncRootProbeTimeoutMs:()=>500},
  [abs('src/main/path/sharedPathProbeRuntime.ts')]:{probeStartupDirectory:async()=>({directory:true,queuedMs:0,executionMs:1})}
 }
 const l=loader(mocks,{process:{...process,platform:'win32'}}),a=l('src/main/path/startupPathAvailabilityRuntime.ts')
 assert.equal(await a.ensureStartupPathRootAvailable('C:\\fonts'),true)
 assert.equal(registrations,0,'local fixed drive was incorrectly registered as isolated shared root')
}
async function previewConsumesCentralOwner(){
 let rootState={state:'checking',generation:1},ensures=0
 const l=loader({
  [abs('src/main/path/startupPathAvailabilityRuntime.ts')]:{ensureStartupPathRootAvailable:async()=>{ensures++;return rootState.state==='online'},getStartupPathRootState:()=>({rootId:'r',...rootState})},
  [abs('src/main/path/cachePath.ts')]:{normalizePathForCacheCompare:x=>x},
  [abs('src/main/path/ioDeadlineRuntime.ts')]:{unavailableRootTtlMs:()=>30000},
  [abs('src/main/preview/runtime/previewSharedStorageCircuitBreakerRuntime.ts')]:{createPreviewSharedStorageCircuitBreakerRuntime:()=>({canUseSharedStorage:()=>true,recordSharedStorageSuccess(){},recordSharedStorageFailure:()=>0})}
 })
 const r=l('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts').createPreviewCacheRootAvailabilityRuntime({availableTtlMs:1000,unavailableTtlMs:1000,now:()=>0})
 assert.equal(await r.ensureRootPreviewCacheAvailable('/fonts'),false);assert.equal(r.isRootPreviewCacheUnavailable('/fonts'),false,'inconclusive central probe opened preview outage')
 rootState={state:'online',generation:1};assert.equal(await r.ensureRootPreviewCacheAvailable('/fonts'),true);assert(ensures>=2)
}
async function main(){await requestTimeoutDoesNotOffline();await reservedProbeLane();await queueAndExecutionAreSeparate();await availabilityEpochs();await localFixedDriveIsNotIsolated();await previewConsumesCentralOwner();console.log('[diagnostics:root-availability-evidence] request timeout isolation, reserved probe lane, split queue/execution timing, generation semantics, local-drive isolation and preview ownership passed')}
main().catch(e=>{console.error(e);process.exitCode=1})
