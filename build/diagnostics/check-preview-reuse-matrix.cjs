#!/usr/bin/env node
// Actual SQLite/files/cache owners. PNG production and shared availability are controlled.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto')
const {DatabaseSync}=require('node:sqlite')
const {loader}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'),base='src/main/preview/runtime/'
let checks=0
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++}
async function run(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-u08-preview-'))
  const env={...process.env,HFM_PREVIEW_CACHE_KEY_STRICT:'0'}
  const load=loader({[path.join(root,'src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts')]:{hasDirectWritePreviewHelper:()=>false}},{process:{...process,env}})
  const sha1=x=>crypto.createHash('sha1').update(x).digest('hex')
  const logs=[],library={folders:[dir]},indexes=new Map();let sharedReads=0
  const dbFor=storage=>{
    const p=storage.storage==='local'?path.join(dir,'local.sqlite'):path.join(dir,'shared.sqlite')
    if(!indexes.has(p)) {const db=new DatabaseSync(p);db.exec('CREATE TABLE IF NOT EXISTS preview_cache(preview_key TEXT PRIMARY KEY,output_path TEXT,status TEXT,accessed_at TEXT,updated_at TEXT)');indexes.set(p,db)}
    return indexes.get(p)
  }
  const writeIndex=async(storage,key,data)=>dbFor(storage).prepare('INSERT OR REPLACE INTO preview_cache VALUES(?,?,?,?,?)').run(key,data.outputPath,data.status,'','')
  const options={sha1,normalizePathForCacheCompare:p=>p.toLowerCase(),normalizePreviewCacheIndexStatus:x=>x,appendStartupLog:s=>logs.push(s),previewSqliteSchemaVersion:1}
  const tier=load(base+'previewCacheTierRuntime.ts').createPreviewCacheTierRuntime({...options,localPreviewImageDir:()=>path.join(dir,'local'),rootPreviewImageDir:()=>path.join(dir,'shared'),rootPreviewDbPath:()=>path.join(dir,'shared.sqlite')})
  const selectStorage=p=>tier.localStorageForRoot(dir,p.toLowerCase())
  const rows=load(base+'previewBatchRowsRuntime.ts').createPreviewBatchRowsRuntime(options,selectStorage)
  const hydrationOptions={appendStartupLog:options.appendStartupLog,withIoDeadlineResult:async(_label,fn)=>{try{return{ok:true,value:await fn()}}catch(error){return{ok:false,error}}},
    readPreviewCacheIndexStatus:async(storage,key)=>{sharedReads++;return dbFor(storage).prepare('SELECT status FROM preview_cache WHERE preview_key=?').get(key)?.status||null},writePreviewCacheIndex:writeIndex,previewCacheStorageToShared:tier.previewCacheStorageToShared,ensureSharedAvailable:async()=>true}
  const create=()=>load(base+'previewBatchReadRuntime.ts').createPreviewBatchReadRuntime(options,{
    ...rows,loadLibraryShellCached:async()=>library,withPreviewIndexDb:async(storage,fn)=>fn(dbFor(storage)),
    rootAvailability:{ensureRootPreviewCacheAvailable:async()=>true,markRootPreviewCacheUnavailable(){}},
    rustPreviewDbPathForStorage:()=>null,runStoragePreviewCacheIo:async(_storage,_label,fn)=>({ok:true,value:await fn()}),
    prefetchRuntime:{schedulePreviewCachePrefetch(){}},hydrationRuntime:load(base+'previewCacheHydrationRuntime.ts').createPreviewCacheHydrationRuntime(hydrationOptions)
  })
  const png=require('./fixtures/preview-png.cjs')
  const font={id:'a',path:path.join(dir,'a.ttf'),fileName:'a.ttf',family:'Fixture',fileSize:1000,modifiedAt:1700000000000,active:false}
  const rowFor=(item=font,text='预览',size=34,width=520,height=150)=>[...rows.buildPreviewCacheGroups([item],library,text,size,width,height).values()][0].rows[0]
  const seed=async(row,shared=false)=>{let storage=selectStorage(font.path);if(shared)storage=tier.previewCacheStorageToShared(storage);const outputPath=shared?path.join(storage.dir,row.previewKey+'.png'):row.outputPath;fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,png);await writeIndex(storage,row.previewKey,{outputPath,status:'ok'})}
  const assertHit=async(runtime,item=font,text='预览',size=34,width=520,height=150)=>eq((await runtime.readCachedPreviewImages([item],text,size,width,height))[item.id],'data:image/png;base64,'+png.toString('base64'),'expected exact cached PNG')
  try {
    let runtime=create();eq(Object.keys(await runtime.readCachedPreviewImages([font],'预览')).length,0,'cold miss must not fabricate a hit')
    const original=rowFor();await seed(original);const beforeWarm=sharedReads
    await assertHit(runtime);await assertHit(runtime);eq(sharedReads,beforeWarm,'local hit probed shared tier')
    // Separate font/page then revisit; changing selection/favorite cannot alter the complete key.
    await runtime.readCachedPreviewImages([{...font,id:'b',path:path.join(dir,'b.ttf')}],'预览')
    await assertHit(runtime,{...font,favorite:true,localTagNames:['tag'],deleteProtected:true})
    for(const [item,text,size,width,height] of [
      [{...font,fileSize:1001},'预览',34,520,150],[{...font,modifiedAt:font.modifiedAt+1},'预览',34,520,150],
      [font,'预览新字',34,520,150],[font,'预览',35,520,150],[font,'预览',34,521,150],[font,'预览',34,520,151]
    ]) {assert.notEqual(rowFor(item,text,size,width,height).previewKey,original.previewKey);checks++;eq(Object.keys(await runtime.readCachedPreviewImages([item],text,size,width,height)).length,0,'changed input reused old image')}
    const active={...font,active:true};const activated=rowFor(active)
    assert.notEqual(activated.previewKey,original.previewKey);checks++
    eq(Object.keys(await runtime.readCachedPreviewImages([active],'预览')).length,0,'new installed route should be cold')
    await seed(activated);await assertHit(runtime,active);await assertHit(runtime,active);await assertHit(runtime,font)
    // Reconstruct runtime and SQLite handles, preserving only on-disk data.
    for(const db of indexes.values())db.close();indexes.clear();runtime=create();const beforeRestart=sharedReads
    await assertHit(runtime);await assertHit(runtime,active);eq(sharedReads,beforeRestart,'restart lost local on-disk hit')
    const shared=rowFor(font,'共享样本');await seed(shared,true);const beforeHydrate=sharedReads
    await Promise.all([assertHit(runtime,font,'共享样本'),assertHit(runtime,font,'共享样本')])
    eq(sharedReads,beforeHydrate+1,'same shared hydration was not coalesced')
    eq(fs.readFileSync(shared.outputPath).equals(png),true,'shared PNG not copied intact')
    await assertHit(runtime,font,'共享样本');eq(sharedReads,beforeHydrate+1,'hydrated image failed local reuse')
    const keys=load(base+'previewCacheKeyRuntime.ts'),args=[sha1,font.path,1000,1700000000000,34,520,150,'预览']
    assert.notEqual(keys.previewCacheKey(...args,'renderer-a'),keys.previewCacheKey(...args,'renderer-b'));checks++
    env.HFM_PREVIEW_CACHE_KEY_STRICT='1';const strict=keys.previewCacheKey(...args);env.HFM_PREVIEW_DPI_BUCKET='dpi-other';assert.notEqual(keys.previewCacheKey(...args),strict);checks++
    const dpi=keys.previewCacheKey(...args);env.HFM_PREVIEW_FOREGROUND_MODE='foreground-other';assert.notEqual(keys.previewCacheKey(...args),dpi);checks++
    console.log(`[diagnostics:preview-reuse-matrix] ${checks} checks passed; actual SQLite + PNG, controlled generation/network; no cache production changes`)
  } finally {for(const db of indexes.values())db.close();fs.rmSync(dir,{recursive:true,force:true})}
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1})
module.exports={run}
