const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const timers=[]
const root = path.resolve(__dirname, '../..'), cache = new Map()
function load(file, mocks = {}) {
  file = file.replace(/\\/g, '/')
  if (cache.has(file)) return cache.get(file)
  const exports = {}; cache.set(file,exports)
  let source = fs.readFileSync(path.join(root,file),'utf8')
  const mutation=process.argv[2]
  if(mutation==='active') source=source.replace('...intent.active,','')
  if(mutation==='favorite') source=source.replace('favorite && (!favorite.settled || incoming.favorite !== favorite.value)','false')
  if(mutation==='query') source=source.replaceAll('intentRevision !== fontUserIntentRevision()', 'false')
  if(mutation==='membership') source=source.replace('const candidates = [...items, ...pending]','const candidates = items')
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,console,performance,window:{setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout(){}},require(id){
    if (id in mocks) return mocks[id]
    if (id.startsWith('.')) return load(path.relative(root,path.resolve(root,path.dirname(file),id+'.ts')),mocks)
    throw Error(id)
  }})
  return exports
}
const base='src/renderer/src/'
const mocks={
 '../appConstants':{FONT_OBJECT_LRU_LIMIT:1000},
 '@shared/legacy/legacyCollectionCompatibility':{normalizeLegacyCollectionIds:x=>x||[]},
 '../fontClassification':{},
 './libraryNormalizeBase':{normalizeFolderPathForCompare:x=>x.toLowerCase(),normalizeFontPathForCompare:x=>x.toLowerCase()},
 './libraryNormalizeStateRuntime':{pruneFontFolderIds:ids=>ids},
 './appConstants':{},
 './fontFilteringMetrics':{buildFontComputedIndex:f=>({searchText:'alpha',bad:false,active:f.active}),filterMatchesFontIndex:(filter,f)=>filter.kind==='favorites'?f.favorite:filter.kind==='active'?f.active:true,inTimeSortRangeIndex:()=>true},
 './fontSort':{compareFontsForSort:(a,b)=>a.id.localeCompare(b.id),compareFontsForTimeSort:(a,b)=>a.id.localeCompare(b.id)},
 './libraryNormalize':{},
 './libraryFolderTreeRuntime':{buildFolderTreeFromCachedFonts:()=>({nodes:[]})}
}
const font={id:'a',path:'/fonts/a.ttf',favorite:false,active:true,tagNames:[],collectionIds:[],systemInstalled:false,systemInstallMatches:[]}
const install=load(base+'fontInstallStateRuntime.ts',mocks)
const normalize=load(base+'library-normalize/libraryNormalizeStateRuntime.ts',mocks)
let stopped=install.applyFontActiveRuntimePatch(font,false)
let library={fonts:{a:stopped},folders:[],tags:[],localTags:[]}
library=normalize.libraryWithMergedFonts(library,[font])
assert.equal(library.fonts.a.active,false,'old page must not reactivate a stopped font')
console.log('user intent consistency passed')
const intent=load(base+'fontUserIntentRuntime.ts',mocks)
assert.equal(load((base+'fontUserIntentRuntime.ts').replaceAll('/', '\\'),mocks),intent,'path aliases must share the same module instance')
const view=load(base+'fontViewRuntime.ts',mocks)
const plain=x=>JSON.parse(JSON.stringify(x))
let fav=intent.markFavoriteIntent(stopped,true)
library={...library,fonts:{a:fav}}
library=normalize.libraryWithMergedFonts(library,[{...font,favorite:false}])
assert.equal(library.fonts.a.favorite,true,'uncommitted favorite must survive old query')
assert.equal(library.fonts.a.active,false)
const options={databasePageReady:true,databasePageResult:{items:[]},allFonts:[library.fonts.a],fontIndexById:new Map(),deferredSearch:'',activeFilter:{kind:'favorites'},sidebarPage:'library',timeSortMode:'all',sortMode:'name',library,selectedWatchedFolders:[],selectedFormats:[],selectedScripts:[],selectedCategory:'all',selectedTagName:'',selectedSharedTagName:'',selectedFolderId:'',installStatus:'all'}
assert.deepEqual(plain(view.buildVisibleFonts(options).map(f=>f.id)),['a'],'pending favorite must appear even with empty page')
assert.equal(view.buildVisibleFonts({...options,deferredSearch:'unmatched'}).length,0,'overlay must respect search')
assert.equal(view.buildVisibleFonts({...options,activeFilter:{kind:'active'},databasePageResult:{items:[font]}}).length,0,'stopped favorite must not enter active list')
const rev=intent.fontUserIntentRevision()
intent.settleFavoriteIntent({...fav})
assert(intent.fontUserIntentRevision()>rev,'write settlement invalidates in-flight reads')
library=normalize.libraryWithMergedFonts(library,[{...font,favorite:true,active:false}])
assert.equal(intent.hasFavoriteIntent(library.fonts.a),false,'matching committed read releases favorite intent')
library=normalize.libraryWithMergedFonts(library,[{...font,favorite:false,active:false}])
assert.equal(library.fonts.a.favorite,false,'later authoritative external favorite change accepted')
const unfav=intent.markFavoriteIntent({...stopped,favorite:true},false)
const hidden=view.buildVisibleFonts({...options,allFonts:[unfav],library:{...library,fonts:{a:unfav}},databasePageResult:{items:[{...font,favorite:true}]}})
assert.equal(hidden.length,0,'unfavorite removes stale page membership immediately')
let latest=intent.markFavoriteIntent(fav,false)
intent.settleFavoriteIntent(fav)
latest=intent.mergeFontUserIntent(latest,{...font,favorite:true})
assert.equal(latest.favorite,false,'old write completion cannot settle newer toggle')
const restored=JSON.parse(JSON.stringify(install.applyFontActiveRuntimePatch(stopped,true)))
assert.equal(intent.mergeFontUserIntent(restored,{...font,active:false}).active,false,'session intent must not persist across restart')
assert.equal(install.applyFontActiveRuntimePatch({...font,systemInstalled:true},false).systemInstalled,true,'system installation is independent')
assert(!JSON.stringify(fav).includes('settled'))
assert.equal(Object.getOwnPropertySymbols(structuredClone(fav)).length,0)
console.log('favorite membership, stale activation, acknowledgment, newer toggles, search and session boundaries passed')

