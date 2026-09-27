#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp=fs.promises, path=require('node:path'), os=require('node:os'), cp=require('node:child_process');
const {loader}=require('./check-operation-chain.cjs');
const tick=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test){const end=Date.now()+10000;while(!test()){assert(Date.now()<end,'condition timed out');await tick(10)}}
async function main(){
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'hfm-preview-shared-')), children=new Set(), logs=[];
 let hold=true, started=0, peak=0, daemonCalls=0;
 const root=path.resolve(__dirname,'../..');
 const shared='\\\\nas\\fonts\\a.ttf';
 const spawn=(file,args,options)=>{
  const input=JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1],'utf8'));
  const id=++started, release=path.join(dir,'release-'+id);
  const result=args[0]==='--shared-file-io'?{ok:true,operation:input.operation,value:{size:100,mtimeMs:1,isFile:true}}:{ok:true,outputPath:input.outputPath||'local'};
  const code=`const fs=require('node:fs'); const send=()=>{process.stdout.write(${JSON.stringify(JSON.stringify(result))})}; ${hold?`const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);send()}},5);`:'send();'}`;
  const child=cp.spawn(process.execPath,['-e',code],options);children.add(child);peak=Math.max(peak,children.size);child.once('close',()=>children.delete(child));return child;
 };
 const load=loader({electron:{app:{}},'node:child_process':{...cp,spawn},[path.join(root,'src/main/rust-core/rustCoreDaemonRuntime.ts')]:{createRustCoreDaemonRuntime:()=>({tryRun:async()=>{daemonCalls++;return {stdout:'{"ok":true}',stderr:''}},stopImmediately(){},status(){},pollStatus(){}}),isRustCoreDaemonSubmittedError:()=>false}});
 const transport=load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({appendStartupLog:s=>logs.push(s),enabled:false,required:false});
 const pool=load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime();
 const client=load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({...transport,appendStartupLog(){},diagnoseRustCoreWorker:async()=>({available:true,path:process.execPath,capabilities:['preview-render-image']})});
 const render=i=>client.runRustPreviewRenderImage({fontPath:shared,outputPath:path.join(dir,i+'.png'),text:'text',fontSize:32,width:100,height:50});
 const release=async id=>fsp.writeFile(path.join(dir,'release-'+id),'go');
 const submit=async(command,input,options={})=>{const file=transport.createTemporaryJsonFile('hfm-preview-admission');await file.writeJson(input);try{return await transport.runRustCoreScheduledCommand(process.execPath,[command,'--input',file.path],{timeout:5000,...options})}finally{await file.dispose()}};
 try{
  const ten=Array.from({length:10},(_,i)=>render(i));await until(()=>pool.status().active===10);
  assert.equal(pool.status().activePreviewRead,10);assert.equal(daemonCalls,0,'shared font must never enter resident daemon');
  assert(logs.filter(s=>s.includes('shared io started:')).every(s=>s.includes('lane=preview-read')&&s.includes('write=false')));
  // Same-root write waits; a newer preview cannot overtake that write.
  const writer=submit('--test-write',{path:shared});await until(()=>pool.status().queued===1);
  const eleven=render(11);await until(()=>pool.status().queued===2);assert.equal(started,10);
  await release(1);await until(()=>pool.status().active===9);await tick(30);assert.equal(started,10,'new preview overtook pending write');
  for(let i=2;i<=10;i++)await release(i);await Promise.all(ten);await until(()=>started===11);assert.equal(pool.status().activeDefault,1);assert.equal(pool.status().activePreviewRead,0);
  await release(11);await writer;await until(()=>started===12);await release(12);await eleven;
  assert.equal(peak,10);assert.equal(pool.status().active,0);
  // A remote output remains an exclusive write, despite a preview command.
  const remote=client.runRustPreviewRenderImage({fontPath:shared,outputPath:'\\\\nas\\fonts\\out.png',text:'x',fontSize:32,width:100,height:50});
  await until(()=>started===13);assert.equal(pool.status().activeDefault,1);assert(logs.some(s=>s.includes('label=preview-render-image')&&s.includes('write=true')));
  const remoteFollower=render(14);await until(()=>started===14);assert.equal(pool.status().activePreviewRead,1,'font read should not conflict with a different output file');await release(14);await remoteFollower;await release(13);await remote;
  // Exercise the actual source + shared filesystem + transport + process queue.
  // Only the native executable/handshake adapter is replaced with a real Node child.
  const files=load('src/main/path/sharedFileSystemRuntime.ts');
  files.configureSharedFileExecutor(async request=>({result:JSON.parse((await submit('--shared-file-io',request,{timeout:500,sharedIo:{paths:[request.path],write:false}})).stdout)}));
  const blocking=submit('--test-write',{path:shared});await until(()=>started===15);
  hold=false;
  const begin=Date.now();let resolverCalls=0;
  const source=load('src/main/preview/runtime/previewSourceRuntime.ts').resolvePreviewSource(shared,async()=>{resolverCalls++;throw Error('legacy resolver must not read shared files')});
  await until(()=>pool.status().queued===1);await tick(650);assert.equal(started,15);await release(15);await blocking;
  const result=await source;assert.equal(result.path,shared);assert.equal(result.stat.size,100);assert.equal(resolverCalls,0);assert(Date.now()-begin>=650);
  assert(logs.filter(s=>s.includes('shared io started:')).at(-1).includes('lane=preview-read'));
  const kind=load('src/shared/previewFailure.ts').previewFailureKind;
  assert.equal(kind({reason:'queue-timeout'}),'timeout');assert.equal(kind({reason:'stopping'}),'cancelled');assert.equal(kind({reason:'queue-full'}),'unavailable');
  // Queued cancellation, genuine execution timeout, and close accounting.
  hold=true;const signal=new AbortController();
  const hung=submit('--test-write',{path:shared},{timeout:150}).catch(e=>e);await until(()=>started===17);
  const cancelled=submit('--shared-file-io',{operation:'stat',path:shared},{timeout:500,signal:signal.signal,sharedIo:{paths:[shared],write:false}}).catch(e=>e);
  await until(()=>pool.status().queued===1);signal.abort();assert.equal((await cancelled).outcome,'not-started');assert.equal(started,17);
  const timeout=await hung;assert.equal(timeout.reason,'timeout');assert.equal(timeout.outcome,'unknown');await timeout.closed;await pool.whenIdle();assert.equal(pool.status().metrics.started,pool.status().metrics.closed);
  const previewTimeout=submit('--preview-render-image',{fontPath:shared,outputPath:path.join(dir,'timeout.png')},{timeout:150}).catch(e=>e);
  await until(()=>started===18);const previewError=await previewTimeout;assert.equal(previewError.reason,'timeout');assert.equal(pool.status().activePreviewRead,0,'preview caller released before physical close');
  for (const [code, expected] of [['ENOENT','missing'],['EACCES','unavailable']]) {
    files.configureSharedFileExecutor(async request=>({result:{ok:false,operation:request.operation,code,message:code}}));
    await assert.rejects(load('src/main/preview/runtime/previewSourceRuntime.ts').resolvePreviewSource(shared,async()=>{throw Error('legacy bypass')}),error=>error.message.includes('[HFM_PREVIEW:'+expected+']'));
  }
  const invalid=await pool.run({file:process.execPath,args:[],roots:['a'],timeoutMs:500,write:true,lane:'preview-read'}).catch(e=>e);assert.equal(invalid.reason,'invalid-lane');
  console.log('shared preview: real client/transport/children peak10; daemon bypass; write fairness and per-file remote-output exclusion; source waits650ms then stat within500ms; queued abort, execution timeout and physical close preserved');
 }finally{transport.stopRustCoreDaemon();for(const child of children)child.kill('SIGKILL');await pool.whenIdle();await fsp.rm(dir,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1});
