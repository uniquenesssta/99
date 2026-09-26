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
 }},{AbortController});
 const command=path.join(root,'build/native/directwrite/hfm-directwrite-preview.exe');
 const fonts=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/directwrite/fonts.json'),'utf8'));
 const source=path.join(dir,'fixture.ttf');fs.writeFileSync(source,Buffer.from(fonts['narrow.ttf'],'base64'));
 const port=load('src/main/preview/native-renderer/directwriteFontStaging.ts').createDirectwriteFontStaging(command,
  {fontExtensions:new Set(['.ttf']),readRoots:()=>[dir],watchedRoots:()=>[dir],appOwnedRoots:()=>[]});
 const store=new (load('src/main/preview/native-renderer/directwriteFontStore.ts').DirectwriteFontStore)(dir,port);
 const service=new (load('src/main/preview/native-renderer/directwriteService.ts').DirectwriteService)({command,temporaryRoot:dir});
 load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(message=>console.log(message));
 const render=load('src/main/preview/native-renderer/directwriteFontPreview.ts').renderStagedDirectwrite;
 const input={faceIndex:0,text:'AB',fontSize:44,width:720,height:260};
 try{
  const a=await render(service,store,source,input,{isCurrent:()=>true});
  const b=await render(service,store,source,{...input,text:'BA'},{isCurrent:()=>true});
  assert(a.receipt.ok && b.receipt.cacheHit);assert.equal(a.receipt.fontObjectId,b.receipt.fontObjectId);
  const copyFiles=fs.readdirSync(path.join(dir,'dw-fonts')).filter(x=>x.endsWith('.font'));assert.equal(copyFiles.length,1);
  assert.notEqual(source,path.join(dir,'dw-fonts',copyFiles[0]));
  const original=source+'.moved';fs.renameSync(source,original);fs.renameSync(original,source);
  const state=load('src/main/path/startupPathAvailabilityRuntime.ts');
  state.markStartupPathRootUnavailable(dir,Error('offline fixture'));
  await assert.rejects(render(service,store,source,input,{isCurrent:()=>true}),/OFFLINE|UNAUTHORIZED/);
  assert.equal(load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime().status().active,0);
 }catch(error){console.error(load('src/main/path/startupPathAvailabilityRuntime.ts').getStartupPathRootState(fs.realpathSync(dir)));throw error}
 finally{await service.dispose();await store.dispose();await load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime().whenIdle();fs.rmSync(dir,{recursive:true,force:true})}
 console.log('real authorized source → Shared I/O → SHA snapshot/store → resident DirectWrite/PNG and offline refusal passed');
}
main().catch(e=>{console.error(e);process.exitCode=1});
