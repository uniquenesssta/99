#!/usr/bin/env node
// U-07: real temp files, SQLite quick_check/VACUUM and cache writers.
// Rust results and OS error codes are controlled ports, not Windows native acceptance.
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path')
const {DatabaseSync}=require('node:sqlite')
const {loader}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'), base='src/main/maintenance/'
const labels=['library','tasks','preview','kvs','events','hash','metrics'], lazy=['preview','events','hash','metrics']
const plain=x=>JSON.parse(JSON.stringify(x))
let checks=0
const check=fn=>{fn();checks++}
function fixture({rust=false,missingRequired=false,transforms={},statError,openError,backupResult}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-u07-')),dbDir=path.join(dir,'db')
  fs.mkdirSync(dbDir)
  const logs=[],opens=[],requests=[],handles=[]
  const file=label=>path.join(dbDir,label+'.sqlite')
  const create=label=>{const db=new DatabaseSync(file(label));db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('keep history');");db.close()}
  if(!missingRequired)for(const label of ['library','tasks','kvs'])create(label)
  const mocks={
    [path.join(root,base+'previewCacheMaintenanceRuntime.ts')]:{createPreviewCacheMaintenanceRuntime:()=>({runPreviewCacheMaintenance:async()=>({checkedRows:0,staleRows:0,removedFiles:0,removedOrphanFiles:0,errors:[]})})}
  }
  if(statError)mocks['node:fs']={...fs,promises:{...fs.promises,stat:async p=>{const code=statError(p);if(code)throw Object.assign(Error(code+' stat rejected'),{code});return fs.promises.stat(p)}}}
  const load=loader(mocks,{},transforms)
  const open=async label=>{opens.push(label);if(openError?.(label))throw Error(openError(label));const db=new DatabaseSync(file(label),{readOnly:true});handles.push(db);return db}
  const options={appName:'HFM',maintenanceSqliteSchemaVersion:1,databaseBackupRetentionCount:3,autoDatabaseBackupIntervalMs:86400000,
    backupsRootPath:()=>path.join(dir,'backups'),maintenanceStatePath:()=>path.join(dir,'maintenance.json'),dataRoot:()=>dir,
    exists:async p=>fs.existsSync(p),appendStartupLog:line=>logs.push(line),normalizePathForCacheCompare:x=>x,
    checkpointTasksDb(){},checkpointOpenCacheDbs(){},getOpenLibraryDb:()=>null,getOpenPreviewDb:()=>null,
    loadLibraryShell:async()=>({folders:[]}),localPreviewImageDir:()=>path.join(dir,'images'),
    runTaskMaintenance:async()=>({resetRunning:0,removedCompleted:0,removedFailed:0,removedErrors:0}),
    closeLibraryDb(){},closeTasksDb(){},closePreviewDb(){},closeCacheDb(){},
    restoreLatestDatabaseBackupForLabel:async()=>({ok:false,message:'no backup'}),quarantineSqliteFiles:async()=>{throw Error('unexpected quarantine')},recoveryMessage:String}
  for(const label of labels){options[label+'SqlitePath']=()=>file(label);options['open'+label[0].toUpperCase()+label.slice(1)+'Db']=()=>open(label)}
  const rustRead=async input=>{
    requests.push(plain(input.items))
    return {items:input.items.map(item=>{let db;try{db=new DatabaseSync(item.filePath,{readOnly:true});const row=db.prepare('PRAGMA quick_check').get();const message=String(Object.values(row)[0]);return {...item,ok:message==='ok',message}}catch(error){return {...item,ok:false,message:error.message}}finally{db?.close()}}),elapsedMs:1}
  }
  if(rust)options.runRustDatabaseHealthCheck=rustRead
  if(backupResult)options.runRustDatabaseBackup=backupResult
  const runtime=load(base+'applicationDatabaseMaintenanceRuntime.ts').createApplicationDatabaseMaintenanceRuntime(options)
  return {dir,file,create,logs,opens,requests,handles,options,load,runtime,rustRead,close(){handles.forEach(db=>db.close());fs.rmSync(dir,{recursive:true,force:true})}}
}
async function absence(transforms={}) {
  for(const rust of [false,true]) {
    const h=fixture({rust,transforms})
    try {
      const report=await h.runtime.runDatabaseMaintenance()
      check(()=>{assert.equal(report.ok,true);assert.deepEqual(plain(report.health.map(x=>x.label)),labels);assert(report.health.every(x=>x.ok))})
      check(()=>{for(const label of lazy){assert(!fs.existsSync(h.file(label)));assert(!h.opens.includes(label));assert.match(report.health.find(x=>x.label===label).message,/optional/)}})
      if(rust)check(()=>assert.deepEqual(h.requests[0].map(x=>x.label),['library','tasks','kvs']))
      await h.runtime.runStartupDatabaseMaintenance()
      check(()=>{assert(h.logs.includes('startup database maintenance finished: ok=true'));assert(!h.logs.some(x=>x.includes('health warning')));assert(fs.existsSync(path.join(h.dir,'maintenance.json')));for(const label of lazy)assert(!fs.existsSync(h.file(label)))})
      const backupDirs=fs.readdirSync(path.join(h.dir,'backups')),manifest=JSON.parse(fs.readFileSync(path.join(h.dir,'backups',backupDirs[0],'backup-manifest.json')))
      check(()=>{assert.equal(manifest.ok,true);assert.equal(manifest.items.length,7);for(const label of lazy)assert.equal(manifest.items.find(x=>x.label===label).sizeBytes,0)})
      for(const item of manifest.items.filter(x=>x.backupPath)){const db=new DatabaseSync(item.backupPath,{readOnly:true});check(()=>assert.equal(db.prepare('SELECT value FROM evidence').get().value,'keep history'));db.close()}
    } finally {h.close()}
  }
}
async function failures() {
  for(const rust of [false,true]) {
    const missing=fixture({rust,missingRequired:true})
    try {const result=await missing.runtime.runDatabaseHealthCheck();check(()=>assert.deepEqual(plain(result.filter(x=>!x.ok).map(x=>x.label)),['library','tasks','kvs']))}finally{missing.close()}
    const h=fixture({rust})
    try {
      for(const label of lazy)h.create(label)
      const before=fs.readFileSync(h.file('hash'))
      fs.writeFileSync(h.file('events'),'not a database')
      const report=await h.runtime.runDatabaseMaintenance()
      check(()=>{assert.equal(report.ok,false);assert.equal(report.health.find(x=>x.label==='events').ok,false);assert.equal(report.health.find(x=>x.label==='hash').ok,true);assert.deepEqual(fs.readFileSync(h.file('hash')),before);assert.equal(fs.readFileSync(h.file('events'),'utf8'),'not a database')})
      await h.runtime.runStartupDatabaseMaintenance()
      check(()=>{assert(h.logs.some(x=>x.includes('startup database health warning')&&x.includes('events:')));assert(!fs.existsSync(path.join(h.dir,'maintenance.json')))})
    }finally{h.close()}
    for(const code of ['EACCES','EPERM','EIO','ENOTDIR']) {
      const h=fixture({rust,statError:p=>p.endsWith('events.sqlite')?code:null})
      try {const report=await h.runtime.runDatabaseMaintenance();check(()=>{assert.equal(report.ok,false);assert.match(report.health.find(x=>x.label==='events').message,new RegExp(code));assert(!h.opens.includes('events'));assert(!h.requests.flat().some(x=>x.label==='events'))})}finally{h.close()}
    }
    for(const reason of ['SQLITE_BUSY: database locked','SQLITE_READONLY: write rejected','SQLITE_IOERR: disk error']) {
      const h=fixture({rust,openError:label=>label==='events'?reason:null})
      try {
        h.create('events')
        if(rust)h.options.runRustDatabaseHealthCheck=async input=>{const r=await h.rustRead(input);r.items.find(x=>x.label==='events').ok=false;r.items.find(x=>x.label==='events').message=reason;return r}
        const runtime=h.load(base+'applicationDatabaseMaintenanceRuntime.ts').createApplicationDatabaseMaintenanceRuntime(h.options)
        const health=await runtime.runDatabaseHealthCheck();check(()=>{const event=health.find(x=>x.label==='events');assert.equal(event.ok,false);assert(event.message.includes(reason))})
      }finally{h.close()}
    }
  }
}
async function racesAndProtocol() {
  for(const mode of ['deleted-after-check','duplicate','wrong-path','null','throw']) {
    const h=fixture({rust:true})
    try {
      h.create('events')
      h.options.runRustDatabaseHealthCheck=async input=>{
        if(mode==='null')return null
        if(mode==='throw')throw Error('worker unavailable')
        const r=await h.rustRead(input)
        if(mode==='deleted-after-check'){fs.unlinkSync(h.file('events'));Object.assign(r.items.find(x=>x.label==='events'),{ok:false,message:'corrupt database before removal'})}
        if(mode==='duplicate')r.items[r.items.length-1]={...r.items[0]}
        if(mode==='wrong-path')r.items[0].filePath='different.sqlite'
        return r
      }
      const runtime=h.load(base+'applicationDatabaseMaintenanceRuntime.ts').createApplicationDatabaseMaintenanceRuntime(h.options)
      const result=await runtime.runDatabaseHealthCheck()
      check(()=>{if(mode==='deleted-after-check'){assert.equal(result.find(x=>x.label==='events').ok,false);assert.match(result.find(x=>x.label==='events').message,/corrupt/)}else{assert(result.every(x=>x.ok));assert(h.opens.includes('events'))}})
    }finally{h.close()}
  }
}
async function writers() {
  const h=fixture()
  try {
    await h.runtime.runDatabaseHealthCheck()
    const options={...h.options,cacheArchitectureVersion:3,eventsSqliteSchemaVersion:1,hashSqliteSchemaVersion:1,
      setSqliteMeta:(db,k,v)=>db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(k,v),
      normalizePathForCacheCompare:x=>x.toLowerCase(),fileCacheSignature:()=> 'signature',sha1:x=>x,
      openRecoverableApplicationSqliteDb:async p=>{const db=new DatabaseSync(p);h.handles.push(db);return {exec:sql=>db.exec(sql),prepare:sql=>db.prepare(sql),transaction:fn=>()=>{db.exec('BEGIN');try{fn();db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}}}},closeSqliteDb(){}}
    const cache=h.load('src/main/cache/cacheArchitectureRuntime.ts').createCacheArchitectureRuntime(options)
    await cache.upsertFontHashIndex([])
    check(()=>assert(!fs.existsSync(h.file('hash'))))
    await cache.recordCacheEvent('test','scan_finished',{fontId:'a'})
    await cache.upsertFontHashIndex([{id:'a',path:'C:/fonts/a.ttf',fileSize:12,modifiedAt:1}])
    const report=await h.runtime.runDatabaseHealthCheck()
    check(()=>{assert(report.every(x=>x.ok));for(const label of ['events','hash'])assert.equal(report.find(x=>x.label===label).message,'ok')})
    for(const [label,table]of [['events','index_events'],['hash','file_hashes']]){const db=new DatabaseSync(h.file(label),{readOnly:true});check(()=>assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,1));db.close()}
  }finally{h.close()}
}
async function failedBackup(transforms={}) {
  const h=fixture({transforms,backupResult:async input=>({ok:false,reason:input.reason,createdAt:input.createdAt,backupDir:path.join(input.backupsRoot,input.backupDirName),items:input.items.map(item=>({label:item.label,sourcePath:item.filePath,ok:false,sizeBytes:0,message:'backup readonly'})),elapsedMs:1})})
  try {
    await h.runtime.runStartupDatabaseMaintenance()
    check(()=>{assert(h.logs.includes('startup database maintenance finished: ok=false'),'failed automatic backup reported success');assert(!fs.existsSync(path.join(h.dir,'maintenance.json')));assert(h.logs.some(x=>x.includes('next startup remains eligible')))})
  }finally{h.close()}
}
async function requiredStartup(transforms={}) {
  for(const rust of [false,true]) {
    const h=fixture({rust,missingRequired:true,transforms}),order=[]
    try {
      const ownerOptions={...h.options,cacheArchitectureVersion:3,kvsSqliteSchemaVersion:1,taskSqliteSchemaVersion:1,taskLockStaleMs:60000,safeStartupTaskTypes:[],recoverScanTasksOnStartup:false,
        ensureSqliteColumn(){},getLibraryDb:()=>null,
        setSqliteMeta:(db,k,v)=>db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(k,v),
        openRecoverableApplicationSqliteDb:async(p,label)=>{order.push(label);const db=new DatabaseSync(p);h.handles.push(db);return db},closeSqliteDb(){}}
      const tasks=h.load('src/main/tasks/backgroundTasks.ts').createBackgroundTaskRuntime(ownerOptions)
      const cache=h.load('src/main/cache/cacheArchitectureRuntime.ts').createCacheArchitectureRuntime(ownerOptions)
      // Library initialization is a controlled port; task/KVS owners and their schemas are real.
      let libraryDb
      h.options.openLibraryDb=async()=>{if(libraryDb)return libraryDb;order.push('library');h.create('library');libraryDb=new DatabaseSync(h.file('library'));h.handles.push(libraryDb);return libraryDb}
      h.options.openTasksDb=tasks.openTasksDb;h.options.openKvsDb=cache.openKvsDb
      const runtime=h.load(base+'applicationDatabaseMaintenanceRuntime.ts').createApplicationDatabaseMaintenanceRuntime(h.options)
      await runtime.runStartupDatabaseMaintenance()
      check(()=>{assert.deepEqual(order,['library','tasks','kvs'],'required owners must initialize in order before health');assert(h.logs.includes('startup database maintenance finished: ok=true'));assert(!h.logs.some(x=>x.includes('health warning')));for(const label of lazy)assert(!fs.existsSync(h.file(label)))})
      for(const [label,table] of [['tasks','tasks'],['kvs','kvs']]){const db=new DatabaseSync(h.file(label),{readOnly:true});check(()=>assert(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)));db.close()}
      const before=h.logs.filter(x=>x.includes('required database initialized:')).length
      await runtime.runStartupDatabaseMaintenance()
      check(()=>assert.equal(h.logs.filter(x=>x.includes('required database initialized:')).length,before,'existing files initialized again'))
    }finally{h.close()}
  }
  for(const reason of ['EACCES','SQLITE_READONLY']) {
    const h=fixture({missingRequired:true,statError:reason==='EACCES'?p=>p.endsWith('library.sqlite')?'EACCES':null:undefined})
    try {
      h.options.openLibraryDb=async()=>{throw Error(reason)}
      const runtime=h.load(base+'applicationDatabaseMaintenanceRuntime.ts').createApplicationDatabaseMaintenanceRuntime(h.options)
      await runtime.runStartupDatabaseMaintenance()
      check(()=>{assert(h.logs.some(x=>x.includes('startup database maintenance skipped:')&&x.includes(reason)));assert(!h.logs.includes('startup database maintenance finished: ok=true'));assert(!fs.existsSync(h.file('tasks')))})
    }finally{h.close()}
  }
}
async function backupAbsenceError() {
  const h=fixture({statError:p=>p.endsWith('events.sqlite')?'EACCES':null})
  try {
    const report=await h.runtime.createDatabaseBackup('controlled-access-error')
    check(()=>{assert.equal(report.ok,false);assert.equal(report.items.find(x=>x.label==='events').ok,false);assert.match(report.items.find(x=>x.label==='events').message,/EACCES/);assert(!h.opens.includes('events'));assert(!fs.existsSync(h.file('events')))})
  }finally{h.close()}
}
async function main() {
  await absence();await failures();await racesAndProtocol();await writers();await failedBackup();await requiredStartup();await backupAbsenceError()
  const helper=path.join(root,base+'databaseMaintenanceHelpers.ts'),coordinator=path.join(root,base+'databaseMaintenance.ts')
  function mutation(file, before, after, eol) {
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    assert(source.includes(before), 'database health mutation anchor missing')
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, 'database health mutation must change source')
    return { [file]: () => changed.replace(/\n/g, eol) }
  }
  for (const eol of ['\n', '\r\n']) {
    await assert.rejects(absence(mutation(helper, " || spec.label === 'events' || spec.label === 'hash'", '', eol)), assert.AssertionError);checks++
    await assert.rejects(failedBackup(mutation(coordinator, 'report.ok = report.ok && backup.ok', 'report.ok = report.ok', eol)), /failed automatic backup reported success/);checks++
    await assert.rejects(requiredStartup(mutation(coordinator, 'await spec.open()\n          appendStartupLog', '/* initialization removed */\n          appendStartupLog', eol)), /required owners must initialize/);checks++
  }
  await absence({[helper]:s=>s.replace(/\r?\n/g,'\r\n'),[coordinator]:s=>s.replace(/\r?\n/g,'\r\n')})
  console.log(`[diagnostics:startup-database-health] ${checks} checks passed: fresh/existing directories, real SQLite health/backup/cache writers, Rust/Node classification, controlled permission/lock/IO errors, late removal, incomplete worker results, backup failure/retry, three mutants and CRLF`)
}
main().catch(error=>{console.error(error);process.exitCode=1})
