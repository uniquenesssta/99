// Same-state F14 integration owner. Only OS picker/registry/mutation and remote
// availability are controlled; all content, recovery, status, query and receipt
// decisions below belong to production modules and real disk databases.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const {DatabaseSync}=require('node:sqlite')
const {createFixture,hash}=require('./operation-work-performance.cjs')
const plain=value=>JSON.parse(JSON.stringify(value))
async function createChain(options) {
  const fixture=await createFixture({...options,initialInstallCopies:false,persistControlledRegistry:true})
  const {load,raw,db,key,query,queryDeps,runtime,records,effects,folders,appendLog}=fixture
  const controls={mutation:'success',beforeEffect:null,offline:false},observed={transactions:0,statusWrites:0,queryReads:0,registrations:[],nativeRequests:[]}
  const invalidate=()=>{query.invalidate();pages?.invalidateFontQueryPageCache()}
  let pages
  const favorites=load('src/main/library/runtime/localFontFavoritesRuntime.ts').createLocalFontFavoritesRuntime({openLibraryDb:async()=>db,loadLegacyLocalSnapshot:async()=>[],invalidate,appendLog})
  const protection=load('src/main/library/runtime/localFontProtectionRuntime.ts').createLocalFontProtectionRuntime({openLibraryDb:async()=>db,invalidate,watchedFolders:async()=>[options.fixtureDirectory]})
  const localTags=load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts').createLocalFontTagNodePersistenceRuntime(async()=>db)
  const transport=load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({enabled:true,required:true,appendStartupLog:appendLog})
  const metadata=load('src/main/rust-core/clients/rustMetadataClientRuntime.ts').createRustMetadataClientRuntime({...transport,appendStartupLog:appendLog})
  await transport.diagnoseRustCoreWorker()
  const sqlite=load('src/main/db/sqliteHelpers.ts')
  const status=load('src/main/install/installStatusRuntime.ts').createInstallStatusRuntime({
    rootCacheDir:()=>options.directory,dataPath:(...parts)=>path.join(options.directory,'state',...parts),cacheIdentityPath:()=>path.join(options.directory,'identity.json'),
    ensureCacheIdentity:async()=>{if(!fs.existsSync(path.join(options.directory,'identity.json')))fs.writeFileSync(path.join(options.directory,'identity.json'),JSON.stringify({cacheId:'f14-controlled-machine'}))},
    appWatchedFolders:async()=>[options.fixtureDirectory],findBestWatchedRootForFile:load('src/main/path/fontPathPolicy.ts').findBestWatchedRootForFile,
    openStableSqliteDb:file=>new DatabaseSync(file),closeSqliteDb:value=>value.close(),...sqlite,
    exists:async file=>fs.existsSync(file),sha1:value=>crypto.createHash('sha1').update(value).digest('hex'),normalizePathForCacheCompare:key,
    isCleanWindowsDefaultCompareResult:()=>false,completeBackgroundTask:async()=>{},appendStartupLog:appendLog,
    readInstallStatusIndexInWorker:async groups=>{const value=await metadata.runRustInstallStatusRead(groups);assert(value,'actual Rust status read unavailable');return value},
    saveInstallStatusIndexInWorker:async groups=>{const value=await metadata.runRustInstallStatusSave(groups);assert(value,'actual Rust status save unavailable');observed.statusWrites+=value.written;return value},
  })
  const statusDb=await status.openFallbackInstallDb();statusDb.close()
  const saveQueue=load('src/main/activation/mainActivationInstallStatusSaveRuntime.ts').createMainActivationInstallStatusSaveRuntime({
    readInstallStatusIndex:status.readInstallStatusIndex,saveInstallStatusIndex:status.saveInstallStatusIndex,appWatchedFolders:async()=>[options.fixtureDirectory],rootForFontPath:status.rootForFontPath,clearFontQueryCaches:invalidate,appendStartupLog:appendLog,
    // This scenario uses the production binding-backed tag page, which reads the
    // status DB directly. No merged-index projection is claimed by this fixture.
    syncMergedIndexAfterInstallStatusRefresh:async(_roots,items)=>{assert(items.every(item=>item.installStatusKnown!==undefined));observed.projectionItems=(observed.projectionItems||0)+items.length},
  })
  const facade=load('src/main/library/fontQueryFacadeRuntime.ts').createFontQueryFacadeRuntime({readInstallStatusIndex:status.readInstallStatusIndex,applyPendingActivationState:saveQueue.applyPendingActivationState,appendLog})
  const matcher=load('src/main/library/fontMemoryQueryMatcherRuntime.ts').createFontMemoryQueryMatcher({normalizePathForCacheCompare:key,isSystemInstalledRecord:()=>false,isPathInWindowsFonts:()=>false,inferFontSearchCategory:()=> 'sansSerif'})
  queryDeps.matches=matcher.sharedFontMatchesRequest
  queryDeps.hydrate=async items=>protection.hydrate(await favorites.hydrate(await facade.hydrateInstallStatusForFonts(await localTags.hydrateLocalTagsForFonts(items))))
  // The remote snapshot lives across application reopen, but is explicitly a
  // controlled read port. This is never represented as real NAS verification.
  raw.exec('CREATE TABLE IF NOT EXISTS fixture_shared_metadata (id INTEGER PRIMARY KEY, row_json TEXT NOT NULL)')
  if(!options.reopen) {
    records.splice(0);fixture.saveExternalState()
    await favorites.setFavorite([fixture.old[0]],[],true)
    await protection.set([fixture.old[4]],true)
    raw.prepare('INSERT INTO fixture_shared_metadata(row_json) VALUES (?)').run(JSON.stringify({font_id:fixture.old[0].id,relative_path:path.relative(options.fixtureDirectory,fixture.old[0].path),tag_names_json:JSON.stringify(['SharedKeep']),favorite:0,delete_protected:0,revision:1}))
  }
  queryDeps.readShared=async()=>{if(controls.offline)throw Error('controlled remote unavailable');return {preflight:{snapshot:{rows:raw.prepare('SELECT row_json FROM fixture_shared_metadata ORDER BY id').all().map(row=>JSON.parse(row.row_json))}}}}
  runtime.getSharedAvailability=async()=>({roots:[]})
  runtime.assertFeatureForChannel=channel=>assert(['fonts:setLocalTagsBatch','fonts:setSharedTagsBatch'].includes(channel),'unexpected feature gate')
  const writeTags=runtime.setLocalFontTagsBatch
  runtime.setLocalFontTagsBatch=async(...args)=>{const result=await writeTags(...args);observed.transactions++;invalidate();return result}
  const queryKey=load('src/main/library/fontQuerySqlRuntime.ts').fontQueryCacheKey
  pages=load('src/main/library/fontPageQueryCacheRuntime.ts').createFontPageQueryCacheRuntime({pageCacheMax:20,pageCacheTtlMs:60000,appendStartupLog:appendLog,
    queryUncached:async(request,limit,offset)=>{observed.queryReads++;const result=await query.query(request,limit,offset);return {...result,queryKey:queryKey({...request,limit,offset})}}})
  runtime.queryFontPageInLibrary=async request=>{
    // Recovery candidate discovery deliberately uses no live merged rows.
    if(request.sidebarPage==='filters')return {items:[],total:0,offset:0,limit:500}
    const result=await pages.queryFontPageInLibrary(request)
    return {...result,items:fixture.store().hydrate(result.items)}
  }
  runtime.queryFontsInLibrary=async request=>{const page=await query.query(request,Math.max(1,request.limit||500),0);return {...page,ids:page.items.map(item=>item.id)}}
  runtime.getFontMetricsFromLibrary=async()=>{const all=await runtime.queryFontPageInLibrary({sidebarPage:'tags',selectedTagName:'Recover',limit:500});return {total:all.total,installedCount:all.items.filter(item=>item.installStatusKnown&&item.systemInstalled).length,notInstalledCount:all.items.filter(item=>item.installStatusKnown&&!item.systemInstalled).length,installStatusMissingCount:all.items.filter(item=>!item.installStatusKnown).length,activeCount:0,favoriteCount:all.items.filter(item=>item.favorite).length}}
  const compare=load('src/main/install/fontInstallCompare.ts').createInstallCompareRuntime({appName:'HFM'})
  const fonts=load('src/main/fonts/fontRuntime.ts')
  const installedRuntime=load('src/main/install/systemInstalledFontsRuntime.ts').createSystemInstalledFontsRuntime({
    // Actual production registry parser/directory merge/enrichment; only reg.exe
    // output is controlled. Residual real fixture files remain visible candidates.
    execFileAsync:async(file,args)=>{assert.equal(String(file).toLowerCase(),'reg');const scope=args.some(arg=>String(arg).startsWith('HKLM'))?'HKLM':'HKCU';return {stdout:records.filter(row=>row.source===scope).map(row=>`    ${row.registryName}    REG_SZ    ${row.value}`).join('\n'),stderr:''}},
    fontExtensions:new Set(['.ttf','.otf','.ttc','.otc']),installedFontsTtlMs:1000,systemFontResolveBatchSize:8,
    windowsFontsDir:fixture.deps.windowsFontsDir,currentUserFontsDir:()=>folders.installed,
    resolveExistingFontFilePath:async file=>fs.existsSync(file)?file:undefined,hasValidFontSignature:fonts.hasValidFontSignature,fontItemFromPath:fonts.fontItemFromPath,readFontMetadata:fonts.readFontMetadata,
    sha1:fonts.sha1,normalizeCompareText:compare.normalizeCompareText,isUsableInstalledNameCandidate:compare.isUsableInstalledNameCandidate,withGlobalIo:fixture.withGlobalIo,delayToEventLoop:async()=>{},appendStartupLog:appendLog,
  })
  Object.assign(fixture.deps,{getSystemInstalledFonts:installedRuntime.getSystemInstalledFonts,getSystemInstalledFontsCached:installedRuntime.getSystemInstalledFontsCached,clearInstalledFontsMemoryCache:installedRuntime.clearInstalledFontsMemoryCache})
  async function confirmAndSave(item,assertCurrent=()=>{}) {
    assertCurrent()
    const installed=await fixture.deps.getSystemInstalledFontsCached(true)
    assertCurrent()
    const result=await load('src/main/install/fontInstallEvidenceRuntime.ts').createFontInstallEvidenceSession({installed,temporaryRecords:[],readHistorical:async file=>fixture.snapshots.read(file)}).confirm(item,compare.compareFontInstalledWithList(item,installed))
    assertCurrent()
    saveQueue.scheduleActivationInstallStatusSave({[item.id]:result},new Map([[item.id,item]]),'uninstall-verified')
    await saveQueue.flushActivationInstallStatusSave('uninstall-verified')
    assertCurrent()
    assert(!saveQueue.hasPendingActivationInstallStatusSave());assert(!saveQueue.hasInFlightActivationInstallStatusSave());return result
  }
  fixture.deps.persistUninstallResult=confirmAndSave
  Object.assign(fixture.deps,{fontExtensions:new Set(['.ttf','.otf','.ttc','.otc']),registryNameFor:compare.registryNameFor,normalizeCompareText:value=>String(value).toLowerCase(),activationTraceStep:async(_label,_id,run)=>run(),
    writeFontRegistryValuesHKCUBatch:async items=>{for(const item of items){assert.equal(path.dirname(item.path),folders.installed);assert(fs.existsSync(item.path));assert(!records.some(row=>row.registryName===item.name),'fixture install must not overwrite another registration');records.push({source:'HKCU',path:item.path,value:item.path,fileName:path.basename(item.path),registryName:item.name,nameCandidates:[item.name]});observed.registrations.push(plain(item))}fixture.saveExternalState()},
  })
  fixture.deps.createMutationSession=async()=>{fixture.observer.counts.brokerSessions++;return {close(){},readRegistry:async()=>plain(records),execute:async(plan,check)=>{
    let completedSteps=0,fileRemoved=false
    try {
      await check()
      for(const record of plan.records){await controls.beforeEffect?.('registry',plan);await check(plain(records),'registry');const index=records.findIndex(row=>row.source===record.scope&&row.registryName===record.name&&row.value===record.value);assert(index>=0,'exact controlled registration no longer exists');records.splice(index,1);fixture.saveExternalState();effects.push(['registry',record.scope,record.name,record.value]);completedSteps++}
      if(plan.delete_file){assert.equal(path.dirname(plan.path),folders.installed,'source file deletion forbidden');await controls.beforeEffect?.('file',plan);await check(plain(records),'file');if(controls.mutation==='blocked')return {ok:false,message:'controlled sharing violation',code:32,completedSteps,fileRemoved};fs.unlinkSync(plan.path);effects.push(['file',plan.path]);completedSteps++;fileRemoved=true}
      return {ok:true,message:'controlled exact effects',completedSteps,fileRemoved}
    }catch(error){return {ok:false,message:String(error),completedSteps,fileRemoved}}
  }}}
  runtime.installFontSystemWide=fixture.uninstall.installFontSystemWide
  runtime.uninstallFontSystemWide=fixture.uninstall.uninstallFontSystemWide
  runtime.compareFontInstalled=confirmAndSave
  runtime.getInstallStatusIndexSnapshot=status.getInstallStatusIndexSnapshot
  runtime.loadLibraryShell=async()=>({fonts:{},folders:[options.fixtureDirectory],folderNodes:[],fontFolderIds:{},collections:[],tags:['SharedKeep'],localTags:['Recover']})
  const sourceManifest=()=>fixture.next.map(item=>{const stat=fs.statSync(item.path);return {path:item.path,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,birthtime:stat.birthtimeMs,mode:stat.mode,sha256:hash(fs.readFileSync(item.path))}})
  const original=sourceManifest(),sharedOriginal=raw.prepare('SELECT * FROM fixture_shared_metadata ORDER BY id').all()
  const sourceSafe=()=>{assert.deepEqual(sourceManifest(),original,'original recovered source bytes/path/attributes changed');assert.deepEqual(raw.prepare('SELECT * FROM fixture_shared_metadata ORDER BY id').all(),sharedOriginal,'other-scope shared association changed')}
  async function checkpoint(label) {
    const states={}
    for(const installStatus of ['all','installed','notInstalled']){
      const request={sidebarPage:'tags',selectedTagName:'Recover',installStatus,limit:500}
      const page=await runtime.queryFontPageInLibrary(request),ids=await runtime.queryFontsInLibrary(request)
      assert.equal(page.total,page.items.length);assert.equal(ids.total,page.total);assert.deepEqual(ids.ids,page.items.map(item=>item.id))
      states[installStatus]={total:page.total,items:page.items.map(({id,path,installStatusKnown,systemInstalled,pendingUninstall,fileAvailability,favorite,deleteProtected,localTagNames})=>({id,path,installStatusKnown,systemInstalled,pendingUninstall,fileAvailability,favorite,deleteProtected,localTagNames}))}
    }
    sourceSafe()
    const installFile=await status.fallbackInstallStatusDbPath(),installDb=new DatabaseSync(installFile)
    try{return {label,states,bindings:plain(raw.prepare('SELECT * FROM local_font_tags ORDER BY font_path,tag_name').all()),favorites:plain(raw.prepare('SELECT * FROM local_font_favorites ORDER BY font_path').all()),protection:plain(raw.prepare('SELECT * FROM local_font_protection ORDER BY font_path').all()),receipts:plain(raw.prepare('SELECT * FROM font_uninstall_receipts ORDER BY source_path').all()),installRows:plain(installDb.prepare('SELECT * FROM install_status ORDER BY font_id').all()),sourceManifest:sourceManifest(),effects:plain(effects)}}finally{installDb.close()}
  }
  return {...fixture,status,saveQueue,controls,observed,confirmAndSave,invalidate,checkpoint,sourceSafe,sourceManifest,stopTransport:()=>transport.stopRustCoreDaemon(),async close(){transport.stopRustCoreDaemon();await load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime().whenIdle();const end=Date.now()+5000;while(fixture.observer.children.size&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));fixture.close()}}
}
module.exports={createChain}
