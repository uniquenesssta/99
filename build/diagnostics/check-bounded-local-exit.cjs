const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {loader}=require('./check-operation-chain.cjs');
const root=path.resolve(__dirname,'../..'),file='src/main/app/shutdownCoordinatorRuntime.ts';
const tick=async()=>{for(let i=0;i<60;i++)await Promise.resolve()};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
function fixture(transforms={},mocks={},globals={}){
 let now=0,id=0;const timers=new Map();
 const clock={setTimeout(fn,ms){const key=++id;timers.set(key,{at:now+ms,fn});return key},clearTimeout(key){timers.delete(key)}};
 const load=loader({...mocks,'node:perf_hooks':{performance:{now:()=>now}}},{...clock,AbortController,...globals},transforms);
 const runtime=load(file),events=[];
 const ports={log:s=>events.push(s),freeze:()=>events.push('freeze'),restore:()=>events.push('restore'),closeRenderers:async()=>true,cleanup:async()=>({remaining:0}),save:async()=>{},drainLogs:async()=>{},confirmLoss:async()=>false,terminate:outcome=>events.push(['exit',outcome,now])};
 const advance=async ms=>{const end=now+ms;await tick();while(true){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await tick()}now=end;await tick()};
 return {runtime,ports,events,advance,load,timers,now:()=>now};
}
async function deterministic(){
 for(const count of [1,100,1000]){
  const f=fixture();f.ports.cleanup=async()=>({remaining:count});const c=f.runtime.createShutdownCoordinator(f.ports);const a=c.request();assert.strictEqual(c.request(),a);await a;
  assert.equal(f.events.filter(e=>e==='freeze').length,1);assert.equal(f.events.filter(Array.isArray).length,1);assert(f.events.some(e=>String(e).includes(`remaining=${count}`)));assert(!f.events.includes('restore'));
 }
 for(const phase of ['cleanup','save','closeRenderers','drainLogs']){
  const f=fixture();f.ports[phase]=()=>new Promise(()=>{});f.ports.confirmLoss=async()=>true;const task=f.runtime.createShutdownCoordinator(f.ports).request();await f.advance(15000);await task;
  assert.equal(f.events.filter(Array.isArray).length,1,phase);assert(f.events.find(Array.isArray)[2]<=15000,phase);assert.equal(f.timers.size,0);
 }
 {
  const f=fixture(),prompt=deferred();let calls=0;
  f.ports.closeRenderers=()=>f.runtime.withShutdownPrompt(()=>{calls++;return prompt.promise});const c=f.runtime.createShutdownCoordinator(f.ports);const task=c.request();await tick();
  await f.advance(60000);assert(!f.events.some(Array.isArray));assert.equal(calls,1);assert.strictEqual(c.request(),task);
  prompt.resolve(false);await task;assert(!f.runtime.isApplicationClosing());assert(f.events.includes('restore'));assert.equal(f.timers.size,0);
  f.ports.closeRenderers=async()=>true;await c.request();assert.equal(f.events.filter(Array.isArray).length,1);
 }
 {
  const f=fixture();let confirmations=0;
  f.ports.cleanup=async()=>{f.runtime.noteRecoveryPersistenceFailure(new Error('disk full'));return {remaining:1}};
  f.ports.confirmLoss=async message=>{confirmations++;assert(message.includes('disk full'));return false};
  await f.runtime.createShutdownCoordinator(f.ports).request();assert.equal(confirmations,1);assert(!f.events.some(Array.isArray));assert(!f.runtime.isApplicationClosing());
 }
 {
  const f=fixture(),late=deferred();let unsafe=0;
  f.ports.cleanup=async()=>{await late.promise;f.runtime.assertLocalShutdownWorkAllowed();unsafe++;return {remaining:0}};
  const c=f.runtime.createShutdownCoordinator(f.ports);const task=c.request();await f.advance(8000);await task;late.resolve();await tick();assert.equal(unsafe,0);
 }
 {
  const f=fixture(),prompt=deferred(),ticket=f.runtime.applicationWorkEpoch();f.ports.closeRenderers=()=>prompt.promise;
  const task=f.runtime.createShutdownCoordinator(f.ports).request();assert.throws(()=>f.runtime.assertApplicationOpen(ticket));prompt.resolve(false);await task;
  assert.throws(()=>f.runtime.assertApplicationOpen(ticket),'old activation must stay rejected after cancel');f.runtime.assertApplicationOpen();
 }
 // Real lifecycle wiring, with only Electron and unrelated startup ports replaced.
 {
  const events=new Map(),exits=[],logs=[];const app={setName(){},getVersion:()=>'',getPath:()=>'',getAppPath:()=>'',setAppUserModelId(){},requestSingleInstanceLock:()=>true,on:(n,fn)=>events.set(n,fn),whenReady:()=>({then(){}}),exit:code=>exits.push(code)};
  const proc=Object.create(process);Object.defineProperty(proc,'platform',{value:'win32'});proc.on=()=>{};
  const load=loader({electron:{app,BrowserWindow:{getAllWindows:()=>[]},dialog:{showMessageBox:async()=>({response:1})}},[path.resolve(root,'src/main/security/appSecurityRuntime.ts')]:{registerPackagedSessionSecurity(){}},[path.resolve(root,'src/main/app/appDataRootPolicyRuntime.ts')]:{configureElectronUserDataRoot:()=>'/tmp'},[path.resolve(root,'src/main/security/appIntegrityRuntime.ts')]:{verifyPackagedAppIntegrity:()=>({ok:true})}},{process:proc,AbortController});
  const order=[];const options=new Proxy({appendLog:s=>logs.push(s),gpuAccelerationSwitches:[],gpuDisableSwitches:[],requestRendererWindowsCloseForQuit:async()=>{order.push('renderer');return true},cleanupTemporaryActiveFontsUntilEmpty:async()=>{order.push('cleanup');return {remaining:1000}},flushPendingTemporaryFontDeletes:async()=>({remaining:0}),hasPendingActivationInstallStatusSave:()=>false,hasInFlightActivationInstallStatusSave:()=>false,flushStartupLogAsync:async()=>order.push('logs'),stopRustCoreDaemon:()=>order.push('stop-native'),dbQueryWorkerShutdown:()=>order.push('stop-db')},{get:(obj,key)=>key in obj?obj[key]:()=>undefined});
  load('src/main/app/mainProcessLifecycleRuntime.ts').registerMainProcessLifecycleRuntime(options);let prevented=0;events.get('before-quit')({preventDefault(){prevented++}});events.get('before-quit')({preventDefault(){prevented++}});await tick();
  assert.equal(prevented,2);assert.deepEqual(exits,[0]);assert.equal(order.filter(x=>x==='cleanup').length,1);assert(order.indexOf('renderer')<order.indexOf('cleanup'));assert(order.includes('stop-native')&&order.includes('stop-db'));
 }
}
async function shutdownOutcomeAxes(){
 const outcomeOf=events=>JSON.parse(JSON.stringify(events.find(Array.isArray)?.[1]));
 {
  const f=fixture();await f.runtime.createShutdownCoordinator(f.ports).request();assert.deepEqual(outcomeOf(f.events),{processExitClean:true,persistenceComplete:true,localCleanupComplete:true,cleanupRemaining:0,cleanupTimedOut:false,forced:false,reason:'complete'});
 }
 {
  const f=fixture();f.ports.cleanup=async()=>({remaining:1});await f.runtime.createShutdownCoordinator(f.ports).request();assert.deepEqual(outcomeOf(f.events),{processExitClean:true,persistenceComplete:true,localCleanupComplete:false,cleanupRemaining:1,cleanupTimedOut:false,forced:false,reason:'residual'});
 }
 {
  const f=fixture();f.ports.cleanup=async()=>{f.runtime.noteRecoveryPersistenceFailure(new Error('journal disk full'));return{remaining:1}};f.ports.confirmLoss=async()=>true;await f.runtime.createShutdownCoordinator(f.ports).request();assert.deepEqual(outcomeOf(f.events),{processExitClean:false,persistenceComplete:false,localCleanupComplete:false,cleanupRemaining:1,cleanupTimedOut:false,forced:true,reason:'persistence-failure'});
 }
 {
  const f=fixture();f.ports.cleanup=()=>new Promise(()=>{});const task=f.runtime.createShutdownCoordinator(f.ports).request();await f.advance(8000);await task;assert.deepEqual(outcomeOf(f.events),{processExitClean:true,persistenceComplete:true,localCleanupComplete:false,cleanupRemaining:null,cleanupTimedOut:true,forced:false,reason:'cleanup-timeout'});
 }
 {
  const f=fixture();f.ports.cleanup=async()=>{throw Error('cleanup contract failed')};f.ports.confirmLoss=async()=>true;await f.runtime.createShutdownCoordinator(f.ports).request();assert.deepEqual(outcomeOf(f.events),{processExitClean:false,persistenceComplete:true,localCleanupComplete:false,cleanupRemaining:null,cleanupTimedOut:false,forced:true,reason:'forced-exit'});
 }
}

