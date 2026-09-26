const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {loader}=require('./check-operation-chain.cjs');
const root=path.resolve(__dirname,'../..');
async function main(){
 assert.equal(process.platform,'win32');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-dw-preview-'));
 const allowed=process.env.HFM_DW_TEST_SOURCE_ROOT || path.join(dir,'source');fs.mkdirSync(allowed,{recursive:true});
 const source=path.join(allowed,'trial.ttf'), fonts=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/directwrite/fonts.json')));
 const load=loader({electron:{app:{getAppPath:()=>root}}},{AbortController,setImmediate});
 const logs=[],publications=[];
 const authorization={fontExtensions:new Set(['.ttf','.ttc']),readRoots:()=>[allowed],watchedRoots:()=>[allowed],appOwnedRoots:()=>[]};
 const command=path.join(root,'build/native/directwrite/hfm-directwrite-preview.exe');
 const staging=load('src/main/preview/native-renderer/directwriteFontStaging.ts').createDirectwriteFontStaging(command,authorization);
 const runtime=load('src/main/preview/native-renderer/directwritePreviewRuntime.ts').createDirectwritePreviewRuntime({
  localDataRoot:()=>dir,localPreviewImageDir:()=>path.join(dir,'images'),getFontReadPolicy:()=>authorization,
  authorizeFontRead:async p=>{try{await staging.authorize(p);return{ok:true}}catch{return{ok:false,reason:'denied'}}},appendStartupLog:m=>logs.push(m),
 },async (...args)=>publications.push(args));
 // AB intentionally ligates to the same fi outline in both fixture files; A differs.
 const input={text:'A',fontSize:44,width:720,height:260},item={id:'trial',path:source};let live=true,fallbacks=0;
 const fallback=async()=>{fallbacks++;return'old-backend'};
 try{
  fs.writeFileSync(source,Buffer.from(fonts['narrow.ttf'],'base64'));
  const first=await runtime.render(item,input,{isCurrent:()=>live},fallback);assert(first.startsWith('data:image/png'));
  assert.equal(await runtime.render(item,input,{isCurrent:()=>live},fallback),first);
  assert.equal(publications.length,1);assert(logs.some(s=>s.includes('source=local-image-cache')));
  fs.rmSync(path.join(dir,'images'),{recursive:true});
  assert.equal(await runtime.render(item,input,{isCurrent:()=>live},fallback),first);
  await runtime.render(item,{...input,text:'BA'},{isCurrent:()=>live},fallback);assert(logs.some(s=>s.includes('objectHit=true')));
  const oldStat=fs.statSync(source),wide=Buffer.from(fonts['wide.ttf'],'base64'),changed=Buffer.alloc(oldStat.size);wide.copy(changed);
  assert.equal(changed.length,oldStat.size,'fixture must preserve length');
  fs.writeFileSync(source,changed);fs.utimesSync(source,oldStat.atime,oldStat.mtime);
  const replacement=await runtime.render(item,input,{isCurrent:()=>live},fallback);assert.notEqual(replacement,first);
  assert.equal(publications.at(-1)[4],require('node:crypto').createHash('sha256').update(changed).digest('hex'));
  assert.equal(new Set(publications.map(p=>p[0])).size,3,'image keys collided');
  fs.writeFileSync(source,Buffer.from(fonts['variable.ttf'],'base64'));
  assert.equal(await runtime.render(item,input,{isCurrent:()=>live},fallback),'old-backend');assert.equal(fallbacks,1);
  live=false;await assert.rejects(runtime.render(item,input,{isCurrent:()=>live},fallback),/STALE/);assert.equal(fallbacks,1);live=true;
  const controller=new AbortController();controller.abort();await assert.rejects(runtime.render(item,input,{isCurrent:()=>live,signal:controller.signal},fallback),/STALE/);
  fs.writeFileSync(source,Buffer.from(fonts['narrow.ttf'],'base64'));
  const info=await staging.authorize(source);const stateRoot=JSON.parse(info.identity)[0];
  load('src/main/path/startupPathAvailabilityRuntime.ts').markStartupPathRootUnavailable(stateRoot,Error('test offline'));
  await assert.rejects(runtime.render(item,input,{isCurrent:()=>live},fallback),/OFFLINE|UNAUTHORIZED/);assert.equal(fallbacks,1);
  assert(fs.readdirSync(path.join(dir,'images')).filter(n=>n.endsWith('.png')).length===3);
 }finally{await runtime.dispose();await load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime().whenIdle();fs.unlinkSync(source);fs.rmSync(dir,{recursive:true,force:true})}
 console.log(`${process.env.HFM_DW_TEST_SOURCE_ROOT?'SMB':'local'} DW-05 real production owner: mapping/auth/SHA/store/resident/cache/atomic publication/replacement/fallback/stale/offline passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1});
