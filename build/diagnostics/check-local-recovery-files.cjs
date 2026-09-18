#!/usr/bin/env node
const assert=require('node:assert/strict'), fs=require('node:fs'), fsp=fs.promises, path=require('node:path'), os=require('node:os'), cp=require('node:child_process')
const {loader}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'), base='src/main/activation/runtime/', file=base+'localRecoveryFileRuntime.ts'
const crlf=process.argv.includes('--crlf'), mutation=process.argv.includes('--unsafe-publish')
const transforms={}
for(const name of [file,base+'fontActivationCompensationQueue.ts','src/main/activation/temporaryFontDeleteQueue.ts','src/main/windows/runtime/temporaryActiveFontsStoreRuntime.ts']) transforms[path.join(root,name)]=text=>{
 if(mutation && name===file)text=text.replace('await fsp.rename(temporary, path)','await fsp.rm(path, { force: true }); await fsp.rename(temporary, path)')
 return crlf?text.replace(/\r?\n/g,'\r\n'):text
}
const cases=[]
const record=(dir,id)=>({fontId:id,sourcePath:'\\\\unreachable\\fonts\\'+id+'.ttf',installPath:path.join(dir,'HFM_ACTIVE_'+id+'.ttf'),registryName:id,activatedAt:'2026-09-18',fileName:'HFM_ACTIVE_'+id+'.ttf'})
async function main(){
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'hfm-recovery-'))
 const filePath=path.join(dir,'record.json'), initial=JSON.stringify({version:1,records:[{id:'old'}]})
 try{
  const load=loader({}, {},transforms),create=load(file).createLocalRecoveryFileRuntime
  const store=create(()=>filePath,value=>typeof value?.id==='string')
  assert.equal((await store.load()).length,0)
  await store.save([{id:'old'}]);assert.equal(await fsp.readFile(filePath,'utf8'),initial)
  for(const bad of ['{bad',JSON.stringify({version:2,records:[]}),JSON.stringify({version:1,records:[{wrong:1}]})]){
   await fsp.writeFile(filePath,bad);await assert.rejects(store.load());await assert.rejects(store.save([]));assert.equal(await fsp.readFile(filePath,'utf8'),bad)
   const reopened=create(()=>filePath,value=>typeof value?.id==='string');await assert.rejects(reopened.load())
  }
  cases.push('ENOENT alone is empty; corrupt JSON/version/record rejected and original bytes retained')
  await fsp.writeFile(filePath,initial)
  for(const stage of ['read','write','sync','rename']){
   const ops=[],failure=Object.assign(Error(stage+' failed'),{code:stage==='write'?'ENOSPC':'EACCES'})
   const io={...fsp,readFile:async(...args)=>{if(stage==='read')throw failure;return fsp.readFile(...args)},
    open:async(...args)=>{ops.push('open');const h=await fsp.open(...args);return {writeFile:async(...values)=>{ops.push('write');if(stage==='write'){await h.writeFile('partial');throw failure}return h.writeFile(...values)},sync:async()=>{ops.push('sync');if(stage==='sync')throw failure;return h.sync()},close:async()=>{ops.push('close');return h.close()}}},
    rename:async(...args)=>{ops.push('rename');if(stage==='rename')throw failure;return fsp.rename(...args)},rm:async(target,...args)=>fsp.rm(target,...args)}
   const injected=loader({'node:fs':{promises:io}}, {},transforms)(file).createLocalRecoveryFileRuntime(()=>filePath,()=>true)
   await assert.rejects(injected.save([{id:'new'}]))
   assert(fs.existsSync(filePath),'publication deleted original');assert.equal(await fsp.readFile(filePath,'utf8'),initial,'failed publication changed original')
   assert.equal((await fsp.readdir(dir)).filter(x=>x.endsWith('.tmp')).length,0)
   if(stage==='rename')assert.deepEqual(ops,['open','write','sync','close','rename'])
  }
  cases.push('permission/disk-full/flush/rename failures preserve destination; handles and owned temp files cleaned')
  const second=create(()=>filePath,()=>true)
  await Promise.all(Array.from({length:12},(_,i)=>(i%2?store:second).update(async records=>{await new Promise(r=>setTimeout(r,1));return [...records,{id:String(i)}]})))
  assert.equal((await store.load()).length,13)
  const snapshot=[{id:'snapshot'}],saving=store.save(snapshot);snapshot[0].id='changed';await saving;assert.equal((await store.load())[0].id,'snapshot')
  cases.push('concurrent reopened owners serialize read-modify-write and snapshot caller input')
  await fsp.writeFile(filePath,initial)
  const crashScript=`const fs=require('node:fs');const {loader}=require(${JSON.stringify(path.join(root,'build/diagnostics/check-operation-chain.cjs'))});const load=loader({'node:fs':{promises:{...fs.promises,rename:async()=>process.exit(23)}}});load(${JSON.stringify(file)}).createLocalRecoveryFileRuntime(()=>${JSON.stringify(filePath)},()=>true).save([{id:'new'}]);`
  const crashed=cp.spawnSync(process.execPath,['-e',crashScript],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(crashed.status,23,crashed.stderr)
  assert.equal(await fsp.readFile(filePath,'utf8'),initial);assert.equal((await store.load())[0].id,'old')
  cases.push('real child exits after flush before rename; reopening sees complete previous file')
  const dirs={dataRoot:()=>dir,dataPath:name=>path.join(dir,name)}
  const active=load('src/main/windows/runtime/temporaryActiveFontsStoreRuntime.ts').createTemporaryActiveFontsStoreRuntime(dirs)
  await active.saveTemporaryActiveFonts({version:1,records:[record(dir,'a')]});assert.equal((await active.loadTemporaryActiveFonts()).records.length,1)
  const comp=load(base+'fontActivationCompensationQueue.ts').createFontActivationCompensationQueue(dirs)
  const pending=id=>({record:record(dir,id),pending:{file:true,registry:false,resource:false},queuedAt:'now',attempts:0,reason:'test',lastError:''})
  await Promise.all([comp.upsert(pending('a')),comp.upsert(pending('b'))]);assert.equal((await comp.load()).length,2)
  await comp.remove(record(dir,'a'));assert.equal((await comp.load())[0].record.fontId,'b')
  cases.push('real session and compensation owners retain version 1 and concurrent records')
  let resolveWorker,entered;const gate=new Promise(r=>resolveWorker=r),start=new Promise(r=>entered=r)
  const queue=load('src/main/activation/temporaryFontDeleteQueue.ts').createTemporaryFontDeleteQueue({...dirs,appName:'HFM',currentUserFontsDir:()=>dir,flushDelayMs:60000,appendStartupLog(){},delayToEventLoop:async()=>{},withGlobalIo:(_,fn)=>fn(),runRustFontActivationFiles:async input=>{entered();await gate;return {deleted:0,failed:input.deletes.length,deleteResults:input.deletes.map(p=>({path:p,ok:false,message:'file occupied'}))}}})
  await queue.flushPendingTemporaryFontDeletes('empty');assert(!fs.existsSync(dirs.dataPath('pending-temporary-font-deletes.json')),'empty cleanup must not create a queue file')
  assert.equal(queue.isSafeTemporaryActiveFontPath(path.join(dir+'-neighbor','HFM_ACTIVE_bad.ttf')),false)
  await queue.queueTemporaryFontFileDeletes([record(dir,'a')],'initial')
  const flush=queue.flushPendingTemporaryFontDeletes('test');await start
  const enqueue=queue.queueTemporaryFontFileDeletes([record(dir,'b')],'during-flush');resolveWorker();await Promise.all([flush,enqueue]);await queue.flushPendingTemporaryFontDeletes('drain-timer')
  const queuePath=dirs.dataPath('pending-temporary-font-deletes.json'),saved=JSON.parse(await fsp.readFile(queuePath,'utf8'))
  assert.deepEqual(saved.records.map(r=>r.fontId).sort(),['a','b']);assert(saved.records.every(r=>r.lastError==='file occupied'))
  cases.push('enqueue during cleanup is retained; occupied errors durable; sibling directory rejected')
  for(const [target,read,save] of [
   [dirs.dataPath('temporary-active-fonts.json'),()=>active.loadTemporaryActiveFonts(),()=>active.saveTemporaryActiveFonts({version:1,records:[]})],
   [dirs.dataPath('pending-font-activation-compensations.json'),()=>comp.load(),()=>comp.upsert(pending('c'))],
   [queuePath,()=>queue.flushPendingTemporaryFontDeletes('corrupt'),()=>queue.queueTemporaryFontFileDeletes([record(dir,'c')],'corrupt')]
  ]) {await fsp.writeFile(target,'{damaged');await assert.rejects(read());await assert.rejects(save());assert.equal(await fsp.readFile(target,'utf8'),'{damaged')}
  cases.push('all three production stores refuse to erase damaged recovery data')
 }finally{await fsp.rm(dir,{recursive:true,force:true})}
 console.log(JSON.stringify({passed:cases.length,cases,crlf}))
 if(!crlf&&!mutation){const other=cp.spawnSync(process.execPath,[__filename,'--crlf'],{encoding:'utf8',timeout:30000});assert.equal(other.status,0,other.stdout+other.stderr);const bad=cp.spawnSync(process.execPath,[__filename,'--unsafe-publish'],{encoding:'utf8',timeout:30000});assert.notEqual(bad.status,0);assert.match(bad.stderr,/publication deleted original|failed publication changed original|Missing expected rejection/);console.log('CRLF passed; destructive-publish mutant rejected')}
}
main().catch(error=>{console.error(error);process.exitCode=1})