async function productionCleanupBudget(){
 for(const count of [1,100,1000]){
  const proc=Object.create(process);Object.defineProperty(proc,'platform',{value:'win32'});
  const f=fixture({}, {'./managedActivationIdentityRuntime':{createManagedActivationIdentityRuntime:()=>({verify:async()=>true})},'./temporaryFontDeleteQueue':{createTemporaryFontDeleteQueue:()=>({})}}, {process:proc});
  let records=Array.from({length:count},(_,i)=>({fontId:String(i),sessionId:String(i),installPath:'/managed/'+i,registryName:String(i),stage:'active'})),calls=0,writes=0;const late=deferred();
  const cleanup=f.load('src/main/activation/runtime/fontActivationCleanupRuntime.ts').createFontActivationCleanupRuntime({appName:'HFM',appendStartupLog(){},loadTemporaryActiveFonts:async()=>({records:records.map(r=>({...r}))}),saveTemporaryActiveFonts:async state=>{f.runtime.assertLocalShutdownWorkAllowed();writes++;records=state.records.map(r=>({...r}))},removeFontResourceSession:async()=>{calls++;await late.promise},currentUserFontsDir:()=>'/managed'},{});
  f.ports.cleanup=()=>cleanup.cleanupTemporaryActiveFontsUntilEmpty('quit',1);const task=f.runtime.createShutdownCoordinator(f.ports).request();await f.advance(15000);await task;
  assert.equal(f.events.filter(Array.isArray).length,1);assert.equal(calls,1);assert.equal(records.length,count);assert.equal(records[0].stage,'resource-removal-pending');
  late.resolve();await tick();assert.equal(calls,1);assert.equal(writes,1,'late cleanup cannot publish a cleared recovery journal');
 }
}

