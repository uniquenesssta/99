#!/usr/bin/env node
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const {loader}=require('./check-operation-chain.cjs');
const root=path.resolve(__dirname,'../..');
async function main(){
 assert.equal(process.platform,'win32','requires Windows native executable');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-dw-stage-chain-'));
 // The mapping discovery OS port is fixed to an empty table for this local
 // fixture. Authorization, availability owner/probe, shared process pool,
 // staging/store, resident rendering and filesystem operations are real.
 const canonical=loader()('src/main/path/pathCanonicalizer.ts');
 const load=loader({[path.join(root,'src/main/path/pathCanonicalizer.ts')]:{
  ...canonical,mappedDriveTableAsync:async()=>new Map(),
 }},{AbortController,setImmediate});
 const command=path.join(root,'build/native/directwrite/hfm-directwrite-preview.exe');
 const fonts=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/directwrite/fonts.json'),'utf8'));
 const networkRoot=process.env.HFM_DW_TEST_SOURCE_ROOT;
 const allowed=networkRoot || path.join(dir,'allowed');if(!networkRoot)fs.mkdirSync(allowed);
 const source=path.join(allowed,'fixture.ttf');fs.writeFileSync(source,Buffer.from(fonts['narrow.ttf'],'base64'));
 const port=load('src/main/preview/native-renderer/directwriteFontStaging.ts').createDirectwriteFontStaging(command,
  {fontExtensions:new Set(['.ttf']),readRoots:()=>[allowed],watchedRoots:()=>[allowed],appOwnedRoots:()=>[]});
 const store=new (load('src/main/preview/native-renderer/directwriteFontStore.ts').DirectwriteFontStore)(dir,port);
 const service=new (load('src/main/preview/native-renderer/directwriteService.ts').DirectwriteService)({command,temporaryRoot:dir});
 load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(message=>console.log(message));
 const render=load('src/main/preview/native-renderer/directwriteFontPreview.ts').renderStagedDirectwrite;
 const input={faceIndex:0,text:'AB',fontSize:44,width:720,height:260};
 try{
  const sourceInfo=await port.authorize(source);const canonicalRoot=JSON.parse(sourceInfo.identity)[0];
  const outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.copyFileSync(source,path.join(outside,'other.ttf'));
  await assert.rejects(port.authorize(path.join(outside,'other.ttf')),/UNAUTHORIZED/);
  if(!networkRoot){const junction=path.join(allowed,'escape');require('node:child_process').execFileSync('cmd',['/c','mklink','/J',junction,outside]);
   await assert.rejects(port.authorize(path.join(junction,'other.ttf')),/UNAUTHORIZED/);fs.rmdirSync(junction);}
  const a=await render(service,store,source,input,{isCurrent:()=>true});
  const b=await render(service,store,source,{...input,text:'BA'},{isCurrent:()=>true});
  assert(a.receipt.ok && b.receipt.cacheHit);assert.equal(a.receipt.fontObjectId,b.receipt.fontObjectId);
  const copyFiles=fs.readdirSync(path.join(dir,'dw-fonts')).filter(x=>x.endsWith('.font'));assert.equal(copyFiles.length,1);
  assert.notEqual(source,path.join(dir,'dw-fonts',copyFiles[0]));
  // Cancel the actual native writer after its exclusive .part file appears.
  // Capacity and temp files must remain owned until the real process closes.
  const large=path.join(allowed,'large.ttf');fs.copyFileSync(source,large);fs.truncateSync(large,64*1024*1024);
  const controller=new AbortController();let finished=false,sawPart=false;
  const acquisition=store.acquire(large,{signal:controller.signal,isCurrent:()=>true});
  void acquisition.finally(()=>{finished=true}).catch(()=>{});
  const rejected=assert.rejects(acquisition,/cancelled|STALE/);
  const until=Date.now()+10000;
  while(!finished && Date.now()<until){
   if(fs.readdirSync(path.join(dir,'dw-fonts')).some(name=>name.endsWith('.part'))){sawPart=true;controller.abort();break}
   await new Promise(resolve=>setTimeout(resolve,1));
  }
  if(!sawPart)controller.abort();await rejected;assert(sawPart,'writer was not observed during copy');
  assert.equal(fs.readdirSync(path.join(dir,'dw-fonts')).filter(x=>/\.(part|font)$/.test(x)).length,1,'cancelled partial published or leaked');
  const original=source+'.moved';fs.renameSync(source,original);fs.renameSync(original,source);
  const state=load('src/main/path/startupPathAvailabilityRuntime.ts');
  state.markStartupPathRootUnavailable(canonicalRoot,Error('offline fixture'));
  await assert.rejects(render(service,store,source,input,{isCurrent:()=>true}),/OFFLINE|UNAUTHORIZED/);
  assert.equal(load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime().status().active,0);
 }catch(error){console.error(load('src/main/path/startupPathAvailabilityRuntime.ts').getStartupPathRootState(fs.realpathSync(dir)));throw error}
 finally{await service.dispose();await store.dispose();await load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime().whenIdle();fs.rmSync(dir,{recursive:true,force:true})}
 console.log((networkRoot?'SMB ':'local ')+'real authorized source → Shared I/O → SHA snapshot/store → resident DirectWrite/PNG and offline refusal passed');
}
main().catch(e=>{console.error(e);process.exitCode=1});
