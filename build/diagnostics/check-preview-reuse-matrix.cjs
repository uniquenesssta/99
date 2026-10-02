#!/usr/bin/env node
// Actual SQLite/files/cache owners. PNG production and shared availability are controlled.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto')
const {DatabaseSync}=require('node:sqlite')
const {loader}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'),base='src/main/preview/runtime/'
let checks=0
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++}
async function run({dropLayout=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-u08-preview-'))
  const env={...process.env,HFM_PREVIEW_CACHE_KEY_STRICT:'0'}
  const rowFile=path.join(root,base+'previewBatchRowsRuntime.ts')
  const load=loader({[path.join(root,'src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts')]:{hasDirectWritePreviewHelper:()=>false}},{process:{...process,env}},dropLayout?{[rowFile]:source=>{assert(source.includes('undefined, layout,'));return source.replace('undefined, layout,','undefined, undefined,')}}:{})
  const sha1=x=>crypto.createHash('sha1').update(x).digest('hex')
  const logs=[],library={folders:[dir]},indexes=new Map();let sharedReads=0,sharedOnline=true
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
    readPreviewCacheIndexStatus:async(storage,key)=>{sharedReads++;return dbFor(storage).prepare('SELECT status FROM preview_cache WHERE preview_key=?').get(key)?.status||null},writePreviewCacheIndex:writeIndex,previewCacheStorageToShared:tier.previewCacheStorageToShared,ensureSharedAvailable:async()=>sharedOnline}
  const pendingHydrations=[];
  const settleHydrations=()=>Promise.all(pendingHydrations.splice(0));
  const hydration=load(base+'previewCacheHydrationRuntime.ts').createPreviewCacheHydrationRuntime(hydrationOptions);
  const create=()=>load(base+'previewBatchReadRuntime.ts').createPreviewBatchReadRuntime(options,{
    ...rows,loadLibraryShellCached:async()=>library,withPreviewIndexDb:async(storage,fn)=>fn(dbFor(storage)),
    rootAvailability:{ensureRootPreviewCacheAvailable:async()=>true,markRootPreviewCacheUnavailable(){}},
    rustPreviewDbPathForStorage:()=>null,runStoragePreviewCacheIo:async(_storage,_label,fn)=>({ok:true,value:await fn()}),
    prefetchRuntime:{schedulePreviewCachePrefetch(storage,rows){pendingHydrations.push(hydration.hydratePreviewCacheRows(storage,rows))}},hydrationRuntime:load(base+'previewCacheHydrationRuntime.ts').createPreviewCacheHydrationRuntime(hydrationOptions)
  })
  const png=require('./fixtures/preview-png.cjs')
  const font={id:'a',path:path.join(dir,'a.ttf'),fileName:'a.ttf',family:'Fixture',fileSize:1000,modifiedAt:1700000000000,active:false}
  const rowFor=(item=font,text='预览',size=34,width=520,height=150,layout)=>[...rows.buildPreviewCacheGroups([item],library,text,size,width,height,undefined,layout).values()][0].rows[0]
  const seed=async(row,shared=false)=>{let storage=selectStorage(font.path);if(shared)storage=tier.previewCacheStorageToShared(storage);const outputPath=shared?path.join(storage.dir,row.previewKey+'.png'):row.outputPath;fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,png);await writeIndex(storage,row.previewKey,{outputPath,status:'ok'})}
  const assertHit=async(runtime,item=font,text='预览',size=34,width=520,height=150,layout)=>eq((await runtime.readCachedPreviewImages([item],text,size,width,height,layout))[item.id],'data:image/png;base64,'+png.toString('base64'),'expected exact cached PNG')
  try {
    let runtime=create();eq(Object.keys(await runtime.readCachedPreviewImages([font],'预览')).length,0,'cold miss must not fabricate a hit')
    // A cold read schedules background work. Finish that scenario before
    // attributing shared access to the subsequent local-hit scenario.
    await settleHydrations()
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
    await settleHydrations();for(const db of indexes.values())db.close();indexes.clear();runtime=create();const beforeRestart=sharedReads
    await assertHit(runtime);await assertHit(runtime,active);eq(sharedReads,beforeRestart,'restart lost local on-disk hit')
    const shared=rowFor(font,'共享样本');await seed(shared,true);const beforeHydrate=sharedReads
    await Promise.all([runtime.readCachedPreviewImages([font],'共享样本'),runtime.readCachedPreviewImages([font],'共享样本')]);await settleHydrations();await assertHit(runtime,font,'共享样本')
    eq(sharedReads,beforeHydrate+1,'same shared hydration was not coalesced')
    eq(fs.readFileSync(shared.outputPath).equals(png),true,'shared PNG not copied intact')
    await assertHit(runtime,font,'共享样本');eq(sharedReads,beforeHydrate+1,'hydrated image failed local reuse')
    // New card layouts must survive actual disk reads/restart/hydration. Seed a
    // legacy image with IDENTICAL scalar arguments so layout omission is visible.
    const card=load('src/shared/preview-layout/previewTextFitRuntime.ts').getCardPreviewLayout
    const params=spec=>[spec.text,spec.fontSize,spec.width,spec.height,spec.nativeLayout]
    for(const strict of ['0','1']) {
      env.HFM_PREVIEW_CACHE_KEY_STRICT=strict
      const text=`安盛aaaa ${strict}\n  Second  `,list=card('list',text,44),grid=card('grid',text,18)
      const records=[]
      for(const spec of [list,grid]) for(const item of [font,active]) {
        const args=params(spec),row=rowFor(item,...args),legacy=rowFor(item,...args.slice(0,4))
        await seed(legacy)
        eq(Object.keys(await runtime.readCachedPreviewImages([item],...args)).length,0,'layout-qualified read reused legacy pixels')
        await seed(row);await assertHit(runtime,item,...args);records.push({item,args,row})
      }
      eq(new Set(records.map(x=>x.row.previewKey)).size,4,'mode/installed route cache identities merged')
      // Hidden list size and invisible third line must not invalidate grid pixels.
      await assertHit(runtime,font,...params(card('grid',text+'\nhidden',72)))
      for(const changed of [card('list',text,72),card('grid',text+'changed',18)])
        eq(Object.keys(await runtime.readCachedPreviewImages([font],...params(changed))).length,0,'changed visible layout reused old pixels')
      await settleHydrations();for(const db of indexes.values())db.close();indexes.clear();runtime=create()
      const before=sharedReads;sharedOnline=false
      for(const {item,args} of records)await assertHit(runtime,item,...args)
      eq(sharedReads,before,'new layout local hit depended on shared availability after restart')
      const remote=card('grid',`共享 ${strict}\n安盛aaaa`,18),args=params(remote),row=rowFor(font,...args)
      await seed(row,true)
      await runtime.readCachedPreviewImages([font],...args);await settleHydrations()
      eq(fs.existsSync(row.outputPath),false,'offline shared image was published locally')
      sharedOnline=true
      await Promise.all([runtime.readCachedPreviewImages([font],...args),runtime.readCachedPreviewImages([font],...args)])
      await settleHydrations();await assertHit(runtime,font,...args)
      eq(sharedReads,before+1,'new layout shared recovery failed to coalesce')
      eq(fs.readFileSync(row.outputPath).equals(png),true,'new layout hydration changed PNG bytes')
    }
    const keys=load(base+'previewCacheKeyRuntime.ts'),args=[sha1,font.path,1000,1700000000000,34,520,150,'预览']
    assert.notEqual(keys.previewCacheKey(...args,'renderer-a'),keys.previewCacheKey(...args,'renderer-b'));checks++
    env.HFM_PREVIEW_CACHE_KEY_STRICT='1';const strict=keys.previewCacheKey(...args);env.HFM_PREVIEW_DPI_BUCKET='dpi-other';assert.notEqual(keys.previewCacheKey(...args),strict);checks++
    const dpi=keys.previewCacheKey(...args);env.HFM_PREVIEW_FOREGROUND_MODE='foreground-other';assert.notEqual(keys.previewCacheKey(...args),dpi);checks++
    console.log(`[diagnostics:preview-reuse-matrix] ${checks} checks passed; actual SQLite + PNG, legacy/strict list/grid/installed identities, restart/offline/shared recovery; controlled generation/network`)
  } finally {await Promise.allSettled(pendingHydrations.splice(0));for(const db of indexes.values())db.close();fs.rmSync(dir,{recursive:true,force:true})}
}
if(require.main===module)(async()=>{await run();await assert.rejects(run({dropLayout:true}),/layout-qualified read reused legacy pixels/);console.log('[diagnostics:preview-reuse-matrix] dropped disk layout mutant rejected')})().catch(e=>{console.error(e);process.exitCode=1})
module.exports={run}
