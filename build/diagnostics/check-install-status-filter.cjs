#!/usr/bin/env node
// U-04: real TSX/controller/request/SQL/memory/page owner; SQLite is real, host hooks/IPC are controlled.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite')
const {loadModules,font,plain,noop,tick,renderer,root}=require('./check-activation-entry.cjs')
const {loader}=require('./check-operation-chain.cjs')
let cases=0
function hooks(){let cursor=0,pending=[];const slots=[];return {begin(){cursor=0;pending=[]},flush(){for(const f of pending)f()},useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v]},useRef:v=>{const i=cursor++;return slots[i]||=( {current:v})},useMemo(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j]))slots[i]={deps,value:fn()};return slots[i].value},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){pending.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()}})}},useCallback(fn){return fn}}}
function renderLoader(hook,globals={},transforms={}){const base=loadModules(globals,{}),app={...base(renderer+'libraryNormalize.ts'),...base(renderer+'fontDisplay.ts'),...base(renderer+'fontClassification.ts'),...base(renderer+'constants/toolbarStateRuntime.ts'),...base(renderer+'constants/queryCacheRuntime.ts'),...base(renderer+'constants/filterConstants.ts'),VIEW_MODE_LAYOUT:{comfortable:{rowHeight:100,minCardWidth:100}},USER_ACTIVITY_IDLE_WINDOW_MS:100,IS_DEVELOPMENT:false,getVirtualGridColumns:()=>1,reportRendererTrace:noop};return loadModules(globals,{react:hook,[path.join(root,renderer+'appRuntime.ts')]:app},transforms)}
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return [];if(typeof tree.type==='function'&&['InstallStatusControl','NameSortCycleButton','CardPoolViewToggle','ListPreviewSizeControl'].includes(tree.type.name))return nodes(tree.type(tree.props));return [tree,...nodes(tree.props?.children)]}
const scopes=[['library','all'],['library','favorites'],['folders','all'],['tags','all'],['sharedTags','all'],['filters','all']]
const states=['all','installed','notInstalled']
const records=[]
for(const group of ['a','b'])for(const favorite of [false,true])for(const kind of ['i','n','t','b','u']){const id=group+Number(favorite)+kind;records.push({...font(id),path:`C:\\fonts\\${group==='a'?'scope':'other'}\\${id}.ttf`,favorite,systemInstalled:['i','b'].includes(kind),installStatusKnown:kind!=='u',systemInstallMatches:kind==='u'?[{family:'old',path:'C:\\old.ttf'}]:[],active:['t','b'].includes(kind),localTagNames:group==='a'?['L']:[],tagNames:group==='a'?['S']:[],scripts:['latin'],group,kind})}
const library={fonts:Object.fromEntries(records.map(f=>[f.id,f])),folders:['C:\\fonts'],folderNodes:[{id:'C:\\fonts\\scope',parentId:'C:\\fonts'}],fontFolderIds:{},tags:['S'],localTags:['L'],collections:[]}
function options(page,kind,status){return {sidebarPage:page,activeFilter:{kind},installStatus:status,deferredSearch:'',databasePageLimit:2,databasePageOffset:0,selectedFolderId:'C:\\fonts\\scope',selectedTagName:'L',selectedSharedTagName:'S',selectedWatchedFolders:['C:\\fonts\\scope'],selectedFormats:['ttf'],selectedScripts:['latin'],selectedCategory:'all',timeSortMode:'all',sortMode:'nameAsc',library,allFonts:records,databasePageReady:false,fontIndexById:new Map()}}
function expected(page,kind,status){return records.filter(f=>(page==='library'?(kind!=='favorites'||f.favorite):f.group==='a')&&(status==='all'||(status==='installed'?['i','b'].includes(f.kind):['n','t'].includes(f.kind)))).map(f=>f.id).sort()}
function fixture(load){
 const db=new DatabaseSync(':memory:');db.exec(`ATTACH DATABASE ':memory:' AS local_db; ATTACH DATABASE ':memory:' AS install_db;
 CREATE TABLE entries(root_path TEXT,relative_path TEXT,cache_key TEXT,file_size INTEGER,modified_at INTEGER,created_at INTEGER,status TEXT,font_json TEXT,message TEXT,cached_at TEXT,installed INTEGER,installed_by TEXT,matches_json TEXT,is_deleted INTEGER,search_text TEXT,category_index TEXT);
 CREATE TABLE local_db.local_font_favorites(font_id TEXT,font_path TEXT,favorite INTEGER); CREATE TABLE local_db.local_font_tags(font_id TEXT,font_path TEXT,tag_name TEXT);
 CREATE TABLE install_status(font_id TEXT,installed INTEGER,by_type TEXT,matches_json TEXT,system_default INTEGER);
 CREATE TABLE install_db.install_status(font_id TEXT,installed INTEGER,by_type TEXT,matches_json TEXT,system_default INTEGER);
 CREATE TABLE fonts(id TEXT PRIMARY KEY); CREATE TABLE font_details(font_id TEXT,json TEXT); CREATE TABLE font_search(font_id TEXT,search_text TEXT);
 CREATE TABLE font_folder_ids(font_id TEXT,folder_id TEXT); CREATE TABLE font_scripts(font_id TEXT,script TEXT); CREATE TABLE font_collections(font_id TEXT,collection_id TEXT); CREATE TABLE font_tags(font_id TEXT,tag_name TEXT);
 CREATE TABLE local_font_tags(font_id TEXT,font_path TEXT,tag_name TEXT);`)
 load('src/main/library/runtime/librarySchemaRuntime.ts').ensureStructuredFontsSchema(db,(db,table,col,type)=>db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`))
 db.function('hfm_shared_font_id',(relative,_size,_mtime)=>String(relative).split(/[\\/]/).at(-1).replace('.ttf',''))
 const mapper=load('src/main/library/fontSqliteMapper.ts')
 for(const f of records){const raw=f.kind==='u'?null:f.kind==='n'?0:1,by=f.kind==='t'?'managed':f.kind==='b'?'both':f.kind==='i'?'system':'none',relative=f.path.slice('C:\\fonts\\'.length).replaceAll('\\','/')
  db.prepare("INSERT INTO entries VALUES ('C:\\fonts',?,'',1,1,1,'ok',?,'','',?,?,'[]',0,?,'serif')").run(relative,JSON.stringify(f),raw,by,f.fileName)
  for(const table of ['install_status','install_db.install_status'])if(raw!==null)db.prepare(`INSERT INTO ${table} VALUES (?,?,?,'[]',0)`).run(f.id,raw,by)
  db.prepare("INSERT INTO local_db.local_font_favorites VALUES (?,'',?)").run(f.id,Number(f.favorite))
  for(const table of ['local_font_tags','local_db.local_font_tags'])if(f.group==='a')db.prepare(`INSERT INTO ${table} VALUES (?,'','L')`).run(f.id)
  if(f.group==='a')db.prepare("INSERT INTO font_tags VALUES (?,'S')").run(f.id)
  db.prepare("INSERT INTO font_scripts VALUES (?,'latin')").run(f.id)
  db.prepare('INSERT INTO font_search VALUES (?,?)').run(f.id,f.fileName)
  const params=mapper.fontToSqliteParams(f.id,f,'now'),keys=Object.keys(params);db.prepare(`INSERT INTO fonts (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(params))
 }
 return db
}
async function matrix(transforms={}){
 const load=loader({'node:path':path.win32}, {},transforms),r=renderLoader(hooks(),{},transforms),db=fixture(load),view=r(renderer+'fontViewRuntime.ts'),index=r(renderer+'fontFilteringMetrics.ts').buildFontComputedIndex
 const main=load('src/main/library/fontMemoryQueryRuntime.ts').createFontMemoryQueryRuntime({resultCacheMax:100,resultCacheTtlMs:10000,appWatchedFolders:async()=>library.folders,loadSharedFontsForFolders:async()=>records,hydrateLocalTagsForFonts:async f=>f,hydrateInstallStatusForFonts:async f=>f,normalizePathForCacheCompare:p=>p.replaceAll('/','\\').toLowerCase(),isSystemInstalledRecord:()=>false,isPathInWindowsFonts:()=>false,inferFontSearchCategory:()=> 'serif'})
 const merged=load('src/main/indexing/root-query/mergedIndexPageQuerySql.ts'),rootSql=load('src/main/indexing/root-query/rootIndexPageQuerySql.ts'),local=load('src/main/library/fontQuerySqlRuntime.ts')
 try {for(const [page,kind] of scopes)for(const status of states){const opts=options(page,kind,status),request=view.createRendererFontQueryRequest(opts),want=expected(page,kind,status);opts.fontIndexById=new Map(records.map(f=>[f.id,index(f)]))
  assert.deepEqual(plain(view.buildVisibleFonts(opts).map(f=>f.id).sort()),want,`renderer ${page}/${kind}/${status}`)
  assert.deepEqual(plain((await main.cleanSharedFontsForQuery(request)).map(f=>f.id).sort()),want,`main memory ${page}/${kind}/${status}`)
  const build=merged.buildMergedIndexQuerySql(request,2,0),count=db.prepare(build.countSql).get(...build.countParams).count;assert.equal(count,want.length)
  const found=[];for(let offset=0;offset<count;offset+=2){const q=merged.buildMergedIndexQuerySql(request,2,offset);found.push(...db.prepare(q.sql).all(...q.params).map(row=>JSON.parse(row.font_json).id))}assert.deepEqual(found.sort(),want,`SQL ${page}/${kind}/${status}`)
  const ids=merged.buildMergedIndexIdsQuerySql(request,100);assert.deepEqual(db.prepare(ids.sql).all(...ids.params).map(r=>r.id).sort(),want)
  const oldSql=local.buildFontQueryPageSql({...request,limit:100});assert.equal(db.prepare(oldSql.countSql).get(...oldSql.countParams).count,want.length);assert.deepEqual(db.prepare(oldSql.sql).all(...oldSql.params).map(r=>r.id).sort(),want)
  const rootQuery=rootSql.buildRootIndexQuerySql('C:\\fonts',request,true,100,0);if(!rootQuery.unsupportedReason){assert.equal(db.prepare(rootQuery.countSql).get(...rootQuery.countParams).count,want.length);assert.deepEqual(db.prepare(rootQuery.sql).all(...rootQuery.params).map(row=>JSON.parse(row.font_json).id).sort(),want)}
  const dbRows=records.filter(f=>want.includes(f.id));assert.deepEqual(plain(view.buildVisibleFonts({...opts,databasePageReady:true,databasePageResult:{items:dbRows}}).map(f=>f.id).sort()),want,'optimistic page widened install filter')
  const frontendKey=r(renderer+'constants/queryCacheRuntime.ts').rendererFontQueryCacheKey(request);assert.equal(frontendKey,local.fontQueryCacheKey(request));assert.notEqual(frontendKey,local.fontQueryCacheKey({...request,installStatus:status==='all'?'installed':'all'}))
  cases++
 }
 const contradiction={...view.createRendererFontQueryRequest(options('library','installed','notInstalled'))};const empty=merged.buildMergedIndexQuerySql(contradiction,100,0);assert.equal(db.prepare(empty.countSql).get(...empty.countParams).count,0);assert.equal((await main.cleanSharedFontsForQuery(contradiction)).length,0);cases++
 }finally{db.close()}
}
function ui(){const hook=hooks(),load=renderLoader(hook),controller=()=>{hook.begin();const c=load(renderer+'runtime/app/useBrowseController.ts').useBrowseController({reportUserActivity:noop});hook.flush();return c};let c=controller()
 for(const page of ['library','filters','tags','sharedTags','folders'])for(const mode of ['grid','list','family']){c.setSidebarPage(page);c=controller();for(const status of states){const tree=load(renderer+'components/app/FontListPanel.tsx').FontListPanel({...c,status:'',cardPoolViewMode:mode,selectedFontIds:[],virtualLayout:{items:[],totalHeight:0,top:0,columns:1},viewLayout:{rowHeight:100,minCardWidth:100},visibleFonts:[],fontFamilyGroupResult:null}),select=nodes(tree).find(n=>n.type==='select'&&n.props['aria-label']==='安装状态');assert(select,'actual toolbar missing');assert.deepEqual(plain(nodes(select).filter(n=>n.type==='option').map(n=>[n.props.value,n.props.children])),[['all','全部状态'],['installed','已安装'],['notInstalled','未安装']]);select.props.onChange({currentTarget:{value:status}});c=controller();assert.equal(c.installStatus,status);assert.equal(c.sidebarPage,page)}cases++}
 c.setSidebarPage('tags');c=controller();c.updatePageToolbar('installStatus','installed');c.setSidebarPage('folders');c=controller();assert.equal(c.installStatus,'notInstalled');c.setSidebarPage('tags');c=controller();assert.equal(c.installStatus,'installed');cases++
 const family=load(renderer+'runtime/family/fontFamilyGroupingRuntime.ts');assert.notEqual(family.fontFamilyQueryScopeKey({installStatus:'installed'}),family.fontFamilyQueryScopeKey({installStatus:'notInstalled'}));cases++
}
async function race(){const hook=hooks(),timers=new Map(),pending=[],published=[],traces=[];let serial=0,result=null,lib=library
 const window={setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id)},load=renderLoader(hook,{window})
 const opts={...options('library','favorites','installed'),hfm:{queryFontPage:r=>new Promise(resolve=>pending.push({r,resolve}))},libraryLoadedRef:{current:true},databaseRefreshToken:0,databaseQueryFailedKey:'',virtualViewport:{width:500,height:400,scrollTop:0},viewLayout:{rowHeight:100,minCardWidth:100},allFontsLength:records.length,indexingActive:false,selectedFontId:'',selectedFontIds:[],fontListScrollingRef:{current:false},fontMetricsRequestSeqRef:{current:0},databasePageRequestSeqRef:{current:0},rendererUserActive:()=>false,reportTrace:e=>traces.push(e),setDatabaseFontMetrics:noop,setDatabasePageResult:r=>{result=r;published.push(r)},setDatabaseQueryResult:noop,setDatabaseQueryFailedKey:noop,setLibrary:fn=>lib=fn(lib),setStatus:noop}
 const render=()=>{hook.begin();const value=load(renderer+'runtime/database/useRendererDatabasePageRuntime.ts').useRendererDatabasePageRuntime({...opts,library:lib,databasePageResult:result});hook.flush();for(const [id,fn] of timers){timers.delete(id);fn()}return value}
 render();assert.equal(pending[0].r.installStatus,'installed');opts.installStatus='notInstalled';render();assert.equal(pending[1].r.offset,0)
 const respond=(p,ids)=>p.resolve({queryKey:load(renderer+'constants/queryCacheRuntime.ts').rendererFontQueryCacheKey(p.r),items:records.filter(f=>ids.includes(f.id)),total:ids.length,offset:0,limit:100,engine:'sql'})
 respond(pending[1],['a1n','a1t']);await tick();respond(pending[0],['a1i']);await tick();assert.equal(published.length,1);assert.deepEqual(plain(result.items.map(f=>f.id).sort()),['a1n','a1t']);assert(render().databasePageReady);cases++
 const scrollHook=hooks(),scrollLoad=renderLoader(scrollHook),ref={current:{scrollTop:500}},reset={fontScrollerRef:ref,setVirtualViewport:fn=>assert.equal(fn({scrollTop:500}).scrollTop,0),installStatus:'installed'}
 scrollHook.begin();scrollLoad(renderer+'runtime/app/effects/useFontFilterScrollResetRuntime.ts').useFontFilterScrollResetRuntime(reset);scrollHook.flush();ref.current.scrollTop=400;scrollHook.begin();scrollLoad(renderer+'runtime/app/effects/useFontFilterScrollResetRuntime.ts').useFontFilterScrollResetRuntime({...reset,installStatus:'notInstalled'});scrollHook.flush();assert.equal(ref.current.scrollTop,0);cases++
}
async function favoriteCombination(){
 const {setup}=require('./check-font-command-entry.cjs'),s=setup(),h=s.base
 h.library.fonts.b.systemInstalled=true;h.library.fonts.c.installStatusKnown=false
 const view=h.load(renderer+'fontViewRuntime.ts'),buildIndex=h.load(renderer+'fontFilteringMetrics.ts').buildFontComputedIndex
 const visible=kind=>view.buildVisibleFonts({...options('library',kind,'notInstalled'),library:h.library,allFonts:Object.values(h.library.fonts),fontIndexById:new Map(Object.values(h.library.fonts).map(f=>[f.id,buildIndex(f)]))})
 h.setVisible(visible('all'));h.select().setSelectedFontIds(visible('all').map(f=>f.id));await h.command()('favorite')
 assert.deepEqual(s.favorites,[['a',true]]);assert.deepEqual(plain(visible('favorites').map(f=>f.id)),['a'])
 await h.command()('unfavorite');assert.deepEqual(s.favorites,[['a',true],['a',false]]);assert.equal(visible('favorites').length,0);assert(!h.library.fonts.b.favorite&&!h.library.fonts.c.favorite)
 h.select().setSelectedFontIds(['a']);h.setScope('library:favorites:notInstalled');assert.equal(h.select().selectedFontIds.length,0,'old filter selection survived scope change');cases++
}
async function main(){
 await matrix();ui();await race();await favoriteCombination()
 const mutants=[
  ['src/main/indexing/root-query/mergedIndexPageQuerySql.ts',"if (request.installStatus === 'notInstalled')","if (request.sidebarPage !== 'library' && request.installStatus === 'notInstalled')"],
  ['src/main/indexing/root-query/rootIndexPageQuerySql.ts',"if (request.installStatus === 'notInstalled')","if (request.sidebarPage !== 'library' && request.installStatus === 'notInstalled')"],
  ['src/main/library/fontMemoryQueryMatcherRuntime.ts',"request.installStatus === 'notInstalled'","request.sidebarPage !== 'library' && request.installStatus === 'notInstalled'"],
  [renderer+'fontViewRuntime.ts','font.installStatusKnown === true && !isInstalled(font)','!isInstalled(font)']
 ]
 for(const [file,from,to] of mutants){const before=cases;assert(fs.readFileSync(path.join(root,file),'utf8').includes(from),'mutation anchor missing: '+file);await assert.rejects(()=>matrix({[path.join(root,file)]:s=>s.replace(from,to)}),assert.AssertionError);cases=before+1}
 console.log(`[diagnostics:install-status-filter] ${cases} scenarios: actual toolbar/controller, six scopes x three states, three SQL builders + SQLite rows/count/IDs/paging, memory and optimistic fallback, permanent/managed/both/unknown, empty intersection, page state/cache keys/late response/scroll reset; four regressions rejected. Controlled DOM/hooks and Windows path adapter; Windows GUI pending.`)
}
main().catch(e=>{console.error(e);process.exitCode=1})
