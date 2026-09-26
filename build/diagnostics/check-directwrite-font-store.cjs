#!/usr/bin/env node
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto');
const {loader}=require('./check-operation-chain.cjs');
const root=path.resolve(__dirname,'../..');
const file=path.join(root,'src/main/preview/native-renderer/directwriteFontStore.ts');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function scenario(transforms={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-font-store-'));
 let generation=1,online=true,content=Buffer.from('original'),beforeCopy,copyCount=0;
 const load=loader({}, {AbortController},transforms);
 const Store=load(file).DirectwriteFontStore;
 const port={prepare:async parent=>fs.mkdirSync(path.join(parent,'dw-fonts'),{recursive:true}),authorize:async name=>{
  if(name==='denied') throw Error('unauthorized');
  const gen=generation; return {path:name,identity:'same-real-file',generation:gen,current:()=>online && gen===generation};
 },copy:async(source,target,known,signal)=>{
  copyCount++;if(beforeCopy) await beforeCopy(signal);
  if(signal.aborted)throw Error('cancelled');
  const hash=digest(content),reused=hash===known;
  if(!reused)fs.writeFileSync(target,content,{flag:'wx'});
  return {digest:hash,bytes:content.length,reused};
 }};
 const store=new Store(dir,port);const acquired=[];const acquire=store.acquire.bind(store);store.acquire=async(...args)=>{const lease=await acquire(...args);acquired.push(lease);return lease};const current={isCurrent:()=>true};
 try {
  assert(!fs.existsSync(path.join(dir,'dw-fonts')),'eager store');
  await assert.rejects(store.acquire('denied',current),/unauthorized/);
  const a=await store.acquire('UNC',current),b=await store.acquire('mapped-alias',current);
  assert.equal(a.fontPath,b.fontPath);assert.equal(copyCount,2,'source hash validation skipped');
  await a.release();await b.release();
  content=Buffer.from('replaced');const c=await store.acquire('UNC',current);assert.notEqual(c.fontPath,a.fontPath);assert.equal(fs.readFileSync(c.fontPath).toString(),'replaced');
  generation++;const d=await store.acquire('UNC',current);assert(!c.current(),'old generation admitted');assert(fs.existsSync(c.fontPath),'active lease deleted');await c.release();assert(!fs.existsSync(c.fontPath));await d.release();
  beforeCopy=async()=>{generation++};await assert.rejects(store.acquire('UNC',current),/STALE/);beforeCopy=undefined;
  online=false;await assert.rejects(store.acquire('UNC',current),/STALE/);online=true;
  const controller=new AbortController();beforeCopy=async()=>{controller.abort()};await assert.rejects(store.acquire('UNC',{signal:controller.signal,isCurrent:()=>true}),/cancelled/);beforeCopy=undefined;
  const second=new Store(dir,port);try{await assert.rejects(second.acquire('UNC',current),/IN_USE/)}finally{await second.dispose()}
  const live=await store.acquire('UNC',current);await assert.rejects(store.dispose(),/PENDING/);assert(fs.existsSync(live.fontPath));await live.release();await store.dispose();
  assert.deepEqual(fs.readdirSync(path.join(dir,'dw-fonts')),['owner']);
  // Recovery is selective: only regular files with authenticated ownership.
  fs.writeFileSync(path.join(dir,'dw-fonts','a'.repeat(32)+'.part'),'half');
  fs.writeFileSync(path.join(dir,'dw-fonts','b'.repeat(32)+'.font'),'stale');
  const recovery=new Store(dir,port);const lease=await recovery.acquire('UNC',current);assert.equal(fs.readdirSync(path.join(dir,'dw-fonts')).filter(x=>/\.(part|font)$/.test(x)).length,1);await lease.release();await recovery.dispose();
  fs.writeFileSync(path.join(dir,'dw-fonts','unknown'),'keep');const unsafe=new Store(dir,port);try{await assert.rejects(unsafe.acquire('UNC',current),/UNKNOWN_CONTENT/);assert.equal(fs.readFileSync(path.join(dir,'dw-fonts','unknown')).toString(),'keep')}finally{await unsafe.dispose()}
 }finally{for(const lease of acquired)await lease.release().catch(()=>{});await store.dispose().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true})}
}
async function budget() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-font-budget-'));
 const load=loader({}, {AbortController});const Store=load(file).DirectwriteFontStore;
 let currentSize=64*1024*1024;
 const port={prepare:async p=>fs.mkdirSync(path.join(p,'dw-fonts'),{recursive:true}),authorize:async name=>({path:name,identity:name,generation:1,current:()=>true}),copy:async(s,target,known)=>{
  const fd=fs.openSync(target,'wx');fs.ftruncateSync(fd,currentSize);fs.closeSync(fd);return {digest:'a'.repeat(64),bytes:currentSize,reused:false};
 }};
 const store=new Store(dir,port),leases=[];
 try{
  for(let i=0;i<8;i++) leases.push(await store.acquire('font'+i,{isCurrent:()=>true}));
  await assert.rejects(store.acquire('overflow',{isCurrent:()=>true}),/BUDGET/);
  await leases[0].release();const ninth=await store.acquire('ninth',{isCurrent:()=>true});assert(!fs.existsSync(leases[0].fontPath));await ninth.release();
  for(const lease of leases) await lease.release();
  currentSize=1;
  for(let i=0;i<140;i++){const lease=await store.acquire('small'+i,{isCurrent:()=>true});await lease.release()}
  assert(fs.readdirSync(path.join(dir,'dw-fonts')).filter(x=>x.endsWith('.font')).length<=128);
 }finally{for(const lease of leases)await lease.release();await store.dispose();fs.rmSync(dir,{recursive:true,force:true})}
}
async function stagingBoundary() {
 const events=[];let generation=1,online=true,after,releaseClose;
 const pool={run:async request=>{
  events.push(request);
  if(after)return after(request);
  const mode=request.args[0],name=request.args[1];
  if(mode==='--font-path-info'){
   const directory=name==='C:\\allowed';
   return {stdout:JSON.stringify({type:'font-path',version:1,ok:true,pathHex:Buffer.from(name,'utf16le').toString('hex'),bytes:directory?0:8,directory})};
  }
  return {stdout:JSON.stringify({type:'font-stage',version:1,ok:true,digest:'a'.repeat(64),bytes:8,reused:false})};
 }};
 const load=loader({
  [path.join(root,'src/main/path/sharedIoProcessRuntime.ts')]:{applicationSharedIoProcessRuntime:()=>pool},
  [path.join(root,'src/main/path/startupPathAvailabilityRuntime.ts')]:{
   ensureStartupPathRootAvailable:async()=>online,getStartupPathRootState:()=>({rootId:'root',generation,state:online?'online':'offline'}),
  },
  [path.join(root,'src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{sharedIoResourceKeys:async()=>['share']},
 },{AbortController});
 const port=load('src/main/preview/native-renderer/directwriteFontStaging.ts').createDirectwriteFontStaging('native',{
  fontExtensions:new Set(['.ttf']),readRoots:()=>['C:\\allowed'],watchedRoots:()=>[],appOwnedRoots:()=>[],
 });
 const source=await port.authorize('C:\\allowed\\font.ttf');assert(source.current());
 assert.equal(events.length,4);assert(events.every(e=>e.args[0]==='--font-path-info' && e.timeoutMs===500));
 await assert.rejects(port.authorize('C:\\outside\\font.ttf'),/UNAUTHORIZED/);
 generation++;assert(!source.current());generation--;
 let closed=false;const promise=new Promise(r=>{releaseClose=()=>{closed=true;r()}});
 after=async()=>{throw Object.assign(Error('timeout'),{closed:promise})};
 let settled=false;const copy=port.copy(source,'C:\\local\\part',undefined,new AbortController().signal).catch(e=>{settled=true;throw e});
 const rejected=assert.rejects(copy,/timeout/);await new Promise(r=>setImmediate(r));assert(!settled && !closed,'released before real close');releaseClose();await rejected;
 after=async()=>({stdout:JSON.stringify({type:'font-stage',version:1,ok:true,digest:'a'.repeat(64),bytes:8,reused:true})});
 await assert.rejects(port.copy(source,'C:\\local\\part','b'.repeat(64),new AbortController().signal),/RECEIPT/);
}
async function main(){await scenario();await budget();await stagingBoundary();
 for(const [from,to] of [['!source.current()','false'],['entry.refs) return false','false) return false']]){
  let changed=false;await assert.rejects(scenario({[file]:source=>{assert(source.includes(from));changed=true;return source.replaceAll(from,to)}}));assert(changed);
 }
 console.log('directwrite font store: authorization, SHA reuse, stale/offline/cancel, aliases, leases, 512MiB/128 LRU, recovery and 2 mutants passed');
}
main().catch(e=>{console.error(e);process.exitCode=1});
