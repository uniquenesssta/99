const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loader} = require('./check-operation-chain.cjs');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for(let i=0;i<400;i++){if(predicate())return;await tick(5)}throw Error('condition timed out'); }
async function run(){
 const load=loader({}), identity=load('src/main/rust-core/rustSharedIoCommandRuntime.ts');
 const root='\\\\nas\\fonts', font=root+'\\folder\\a.ttf', db=root+'\\cache\\preview.sqlite';
 const access=async(path,mode='read',scope='file')=>(await identity.sharedIoAccesses([{path,mode,scope}]))[0];
 const conflict=load('src/main/path/sharedIoAccessRuntime.ts').sharedIoAccessConflict;
 assert(conflict(await access(db,'read','database'),await access(db+'-wal','write')));
 assert(conflict(await access(root+'\\folder','write','tree'),await access(font)));
 assert(!conflict(await access(root+'\\fold','write','tree'),await access(font)));
 assert(!conflict(await access(font),await access(font)));
 assert.equal(JSON.stringify(await identity.sharedIoAccesses([{path:'//NAS/fonts/folder/../folder/A.ttf',mode:'read',scope:'file'}])),JSON.stringify([await access(font)]));
 const mapped=loader({'../path/pathCanonicalizer':{normalizeNativePathText:p=>p,mappedDriveTableAsync:async()=>new Map([['Z:',root]])}},{process:{...process,platform:'win32',env:{...process.env,SystemDrive:'C:'}}})('src/main/rust-core/rustSharedIoCommandRuntime.ts');
 assert.equal(JSON.stringify(await mapped.sharedIoAccesses([{path:'Z:\\folder\\a.ttf',mode:'read',scope:'file'}])),JSON.stringify([await access(font)]));
 const fileAccess=load('src/main/path/sharedFileSystemRuntime.ts').sharedFileAccesses;
 const copyAccess=fileAccess({operation:'copyFile',path:font,dest:'C:\\local\\image.png'});assert.equal(copyAccess[0].mode,'read');assert.equal(copyAccess[1].mode,'write');
 const repairAccess=fileAccess({operation:'repairRootDatabase',path:db,dest:root+'\\quarantine'});assert.equal(repairAccess[0].scope,'database');assert.equal(repairAccess.at(-1).scope,'tree');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-resource-')); const runtime=load('src/main/path/sharedIoProcessRuntime.ts').createSharedIoProcessRuntime(()=>{});
 const jobs=[];
 const start=(name,accesses,lane='default')=>{ const held=runtime.run({file:process.execPath,args:['-e',`const f=require('fs');f.writeFileSync(${JSON.stringify(path.join(directory,name+'.started'))},'');const timer=setInterval(()=>{if(f.existsSync(${JSON.stringify(path.join(directory,name+'.end'))}))clearInterval(timer)},5)`],roots:[...new Set(accesses.map(a=>a.root))],accesses,lane,write:accesses.some(a=>a.mode==='write'),timeoutMs:5000,queueTimeoutMs:5000});jobs.push(held);return held;};
 const started=name=>fs.existsSync(path.join(directory,name+'.started'));
 const end=name=>fs.writeFileSync(path.join(directory,name+'.end'),'');
 try {
  const dbWrite=start('database',[await access(db,'write','database')]);await until(()=>started('database'));
  const preview=start('font',[await access(font)],'preview-read');await until(()=>started('font'));assert(!started('database-end'));
  const dbRead=start('same-db',[await access(db,'read','database')]);await tick(35);assert(!started('same-db'));
  end('font');await preview;end('database');await dbWrite;await until(()=>started('same-db'));end('same-db');await dbRead;
  // An earlier conflicting writer blocks newer reads, without blocking an unrelated read.
  const read=start('read',[await access(font)],'preview-read');await until(()=>started('read'));
  const write=start('write',[await access(font,'write')]);
  const newer=start('newer',[await access(font)],'preview-read');
  const unrelated=start('unrelated',[await access(root+'\\other.ttf')],'preview-read');await until(()=>started('unrelated'));assert(!started('write'));assert(!started('newer'));
  end('unrelated');await unrelated;end('read');await read;await until(()=>started('write'));assert(!started('newer'));end('write');await write;await until(()=>started('newer'));end('newer');await newer;
  // Composite requests acquire both ends together. No partial lock deadlock.
  const first=start('first',[await access(font,'write')]);await until(()=>started('first'));
  const copy=start('copy',[await access(font),await access(db,'write','database')]);
  const free=start('free',[await access(db,'read','database')],'preview-read');await tick(30);assert(!started('copy'));assert(!started('free'),'writer fairness was lost');
  end('first');await first;await until(()=>started('copy'));end('copy');await copy;await until(()=>started('free'));end('free');await free;
  await runtime.whenIdle();assert.equal(runtime.status().metrics.started,runtime.status().metrics.closed);
 } finally {runtime.stop();await runtime.whenIdle();await Promise.allSettled(jobs);fs.rmSync(directory,{recursive:true,force:true});}
 console.log('PASS precise shared resources: real children, unrelated progress, DB sidecars, tree boundaries, fairness, atomic sets and close');
}
run().catch(error=>{console.error(error);process.exitCode=1});
