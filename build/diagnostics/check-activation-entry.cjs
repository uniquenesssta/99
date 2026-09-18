#!/usr/bin/env node
// U-01 regression (U-00 original-source mode retained): actual TSX callbacks + selection/action/preload/IPC modules.
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
  if (typeof tree.type === 'function' && tree.type.name === 'FontCommandButtons') return treeNodes(tree.type(tree.props))
  return [tree,...treeNodes(tree.props?.children)]
}
function button(tree,label) { const found=treeNodes(tree).find(n=>n.type==='button'&&n.props.children===label); assert(found,'missing button '+label); return found }
const font = id => ({id,path:`C:/fixture/${id}.ttf`,fileName:`${id}.ttf`,family:id,format:'ttf',fileSize:100,localTagNames:['test'],tagNames:['shared'],active:false,systemInstalled:false,installStatusKnown:true})
function harness({runtimePreload=false,cache=['a','b','c'],mode='success',throwLog=false,transforms={},partial=true}={}) {
  const all = ['a','b','c'].map(font), events=[], requests=[], status=[], listeners=new Map(), handlers=new Map(), selection=hookPort(), effects=hookPort()
  let hook=selection, scopeKey='', library={__partialFonts:partial,fonts:Object.fromEntries(all.filter(f=>cache.includes(f.id)).map(f=>[f.id,f])),localTags:['test'],tags:['shared'],folders:[]}, selected, menu=null, activeCount=0, refreshes=0, visible=all
  let commandActions={}
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
  handlers.set('fonts:queryPage',(_,request)=>({items:all.slice(request.offset,request.offset+request.limit),total:all.length,offset:request.offset,limit:request.limit,engine:'sql'}))
  handlers.set('fonts:activateFont',(_,f)=>{requests.push([f.id]);return {ok:true,temporaryActivated:true,message:'single'}})
  const setLibrary=value=>{library=typeof value==='function'?value(library):value}
  function select() {hook=selection;hook.begin();selected=load(renderer+'runtime/app/useSelectionController.ts').useSelectionController(scopeKey);hook.flush();return selected}
  function interaction() {return select().createInteractionRuntime({visibleFonts:visible,setStatus:x=>status.push(x),setSingleFontSelection:id=>{selected.setSelectedFontIds([id]);selected.setSelectionAnchorFontId(id)},toggleFontDetail:noop,hydrateFont:(f,keepIds)=>load(renderer+'runtime/app/fontSelectionHydrationRuntime.ts').hydrateFontForSelectionDetail(f,setLibrary,keepIds),reportUserActivity:noop,userActivityIdleWindowMs:100})}
  function prune() {const setIds=select().setSelectedFontIds;hook=effects;hook.begin();load(renderer+'runtime/app/useFontDetailSelectionEffectsRuntime.ts').useFontDetailSelectionEffectsRuntime({library,selectedFontIds:selected.selectedFontIds,setLibrary,visibleFonts:visible,selectedFontId:'',detailVisible:false,setSelectedFontIds:setIds,setSelectedFontId:noop,requestPreviewFont:noop,isBadFontRecord:()=>false});effects.flush();select()}
  function patch(id,active,extra) { if(library.fonts[id])library={...library,fonts:{...library.fonts,[id]:{...library.fonts[id],...extra,active}}} }
  function actions() {return {...load(renderer+'runtime/system/actions/fontActivationActionRuntime.ts').createFontActivationActionRuntime({hfm:window.hfm,library,getCurrentLibrary:()=>library,setLibrary,activeOperationFontIds:{current:busy},setStatus:x=>status.push(x),refreshDatabaseDerivedState:()=>refreshes++},{setFontActiveRuntime:patch,setFontsActiveRuntimeBulk:updates=>Object.entries(updates).forEach(([id,v])=>patch(id,v.active,v.patch)),adjustDatabaseActiveCount:n=>{activeCount+=n}}),...commandActions}}
  function command() {return load(renderer+'fontCommandRuntime.ts').createFontCommandRuntime({library,getCurrentLibrary:()=>library,selectedFontIds:select().selectedFontIds,getVisibleFonts:()=>visible,setStatus:x=>status.push(x),...actions()})}
  function context() {return load(renderer+'fontContextActionRuntime.ts').createFontContextActionRuntime({library,getVisibleFonts:()=>visible,setStatus:x=>status.push(x),contextMenu:menu,selectedFontIds:select().selectedFontIds,menuWidth:100,menuMaxHeight:100,viewport:window,setSelectedFontIds:selected.setSelectedFontIds,setSelectionAnchorFontId:selected.setSelectionAnchorFontId,setSelectedFontId:selected.setSelectedFontId,setContextMenu:x=>{menu=x},...actions()})}
  function panel(view='grid',page='library') { const i=interaction();return load(renderer+'components/app/FontListPanel.tsx').FontListPanel({sidebarPage:page,status:status.at(-1),setStatus:x=>status.push(x),selectedFontIds:selected.selectedFontIds,library,runFontCommand:command(),activeFilter:{kind:'all'},cardPoolViewMode:view,viewMode:'grid',visibleFonts:visible,virtualLayout:{items:[],columns:1,totalHeight:100,top:0},viewLayout:{minCardWidth:100,rowHeight:30},renderFontCard:noop,closeDetail:noop,beginMarqueeSelection:i.beginMarqueeSelection,setSelectedFontIds:selected.setSelectedFontIds,...actions()}) }
  async function click(entry,view='grid',page='library',command='activate') {
    if(entry==='toolbar')button(panel(view,page),(process.argv.includes('--baseline')?'批量':'')+(command==='activate'?'激活':'取消激活')).props.onClick()
    else {
      const ctx=context();if(entry==='font')ctx.openFontMenu(event(),all[0]);else menu={kind:'tag',scope:'local',name:'test',x:0,y:0}
      const current=context(), dialogs=load(renderer+'fontDialogContextActionsRuntime.ts').createFontDialogContextActions({hfm:window.hfm,library,setStatus:x=>status.push(x),contextMenu:menu,setContextMenu:x=>{menu=x},fontsForTag:(name,scope)=>load(renderer+'fontSelectionRuntime.ts').fontsForTagFromLibrary(library.fonts,name,scope),...actions()})
      const overlay=load(renderer+'components/app/AppOverlays.tsx').AppOverlays({contextMenu:menu,contextSelectedFonts:current.contextFontTargets(),contextTargetCount:current.contextTargetCount,selectionLabel:current.selectionLabel,runFontContextAction:current.runFontContextAction,runContextBatchActivate:dialogs.runContextBatchActivate,runContextBatchDeactivate:dialogs.runContextBatchDeactivate})
      const label=command==='activate'?'激活':'取消激活';const b=button(overlay,!process.argv.includes('--baseline')||current.contextFontTargets().length<=1&&entry==='font'?label:'批量'+label);b.props.onMouseDown(event());b.props.onClick()
    }
    await tick()
  }
  function event(extra={}) {return {button:0,clientX:0,clientY:0,preventDefault:noop,stopPropagation:noop,target:{closest:()=>null},currentTarget:{contains:()=>false,classList:{add:noop,remove:noop}},...extra}}
  function card(id,keys={},compact=false) {const i=interaction();hook=hookPort();hook.begin();const tree=load(renderer+'components/FontCard.tsx').FontCard({font:all.find(f=>f.id===id),compact,previewText:'test',onSelect:e=>i.handleFontSelect(e,all.find(f=>f.id===id))});tree.props.onMouseDown(event(keys));select()}
  function marquee(view='grid') {const scroller=treeNodes(panel(view)).find(n=>n.props?.className?.includes('font-virtual-scroller'));scroller.props.onMouseDown(event());listeners.get('mousemove')(event({clientX:100,clientY:100}));listeners.get('mouseup')(event({clientX:100,clientY:100}));select();assert.equal(listeners.size,0)}
  select()
  return {all,events,requests,status,busy,setCommandActions:value=>{commandActions=value},card,marquee,click,prune,select,load,window,setLibrary,panel,handlers,actions,command,context,interaction,event,listeners,setScope:value=>{scopeKey=value;select();select()},get library(){return library},get menu(){return menu},get count(){return activeCount},get refreshes(){return refreshes},setVisible:fonts=>{visible=fonts}}
}
async function run() {
  process.env.HFM_LOG_DETAIL='debug'
  if (process.argv.includes('--baseline')) {
    const {execFileSync}=require('node:child_process'), transforms={}
    for(const file of ['components/app/FontListPanel.tsx','components/app/AppOverlays.tsx','fontContextActionRuntime.ts','fontContextMenuRuntime.ts','fontDialogContextActionsRuntime.ts','runtime/system/actions/fontActivationActionRuntime.ts','runtime/app/useSelectionController.ts','runtime/app/useFontDetailSelectionEffectsRuntime.ts','runtime/app/fontSelectionHydrationRuntime.ts']) {
      const source=execFileSync('git',['show',`c41f410ea19de901af0df9e1d64ff60d0b8a58c5:${renderer+file}`],{cwd:root,encoding:'utf8'})
      transforms[path.join(root,renderer+file)]=()=>source
    }
    for(const entry of ['toolbar','font','tag']) {const h=harness({transforms});h.marquee();await h.click(entry);assert.deepEqual(plain(h.requests),[['a','b','c']])}
    const zero=harness({transforms,cache:[]});zero.marquee();await zero.click('toolbar');assert.equal(zero.requests.length,0)
    const shift=harness({transforms,cache:[]});shift.card('a');shift.prune();shift.card('c',{shiftKey:true});shift.prune();await shift.click('toolbar');assert.deepEqual(plain(shift.requests),[['a','c']])
    console.log('[activation-entry baseline c41f410] 5 original-source cases: healthy three entries; missing-cache marquee no IPC; Shift loses middle selection. No fix claimed.')
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
  assert.equal(visible.length,1499);lru.setVisible(visible.slice(0,3));lru.marquee();await lru.click('toolbar');assert.deepEqual(plain(lru.requests),[['a','b','c']]);assert.equal(lru.count,3);assert(lru.library.fonts.a.active);assert(lru.events.some(e=>e.reason==='selected:3.resolved:3.missing:0'));cases++
  // Original defect evidence: visible page rows with no matching library cache, actual marquee callback.
  for(const view of ['grid','list']) {
    const h=harness({cache:[]});h.marquee(view);assert.deepEqual(plain(h.select().selectedFontIds),['a','b','c']);await h.click('toolbar',view)
    assert.deepEqual(plain(h.requests),[['a','b','c']]);assert(h.events.some(e=>e.reason==='selected:3.resolved:3.missing:0'));assert.equal(h.count,3);assert(h.library.fonts.b.active);cases++
    const s=harness({cache:[]});s.card('a',{},view==='list');s.prune();s.card('c',{shiftKey:true},view==='list');assert.deepEqual(plain(s.select().selectedFontIds),['a','b','c']);assert.deepEqual(Object.keys(s.library.fonts),['a','c']);s.prune();assert.deepEqual(plain(s.select().selectedFontIds),['a','b','c']);assert(s.library.fonts.b);await s.click('toolbar',view);assert.deepEqual(plain(s.requests),[['a','b','c']]);cases++
  }
  for(const mode of ['partial','reject']) {
    const h=harness({mode});h.marquee();await h.click('toolbar');assert.equal(h.busy.size,0);assert.equal(h.count,mode==='partial'?2:0);assert.equal(h.library.fonts.b.active,false);assert(h.events.some(e=>e.outcome===(mode==='partial'?'partial-failure':'unknown')));cases++
  }
  const skipped=harness();skipped.library.fonts.a.systemInstalled=true;skipped.library.fonts.b.active=true;skipped.busy.add('c');skipped.marquee();await skipped.click('toolbar');assert.equal(skipped.requests.length,0);assert(skipped.events.some(e=>e.outcome==='all-skipped'));assert(skipped.events.some(e=>e.reason==='installed:1.system:0.active:1.busy:1'));cases++
  const crossing=harness({cache:[]});crossing.card('a',{ctrlKey:true});crossing.setVisible(crossing.all.slice(1));crossing.card('c',{ctrlKey:true});await crossing.click('toolbar');assert.deepEqual(plain(crossing.requests),[['a','c']]);cases++
  const stale=harness();stale.card('a',{ctrlKey:true});stale.card('b',{ctrlKey:true});stale.select().setSelectedFontIds(['b','c']);await stale.click('toolbar');assert.deepEqual(plain(stale.requests),[['b','c']]);cases++
  const logging=harness({throwLog:true});logging.marquee();await logging.click('toolbar');assert.deepEqual(plain(logging.requests),[['a','b','c']]);assert.equal(logging.count,3);cases++
  const partialCache=harness({cache:['a','b']});partialCache.marquee();await partialCache.click('toolbar');assert.deepEqual(plain(partialCache.requests),[['a','b','c']]);assert(partialCache.events.some(e=>e.reason==='selected:3.resolved:3.missing:0'));cases++
  const closed=harness();await closed.load(renderer+'fontContextActionRuntime.ts').createFontContextActionRuntime({contextMenu:null,selectedFontIds:['a','b'],library:closed.library}).runFontContextAction('activate');await tick();assert.equal(closed.requests.length,0);assert(closed.events.some(e=>e.outcome==='missing-context'));cases++
  const zeroMenu=harness({cache:[]});zeroMenu.marquee();await zeroMenu.click('font');assert.deepEqual(plain(zeroMenu.requests),[['a','b','c']]);assert.equal(zeroMenu.menu,null);assert.equal(zeroMenu.count,3);cases++
  for (const entry of ['toolbar','font']) {
    const missing=harness({cache:['a']});missing.select().setSelectedFontIds(['a','absent','c']);await missing.click(entry)
    assert.equal(missing.requests.length,0);assert(missing.events.some(e=>e.stage==='preflight'&&e.outcome==='missing-records'));assert.match(missing.status.at(-1),/1 个.*未执行.*absent/)
    assert.equal(treeNodes(missing.panel()).find(n=>n.props?.role==='status').props.children,missing.status.at(-1));cases++
  }
  const deleted=harness({partial:false,cache:['a','b']});deleted.select().setSelectedFontIds(['a','b','c']);deleted.prune();assert.deepEqual(plain(deleted.select().selectedFontIds),['a','b']);assert(!deleted.library.fonts.c);cases++
  const removed=harness();removed.marquee();removed.select().removeFontIds(new Set(['b']));assert.deepEqual(plain(removed.select().selectedFontIds),['a','c']);removed.setScope('tags:test');assert.deepEqual(plain(removed.select().selectedFontIds),[]);cases++
  const oldScope=harness(), oldEvents=oldScope.interaction();oldEvents.beginMarqueeSelection(oldScope.event());oldScope.setScope('folders:new');oldScope.listeners.get('mouseup')(oldScope.event({clientX:100,clientY:100}));assert.deepEqual(plain(oldScope.select().selectedFontIds),[]);oldEvents.handleFontSelect(oldScope.event({ctrlKey:true}),oldScope.all[0]);assert.deepEqual(plain(oldScope.select().selectedFontIds),[]);cases++
  const cancelled=harness();cancelled.marquee();button(cancelled.panel(),'取消选择').props.onClick();assert.deepEqual(plain(cancelled.select().selectedFontIds),[]);cases++
  const duplicate=harness();duplicate.select().setSelectedFontIds(['a','a','b']);await duplicate.click('toolbar');assert.deepEqual(plain(duplicate.requests),[['a','b']]);cases++
  for(const n of [1,2,3]) {const h=harness({cache:[]});h.select().setSelectedFontIds(h.all.slice(0,n).map(f=>f.id));await h.click('font');assert.deepEqual(plain(h.requests),[h.all.slice(0,n).map(f=>f.id)]);assert.equal(h.count,n);cases++}
  const pending=harness();let release
  pending.handlers.set('fonts:activateFonts',async(_,...args)=>{pending.requests.push(args[0].map(f=>f.id));await new Promise(resolve=>{release=resolve});return {message:'settled',results:{a:{ok:true,temporaryActivated:true},b:{ok:false}}}})
  pending.select().setSelectedFontIds(['a','b']);await pending.click('toolbar');assert.deepEqual([...pending.busy],['a','b']);await pending.click('toolbar');assert.equal(pending.requests.length,1)
  pending.select().setSelectedFontIds(['c']);release();await tick();assert.deepEqual(plain(pending.requests),[['a','b']]);assert.equal(pending.library.fonts.a.active,true);assert.equal(pending.library.fonts.b.active,false);assert.equal(pending.library.fonts.c.active,false);assert.deepEqual(plain(pending.select().selectedFontIds),['c']);assert.equal(pending.busy.size,0);cases++
  for(const ok of [true,false]) {const h=harness({cache:[]});h.all[0].active=true;h.select().setSelectedFontIds(['a']);h.handlers.set('fonts:deactivateFonts',(_,fonts)=>{h.requests.push(fonts.map(f=>f.id));return {ok,message:'controlled deactivation',results:{a:{ok}}}});await h.click('font','grid','library','deactivate');assert.deepEqual(plain(h.requests),[['a']]);assert.equal(h.library.fonts.a.active,!ok);assert.equal(h.count,ok?-1:0);assert.equal(h.busy.size,0);cases++}
  const noReceipts=harness();noReceipts.handlers.set('fonts:activateFonts',()=>({message:'missing receipt'}));noReceipts.marquee();await noReceipts.click('toolbar');assert.equal(noReceipts.count,0);assert.equal(noReceipts.busy.size,0);assert.match(noReceipts.status.at(-1),/未确认 3 个/);cases++
  const tags=harness({cache:[]}), tagRows=Array.from({length:503},(_,i)=>font('tag-'+i)), offsets=[]
  tags.handlers.set('fonts:queryPage',(_,r)=>{offsets.push(r.offset);return {items:tagRows.slice(r.offset,r.offset+r.limit),total:503,offset:r.offset,limit:r.limit,engine:'sql'}})
  await tags.click('tag');assert.deepEqual(offsets,[0,500]);assert.deepEqual(plain(tags.requests),[tagRows.map(f=>f.id)]);assert.equal(tags.count,503);cases++
  for(const bad of ['failure','short','changed','duplicate']) {
    const tag=harness({cache:[]})
    tag.handlers.set('fonts:queryPage',(_,r)=>{if(bad==='failure')throw Error('offline');return {items:r.offset===0?tag.all:bad==='duplicate'?tag.all:[],total:bad==='changed'&&r.offset?4:5,offset:r.offset,limit:500,engine:'sql'}})
    await tag.click('tag');assert.equal(tag.requests.length,0);assert.match(tag.status.at(-1),/未完成/);cases++
  }
  // Selected records survive one-item detail hydration at the cache limit.
  const keep=harness(), filler=Array.from({length:1397},(_,i)=>font('keep-'+i))
  keep.setLibrary({...keep.library,fonts:Object.fromEntries([...keep.all,...filler].map(f=>[f.id,f]))});keep.select().setSelectedFontIds(['a','b']);keep.card('c',{ctrlKey:true});keep.prune();assert.deepEqual(plain(keep.select().selectedFontIds),['a','b','c']);cases++
  const limited=harness(), many=Array.from({length:1000},(_,i)=>font(String(i))), ft=limited.load(renderer+'fontActivationTrace.ts')
  ft.traceActivationEntry(many,'diagnostic');ft.reportActivationResult(ft.activationEntryTrace(many),many,Object.fromEntries(many.map(f=>[f.id,{ok:true,temporaryActivated:true}])));await tick()
  assert.equal(limited.events.filter(e=>e.stage==='item-result').length,16);assert.equal(limited.events.find(e=>e.stage==='operation-result').trace.omitted,984);assert(!JSON.stringify(limited.events).includes('fixture/'));cases++
  // Remove the actual toolbar callback; the same request assertion must detect the regression.
  const f=path.join(root,renderer+'components/app/FontListPanel.tsx')
  const broken=harness({transforms:{[f]:s=>{const pattern=/onCommand=\{action => void runFontCommand\([^\n]+\)\}/;assert(pattern.test(s));return s.replace(pattern,'onCommand={() => {}}')}}})
  broken.marquee();await broken.click('toolbar');assert.throws(()=>assert.deepEqual(plain(broken.requests),[['a','b','c']]),assert.AssertionError);cases++
  console.log(`[diagnostics:activation-entry] ${cases} controlled cases: actual TSX handlers, three entries, two preload/IPC routes, recovered hydration/prune, complete-or-reject targets, immutable inflight selection, tag pagination, all-skipped/partial/reject, trace non-interference. DOM propagation and Windows remain unverified.`)
}
module.exports={harness,loadModules,treeNodes,button,font,plain,noop,tick,renderer,root};
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1})