async function watcherCancellation(){
 let opened=0,closed=0;
 const f=fixture({}, {electron:{BrowserWindow:{getAllWindows:()=>[]}},'node:fs':{promises:{stat:async()=>({isDirectory:()=>true})},watch:()=>{opened++;const w={close(){closed++},on(){return w}};return w}},'../path/startupPathAvailabilityRuntime':{ensureStartupPathRootAvailable:async()=>true},'../rust-core/rustSharedIoCommandRuntime':{sharedIoResourceKeys:async()=>[]}});
 const watcher=f.load('src/main/watcher/folderWatcherRuntime.ts').createFolderWatcherRuntime({appendStartupLog(){},isIgnoredWatcherPath:()=>false,startupGraceMs:0,flushDebounceMs:10,closeRuntimeDatabases(){},watcherChangeBatchLooksUnchanged:async()=>true,applyWatchedFolderChangesToIndex:async()=>({}),syncMergedIndexForRootIncremental:async()=>{}});
 await watcher.startWatchingFolders(['/local/fonts']);assert.equal(opened,1);
 f.ports.cleanup=async()=>{watcher.stopFolderWatchers();return{remaining:0}};f.ports.save=async()=>{throw Error('disk full')};await f.runtime.createShutdownCoordinator(f.ports).request();await tick();assert.equal(opened,2,'cancel must restore configured watchers');assert.equal(closed,1);watcher.stopFolderWatchers();
}

