#!/usr/bin/env node
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os')
const {DatabaseSync}=require('node:sqlite'),{spawnSync}=require('node:child_process')
const {loader:baseLoader}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'),crlf=process.argv.includes('--crlf'),mutant=process.argv.find(x=>x.startsWith('--mutant='))?.split('=')[1]
const queueFile='src/main/activation/activationInstallStatusSaveQueue.ts',watchFile='src/main/watcher/folderWatcherRuntime.ts',mergeFile='src/main/indexing/merged-page/mergedIndexValidationRuntime.ts'
const reconciliationFile='src/main/watcher/sharedFolderReconciliationRuntime.ts'
function load(mocks={},globals={}) {
 const transforms={}
 for(const file of [queueFile,watchFile,mergeFile,reconciliationFile])transforms[path.join(root,file)]=s=>{
  if(mutant==='projection'&&file===queueFile){assert(s.includes('!projectionPending.has(id) &&'));s=s.replace('!projectionPending.has(id) &&','')}
  if(mutant==='signature'&&file===mergeFile){const anchor='const values = sameSignature ? [installed, knownBy, matches] : [null, null, null];';assert(s.includes(anchor),'signature mutation target missing');s=s.replace(anchor,'const values = [installed, knownBy, matches];')}
  if(mutant==='baseline'&&file===reconciliationFile){const anchor='failures = Math.min(failures + 1, 5)';assert(s.includes(anchor),'baseline mutation target missing');s=s.replace(anchor,'committed = undefined; '+anchor)}
  return crlf?s.replace(/\r?\n/g,'\r\n'):s
 }
 return baseLoader(mocks,globals,transforms)
}
const tick=()=>new Promise(r=>setImmediate(r)),plain=x=>JSON.parse(JSON.stringify(x))
async function settlement() {
 assert.equal(process.platform,'win32','HFM verification is Windows-only')
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-offline-settlement-')),machineDirectory=path.join(directory,'machines')
 const readers=new Set()
 let db,authority,failed=false
 try {
 fs.mkdirSync(machineDirectory)
 const installPath=path.join(machineDirectory,'install.sqlite')
 db=new DatabaseSync(path.join(directory,'merged.sqlite'));authority=new DatabaseSync(installPath)
 const production=load(),identity=production('src/main/fonts/fontFileIdentity.ts'),signature=production('src/main/install/status/installStatusSignatureRuntime.ts')
 const metadata=production('src/main/db/sqliteHelpers.ts'),contentSignature=production('src/main/install/status/installStatusContentSignatureRuntime.ts').installStatusContentSignatureFromDb
 const folder='\\\\nas\\fonts'
 let committed=0,failProjection=true,projectionCalls=0,saves=0,nasAccesses=0,authorityOpens=0
 const deny=()=>{nasAccesses++;throw Error('NAS must not be queried')}
 const localPath=file=>{if(file!==installPath)return deny();return file}
 const closeSqliteDb=handle=>{if(handle===db)return;assert(readers.has(handle),'unknown authority handle');handle.close();readers.delete(handle)}
 const dataPath=(...parts)=>path.join(directory,...parts)
  identity.registerFileIdentitySql(db)
  db.exec("CREATE TABLE entries(relative_path TEXT,file_size INTEGER,modified_at INTEGER,font_json TEXT,installed INTEGER,installed_by TEXT,matches_json TEXT,root_path TEXT,is_deleted INTEGER DEFAULT 0,status TEXT DEFAULT 'ok'); CREATE TABLE sources(root_path TEXT PRIMARY KEY,index_db_path TEXT,install_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT,synced_at TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)")
  authority.exec('PRAGMA journal_mode=WAL; CREATE TABLE install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT,checked_at TEXT)')
  const fonts=['a','b'].map(name=>{const file=folder+'\\'+name+'.ttf';return{id:identity.fileRuntimeFontId(file,1,1),path:file,fileName:name+'.ttf',fileSize:1,modifiedAt:1,localTagNames:['keep']}})
  const insert=db.prepare('INSERT INTO entries(relative_path,file_size,modified_at,font_json,installed,installed_by,matches_json,root_path) VALUES (?,1,1,?,0,?,?,?)')
  const write=authority.prepare('INSERT OR REPLACE INTO install_status VALUES (?,?,?,?,?,?)')
  for(const font of fonts){insert.run(font.fileName,JSON.stringify(font),'none','[]',folder);write.run(font.id,signature.installStatusSignatureValue(font),0,'none','[]','initial')}
  const localPorts={dataPath,...metadata,exists:async file=>fs.existsSync(localPath(file)),openStableSqliteDb:file=>{localPath(file);const reader=new DatabaseSync(file);readers.add(reader);authorityOpens++;return reader},closeSqliteDb,appendStartupLog(){}}
  const sourceRuntime=production('src/main/indexing/mergedIndexRuntime.ts').createMergedIndexRuntime({...localPorts,openRootIndexDb:deny,schemaVersion:1,staleFirstPageEnabled:true})
  const sourceShape=row=>({root:row.root_path,indexDbPath:row.index_db_path,installDbPath:row.install_db_path,indexSignature:row.index_signature,installSignature:row.install_signature,sharedMetadataSignature:row.shared_metadata_signature})
  db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?)').run(folder,folder+'\\.hfm-cache\\database\\index.sqlite',installPath,'retained-index',contentSignature(authority),'retained-tags','retained-sync')
  const sourceReceipt=()=>plain(db.prepare('SELECT * FROM sources').get())
  const sourceKey=()=>sourceRuntime.mergedIndexSourcesKey([sourceShape(sourceReceipt())])
  metadata.setSqliteMeta(db,'sourcesKey',sourceKey())
  const initialReceipt=sourceReceipt(),initialKey=metadata.getSqliteMeta(db,'sourcesKey')
  const runtime=production(mergeFile).createMergedIndexValidationRuntime({
   ...localPorts,mergedIndexSourcesKey:sourceRuntime.mergedIndexSourcesKey,writeMergedIndexSourceRow:deny,installStatusContentSignature:deny,
   runMergedIndexMutation:async(_,fn)=>fn({commit(){committed++}}),openMergedIndexDb:async()=>db,appWatchedFolders:deny,
  },{mergedIndexSourcesForRoots:deny},{ensureMergedIndexBuilt:deny})
  // The save boundary commits real local SQLite rows before projection. This is
  // deliberately not a page repair: the queue must reconcile complete authority.
  const queue=production(queueFile).createActivationInstallStatusSaveQueue({
   readInstallStatusIndex:async items=>{const results={},misses=[];for(const item of items){const row=authority.prepare('SELECT * FROM install_status WHERE font_id=?').get(item.id);if(!row||row.signature!==signature.installStatusSignatureValue(item)){misses.push(item);continue}results[item.id]={installed:row.installed===1,by:row.by_type,matches:JSON.parse(row.matches_json)}}return{results,misses}},
   saveInstallStatusIndex:async(results,items)=>{saves++;authority.exec('BEGIN IMMEDIATE');try{for(const[id,result]of Object.entries(results))write.run(id,signature.installStatusSignatureValue(items.get(id)),result.installed?1:0,result.by,JSON.stringify(result.matches||[]),'save-'+saves);authority.exec('COMMIT')}catch(error){authority.exec('ROLLBACK');throw error}},
   appWatchedFolders:deny,rootForFontPath:deny,clearFontQueryCaches(){},appendStartupLog(){},batchDelayMs:60000,
   syncMergedIndexAfterInstallStatusRefresh:async(roots,items)=>{projectionCalls++;assert.equal(roots.length,0);if(failProjection){failProjection=false;throw Error('local busy')}await runtime.syncMergedIndexAfterInstallStatusRefresh(roots,deny,items,deny)}
  })
  const item=fonts[0],sourceRow=db.prepare('SELECT * FROM entries WHERE relative_path=?').get('a.ttf')
  const sourceSignature=signature.rootInstallStatusSignature(sourceRow.root_path,sourceRow.relative_path,sourceRow.file_size,sourceRow.modified_at,sourceRow.font_json)
  assert.equal(signature.installStatusSignatureValue(item),sourceSignature,'positive fixture must carry the exact indexed filename and stat')
  const incomplete={id:item.id,path:item.path,installStatusKnown:true,active:true,systemInstalled:false,systemInstallMatches:[]}
  assert.notEqual(signature.installStatusSignatureValue(incomplete),sourceSignature,'original incomplete fixture must not become authoritative')
  const peerInitial=plain(db.prepare('SELECT * FROM entries WHERE relative_path=?').get('b.ttf'))
  queue.schedule({[item.id]:{installed:true,by:'managed',matches:[]}},new Map([[item.id,item]]),'activate')
  await queue.flush('first');assert.equal(queue.hasPending(),true);assert.equal(db.prepare('SELECT installed FROM entries WHERE relative_path=?').get('a.ttf').installed,0)
  assert.equal(authority.prepare('SELECT installed FROM install_status WHERE font_id=?').get(item.id).installed,1,'first failure must follow the actual durable authority commit')
  assert.deepEqual(sourceReceipt(),initialReceipt,'failed projection advanced the source receipt');assert.equal(metadata.getSqliteMeta(db,'sourcesKey'),initialKey)
  await queue.flush('retry');assert.equal(projectionCalls,2,'persisted install facts must not suppress failed local projection');assert.equal(queue.hasPending(),false)
  assert.equal(authorityOpens,1,'successful retry must read the actual local authority')
  assert.equal(db.prepare('SELECT installed_by FROM entries WHERE relative_path=?').get('a.ttf').installed_by,'managed')
  assert.equal(db.prepare('SELECT installed_by FROM entries WHERE relative_path=?').get('b.ttf').installed_by,'none')
  assert.deepEqual(plain(db.prepare('SELECT * FROM entries WHERE relative_path=?').get('b.ttf')),peerInitial,'full authority repair changed an unrelated valid peer')
  assert.equal(sourceReceipt().install_signature,contentSignature(authority));assert.equal(metadata.getSqliteMeta(db,'sourcesKey'),sourceKey())
  for(const field of ['root_path','index_db_path','install_db_path','index_signature','shared_metadata_signature','synced_at'])assert.equal(sourceReceipt()[field],initialReceipt[field],'local settlement changed root receipt '+field)
  queue.schedule({[item.id]:{installed:false,by:'none',matches:[]}},new Map([[item.id,item]]),'deactivate');await queue.flush('deactivate')
  assert.equal(db.prepare('SELECT installed FROM entries WHERE relative_path=?').get('a.ttf').installed,0)
  assert.deepEqual(JSON.parse(db.prepare('SELECT font_json FROM entries WHERE relative_path=?').get('a.ttf').font_json).localTagNames,['keep']);assert.equal(committed,2);assert.equal(saves,3);assert.equal(nasAccesses,0)
  assert.equal(authorityOpens,2);assert.equal(readers.size,0,'local authority reader leaked after settlement')
  assert.equal(sourceReceipt().install_signature,contentSignature(authority));assert.equal(metadata.getSqliteMeta(db,'sourcesKey'),sourceKey())
  const peerBefore=plain(db.prepare('SELECT * FROM entries WHERE relative_path=?').get('b.ttf'))
  const receiptBeforePage=sourceReceipt(),keyBeforePage=metadata.getSqliteMeta(db,'sourcesKey')
  // Unlike committed queue writes, this explicit partial page must withdraw its
  // mismatched row without acknowledging whole-source authority.
  await runtime.syncMergedIndexAfterInstallStatusRefresh([],deny,[incomplete],deny,{preserveSourceCheckpoint:true})
  const withdrawn=db.prepare('SELECT installed,installed_by,matches_json,font_json FROM entries WHERE relative_path=?').get('a.ttf')
  assert.deepEqual([withdrawn.installed,withdrawn.installed_by,withdrawn.matches_json],[null,null,null],'incomplete signature must withdraw projected status')
  assert.deepEqual(JSON.parse(withdrawn.font_json).localTagNames,['keep'])
  assert.equal(db.prepare('SELECT installed_by FROM entries WHERE relative_path=?').get('b.ttf').installed_by,'none')
  assert.deepEqual(plain(db.prepare('SELECT * FROM entries WHERE relative_path=?').get('b.ttf')),peerBefore,'signature withdrawal must leave the peer row unchanged')
  assert.equal(committed,3,'only the explicit withdrawal adds one local projection commit');assert.equal(saves,3,'withdrawal must not resave install evidence');assert.equal(nasAccesses,0,'signature withdrawal must remain local')
  assert.equal(authorityOpens,2,'partial page should not reopen whole authority');assert.deepEqual(sourceReceipt(),receiptBeforePage);assert.equal(metadata.getSqliteMeta(db,'sourcesKey'),keyBeforePage)
 } catch(error) {failed=true;throw error}
 finally {
  let cleanupError
  const cleanup=action=>{try{action()}catch(error){cleanupError??=error}}
  for(const reader of readers)cleanup(()=>reader.close())
  cleanup(()=>authority?.close());cleanup(()=>db?.close());cleanup(()=>fs.rmSync(directory,{recursive:true,force:true}))
  if(cleanupError){if(failed)console.error('offline settlement fixture cleanup also failed:',cleanupError);else throw cleanupError}
 }
}
async function watcher() {
 let now=10000,timerId=0,snapshot={'a.ttf':[1,'1000000123']},failure=false,held=null,releaseHeld,offline=0,collections=0,projectionRepairs=0,collectionSignal
 const timers=new Map(),batches=[],folder=path.resolve('/test/shared')
 class Clock extends Date { static now(){return now} }
 async function advance(ms){
  const target=now+ms
  for(;;){const row=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!row||row[1].at>target)break;now=row[1].at;timers.delete(row[0]);row[1].fn();await tick()}
  now=target;await tick()
 }
 function nextDelay(){assert.equal(timers.size,1,'exactly one root reconciliation timer must remain');return [...timers.values()][0].at-now}
 const runtime=load({electron:{BrowserWindow:{getAllWindows:()=>[]}},'node:fs':{...fs,watch(){throw Error('main fs.watch must not receive isolated root')}},
  'node:child_process':{spawn(){throw Error('notification capability was not supplied')}},
  [path.join(root,'src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{sharedIoResourceKeys:async()=>['nas']},
  [path.join(root,'src/main/path/sharedFileSystemRuntime.ts')]:{withSharedIoSignal:(_signal,work)=>work(),executeSharedFile:async(request,_options,signal)=>{assert.equal(request.operation,'treeSnapshot');assert.equal(request.path,folder);assert.equal(signal.aborted,false);collections++;collectionSignal=signal;if(held)return held;if(failure)throw Error('network timeout');return {result:{value:snapshot}}}},
  [path.join(root,'src/main/path/startupPathAvailabilityRuntime.ts')]:{ assertStartupPathRootGuardCurrent() {},ensureStartupPathRootAvailable:async()=>true,markStartupPathRootUnavailable(){offline++}},
 },{Date:Clock,setTimeout(fn,ms){const token={id:++timerId,unref(){}};timers.set(token,{fn,at:now+ms});return token},clearTimeout(token){timers.delete(token)}})(watchFile).createFolderWatcherRuntime({
  appendStartupLog(){},isIgnoredWatcherPath:()=>false,verboseLogs:false,startupGraceMs:0,flushDebounceMs:10,closeRuntimeDatabases(){},watcherChangeBatchLooksUnchanged:async()=>{throw Error('complete inventory must not trigger a second preflight')},
  applyWatchedFolderChangesToIndex:async(changes,_replay,context)=>{context.assertCurrent();assert.equal(context.inventory.rootPath,folder);assert.equal(context.inventory.complete,true);batches.push({changes:plain(changes),files:plain([...context.inventory.files])});return {upserts:[],deletes:[]}},
  syncMergedIndexForRootSnapshot:async()=>{projectionRepairs++}
 })
 const status=()=>runtime.getSharedWatchStatus().roots[0]
 async function poll(expectedDelay){assert.equal(nextDelay(),expectedDelay);await advance(expectedDelay);if(status().phase==='applying')await advance(10)}
 try {
  await runtime.startWatchingFolders([folder]);assert.equal(collections,0,'initial collection belongs to the scheduled owner');assert.equal(status().lastCheckedAt,null)
  await advance(0);assert.equal(collections,1);assert.equal(batches.length,0);assert.equal(status().phase,'applying');assert.equal(status().lastCheckedAt,null,'collection alone is not an ACK')
  await advance(10);assert.equal(batches.length,1);assert.deepEqual(batches[0].files,[['a.ttf',{size:1,mtimeMs:1000.000123}]]);assert.equal(projectionRepairs,1)
  const firstAck=status().lastCheckedAt;assert.equal(firstAck,now);assert.equal(status().pendingCount,0)
  failure=true;await poll(30000);assert.equal(batches.length,1);assert.equal(status().lastCheckedAt,firstAck);assert.equal(status().pendingCount,null)
  assert.equal(offline,0,'shared watcher request failure must not directly own root offline state')
  failure=false;await poll(30000);assert.equal(batches.length,1,'failed poll must retain old baseline');assert.equal(projectionRepairs,1,'unchanged recovery must not rewrite projection')
  snapshot={};await poll(60000);assert.equal(batches.length,2)
  assert.deepEqual(batches[1].files,[],'complete empty inventory must reach apply so the previously indexed font can be deleted')
  assert.deepEqual(batches[1].changes.map(x=>[x.eventType,x.fileName,x.origin]),[['rescan','.','shared-poll-diff']])
  held=new Promise(r=>releaseHeld=r);await poll(30000);assert.equal(collections,5)
  runtime.stopFolderWatchers();assert.equal(collectionSignal.aborted,true)
  let closed=false;const closing=runtime.awaitFolderWatchersClosed().then(()=>{closed=true});await tick();assert.equal(closed,false,'stop must retain ownership of an unfinished collection')
  releaseHeld({result:{value:{'late.ttf':[3,'3000000']}}});await closing;await runtime.flushPendingFolderChanges()
  assert.equal(batches.length,2,'late collection must not publish after stop');assert.equal(timers.size,0);assert.deepEqual(plain(runtime.getSharedWatchStatus()),{roots:[]})
 } finally {runtime.stopFolderWatchers();releaseHeld?.({result:{value:{}}});await runtime.awaitFolderWatchersClosed()}
}
async function main(){await settlement();await watcher();if(!crlf&&!mutant){for(const [arg,cause] of [['--crlf',null],['--mutant=projection','persisted install facts must not suppress failed local projection'],['--mutant=baseline','failed poll must retain old baseline'],['--mutant=signature','incomplete signature must withdraw projected status']]){const r=spawnSync(process.execPath,[__filename,arg],{encoding:'utf8',timeout:30000});assert.equal(r.error,undefined,arg+' process failed');assert.equal(r.signal,null,arg+' was terminated');assert.equal(r.status===0,!cause,arg+'\n'+r.stdout+r.stderr);if(cause)assert(r.stderr.includes(cause),arg+' failed for an unrelated reason:\n'+r.stderr)}}console.log('offline settlement/watcher: actual local SQLite, failed projection retry, unrelated fields, complete inventory/retained baseline, ACK status, adaptive polling, awaited late stop, CRLF, exact-signature withdrawal and three causal mutants passed')}
const watchdog=setTimeout(()=>{console.error('offline settlement/watcher did not settle');process.exitCode=1},60000)
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>clearTimeout(watchdog))
