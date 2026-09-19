#!/usr/bin/env node
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs')
const {DatabaseSync}=require('node:sqlite'),{spawnSync}=require('node:child_process')
const {loader:baseLoader}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'),crlf=process.argv.includes('--crlf'),mutant=process.argv.find(x=>x.startsWith('--mutant='))?.split('=')[1]
const queueFile='src/main/activation/activationInstallStatusSaveQueue.ts',watchFile='src/main/watcher/folderWatcherRuntime.ts',mergeFile='src/main/indexing/merged-page/mergedIndexValidationRuntime.ts'
function load(mocks={},globals={}) {
 const transforms={}
 for(const file of [queueFile,watchFile,mergeFile])transforms[path.join(root,file)]=s=>{
  if(mutant==='projection'&&file===queueFile){assert(s.includes('!projectionPending.has(id) &&'));s=s.replace('!projectionPending.has(id) &&','')}
  if(mutant==='baseline'&&file===watchFile){const anchor='markStartupPathRootUnavailable(folder, error, options.appendStartupLog);';assert(s.includes(anchor));s=s.replace(anchor,'baseline = {}; '+anchor)}
  return crlf?s.replace(/\r?\n/g,'\r\n'):s
 }
 return baseLoader(mocks,globals,transforms)
}
const tick=()=>new Promise(r=>setImmediate(r)),plain=x=>JSON.parse(JSON.stringify(x))
async function settlement() {
 const db=new DatabaseSync(':memory:');db.function('hfm_shared_font_id',(relative,_size,_mtime)=>String(relative).replace('.ttf',''))
 db.exec('CREATE TABLE entries(relative_path TEXT,file_size INTEGER,modified_at TEXT,font_json TEXT,installed INTEGER,installed_by TEXT,matches_json TEXT)')
 const insert=db.prepare('INSERT INTO entries VALUES (?,1,?, ?,0,?,?)')
 for(const id of ['a','b'])insert.run(id+'.ttf','now',JSON.stringify({id,path:'\\\\nas\\fonts\\'+id+'.ttf',localTagNames:['keep']}),'none','[]')
 let committed=0,failProjection=true,projectionCalls=0,saves=0,persisted={}
 const deny=()=>{throw Error('NAS must not be queried')}
 const runtime=load()(mergeFile).createMergedIndexValidationRuntime({
  runMergedIndexMutation:async(_,fn)=>fn({commit(){committed++}}),openMergedIndexDb:async()=>db,closeSqliteDb(){},appWatchedFolders:deny,
 },{mergedIndexSourcesForRoots:deny},{ensureMergedIndexBuilt:deny})
 const queue=load()(queueFile).createActivationInstallStatusSaveQueue({
  readInstallStatusIndex:async()=>({results:persisted,misses:[]}),saveInstallStatusIndex:async results=>{saves++;persisted={...persisted,...results}},
  appWatchedFolders:deny,rootForFontPath:deny,clearFontQueryCaches(){},appendStartupLog(){},batchDelayMs:60000,
  syncMergedIndexAfterInstallStatusRefresh:async(roots,items)=>{projectionCalls++;assert.equal(roots.length,0);if(failProjection){failProjection=false;throw Error('local busy')}await runtime.syncMergedIndexAfterInstallStatusRefresh(roots,deny,items,deny)}
 })
 const item={id:'a',path:'\\\\nas\\fonts\\a.ttf'}
 try {
  queue.schedule({a:{installed:true,by:'managed',matches:[]}},new Map([['a',item]]),'activate')
  await queue.flush('first');assert.equal(queue.hasPending(),true);assert.equal(db.prepare('SELECT installed FROM entries WHERE relative_path=?').get('a.ttf').installed,0)
  await queue.flush('retry');assert.equal(projectionCalls,2,'persisted install facts must not suppress failed local projection');assert.equal(queue.hasPending(),false)
  assert.equal(db.prepare('SELECT installed_by FROM entries WHERE relative_path=?').get('a.ttf').installed_by,'managed')
  assert.equal(db.prepare('SELECT installed_by FROM entries WHERE relative_path=?').get('b.ttf').installed_by,'none')
  queue.schedule({a:{installed:false,by:'none',matches:[]}},new Map([['a',item]]),'deactivate');await queue.flush('deactivate')
  assert.equal(db.prepare('SELECT installed FROM entries WHERE relative_path=?').get('a.ttf').installed,0)
  assert.deepEqual(JSON.parse(db.prepare('SELECT font_json FROM entries WHERE relative_path=?').get('a.ttf').font_json).localTagNames,['keep']);assert.equal(committed,2);assert.equal(saves,3)
 } finally {db.close()}
}
async function watcher() {
 let timerId=0,snapshot={'a.ttf':{size:1}},failure=false,held=null,offline=0
 const timers=new Map(),batches=[]
 const runtime=load({electron:{BrowserWindow:{getAllWindows:()=>[]}},'node:fs':{...fs,watch(){throw Error('main fs.watch must not receive isolated root')}},
  [path.join(root,'src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{sharedIoResourceKeys:async()=>['nas']},
  [path.join(root,'src/main/path/sharedFileSystemRuntime.ts')]:{executeSharedFile:async()=>{if(held)return held;if(failure)throw Error('network timeout');return {result:{value:snapshot}}}},
  [path.join(root,'src/main/path/startupPathAvailabilityRuntime.ts')]:{ensureStartupPathRootAvailable:async()=>true,markStartupPathRootUnavailable(){offline++}},
 },{setTimeout(fn,ms){const token={id:++timerId,unref(){}};timers.set(token,{fn,ms});return token},clearTimeout(token){timers.delete(token)}})(watchFile).createFolderWatcherRuntime({
  appendStartupLog(){},isIgnoredWatcherPath:()=>false,verboseLogs:false,startupGraceMs:0,flushDebounceMs:10,closeRuntimeDatabases(){},watcherChangeBatchLooksUnchanged:async()=>false,
  applyWatchedFolderChangesToIndex:async changes=>{batches.push(plain(changes));return {upserts:[],deletes:[]}}
 })
 async function poll(){const row=[...timers].find(([,t])=>t.ms===30000);assert(row,'next poll absent');timers.delete(row[0]);row[1].fn();await tick()}
 try {
  await runtime.startWatchingFolders(['/test/shared']);await tick();await runtime.flushPendingFolderChanges();assert.equal(batches.length,1)
  failure=true;await poll();await runtime.flushPendingFolderChanges();assert.equal(batches.length,1);assert.equal(offline,1)
  failure=false;await poll();await runtime.flushPendingFolderChanges();assert.equal(batches.length,1,'failed poll must retain old baseline')
  snapshot={};await poll();await runtime.flushPendingFolderChanges();assert.equal(batches.length,2);assert.equal(batches[1][0].fileName,'a.ttf')
  let resolve;held=new Promise(r=>resolve=r);await poll();runtime.stopFolderWatchers();resolve({result:{value:{'late.ttf':{size:3}}}});await tick();await runtime.flushPendingFolderChanges();assert.equal(batches.length,2);assert.equal(timers.size,0)
 } finally {runtime.stopFolderWatchers()}
}
async function main(){await settlement();await watcher();if(!crlf&&!mutant){for(const arg of ['--crlf','--mutant=projection','--mutant=baseline']){const r=spawnSync(process.execPath,[__filename,arg],{encoding:'utf8',timeout:30000});assert.equal(r.status===0,arg==='--crlf',arg+'\n'+r.stdout+r.stderr)}}console.log('offline settlement/watcher: actual local SQLite, failed projection retry, unrelated fields, retained snapshot, late stop, CRLF and two causal mutants passed')}
main().catch(e=>{console.error(e);process.exitCode=1})