async function lateActivation(){
 const copied=deferred(),started=deferred();let registry=0,resource=0,saved=0,intents=0,compensated=0;
 const load=loader({'node:fs':{promises:{mkdir:async()=>{}}},'./managedActivationIdentityRuntime':{createManagedActivationIdentityRuntime:()=>({inspect:async()=>({sha1:"a"})}),sameManagedIdentity:()=>true}},{AbortController});
 const runtime=load(file),transaction=load('src/main/activation/runtime/fontActivationTransactionRuntime.ts').createFontActivationTransactionRuntime(
  {ensureWindows(){},currentUserFontsDir:()=>'/managed',loadTemporaryActiveFonts:async()=>({records:[]}),saveTemporaryActiveFonts:async()=>saved++,safeTemporaryActiveFontName:()=> 'font.ttf',temporaryActiveRegistryNameFor:()=> 'font',writeFontRegistryValuesHKCUBatch:async()=>registry++,addFontResourceSession:async()=>resource++},
  {activationTraceStep:async(_step,_id,fn)=>fn()}, {},{compareActivationInstallStatus:async()=>({installed:false})},
  {copyTemporaryActiveFontWithTrace:async()=>{started.resolve();await copied.promise;return{identity:{sha1:'a'},mode:'copied'}}},
  {recordActivationIntent:async()=>intents++,queueCopyPartial:async()=>{},compensateFailedFontActivation:async()=>{compensated++;return[]}}
 );
 const a=transaction.activateFontSessionTransaction({id:'a',path:'/source/a.ttf'}),b=transaction.activateFontSessionTransaction({id:'b',path:'/source/b.ttf'});
 const checks=[assert.rejects(a,/退出/),assert.rejects(b,/退出/)];await started.promise;assert.equal(intents,1);
 await runtime.createShutdownCoordinator({log(){},freeze(){},restore(){},closeRenderers:async()=>false,cleanup:async()=>({remaining:0}),save:async()=>{},drainLogs:async()=>{},confirmLoss:async()=>false,terminate(){assert.fail('cancel')}}).request();
 copied.resolve();await Promise.all(checks);assert.equal(registry,0);assert.equal(resource,0);assert.equal(saved,0);assert.equal(compensated,1);assert.equal(intents,2,'queued activation must not write a fresh intent');
}

async function windowProtocol(){
 const {EventEmitter}=require('node:events'),handlers=new Map(),windows=[],prompt=deferred();let quitRequests=0,prompts=0,requestId;
 class Window extends EventEmitter {
  constructor(){super();windows.push(this);this.destroyed=false;this.webContents=new EventEmitter();Object.assign(this.webContents,{isDestroyed:()=>false,send:(_ch,payload)=>{requestId=payload.requestId}})}
  static getAllWindows(){return windows.filter(w=>!w.destroyed)}
  static fromWebContents(contents){return windows.find(w=>w.webContents===contents)}
  isDestroyed(){return this.destroyed} isMinimized(){return false} isVisible(){return true}
  focus(){} moveTop(){} setMenu(){} setAutoHideMenuBar(){} setMenuBarVisibility(){} show(){}
  async loadURL(){} async loadFile(){}
  close(){let prevented=false;this.emit('close',{preventDefault(){prevented=true}});if(!prevented){this.destroyed=true;this.emit('closed')}}
 }
 const mocks={electron:{app:{isPackaged:false,quit:()=>quitRequests++},BrowserWindow:Window,dialog:{showMessageBox:()=>{prompts++;return prompt.promise}},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},protocol:{registerSchemesAsPrivileged(){}}},
  'node:fs':{existsSync:()=>false,mkdirSync(){},writeFileSync(){}},
  './windowRoundedShapeRuntime':{createWindowRoundedShapeRuntime:()=>({dispose(){}})},
  './fontProtocolRuntime':{createFontProtocolRuntime:()=>({})},
  '../security/appSecurityRuntime':{productionDevToolsEnabled:()=>false,registerWindowSecurityGuards(){},resolveRendererDevUrl:()=> 'http://localhost:1234'},
  '../security/ipcSenderValidation':{assertTrustedIpcSender(){}},
 };
 const f=fixture({},mocks),r=f.load('src/main/app/windowRuntime.ts').createWindowRuntime({appName:'test',appInstallDir:()=>'/tmp',dataPath:()=>'/tmp/test-preload',runtimePreloadSource:'',loadErrorHtml:()=>'',appendLog(){},verboseRendererLogs:false,authorizeFontRead:async()=>{}});
 r.createWindow();const w=r.getMainWindow();handlers.get('app-window:rendererReady')({sender:w.webContents});w.close();assert.equal(quitRequests,1);assert(!w.destroyed);
 f.ports.closeRenderers=r.requestRendererWindowsCloseForQuit;const c=f.runtime.createShutdownCoordinator(f.ports),task=c.request();await tick();assert(requestId);
 await f.advance(3000);assert.equal(prompts,1);await f.advance(60000);assert(!w.destroyed);assert(!f.events.some(Array.isArray));
 assert.equal(await handlers.get('app-window:flushComplete')({sender:w.webContents},requestId,true),false,'late acknowledgement cannot bypass open prompt');
 prompt.resolve({response:0});await task;assert(!w.destroyed);assert(!f.runtime.isApplicationClosing());
 const retry=c.request();await tick();await handlers.get('app-window:flushComplete')({sender:w.webContents},requestId,true);await retry;assert(w.destroyed);assert.equal(f.events.filter(Array.isArray).length,1);
}

