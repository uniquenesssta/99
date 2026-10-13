#!/usr/bin/env node
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs')
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
 const db=new DatabaseSync(':memory:');db.function('hfm_shared_font_id',(relative,_size,_mtime)=>String(relative).replace('.ttf',''))
  require('./check-operation-chain.cjs').loader()('src/main/fonts/fontFileIdentity.ts').registerFileIdentitySql(db)
 db.exec("CREATE TABLE entries(relative_path TEXT,file_size INTEGER,modified_at INTEGER,font_json TEXT,installed INTEGER,installed_by TEXT,matches_json TEXT,root_path TEXT,is_deleted INTEGER DEFAULT 0,status TEXT DEFAULT 'ok')")
 const insert=db.prepare('INSERT INTO entries(relative_path,file_size,modified_at,font_json,installed,installed_by,matches_json,root_path) VALUES (?,1,?, ?,0,?,?,?)')
 for(const id of ['a','b'])insert.run(id+'.ttf',1,JSON.stringify({id,path:'\\\\nas\\fonts\\'+id+'.ttf',localTagNames:['keep']}),'none','[]','\\\\nas\\fonts')
 db.exec('CREATE TABLE sources(root_path TEXT PRIMARY KEY,index_db_path TEXT,install_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)')
 let committed=0,failProjection=true,projectionCalls=0,saves=0,persisted={},nasAccesses=0
 const deny=()=>{nasAccesses++;throw Error('NAS must not be queried')}
 const runtime=load()(mergeFile).createMergedIndexValidationRuntime({
  mergedIndexSourcesKey:JSON.stringify,getSqliteMeta:()=>'',setSqliteMeta:deny,writeMergedIndexSourceRow:deny,installStatusContentSignature:deny,
  runMergedIndexMutation:async(_,fn)=>fn({commit(){committed++}}),openMergedIndexDb:async()=>db,closeSqliteDb(){},appendStartupLog(){},appWatchedFolders:deny,
 },{mergedIndexSourcesForRoots:deny},{ensureMergedIndexBuilt:deny})
 const queue=load()(queueFile).createActivationInstallStatusSaveQueue({
  readInstallStatusIndex:async()=>({results:persisted,misses:[]}),saveInstallStatusIndex:async results=>{saves++;persisted={...persisted,...results}},
  appWatchedFolders:deny,rootForFontPath:deny,clearFontQueryCaches(){},appendStartupLog(){},batchDelayMs:60000,
  syncMergedIndexAfterInstallStatusRefresh:async(roots,items)=>{projectionCalls++;assert.equal(roots.length,0);if(failProjection){failProjection=false;throw Error('local busy')}await runtime.syncMergedIndexAfterInstallStatusRefresh(roots,deny,items,deny)}
 })
 const item={id:load()('src/main/fonts/fontFileIdentity.ts').fileRuntimeFontId('\\\\nas\\fonts\\a.ttf',1,1),path:'\\\\nas\\fonts\\a.ttf',fileName:'a.ttf',fileSize:1,modifiedAt:1}
 const signature=load()('src/main/install/status/installStatusSignatureRuntime.ts')
 const sourceRow=db.prepare('SELECT * FROM entries WHERE relative_path=?').get('a.ttf')
 const sourceSignature=signature.rootInstallStatusSignature(sourceRow.root_path,sourceRow.relative_path,sourceRow.file_size,sourceRow.modified_at,sourceRow.font_json)
 assert.equal(signature.installStatusSignatureValue(item),sourceSignature,'positive fixture must carry the exact indexed filename and stat')
 const incomplete={id:item.id,path:item.path,installStatusKnown:true,active:true,systemInstalled:false,systemInstallMatches:[]}
 assert.notEqual(signature.installStatusSignatureValue(incomplete),sourceSignature,'original incomplete fixture must not become authoritative')
 try {
  queue.schedule({[item.id]:{installed:true,by:'managed',matches:[]}},new Map([[item.id,item]]),'activate')
  await queue.flush('first');assert.equal(queue.hasPending(),true);assert.equal(db.prepare('SELECT installed FROM entries WHERE relative_path=?').get('a.ttf').installed,0)
  await queue.flush('retry');assert.equal(projectionCalls,2,'persisted install facts must not suppress failed local projection');assert.equal(queue.hasPending(),false)
  assert.equal(db.prepare('SELECT installed_by FROM entries WHERE relative_path=?').get('a.ttf').installed_by,'managed')
  assert.equal(db.prepare('SELECT installed_by FROM entries WHERE relative_path=?').get('b.ttf').installed_by,'none')
  queue.schedule({[item.id]:{installed:false,by:'none',matches:[]}},new Map([[item.id,item]]),'deactivate');await queue.flush('deactivate')
  assert.equal(db.prepare('SELECT installed FROM entries WHERE relative_path=?').get('a.ttf').installed,0)
  assert.deepEqual(JSON.parse(db.prepare('SELECT font_json FROM entries WHERE relative_path=?').get('a.ttf').font_json).localTagNames,['keep']);assert.equal(committed,2);assert.equal(saves,3);assert.equal(nasAccesses,0)
  const peerBefore=plain(db.prepare('SELECT * FROM entries WHERE relative_path=?').get('b.ttf'))
  // The old id/path-only fixture is a real signature mismatch, not managed evidence.
  await runtime.syncMergedIndexAfterInstallStatusRefresh([],deny,[incomplete],deny)
  const withdrawn=db.prepare('SELECT installed,installed_by,matches_json,font_json FROM entries WHERE relative_path=?').get('a.ttf')
  assert.deepEqual([withdrawn.installed,withdrawn.installed_by,withdrawn.matches_json],[null,null,null],'incomplete signature must withdraw projected status')
  assert.deepEqual(JSON.parse(withdrawn.font_json).localTagNames,['keep'])
  assert.equal(db.prepare('SELECT installed_by FROM entries WHERE relative_path=?').get('b.ttf').installed_by,'none')
  assert.deepEqual(plain(db.prepare('SELECT * FROM entries WHERE relative_path=?').get('b.ttf')),peerBefore,'signature withdrawal must leave the peer row unchanged')
  assert.equal(committed,3,'only the explicit withdrawal adds one local projection commit');assert.equal(saves,3,'withdrawal must not resave install evidence');assert.equal(nasAccesses,0,'signature withdrawal must remain local')
 } finally {db.close()}
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
