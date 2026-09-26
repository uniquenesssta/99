const assert=require('node:assert/strict');
const {loader}=require('./check-operation-chain.cjs');
const png=require('./fixtures/preview-png.cjs');
async function run(){
 let now=1000, source='ok', renderFailure=false, index='failed', renders=0, writes=[], files=new Map();
 class Clock extends Date {static now(){return now}}
 const fs={stat:async()=>{if(source!=='ok')throw Object.assign(Error(source),{code:source});return {size:100,mtimeMs:1}},access:async p=>{if(p.endsWith('.png')&&!files.has(p))throw Object.assign(Error('missing'),{code:'ENOENT'})},readFile:async p=>{if(!files.has(p))throw Object.assign(Error('missing'),{code:'ENOENT'});return files.get(p)},mkdir:async()=>{},copyFile:async()=>{}};
 const deadline={fileExistsTimeoutMs:()=>500,previewCacheQueryTimeoutMs:()=>2000,fileExistsWithDeadline:async p=>files.has(p),withIoDeadlineResult:async(label,f)=>{if(source==='timeout'&&label==='preview-font-stat')return {ok:false,timedOut:true};try{return {ok:true,value:await f(),timedOut:false}}catch(error){return {ok:false,error,timedOut:false}}}};
 const storage={previewCacheStorageForFont:async()=>({identity:'font',dir:'/cache',storage:'local'}),readPreviewCacheIndexStatus:async()=>index,writePreviewCacheIndex:async(_s,_k,v)=>{writes.push(v.status);index=v.status},deletePreviewCacheIndex:async()=>{index=null},rememberPreviewCacheRenderQueued(){}};
 const load=loader({
 '../native-renderer/directwrite/directWritePreviewHelperPathRuntime':{hasDirectWritePreviewHelper:()=>false},
 '../path/sharedFileSystemRuntime':{sharedFileSystem:fs},'../../path/sharedFileSystemRuntime':{sharedFileSystem:fs},
 '../path/ioDeadlineRuntime':deadline,'../../path/ioDeadlineRuntime':deadline,
 './runtime/previewCacheStorageRuntime':{createPreviewCacheStorageRuntime:()=>storage},
 './runtime/previewCachePublishRuntime':{createPreviewCachePublishRuntime:()=>({enqueuePreviewCachePublish(){}})},
 './native-renderer/previewNativeRendererRuntime':{createPreviewNativeRenderer:()=>({activeEngineLabel:()=> 'test',renderNativePreview:async request=>{renders++;if(renderFailure)throw Error('bad font');files.set(request.outputPath,png);return {ok:true,outputPath:request.outputPath,engine:'test'}}})},
 },{Date:Clock});
 const classify=load('src/shared/previewFailure.ts');
 const validate=load('src/main/preview/runtime/previewImageValidationRuntime.ts').isCompletePreviewPng;
 assert(validate(png));assert(!validate(png.subarray(0,-1)));const corrupt=Buffer.from(png);corrupt[45]^=1;assert(!validate(corrupt));
 const options={ensureWindows(){},appendStartupLog(){},sha1:()=> 'key',resolveExistingFontFilePath:async()=>source==='EACCES'?undefined:'/font.ttf',withGlobalIo:(_s,f)=>f(),previewTaskKey:x=>x,completeBackgroundTask:async()=>{},upsertBackgroundTask:async()=>{},startBackgroundTask:async()=>{},heartbeatBackgroundTask:async()=>{},failBackgroundTask:async()=>{}};
 const runtime=load('src/main/preview/previewRuntime.ts').createPreviewRuntime(options);
 const font={id:'a',path:'/font.ttf',fileSize:100,modifiedAt:1};
 for(const [condition,kind] of [['timeout','timeout'],['ENOENT','missing'],['EACCES','unavailable'],['stale-generation','cancelled']]){
  source=condition;await assert.rejects(runtime.renderFontPreviewImage(font,'text'),e=>classify.previewFailureKind(e)===kind);assert.equal(renders,0);assert.equal(writes.length,0);
 }
 source='ok';const image=await runtime.renderFontPreviewImage(font,'text');assert(image.startsWith('data:image/png;base64,'));assert.equal(renders,1,'old failed index blocked recovery');assert.equal(writes.at(-1),'ok');
 assert.equal(await runtime.renderFontPreviewImage(font,'text'),image);assert.equal(renders,1);
 // New runtime represents restart with historical missing index and a corrupt PNG.
 index='missing';for(const p of files.keys())files.set(p,corrupt);
 const restart=load('src/main/preview/previewRuntime.ts').createPreviewRuntime(options);
 await restart.renderFontPreviewImage(font,'text');assert.equal(renders,2,'corrupt cache or old missing row prevented regeneration');
 files.clear();index='failed';renderFailure=true;
 const failing=load('src/main/preview/previewRuntime.ts').createPreviewRuntime(options);
 await assert.rejects(failing.renderFontPreviewImage(font,'retry'),/HFM_PREVIEW:failed/);const before=renders;
 await assert.rejects(failing.renderFontPreviewImage(font,'retry'),/HFM_PREVIEW:failed/);assert.equal(renders,before,'failed generation retried without backoff');
 now+=30001;renderFailure=false;await failing.renderFontPreviewImage(font,'retry');assert.equal(renders,before+1);
 source='ENOENT';const backgroundMissing=await runtime.ensureFontPreviewCache({...font,previewError:'字体文件不存在或路径已失效。'},'background');assert.equal(backgroundMissing.ok,false,'background trusted old cache before rechecking legacy source');source='ok';
 const memory=load('src/main/preview/runtime/previewImageMemoryRuntime.ts').createPreviewImageMemoryRuntime();memory.remember('x','data:image/svg+xml,missing');assert.equal(memory.get('x'),'');
 const rendererLoad=loader({'../../../appRuntime':{PREVIEW_STATE_LRU_LIMIT:800,pruneRecordByKeyLimit:x=>x},'../../../rendererPerformance':{reportRendererTrace(){}},'./fontPreviewQuickFallbackRuntime':{}},{Date:Clock});
 let failureKind='missing', rendererCalls=0, saved={id:'legacy',path:'/legacy.ttf',fileName:'legacy.ttf',fileSize:100,systemInstalled:true,previewDisabled:true,previewError:'字体文件不存在或路径已失效。'};
 const rendererOptions={previewText:'text',listPreviewFontSize:44,previewRequestTokenRef:{current:'text::44'},selectedFontId:'',selectedFontIds:[],previewFamilies:{},nativePreviewImages:{},failedPreviewFontIds:{},loadingFonts:{current:new Set()},isBadFontRecord:f=>f.fileSize<64||!!f.previewError?.includes('路径已失效'),setPreviewFamilies(){},setFailedPreviewFontIds(){},setNativePreviewImages(fn){this.nativePreviewImages=fn(this.nativePreviewImages)},updateFont(_id,fn){saved=fn(saved)},hfm:{getCachedPreviewImage:async()=> 'data:image/png;base64,old',renderPreviewImage:async()=>{rendererCalls++;if(failureKind)throw Error('[HFM_PREVIEW:'+failureKind+']');return 'data:image/png;base64,new'}}};
 const renderer=rendererLoad('src/renderer/src/runtime/preview/queue/fontPreviewLoadRuntime.ts').createFontPreviewLoadRuntime(rendererOptions);
 for(const kind of ['missing','timeout','unavailable','failed','cancelled']) {failureKind=kind;now+=30001;await renderer.ensurePreviewFont(saved);assert.equal(saved.previewError,'字体文件不存在或路径已失效。');assert.equal(Object.keys(rendererOptions.nativePreviewImages).length,0);}
 failureKind='';now+=30001;await renderer.ensurePreviewFont(saved);assert.equal(saved.previewError,undefined,'confirmed success did not repair the legacy flag');assert.equal(saved.previewDisabled,false);assert.equal(rendererCalls,6,'legacy flag or cached image blocked authoritative recheck');
 const beforeBad=rendererCalls;await renderer.ensurePreviewFont({...saved,id:'bad',fileSize:1});assert.equal(rendererCalls,beforeBad,'structurally bad font bypassed admission');
 console.log('PASS S10-03 source classification, no negative image cache, failed/missing index recovery, restart, corrupt PNG, bounded failed generation');
}
run().catch(e=>{console.error(e);process.exitCode=1});
