#!/usr/bin/env node
// O-00 observer, NOT an offline correctness gate. Default executes pinned baseline sources.
if (process.argv.includes('--hung-child')) {
  process.stdout.write('ready\n')
  setInterval(() => {}, 1000)
} else {
const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const { spawn, execFileSync } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname,'../..')
const baseline = '117b08470b55556d9c066da618e4afaf7947178a'
const current = process.argv.includes('--current'), crlf = process.argv.includes('--crlf')
const transforms = {}
const sources = execFileSync('git',['ls-tree','-r','--name-only',baseline,'src'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(p=>p.endsWith('.ts'))
for(const file of sources) transforms[path.join(root,file)] = source => {
  const text = current ? source : execFileSync('git',['show',baseline+':'+file],{cwd:root,encoding:'utf8'})
  return crlf ? text.replace(/\r?\n/g,'\r\n') : text
}
const load = (mocks={},globals={}) => loader(mocks,globals,transforms)
const rows=[]
const report=(id,defect,evidence)=>rows.push({id,status:defect?'KNOWN_DEFECT':'CONTROL_PASS',evidence})
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
async function rootAndCatalog(dir) {
  const offline='\\\\offline-test\\fonts', online='\\\\online-test\\fonts', mapped='O:\\fonts'
  const calls=[]
  const sql=new DatabaseSync(path.join(dir,'catalog.sqlite'))
  sql.exec('CREATE TABLE tags(name TEXT PRIMARY KEY, sort_order INTEGER)')
  sql.prepare('INSERT INTO tags VALUES (?,?)').run('离线保留',0)
  sql.prepare('INSERT INTO tags VALUES (?,?)').run('在线标签',1)
  const db={prepare:q=>sql.prepare(q),transaction:fn=>()=>{sql.exec('BEGIN');try{const r=fn();sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}}
  const l=load({'node:fs':{promises:{stat:async p=>{calls.push(p);if(p===offline)throw Error('ENETUNREACH');return {isDirectory:()=>true}}}}}, {process:{...process,env:{}}})
  try {
    const available=l('src/main/path/startupPathAvailabilityRuntime.ts')
    assert.equal(await available.ensureStartupPathRootAvailable(mapped),true)
    assert.equal(calls.length,0)
    report('B01',true,{mappedAcceptedWithoutProbe:true,statCalls:0,boundary:'mapped-drive policy; Windows drive mapping not exercised'})
    assert.equal(await available.ensureStartupPathRootAvailable(offline),false)
    assert.equal(await available.ensureStartupPathRootAvailable(offline),false)
    assert.equal(calls.filter(p=>p===offline).length,1)
    report('C01',false,{uncRejected:true,repeatSuppressed:true,perRootStatCalls:{offline:1}})
    const runtime=l('src/main/library/sharedKnownTagsRuntime.ts').createSharedKnownTagsRuntime({
      uniqueResolvedFolders:x=>x,sharedMetadataDbPathForRoot:p=>p+'/metadata.sqlite',
      openLibraryDb:async()=>db,loadLibraryShellFromSqlite:()=>({tags:sql.prepare('SELECT name FROM tags ORDER BY sort_order').all().map(r=>r.name)}),
      appendStartupLog(){},runRustSharedMetadataKnownTags:async({roots})=>{assert.equal(roots.length,1);assert.equal(roots[0].rootPath,online);return {knownTags:['在线标签']}}
    })
    const before=sql.prepare('SELECT name FROM tags ORDER BY sort_order').all().map(r=>r.name)
    const result=await runtime.refreshKnownSharedTagsFromMetadata([offline,online])
    assert.deepEqual(Array.from(result),['在线标签'])
    const reader=new DatabaseSync(path.join(dir,'catalog.sqlite'))
    try {assert.deepEqual(reader.prepare('SELECT name FROM tags').all().map(r=>r.name),['在线标签'])} finally {reader.close()}
    report('B02',true,{before,after:Array.from(result),persistedOverwrite:true,options:'default',perRootStatCalls:{offline:calls.filter(p=>p===offline).length,online:calls.filter(p=>p===online).length}})
    sql.prepare('INSERT INTO tags VALUES (?,?)').run('离线保留',2)
    const preserved=await runtime.refreshKnownSharedTagsFromMetadata([offline,online],{allowEmptyOverwrite:false})
    assert(preserved.includes('离线保留'))
    await assert.rejects(runtime.refreshKnownSharedTagsFromMetadata([offline,online],{requireFresh:true}),/不能确认/)
    report('C02',false,{explicitPreserveWorks:true,requireFreshRejectsPartial:true})
  } finally {sql.close()}
}
function lifecycle(dir,flush,remaining=0) {
  const app=new EventEmitter(), events=[], logs=[]
  let quits=0,restores=0
  Object.assign(app,{setName(){},setAppUserModelId(){},getVersion:()=> 'test',getPath:()=>dir,getAppPath:()=>dir,requestSingleInstanceLock:()=>true,whenReady:()=>new Promise(()=>{}),quit(){quits++;events.push('quit')}})
  const globals={process:{...process,platform:'win32',argv:[],env:{},on(){}}}
  const mocks={electron:{app,BrowserWindow:{getAllWindows:()=>[]},dialog:{showErrorBox:()=>events.push('error-dialog')}},
    [path.join(root,'src/main/security/appSecurityRuntime.ts')]:{},
    [path.join(root,'src/main/app/appIntegrityRuntime.ts')]:{},
    [path.join(root,'src/main/app/appDataRootPolicyRuntime.ts')]:{configureElectronUserDataRoot:()=>dir}}
  const options=new Proxy({appName:'test',appendLog:m=>logs.push(m),
    cleanupTemporaryActiveFontsUntilEmpty:async()=>{events.push('cleanup-local');return {remaining}},
    flushPendingTemporaryFontDeletes:async()=>events.push('delete-flush'),
    flushActivationInstallStatusSave:async()=>{events.push('status-flush');await flush()},
    stopFolderWatchers:()=>events.push('watchers-stop'),createWindow(){restores++},
    hasPendingActivationInstallStatusSave:()=>false,hasInFlightActivationInstallStatusSave:()=>false,
    flushStartupLogAsync:async()=>events.push('log-flush')},{get:(o,k)=>k in o?o[k]:()=>{}})
  load(mocks,globals)('src/main/app/mainProcessLifecycleRuntime.ts').registerMainProcessLifecycleRuntime(options)
  app.emit('before-quit',{preventDefault:()=>events.push('prevent-quit')})
  return {events,logs,quits:()=>quits,restores:()=>restores}
}
async function exitDependency(dir) {
  for(const blockedAt of ['root','sync']) {
    const gate=deferred(), entered=deferred(), calls=[]
    const item={id:'test-font',path:'\\\\offline-test\\fonts\\a.ttf'}
    const q=load()('src/main/activation/activationInstallStatusSaveQueue.ts').createActivationInstallStatusSaveQueue({
      readInstallStatusIndex:async()=>({results:{},misses:[item]}),saveInstallStatusIndex:async()=>calls.push('save'),
      appWatchedFolders:async()=>['\\\\offline-test\\fonts'],rootForFontPath:async source=>{calls.push('root:'+source);if(blockedAt==='root'){entered.resolve();await gate.promise}return '\\\\offline-test\\fonts'},
      syncMergedIndexAfterInstallStatusRefresh:async()=>{calls.push('sync');if(blockedAt==='sync'){entered.resolve();await gate.promise}},clearFontQueryCaches(){},appendStartupLog(){},batchDelayMs:60000
    })
    q.schedule({[item.id]:{installed:false,by:'none',matches:[]}},new Map([[item.id,item]]),'test')
    const h=lifecycle(dir,()=>q.flush('before-quit'))
    await entered.promise;await tick()
    try {
      assert(q.hasInFlight());assert.equal(h.quits(),0);assert(!h.events.includes('watchers-stop'));assert(h.events.includes('cleanup-local'))
      report(blockedAt==='root'?'B03':'B04',true,{blockedAt,sourceAccesses:calls.filter(c=>c.startsWith('root:')).length,cleanupCompleted:true,exitBlocked:true,watchersStillRunning:true,events:[...h.events],productionLogs:h.logs.filter(m=>m.startsWith('before-quit')),boundary:'actual lifecycle + save queue; OS cleanup and network endpoints controlled'})
    } finally {gate.resolve();await q.flush('test-drain');await tick()}
    assert.equal(h.quits(),1);assert(!q.hasInFlight())
  }
  const residual=lifecycle(dir,async()=>{},1);await tick()
  assert.equal(residual.quits(),0);assert.equal(residual.restores(),1)
  report('B05',true,{remaining:1,exitBlocked:true,restoredWindow:true})
  const control=lifecycle(dir,async()=>{});await tick()
  assert.equal(control.quits(),1)
  report('C03',false,{normalExitOrder:control.events})
}
async function localRecords(dir) {
  const storeFile='src/main/windows/runtime/temporaryActiveFontsStoreRuntime.ts'
  const options={dataRoot:()=>dir,dataPath:n=>path.join(dir,n)}
  const store=load()(storeFile).createTemporaryActiveFontsStoreRuntime(options)
  const record={fontId:'test',sourcePath:'\\\\offline-test\\fonts\\a.ttf',installPath:path.join(dir,'test_ACTIVE_a.ttf'),registryName:'test_ACTIVE_a',fileName:'a.ttf',activatedAt:'test'}
  await store.saveTemporaryActiveFonts({version:1,records:[record]})
  assert.equal((await load()(storeFile).createTemporaryActiveFontsStoreRuntime(options).loadTemporaryActiveFonts()).records.length,1)
  await fsp.writeFile(options.dataPath('temporary-active-fonts.json'),'{broken')
  assert.equal((await store.loadTemporaryActiveFonts()).records.length,0)
  assert.equal(await fsp.readFile(options.dataPath('temporary-active-fonts.json'),'utf8'),'{broken')
  report('B06',true,{corruptRecordReportedEmpty:true,originalFileRetainedByRead:true,realFile:true})
  await fsp.writeFile(record.installPath,Buffer.from('test fixture; not installed'))
  const verify=load({}, {process:{...process,platform:'win32'}})('src/main/activation/runtime/fontActivationVerifyRuntime.ts').createFontActivationVerifyRuntime({normalizePathForCacheCompare:p=>p.toLowerCase(),clearInstalledFontsMemoryCache(){},getSystemInstalledFontsCached:async()=>[],appendStartupLog(){}})
  assert.equal(await verify.temporaryActiveRecordStillVisible(record),true)
  report('B07',true,{fileExists:true,systemRecords:0,stillVisible:true,boundary:'resource/registry enumeration mocked empty; real local file'})
  await fsp.unlink(record.installPath)
  assert.equal(await verify.temporaryActiveRecordStillVisible(record),false)
  const source=path.join(dir,'source.ttf');await fsp.writeFile(source,Buffer.from('copy fixture'))
  const copy=load()('src/main/activation/runtime/fontActivationCopyRuntime.ts').createFontActivationCopyRuntime({normalizePathForCacheCompare:p=>p,appendStartupLog(){},runRustFontActivationFiles:async({copies})=>{await fsp.copyFile(copies[0].source,copies[0].dest);return {copyResults:[{ok:true,mode:'copied'}]}}})
  await copy.copyTemporaryActiveFontWithTrace({id:'copy',path:source},record.installPath)
  await fsp.unlink(source);assert.equal(await fsp.readFile(record.installPath,'utf8'),'copy fixture')
  report('C04',false,{localRecordRoundTrip:true,copySurvivesSourceRemoval:true,nativeCopyPort:'controlled real filesystem copy; no OS activation'})
}
async function deadlineChild() {
  const child=spawn(process.execPath,[__filename,'--hung-child'],{stdio:['ignore','pipe','pipe'],windowsHide:true})
  const closed=once(child,'close')
  const watchdog=setTimeout(()=>child.kill(),5000)
  const started=performance.now()
  try {
    await once(child.stdout,'data')
    const runtime=load()('src/main/path/ioDeadlineRuntime.ts')
    const result=await runtime.withIoDeadlineResult('test-child-hung',()=>closed,100)
    assert.equal(result.ok,false);assert.equal(result.timedOut,true)
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);assert.equal(child.killed,false)
    report('B08',true,{timedOut:true,childStillAlive:true,childPid:child.pid,elapsedMs:Math.round(performance.now()-started),boundary:'real Node child ignoring completion; not a Windows SMB syscall'})
  } finally {child.kill();await closed;clearTimeout(watchdog)}
  report('C05',false,{childPid:child.pid,closeObserved:true,ownedChildRemaining:0})
}
async function main() {
  const guard=setTimeout(()=>{console.error('offline observer exceeded 15s safety budget');process.exit(1)},15000)
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'hfm-offline-baseline-'))
  try {await rootAndCatalog(dir);await exitDependency(dir);await localRecords(dir);await deadlineChild()}
  finally {clearTimeout(guard);await fsp.rm(dir,{recursive:true,force:true})}
  const reportData={mode:current?'current-observation':'pinned-baseline',baseline,crlf,knownDefects:rows.filter(r=>r.status==='KNOWN_DEFECT').length,controls:rows.filter(r=>r.status==='CONTROL_PASS').length,rows,limitations:['No real NAS access','No native Windows activation','No browser DOM or real Electron process exit'],businessCorrectnessPassed:false}
  console.log(JSON.stringify(reportData,null,2))
  if(process.argv.includes('--strict')&&reportData.knownDefects)process.exitCode=1
}
main().catch(error=>{console.error(error);process.exitCode=1})
}
