#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function loader(mocks = {}) {
    const cache = new Map();
    function load(file) {
        file = path.resolve(root, file);
        if (cache.has(file))
            return cache.get(file).exports;
        const module = { exports: {} };
        cache.set(file, module);
        const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
        new Function('require', 'module', 'exports', code)(id => {
            if (Object.hasOwn(mocks, id))
                return mocks[id];
            if (id.startsWith('node:'))
                return require(id);
            if (!id.startsWith('.') && !id.startsWith('@shared/'))
                throw Error(`Unmocked ${id}`);
            const target = id.startsWith('@shared/') ? path.join(root, 'src/shared', id.slice(8)) : path.resolve(path.dirname(file), id);
            return load(target + '.ts');
        }, module, module.exports);
        return module.exports;
    }
    return load;
}
async function run() {
 const trace = { previewTrace: () => undefined, previewEvent: () => {}, previewImageTrace: () => undefined, previewTraceEnabled: () => false };
 let timers = [], loads = [], finish = [], resizing = false, resizeCallbacks = [], peak = 0;
 global.window = { setTimeout: f => (timers.push(f), timers.length), clearTimeout: () => {} };
 const ref = current => ({current});
 const opt = { previewFamilies: {}, nativePreviewImages: {}, failedPreviewFontIds: {}, loadingFonts: ref(new Set()), queuedPreviewFontIds: ref(new Set()), previewQueue: ref([]), activePreviewLoads: ref(0), fontListScrollingRef: ref(false), previewText:'abc', listPreviewFontSize:44, isBadFontRecord:f=>!!f.previewDisabled, rendererUserActive:()=>true };
 Object.assign(opt, {
  autoPreviewCacheQueue:ref([]), queuedAutoPreviewCacheIds:ref(new Set()), activeAutoPreviewCacheLoads:ref(0), autoPreviewCacheStats:ref({}),
  setFailedPreviewFontIds:value=>{opt.failedPreviewFontIds=value;}, setNativePreviewImages:value=>{opt.nativePreviewImages=value;}, setNativeDetailImage:()=>{}
 });
 const queueLoad = loader({
  '../previewTraceRuntime':trace,
  '../../../appRuntime':{ requestIdleWindow:f=>(timers.push(f),timers.length), rendererMemoryPressure:()=> 'normal', INDEXING_PREVIEW_LOADS:1, SCROLLING_PREVIEW_LOADS:1, MAX_CONCURRENT_PREVIEW_LOADS:4 },
  './fontPreviewIndexCooldownRuntime':{previewQueueCooldownRemaining:()=>0},
  './fontPreviewNetworkPathRuntime':{networkAwarePreviewLimit:(_,v)=>v,hasNetworkFontPath:()=>false},
  './fontPreviewRouteRuntime':{resolveFontPreviewRoute:()=>({shouldSkipWebFontFileLoad:false})}
 });
 const state = queueLoad('src/renderer/src/runtime/preview/queue/fontPreviewStateRuntime.ts').createFontPreviewStateRuntime(opt);
 const queue = queueLoad('src/renderer/src/runtime/preview/queue/fontVisiblePreviewQueueRuntime.ts').createFontVisiblePreviewQueueRuntime(opt,state,{
  loadCachedNativeCardPreviews:async()=>new Set(), resetPreviewLoads:()=>{},
  ensurePreviewFont:f=>{peak=Math.max(peak,opt.activePreviewLoads.current);loads.push([f.id,opt.previewText,opt.listPreviewFontSize]);opt.loadingFonts.current.add(f.id);return new Promise(r=>finish.push(()=>{opt.loadingFonts.current.delete(f.id);opt.nativePreviewImages[f.id]='image';r();}));}
 });
 const flush = async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
 const font={id:'promote'};
 queue.requestPreviewFont(font,'normal');queue.requestPreviewFont(font,'high');queue.requestPreviewFont(font,'high');
 assert.equal(opt.previewQueue.current.length,1);assert.equal(opt.previewQueue.current[0].priority,'high');
 await flush();assert.equal(loads.length,1);queue.requestPreviewFont(font,'high');assert.equal(opt.previewQueue.current.length,0);
 finish.splice(0).forEach(f=>f());await flush();
 for(const [id,setup] of [['family',()=>opt.previewFamilies.family='loaded'],['image',()=>opt.nativePreviewImages.image='png'],['loading',()=>opt.loadingFonts.current.add('loading')],['bad',()=>{}]]) {
  setup();queue.requestPreviewFont({id,previewDisabled:id==='bad'},'high');assert(!opt.queuedPreviewFontIds.current.has(id));
 }
 assert.equal(state.canRequestPreviewFont({id:'queued'}),true);
 opt.queuedPreviewFontIds.current.add('queued');
 assert.equal(state.canRequestPreviewFont({id:'queued'}),false);
 assert.equal(state.canRequestPreviewFont({id:'queued'},true),true);
 assert.equal(state.canRequestPreviewFont({id:'queued',previewDisabled:true},true),false);
 opt.queuedPreviewFontIds.current.delete('queued');
 // Stable callbacks and FontItem objects: run the actual FontCard effects, including cleanup.
 let active, observers=[];
 global.IntersectionObserver=class {constructor(cb){this.cb=cb;this.off=false;observers.push(this);}observe(){}disconnect(){this.off=true;}emit(visible=true){this.cb([{isIntersecting:visible}]);}};
 const react={memo:f=>f,useMemo:f=>f(),useRef:v=>{let i=active.pos++;return active.slots[i]??=ref(v);},useEffect:(f,deps)=>{let i=active.pos++,old=active.slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))active.effects.push(()=>{old?.cleanup?.();active.slots[i]={deps,cleanup:f()};});}};
 let availability={roots:[],tags:[],unattributedTags:[]};
 const cardLoad=loader({react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
 '../sharedAvailabilityRuntime':{useSharedAvailability:()=>availability},
 '../runtime/preview/previewTraceRuntime':trace,
 '../appRuntime':{fontDisplayName:()=>'',fontFileDisplayName:()=>'',formatSize:()=>'',installLabel:()=>'',isInstalled:()=>false,scriptLabels:{}},
 '../runtime/preview/fontPreviewCssFamilyRuntime':{buildListPreviewCssFamily:()=>''},
 '../runtime/preview/useResizeFrozenPreviewRuntime':{useResizeFrozenPreviewRuntime:(_id,v)=>v},
 '../runtime/preview/gridNativePreviewImageTrimRuntime':{useGridNativePreviewImageTrim:()=>undefined},
 '../runtime/preview/gridPreviewVisualFitRuntime':{useGridPreviewVisualFitText:()=>({fittedText:'sample',visualFitRef:ref(null),visualFitActive:false})},
 '../runtime/app/windowResizePhaseRuntime':{isWindowResizeActive:()=>resizing,subscribeWindowResizeSettled:f=>(resizeCallbacks.push(f),()=>{})}
 });
 const Card=cardLoad('src/renderer/src/components/FontCard.tsx').FontCard;
 const cards=Array.from({length:24},(_,i)=>({font:{id:'card'+i,path:'C:/fonts/'+i+'.ttf'},slots:[],onVisible(){queue.requestPreviewFont(this.font,'high');}}));
 cards.forEach(c=>c.onVisible=c.onVisible.bind(c));
 function render(c,text,size,image,early=false){active=c;c.pos=0;c.effects=[];c.font.__earlyVisible=early;const tree=Card({font:c.font,closingLifecycle:c.closingLifecycle,onVisible:c.onVisible,compact:true,previewText:text,listPreviewFontSize:size,previewImage:image});tree.props.ref.current={};c.effects.forEach(f=>f());}
 function emit(){observers.filter(o=>!o.off).forEach(o=>o.emit());}
 async function drain(){for(let i=0;i<40;i++){await flush();finish.splice(0).forEach(f=>f());}await flush();assert.equal(opt.previewQueue.current.length,0);assert.equal(opt.activePreviewLoads.current,0);}
 for(const [text,size] of [['abc',44],['changed',44],['changed',64],['final',48]]) {
  cards.forEach(c=>opt.nativePreviewImages[c.font.id]='old');
  opt.previewText=text;opt.listPreviewFontSize=size;
  cards.forEach(c=>render(c,text,size,'old'));emit(); // Callback before reset must not strand cards.
  queue.resetVisiblePreviewQueue();state.resetPreviewRuntimeState();
  cards.forEach(c=>render(c,text,size,undefined));emit();emit();
  await drain();
  const generation=loads.filter(x=>x[1]===text&&x[2]===size&&x[0].startsWith('card'));
  assert.equal(generation.length,24);assert.equal(new Set(generation.map(x=>x[0])).size,24);
 }
 const c=cards[0];opt.nativePreviewImages={};render(c,'offscreen',48,undefined);const old=observers.at(-1);old.emit(false);assert.equal(opt.previewQueue.current.length,0);
 resizing=true;old.emit();old.emit(false);resizeCallbacks.splice(0).forEach(f=>f());assert.equal(opt.previewQueue.current.length,0,'resize callback requested an offscreen card');
 old.emit();c.slots.forEach(s=>s?.cleanup?.());old.emit();resizeCallbacks.splice(0).forEach(f=>f());assert.equal(opt.previewQueue.current.length,0,'unmounted callback requested stale work');
 resizing=false;c.slots=[];render(c,'remount',48,undefined,true);emit();await drain();
 opt.nativePreviewImages={};render(c,'remount',48,undefined,false);emit();await drain();assert(loads.filter(x=>x[0]===c.font.id).length>=6);
 opt.fontListScrollingRef.current=true;opt.rendererUserActive=()=>false;queue.requestPreviewFont({id:'scroll'},'normal');queue.processPreviewQueue();await flush();assert(!loads.some(x=>x[0]==='scroll'));
 opt.fontListScrollingRef.current=false;queue.processPreviewQueue();await drain();assert(loads.some(x=>x[0]==='scroll'));
 assert(peak <= 4, 'preview concurrency exceeded existing limit');
 const before=loads.length;opt.previewFamilies[c.font.id]='webfont';render(c,'webfont text',72,undefined);emit();await drain();assert.equal(loads.length,before,'loaded WebFont was reloaded');
 opt.previewFamilies={};opt.nativePreviewImages={};render(c,'obsolete',72,undefined);const obsolete=observers.at(-1);render(c,'newest',80,undefined);obsolete.emit();assert.equal(opt.previewQueue.current.length,0,'old text callback survived cleanup');
 // Retry ownership: only intersecting cards, three retries with backoff; cleanup/root block cancels.
 const priorTimers={setTimeout:window.setTimeout,clearTimeout:window.clearTimeout};let timerId=10000;const pendingTimers=new Map();
 window.setTimeout=(fn,delay)=>{pendingTimers.set(++timerId,{fn,delay});return timerId;};window.clearTimeout=id=>pendingTimers.delete(id);
 let visibleCalls=0;const closingLifecycle=cardLoad('src/renderer/src/runtime/app/rendererClosingLifecycleRuntime.ts').createRendererClosingLifecycleRuntime();const retryCard={closingLifecycle,font:{id:'retry',path:'C:/fonts/retry.ttf'},slots:[],onVisible:()=>visibleCalls++};
 render(retryCard,'retry',44,undefined);let retryObserver=observers.at(-1);retryObserver.emit();assert.equal(visibleCalls,1);
 const fire=()=>{const [id,timer]=pendingTimers.entries().next().value;pendingTimers.delete(id);timer.fn();return timer.delay;};
 assert.equal(fire(),31000);assert.equal(visibleCalls,2);retryObserver.emit(false);assert.equal(pendingTimers.size,0);
 retryObserver.emit();assert.equal(fire(),61000);assert.equal(fire(),121000);assert.equal(visibleCalls,4);assert.equal(pendingTimers.size,0);
 render(retryCard,'changed',44,undefined);retryObserver=observers.at(-1);retryObserver.emit();assert.equal(pendingTimers.size,1);
 availability={roots:[{path:'C:/fonts',rootId:'C:/fonts',state:'offline',generation:2,tags:[]}],tags:[],unattributedTags:[]};
 render(retryCard,'changed',44,undefined);assert.equal(pendingTimers.size,0);const countBefore=visibleCalls;retryObserver.emit();assert.equal(visibleCalls,countBefore);
 availability={roots:[],tags:[],unattributedTags:[]};render(retryCard,'changed',44,undefined);observers.at(-1).emit();assert.equal(visibleCalls,countBefore+1);
 closingLifecycle.beginClosing();assert.equal(pendingTimers.size,0,'closing retained retry timer');const beforeClosing=visibleCalls;observers.at(-1).emit();assert.equal(visibleCalls,beforeClosing);closingLifecycle.resume();assert.equal(pendingTimers.size,1,'cancelled close did not resume visible retry');
 retryCard.slots.forEach(slot=>slot?.cleanup?.());assert.equal(pendingTimers.size,0);Object.assign(window,priorTimers);
 // Exercise production load generation guards with an old success arriving after the new image.
 const actualLoad = require('./check-operation-chain.cjs').loader({
  '../../../appRuntime':{PREVIEW_STATE_LRU_LIMIT:800,pruneRecordByKeyLimit:x=>x},
  '../../../rendererPerformance':{reportRendererTrace(){}}, './fontPreviewQuickFallbackRuntime':{}
 });
 let releaseOld;
 const loadOptions={previewText:'old',listPreviewFontSize:44,previewRequestTokenRef:ref('old::44'),selectedFontId:'',selectedFontIds:[],previewFamilies:{},nativePreviewImages:{},failedPreviewFontIds:{},loadingFonts:ref(new Set()),isBadFontRecord:()=>false,
  setPreviewFamilies(){},setFailedPreviewFontIds(){},setNativePreviewImages(fn){this.nativePreviewImages=fn(this.nativePreviewImages);},updateFont(){},
  hfm:{getCachedPreviewImage:async()=>'',renderPreviewImage:async(_font,text)=>text==='old'?new Promise(r=>releaseOld=r):'data:image/png;base64,new'}
 };
 const actual=actualLoad('src/renderer/src/runtime/preview/queue/fontPreviewLoadRuntime.ts').createFontPreviewLoadRuntime(loadOptions);
 const nativeFont={id:'native',path:'C:/font.ttf',fileName:'font.ttf',systemInstalled:true};
 const oldRequest=actual.ensurePreviewFont(nativeFont);await new Promise(setImmediate);assert(releaseOld);
 actual.resetPreviewLoads();loadOptions.loadingFonts.current.clear();loadOptions.previewText='new';loadOptions.listPreviewFontSize=64;loadOptions.previewRequestTokenRef.current='new::64';
 await actual.ensurePreviewFont(nativeFont);assert.equal(loadOptions.nativePreviewImages.native,'data:image/png;base64,new');
 releaseOld('data:image/png;base64,old');await oldRequest;assert.equal(loadOptions.nativePreviewImages.native,'data:image/png;base64,new','old success overwrote current preview');
 console.log('PASS S10-02: actual admission/promotion, dedupe/guards, 24 stable cards text/size/reset race, offscreen/resize/unmount/remount/early-ready, scroll resume');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