async function admissionAndBatch(){
 const handlers=new Map(),admission=deferred(),render=deferred();let calls=0,admissions=0;
 const mocks={
  './ipcTraceRuntime':{registerTracedIpcHandler:(_runtime,name,fn)=>handlers.set(name,fn)},
  './sharedActionAdmissionRuntime':{createSharedActionAdmission:()=>async channel=>{admissions++;if(channel==='fonts:query')await admission.promise}},
 };
 const registrations={fontSystem:'registerFontSystemIpcHandlers',fontTag:'registerFontTagIpcHandlers',library:'registerLibraryIpcHandlers',maintenance:'registerMaintenanceIpcHandlers',previewAndFolder:'registerPreviewAndFolderIpcHandlers',security:'registerSecurityIpcHandlers'};
 for(const [name,method] of Object.entries(registrations))mocks['./handlers/'+name+'IpcHandlers']={[method]:handle=>{if(name==='library')for(const ch of ['library:save','fonts:setLocalTagsBatch','fonts:query','fonts:activate'])handle(ch,async()=>{calls++;return true})}};
 const load=loader(mocks,{AbortController}),runtime=load(file);load('src/main/ipc/ipcHandlers.ts').registerIpcHandlers({getSharedAvailability:async()=>({})});
 const late=handlers.get('fonts:query')({}).then(()=>assert.fail('late admission resumed'),()=>{});await tick();
 const ports={log(){},freeze(){},restore(){},closeRenderers:()=>render.promise,cleanup:async()=>({remaining:0}),save:async()=>{},drainLogs:async()=>{},confirmLoss:async()=>false,terminate(){assert.fail('cancel must not exit')}};
 const closing=runtime.createShutdownCoordinator(ports).request();await assert.rejects(handlers.get('fonts:activate')({}));assert.equal(calls,0);
 assert.equal(await handlers.get('library:save')({}),true);assert.equal(await handlers.get('fonts:setLocalTagsBatch')({}),true);assert.equal(admissions,3,'local saves must retain shared-edit admission');
 render.resolve(false);await closing;admission.resolve();await late;assert.equal(calls,2,'old admission must not execute after cancel');
 const gate=deferred();let activated=0;
 const batch=load('src/main/activation/runtime/fontActivationBatchRuntime.ts').createFontActivationBatchRuntime({ensureWindows(){},requestFontRefresh(){},appendStartupLog(){}},{},{activateFontSessionTransaction:async()=>{activated++;await gate.promise;return{outcome:'activated',result:{ok:true}}}});
 const task=batch.activateFontSessionsBatch([{id:'a',fileName:'a.ttf'},{id:'b',fileName:'b.ttf'}]);await tick();
 ports.closeRenderers=async()=>false;await runtime.createShutdownCoordinator(ports).request();gate.resolve();const result=await task;assert.equal(activated,1);assert.equal(result.failed,1,'later batch item must retain old epoch');
}
async function regressions(){
 // Exercise the same production coordinator under CRLF and intentional regressions.
 const p=path.resolve(root,file),source=fs.readFileSync(p,'utf8');
 const f=fixture({[p]:s=>s.replace(/\r?\n/g,'\r\n')});await f.runtime.createShutdownCoordinator(f.ports).request();assert.equal(f.events.filter(Array.isArray).length,1);
 for(const [before,after,check] of [
  ['if (running) return running','if (false) return running',async f=>{f.ports.closeRenderers=()=>new Promise(()=>{});const c=f.runtime.createShutdownCoordinator(f.ports);assert.strictEqual(c.request(),c.request())}],
  ['ticket !== epoch','false',async f=>{const ticket=f.runtime.applicationWorkEpoch();f.ports.closeRenderers=async()=>false;await f.runtime.createShutdownCoordinator(f.ports).request();assert.throws(()=>f.runtime.assertApplicationOpen(ticket))}],
  ['shutdownWork.getStore()?.aborted','false',async f=>{const gate=deferred();let allowed=false;f.ports.cleanup=async()=>{await gate.promise;try{f.runtime.assertLocalShutdownWorkAllowed();allowed=true}catch{}return{remaining:0}};f.ports.save=async()=>{throw Error('disk full')};const task=f.runtime.createShutdownCoordinator(f.ports).request();await f.advance(8000);await task;gate.resolve();await tick();assert.equal(allowed,false)}],
 ]){
  assert(source.includes(before));const f=fixture({[p]:s=>s.replace(before,after)});await assert.rejects(()=>check(f),undefined,'regression escaped: '+before);
 }
}

