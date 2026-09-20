#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const cp = require('node:child_process')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..'), core = 'src/main/rust-core/'
const crlf = process.argv.includes('--crlf'), mutant = process.argv.includes('--without-routing')
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
   return crlf ? source.replace(/\r?\n/g,'\r\n') : source
 }
 const mockDaemon = { createRustCoreDaemonRuntime: () => ({ tryRun:async(_,args)=>{daemonCalls.push(args);return{stdout:JSON.stringify(payload),stderr:''}}, stop(){}, stopImmediately(){}, status(){return{}}, pollStatus(){} }), isRustCoreDaemonSubmittedError:e=>!!e?.daemonSubmitted }
 const spawn = (file,args,options) => {
   submissions.push({file,args:plain(args),options})
   let runArgs = args
   if (args[0]?.startsWith('--')) {
     currentInput = args[args.indexOf('--input')+1]
     const ready = nextReady, input = currentInput
     const script = `const fs=require('node:fs'); const input=${JSON.stringify(input)}; if(input) JSON.parse(fs.readFileSync(input,'utf8')); ${ready ? `fs.writeFileSync(${JSON.stringify(ready)},'ready');` : ''}`
       + (mode==='hang' ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" : mode==='bad-json' ? "process.stdout.write('broken')" : 'process.stdout.write('+JSON.stringify(JSON.stringify(payload))+')')
     runArgs = ['-e',script]
   }
   const child = cp.spawn(process.execPath,runArgs,options);children.add(child);child.once('close',()=>children.delete(child));return child
 }
 const load = loader({ electron:{app:{}}, 'node:child_process':{...cp,spawn},
   [path.join(root,core+'rustCoreDaemonRuntime.ts')]:mockDaemon }, {AbortController}, transforms)
 const transport = load(core+'rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({appendStartupLog:s=>logs.push(s),enabled:false,required:false})
 const globals = {process:{...process,platform:'win32'}}
 const mapped = loader({[path.join(root,'src/main/path/pathCanonicalizer.ts')]:{
   normalizeNativePathText:load('src/main/path/pathCanonicalizer.ts').normalizeNativePathText,
   mappedDriveTableAsync:async()=>new Map([['O:','\\\\NAS\\share']])
 }},globals,transforms)(core+'rustSharedIoCommandRuntime.ts')
 const client = load(core+'clients/rustMetadataClientRuntime.ts').createRustMetadataClientRuntime({...transport,
   diagnoseRustCoreWorker:async()=>({available:true,path:process.execPath,capabilities:['install-status-index-read','install-status-index-save','shared-metadata-apply','shared-metadata-remove-tag','shared-metadata-known-tags','shared-metadata-overlay-read','shared-metadata-signature']}),
   appendStartupLog:s=>logs.push(s)})
 const run = (roots,extras={}) => transport.runRustCoreScheduledCommand(process.execPath,['--shared-metadata-signature','--input',extras.input || ''],{timeout:250,sharedIo:{paths:roots,write:false},...extras})
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
   cases.push('real client -> transport -> child -> receipt; daemon is bypassed')
   const localBefore=daemonCalls.length
   await client.runRustSharedMetadataSignature({dbPath:path.join(dir,'local.sqlite')})
   assert.equal(daemonCalls.length,localBefore+1)
   cases.push('local metadata keeps existing transport')
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
   mode='hang';nextReady=path.join(dir,'ready');const file=transport.createTemporaryJsonFile('hfm-integration-lease');await file.writeJson({test:true})
   const hung=run(['\\\\nas\\bad'],{input:file.path,timeout:2000}).catch(e=>e)
   await until(()=>fs.existsSync(nextReady));nextReady='';mode='success';payload={ok:true}
   const queued=run(['//NAS/bad/child'],{timeout:100}).catch(e=>e)
   await transport.runRustCoreScheduledCommand(process.execPath,['--font-resource-remove'],{timeout:100})
   const healthy=await run(['\\\\nas\\good']);assert.equal(healthy.sharedIo,true)
   assert.equal(daemonCalls.length,localBefore+2,'local cleanup was blocked by network request')
   const error=await hung;assert.equal(error.reason,'timeout');assert.equal(error.outcome,'unknown')
   await file.dispose();assert(fs.existsSync(file.path),'input removed before ignoring child closed')
   assert(children.size>=1);await until(()=>!fs.existsSync(file.path))
   await queued
   cases.push('hung root, other root and local cleanup; input held until true close')
   mode='hang';nextReady=path.join(dir,'abort-ready');const controller=new AbortController()
   const aborting=run(['\\\\nas\\cancel'],{signal:controller.signal,timeout:4000}).catch(e=>e)
   await until(()=>fs.existsSync(nextReady));controller.abort()
   assert.equal((await aborting).reason,'cancelled');await until(()=>children.size===0)
   cases.push('external abort reaches actual child and is reaped')
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
   mode='hang';nextReady=path.join(dir,'stop-ready')
   const stopping=run(['\\\\nas\\stop'],{timeout:5000}).catch(e=>e);await until(()=>fs.existsSync(nextReady))
   transport.stopRustCoreDaemon();assert.equal((await stopping).reason,'stopping')
   await assert.rejects(run(['\\\\nas\\new']),e=>e.outcome==='not-started')
   await until(()=>children.size===0)
   cases.push('existing lifecycle stop cancels running work and rejects new shared work')
 } finally {
   transport.stopRustCoreDaemon();for(const child of children) child.kill('SIGKILL');await until(()=>children.size===0);clearTimeout(watchdog);await fsp.rm(dir,{recursive:true,force:true})
 }
 console.log(JSON.stringify({passed:cases.length,cases,crlf,remainingProcesses:children.size}))
 if(!crlf && !mutant) {
   const child=cp.spawnSync(process.execPath,[__filename,'--crlf'],{encoding:'utf8',timeout:60000});assert.equal(child.status,0,child.stdout+child.stderr)
   const negative=cp.spawnSync(process.execPath,[__filename,'--without-routing'],{encoding:'utf8',timeout:60000});assert.notEqual(negative.status,0);assert.match(negative.stderr,/production client did not reach isolated process/)
   console.log('CRLF passed; removed-routing mutant rejected')
 }
}
main().catch(error=>{console.error(error);process.exitCode=1})
