#!/usr/bin/env node
const cardToken = (text, size, mode = 'list') => require('./check-operation-chain.cjs').loader()('src/shared/preview-layout/previewTextFitRuntime.ts').getCardPreviewLayout(mode, text, size).token;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loader: baseLoader } = require('./check-operation-chain.cjs');
const { spawnSync } = require('node:child_process');
const mutant = process.argv.find(x=>x.startsWith('--mutant='))?.slice(9);
function loader(mocks={},globals={},transforms={}) {
 const mutations = {
  physical: ['src/main/path/ioDeadlineRuntime.ts', 'finally { while (pending.size) await Promise.allSettled([...pending]) }', 'finally {}'],
  counter: ['src/renderer/src/runtime/preview/queue/fontPreviewStateRuntime.ts', '    options.previewQueue.current = []', '    options.activePreviewLoads.current = 0; options.previewQueue.current = []'],
  webfont: ['src/renderer/src/runtime/preview/queue/fontPreviewQuickFallbackRuntime.ts', 'if (active >= limit)', 'if (false)']
 };
 if (mutant) {
  const [file,from,to]=mutations[mutant], full=path.join(root,file), existing=transforms[full];
  transforms={...transforms,[full]:source=>{source=existing?existing(source):source;assert(source.includes(from),'mutation anchor missing');return source.replace(from,to)}};
 }
 return baseLoader(mocks,globals,transforms);
}
const root = path.resolve(__dirname, '../..');
const deferred = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<100;i++) await Promise.resolve(); };
function clock() {
 const timers=new Map();let sequence=0;
 const setTimeout=(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence};
 const clearTimeout=id=>timers.delete(id);
 const fire=ms=>{for(const [id,t] of [...timers])if(t.ms===ms){timers.delete(id);t.fn()}};
 return {timers,setTimeout,clearTimeout,fire};
}
async function mainQueue() {
 const time=clock(), physical=deferred();let calls=0,peak=0,active=0;
 const load=loader({'../../path/sharedFileSystemRuntime':{sharedFileSystem:{}}},{...time,AbortController});
 const deadlines=load('src/main/path/ioDeadlineRuntime.ts');
 const scheduler=load('src/main/preview/runtime/previewRequestSchedulerRuntime.ts').createPreviewRequestSchedulerRuntime({readCachedPreviewImages:async()=>{
  calls++;peak=Math.max(peak,++active);
  try { const result=await deadlines.withIoDeadlineResult('nested',()=>physical.promise,100);return result.ok?result.value:{}; }
  finally {active--}
 }});
 const a=new AbortController(),b=new AbortController();
 const first=scheduler.readCachedPreviewImages([{id:'a'}],'text',34,520,150,a.signal);
 const second=scheduler.readCachedPreviewImages([{id:'a'}],'text',34,520,150,b.signal);
 time.fire(32);await flush();a.abort();assert.deepEqual({...await first},{});assert.equal(calls,1);
 // One cancellation must not end the second caller. Nested logical timeout must
 // not release the scheduler's physical slot for a different text generation.
 let secondDone=false;second.then(()=>secondDone=true);await flush();assert.equal(secondDone,false);
 time.fire(100);await flush();
 for(let i=0;i<12;i++){void scheduler.readCachedPreviewImages([{id:'x'+i}],String(i),34,520,150);time.fire(32);await flush();}
 time.fire(2000);await flush();assert.equal(calls,1);assert.equal(peak,1);assert.deepEqual({...await second},{});
 physical.resolve({a:'late'});await flush();assert.equal(calls,1,'expired queued work started after old physical completion');
 scheduler.cancelPending();assert.equal(time.timers.size,0);
 // Successful shared result after only one cancellation.
 const gate=deferred();let sharedCalls=0;
 const shared=load('src/main/preview/runtime/previewRequestSchedulerRuntime.ts').createPreviewRequestSchedulerRuntime({readCachedPreviewImages:()=>{sharedCalls++;return gate.promise}});
 const c=new AbortController();const one=shared.readCachedPreviewImages([{id:'same'}],'same',34,520,150,c.signal);const two=shared.readCachedPreviewImages([{id:'same'}],'same',34,520,150);
 time.fire(32);await flush();c.abort();gate.resolve({same:'image'});assert.deepEqual({...await one},{});assert.equal((await two).same,'image');assert.equal(sharedCalls,1);shared.cancelPending();
 // Shared I/O transport can reject before its child exits. closed owns the slot.
 const closed=deferred();let done=false;
 const scoped=deadlines.withPhysicalIoCompletion(()=>deadlines.withIoDeadlineResult('closed',()=>Promise.reject({closed:closed.promise}),100)).then(()=>done=true);
 await flush();assert.equal(done,false);closed.resolve();await scoped;assert.equal(done,true);
 console.log('main: 12 expired generations keep one physical batch; nested deadline/child close retained; one shared caller cancels independently');
}
async function cacheAbort() {
 const time=clock(),gate=deferred();let calls=0,aborted=false;
 const load=loader({'../../path/sharedFileSystemRuntime':{sharedFileSystem:{readFile:(_p,{signal})=>{calls++;signal.addEventListener('abort',()=>aborted=true);return gate.promise}}}},{...time,AbortController});
 const p=load('src/main/preview/runtime/previewCachedImageReadBatchRuntime.ts').readCachedPreviewImageDataUris([{id:'a',outputPath:'/a'},{id:'b',outputPath:'/b'}],1,{readTimeoutMs:100});
 await flush();time.fire(100);await flush();assert.equal(aborted,true);assert.equal(calls,1,'abort requested but unsettled read released worker');gate.resolve(Buffer.from('invalid'));await p;assert.equal(calls,2);
 console.log('cache: deadline signals the owned read; a still-running abort retains the worker');
}
function rendererHarness(limit = 5) {
 const time=clock(),ref=current=>({current}),faces=[],native=[],applied=[];
 class FontFace {constructor(family,source){this.family=family;this.source=source;this.gate=deferred();faces.push(this)}load(){return this.gate.promise.then(()=>this)}}
 const opt={previewText:'text',listPreviewFontSize:44,previewRequestTokenRef:ref(cardToken('text', 44)),selectedFontId:'',selectedFontIds:[],previewFamilies:{},nativePreviewImages:{},failedPreviewFontIds:{},loadingFonts:ref(new Set()),queuedPreviewFontIds:ref(new Set()),previewQueue:ref([]),activePreviewLoads:ref(0),fontListScrollingRef:ref(false),isBadFontRecord:()=>false,rendererUserActive:()=>false,
 setPreviewFamilies(fn){this.previewFamilies=typeof fn==='function'?fn(this.previewFamilies):fn},setNativePreviewImages(fn){this.nativePreviewImages=typeof fn==='function'?fn(this.nativePreviewImages):fn;applied.push({...this.nativePreviewImages})},setFailedPreviewFontIds(fn){this.failedPreviewFontIds=typeof fn==='function'?fn(this.failedPreviewFontIds):fn},setNativeDetailImage(){},updateFont(){},setStatus(){},autoPreviewCacheRunId:ref(0),autoPreviewCacheQueue:ref([]),queuedAutoPreviewCacheIds:ref(new Set()),activeAutoPreviewCacheLoads:ref(0),autoPreviewCacheStats:ref({}),
 hfm:{getCachedPreviewImages:async()=>({}),getCachedPreviewImage:async()=>'',toFontUrl:async p=>'hfm-font://local/'+p,renderPreviewImage:async f=>{native.push(f.id);return 'data:image/png;base64,'+f.id}}
 };
 const quickPath=path.join(root,'src/renderer/src/runtime/preview/queue/fontPreviewQuickFallbackRuntime.ts');
 const attached=[];
 const load=loader({'../../../appRuntime':{PREVIEW_STATE_LRU_LIMIT:800,pruneRecordByKeyLimit:x=>x,requestIdleWindow:f=>time.setTimeout(f,0),rendererMemoryPressure:()=> 'normal',INDEXING_PREVIEW_LOADS:1,SCROLLING_PREVIEW_LOADS:1,MAX_CONCURRENT_PREVIEW_LOADS:limit},'../../../rendererPerformance':{reportRendererTrace(){}},'./fontPreviewIndexCooldownRuntime':{previewQueueCooldownRemaining:()=>0}}, {window:time,FontFace,document:{fonts:{add:f=>attached.push(f)}},AbortController},{[quickPath]:s=>s.replaceAll('import.meta.env','({})')});
 const availability=load('src/renderer/src/runtime/preview/previewAvailabilitySnapshotRuntime.ts');
 const stamp=g=>availability.rememberPreviewAvailability({roots:[{path:'C:/fonts',rootId:'c:/fonts',generation:g,state:'online',resourceKeys:[],tags:[]}],tags:[],unattributedTags:[]});stamp(1);
 const runtime=load('src/renderer/src/runtime/preview/fontPreviewQueueRuntime.ts').createFontPreviewQueueRuntime(opt);
 return {time,opt,faces,native,applied,attached,load,runtime,stamp};
}
async function renderer() {
 const h=rendererHarness(),{runtime:r,opt,time,faces,attached}=h;
 const font={id:'web',path:'C:/fonts/web.ttf',fileSize:100,modifiedAt:1};
 let p=r.ensurePreviewFont(font,true);await flush();assert.equal(faces.length,1);time.fire(180);await p;assert.equal(opt.failedPreviewFontIds.web,undefined,'deadline was classified as a malformed font');assert.equal(attached.length,0);
 faces[0].gate.resolve();await flush();assert.equal(attached.length,0,'late face attached without a current caller');
 opt.previewText='new text';opt.previewRequestTokenRef.current=cardToken('new text', 44);r.resetPreviewRuntimeState();await r.ensurePreviewFont(font,true);assert.equal(faces.length,1,'text edit downloaded the same authorized face again');assert.equal(opt.previewFamilies.web,'HFM_web');assert.equal(attached.length,1);
 // A changed root generation cannot reuse a previous physical load.
 opt.previewFamilies={};r.resetPreviewRuntimeState();h.stamp(2);p=r.ensurePreviewFont(font,true);await flush();assert.equal(faces.length,2);faces[1].gate.reject(Error('invalid font'));await p;assert.equal(opt.failedPreviewFontIds.web,true);
 // More edits than the physical WebFont limit: timeout is not slot release.
 for(let i=0;i<14;i++){opt.previewText='edit'+i;opt.previewRequestTokenRef.current=cardToken(opt.previewText, 44);r.resetPreviewRuntimeState();p=r.ensurePreviewFont({id:'f'+i,path:'C:/fonts/'+i+'.ttf',fileSize:100},true);await flush();time.fire(180);await p;}
 assert.equal(faces.length,12,'physical FontFace cap was bypassed across reset');
 for(const f of faces.slice(2))f.gate.resolve();await flush();
 r.disposePreviewQueue();assert.equal(time.timers.size,0);
 const closing=rendererHarness();const waiting=closing.runtime.ensurePreviewFont(font,true);await flush();assert(closing.time.timers.size>0);closing.runtime.disposePreviewQueue();await waiting;assert.equal(closing.time.timers.size,0,'close retained a WebFont UI deadline');closing.faces[0].gate.resolve();await flush();assert.equal(closing.attached.length,0);
 // Native IPC lifetime is also bounded across generations; stale results ignored.
 const n=rendererHarness(),gate=deferred();let nativeCalls=0;
 n.opt.hfm.renderPreviewImage=()=>{nativeCalls++;return gate.promise};
 const nativeFont={id:'native',path:'C:/fonts/native.ttf',systemInstalled:true};
 n.runtime.requestPreviewFont(nativeFont,'high');await flush();assert.equal(nativeCalls,1);
 for(let i=0;i<15;i++){n.opt.previewText='change'+i;n.opt.previewRequestTokenRef.current=cardToken(n.opt.previewText, 44);n.runtime.resetPreviewRuntimeState();n.runtime.requestPreviewFont({...nativeFont,id:'n'+i},'high');await flush();}
 assert.equal(nativeCalls,5);assert.equal(n.opt.activePreviewLoads.current,5);n.runtime.disposePreviewQueue();gate.resolve('data:image/png;base64,old');await flush();assert.equal(n.opt.activePreviewLoads.current,0);assert.deepEqual({...n.opt.nativePreviewImages},{});assert.equal(n.time.timers.size,0);
 // Old-generation cleanup must not revoke the same font's newer live owner.
 const latest=rendererHarness(),oldResult=deferred(),newResult=deferred();let version=0;
 latest.opt.hfm.renderPreviewImage=()=>++version===1?oldResult.promise:newResult.promise;
 latest.runtime.requestPreviewFont(nativeFont,'high');await flush();latest.opt.previewText='latest';latest.opt.previewRequestTokenRef.current=cardToken('latest', 44);latest.runtime.resetPreviewRuntimeState();latest.runtime.requestPreviewFont(nativeFont,'high');await flush();assert.equal(version,2);
 oldResult.resolve('data:image/png;base64,old');await flush();assert.equal(latest.opt.loadingFonts.current.has(nativeFont.id),true);newResult.resolve('data:image/png;base64,newest');await flush();assert.equal(latest.opt.nativePreviewImages.native,'data:image/png;base64,newest');latest.runtime.disposePreviewQueue();
 // Two card consumers share a request; leaving one does not invalidate the other.
 const c=rendererHarness(),cg=deferred();let ca=true,cb=true,cc=0;
 c.opt.hfm.renderPreviewImage=()=>{cc++;return cg.promise};c.runtime.requestPreviewFont(nativeFont,'high',()=>ca);c.runtime.requestPreviewFont(nativeFont,'high',()=>cb);await flush();ca=false;cg.resolve('data:image/png;base64,current');await flush();assert.equal(cc,1);assert.equal(c.opt.nativePreviewImages.native,'data:image/png;base64,current');
 c.opt.activePreviewLoads.current=5;let visible=true;c.runtime.requestPreviewFont({...nativeFont,id:'off'},'normal',()=>visible);visible=false;c.opt.activePreviewLoads.current=0;c.runtime.processPreviewQueue();await flush();assert.equal(cc,1);assert.equal(c.opt.previewQueue.current.length,0);c.runtime.disposePreviewQueue();
 console.log('renderer: timeout/format split, late authorized reuse, root-generation isolation, 14 WebFont edits capped at 10, 15 native edits capped at 5, two consumers/leave/dispose');
}
async function background() {
 const h=rendererHarness(),{runtime:r,opt,time}=h, status=deferred(),work=deferred();let queries=0,calls=0;
 opt.hfm.getPreviewCacheStatus=()=>{queries++;return queries===1?status.promise:Promise.resolve({})};
 opt.hfm.ensurePreviewCache=()=>{calls++;return work.promise};
 const fonts=Array.from({length:8},(_,i)=>({id:'auto'+i,path:'C:/fonts/'+i+'.ttf'}));
 const old=r.startAutoPreviewCache(fonts);await flush();await r.startAutoPreviewCache([fonts[0]]);await r.startAutoPreviewCache(fonts.slice(2));assert.equal(queries,1);
 status.reject(Error('obsolete'));await old;await flush();assert.equal(queries,2);assert.equal(calls,5);assert.equal(opt.activeAutoPreviewCacheLoads.current,5);
 r.resetPreviewRuntimeState();await r.startAutoPreviewCache(fonts);assert.equal(calls,5,'reset released background native slots');
 opt.rendererUserActive=()=>true;r.processAutoPreviewCacheQueue();r.processAutoPreviewCacheQueue();assert.equal(time.timers.size,1);
 r.disposePreviewQueue();assert.equal(time.timers.size,0);
work.resolve({ok:true,cached:false});await flush();assert.equal(opt.activeAutoPreviewCacheLoads.current,0);assert.equal(calls,5);assert.equal(opt.autoPreviewCacheQueue.current.length,0);
 console.log('background: latest status intent coalesced, stale rejection ignored, active slots preserved, one retry timer disposed');
}
async function prefetch() {
 const effects=[],demands=[],fonts=[{id:'a'},{id:'b',__earlyVisible:true}],ref=current=>({current});
 const load=loader({react:{useEffect:fn=>effects.push(fn),useLayoutEffect(){},useMemo:fn=>fn()},'../../appRuntime':{PREVIEW_PREFETCH_LIMIT:18,traceRendererSyncComputation:(_l,_d,fn)=>fn()},'../../fontViewRuntime':{buildVirtualLayout:()=>({items:fonts}),buildTagSuggestions:()=>[]},'./useBrowseDerivedRuntime':{useBrowseDerivedRuntime:()=>({visibleFonts:fonts,fontMetrics:{}})}});
 load('src/renderer/src/runtime/app/useAppFontDerivedRuntime.ts').useAppFontDerivedRuntime({cardPoolViewLayout:{},virtualViewport:{},selectedFontIds:[],previewFamilies:{},nativePreviewImages:{},failedPreviewFontIds:{},latestVisibleFontsRef:ref([]),latestViewLayoutRef:ref({}),requestPreviewFont:(f,_p,current)=>demands.push({f,current}),contextFontTargets:()=>[],library:{fonts:{},previewText:'text'}});
 assert.equal(effects.length,0);assert.equal(demands.length,0);
 console.log('prefetch: derived layout emits no offscreen or first-18 preview requests');
}
async function detail() {
 const time=clock();let effect,requests=0,writes=0;
 const load=loader({react:{useEffect:fn=>effect=fn}},{window:time});
 const hook=load('src/renderer/src/runtime/app/useFontDetailNativePreviewRuntime.ts').useFontDetailNativePreviewRuntime;
 const gate=deferred();const args={hfm:{getCachedPreviewImage:()=>{requests++;return gate.promise},renderPreviewImage:async()=>{requests++;return 'native'}},detailVisible:true,selectedFont:{id:'a',previewDisabled:true},selectedFailedPreview:true,selectedNativePreviewImage:'',previewText:'text',requestSeqRef:{current:0},setNativeDetailImage:()=>writes++,isBadFontRecord:()=>false};
 hook(args);effect();time.fire(180);await flush();assert.equal(requests,0);
 hook({...args,previewConsumerEnabled:true});const cleanup=effect();time.fire(180);await flush();assert.equal(requests,1);cleanup();const before=writes;gate.resolve('old');await flush();assert.equal(writes,before);assert.equal(requests,1);assert.equal(time.timers.size,0);
 const panel=fs.readFileSync(path.join(root,'src/renderer/src/components/app/FontDetailPanel.tsx'),'utf8');
 assert.equal((panel.match(/nativeDetailImage/g)||[]).length,2,'detail consumer changed: re-audit producer gate');
 console.log('detail: no-consumer default emits zero IO; opted-in pending work cannot commit after unmount');
}
module.exports = { rendererHarness, deferred, flush, clock };
if (require.main === module) (async()=>{
 await mainQueue();await cacheAbort();await renderer();await detail();await background();await prefetch();
 if (!mutant) for(const [name,needle] of Object.entries({physical:'1',counter:'5',webfont:'physical FontFace cap'})) {
  const result=spawnSync(process.execPath,[__filename,'--mutant='+name],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/AssertionError/);assert(result.stderr.includes(needle),result.stderr);
 }
 if (!mutant) console.log('three lifetime regressions rejected by behavior assertions');
})().catch(e=>{console.error(e);process.exitCode=1});