async function realProcesses(){
 const load=loader({}, {AbortController}),runtime=load(file),io=load('src/main/path/sharedIoProcessRuntime.ts'),pool=io.applicationSharedIoProcessRuntime();const outcomes=[];
 const child="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
 const jobs=[0,1,2].map(i=>pool.run({file:process.execPath,args:['-e',child],roots:['root'+i],write:i===2,timeoutMs:60000,queueTimeoutMs:60000,maxBuffer:1000}).catch(e=>outcomes.push(e.outcome)));
 await new Promise(r=>setTimeout(r,200));assert.equal(pool.status().active,2);assert.equal(pool.status().queued,1);
 let exited=false;const started=Date.now();await runtime.createShutdownCoordinator({log(){},freeze(){},restore(){throw Error('must exit')},closeRenderers:async()=>true,cleanup:async()=>{await pool.whenIdle();return {remaining:0}},save:async()=>{},drainLogs:async()=>{},confirmLoss:async()=>true,terminate:()=>{exited=true}}).request();
 await Promise.all(jobs);assert(exited);assert.equal(pool.status().active,0);assert.equal(pool.status().queued,0);assert.equal(pool.status().pids.length,0);assert(outcomes.includes('not-started'));assert(outcomes.includes('unknown'));assert(Date.now()-started<5000);
 let released=0;await assert.rejects(pool.run({file:process.execPath,args:['-e','process.exit(0)'],roots:['later'],write:false,timeoutMs:1000,onClose:()=>released++}),/退出/);assert.equal(released,1);
}
(async()=>{await deterministic();await shutdownOutcomeAxes();await productionCleanupBudget();await watcherCancellation();await lateActivation();await windowProtocol();await admissionAndBatch();await regressions();await realProcesses();console.log('[diagnostics:bounded-local-exit] coordinator/lifecycle, three-axis 0/residual/persistence-failure/cleanup-timeout/forced outcomes, 1/100/1000 remnants, duplicate close, frozen admissions, cancelled epoch, paused prompts, disk failure, late copy/batch/IPC, late cleanup, real window protocol, CRLF/three mutants and real child close passed')})().catch(e=>{console.error(e);process.exitCode=1});
