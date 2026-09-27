#!/usr/bin/env node
const assert = require('node:assert/strict');
const { loader } = require('./check-operation-chain.cjs');
const { rendererHarness, deferred, flush } = require('./check-preview-work-lifetime.cjs');
const constants = loader()('src/renderer/src/constants/previewConstants.ts');
async function viewport() {
 const h = rendererHarness(constants.MAX_CONCURRENT_PREVIEW_LOADS), { opt, runtime:r } = h;
 const work = []; let active=0, peak=0, oldVisible=true;
 opt.rendererUserActive=()=>true; opt.indexingActive=true;
 opt.hfm.renderPreviewImage=font=>{const gate=deferred();active++;peak=Math.max(peak,active);work.push({font,gate});return gate.promise.finally(()=>active--)};
 const font=i=>({id:String(i),path:'\\\\nas\\fonts\\'+i+'.ttf',systemInstalled:true});
 for(let i=0;i<24;i++)r.requestPreviewFont(font(i),'high',()=>oldVisible);
 await flush(); assert.equal(work.length,10);assert.equal(opt.activePreviewLoads.current,10);
 r.pausePreviewForScroll();opt.fontListScrollingRef.current=true;oldVisible=false;
 for(let i=24;i<48;i++)r.requestPreviewFont(font(i),'high',()=>true);
 r.processPreviewQueue();await flush();assert.equal(work.length,10,'scroll admitted new work');
 for(const w of work)w.gate.resolve('data:image/png;base64,old');await flush();
 assert.equal(opt.activePreviewLoads.current,0);assert.deepEqual({...opt.nativePreviewImages},{});assert.equal(work.length,10);
 opt.fontListScrollingRef.current=false;r.resumePreviewAfterScroll();await flush();assert.equal(work.length,20);
 // Each completion replenishes a slot; every one of the 24 visible cards is served.
 let cursor=10;
 while(cursor<work.length){const w=work[cursor++];w.gate.resolve('data:image/png;base64,'+w.font.id);await flush();assert(active<=10)}
 assert.equal(peak,10);assert.equal(work.length,34);assert.equal(Object.keys(opt.nativePreviewImages).length,24);
 assert(work.slice(10).every(w=>Number(w.font.id)>=24),'offscreen work resumed');
 r.disposePreviewQueue();assert.equal(h.time.timers.size,0);
 console.log('viewport: network+active+indexing fills 10; scroll stops admission and stale commits; all 24 current cards finish');
}
async function debounce() {
 let now=0,sequence=0,paused=0,resumed=0;const timers=new Map();
 const window={setTimeout:(fn,ms)=>{timers.set(++sequence,{fn,at:now+ms});return sequence},clearTimeout:id=>timers.delete(id)};
 const advance=ms=>{now+=ms;for(const[id,t]of[...timers])if(t.at<=now){timers.delete(id);t.fn()}};
 const load=loader({react:{useState:value=>[value,()=>{}],useRef:current=>({current}),useEffect(){}},'../preview/fontPreviewQueueRuntime':{createFontPreviewQueueRuntime:()=>({pausePreviewForScroll:()=>paused++,resumePreviewAfterScroll:()=>resumed++,processAutoPreviewCacheQueue(){}})},'./effects/usePreviewTextResetRuntime':{usePreviewTextResetRuntime(){}}},{window});
 const controller=load('src/renderer/src/runtime/app/usePreviewController.ts').usePreviewController({previewText:'text',listPreviewFontSize:44});
 assert.equal(constants.PREVIEW_SCROLL_IDLE_MS,150);
 controller.beginFontListScroll(constants.PREVIEW_SCROLL_IDLE_MS);advance(149);assert.equal(resumed,0);
 controller.beginFontListScroll(constants.PREVIEW_SCROLL_IDLE_MS);advance(149);assert.equal(resumed,0);assert.equal(paused,1);
 advance(1);assert.equal(resumed,1);assert.equal(controller.isFontListScrolling(),false);assert.equal(timers.size,0);
 controller.beginFontListScroll(constants.PREVIEW_SCROLL_IDLE_MS);assert.equal(paused,2);controller.clearFontListScrollIdleTimer();advance(150);assert.equal(resumed,1);assert.equal(controller.isFontListScrolling(),false,'cancelled exit must not leave scrolling latched');
 console.log('controller: each scroll renews 150ms; 149ms stays paused; one invalidation per gesture; teardown cancels resume');
}
async function mainBudget() {
 const load=loader(), gate=deferred();let active=0,peak=0;
 const scheduler=load('src/main/performance/ioScheduler.ts').createIoScheduler({idleConcurrency:4,indexingConcurrency:2,networkConcurrency:1,hddConcurrency:2,ssdConcurrency:4,nvmeConcurrency:4,removableConcurrency:1,sqliteWriteConcurrency:1,localScanWorkers:2,isIndexingActive:()=>true,isUserActive:()=>true,storageProfileForPath:()=>({type:'network'})});
 const jobs=Array.from({length:24},()=>scheduler.withGlobalIo('preview:render',async()=>{peak=Math.max(peak,++active);await gate.promise;active--},{storagePath:'\\\\nas\\fonts'}));
 await flush();assert.equal(active,10);assert.equal(scheduler.snapshot().lanes.network.concurrency,1);assert.equal(scheduler.snapshot().lanes.sqlite.concurrency,1);
 gate.resolve();await Promise.all(jobs);assert.equal(peak,10);
 const rust=loader({}, {process:{env:{}}})('src/main/rust-core/rustPreviewRenderConcurrencyRuntime.ts');
 assert.equal(rust.previewRenderConcurrency(),10);assert.equal(rust.normalizePreviewRenderConcurrency('--preview-render-image',1),10);assert.equal(rust.normalizePreviewRenderConcurrency('--preview-cache-status',1),1);assert.equal(rust.previewRenderGlobalConcurrencyFloor(),11);
 console.log('main: 10 physical render promises; background network/cache budgets remain 1; worker profile cannot lower render to 1');
}
(async()=>{await viewport();await debounce();await mainBudget()})().catch(error=>{console.error(error);process.exitCode=1});
