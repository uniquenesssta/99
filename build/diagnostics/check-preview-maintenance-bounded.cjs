#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {DatabaseSync}=require('node:sqlite'),{loader}=require('./check-operation-chain.cjs')
const base='src/main/maintenance/',tick=()=>new Promise(resolve=>setImmediate(resolve))
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-maintenance-bounded-')),db=new DatabaseSync(path.join(dir,'preview.sqlite'))
 const images=path.join(dir,'images');fs.mkdirSync(images)
 db.exec('CREATE TABLE preview_cache(preview_key TEXT PRIMARY KEY, output_path TEXT, status TEXT, accessed_at TEXT, generated_at TEXT, updated_at TEXT, message TEXT)')
 const insert=db.prepare("INSERT INTO preview_cache VALUES (?,?,'ok',?,?,?,NULL)"),now=new Date().toISOString()
 for(let i=0;i<70;i++){const key=String(i).padStart(3,'0'),file=path.join(images,key+'.png');fs.writeFileSync(file,'fixture');insert.run(key,file,now,now,now)}
 let batches=[],directoryReads=0
 const mocks={'../path/sharedDirectoryMetadataRuntime':{readSharedDirectoryMetadata:async p=>{directoryReads++;return {entries:fs.readdirSync(p,{withFileTypes:true}).map(e=>({name:e.name,isFile:()=>e.isFile(),isDirectory:()=>e.isDirectory(),isSymbolicLink:()=>false,stat:fs.statSync(path.join(p,e.name))}))}}}}
 const load=loader(mocks,{setImmediate})
 const deps={previewOkRetentionMs:86400000,openPreviewDb:async()=>db,previewSqlitePath:()=>path.join(dir,'preview.sqlite'),previewSqliteSchemaVersion:1,collectPreviewMaintenanceDirs:async()=>[{dirPath:images,referenceDbPath:path.join(dir,'preview.sqlite')}],normalizePathForCacheCompare:x=>x}
 try{
  const runtime=load(base+'previewCacheMaintenanceRuntime.ts').createPreviewCacheMaintenanceRuntime({...deps,runRustPreviewCacheMaintenance:async input=>{
   assert.deepEqual(Array.from(input.previewDirs),[],'maintenance still reserves a complete tree')
   assert(input.batch.rows.length<=32);batches.push(input.batch.rows.map(row=>row.previewKey))
   for(const row of input.batch.rows)db.prepare("UPDATE preview_cache SET status='stale' WHERE preview_key=?").run(row.previewKey)
   return {checkedRows:input.batch.rows.length,staleRows:input.batch.rows.length,removedFiles:0,removedOrphanFiles:0,errors:[]}
  }})
  const result=await runtime.runPreviewCacheMaintenance()
  assert.equal(result.checkedRows,70);assert.deepEqual(batches.map(b=>b.length),[32,32,6]);assert.equal(new Set(batches.flat()).size,70,'keyset paging skipped rows changed by earlier batch')
  assert.equal(directoryReads,1);assert.equal(fs.readdirSync(images).length,70,'indexed files deleted as orphans')
  db.exec("UPDATE preview_cache SET status='ok'")
  const first=path.join(images,'000.png');fs.unlinkSync(first)
  const original=fs.promises.lstat
  const fallbackLoad=loader({...mocks,'../path/sharedFileSystemRuntime':{sharedFileSystem:{...fs.promises,lstat:async p=>{if(p.endsWith('001.png'))throw Object.assign(Error('denied'),{code:'EACCES'});return original(p)}}}},{setImmediate})
  const fallback=await fallbackLoad(base+'previewCacheMaintenanceRuntime.ts').createPreviewCacheMaintenanceRuntime(deps).runPreviewCacheMaintenance()
  assert.equal(db.prepare("SELECT status FROM preview_cache WHERE preview_key='000'").get().status,'stale')
  assert.equal(db.prepare("SELECT status FROM preview_cache WHERE preview_key='001'").get().status,'ok','permission error was mislabeled missing')
  assert.equal(fallback.staleRows,1);assert(fallback.errors.length>0)
  let submissions=0,support=false,fail=false,accesses
  const clientLoad=loader({'../rustCoreWorkerTransportRuntime':{parseJsonLine:JSON.parse,hasCapability:(s,c)=>s.capabilities.includes(c)}})
  const client=clientLoad('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({
   diagnoseRustCoreWorker:async()=>({available:true,path:'worker',capabilities:['preview-cache-maintenance',...(support?['preview-cache-maintenance-bounded-v1']:[])]}),
   createTemporaryJsonFile:()=>({path:'input',writeJson:async()=>{},dispose:async()=>{}}),appendStartupLog(){},appendPreviewCacheFailureLog(){},
   runRustCoreScheduledCommand:async(_p,_a,options)=>{submissions++;accesses=options.sharedIo.accesses;if(fail)throw Error('uncertain worker');return {stdout:JSON.stringify({ok:true,checkedRows:1,staleRows:0,removedFiles:0,removedOrphanFiles:0,errors:[]})}}
  })
  const input={dbPath:path.join(dir,'preview.sqlite'),schemaVersion:1,now,previewDirs:[],previewOkRetentionMs:1,orphanRetentionMs:1,batch:{rows:[{previewKey:'001',outputPath:'\\\\nas\\fonts\\a.png'}],orphanFiles:[],referenceDbPath:'\\\\nas\\fonts\\cache.sqlite'}}
  assert.equal(await client.runRustPreviewCacheMaintenance(input),null);assert.equal(submissions,0,'old worker received narrowed declaration it would ignore')
  support=true;assert.equal((await client.runRustPreviewCacheMaintenance(input)).checkedRows,1)
  assert(!accesses.some(a=>a.scope==='tree'));assert(accesses.some(a=>a.path===input.batch.rows[0].outputPath&&a.mode==='write'))
  assert(accesses.some(a=>a.path===input.batch.referenceDbPath&&a.scope==='database'&&a.mode==='read'))
  fail=true;await assert.rejects(client.runRustPreviewCacheMaintenance(input),/uncertain worker/)
  const availabilityLoad=loader({'../../path/startupPathAvailabilityRuntime':{getStartupPathRootState:()=>({state:'online',generation:1,rootId:'root'}),ensureStartupPathRootAvailable:async()=>true}})
  const availability=availabilityLoad('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts').createPreviewCacheRootAvailabilityRuntime()
  const Deadline=availabilityLoad('src/main/path/ioDeadlineRuntime.ts').IoDeadlineTimeoutError
  for(let i=0;i<12;i++)availability.markRootPreviewCacheUnavailable(dir,new Deadline('queue-inclusive-response',2000))
  assert.equal(availability.isRootPreviewCacheUnavailable(dir),false);assert.equal(await availability.ensureRootPreviewCacheAvailable(dir),true,'response timeout poisoned root circuit')
  availability.markRootPreviewCacheUnavailable(dir,Object.assign(Error('network down'),{code:'ENETUNREACH'}))
  assert.equal(availability.isRootPreviewCacheUnavailable(dir),true,'real unavailable evidence no longer trips circuit')
  let reads=0,stats=0
  const statsLoad=loader({'../../path/sharedDirectoryMetadataRuntime':{readSharedDirectoryMetadata:async()=>{reads++;return {entries:Array.from({length:4820},(_,i)=>({name:i+'.png',isDirectory:()=>false,isFile:()=>true,stat:{size:3}}))}}},'../../path/sharedFileSystemRuntime':{sharedFileSystem:{stat:async()=>{stats++;throw Error('unexpected per-file stat')},readdir:async()=>{throw Error('unexpected second listing')}}}})
  const cache=statsLoad('src/main/cache/scan-storage/cacheStatsRuntime.ts').createCacheStatsRuntime({}, {})
  assert.equal(await cache.directorySizeBytes('\\\\nas\\images'),14460);assert.equal(reads,1);assert.equal(stats,0,'directory stats still launch one process per file')
  let folderReads=0,fileReads=0
  const cold=statsLoad('src/main/cache/scan-storage/cacheStatsRuntime.ts').createCacheStatsRuntime({
   legacyScanCachePath:()=>'/local/scan.json',previewSqlitePath:()=>'/local/preview.sqlite',exists:async()=>false,localPreviewImageDir:()=>'/local/images',
   loadLibraryShell:async()=>{throw Error('stats must not wait for shared font counts')},appWatchedFolders:async()=>{folderReads++;await tick();return []}
  },{readScanCacheFile:async()=>{fileReads++;await tick();return {entries:{}}}})
  const [one,two]=await Promise.all([cold.getCacheStats(),cold.getCacheStats()])
  assert.equal(folderReads,1);assert.equal(fileReads,1,'concurrent cold stats duplicated physical read');assert.deepEqual(one,two);assert.notEqual(one,two)
  await tick()
  console.log('PASS bounded maintenance: 70 rows/3 batches, permission preservation, old-worker guard, precise scopes, uncertain receipt, timeout vs offline, 4820 metadata entries/1 read')
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