async function queueSettlementCheck() {
  const queueApi=load(base+'fontWriteQueue.ts',mocks)
  for(const success of [false,true]) {
    const f=intent.markFavoriteIntent({...font,active:false},true)
    const queue=queueApi.createEmptyQueuedFontWriteState()
    queue.favorite.set(f.id,{font:{...f},favorite:true})
    const result=await queueApi.flushQueuedFontWriteQueue({queue,folders:[],hfm:{setFavorite:async()=>success?{ok:true,updatedIds:['a'],failed:[]}:{ok:false,updatedIds:[],failed:[{id:'a',message:'denied'}]}}})
    assert.equal(result.retryQueue.favorite.size,success?0:1)
    const merged=intent.mergeFontUserIntent(f,{...font,favorite:true})
    assert.equal(intent.hasFavoriteIntent(merged),!success,'only confirmed write releases matching read')
  }
  await queryRaceCheck()
  if(!process.argv[2]) {
    for(const mutant of ['active','favorite','membership','query']) {
      const r=require('node:child_process').spawnSync(process.execPath,[__filename,mutant],{encoding:'utf8'})
      assert.notEqual(r.status,0,mutant+' escaped');assert(r.stderr.includes('AssertionError'),r.stderr)
    }
  }
  console.log('real write queue success/failure settlement; four regression mutations rejected')
}
queueSettlementCheck().catch(e=>{console.error(e);process.exitCode=1})

async function queryRaceCheck() {
  const effects=[],traces=[];let resolveQuery,pageWrites=0
  const response=new Promise(resolve=>{resolveQuery=resolve})
  const hook=load(base+'runtime/database/useRendererDatabasePageRuntime.ts',{
    ...mocks,
    react:{useEffect:fn=>effects.push(fn),useMemo:fn=>fn(),useState:()=>[0,()=>{}]},
    '../../appRuntime':{rendererFontQueryCacheKey:JSON.stringify,libraryWithMergedFonts:normalize.libraryWithMergedFonts},
    './rendererDatabasePageWindowRuntime':{buildRendererDatabasePageWindow:()=>({offset:0,limit:100,columns:1})}
  }).useRendererDatabasePageRuntime
  const cleanup=[]
  hook({...options,library:{...library,folders:['/fonts']},libraryLoadedRef:{current:true},hfm:{queryFontPage:()=>response},databasePageResult:null,databasePageRequestSeqRef:{current:0},fontListScrollingRef:{current:false},virtualViewport:{width:500,height:500,scrollTop:0},viewLayout:{rowHeight:100,minCardWidth:100},reportTrace:e=>traces.push(e),setDatabasePageResult:()=>{pageWrites++},setDatabaseQueryResult(){},setDatabaseQueryFailedKey(){},setLibrary(){}})
  for(const effect of effects)cleanup.push(effect())
  for(const timer of timers.splice(0))timer()
  intent.markFavoriteIntent(font,true)
  resolveQuery({items:[font],total:1,offset:0,limit:100})
  for(let i=0;i<10;i++)await Promise.resolve()
  assert.equal(pageWrites,0,'late real hook response must be rejected after mutation')
  assert(traces.some(e=>e.label==='user-intent-changed'),'rejection must be logged')
  for(const fn of cleanup)if(typeof fn==='function')fn()
}

const indexChange=load(base+'library-normalize/libraryIndexChangeRuntime.ts',mocks)
for(const source of ['watcher','shared-metadata']) {
 const current=intent.markFavoriteIntent(install.applyFontActiveRuntimePatch(font,false),true)
 const state={folders:['/fonts'],fonts:{a:current},tags:[],localTags:[]}
 const result=indexChange.applyFontIndexChangeToLibrary(state,{source,folder:'/fonts',upserts:[{...font,favorite:false,active:true}],deletes:[]})
 assert.equal(result.library.fonts.a.active,false,source+' old notification reactivated font')
 assert.equal(result.library.fonts.a.favorite,true,source+' old notification lost favorite')
}
