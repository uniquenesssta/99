#!/usr/bin/env node
const assert = require('node:assert/strict'), fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const {loader} = require('./check-operation-chain.cjs')
const base = 'src/main/activation/runtime/'
async function main() {
 const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-managed-recovery-'))
 const cases = []
 let offline = false, resourceFails = false, registryFails = false, sourceTouches = 0
 const sourceDir = path.join(directory, 'source'), fontsDir = path.join(directory, 'fonts'), dataDir = path.join(directory, 'data')
 await Promise.all([sourceDir, fontsDir, dataDir].map(p => fsp.mkdir(p)))
 const io = new Proxy(fsp, {get(target, name) {const fn = target[name]; if (typeof fn !== 'function') return fn; return (...args) => {
   if (offline && args.some(x => typeof x === 'string' && x.startsWith(sourceDir))) {sourceTouches++; throw Error('NAS source unavailable')}
   return fn.apply(target, args)
 }}})
 const load = loader({'node:fs': {...fs, promises:io}, electron:{app:{isPackaged:true},shell:{openPath:async()=>''}}}, {process:{...process, platform:'win32', env:{...process.env,HFM_RUST_FULL_MIGRATION:'1',HFM_NODE_BRIDGE_FALLBACK:'1',SystemDrive:'C:'}}})
 const store = load('src/main/windows/runtime/temporaryActiveFontsStoreRuntime.ts').createTemporaryActiveFontsStoreRuntime({dataRoot:()=>dataDir,dataPath:n=>path.join(dataDir,n)})
 const registry = new Map(), resources = new Set(), resourceCalls = [], statusWrites = []
 const deps = {appName:'HFM',dataRoot:()=>dataDir,dataPath:n=>path.join(dataDir,n),currentUserFontsDir:()=>fontsDir,ensureWindows(){},...store,
   normalizePathForCacheCompare:p=>p.toLowerCase(),safeTemporaryActiveFontName:i=>`HFM_ACTIVE_${i.id}.ttf`,temporaryActiveRegistryNameFor:i=>`HFM_ACTIVE_${i.id}`,
   appendStartupLog(){},withGlobalIo:(_,action)=>action(),delayToEventLoop:async()=>{},clearInstalledFontsMemoryCache(){},requestFontRefresh(){},advancedFontRefresh:async()=>{},scheduleBackgroundFontRefreshTail(){},
   isTemporaryActiveInstalledRecord:r=>r.registryName.startsWith('HFM_ACTIVE_'),
   getSystemInstalledFontsCached:async()=>[...registry].map(([registryName,p])=>({source:'HKCU',registryName,path:p,value:p,fileName:path.basename(p)})),
   compareFontInstalledWithList:()=>({installed:false,by:'none',matches:[]}),readInstallStatusIndex:async items=>({results:{},misses:items}),saveInstallStatusIndex:async()=>{},scheduleActivationInstallStatusSave:rows=>statusWrites.push(rows),
   writeFontRegistryValuesHKCUBatch:async rows=>{if(registryFails)throw Error('registry denied');for(const row of rows)registry.set(row.name,row.path)},
   deleteRegistryValueHKCU:async name=>{if(registryFails)throw Error('registry denied');registry.delete(name)},
   deleteFontRegistryValuesHKCUBatch:async names=>{if(registryFails)throw Error('registry denied');names.forEach(name=>registry.delete(name))},
   addFontResourceSession:async p=>{resources.add(p);return 1},
   removeFontResourceSession:async p=>{resourceCalls.push(p);if(resourceFails)throw Error('resource denied');resources.delete(p)},
   removeFontResourceSessionBatch:async paths=>Object.fromEntries(await Promise.all(paths.map(async p=>{try{await deps.removeFontResourceSession(p);return [p,{ok:true,count:1}]}catch(error){return [p,{ok:false,message:error.message}]}})))
 }
 const identity = load(base+'managedActivationIdentityRuntime.ts').createManagedActivationIdentityRuntime(deps)
 const verify = load(base+'fontActivationVerifyRuntime.ts').createFontActivationVerifyRuntime(deps)
 const cleanup = load(base+'fontActivationCleanupRuntime.ts').createFontActivationCleanupRuntime(deps,verify)
 const compensation = load(base+'fontActivationCompensationRuntime.ts').createFontActivationCompensationRuntime(deps,cleanup)
 const status = load(base+'fontActivationInstallStatusRuntime.ts').createFontActivationInstallStatusRuntime(deps)
 const copy = load(base+'fontActivationCopyRuntime.ts').createFontActivationCopyRuntime(deps)
 const transaction = load(base+'fontActivationTransactionRuntime.ts').createFontActivationTransactionRuntime(deps,{activationTraceStep:(_,__,fn)=>fn()},verify,status,copy,compensation)
 const session = load(base+'fontActivationSessionRuntime.ts').createFontActivationSessionRuntime(deps,status,cleanup,transaction)
 const batch = load(base+'fontDeactivationBatchRuntime.ts').createFontDeactivationBatchRuntime(deps,cleanup)
 const font = async id=>{const item={id,path:path.join(sourceDir,id+'.ttf'),fileName:id+'.ttf',format:'ttf'};await fsp.writeFile(item.path,'font bytes '+id);return item}
 const activeRecord = async id=>(await store.loadTemporaryActiveFonts()).records.find(r=>r.fontId===id)
 try {
   const a = await font('single');await session.activateFontSession(a);const record=await activeRecord(a.id)
   assert(record.identity && record.sessionId);assert.equal(record.stage,'active');assert.notEqual(record.installPath,a.path)
   assert.deepEqual(await fsp.readFile(record.installPath),await fsp.readFile(a.path))
   offline=true;assert.equal((await session.deactivateFontSession(a)).ok,true);await cleanup.flushPendingTemporaryFontDeletes('test')
   assert.equal(sourceTouches,0);assert.equal(fs.existsSync(record.installPath),false);assert.equal((await store.loadTemporaryActiveFonts()).records.length,0)
   cases.push('actual local copy and single deactivation complete with every source filesystem port denied')
   offline=false;const items=await Promise.all(['batch-a','batch-b'].map(font));for(const item of items)await session.activateFontSession(item)
   offline=true;assert.equal((await batch.deactivateFontSessionsBatch(items)).deactivated,2);await cleanup.flushPendingTemporaryFontDeletes('batch');assert.equal(sourceTouches,0)
   cases.push('batch deactivation uses local records and keeps source ports untouched')
   offline=false;const b=await font('phases');await session.activateFontSession(b);const original=await activeRecord(b.id)
   resourceFails=true;offline=true;await assert.rejects(session.deactivateFontSession(b),/resource denied/);assert(registry.has(original.registryName));assert(fs.existsSync(original.installPath));assert.equal((await activeRecord(b.id)).stage,'resource-removal-pending')
   resourceFails=false;registryFails=true;await assert.rejects(session.deactivateFontSession(b),/registry denied/);assert.equal((await activeRecord(b.id)).stage,'registry-removal-pending');const calls=resourceCalls.length
   registryFails=false;assert.equal((await session.deactivateFontSession(b)).ok,true);assert.equal(resourceCalls.length,calls,'retry removed a resource already durably settled');await cleanup.flushPendingTemporaryFontDeletes('phases')
   cases.push('resource failure preserves registry/file; reopened stage retry avoids duplicate resource removal')
   offline=false;const c=await font('replacement');await session.activateFontSession(c);const old=await activeRecord(c.id);const bytes=await fsp.readFile(old.installPath)
   await fsp.rename(old.installPath,old.installPath+'.replaced');await fsp.writeFile(old.installPath,bytes)
   assert.equal((await identity.inspect(old.installPath)).sha1,old.identity.sha1);assert.notEqual((await identity.inspect(old.installPath)).inode,old.identity.inode)
   const before=resourceCalls.length;offline=true;await assert.rejects(session.deactivateFontSession(c),/替换/);assert.equal(resourceCalls.length,before);assert(registry.has(old.registryName));assert.deepEqual(await fsp.readFile(old.installPath),bytes)
   cases.push('same bytes at a new file identity reject old cleanup before OS side effects')
   const identityModule=load(base+'managedActivationIdentityRuntime.ts');let release;const closed=new Promise(r=>release=r);identityModule.retainManagedCopyUntilClosed(old.installPath,closed)
   await assert.rejects(identity.inspect(old.installPath),/尚未关闭/);release();await closed;await new Promise(r=>setImmediate(r));assert(await identity.inspect(old.installPath))
   cases.push('timed-out copy lease prevents adoption/deletion until actual executor close')
   assert.equal(await verify.temporaryActiveRecordStillVisible({...old,registryName:'absent'}),false)
   cases.push('a leftover file alone is not reported as still active')
   const panel=load(base+'fontCleanupRemnantsRuntime.ts').createFontCleanupRemnantsRuntime(deps,cleanup,async()=>{})
   await assert.rejects(panel.runFontCleanupAction({action:'retry',path:old.installPath}),/未知字段/)
   await assert.rejects(panel.runFontCleanupAction({action:'adopt',key:'x',observedToken:'x'}),/令牌/)
   const legacy={...old,identity:undefined,lastError:'legacy'};await store.saveTemporaryActiveFonts({version:1,records:[legacy]});const report=await panel.readFontCleanupRemnants();const entry=report.records.find(r=>r.path===old.installPath);assert(entry.canAdopt)
   await fsp.appendFile(old.installPath,'changed');await assert.rejects(panel.runFontCleanupAction({action:'adopt',key:entry.key,observedToken:entry.observedToken}),/已经变化/)
   cases.push('manual actions reject arbitrary paths and stale displayed identity tokens')
   await fsp.unlink(old.installPath)
   deps.runRustFontActivationFiles=async input=>{
     if(!input.requireMissing)return null
     for(const [name,file] of Object.entries(input.registryExpectations||{})) {
       if(registry.has(name))throw Error('registry still exists')
       try{await fsp.access(file);throw Error('file still exists')}catch(error){if(error.code!=='ENOENT')throw error}
     }
     return {ok:true,copyResults:[],deleteResults:[],inspectResults:[],copied:0,reused:0,deleted:0,failed:0}
   }
   const missing=(await panel.readFontCleanupRemnants()).records.find(r=>r.path===old.installPath);assert(missing.canDismissMissing)
   await assert.rejects(panel.runFontCleanupAction({action:'dismiss-missing',key:missing.key,windowsRestarted:false}),/重启/)
   await assert.rejects(panel.runFontCleanupAction({action:'dismiss-missing',key:missing.key,windowsRestarted:true}),/registry still exists/)
   assert((await store.loadTemporaryActiveFonts()).records.length)
   registry.delete(old.registryName)
   await panel.runFontCleanupAction({action:'dismiss-missing',key:missing.key,windowsRestarted:true})
   assert.equal((await store.loadTemporaryActiveFonts()).records.length,0)
   cases.push('manual terminal action requires restart acknowledgement and native-confirmed missing file plus registry; no delete side effect')
   const journalPath=path.join(dataDir,'pending-font-activation-compensations.json');await fsp.writeFile(journalPath,'{corrupt')
   offline=false;const blocked=await font('blocked');const filesBefore=await fsp.readdir(fontsDir);await assert.rejects(session.activateFontSession(blocked),/JSON/);assert.deepEqual(await fsp.readdir(fontsDir),filesBefore);assert.equal(await fsp.readFile(journalPath,'utf8'),'{corrupt')
   cases.push('corrupt intent storage refuses activation before copy/registry/resource side effects')
   console.log(JSON.stringify({passed:cases.length,cases,nativeWindows:'not executed; filesystem owners real, OS resource/registry ports controlled'}))
 } finally {offline=false;await cleanup.flushPendingTemporaryFontDeletes('finally').catch(()=>{});await fsp.rm(directory,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
