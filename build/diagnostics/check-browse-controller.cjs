#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),crypto=require('node:crypto')
const root=path.resolve(__dirname,'../..'),prefix='src/renderer/src/',controller=prefix+'runtime/app/useBrowseController.ts',derived=prefix+'runtime/app/useBrowseDerivedRuntime.ts',wrapper=prefix+'runtime/app/useAppFontDerivedRuntime.ts'
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n')
function hash(s){const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,s.replace(/\r\n/g,'\n')),tokens=[];while(scanner.scan()!==ts.SyntaxKind.EndOfFileToken)tokens.push(scanner.getTokenText());return crypto.createHash('sha256').update(JSON.stringify(tokens)).digest('hex')}
function declarations(text){const file=ts.createSourceFile('source.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),result={};function walk(n){if(ts.isVariableStatement(n))for(const d of n.declarationList.declarations){if(d.initializer&&ts.isCallExpression(d.initializer)&&['useState','useRef'].includes(d.initializer.expression.getText(file)))result[d.name.getText(file)]=hash(d.getText(file))}ts.forEachChild(n,walk)}walk(file);return result}
const calls=['useDeferredValue','useRendererDatabasePageRuntime','useFontFamilyGroupsRuntime','useFontFilterScrollResetRuntime','useFontViewportResizeObserverRuntime','createAppFontScrollRestoreRuntime','useAppFontShellDerivedRuntime']
function callHashes(text){const file=ts.createSourceFile('source.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),result=[];function walk(n){if(ts.isCallExpression(n)&&calls.includes(n.expression.getText(file)))result.push([n.expression.getText(file),hash(n.getText(file))]);ts.forEachChild(n,walk)}walk(file);return result}
function checkSource(fixture,overrides=new Map()){
 const get=p=>overrides.get(p)??read(p),c=get(controller),d=get(derived),w=get(wrapper),app=get(prefix+'App.tsx')
 assert.deepEqual(declarations(c),fixture.states,'state/ref initialization changed')
 for(const key of Object.keys(fixture.states))assert(!Object.hasOwn(declarations(app),key),'duplicate state owner '+key)
 assert.deepEqual(callHashes(app),fixture.calls,'deferred/query/family/scroll call or order changed')
 const start=d.indexOf('  const fontIndexById ='),end=d.indexOf('  return {',start)
 assert.equal(hash(d.slice(start,end)),fixture.derived,'read-only calculations or memo dependencies changed')
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
function main(){const fixture=require('./fixtures/browse-controller.fixture.json');checkSource(fixture);behavior();const c=read(controller);assert.throws(()=>checkSource(fixture,new Map([[controller,c.replace('height: 640','height: 641')]])));const app=read(prefix+'App.tsx');assert.throws(()=>checkSource(fixture,new Map([[prefix+'App.tsx',app.replace('useDeferredValue(search)','useDeferredValue(status)')]])));checkSource(fixture,new Map([[controller,c.replace(/\n/g,'\r\n')],[derived,read(derived).replace(/\n/g,'\r\n')]]));console.log('[diagnostics:browse-controller] 16 states/7 refs, per-page toolbar and filters, query/scroll/deferred call baselines, frozen derived/preview/selection bodies, two mutations and CRLF passed')}
module.exports={hash,declarations,callHashes}
if(require.main===module)main()
