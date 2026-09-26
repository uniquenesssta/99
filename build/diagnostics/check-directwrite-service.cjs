#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {spawn} = require('node:child_process')
const {loader} = require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..')
const file='src/main/preview/native-renderer/directwriteService.ts'
const protocol='src/main/preview/native-renderer/directwriteProtocol.ts'
const fixture=path.join(__dirname,'fixtures/directwrite/process.cjs')
const tick=()=>new Promise(r=>setTimeout(r,10))
async function until(check) {const end=Date.now()+6000;while(!check()){assert(Date.now()<end,'condition timeout');await tick()}}
const dead=pid=>{try{process.kill(pid,0);return false}catch{return true}}
const input=text=>({fontPath:'C:\\local\\font.ttf',fontIdentity:'a'.repeat(64),sourceGeneration:1,faceIndex:0,text,fontSize:44,width:720,height:260})
function setup({deadlineMs=3000,transforms={},args=[]}={}) {
 // On Linux the Windows-shaped root is a normal relative directory, so the
 // exact production encoder and real fs/process paths can run unchanged.
 const temp=process.platform==='win32'?fs.mkdtempSync(path.join(os.tmpdir(),'hfm-dw-owner-')):fs.mkdtempSync('C:\\hfm-dw-owner-')
 const log=path.resolve(temp,'process.log');fs.writeFileSync(log,'')
 const load=loader({}, {AbortController,setImmediate},transforms)
 const Service=load(file).DirectwriteService
 const service=new Service({command:process.execPath,args:[fixture,log,...args],temporaryRoot:temp,deadlineMs})
 const events=()=>fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
 const render=(text,admission={isCurrent:()=>true})=>service.render(input(text),admission)
 return {service,render,events,load,temp,close:async()=>{await service.dispose();assert(events().filter(e=>e.type==='spawn').every(e=>dead(e.pid)),'live child after dispose');fs.rmSync(temp,{recursive:true,force:true})}}
}
async function normal() {
 const s=setup()
 try {
  assert.equal(s.events().length,0,'eager spawn')
  const [a,b]=await Promise.all([s.render('delay'),s.render('delay')]);assert.equal(a.receipt.requestId,b.receipt.requestId)
  const c=await s.render('next');assert(c.receipt.requestId>a.receipt.requestId)
  assert.equal(s.events().filter(e=>e.type==='spawn').length,1,'not resident')
  assert.equal(s.events().filter(e=>e.type==='request').length,2,'same key not coalesced')
  assert.equal(a.png.length,24)
 }finally{await s.close()}
}
async function cancellation(transforms={}) {
 const s=setup({transforms}); const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})
 try {
  const controller=new AbortController();const active=s.render('hang',{signal:controller.signal,isCurrent:()=>true});const rejected=assert.rejects(active,/CANCELLED/)
  await until(()=>s.events().some(e=>e.type==='request'))
  const first=s.events()[0].pid
  const queuedController=new AbortController();const queued=s.render('never',{signal:queuedController.signal,isCurrent:()=>true});const qr=assert.rejects(queued,/CANCELLED/)
  queuedController.abort();await qr
  const next=s.render('next');controller.abort();await rejected
  const value=await next;assert(value.receipt.ok);assert(dead(first),'restart before actual exit');assert(!dead(other.pid),'unrelated process killed')
  assert(!s.events().some(e=>e.text==='never'),'cancelled queue item executed')
  assert.equal(s.events().filter(e=>e.type==='spawn').length,2)
  const c=new AbortController();const p=s.render('delay',{signal:c.signal,isCurrent:()=>true});const survivor=s.render('delay');const pr=assert.rejects(p,/CANCELLED/);c.abort();await pr;await survivor
  let current=true;const stale=s.render('delay',{isCurrent:()=>current});const sr=assert.rejects(stale,/STALE/);await until(()=>s.events().filter(e=>e.text==='delay').length===2);current=false;await sr
 }finally{other.kill('SIGKILL');await s.close()}
}
async function queueLimit(transforms={}) {
 const s=setup({transforms});const controller=new AbortController();const pending=[]
 try {
  pending.push(s.render('hang',{signal:controller.signal,isCurrent:()=>true}).catch(e=>e))
  await until(()=>s.events().some(e=>e.type==='request'))
  for(let i=0;i<64;i++) pending.push(s.render('q'+i,{signal:controller.signal,isCurrent:()=>true}).catch(e=>e))
  let accepted=false
  const overflow=s.render('overflow',{signal:controller.signal,isCurrent:()=>true}).then(()=>{accepted=true},e=>{assert.match(e.message,/QUEUE_FULL/);accepted=true})
  void overflow.catch(()=>{})
  await tick();assert(accepted,'queue overflow did not reject immediately');await overflow
  controller.abort();await Promise.all(pending)
  assert.equal(s.events().filter(e=>e.type==='request').length,1)
 }finally{controller.abort();await s.close()}
}
async function fault(text,transforms={}) {
 const s=setup({transforms,deadlineMs:1000})
 try {
  await assert.rejects(s.render(text),/DW_/)
  const result=await s.render('recover');assert(result.receipt.ok)
  assert.equal(s.events().filter(e=>e.type==='spawn').length,2,'fault did not recycle worker')
 }finally{await s.close()}
}
async function timeoutAndFreeze() {
 const s=setup({deadlineMs:1000})
 try {
  await assert.rejects(s.render('hang'),/TIMEOUT/)
  await until(()=>s.events().filter(e=>e.type==='spawn').every(e=>dead(e.pid)))
  await s.render('recovered')
  const active=s.render('hang');const failure=assert.rejects(active,/CLOSING/)
  const shutdown=s.load('src/main/app/shutdownCoordinatorRuntime.ts')
  let resume
  const coordinator=shutdown.createShutdownCoordinator({log:()=>{},freeze:()=>{},closeRenderers:()=>new Promise(r=>resume=r),restore:()=>{},cleanup:async()=>({remaining:0}),save:async()=>{},confirmLoss:async()=>false,drainLogs:async()=>{},terminate:()=>{throw Error('unexpected exit')}})
  const closing=coordinator.request();await failure
  await assert.rejects(s.render('closing'),/CLOSING/)
  await until(()=>s.events().filter(e=>e.type==='spawn').every(e=>dead(e.pid)))
  resume(false);await closing
  await s.render('after-resume')
 }finally{await s.close()}
 const missing=setup({args:['--no-ready'],deadlineMs:100})
 try{await assert.rejects(missing.render('hang'),/TIMEOUT/)}finally{await missing.close()}
}
async function sourceMutants() {
 const absolute=path.join(root,protocol)
 await assert.rejects(fault('wrong-generation',{[absolute]:s=>s.replace('value.serviceGeneration !== request.serviceGeneration','false')}),/Missing expected rejection/)
 const serviceFile=path.join(root,file)
 await assert.rejects(queueLimit({[serviceFile]:s=>s.replace('MAX_PENDING = 64','MAX_PENDING = 65')}),/queue overflow/)
 await assert.rejects(cancellation({[serviceFile]:s=>s.replace('this.disposed || isApplicationClosing() || !subscriber.current()', 'this.disposed || isApplicationClosing()')}),/Missing expected rejection/)
}
async function nativeOwner() {
 // Invoked separately by Windows CI against the real DirectWrite executable.
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-dw-integration-'))
 const fonts=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/directwrite/fonts.json'),'utf8'))
 const fontPath=path.join(temp,'fixture.ttf')
 fs.writeFileSync(fontPath,Buffer.from(fonts['narrow.ttf'],'base64'))
 const load=loader({}, {AbortController,setImmediate});const Service=load(file).DirectwriteService
 const service=new Service({command:path.join(root,'build/native/directwrite/hfm-directwrite-preview.exe'),temporaryRoot:temp})
 try {
  const a=await service.render({...input('AB'),fontPath},{isCurrent:()=>true})
  const b=await service.render({...input('A'),fontPath},{isCurrent:()=>true})
  assert(a.png.length>100);assert(b.png.length>100);assert.notDeepEqual(a.png,b.png)
  assert.equal(a.receipt.serviceGeneration,b.receipt.serviceGeneration,'real worker not reused')
  assert.equal(a.receipt.engine,'directwrite')
  const originalPid=service.child.child.pid
  const suspended=require('node:child_process').spawnSync('python',[path.join(__dirname,'check-directwrite-resident.py'),'--suspend-main',String(originalPid)],{encoding:'utf8',timeout:10000})
  assert.equal(suspended.status,0,suspended.stderr)
  const cancel=new AbortController()
  const hung=service.render({...input('A'),fontPath},{signal:cancel.signal,isCurrent:()=>true})
  const rejected=assert.rejects(hung,/CANCELLED/)
  await until(()=>service.child?.pending)
  cancel.abort();await rejected
  const recovered=await service.render({...input('B'),fontPath},{isCurrent:()=>true})
  assert(dead(originalPid),'real native cancelled process survived')
  assert.notEqual(recovered.receipt.serviceGeneration,a.receipt.serviceGeneration)
 }finally{await service.dispose();fs.rmSync(temp,{recursive:true,force:true})}
}
async function main() {
 if(process.argv.includes('--native')) {await nativeOwner();console.log('[directwrite-service] real Windows owner → native DirectWrite → PNG passed');return}
 await normal();await cancellation();await queueLimit()
 for(const mode of ['crash','wrong-id','wrong-generation','wrong-source','wrong-output','wrong-font','wrong-engine','missing','invalid','oversized','duplicate','duplicate-field']) await fault(mode)
 await timeoutAndFreeze();await sourceMutants()
 console.log('[directwrite-service] real subprocess: reuse/coalescing, 64 queue limit, cancellation, stale source, 12 faults, bounded restart, deadline, shutdown/resume and 3 source mutants passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
