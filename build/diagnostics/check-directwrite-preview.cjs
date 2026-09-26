const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const {loader}=require('./check-operation-chain.cjs');
const root=path.resolve(__dirname,'../..'),file='src/main/preview/native-renderer/directwritePreviewRuntime.ts';
const tick=()=>new Promise(r=>setImmediate(r));
async function owner(transform=s=>s){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dw-preview-')), png=Buffer.alloc(24);
 Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(720,16);png.writeUInt32BE(260,20);
 let count=0,release=0,closed=0,digest='a'.repeat(64),fault='',valid=true,published=0,fallbacks=0,auth=true;
 const load=loader({
  'node:fs':{...fs,existsSync:()=>true},
  [path.join(root,'src/main/preview/native-renderer/directwriteFontStaging.ts')]:{createDirectwriteFontStaging:()=>({prepare:async()=>{}})},
  [path.join(root,'src/main/preview/native-renderer/directwriteFontStore.ts')]:{DirectwriteFontStore:class{async acquire(){if(fault.startsWith('DW_FONT'))throw Error(fault);return{fontPath:'C:\\copy.font',fontIdentity:digest,sourceGeneration:1,current:()=>valid,release:async()=>{assert(closed>release);release++}}} async dispose(){}}},
  [path.join(root,'src/main/preview/native-renderer/directwriteService.ts')]:{DirectwriteService:class{async render(){count++;if(fault)throw Error(fault);return{png,receipt:{cacheHit:count>1,missingGlyphs:0}}}async whenCurrentExecutionClosed(){closed++}async dispose(){}}},
 },{AbortController},{[path.join(root,file)]:transform});
 const runtime=load(file), trial=runtime.createDirectwritePreviewRuntime({localDataRoot:()=>dir,localPreviewImageDir:()=>path.join(dir,'images'),getFontReadPolicy:()=>({}),authorizeFontRead:async()=>auth?{ok:true}:{ok:false,reason:'denied'},appendStartupLog:()=>{}},async()=>{published++});
 const input={text:'AB',fontSize:44,width:720,height:260},font={id:'a',path:'C:\\source.ttf'},admit={isCurrent:()=>valid},fallback=async()=>{fallbacks++;return'old'};
 try{
  const a=await trial.render(font,input,admit,fallback);assert(a.startsWith('data:image/png'));assert.equal(published,1);
  assert.equal(await trial.render(font,input,admit,fallback),a);assert.equal(count,1,'image cache missed');
  fs.rmSync(path.join(dir,'images'),{recursive:true});
  await trial.render(font,input,admit,fallback);assert.equal(count,2,'cleared image directory was not recreated');
  await trial.render(font,{...input,text:'BA'},admit,fallback);assert.equal(count,3);
  digest='b'.repeat(64);await trial.render(font,input,admit,fallback);assert.equal(count,4,'same metadata replacement used old image');
  assert.notEqual(runtime.directwriteImageKey(digest,input),runtime.directwriteImageKey(digest,{...input,width:721}));
  digest='c'.repeat(64);fault='DW_NATIVE_VARIABLE_FONT_UNSUPPORTED';assert.equal(await trial.render(font,input,admit,fallback),'old');assert.equal(fallbacks,1);
  auth=false;await assert.rejects(trial.render(font,input,admit,fallback),/FALLBACK_UNAUTHORIZED/);assert.equal(fallbacks,1);auth=true;
  for(const reason of ['DW_STALE','DW_CANCELLED','DW_SOURCE_OFFLINE','DW_FONT_UNAUTHORIZED_outside-authorized-roots','DW_TIMEOUT']){fault=reason;await assert.rejects(trial.render(font,input,admit,fallback));assert.equal(fallbacks,1)}
  valid=false;fault='';await assert.rejects(trial.render(font,input,admit,fallback),/STALE/);assert.equal(fallbacks,1);
 }finally{await trial.dispose();fs.rmSync(dir,{recursive:true,force:true})}
}
async function admission(){
 const runtime=loader({}, {AbortController})('src/main/preview/runtime/previewRenderAdmissionRuntime.ts').createPreviewRenderAdmissionRuntime();
 class Sender extends EventEmitter{isDestroyed(){return false}}
 const a=new Sender(),b=new Sender();let proceed;let signal;
 const running=runtime.run(a,'request',async admission=>{signal=admission.signal;await new Promise(r=>proceed=r);return'image'});
 runtime.cancel(b,'request');assert.equal(signal.aborted,false);runtime.cancel(a,'request');assert.equal(signal.aborted,true);proceed();await assert.rejects(running,/STALE|CANCELLED/);
 const death=runtime.run(a,'death',async admission=>{a.emit('destroyed');assert(admission.signal.aborted);return'image'});await assert.rejects(death,/STALE|CANCELLED/);assert.equal(a.listenerCount('destroyed'),0);
 const navigation=new Sender();const pending=[];
 for(let n=0;n<16;n++)pending.push(assert.rejects(runtime.run(navigation,'nav-'+n,async admission=>new Promise(resolve=>admission.signal.addEventListener('abort',()=>resolve('late')))),/CANCELLED|STALE/));
 assert.equal(navigation.listenerCount('destroyed'),1,'per-request window listeners accumulated');
 navigation.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});await Promise.all(pending);

}
async function ipcRendererChain(template) {
 const handlers=new Map();let api,resolveRender,signal,live=true;const intervals=new Set();
 class Sender extends EventEmitter{isDestroyed(){return false}}
 const sender=new Sender(),processPort={...process,platform:'win32',defaultApp:true,env:{...process.env,HFM_PREVIEW_BACKEND:'directwrite-resident'}};
 const electron={shell:{},contextBridge:{exposeInMainWorld:(_name,value)=>api=value},ipcRenderer:{invoke:async(channel,...args)=>handlers.get(channel)({sender},...args)}};
 const load=loader({electron},{AbortController,process:processPort,crypto:require('node:crypto').webcrypto,
  window:{setInterval:fn=>{intervals.add(fn);return fn},clearInterval:fn=>intervals.delete(fn)}});
 load('src/main/ipc/handlers/previewAndFolderIpcHandlers.ts').registerPreviewAndFolderIpcHandlers((channel,handler)=>handlers.set(channel,handler),{
  renderFontPreviewImage:async(_font,_text,_size,_width,_height,admission)=>{signal=admission.signal;return await new Promise(resolve=>resolveRender=resolve)},
 });
 if(template)require('node:vm').runInNewContext(load('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource,{require:()=>electron,process:processPort,console,performance,Buffer});
 else load('src/preload/index.ts');
 assert.equal(await api.getPreviewBackend(),'directwrite-resident');
 const request=load('src/renderer/src/runtime/preview/nativePreviewRequestRuntime.ts').renderNativePreviewRequest(api,{id:'a',path:'C:\\a.ttf'},'AB',{fontSize:44,width:720,height:260},()=>live);
 const rejected=assert.rejects(request,/CANCELLED|STALE/);await tick();assert(signal);live=false;
 for(const fn of [...intervals])fn();await tick();assert(signal.aborted);resolveRender('late');await rejected;assert.equal(intervals.size,0);
 const policy=load('src/main/preview/runtime/previewBackendPolicy.ts');processPort.defaultApp=false;assert.equal(policy.residentPreviewEnabled(),false);
 processPort.defaultApp=true;processPort.env.HFM_PREVIEW_BACKEND='current';assert.equal(policy.residentPreviewEnabled(),false);
}
async function manualDetail() {
 let resolve;const images=[];
 const load=loader({'react-dom':{flushSync:fn=>fn()}},{});
 const detail=load('src/renderer/src/fontDetailPanelRuntime.ts').createFontDetailPanelRuntime({
  previewFamilies:{},selectedFont:undefined,library:{previewText:'AB'},hfm:{renderPreviewImage:()=>new Promise(done=>resolve=done)},
  setNativeDetailImage:image=>images.push(image),setSelectedFontId:()=>{},setDetailVisible:()=>{},
 });
 const pending=detail.generateDetailNativePreview({id:'a'});await tick();detail.closeDetail();resolve('late');await pending;assert.deepEqual(images,[]);
}
async function main(){await owner();await admission();await manualDetail();await ipcRendererChain(false);await ipcRendererChain(true);await assert.rejects(()=>owner(s=>s.replace('input.text,', '"fixed",')));await assert.rejects(()=>owner(s=>s.replace('recoverable.test(reason)', 'true')));console.log('DW-05 content/backend image keys, local image reuse/publication, closed lease, one controlled fallback, auth/offline/stale/cancel denial and per-window cancellation passed')}
main().catch(e=>{console.error(e);process.exitCode=1});
