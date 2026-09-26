const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const {loader}=require('./check-operation-chain.cjs');
const root=path.resolve(__dirname,'../..'),file='src/main/preview/native-renderer/directwritePreviewRuntime.ts';
const tick=()=>new Promise(r=>setImmediate(r));
async function owner(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dw-preview-')), png=Buffer.alloc(24);
 Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(720,16);png.writeUInt32BE(260,20);
 let count=0,release=0,closed=0,digest='a'.repeat(64),fault='',valid=true,published=0,fallbacks=0,auth=true;
 const load=loader({
  'node:fs':{...fs,existsSync:()=>true},
  [path.join(root,'src/main/preview/native-renderer/directwriteFontStaging.ts')]:{createDirectwriteFontStaging:()=>({prepare:async()=>{}})},
  [path.join(root,'src/main/preview/native-renderer/directwriteFontStore.ts')]:{DirectwriteFontStore:class{async acquire(){if(fault.startsWith('DW_FONT'))throw Error(fault);return{fontPath:'C:\\copy.font',fontIdentity:digest,sourceGeneration:1,current:()=>valid,release:async()=>{assert(closed>release);release++}}} async dispose(){}}},
  [path.join(root,'src/main/preview/native-renderer/directwriteService.ts')]:{DirectwriteService:class{async render(){count++;if(fault)throw Error(fault);return{png,receipt:{cacheHit:count>1,missingGlyphs:0}}}async whenCurrentExecutionClosed(){closed++}async dispose(){}}},
 },{AbortController});
 const runtime=load(file), trial=runtime.createDirectwritePreviewRuntime({localDataRoot:()=>dir,localPreviewImageDir:()=>path.join(dir,'images'),getFontReadPolicy:()=>({}),authorizeFontRead:async()=>auth?{ok:true}:{ok:false,reason:'denied'},appendStartupLog:()=>{}},async()=>{published++});
 const input={text:'AB',fontSize:44,width:720,height:260},font={id:'a',path:'C:\\source.ttf'},admit={isCurrent:()=>valid},fallback=async()=>{fallbacks++;return'old'};
 try{
  const a=await trial.render(font,input,admit,fallback);assert(a.startsWith('data:image/png'));assert.equal(published,1);
  assert.equal(await trial.render(font,input,admit,fallback),a);assert.equal(count,1,'image cache missed');
  await trial.render(font,{...input,text:'BA'},admit,fallback);assert.equal(count,2);
  digest='b'.repeat(64);await trial.render(font,input,admit,fallback);assert.equal(count,3,'same metadata replacement used old image');
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
 runtime.cancel(b,'request');assert.equal(signal.aborted,false);runtime.cancel(a,'request');assert.equal(signal.aborted,true);proceed();await assert.rejects(running,/STALE/);
 const death=runtime.run(a,'death',async admission=>{a.emit('destroyed');assert(admission.signal.aborted);return'image'});await assert.rejects(death,/STALE/);assert.equal(a.listenerCount('destroyed'),0);
}
async function main(){await owner();await admission();console.log('DW-05 content/backend image keys, local image reuse/publication, closed lease, one controlled fallback, auth/offline/stale/cancel denial and per-window cancellation passed')}
main().catch(e=>{console.error(e);process.exitCode=1});
