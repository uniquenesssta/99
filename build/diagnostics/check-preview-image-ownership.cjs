const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loader}=require('./check-operation-chain.cjs');
const png=require('./fixtures/preview-png.cjs');
const gate=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:()=>resolve()}};
async function run(){
 const load=loader({}), owner=load('src/main/preview/runtime/previewImageCommitRuntime.ts');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-image-owner-')),output=path.join(dir,'final.png');
 try {
  const old=owner.claimPreviewImage(output,'hydrate');const oldFile=old.temporaryPath;
  const current=owner.claimPreviewImage(output,'render');assert(old.signal.aborted,'render must cancel obsolete optional read');
  fs.writeFileSync(current.temporaryPath,png);assert(await current.commit());
  fs.writeFileSync(oldFile,Buffer.from('late'));assert.equal(await old.commit(),false);await old.release();
  assert(fs.readFileSync(output).equals(png));await current.release();
  assert.deepEqual(fs.readdirSync(dir),['final.png']);
  let reads=0, receivedBytes, valid=true;
  const held=gate(),state={generation:1,state:'online'};
  const shared=path.join(dir,'shared');fs.mkdirSync(shared);fs.writeFileSync(path.join(shared,'key.png'),png);
  const fsp={...fs.promises,readFile:async p=>{if(p===path.join(shared,'key.png'))reads++;return fs.promises.readFile(p)}};
  const hydrateLoad=loader({'../../path/sharedFileSystemRuntime':{sharedFileSystem:fsp,withSharedIoSignal:(_signal,fn)=>fn()},'../../path/startupPathAvailabilityRuntime':{getStartupPathRootState:()=>state}});
  const io=load('src/main/path/ioDeadlineRuntime.ts');
  const hydration=hydrateLoad('src/main/preview/runtime/previewCacheHydrationRuntime.ts').createPreviewCacheHydrationRuntime({appendStartupLog(){},withIoDeadlineResult:io.withIoDeadlineResult,previewCacheStorageToShared:()=>({rootPath:shared,dir:shared,storage:'root'}),ensureSharedAvailable:async()=>true,readPreviewCacheIndexStatus:async()=> 'ok',writePreviewCacheIndex:async()=>{},validateSharedPreviewCacheMeta:async(_path,_row,bytes)=>{receivedBytes=bytes;await held.promise;return{status:'ok'}}});
  const local=path.join(dir,'hydrated.png'),row={id:'a',previewKey:'key',outputPath:local,fontSignature:'s',textHash:'t',fontSize:12,width:1,height:1};
  const task=hydration.hydratePreviewCache({storage:'local'},row);while(!receivedBytes)await new Promise(r=>setTimeout(r,5));
  assert(receivedBytes.equals(png));held.resolve();assert(await task);assert.equal(reads,1,'hydration reread the network PNG');assert(fs.readFileSync(local).equals(png));
  // A root generation change between validated bytes and commit rejects the old result.
  const stale=hydrateLoad('src/main/preview/runtime/previewImageCommitRuntime.ts').claimPreviewImage(path.join(dir,'stale.png'),'hydrate',()=>valid);
  fs.writeFileSync(stale.temporaryPath,png);valid=false;assert.equal(await stale.commit(),false);await stale.release();assert(!fs.existsSync(path.join(dir,'stale.png')));
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
 console.log('PASS temporary/final image ownership, late hydration, abort, cleanup and single PNG read');
}
async function compatibility(){
 const load=loader({'../rustCoreWorkerTransportRuntime':{parseJsonLine:JSON.parse,hasCapability:(status,cap)=>status.capabilities.includes(cap)}}), calls=[], inputs=[];let caps=['preview-cache-index-read'];
 const client=load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({diagnoseRustCoreWorker:async()=>({available:true,path:'/worker',capabilities:caps}),appendStartupLog(){},appendPreviewCacheFailureLog(){},createTemporaryJsonFile:()=>({path:'/input',writeJson:async data=>inputs.push(data),dispose:async()=>{}}),runRustCoreScheduledCommand:async(_worker,_args,options)=>{calls.push(options);return{stdout:JSON.stringify({ok:true,status:'ok',matched:true,touched:false})}}});
 const input={dbPath:'\\\\nas\\fonts\\preview.sqlite',previewKey:'a',outputPath:'\\\\nas\\fonts\\a.png',schemaVersion:1,now:'now'};
 assert.equal(await client.runRustPreviewCacheReadStatus({...input,readOnly:true}),null);assert.equal(calls.length,0);
 await client.runRustPreviewCacheReadStatus(input);assert.equal(calls.at(-1).sharedIo.write,true);
 caps.push('preview-cache-read-only-v1');await client.runRustPreviewCacheReadStatus({...input,readOnly:true});assert.equal(calls.at(-1).sharedIo.write,false);
 assert.equal(calls.at(-1).sharedIo.accesses.length,1);assert.equal(calls.at(-1).sharedIo.accesses[0].scope,'database');assert.equal(inputs.at(-1).readOnly,true);
 console.log('PASS old-worker safety and capability-gated read-only resource declaration');
}
async function rootRecovery(){
 let generation=1, probes=0;
 const load=loader({'../../path/startupPathAvailabilityRuntime':{getStartupPathRootState:()=>({rootId:'root',generation,state:'online'}),ensureStartupPathRootAvailable:async()=>{probes++;return true}}});
 const root=load('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts').createPreviewCacheRootAvailabilityRuntime();
 root.markRootPreviewCacheUnavailable('/root',{reason:'cancelled'});assert.equal(root.isRootPreviewCacheUnavailable('/root'),false);
 root.markRootPreviewCacheUnavailable('/root',Error('temporary network failure'));assert.equal(root.isRootPreviewCacheUnavailable('/root'),true);
 generation++;assert.equal(await root.ensureRootPreviewCacheAvailable('/root'),true);assert.equal(probes,1);assert.equal(root.isRootPreviewCacheUnavailable('/root'),false);
 console.log('PASS cancellation is not an outage; root recovery invalidates old cache circuit');
}
run().then(compatibility).then(rootRecovery).catch(error=>{console.error(error);process.exitCode=1});
