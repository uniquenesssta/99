#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),crypto=require('node:crypto')
const root=path.resolve(__dirname,'../..'),prefix='src/renderer/src/',controller=prefix+'runtime/app/useBrowseController.ts',derived=prefix+'runtime/app/useBrowseDerivedRuntime.ts',wrapper=prefix+'runtime/app/useAppFontDerivedRuntime.ts'
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n')
function hash(s){const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,s.replace(/\r\n/g,'\n')),tokens=[];while(scanner.scan()!==ts.SyntaxKind.EndOfFileToken)tokens.push(scanner.getTokenText());return crypto.createHash('sha256').update(JSON.stringify(tokens)).digest('hex')}
function declarations(text){const file=ts.createSourceFile('source.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),result={};function walk(n){if(ts.isVariableStatement(n))for(const d of n.declarationList.declarations){if(d.initializer&&ts.isCallExpression(d.initializer)&&['useState','useRef'].includes(d.initializer.expression.getText(file)))result[d.name.getText(file)]=hash(d.getText(file))}ts.forEachChild(n,walk)}walk(file);return result}
const calls=['useDeferredValue','useRendererDatabasePageRuntime','useFontFamilyGroupsRuntime','useFontFilterScrollResetRuntime','useFontViewportResizeObserverRuntime','createAppFontScrollRestoreRuntime','useAppFontShellDerivedRuntime']
function reviewedQueryCall(node, file) {
 const options=node.arguments[0]
 assert(ts.isObjectLiteralExpression(options),'database query options must stay explicit')
 const properties=options.properties
 const status=properties.filter(property=>property.name?.getText(file)==='setStatus')
 const recovered=properties.filter(property=>property.name?.getText(file)==='onReadRecovered')
 assert.equal(status.length,1,'database query status port missing or duplicated')
 assert.equal(recovered.length,1,'database query recovery port missing or duplicated')
 assert(ts.isPropertyAssignment(status[0])&&status[0].initializer.getText(file)==='reportQueryError','database query failure must report independent feedback')
 assert(ts.isPropertyAssignment(recovered[0])&&recovered[0].initializer.getText(file)==='clearQueryError','database query recovery must only clear query feedback')
 assert.equal(properties.at(-2),status[0],'query status port moved relative to the frozen input order')
 assert.equal(properties.at(-1),recovered[0],'query recovery must be the sole appended input')
 // Reverse only these two reviewed properties inside this call. Every other
 // query token, input order and every unrelated call retains the frozen hash.
 const start=node.getStart(file),source=node.getText(file)
 return source.slice(0,status[0].getStart(file)-start)+'setStatus'+source.slice(recovered[0].end-start)
}
function callHashes(text, reviewedFeedback=false){
 const file=ts.createSourceFile('source.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),result=[]
 function walk(node){
  if(ts.isCallExpression(node)&&calls.includes(node.expression.getText(file))){
   const name=node.expression.getText(file)
   result.push([name,hash(reviewedFeedback&&name==='useRendererDatabasePageRuntime'?reviewedQueryCall(node,file):node.getText(file))])
  }
  ts.forEachChild(node,walk)
 }
 walk(file);return result
}
// The row-membership repair changes only the memo's result carrier and callee.
// Reverse those exact reviewed tokens for the original frozen calculation hash;
// do not refresh the baseline or normalize dependency lists/other calculations.
function reviewedDerivedCalculations(text){
 const changes=[['const visibleResult = useMemo(', 'const visibleFonts = useMemo('],['() => buildVisibleFontResult({','() => buildVisibleFonts({']]
 for(const [current,previous] of changes){assert.equal(text.split(current).length,2,'reviewed derivation extension missing or ambiguous');text=text.replace(current,previous)}
 return text
}
function checkSource(fixture,overrides=new Map()){
 const get=p=>overrides.get(p)??read(p),c=get(controller),d=get(derived),w=get(wrapper),app=get(prefix+'App.tsx')
 assert.deepEqual(declarations(c),fixture.states,'state/ref initialization changed')
 for(const key of Object.keys(fixture.states))assert(!Object.hasOwn(declarations(app),key),'duplicate state owner '+key)
 assert.deepEqual(callHashes(app,true),fixture.calls,'deferred/query/family/scroll call or order changed')
 const start=d.indexOf('  const fontIndexById ='),end=d.indexOf('  return {',start)
 assert.equal(hash(reviewedDerivedCalculations(d.slice(start,end))),fixture.derived,'read-only calculations or memo dependencies changed')
 assert(d.includes("import { buildVisibleFontResult } from '../../fontViewRuntime'"),'membership result owner import changed')
 assert.equal(d.slice(end).replace(/\s+/g,''),'return{fontIndexById,fontMetrics,localTagCounts,sharedTagCounts,localTagList,sharedTagList,flatFolderNodes,advancedFilterCount,visibleFonts:visibleResult.fonts,membershipDiagnostics:visibleResult.diagnostics}}','membership result projection changed')
 assert.equal(hash(w.slice(w.indexOf('  useLayoutEffect(() =>'))),fixture.remainder,'preview/selection/layout effects changed')
 const delegation=w.match(/= useBrowseDerivedRuntime\(\{([\s\S]*?)\n  \}\)/);assert(delegation)
 for(const line of delegation[1].trim().split('\n')){const match=line.trim().match(/^(\w+): args\.(\w+),$/);assert(match,'broad or computed derived port');assert.equal(match[1],match[2],'derived port miswired')}
 assert.equal(delegation[1].trim().split('\n').length,19)
 assert(!/\b(useEffect|useLayoutEffect|useState|useRef)\b/.test(d),'derived module owns effects or state')
 assert(!/\b(useEffect|useLayoutEffect)\b/.test(c),'controller introduced effect timing')
 assert.equal((app.match(/= useBrowseController\(/g)||[]).length,1)
}
function behavior(){
 let cursor=0;const slots=[],events=[];const modules=new Map()
 const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value}]},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i]}}
 function load(rel){if(modules.has(rel))return modules.get(rel);const exports={};modules.set(rel,exports);const code=ts.transpileModule(read(rel),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const req=id=>{if(id==='react')return hooks;if(id.endsWith('/appRuntime'))return {...load(prefix+'constants/toolbarStateRuntime.ts'),VIEW_MODE_LAYOUT:{comfortable:{rowHeight:1,minCardWidth:1}},USER_ACTIVITY_IDLE_WINDOW_MS:100};return load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),id))+'.ts')};vm.runInNewContext('(function(require,exports){'+code+'\n})')(req,exports);return exports}
 const hook=load(controller).useBrowseController
 const render=()=>{cursor=0;return hook({reportUserActivity:(...args)=>events.push(args)})}
 let c=render();assert.equal(events.length,0);assert.equal(slots.length,23)
 const ref=c.databasePageRequestSeqRef,scroller=c.fontScrollerRef
 c.updatePageToolbar('search','library search');c.updatePageToolbar('viewMode','compact');c.setSidebarPage('filters');c=render();assert.equal(c.search,'');assert.equal(c.viewMode,'comfortable')
 c.updatePageToolbar('search','filter search');c.updatePageToolbar('sortMode','name');c.setSelectedFormats(()=>['ttf']);c.setSelectedScripts(()=>['latin']);c.setSelectedWatchedFolders(()=>['C:/fonts','D:/fonts']);c.setSelectedCategory('serif');c.setFilterGroupExpanded('scripts',true);c=render()
 assert.equal(c.search,'filter search');assert.equal(c.selectedWatchedFoldersKey,'C:/fonts\u0000D:/fonts');assert.equal(c.selectedFormatsKey,'ttf');assert.equal(c.expandedFilterGroups.scripts,true)
 c.setSidebarPage('library');c=render();assert.equal(c.search,'library search');assert.equal(c.viewMode,'compact');assert.equal(typeof c.setSelectedFormats,'function')
 c.clearAdvancedFilters();c=render();assert.equal(c.selectedFormats.length,0);assert.equal(c.selectedScripts.length,0);assert.equal(c.selectedWatchedFolders.length,0);assert.equal(c.selectedCategory,'all');assert.equal(c.search,'library search')
 ref.current=9;scroller.current={scrollTop:55};c.setVirtualViewport(prev=>({...prev,scrollTop:55}));c=render();assert.equal(c.databasePageRequestSeqRef,ref);assert.equal(c.databasePageRequestSeqRef.current,9);assert.equal(c.fontScrollerRef,scroller);assert.equal(c.virtualViewport.scrollTop,55)
 const page={items:[],total:5};c.setDatabasePageResult(page);c.setDatabaseQueryFailedKey('failed');c=render();assert.equal(c.databasePageResult,page);assert.equal(c.databaseQueryFailedKey,'failed');assert.equal(events.length,4)
}
function main(){const fixture=require('./fixtures/browse-controller.fixture.json');checkSource(fixture);behavior();const c=read(controller);assert.throws(()=>checkSource(fixture,new Map([[controller,c.replace('height: 640','height: 641')]])));const app=read(prefix+'App.tsx');assert.throws(()=>checkSource(fixture,new Map([[prefix+'App.tsx',app.replace('useDeferredValue(search)','useDeferredValue(status)')]])));const d=read(derived)
 for(const [before,after] of [['library.__localTagAuthorityKnown, library.__sharedTagAuthorityKnown','library.__sharedTagAuthorityKnown'],['visibleFonts: visibleResult.fonts','visibleFonts: allFonts'],['membershipDiagnostics: visibleResult.diagnostics','membershipDiagnostics: undefined']]){
  assert(d.includes(before),'derived negative anchor missing');assert.throws(()=>checkSource(fixture,new Map([[derived,d.replace(before,after)]])),assert.AssertionError)
 }
 for(const [before,after] of [['setStatus: reportQueryError','setStatus'],['onReadRecovered: clearQueryError','onReadRecovered: dismissActionStatus'],['    onReadRecovered: clearQueryError','    onReadRecovered: clearQueryError,\n    extraQueryOption: true']]){
  assert(app.includes(before),'query feedback negative anchor missing')
  assert.throws(()=>checkSource(fixture,new Map([[prefix+'App.tsx',app.replace(before,after)]])),assert.AssertionError,'wrong query feedback or extra input escaped frozen call gate')
 }
 checkSource(fixture,new Map([[controller,c.replace(/\n/g,'\r\n')],[derived,d.replace(/\n/g,'\r\n')],[prefix+'App.tsx',app.replace(/\n/g,'\r\n')]]));console.log('[diagnostics:browse-controller] 16 states/7 refs, per-page toolbar and filters, separate query failure/recovery with frozen query/scroll/deferred call baselines, original derived hash retained through exact reviewed result-carrier inverse; frozen preview/selection, derivation and feedback mutations and CRLF passed')}
module.exports={hash,declarations,callHashes}
if(require.main===module)main()
