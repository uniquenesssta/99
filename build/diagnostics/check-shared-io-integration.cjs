#!/usr/bin/env node
const assert = require('node:assert/strict')
process.env.HFM_LOG_DETAIL = 'debug'
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const cp = require('node:child_process')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..'), core = 'src/main/rust-core/'
const crlf = process.argv.includes('--crlf'), mutant = process.argv.includes('--without-routing'), timeoutMutant = process.argv.includes('--timeout-offlines-root')
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test) { const end = Date.now() + 5000; while (!test()) { assert(Date.now() < end, 'condition timed out'); await tick(10) } }
const plain = value => JSON.parse(JSON.stringify(value))
const cases = []
async function main() {
 const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-io-integration-'))
 const children = new Set(), logs = [], submissions = [], daemonCalls = []
 let mode = 'success', nextReady = '', currentInput = '', payload = {ok:true}
 const transforms = {}
 for (const file of [core+'rustCoreWorkerTransportRuntime.ts',core+'rustSharedIoCommandRuntime.ts',core+'clients/rustMetadataClientRuntime.ts','src/main/path/sharedIoProcessRuntime.ts','src/main/path/sharedPathProbeRuntime.ts']) transforms[path.join(root,file)] = source => {
   if(mutant && file.endsWith('rustCoreWorkerTransportRuntime.ts')) source=source.replace('if (roots.length) {','if (false) {')
   if(timeoutMutant && file.endsWith('rustCoreWorkerTransportRuntime.ts')) {
     const before=source
     source=source.replace('getStartupPathRootState }', 'getStartupPathRootState, markStartupPathRootUnavailable }').replace("          logOperation({ stage: 'transport-result'", "          if (error.reason === 'timeout') for (const root of rootGenerations.keys()) markStartupPathRootUnavailable(root,error)\n          logOperation({ stage: 'transport-result'")
     assert.notEqual(source,before,'timeout mutant not applied')
   }
   return crlf ? source.replace(/\r?\n/g,'\r\n') : source
 }
 const mockDaemon = { createRustCoreDaemonRuntime: () => ({ tryRun:async(_,args)=>{daemonCalls.push(args);return{stdout:JSON.stringify(payload),stderr:''}}, stop(){}, stopImmediately(){}, status(){return{}}, pollStatus(){} }), isRustCoreDaemonSubmittedError:e=>!!e?.daemonSubmitted }
 const spawn = (file,args,options) => {
   submissions.push({file,args:plain(args),options})
   let runArgs = args
   if (args[0]?.startsWith('--')) {
     currentInput = args.includes('--input') ? args[args.indexOf('--input')+1] : ''
     const ready = nextReady, input = currentInput
     const script = `const fs=require('node:fs'); const input=${JSON.stringify(input)}; if(input) JSON.parse(fs.readFileSync(input,'utf8')); ${ready ? `fs.writeFileSync(${JSON.stringify(ready)},'ready');` : ''}`
       + (mode==='hang' ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" : mode==='delayed' ? 'setTimeout(()=>process.stdout.write('+JSON.stringify(JSON.stringify(payload))+'),500)' : mode==='bad-json' ? "process.stdout.write('broken')" : 'process.stdout.write('+JSON.stringify(JSON.stringify(payload))+')')
     runArgs = ['-e',script]
   }
   const child = cp.spawn(process.execPath,runArgs,options);children.add(child);child.once('close',()=>children.delete(child));return child
 }
 const execFile=(...args)=>{
   const callback=args.at(-1),command=args[1][0],protocol=load(core+'rustCoreProtocolRuntime.ts')
   const value=command==='--handshake'?{ok:true,version:'0.42.0',protocolVersion:42,capabilities:[...protocol.REQUIRED_RUST_CORE_CAPABILITIES,'shared-metadata-bindings-read-v1','list-font-files-stdout-v1']}:{ok:true,profiles:[]}
   callback(null,JSON.stringify(value),'');return {}
 }
 execFile[require('node:util').promisify.custom]=(...args)=>new Promise((resolve,reject)=>execFile(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})))
 const load = loader({ electron:{app:{}}, 'node:child_process':{...cp,spawn,execFile},
   [path.join(root,core+'rustCoreWorkerPathRuntime.ts')]:{resolveRustCoreWorkerPathWithDiagnostics:()=>({path:process.execPath,candidates:[process.execPath]})},
   [path.join(root,core+'rustCoreDaemonRuntime.ts')]:mockDaemon }, {AbortController}, transforms)
 const transport = load(core+'rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({appendStartupLog:s=>logs.push(s),enabled:true,required:true})
 const globals = {process:{...process,platform:'win32'}}
 const mapped = loader({[path.join(root,'src/main/path/pathCanonicalizer.ts')]:{
   normalizeNativePathText:load('src/main/path/pathCanonicalizer.ts').normalizeNativePathText,
   mappedDriveTableAsync:async()=>new Map([['O:','\\\\NAS\\share']])
 }},globals,transforms)(core+'rustSharedIoCommandRuntime.ts')
 const client = load(core+'clients/rustMetadataClientRuntime.ts').createRustMetadataClientRuntime({...transport,
   diagnoseRustCoreWorker:async()=>({available:true,path:process.execPath,capabilities:['install-status-index-read','install-status-index-save','shared-metadata-apply','shared-metadata-remove-tag','shared-metadata-known-tags','shared-metadata-overlay-read','shared-metadata-signature']}),
   appendStartupLog:s=>logs.push(s)})
 const run = (roots,extras={}) => transport.runRustCoreScheduledCommand(process.execPath,['--shared-metadata-signature','--input',extras.input || ''],{timeout:250,sharedIo:{paths:roots,write:false},...extras})
 let healthyProbe=true
 const healthLoad=loader({electron:{app:{}},'node:child_process':{...cp,spawn},
   [path.join(root,core+'rustCoreDaemonRuntime.ts')]:mockDaemon,
   [path.join(root,'src/main/path/sharedPathProbeRuntime.ts')]:{stopSharedPathProbes(){},probeStartupDirectory:async()=>({directory:healthyProbe,queuedMs:0,executionMs:1})}
 },{AbortController},transforms)
 const availability=healthLoad('src/main/path/startupPathAvailabilityRuntime.ts')
 const healthTransport=healthLoad(core+'rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({appendStartupLog:s=>logs.push(s),enabled:false,required:false})
 const watchdog = setTimeout(()=>{for(const child of children)child.kill('SIGKILL');console.error('integration watchdog');process.exit(1)},60000)
 try {
   assert.deepEqual(plain(await mapped.sharedIoResourceKeys(['O:/fonts/../fonts','//nas/share/fonts','\\\\?\\UNC\\NAS\\share\\a'])),['\\\\nas\\share'])
   assert.deepEqual(plain(await mapped.sharedIoResourceKeys(['C:/local'])),[])
   const failedMapping = loader({[path.join(root,'src/main/path/pathCanonicalizer.ts')]:{normalizeNativePathText:x=>x,mappedDriveTableAsync:async()=>null}},globals,transforms)(core+'rustSharedIoCommandRuntime.ts')
   await assert.rejects(failedMapping.sharedIoResourceKeys(['P:\\fonts']),e=>e.outcome==='not-started')
   cases.push('UNC/device/dot/mapped aliases share one resource; unverified mapping rejects')
   payload={ok:true,signature:'metadata-v2|valid'}
   const first=await client.runRustSharedMetadataSignature({dbPath:'\\\\nas\\share\\metadata.sqlite'})
   assert.equal(first.signature,payload.signature);assert.equal(submissions.length,1,'production client did not reach isolated process');assert.equal(daemonCalls.length,0)
   assert.equal(submissions[0].options.shell,false)
   assert(logs.some(line=>line.includes('shared io started:')&&line.includes('label=shared-metadata-signature')),'shared I/O command label was not observable')
   cases.push('real client -> transport -> child -> receipt; daemon is bypassed; command label observable')
   const localBefore=daemonCalls.length
   await client.runRustSharedMetadataSignature({dbPath:path.join(dir,'local.sqlite')})
   assert.equal(daemonCalls.length,localBefore+1)
   cases.push('local metadata keeps existing transport')
   const priorityPool=load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(),originalRun=priorityPool.run,priorities=[]
   priorityPool.run=request=>{priorities.push(request.priority);return originalRun(request)}
   try {
     const global=load('src/main/performance/globalIoRuntime.ts').createGlobalIoRuntime({env:{},localScanWorkers:1,appendLog(){},isIndexingActive:()=>false,isUserActive:()=>false,storageProfileForPath:()=>({type:'unknown'})})
     await global.withGlobalIo('fixture:foreground',()=>run(['\\\\nas\\priority'],{timeout:2000}),{priority:'foreground'})
     assert.deepEqual(priorities,['foreground'],'global priority did not reach the real transport/shared queue')
   }finally{priorityPool.run=originalRun}
   cases.push('actual global queue context -> transport -> shared process priority propagation')

   const seven=[
     ['runRustInstallStatusRead', [{rootPath:'\\\\nas\\a',dbPath:'\\\\nas\\a\\install.sqlite',items:[]}], {ok:true,results:{},missingIds:[]}],
     ['runRustInstallStatusSave', [{rootPath:'\\\\nas\\a',dbPath:'\\\\nas\\a\\install.sqlite',rows:[]}], {ok:true,written:0,groups:1}],
     ['runRustSharedMetadataApply', {rootPath:'\\\\nas\\a',dbPath:'\\\\nas\\a\\metadata.sqlite',rows:[]}, {ok:true,written:0}],
     ['runRustSharedMetadataRemoveTag', {rootPath:'\\\\nas\\a',dbPath:'\\\\nas\\a\\metadata.sqlite',tagName:'a'}, {ok:true,updatedIds:[]}],
     ['runRustSharedMetadataKnownTags', {roots:[{rootPath:'\\\\nas\\a',dbPath:'\\\\nas\\a\\metadata.sqlite'}]}, {ok:true,knownTags:[],roots:[]}],
     ['runRustSharedMetadataOverlayRead', {rootPath:'\\\\nas\\a',dbPath:'\\\\nas\\a\\metadata.sqlite',entries:[{key:'a'}]}, {ok:true,matched:[]}],
     ['runRustSharedMetadataSignature', {dbPath:'\\\\nas\\a\\metadata.sqlite'}, {ok:true,signature:'metadata-v2|a'}]
   ]
   for(const [name,input,result] of seven) {
     payload=result;const before=submissions.length
     assert(await client[name](input));assert.equal(submissions.length,before+1,name)
     await until(()=>!fs.existsSync(currentInput))
   }
   cases.push('all seven production methods submit, validate and dispose local inputs')
   for(const bad of ['bad-json','false','bad-shape']) {
     mode=bad==='bad-json'?bad:'success';payload=bad==='false'?{ok:false}:{ok:true,written:'invalid'}
     await assert.rejects(client.runRustSharedMetadataApply(seven[2][1]),e=>e.sharedIo===true && e.outcome==='unknown')
   }
   assert.equal(daemonCalls.length,localBefore+1)
   cases.push('invalid JSON / failed envelope / invalid business receipt cannot trigger fallback')

   mode='success';payload={ok:true,matched:[]}
   const policy=load(core+'rustCoreWorkerTransportRuntime.ts').sharedCommandExecutionTimeoutMs
   assert.equal(policy('--list-font-files',600000,true),600000);assert.equal(policy('--list-font-files',Infinity,true),600000)
   assert.equal(policy('--list-font-files',600000,false),30000);assert.equal(policy('--shared-file-io',600000,true),30000)
   const capturePool=load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(),captureRun=capturePool.run,requests=[]
   const output=transport.createTemporaryJsonFile('hfm-listing-budget');capturePool.run=request=>{requests.push(request);return captureRun(request)}
   try{
     const source="\\\\nas\\budget\\fonts",args=['--list-font-files','--root',source,'--extensions','ttf','--max','300000']
     const target={paths:[source],write:false,accesses:[{path:source,mode:'read',scope:'tree'}]}
     const unverified=transport.createTemporaryJsonFile('hfm-unverified-binding-proof');await unverified.writeJson({bindingSnapshot:true,entries:[]})
     try{await transport.runRustCoreScheduledCommand(process.execPath,['--shared-metadata-overlay-read','--input',unverified.path],{timeout:1000,sharedIo:target});assert.equal(requests.at(-1).verifiedReadOnly,false)}finally{await unverified.dispose()}
     await transport.runRustCoreScheduledCommand(process.execPath,args,{timeout:600000,sharedIo:target})
     assert.equal(requests.at(-1).timeoutMs,30000);assert.equal(requests.at(-1).verifiedReadOnly,false,'stdout flag without compatible cached worker granted proof')
     assert.equal(requests.at(-1).write,true);assert.equal(requests.at(-1).accesses,undefined);assert(requests.at(-1).roots.includes('configured-root:listing-output'))
     assert.equal((await transport.diagnoseRustCoreWorker()).available,true)
     const shape=load(core+'rustCoreWorkerTransportRuntime.ts').isStdoutFontListingArgs
     assert(shape(args));assert(shape([...args,'--probe-names','--full-hash']))
     for(const extra of [['--root',source],['--output',output.path],['--output='+output.path],['--shared-metadata-apply'],['--probe-names','--probe-names']]){
       assert.equal(shape([...args,...extra]),false,'unsafe CLI shape passed proof')
       await transport.runRustCoreScheduledCommand(process.execPath,[...args,...extra],{timeout:600000,sharedIo:target})
       const request=requests.at(-1);assert.equal(request.write,true);assert.equal(request.verifiedReadOnly,false);assert.equal(request.accesses,undefined);assert(request.roots.includes('configured-root:listing-output'));assert.equal(request.timeoutMs,30000)
     }
     await transport.runRustCoreScheduledCommand(process.execPath,args,{timeout:600000,sharedIo:target})
     assert.equal(requests.at(-1).timeoutMs,600000);assert.equal(requests.at(-1).queueTimeoutMs,3000);assert.equal(requests.at(-1).verifiedReadOnly,true)
     await transport.runRustCoreScheduledCommand(process.execPath+'.different-worker',args,{timeout:600000,sharedIo:target})
     assert.equal(requests.at(-1).timeoutMs,30000);assert.equal(requests.at(-1).verifiedReadOnly,false);assert.equal(requests.at(-1).write,true);assert.equal(requests.at(-1).accesses,undefined)
     for(const legacyOutput of [output.path,source+'/redirected-temp.json','O:/Temp/list.json','C:/reparse-temp/list.json']) {
       await transport.runRustCoreScheduledCommand(process.execPath,[...args,'--output',legacyOutput],{timeout:600000,sharedIo:target})
       const request=requests.at(-1);assert.equal(request.write,true);assert.equal(request.verifiedReadOnly,false);assert.equal(request.accesses,undefined);assert(request.roots.includes('configured-root:listing-output'));assert.equal(request.timeoutMs,30000)
     }
     const statInput=transport.createTemporaryJsonFile('hfm-preview-stat-proof');await statInput.writeJson({operation:'stat',path:source})
     try{await transport.runRustCoreScheduledCommand(process.execPath,['--shared-file-io','--input',statInput.path],{timeout:500,sharedIo:{paths:[source,'',''],write:false,preview:true,accesses:[{path:source,mode:'read',scope:'file'}]}});assert.equal(requests.at(-1).verifiedReadOnly,true);assert.equal(requests.at(-1).timeoutMs,500)}finally{await statInput.dispose()}
     await transport.runRustCoreScheduledCommand(process.execPath,args,{timeout:600000,sharedIo:{...target,paths:[source,path.win32.join(source, "uncovered")]}})
     assert.equal(requests.at(-1).timeoutMs,30000);assert.equal(requests.at(-1).verifiedReadOnly,false)
     const conservative=transport.createTemporaryJsonFile('hfm-unproven-read');
     try{for(const command of ['--install-status-read','--merged-index-query-page','--merged-index-query-metrics','--shared-metadata-known-tags','--preview-cache-read-status','--shared-file-io']){
       await conservative.writeJson({operation:'sqliteSnapshot',path:source});await transport.runRustCoreScheduledCommand(process.execPath,[command,'--input',conservative.path],{timeout:1000,sharedIo:target});assert.equal(requests.at(-1).verifiedReadOnly,false,command)
     }}finally{await conservative.dispose()}
     const previous=requests.length;await client.runRustSharedMetadataOverlayRead({rootPath:source,dbPath:path.win32.join(source, "metadata.sqlite"),entries:[{key:'one',fontId:'one'}]});assert.equal(requests.length,previous+1)
     assert.equal(requests.at(-1).verifiedReadOnly,false);assert.equal(requests.at(-1).write,true)
     const oldCount=requests.length
     await assert.rejects(client.runRustSharedMetadataOverlayRead({rootPath:source,dbPath:path.win32.join(source, "metadata.sqlite"),entries:[],bindingSnapshot:true}),e=>e.reason==='capability-unavailable');assert.equal(requests.length,oldCount)
     const readonlyClient=load(core+'clients/rustMetadataClientRuntime.ts').createRustMetadataClientRuntime({...transport,appendStartupLog:s=>logs.push(s)})
     payload={ok:true,matched:[],bindingSnapshot:{version:1,rows:[{font_id:'one',relative_path:'one.ttf',tag_names_json:'["A"]',revision:1}]}}
     const currentCount=requests.length,read=await readonlyClient.runRustSharedMetadataOverlayRead({rootPath:source,dbPath:path.win32.join(source, "metadata.sqlite"),entries:[],bindingSnapshot:true})
     assert.equal(requests.length,currentCount+1);assert.equal(read.bindingSnapshot.rows.length,1);assert.equal(requests.at(-1).write,false);assert.equal(requests.at(-1).verifiedReadOnly,true)
     const wrong=transport.createTemporaryJsonFile('hfm-binding-wrong-worker');await wrong.writeJson({bindingSnapshot:true,entries:[]})
     try{await transport.runRustCoreScheduledCommand(process.execPath+'.different-worker',['--shared-metadata-overlay-read','--input',wrong.path],{timeout:1000,sharedIo:target});assert.equal(requests.at(-1).verifiedReadOnly,false)}finally{await wrong.dispose()}
     payload={ok:true,matched:[]};await assert.rejects(readonlyClient.runRustSharedMetadataOverlayRead({rootPath:source,dbPath:path.win32.join(source, "metadata.sqlite"),entries:[],bindingSnapshot:true}),e=>e.sharedIo&&e.reason==='invalid-receipt')
   }finally{capturePool.run=captureRun;await output.dispose()}
   cases.push('bounded listing deadline and narrow capability-owned read effects; legacy/malformed receipt cannot authorize a read bypass')

   mode='hang';nextReady=path.join(dir,'ready');const file=transport.createTemporaryJsonFile('hfm-integration-lease');await file.writeJson({test:true})
   let hungSettled=false
   const hung=run(['\\\\nas\\bad'],{input:file.path,timeout:2000}).catch(e=>e).finally(()=>{hungSettled=true})
   await until(()=>fs.existsSync(nextReady));const hungChild=[...children][0];assert(hungChild);nextReady='';mode='success';payload={ok:true}
   const queued=run(['//NAS/bad/child'],{timeout:100}).catch(e=>e)
   await transport.runRustCoreScheduledCommand(process.execPath,['--font-resource-remove'],{timeout:100})
   const healthy=await run(['\\\\nas\\good'],{timeout:2000});assert.equal(healthy.sharedIo,true)
   assert.equal(hungSettled,false,'healthy root waited for hung root to settle')
   assert.equal(daemonCalls.length,localBefore+2,'local cleanup was blocked by network request')
   await file.dispose();assert(fs.existsSync(file.path),'input removed before ignoring child closed')
   assert(children.size>=1);assert.equal(hungSettled,false,'read promise settled while its child was still live')
   const error=await hung;assert.equal(error.reason,'timeout');assert.equal(error.outcome,'unknown')
   await error.closed;await until(()=>!fs.existsSync(file.path));assert.equal(children.has(hungChild),false,'read released before its physical close')
   await queued;await until(()=>children.size===0)
   cases.push('hung root, other root and local cleanup; input held until true close')
   mode='hang';nextReady=path.join(dir,'abort-ready');const controller=new AbortController()
   const aborting=run(['\\\\nas\\cancel'],{signal:controller.signal,timeout:4000}).catch(e=>e)
   await until(()=>fs.existsSync(nextReady));controller.abort()
   assert.equal((await aborting).reason,'cancelled');await until(()=>children.size===0)
   cases.push('external abort reaches actual child and is reaped')
   for (const cancelled of [false,true]) {
     mode='hang';nextReady=path.join(dir,'legacy-close-'+cancelled)
     const output=transport.createTemporaryJsonFile('hfm-legacy-list-close'),aborter=new AbortController()
     await output.writeJson({held:true})
     const source='//nas/legacy-close-'+cancelled
     const pending=transport.runRustCoreScheduledCommand(process.execPath,['--list-font-files','--root',source,'--extensions','ttf','--max','300000','--output',output.path],{timeout:cancelled?5000:1000,signal:aborter.signal,sharedIo:{paths:[source,output.path],write:true}}).catch(e=>e)
     await until(()=>fs.existsSync(nextReady));await output.dispose()
     assert(fs.existsSync(output.path),'legacy output lease released before physical close')
     if(cancelled)aborter.abort()
     const failure=await pending
     assert.equal(failure.reason,cancelled?'cancelled':'timeout');assert.equal(failure.outcome,'unknown')
     assert.equal(children.size,0,'legacy listing caller settled before its child physically closed')
     await until(()=>!fs.existsSync(output.path))
   }
   cases.push('legacy listing timeout/cancel waits through true child close and keeps its temporary lease')
   // Exercise outer consumers with compatibility explicitly on: no second SQLite attempt.
   const terminalError=new (load('src/main/path/sharedIoProcessRuntime.ts').SharedIoProcessError)('fault','unknown','timeout')
   const fallbackLoad=loader({}, {process:{...process,env:{...process.env,HFM_NODE_STATE_FALLBACK:'1'}}},transforms)
   const forbidden=()=>{throw Error('main SQLite fallback forbidden')}
   const deps={appWatchedFolders:async()=>[],appendStartupLog(){},readInstallStatusIndexInWorker:async()=>{throw terminalError},saveInstallStatusIndexInWorker:async()=>{throw terminalError},isCleanWindowsDefaultCompareResult:()=>false,openStableSqliteDb:forbidden}
   const helpers={rootForFontPath:async()=>null,fallbackInstallStatusDbPath:async()=>'/local.sqlite',installStatusSignature:()=>'',installStatusWorkerItem:x=>x,openFallbackInstallDb:forbidden}
   const item={id:'font',path:'/font.ttf'}
   const read=fallbackLoad('src/main/install/status/installStatusReadRuntime.ts').createInstallStatusReadRuntime(deps,helpers)
   const write=fallbackLoad('src/main/install/status/installStatusWriteRuntime.ts').createInstallStatusWriteRuntime(deps,helpers)
   await assert.rejects(read.readInstallStatusIndex([item]),e=>e===terminalError)
   await assert.rejects(write.saveInstallStatusIndex({font:{installed:false}},new Map([['font',item]])),e=>e===terminalError)
   const signature=fallbackLoad('src/main/indexing/shared-metadata/sharedMetadataSignatureRuntime.ts').createSharedMetadataSignatureRuntime({runtimeDeps:{exists:forbidden,appendStartupLog(){},runRustSharedMetadataSignature:async()=>{throw terminalError}},openSharedMetadataDb:forbidden})
   await assert.rejects(signature.sharedMetadataSignatureForRoot('\\\\nas\\share'),e=>e===terminalError)
   cases.push('outer install read/write and network signature forbid main filesystem/SQLite fallback')
   // Production probe runs fs in a child even when the parent fs port would hang.
   const probeLoad=loader({
     'node:child_process':{...cp,spawn},
     'node:fs':{promises:{stat(){throw Error('main stat forbidden')}}},
     [path.join(root,'src/main/path/pathCanonicalizer.ts')]:{
       normalizeNativePathText:value=>String(value).replaceAll('/','\\'),
       mappedDriveTableAsync:async()=>new Map()
     }
   },globals,transforms)
   const probe=probeLoad('src/main/path/sharedPathProbeRuntime.ts')
   const directoryProbe=await probe.probeStartupDirectory(dir,'local-test',2000)
   assert.equal(directoryProbe.directory,true);assert.equal(typeof directoryProbe.queuedMs,'number');assert.equal(typeof directoryProbe.executionMs,'number')
   const fileProbe=await probe.probeStartupDirectory(__filename,'file-test',2000)
   assert.equal(fileProbe.directory,false);assert.equal(typeof fileProbe.queuedMs,'number');assert.equal(typeof fileProbe.executionMs,'number')
   await assert.rejects(probe.probeStartupDirectory(path.join(dir,'missing'),'missing',2000))
   probe.stopSharedPathProbes();await assert.rejects(probe.probeStartupDirectory(dir,'stopped',2000),e=>e.outcome==='not-started')
   cases.push('directory/file/missing probe happens outside main with queue/execution evidence; stop closes admission')
   // Keep the real availability owner, transport and killable child together.
   // Only the external root-health result is controlled.
   for (const write of [false,true]) {
     const rootPath='//nas/timeout-'+String(write)
     assert.equal(await availability.ensureStartupPathRootAvailable(rootPath),true)
     const before=availability.getStartupPathRootState(rootPath)
     mode='hang';nextReady=path.join(dir,'timeout-'+String(write))
     const failed=healthTransport.runRustCoreScheduledCommand(process.execPath,['--test'],{timeout:1000,sharedIo:{paths:[rootPath],write}}).catch(e=>e)
     await until(()=>fs.existsSync(nextReady))
     const timeoutError=await failed
     assert.equal(timeoutError.reason,'timeout');assert.equal(timeoutError.outcome,'unknown')
     assert.equal(availability.getStartupPathRootState(rootPath).state,'online','operation timeout offlined healthy root')
     assert.equal(availability.getStartupPathRootState(rootPath).generation,before.generation,'operation timeout changed root generation')
     await until(()=>children.size===0)
   }
   cases.push('real read/write timeouts preserve healthy root state and generation')
   mode='delayed';payload={ok:true};nextReady=path.join(dir,'stale-ready')
   const staleRoot='//nas/probe-failure'
   const beforeProbe=availability.getStartupPathRootState(staleRoot)
   const stale=healthTransport.runRustCoreScheduledCommand(process.execPath,['--test'],{timeout:3000,sharedIo:{paths:[staleRoot],write:false}}).catch(e=>e)
   await until(()=>fs.existsSync(nextReady));healthyProbe=false
   assert.equal(await availability.ensureStartupPathRootAvailable(staleRoot),false)
   assert.equal(availability.getStartupPathRootState(staleRoot).state,'offline')
   assert(availability.getStartupPathRootState(staleRoot).generation>beforeProbe.generation)
   assert.equal((await stale).reason,'stale-generation')
   await until(()=>children.size===0)
   cases.push('failed dedicated root probe still offlines root and rejects in-flight old-generation result')
   const staleListingRoot='//nas/stale-legacy-listing',staleOutput=healthTransport.createTemporaryJsonFile('hfm-stale-legacy-listing')
   nextReady=path.join(dir,'stale-listing-ready');payload={ok:true,written:true}
   const listingBefore=availability.getStartupPathRootState(staleListingRoot),listingSubmissions=submissions.length
   try {
     const pending=healthTransport.runRustCoreScheduledCommand(process.execPath,['--list-font-files','--root',staleListingRoot,'--extensions','ttf','--max','300000','--output',staleOutput.path],{timeout:3000,sharedIo:{paths:[staleListingRoot,staleOutput.path],write:true}}).catch(e=>e)
     await until(()=>fs.existsSync(nextReady))
     assert.equal(await availability.ensureStartupPathRootAvailable(staleListingRoot),false)
     assert(availability.getStartupPathRootState(staleListingRoot).generation>listingBefore.generation)
     const failure=await pending
     assert.equal(failure.reason,'stale-generation');assert.equal(failure.outcome,'unknown')
     assert.equal(submissions.length,listingSubmissions+1,'stale legacy listing was replayed after possible output side effects')
     await until(()=>children.size===0)
   } finally { await staleOutput.dispose() }
   healthTransport.stopRustCoreDaemon()
   cases.push('legacy listing writer admission still rejects changed source generation without replaying possible output writes')
   mode='hang';nextReady=path.join(dir,'stop-ready')
   const stopping=run(['\\\\nas\\stop'],{timeout:5000}).catch(e=>e);await until(()=>fs.existsSync(nextReady))
   transport.stopRustCoreDaemon();assert.equal((await stopping).reason,'stopping')
   await assert.rejects(run(['\\\\nas\\new']),e=>e.outcome==='not-started')
   await until(()=>children.size===0)
   cases.push('existing lifecycle stop cancels running work and rejects new shared work')
 } finally {
   healthTransport.stopRustCoreDaemon();transport.stopRustCoreDaemon();for(const child of children) child.kill('SIGKILL');await until(()=>children.size===0);clearTimeout(watchdog);await fsp.rm(dir,{recursive:true,force:true})
 }
 console.log(JSON.stringify({passed:cases.length,cases,crlf,remainingProcesses:children.size}))
 if(!crlf && !mutant && !timeoutMutant) {
   const child=cp.spawnSync(process.execPath,[__filename,'--crlf'],{encoding:'utf8',timeout:60000});assert.equal(child.status,0,child.stdout+child.stderr)
   const negative=cp.spawnSync(process.execPath,[__filename,'--without-routing'],{encoding:'utf8',timeout:60000});assert.notEqual(negative.status,0);assert.match(negative.stderr,/production client did not reach isolated process/)
   const timeoutNegative=cp.spawnSync(process.execPath,[__filename,'--timeout-offlines-root'],{encoding:'utf8',timeout:60000});assert.notEqual(timeoutNegative.status,0);assert.match(timeoutNegative.stderr,/operation timeout offlined healthy root/)
   console.log('CRLF passed; removed-routing and timeout-offlining mutants rejected')
 }
}
main().catch(error=>{console.error(error);process.exitCode=1})
