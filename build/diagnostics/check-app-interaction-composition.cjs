#!/usr/bin/env node
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript'), crypto = require('node:crypto')
const root = path.join(__dirname,'../..'), app='src/renderer/src/App.tsx', dir='src/renderer/src/runtime/app/'
const read=f=>fs.readFileSync(path.join(root,f),'utf8'), plain=x=>JSON.parse(JSON.stringify(x))
const digest=s=>crypto.createHash('sha256').update(s.replace(/\r\n/g,'\n')).digest('hex')
function callMap(source) {
  const ast=ts.createSourceFile('App.tsx',source.replace(/\r\n/g,'\n'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX), calls={}, hooks=[]
  function walk(n){if(ts.isCallExpression(n)){const name=n.expression.getText(ast);if(name.startsWith('use'))hooks.push(name);for(const [i,a]of n.arguments.entries())if(ts.isObjectLiteralExpression(a))calls[name+':'+i]=Object.fromEntries(a.properties.map(p=>[p.name.getText(ast),(ts.isShorthandPropertyAssignment(p)?p.name:p.initializer).getText(ast)]))}ts.forEachChild(n,walk)}walk(ast);return {calls,hooks}
}
function loader(transforms = {}) {
  const cache={}
  function load(f){
    if(cache[f])return cache[f]
    if(f==='src/renderer/src/appRuntime.ts')return {...load('src/renderer/src/fontDisplay.ts'),...load('src/renderer/src/libraryNormalize.ts')}
    const out={};cache[f]=out
    let source=read(f);if(transforms[f])source=transforms[f](source);if(f.endsWith('/environmentConstants.ts'))source=source.replace('(import.meta as unknown as { env?: { DEV?: boolean; PROD?: boolean } }).env','({DEV:false,PROD:true})')
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
    vm.runInNewContext(code,{exports:out,require(id){if(id==='react-dom')return {flushSync:fn=>fn()};if(id.startsWith('@shared/'))return load('src/shared/'+id.slice(8)+'.ts');if(id.startsWith('.'))return load(path.posix.normalize(path.posix.join(path.posix.dirname(f),id))+'.ts');throw Error('unmocked '+f+':'+id)},console,Date,Set,Map,Symbol,Promise,setTimeout,clearTimeout});return out
  }return load
}
function structure(){
  const fixture=JSON.parse(read('build/diagnostics/fixtures/app-interaction-composition.fixture.json'))
  for(const source of [read(app),read(app).replace(/\r?\n/g,'\r\n')]){
    const current=callMap(source);assert.deepEqual(current.hooks,fixture.hooks,'Hook order')
    const context=current.calls['createAppMenuDialogRuntime:0'];assert.deepEqual(context,fixture.calls['createFontContextActionRuntime:0'])
    const dialog={...current.calls['contextActionRuntime.createDialogs:0']};for(const k of ['library','contextMenu','setContextMenu','activateFontsBatch','deactivateFontsBatch'])dialog[k]=context[k]
    assert.deepEqual(dialog,fixture.calls['createFontDialogRuntime:0'],'effective dialog inputs')
    assert.deepEqual(current.calls['createAppDetailSelectionRuntime:0'],fixture.calls['createFontDetailPanelRuntime:0'])
    const selection={...current.calls['detailPanelRuntime.createSelection:1'],toggleFontDetail:'toggleFontDetail',hydrateFont:'(font) => hydrateFontForSelectionDetail(font, setLibrary)'}
    assert.deepEqual(selection,fixture.calls['createSelectionInteractionRuntime:0'])
    assert(source.indexOf('createAppControllerPorts()')<source.indexOf('useBrowseController({'))
    assert(source.indexOf('controllerPorts.bindOperations(')>source.indexOf('const operationsController = useFontOperationsController('))
    assert(source.indexOf('controllerPorts.bindDeveloper(')>source.indexOf('const developerController = useDeveloperController('))
  }
  for(const [f,hash]of Object.entries(fixture.sources))assert.equal(digest(read(f)),hash,'unchanged algorithm '+f)
  for(const f of ['createAppMenuDialogRuntime.ts','createAppDetailSelectionRuntime.ts','createAppControllerPorts.ts'])assert(!/use(State|Ref|Effect)\(|\bany\b|ts-ignore/.test(read(dir+f)))
}
function portCases(transform){
  const factory=loader({[dir+'createAppControllerPorts.ts']:transform})(dir+'createAppControllerPorts.ts').createAppControllerPorts
  const ports=factory(),other=factory(),events=[]
  assert.throws(()=>ports.operations(),/before initialization/);assert.throws(()=>ports.developer(),/before initialization/)
  // A constructor that synchronously calls a forward callback must fail explicitly.
  assert.throws(()=>((callback)=>callback())(()=>ports.operations().reportUserActivity()),/before initialization/)
  ports.bindOperations({reportUserActivity:(...args)=>events.push(args),rendererUserActive:()=>true,updateFont:()=>events.push('update')})
  ports.bindDeveloper({appendDeveloperStatus:(...args)=>events.push(args)})
  ports.operations().reportUserActivity('click',10);assert.equal(ports.operations().rendererUserActive(),true);ports.developer().appendDeveloperStatus('source','message')
  assert.deepEqual(events,[['click',10],['source','message']]);assert.throws(()=>other.operations(),/before initialization/)
}
async function interactions(transforms){
  const load=loader(transforms),menuFactory=load(dir+'createAppMenuDialogRuntime.ts').createAppMenuDialogRuntime,detailFactory=load(dir+'createAppDetailSelectionRuntime.ts').createAppDetailSelectionRuntime
  const font={id:'a',fileName:'A.ttf',path:'C:/a.ttf',localTagNames:['old'],tagNames:['shared'],favorite:true,deleteProtected:true}
  let library={fonts:{a:font},localTags:['old'],sharedTags:['shared'],folders:[],folderNodes:[],previewText:'preview'},renameTarget=null,renameValue='',deleteTarget=null
  const events=[],queued=[];const setLibrary=update=>{library=typeof update==='function'?update(library):update}
  function menu(){return menuFactory({library,contextMenu:{kind:'tag',scope:'local',name:'old',x:10,y:10},selectedFontIds:['a'],menuWidth:100,menuMaxHeight:100,viewport:{innerWidth:800,innerHeight:600},setContextMenu:x=>events.push(['menu',x]),setSelectedFontIds:x=>events.push(['ids',x]),setSelectedFontId:x=>events.push(['id',x]),setSelectionAnchorFontId:x=>events.push(['anchor',x]),activateFontsBatch:async()=>{},deactivateFontsBatch:async()=>{}})}
  function dialogs(){return menu().createDialogs({renameTarget,renameValue,deleteTarget,selectedFont:library.fonts.a,selectedTagName:'old',selectedSharedTagName:'shared',watchedFolders:[],hfm:{deleteLocalTag:async()=>{events.push('delete-ipc');return {ok:true,message:'deleted'}}},fontsForTag:()=>[library.fonts.a],queueLocalTagsWrite:(f,tags)=>queued.push({f,tags}),queueSharedTagsWrite:()=>{throw Error('local mutated shared')},setLibrary,commitLibraryUpdate:u=>{setLibrary(u);return library},saveLibraryImmediately:async()=>true,setRenameTarget:x=>{renameTarget=x},setRenameValue:x=>{renameValue=x},setDeleteTarget:x=>{deleteTarget=x},setStatus:()=>{},setSelectedTagName:()=>{},setSelectedSharedTagName:()=>{},refreshDatabaseDerivedState:()=>events.push('refresh'),flushFontWriteQueue:async()=>{events.push('flush');return true},setNewTagName:()=>{},setAssignTagName:()=>{},setSidebarPage:()=>{}},'fresh','shared-fresh')}
  const initial=dialogs();assert.equal(events.length,0,'composition cannot execute commands')
  initial.runContextRename();assert.equal(renameTarget.name,'old');assert.equal(renameValue,'old')
  renameValue='renamed';await dialogs().confirmRename();assert.equal(renameTarget,null);assert.deepEqual(plain(library.fonts.a.localTagNames),['renamed']);assert.deepEqual(plain(queued[0].tags),['renamed'])
  assert.equal(library.fonts.a.favorite,true);assert.equal(library.fonts.a.deleteProtected,true);assert.deepEqual(plain(library.fonts.a.tagNames),['shared'])
  dialogs().createTagOnlyFromInput();assert(library.localTags.includes('fresh'))
  deleteTarget={kind:'tag',scope:'local',name:'renamed'};events.length=0;await dialogs().confirmDelete();assert.deepEqual(events,['flush','delete-ipc','refresh']);assert.equal(deleteTarget,null)
  const detailEvents=[],noop=()=>{},detail=detailFactory({selectedFont:font,detailVisible:false,selectedFontId:'',previewFamilies:{a:'family'},library,setLibrary,setSelectedFontId:x=>detailEvents.push(['id',x]),setDetailVisible:x=>detailEvents.push(['visible',x]),setNativeDetailImage:noop,hfm:{},localTagSuggestions:['local-choice'],activeLocalTagSuggestionIndex:0,assignTagName:'typed',setActiveLocalTagSuggestionIndex:noop,addTagToSelectedByName:x=>detailEvents.push(['local',x]),setAssignTagName:noop,sharedTagSuggestions:['shared-choice'],activeSharedTagSuggestionIndex:0,assignSharedTagName:'',setActiveSharedTagSuggestionIndex:noop,addSharedTagToSelectedByName:x=>detailEvents.push(['shared',x]),setAssignSharedTagName:noop})
  assert.equal(detailEvents.length,0)
  const key=(composing=false)=>({key:'Enter',nativeEvent:{isComposing:composing},preventDefault(){}})
  detail.handleLocalTagInputKeyDown(key(true));assert.equal(detailEvents.length,0)
  detail.handleLocalTagInputKeyDown(key());detail.handleSharedTagInputKeyDown(key());assert.deepEqual(detailEvents,[['local','local-choice'],['shared','shared-choice']])
  let selectionOptions;const selection=detail.createSelection(options=>{selectionOptions=options;return {handleFontSelect:()=>{options.hydrateFont(font);options.toggleFontDetail(font)}}},{visibleFonts:[font],setSingleFontSelection:noop,setStatus:noop,reportUserActivity:noop,userActivityIdleWindowMs:100})
  assert.equal(selectionOptions.toggleFontDetail,detail.toggleFontDetail)
  selection.handleFontSelect();assert(library.fonts.a);assert.deepEqual(detailEvents.slice(-2),[['id','a'],['visible',true]])
  detail.closeDetail();assert.deepEqual(detailEvents.slice(-2),[['id',''],['visible',false]])
}
async function main(){structure();portCases();await interactions();
  assert.throws(()=>portCases(s=>s.replace("if (!operations) throw new Error('App Operations commands used before initialization')",'')),assert.AssertionError)
  await assert.rejects(()=>interactions({[dir+'createAppDetailSelectionRuntime.ts']:s=>s.replace('toggleFontDetail: detail.toggleFontDetail','toggleFontDetail: () => {}')}),assert.AssertionError)
  console.log('[diagnostics:app-interaction-composition] effective inputs/hook order, early callback guard, real menu/dialog rename/delete, tag IME/local/shared, detail-selection hydration wiring; two mutants; existing controller gates cover click/marquee/races')}
module.exports={callMap,digest}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
