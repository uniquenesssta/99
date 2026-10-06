// F13 narrow real-file/SQLite workload. This is also the state owner available to
// the existing Electron chain, not a second runner or a copy of business logic.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process')
const { promisify } = require('node:util'), { DatabaseSync } = require('node:sqlite')
const { loader } = require('../check-operation-chain.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const summarize = values => { const sorted = [...values].sort((a,b)=>a-b); return { count: sorted.length, p95Ms: sorted.length ? sorted[Math.ceil(sorted.length*.95)-1] : 0, maxMs: Math.max(0,...sorted), values } }
function createObserver() {
  const children = new Set(), events = [], bytes = { source:0, cache:0, transfer:0 }, counts = { filesystem:0, reads:0, processes:0, closed:0, globalTasks:0, sharedTasks:0, timeouts:0, bindingCollections:0, bindingRows:0, planningSnapshots:0, projections:0, brokerSessions:0, nativeRenders:0, contentHashes:0 }
  const globalWait = [], globalExecution = [], sharedWait = [], sharedExecution = []
  const read = (file, result, channel) => {
    const size = Buffer.isBuffer(result) ? result.length : typeof result === 'string' ? Buffer.byteLength(result) : result?.bytesRead || 0
    counts.reads++; bytes[channel || (/\.(ttf|otf|ttc|otc)$/i.test(String(file)) ? 'source' : 'cache')] += size
  }
  const promises = new Proxy(fs.promises, { get(target, key) {
    const member = target[key]; if (typeof member !== 'function') return member
    return async (...args) => {
      counts.filesystem++
      const result = await member.apply(target,args)
      if (key === 'readFile') read(args[0],result)
      if (key === 'open') return new Proxy(result,{get(handle,name){const value=Reflect.get(handle,name);if(name==='read')return async(...input)=>{const out=await value.apply(handle,input);read(args[0],out);return out};return typeof value==='function'?value.bind(handle):value}})
      return result
    }
  } })
  const observedFs = new Proxy(fs,{get(target,key){if(key==='promises')return promises;if(key==='readFileSync')return(...args)=>{counts.filesystem++;const value=fs.readFileSync(...args);read(args[0],value);return value};return target[key]}})
  const track = child => { if (!child) return child; counts.processes++; children.add(child); child.once('close',()=>{counts.closed++;children.delete(child)}); return child }
  const execFile = (...args) => track(cp.execFile(...args))
  execFile[promisify.custom] = (...args) => { let child; const task=new Promise((resolve,reject)=>{child=execFile(...args,(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr}))});task.child=child;return task }
  const childProcess = { ...cp, spawn:(...args)=>track(cp.spawn(...args)),execFile }
  function database(raw) {
    return { exec:sql=>raw.exec(sql),prepare(sql){const statement=raw.prepare(sql);return new Proxy(statement,{get(target,key){const fn=Reflect.get(target,key);if(key==='all')return(...args)=>{const rows=fn.apply(target,args);if(/^SELECT font_id, font_path, tag_name FROM local_font_tags/.test(sql)){counts.bindingCollections++;counts.bindingRows+=rows.length}return rows};return typeof fn==='function'?fn.bind(target):fn}})},transaction:fn=>()=>{raw.exec('BEGIN');try{const result=fn();raw.exec('COMMIT');return result}catch(error){raw.exec('ROLLBACK');throw error}} }
  }
  function global(runtime) { return (label,fn,options={})=>{counts.globalTasks++;const enqueued=performance.now();let start;return runtime.withGlobalIo(label,()=>{start=performance.now();globalWait.push(start-enqueued);return fn()},options).finally(()=>{if(start!==undefined)globalExecution.push(performance.now()-start)})} }
  function reset() { for(const key of Object.keys(counts))counts[key]=0;for(const key of Object.keys(bytes))bytes[key]=0;globalWait.length=0;globalExecution.length=0;sharedWait.length=0;sharedExecution.length=0;events.length=0 }
  function snapshot() { return { counts:{...counts},logicalReadBytes:{...bytes},globalWait:summarize([...globalWait]),globalExecution:summarize([...globalExecution]),sharedWait:summarize([...sharedWait]),sharedExecution:summarize([...sharedExecution]),remainingChildren:children.size } }
  return { counts,bytes,children,events,fs:observedFs,childProcess,database,global,reset,snapshot,read,sharedWait,sharedExecution }
}
function selectFonts(directory) {
  const system = path.join(process.env.WINDIR,'Fonts'), chosen=[], seen=new Set()
  for (const name of fs.readdirSync(system).filter(name=>/\.ttf$/i.test(name)).sort()) {
    const content=fs.readFileSync(path.join(system,name)),sha256=hash(content)
    if(seen.has(sha256))continue
    seen.add(sha256);chosen.push({name,source:path.join(system,name),sha256,size:content.length})
    if(chosen.length===8)break
  }
  assert.equal(chosen.length,8,'eight distinct real Windows fonts are required')
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'fixture-manifest.json'),JSON.stringify(chosen.map(({source,...rest})=>rest),null,2))
  return chosen
}
async function createFixture({sourceRoot,directory,fixtureDirectory,manifest,workerPath,electron,reopen=false,initialInstallCopies=true,persistControlledRegistry=false}) {
  assert.equal(process.platform,'win32')
  if(!reopen)fs.rmSync(fixtureDirectory,{recursive:true,force:true});fs.mkdirSync(fixtureDirectory,{recursive:true});fs.mkdirSync(directory,{recursive:true})
  const observer=createObserver(),logs=[],appendLog=line=>logs.push(line)
  const helper=path.join(sourceRoot,'src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts')
  const transforms={ [helper]:source=>source.replaceAll('import.meta.url',JSON.stringify(require('node:url').pathToFileURL(helper).href)) }
  const load=loader({electron:electron||{app:{isPackaged:false,getAppPath:()=>sourceRoot}},fontkit:require('fontkit'),'node:fs':observer.fs,'node:child_process':observer.childProcess,
    [path.join(sourceRoot,'src/main/install/fontMutationProcessRuntime.ts')]:{createFontMutationSession:async()=>{throw Error('real system mutation forbidden in controlled workload')}}}, {setImmediate,clearImmediate}, transforms, sourceRoot)
  const fontRuntime=load('src/main/fonts/fontRuntime.ts'),content=load('src/main/fonts/fontContentIdentityRuntime.ts')
  const readIdentity=content.readFontContentIdentity
  content.readFontContentIdentity=async(...args)=>{observer.counts.contentHashes++;return readIdentity(...args)}
  const folders={old:path.join(fixtureDirectory,'old'),next:path.join(fixtureDirectory,'new'),page:path.join(fixtureDirectory,'page'),other:path.join(fixtureDirectory,'unrelated'),installed:path.join(fixtureDirectory,'user-fonts'),isolated:path.join(fixtureDirectory,'isolated')}
  for(const folder of Object.values(folders))fs.mkdirSync(folder,{recursive:true})
  const copy=(source,target)=>{fs.copyFileSync(source,target);fs.utimesSync(target,new Date('2026-01-01T00:00:00Z'),new Date('2026-01-01T00:00:00Z'))}
  const raw=new DatabaseSync(path.join(directory,'library.sqlite')),db=observer.database(raw)
  load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(db)
  const snapshots=load('src/main/library/tagFontSnapshotRuntime.ts').openTagFontSnapshots(db)
  const old=[],next=[],byPath=new Map(),key=file=>load('src/main/path/cachePath.ts').normalizePathForCacheCompare(file)
  for(const [index,entry] of manifest.entries()) {
    const original=path.join(folders.old,`old-${index}.ttf`),replacement=path.join(folders.next,`renamed-${index}.ttf`)
    if(!reopen) {
      copy(entry.source,original)
      const item=await fontRuntime.fontItemFromPath(original);await snapshots.capture([item]);fs.renameSync(original,replacement)
    }
    const item=snapshots.read(original);assert(item,'reopen must retain historical source evidence');old.push(item)
    const current=await fontRuntime.fontItemFromPath(replacement);next.push(current);byPath.set(key(current.path),current)
  }
  const insert=raw.prepare('INSERT INTO local_font_tags(font_id,font_path,tag_name,updated_at) VALUES(?,?,?,?)')
  if(!reopen) {
  for(const item of old)insert.run(item.id,key(item.path),'Recover','fixture')
  for(let i=0;i<1001;i++)insert.run(`page-${i}`,key(path.join(folders.page,`${i}.ttf`)),'Page','fixture')
  for(let i=0;i<512;i++)insert.run(`other-${i}`,key(path.join(folders.other,`${i}.ttf`)),'Unrelated','fixture')
  }
  const queryModule=load('src/main/library/tagFontQueryRuntime.ts')
  const queryDeps={openLibraryDb:async()=>db,roots:async()=>[fixtureDirectory],findPrevious:async file=>byPath.get(key(file))||null,
    readShared:async()=>({preflight:{snapshot:{rows:[]}}}),queryLive:async()=>({items:[],total:0,offset:0,limit:500,queryKey:'fixture',elapsedMs:0,engine:'sql',truncated:false}),hydrate:async items=>items,
    matches:(font,request)=>!request.selectedTagName||(request.sidebarPage==='sharedTags'?font.tagNames:font.localTagNames||[]).includes(request.selectedTagName),compare:(a,b)=>a.fileName.localeCompare(b.fileName)}
  const query=queryModule.createTagFontQueryRuntime(queryDeps)
  const writer=await load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts').createLocalFontTagNodePersistenceRuntime(async()=>db).openWriter()
  let pickerCalls=0
  const runtime={appendLog,loadLibraryShell:async()=>({folders:[fixtureDirectory],fonts:{},tags:[],localTags:['Recover']}),getSharedAvailability:async()=>({roots:[]}),
    queryFontPageInLibrary:async request=>request.sidebarPage==='filters'?{items:[],total:0,offset:0,limit:500}:query.query(request,request.limit||500,request.offset||0),
    rememberRelinkedFontFile:async()=>{throw Error('fixture recovery must remain in registered root')},refreshWatchedFolder:async()=>{throw Error('relink must not scan roots')},
    setLocalFontTagsBatch:async(items,options)=>{const result=writer.setLocalFontTagsBatch(items,new Date().toISOString(),options);query.invalidate();return {...result,ok:!result.failed.length,message:'controlled local transaction'}}}
  const recovery=load('src/main/library/tagFontRecoveryRuntime.ts').createTagFontRecoveryRuntime(runtime,async()=>{pickerCalls++;return next[0].path})
  const externalStatePath=path.join(directory,'controlled-registry.json')
  const records=reopen?JSON.parse(fs.readFileSync(externalStatePath,'utf8')):next.slice(0,initialInstallCopies?5:0).map((item,i)=>{const target=path.join(folders.installed,`copy-${i}.ttf`);copy(item.path,target);return {source:'HKCU',path:target,value:target,fileName:path.basename(target),registryName:item.fullName,nameCandidates:[item.family,item.fullName,item.postscriptName].filter(Boolean)}})
  const saveExternalState=()=>{if(persistControlledRegistry)fs.writeFileSync(externalStatePath,JSON.stringify(records))}
  if(!reopen)saveExternalState()
  const installedSnapshot=async()=>{observer.counts.planningSnapshots++;await load('src/main/path/sharedFileSystemRuntime.ts').sharedFileSystem.readdir(folders.installed,{withFileTypes:true});return plain(records)}
  const effects=[],store=()=>load('src/main/install/fontUninstallReceiptRuntime.ts').openFontUninstallReceipts(db)
  raw.exec('CREATE TABLE IF NOT EXISTS local_font_protection(font_path TEXT PRIMARY KEY, protected INTEGER NOT NULL)')
  const protection=load('src/main/install/fontProtectionAuthorityRuntime.ts').createFontProtectionAuthorityRuntime({roots:async()=>[fixtureDirectory],read:async item=>!!raw.prepare('SELECT protected FROM local_font_protection WHERE font_path=?').get(key(item.path))?.protected,lock:async(_items,_roots,action)=>action(),log:appendLog})
  const deps={openUninstallReceipts:async()=>store(),readUninstallActivationClaims:async()=>[],ensureWindows(){assert.equal(process.platform,'win32')},currentUserFontsDir:()=>folders.installed,windowsFontsDir:()=>path.join(fixtureDirectory,'not-system'),normalizePathForCacheCompare:key,isTemporaryActiveInstalledRecord:()=>false,
    withFontProtection:protection.guard,getSystemInstalledFonts:installedSnapshot,getSystemInstalledFontsCached:installedSnapshot,readUninstallRegistry:async()=>plain(records),clearInstalledFontsMemoryCache(){},appendStartupLog:appendLog,advancedFontRefresh:async()=>{},
    persistUninstallResult:async item=>{observer.counts.projections++;const compare=load('src/main/install/fontInstallCompare.ts').createInstallCompareRuntime({appName:'HFM'}).compareFontInstalledWithList(item,records);return load('src/main/install/fontInstallEvidenceRuntime.ts').createFontInstallEvidenceSession().confirm(item,compare)},
    createMutationSession:async()=>{observer.counts.brokerSessions++;return {close(){},readRegistry:async()=>plain(records),execute:async(plan,check)=>{let completedSteps=0,fileRemoved=false;await check();for(const record of plan.records){await check(plain(records),'registry');const index=records.findIndex(row=>row.source===record.scope&&row.registryName===record.name&&row.value===record.value);assert(index>=0);records.splice(index,1);saveExternalState();effects.push(['registry',record.name]);completedSteps++}if(plan.delete_file){assert.equal(path.dirname(plan.path),folders.installed);await check(plain(records),'file');fs.unlinkSync(plan.path);effects.push(['file',plan.path]);completedSteps++;fileRemoved=true}return {ok:true,message:'controlled fixture effects',completedSteps,fileRemoved}}}},
  }
  const uninstall=load('src/main/install/systemFontInstallRuntime.ts').createSystemFontInstallRuntime(deps)
  const global=load('src/main/performance/globalIoRuntime.ts').createGlobalIoRuntime({env:process.env,localScanWorkers:2,appendLog,isIndexingActive:()=>false,isUserActive:()=>false,storageProfileForPath:file=>({rootPath:path.parse(file).root,type:'ssd',reason:'controlled-runner-profile',isNetwork:false})})
  const before=next.map(item=>{const stat=fs.statSync(item.path);return {path:item.path,size:stat.size,mtime:stat.mtimeMs,mode:stat.mode,sha256:hash(fs.readFileSync(item.path))}})
  observer.reset()
  async function operations() {
    const timings={}
    let start=performance.now();const pages=[]
    const readPages=async()=>{for(const offset of [0,500,1000])pages.push(await query.query({tagBindingsOnly:true,sidebarPage:'tags',selectedWatchedFolders:[folders.page],limit:500,offset},500,offset))}
    await (queryModule.withTagFontQuerySnapshot?queryModule.withTagFontQuerySnapshot(readPages):readPages())
    timings.paginationMs=performance.now()-start
    assert.deepEqual(pages.map(page=>page.items.length),[500,500,1]);assert(pages.every(page=>page.total===1001))
    const pagination=observer.snapshot();observer.reset()
    start=performance.now();const recovered=await recovery.recover({mode:'relink',scope:'local',fontPath:old[0].path});timings.recoveryMs=performance.now()-start
    assert.equal(recovered.linked,8,JSON.stringify(recovered));assert.equal(recovered.remaining,0);assert.equal(pickerCalls,1)
    const linked=raw.prepare("SELECT font_path FROM local_font_tags WHERE tag_name='Recover' ORDER BY font_path").all();assert.deepEqual(linked.map(row=>row.font_path),next.map(item=>key(item.path)).sort())
    const recoveryEvidence=observer.snapshot();observer.reset()
    start=performance.now();const removed=await uninstall.uninstallFontSystemWide(next.slice(0,5));timings.uninstallMs=performance.now()-start
    assert.equal(removed.ok,true,JSON.stringify(removed));assert.equal(effects.filter(row=>row[0]==='file').length,5);assert.equal(records.length,0);assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM font_uninstall_receipts').get().n,0)
    for(const entry of before){const stat=fs.statSync(entry.path);assert.deepEqual({path:entry.path,size:stat.size,mtime:stat.mtimeMs,mode:stat.mode,sha256:hash(fs.readFileSync(entry.path))},entry)}
    assert.deepEqual(raw.prepare("SELECT font_path FROM local_font_tags WHERE tag_name='Recover' ORDER BY font_path").all(),linked)
    return {timings,pagination,recovery:recoveryEvidence,uninstall:observer.snapshot(),linked:linked.length,pickerCalls,effects:effects.length}
  }

  async function watcher() {
    const watch=path.join(fixtureDirectory,'watch');fs.mkdirSync(watch,{recursive:true})
    const cache={version:1,entries:{}},cacheFile=path.join(directory,'watch-cache.json'),shared=load('src/main/path/sharedFileSystemRuntime.ts').sharedFileSystem
    const paths=load('src/main/path/cachePath.ts'),cachePaths=load('src/main/cache/cachePaths.ts'),cached=fontRuntime.createCachedFontRuntime({sharedFontId:()=> 'unused'})
    const common={fontExtensions:new Set(['.ttf']),scriptDetectionVersion:2,withGlobalIo:observer.global(global),fileCacheSignature:cachePaths.fileCacheSignature,cacheKeyForRootFile:paths.relativePathForRoot,cacheEntryRuntimePath:cached.cacheEntryRuntimePath,hasValidFontSignature:fontRuntime.hasValidFontSignature,fontItemFromPath:fontRuntime.fontItemFromPath,sanitizeCachedFont:cached.sanitizeCachedFont,cachedFontForRuntime:cached.cachedFontForRuntime}
    const entry=load('src/main/watcher/manual-refresh/manualFolderIndexEntryRuntime.ts').createManualFolderIndexEntryRuntime(common)
    for(let i=0;i<8;i++){const file=path.join(watch,`font-${i}.ttf`);copy(manifest[i].source,file);await entry.upsertFontIndexEntry(watch,file,cache)}
    const index=load('src/main/watcher/watchedFolderIndexRuntime.ts').createWatchedFolderIndexRuntime({...common,...entry,isIgnoredWatcherPath:()=>false,appendStartupLog:appendLog,fontScanCacheVersion:1,
      ensureRootScanCacheStorage:async()=>({cachePath:cacheFile,cacheDir:directory,storage:'root',cache}),
      saveScanCacheFile:async(file,value)=>shared.writeFile(file,JSON.stringify(value)),writeRootCacheManifest:async()=>{},saveRootDirectorySignatures:async()=>{},readRootDirectorySignatures:async()=>new Map()})
    const events=Array.from({length:16},(_,i)=>({folder:watch,eventType:'change',fileName:`font-${i%8}.ttf`,receivedAt:0,origin:'controlled-replay'}))
    observer.reset();const unchanged=await index.applyWatchedFolderChangesToIndex(events)
    assert.equal(unchanged.upserts.length,0);assert.equal(unchanged.deletes.length,0);assert.equal(unchanged.errors.length,0)
    const unchangedWork=observer.snapshot();observer.reset()
    copy(manifest[1].source,path.join(watch,'font-0.ttf'));fs.utimesSync(path.join(watch,'font-0.ttf'),new Date('2026-01-01T00:00:01Z'),new Date('2026-01-01T00:00:01Z'))
    const changed=await index.applyWatchedFolderChangesToIndex([events[0]])
    assert.equal(changed.upserts.length,1);assert.equal(changed.errors.length,0);assert.equal(changed.deletes.length,0)
    return {unchangedUpserts:0,changedUpserts:1,unchanged:unchangedWork,changed:observer.snapshot(),scope:'real targeted watcher/index/cache write; renderer event behavior remains the existing F12 diagnostic'}
  }
  async function contention() {
    observer.reset()
    const routing=load('src/main/rust-core/rustSharedIoCommandRuntime.ts');routing.registerIsolatedRoot(folders.isolated)
    const roots=await routing.sharedIoResourceKeys([folders.isolated]);assert(roots.length===1&&roots[0].startsWith('configured-root:'))
    const pool=load('src/main/path/sharedIoProcessRuntime.ts').createSharedIoProcessRuntime(appendLog),input=path.join(folders.isolated,'font.ttf');copy(manifest[0].source,input)
    const jobs=[],foreground=[],all=[]
    for(let i=0;i<14;i++){
      const transfer=path.join(directory,`transfer-${i}.bin`),request=path.join(directory,`read-${i}.json`),priority=i<8?'background':'foreground'
      fs.writeFileSync(request,JSON.stringify({operation:'readFile',path:input,transferPath:transfer}))
      observer.counts.sharedTasks++
      const task=pool.run({file:workerPath,args:['--shared-file-io','--input',request,'--transfer',transfer],roots,timeoutMs:2000,queueTimeoutMs:3000,write:false,priority,label:`f13:${priority}`}).then(receipt=>{const payload=JSON.parse(receipt.stdout.trim().split(/\r?\n/)[0]);assert.equal(payload.ok,true);const data=fs.readFileSync(transfer);assert.equal(hash(data),manifest[0].sha256);observer.bytes.source+=data.length;observer.read(transfer,data,'transfer');all.push({priority,queuedMs:receipt.queuedMs,executionMs:receipt.executionMs});if(priority==='foreground'){foreground.push(receipt.queuedMs);observer.sharedWait.push(receipt.queuedMs);observer.sharedExecution.push(receipt.executionMs)}}).catch(error=>{if(/timeout/.test(error.reason||''))observer.counts.timeouts++;throw error})
      jobs.push(task)
    }
    try{await Promise.all(jobs);await pool.whenIdle();assert.equal(pool.status().metrics.started,pool.status().metrics.closed);assert.equal(pool.status().pids.length,0);return {...observer.snapshot(),foreground:summarize(foreground),all,pool:pool.status().metrics}}
    finally{pool.stop();await pool.whenIdle();await Promise.allSettled(jobs)}
  }
  return {queryDeps,deps,records,effects,store,snapshots,writer,recovery,uninstall,key,saveExternalState,sourceManifest:before,load,observer,global,withGlobalIo:observer.global(global),runtime,query,raw,db,old,next,folders,logs,appendLog,operations,watcher,contention,close(){raw.close();assert.equal(observer.children.size,0,'fixture leaked children')}}
}
module.exports={createObserver,createFixture,selectFonts,hash,summarize}
