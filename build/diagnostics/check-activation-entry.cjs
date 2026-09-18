#!/usr/bin/env node
// U-00 observer: actual TSX callbacks + selection/action/preload/IPC modules.
// React hook scheduling, DOM geometry and native activation are controlled ports, NOT GUI acceptance.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const root = path.resolve(__dirname, '../..'), renderer = 'src/renderer/src/'
const plain = value => JSON.parse(JSON.stringify(value)), noop = () => {}, tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }
function hookPort() {
  const slots = []; let index = 0, effects = []
  return {
    begin() { index = 0; effects = [] }, flush() { for (const fn of effects) fn() },
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(current) { const i = index++; return slots[i] ||= { current } },
    useEffect(fn, deps) { const i = index++; if (!slots[i] || !deps || deps.some((d, n) => d !== slots[i][n])) { slots[i] = deps; effects.push(fn) } },
    useMemo: fn => fn(), useCallback: fn => fn, memo: fn => fn
  }
}
function loadModules(globals, mocks, transforms = {}) {
  const cache = new Map()
  function load(file) {
    file = path.resolve(root, file)
    if (mocks[file]) return mocks[file]
    if (cache.has(file)) return cache.get(file).exports
    if (file.endsWith('/appRuntime.ts')) return { ...load(renderer+'fontDisplay.ts'), ...load(renderer+'fontClassification.ts'), ...load(renderer+'libraryNormalize.ts'), IS_DEVELOPMENT:false }
    const module = { exports:{} }; cache.set(file,module)
    let source = fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n')
    if (file.endsWith('/environmentConstants.ts')) source=source.replace('(import.meta as unknown as { env?: { DEV?: boolean; PROD?: boolean } }).env', '({DEV:false,PROD:true})')
    if (transforms[file]) source = transforms[file](source)
    const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText
    const req = id => {
      if (Object.hasOwn(mocks,id)) return mocks[id]
      if (id === 'react/jsx-runtime' || id.startsWith('node:')) return require(id)
      if (id.startsWith('.') || id.startsWith('@shared/')) {
        const base = id.startsWith('@shared/') ? path.join(root,'src/shared',id.slice(8)) : path.resolve(path.dirname(file),id)
        const target = ['.ts','.tsx',''].map(ext=>base+ext).find(f=>fs.existsSync(f)&&fs.statSync(f).isFile())
        if (!target) throw Error('Missing '+base)
        return load(target)
      }
      throw Error('Unmocked dependency '+id)
    }
    vm.runInNewContext(code, {module,exports:module.exports,require:req,console,process,Buffer,Date,Map,WeakMap,Set,Math,performance,setTimeout,clearTimeout,...globals},{filename:file})
    return module.exports
  }
  return load
}
function treeNodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(treeNodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree,...treeNodes(tree.props?.children)]
}
function button(tree,label) { const found=treeNodes(tree).find(n=>n.type==='button'&&n.props.children===label); assert(found,'missing button '+label); return found }
const font = id => ({id,path:`C:/fixture/${id}.ttf`,fileName:`${id}.ttf`,family:id,format:'ttf',fileSize:100,localTagNames:['test'],tagNames:['shared'],active:false,systemInstalled:false,installStatusKnown:true})
function harness({runtimePreload=false,cache=['a','b','c'],mode='success',throwLog=false,transforms={}}={}) {
  const all = ['a','b','c'].map(font), events=[], requests=[], status=[], listeners=new Map(), handlers=new Map(), selection=hookPort(), effects=hookPort()
  let hook=selection, library={fonts:Object.fromEntries(all.filter(f=>cache.includes(f.id)).map(f=>[f.id,f])),localTags:['test'],tags:['shared'],folders:[]}, selected, menu=null, activeCount=0, refreshes=0, visible=all
  const busy=new Set(), window={setTimeout:fn=>{fn();return 0},clearTimeout:noop,innerWidth:800,innerHeight:600,addEventListener:(n,fn)=>listeners.set(n,fn),removeEventListener:n=>listeners.delete(n)}
  class Rect { constructor(left,top,width,height) { Object.assign(this,{left,top,right:left+width,bottom:top+height,width,height}) } }
  const document={documentElement:{getAttribute:()=>null},querySelectorAll:()=>visible.map((f,i)=>({dataset:{fontId:f.id},getBoundingClientRect:()=>({left:10,top:10+i*20,right:80,bottom:25+i*20})}))}
  const electron={ipcMain:{handle:(n,fn)=>handlers.set(n,fn)},ipcRenderer:{invoke:(n,...args)=>Promise.resolve().then(()=>handlers.get(n)?.({sender:{id:1}},...args)),on:noop,removeListener:noop},contextBridge:{exposeInMainWorld:(_,api)=>{window.hfm=api}}}
  const mocks={electron,react:new Proxy({}, {get:(_,key)=>hook[key]}),'react-dom':{flushSync:fn=>fn()}}
  mocks[path.join(root,'src/main/security/ipcSenderValidation.ts')]={assertTrustedIpcSender:noop}
  // Visual-only preview ports. Selection/card handlers themselves are the production TSX.
  mocks[path.join(root,renderer+'runtime/preview/useGridNativePreviewImageTrim.ts')]={useGridNativePreviewImageTrim:x=>x}
  mocks[path.join(root,renderer+'runtime/preview/gridPreviewVisualFitRuntime.ts')]={useGridPreviewVisualFitText:text=>({fittedText:text,visualFitRef:null,visualFitActive:false})}
  const load=loadModules({window,document,DOMRect:Rect},mocks,transforms)
  const append=line=>{if(throwLog)throw Error('log unavailable');if(line.startsWith('operation-chain: '))events.push(JSON.parse(line.slice(17)))}
  const perf=load('src/main/performance/rendererInteractionRuntime.ts').createRendererInteractionRuntime({appendLog:append})
  handlers.set('performance:rendererTrace',(_,payload)=>perf.reportPerformanceEvent(payload))
  if(runtimePreload)vm.runInNewContext(load('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource,{require:id=>id==='electron'?electron:require(id),process,Buffer,Date,console})
  else load('src/preload/index.ts')
  load('src/main/ipc/ipcTraceRuntime.ts').registerTracedIpcHandler({appendLog:append},'fonts:activateFonts',async(_,...args)=>{
    assert.equal(args.length,1,'trace leaked into business arguments');const targets=args[0];requests.push(targets.map(f=>f.id))
    if(mode==='reject')throw Error('controlled native failure')
    return {ok:mode!=='partial',message:'controlled result',results:Object.fromEntries(targets.map((f,i)=>[f.id,mode==='partial'&&i===1?{ok:false}:{ok:true,temporaryActivated:true}]))}
  })
  handlers.set('fonts:activateFont',(_,f)=>{requests.push([f.id]);return {ok:true,temporaryActivated:true,message:'single'}})
  const setLibrary=value=>{library=typeof value==='function'?value(library):value}
  function select() {hook=selection;hook.begin();selected=load(renderer+'runtime/app/useSelectionController.ts').useSelectionController();return selected}
  function interaction() {return select().createInteractionRuntime({visibleFonts:visible,setStatus:x=>status.push(x),setSingleFontSelection:id=>{selected.setSelectedFontIds([id]);selected.setSelectionAnchorFontId(id)},toggleFontDetail:noop,hydrateFont:f=>load(renderer+'runtime/app/fontSelectionHydrationRuntime.ts').hydrateFontForSelectionDetail(f,setLibrary),reportUserActivity:noop,userActivityIdleWindowMs:100})}
  function prune() {const setIds=select().setSelectedFontIds;hook=effects;hook.begin();load(renderer+'runtime/app/useFontDetailSelectionEffectsRuntime.ts').useFontDetailSelectionEffectsRuntime({library,visibleFonts:visible,selectedFontId:'',detailVisible:false,setSelectedFontIds:setIds,setSelectedFontId:noop,requestPreviewFont:noop,isBadFontRecord:()=>false});effects.flush();select()}
  function patch(id,active,extra) { if(library.fonts[id])library={...library,fonts:{...library.fonts,[id]:{...library.fonts[id],...extra,active}}} }
  function actions() {return load(renderer+'runtime/system/actions/fontActivationActionRuntime.ts').createFontActivationActionRuntime({hfm:window.hfm,library,activeOperationFontIds:{current:busy},setStatus:x=>status.push(x),refreshDatabaseDerivedState:()=>refreshes++},{setFontActiveRuntime:patch,setFontsActiveRuntimeBulk:updates=>Object.entries(updates).forEach(([id,v])=>patch(id,v.active,v.patch)),adjustDatabaseActiveCount:n=>{activeCount+=n}})}
  function context() {return load(renderer+'fontContextActionRuntime.ts').createFontContextActionRuntime({library,contextMenu:menu,selectedFontIds:select().selectedFontIds,menuWidth:100,menuMaxHeight:100,viewport:window,setSelectedFontIds:selected.setSelectedFontIds,setSelectionAnchorFontId:selected.setSelectionAnchorFontId,setSelectedFontId:selected.setSelectedFontId,setContextMenu:x=>{menu=x},...actions()})}
  function panel(view='grid',page='library') { const i=interaction();return load(renderer+'components/app/FontListPanel.tsx').FontListPanel({sidebarPage:page,status:status.at(-1),selectedFontIds:selected.selectedFontIds,library,activeFilter:{kind:'all'},cardPoolViewMode:view,viewMode:'grid',visibleFonts:visible,virtualLayout:{items:[],columns:1,totalHeight:100,top:0},viewLayout:{minCardWidth:100,rowHeight:30},renderFontCard:noop,closeDetail:noop,beginMarqueeSelection:i.beginMarqueeSelection,setSelectedFontIds:selected.setSelectedFontIds,...actions()}) }
  async function click(entry,view='grid',page='library') {
    if(entry==='toolbar')button(panel(view,page),'批量激活').props.onClick()
    else {
      const ctx=context();if(entry==='font')ctx.openFontMenu(event(),all[0]);else menu={kind:'tag',scope:'local',name:'test',x:0,y:0}
      const current=context(), dialogs=load(renderer+'fontDialogContextActionsRuntime.ts').createFontDialogContextActions({contextMenu:menu,setContextMenu:x=>{menu=x},fontsForTag:(name,scope)=>load(renderer+'fontSelectionRuntime.ts').fontsForTagFromLibrary(library.fonts,name,scope),...actions()})
      const overlay=load(renderer+'components/app/AppOverlays.tsx').AppOverlays({contextMenu:menu,contextSelectedFonts:current.contextFontTargets(),selectionLabel:current.selectionLabel,runFontContextAction:current.runFontContextAction,runContextBatchActivate:dialogs.runContextBatchActivate})
      const b=button(overlay,current.contextFontTargets().length<=1&&entry==='font'?'激活':'批量激活');b.props.onMouseDown(event());b.props.onClick()
    }
    await tick()
  }
  function event(extra={}) {return {button:0,clientX:0,clientY:0,preventDefault:noop,stopPropagation:noop,target:{closest:()=>null},currentTarget:{contains:()=>false,classList:{add:noop,remove:noop}},...extra}}
  function card(id,keys={},compact=false) {const i=interaction();hook=hookPort();hook.begin();const tree=load(renderer+'components/FontCard.tsx').FontCard({font:all.find(f=>f.id===id),compact,previewText:'test',onSelect:e=>i.handleFontSelect(e,all.find(f=>f.id===id))});tree.props.onMouseDown(event(keys));select()}
  function marquee(view='grid') {const scroller=treeNodes(panel(view)).find(n=>n.props?.className?.includes('font-virtual-scroller'));scroller.props.onMouseDown(event());listeners.get('mousemove')(event({clientX:100,clientY:100}));listeners.get('mouseup')(event({clientX:100,clientY:100}));select();assert.equal(listeners.size,0)}
  select()
  return {all,events,requests,status,busy,card,marquee,click,prune,select,load,window,setLibrary,get library(){return library},get menu(){return menu},get count(){return activeCount},get refreshes(){return refreshes},setVisible:fonts=>{visible=fonts}}
}
async function run() {
  process.env.HFM_LOG_DETAIL='debug'
  if (process.argv.includes('--baseline')) {
    const {execFileSync}=require('node:child_process'), transforms={}
    for(const file of ['components/app/FontListPanel.tsx','fontContextActionRuntime.ts','fontDialogContextActionsRuntime.ts','runtime/system/actions/fontActivationActionRuntime.ts']) {
      const source=execFileSync('git',['show',`90adfa6c4332fca553db56acc370f886a763b1d4:${renderer+file}`],{cwd:root,encoding:'utf8'})
      transforms[path.join(root,renderer+file)]=()=>source
    }
    for(const entry of ['toolbar','font','tag']) {const h=harness({transforms});h.marquee();await h.click(entry);assert.deepEqual(plain(h.requests),[['a','b','c']])}
    const zero=harness({transforms,cache:[]});zero.marquee();await zero.click('toolbar');assert.equal(zero.requests.length,0)
    const shift=harness({transforms,cache:[]});shift.card('a');shift.prune();shift.card('c',{shiftKey:true});shift.prune();await shift.click('toolbar');assert.deepEqual(plain(shift.requests),[['a','c']])
    console.log('[activation-entry baseline 90adfa6] 5 original-source cases: healthy three entries; missing-cache marquee no IPC; Shift loses middle selection. No fix claimed.')
    return
  }
  let cases=0
  for(const runtimePreload of [false,true])for(const view of ['grid','list'])for(const page of ['library','folders','tags'])for(const entry of ['toolbar','font','tag']) {
    const h=harness({runtimePreload});h.card('a',{ctrlKey:true},view==='list');h.card('b',{ctrlKey:true},view==='list');h.card('c',{ctrlKey:true},view==='list');await h.click(entry,view,page)
    assert.deepEqual(plain(h.requests),[['a','b','c']]);assert.equal(h.count,3);assert.equal(h.busy.size,0);assert.equal(h.refreshes,1);assert.equal(h.menu,null)
    const e=h.events.find(e=>e.stage==='entry');assert.equal(e.reason,{toolbar:'selection-toolbar',font:'font-context',tag:'tag-context'}[entry])
    for(const stage of ['resolved','targets','filter','dispatch','ipc-start','ipc-result','operation-result','view-apply'])assert(h.events.some(x=>x.stage===stage&&x.trace.operationId===e.trace.operationId),stage+' unlinked')
    assert.equal(h.events.filter(e=>e.stage==='item-result').length,3);cases++
  }
  // Reachable cache boundary: real 1400-item LRU + real paged visible-row fallback.
  const lru=harness({cache:[]}), rows=[...lru.all,...Array.from({length:1496},(_,i)=>font(`filler-${i}`))]
  const merge=lru.load(renderer+'libraryNormalize.ts').libraryWithMergedFonts
  lru.setLibrary(merge(lru.library,rows.slice(0,1400),[]));lru.setLibrary(merge(lru.library,rows.slice(1400),[]))
  assert.equal(Object.keys(lru.library.fonts).length,1400);assert.equal(lru.library.fonts.a,undefined)
  const visible=lru.load(renderer+'fontViewRuntime.ts').buildVisibleFonts({databasePageReady:true,databasePageResult:{items:rows},library:lru.library,sidebarPage:'library',activeFilter:{kind:'all'},allFonts:Object.values(lru.library.fonts)})
  assert.equal(visible.length,1499);lru.setVisible(visible.slice(0,3));lru.marquee();await lru.click('toolbar');assert.equal(lru.requests.length,0);assert(lru.events.some(e=>e.reason==='selected:3.resolved:0.missing:3'));cases++
  // Original defect evidence: visible page rows with no matching library cache, actual marquee callback.
  for(const view of ['grid','list']) {
    const h=harness({cache:[]});h.marquee(view);assert.deepEqual(plain(h.select().selectedFontIds),['a','b','c']);await h.click('toolbar',view)
    assert.equal(h.requests.length,0);assert(h.events.some(e=>e.reason==='selected:3.resolved:0.missing:3'));assert(h.events.some(e=>e.outcome==='zero-targets'));assert.match(h.status.at(-1),/没有字体/);cases++
    const s=harness({cache:[]});s.card('a',{},view==='list');s.prune();s.card('c',{shiftKey:true},view==='list');assert.deepEqual(plain(s.select().selectedFontIds),['a','b','c']);assert.deepEqual(Object.keys(s.library.fonts),['a','c']);s.prune();assert.deepEqual(plain(s.select().selectedFontIds),['a','c']);await s.click('toolbar',view);assert.deepEqual(plain(s.requests),[['a','c']]);cases++
  }
  for(const mode of ['partial','reject']) {
    const h=harness({mode});h.marquee();await h.click('toolbar');assert.equal(h.busy.size,0);assert.equal(h.count,mode==='partial'?2:0);assert.equal(h.library.fonts.b.active,false);assert(h.events.some(e=>e.outcome===(mode==='partial'?'partial-failure':'unknown')));cases++
  }
  const skipped=harness();skipped.library.fonts.a.systemInstalled=true;skipped.library.fonts.b.active=true;skipped.busy.add('c');skipped.marquee();await skipped.click('toolbar');assert.equal(skipped.requests.length,0);assert(skipped.events.some(e=>e.outcome==='all-skipped'));assert(skipped.events.some(e=>e.reason==='installed:1.system:0.active:1.busy:1'));cases++
  const crossing=harness({cache:[]});crossing.card('a',{ctrlKey:true});crossing.setVisible(crossing.all.slice(1));crossing.card('c',{ctrlKey:true});await crossing.click('toolbar');assert.deepEqual(plain(crossing.requests),[['a','c']]);cases++
  const stale=harness();stale.card('a',{ctrlKey:true});stale.card('b',{ctrlKey:true});stale.select().setSelectedFontIds(['b','c']);await stale.click('toolbar');assert.deepEqual(plain(stale.requests),[['b','c']]);cases++
  const logging=harness({throwLog:true});logging.marquee();await logging.click('toolbar');assert.deepEqual(plain(logging.requests),[['a','b','c']]);assert.equal(logging.count,3);cases++
  const partialCache=harness({cache:['a','b']});partialCache.marquee();await partialCache.click('toolbar');assert.deepEqual(plain(partialCache.requests),[['a','b']]);assert(partialCache.events.some(e=>e.reason==='selected:3.resolved:2.missing:1'));cases++
  const closed=harness();await closed.load(renderer+'fontContextActionRuntime.ts').createFontContextActionRuntime({contextMenu:null,selectedFontIds:['a','b'],library:closed.library}).runFontContextAction('activate');await tick();assert.equal(closed.requests.length,0);assert(closed.events.some(e=>e.outcome==='missing-context'));cases++
  const zeroMenu=harness({cache:[]});zeroMenu.marquee();await zeroMenu.click('font');assert.equal(zeroMenu.requests.length,0);assert.equal(zeroMenu.menu.kind,'font');assert(zeroMenu.events.some(e=>e.stage==='route'&&e.outcome==='zero-targets'));cases++
  const limited=harness(), many=Array.from({length:1000},(_,i)=>font(String(i))), ft=limited.load(renderer+'fontActivationTrace.ts')
  ft.traceActivationEntry(many,'diagnostic');ft.reportActivationResult(ft.activationEntryTrace(many),many,Object.fromEntries(many.map(f=>[f.id,{ok:true,temporaryActivated:true}])));await tick()
  assert.equal(limited.events.filter(e=>e.stage==='item-result').length,16);assert.equal(limited.events.find(e=>e.stage==='operation-result').trace.omitted,984);assert(!JSON.stringify(limited.events).includes('fixture/'));cases++
  // Remove the actual toolbar callback; the same request assertion must detect the regression.
  const f=path.join(root,renderer+'components/app/FontListPanel.tsx')
  const broken=harness({transforms:{[f]:s=>{const pattern=/onClick=\{\(\) => void activateFontsBatch\([^\n]+?\}>批量激活/;assert(pattern.test(s));return s.replace(pattern,'onClick={() => {}}>批量激活')}}})
  broken.marquee();await broken.click('toolbar');assert.throws(()=>assert.deepEqual(plain(broken.requests),[['a','b','c']]),assert.AssertionError);cases++
  console.log(`[diagnostics:activation-entry] ${cases} controlled cases: actual TSX handlers, three entries, two preload/IPC routes, missing hydration/prune evidence, zero/all-skipped/partial/reject, trace non-interference. DOM propagation and Windows remain unverified.`)
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1})
