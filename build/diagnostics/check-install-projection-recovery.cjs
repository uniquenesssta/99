#!/usr/bin/env node
'use strict'
// Windows private SQLite + actual production writer/query/native page chain.
// No installation, registry mutation, user fonts, or NAS availability is needed.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { loader } = require('./check-operation-chain.cjs')
const { createHost } = require('./lib/production-projection-host.cjs')
const { DatabaseSync } = require('node:sqlite')
const root = path.resolve(__dirname, '../..'), plain = value => JSON.parse(JSON.stringify(value))
const status = installed => ({ known: true, installed, by: installed ? 'system' : 'none', matches: [] })
async function bounded(pending, label) {
  let timer
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`install projection watchdog: ${label}`)), 15000) })]) }
  finally { clearTimeout(timer) }
}
async function productionRecoveryCases() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-install-recovery-'))
  const folder = path.join(directory, 'fonts'); fs.mkdirSync(folder)
  let host
  try {
    host = await createHost({ sourceRoot: root, workerPath: path.join(root, 'build/native/hfm-core-worker.exe'), directory, fixtureDirectory: directory, roots: [folder] })
    const items = [0,1,2].map(index => {
      const fileName = `font-${index}.ttf`, file = path.join(folder, fileName)
      fs.writeFileSync(file, 'unchanged fixture bytes')
      return { id: host.fontIdentity.fileRuntimeFontId(file, 23, 100), path: file, fileName, fileSize: 23, modifiedAt: 100, createdAt: 100,
        family: `Fixture ${index}`, fullName: `Fixture ${index}`, style: 'Regular', format: 'ttf', scripts: ['latin'],
        tagNames: [], localTagNames: ['retained'], collectionIds: [], favorite: false, active: false, systemInstalled: false,
        installStatusKnown: true, systemInstallMatches: [], deleteProtected: false }
    })
    await host.initialize(items, { legacyRows: 0, oldProjection: true })
    const map = new Map(items.map(item => [item.id,item]))
    await host.status.saveInstallStatusIndex(Object.fromEntries(items.map(item => [item.id,status(false)])), map)
    host.setRootOnline(false)
    const request = installed => ({ sidebarPage:'library', activeFilter:{kind:'all'}, installStatus:installed ? 'installed' : 'notInstalled', sortMode:'nameAsc', limit:100, offset:0 })
    await host.query.queryFontPageInLibrary(request(false)) // actual version migration/startup authority
    const snapshot = () => { const db=host.openDb(host.paths.mergedPath,{readonly:true}); try { return { rows:plain(db.prepare('SELECT root_path,relative_path,installed,installed_by,font_json FROM entries ORDER BY relative_path').all()), sources:plain(db.prepare('SELECT * FROM sources').all()), meta:plain(db.prepare('SELECT * FROM meta ORDER BY key').all()) } } finally { db.close() } }
    const sqlite=host.load('src/main/db/sqliteHelpers.ts')
    const makeRuntime=(ports={})=>host.load('src/main/indexing/mergedIndexRuntime.ts').createMergedIndexRuntime({ dataPath:host.dataPath,exists:host.exists,
      openStableSqliteDb:host.openStableSqliteDb,openRootIndexDb:host.rootStorage.openRootIndexDb,closeSqliteDb:host.closeSqliteDb,
      ...sqlite,appendStartupLog(){},schemaVersion:host.config.MERGED_INDEX_SCHEMA_VERSION,staleFirstPageEnabled:true,...ports })
    const receiptRuntime=makeRuntime()
    const sourceShape=row=>({root:row.root_path,indexDbPath:row.index_db_path,installDbPath:row.install_db_path,indexSignature:row.index_signature,installSignature:row.install_signature,sharedMetadataSignature:row.shared_metadata_signature})
    const initialDb=host.openDb(host.paths.mergedPath)
    sqlite.setSqliteMeta(initialDb,'sourcesKey',receiptRuntime.mergedIndexSourcesKey(initialDb.prepare('SELECT * FROM sources').all().map(sourceShape)));initialDb.close()
    const initial = snapshot(), realSync=host.query.syncMergedIndexAfterInstallStatusRefresh
    const fail = Error('controlled durable A / failed projection')
    let failNext=true
    host.query.syncMergedIndexAfterInstallStatusRefresh=async (...args)=>{ if(failNext){failNext=false;throw fail} return realSync(...args) }
    await assert.rejects(() => host.writer.saveInstallStatusIndex({[items[0].id]:status(true)},new Map([[items[0].id,items[0]]])), error=>error===fail)
    assert.deepEqual(snapshot(), initial, 'A failed projection changed its receipt or rows')
    const persisted=await host.status.readInstallStatusIndex([items[0]])
    assert.equal(persisted.results[items[0].id].installed,true,'fault did not occur after actual durable source commit')
    const beforeDebtRepair={...host.sqlCounters}
    await host.writer.saveInstallStatusIndex({[items[1].id]:status(true)},new Map([[items[1].id,items[1]]]))
    assert.equal(host.sqlCounters.projectionSelectCalls-beforeDebtRepair.projectionSelectCalls,1,'complete debt repair omitted its full population pass')
    assert.equal(host.sqlCounters.projectionExaminedRows-beforeDebtRepair.projectionExaminedRows,3)
    assert.equal(host.sqlCounters.projectionUpdateCalls-beforeDebtRepair.projectionUpdateCalls,2,'DEBT_REPAIR_WRITES: one-row B must also repair durable A, without touching stable C')
    assert.equal(host.sqlCounters.projectionUpdatedRows-beforeDebtRepair.projectionUpdatedRows,2)
    assert.equal(host.sqlCounters.projectionIndexedUpdateCalls-beforeDebtRepair.projectionIndexedUpdateCalls,2)
    assert.equal(host.sqlCounters.projectionIdentityUdfCalls-beforeDebtRepair.projectionIdentityUdfCalls,0)
    const repaired=snapshot()
    assert.deepEqual(repaired.rows.map(row=>row.installed),[1,1,0],'COMPLETE_INSTALL_REPAIR: B falsely acknowledged only its own row')
    for(const source of repaired.sources) {
      const old=initial.sources.find(row=>row.root_path===source.root_path)
      assert.equal(source.index_signature,old.index_signature);assert.equal(source.shared_metadata_signature,old.shared_metadata_signature)
    }
    assert.equal(repaired.meta.find(row=>row.key==='sourcesKey').value,receiptRuntime.mergedIndexSourcesKey(repaired.sources.map(sourceShape)),'whole checkpoint is not canonical after complete repair')
    const metrics=await host.query.getFontMetricsFromLibrary(), page=await host.query.queryFontPageInLibrary(request(true))
    assert.deepEqual([metrics.total,metrics.installedCount,metrics.notInstalledCount,metrics.installStatusMissingCount],[3,2,1,0])
    assert.equal(page.workerMode,'rust-merged-index-page');assert.equal(page.total,2)
    // The production loader returns a VM-realm array; compare the exact IDs in
    // this realm without treating its Array prototype as projection state.
    assert.deepEqual(Array.from(page.items,item=>item.id).sort(),items.slice(0,2).map(item=>item.id).sort())
    assert(!host.nativeReceipts.some(row=>row.method==='runRustMergedIndexRebuild'),'local recovery touched offline root rebuild')

    // Real SQLite abort after the durable machine write rolls back all derived
    // state/receipts. The next unrelated writer repairs the whole authority.
    let db=host.openDb(host.paths.mergedPath)
    db.exec("CREATE TRIGGER projection_fault BEFORE UPDATE OF installed ON entries BEGIN SELECT RAISE(ABORT,'controlled projection transaction abort'); END;");db.close()
    const beforeRollback=snapshot()
    await assert.rejects(()=>host.writer.saveInstallStatusIndex({[items[1].id]:status(false)},new Map([[items[1].id,items[1]]])),/controlled projection transaction abort/)
    assert.deepEqual(snapshot(),beforeRollback,'failed transaction advanced projection or checkpoint')
    db=host.openDb(host.paths.mergedPath);db.exec('DROP TRIGGER projection_fault');db.close()
    await host.writer.saveInstallStatusIndex({[items[2].id]:status(true)},new Map([[items[2].id,items[2]]]))
    assert.deepEqual(snapshot().rows.map(row=>row.installed),[1,0,1])

    // Simulate restart after a source commit, including a historical falsely
    // current source receipt. A fresh production owner cannot trust version/key.
    await host.status.saveInstallStatusIndex({[items[0].id]:status(false)},new Map([[items[0].id,items[0]]]))
    const authority=host.openDb(host.paths.installPath,{readonly:true})
    const currentSignature=host.load('src/main/install/status/installStatusContentSignatureRuntime.ts').installStatusContentSignatureFromDb(authority);authority.close()
    db=host.openDb(host.paths.mergedPath);db.prepare('UPDATE sources SET install_signature=?').run(currentSignature)
    sqlite.setSqliteMeta(db,'sourcesKey',receiptRuntime.mergedIndexSourcesKey(db.prepare('SELECT * FROM sources').all().map(sourceShape)));db.close()
    let rootReads=0, opened=[]
    const restart=makeRuntime({
      exists:async file=>{assert(file.startsWith(host.paths.dataDirectory),'restart performed remote availability IO');return host.exists(file)},
      openStableSqliteDb:(file,label)=>{opened.push(file);return host.openStableSqliteDb(file,label)},
      openRootIndexDb:async()=>{rootReads++;throw Error('restart root IO forbidden')} })
    db=await restart.openMergedIndexDb();host.closeSqliteDb(db)
    assert.deepEqual(snapshot().rows.map(row=>row.installed),[0,0,1],'RESTART_INSTALL_REPAIR: current version/receipt hid durable unprojected row')
    assert.equal(rootReads,0);assert(opened.includes(host.paths.installPath))
    const afterRestart=snapshot();db=await restart.openMergedIndexDb();host.closeSqliteDb(db)
    assert.deepEqual(snapshot(),afterRestart,'second open rewrote stable projection')
    // Partial page hydration can update its own row but must keep the prior
    // whole-source ACK, so another committed but unseen row remains detectable.
    await host.status.saveInstallStatusIndex({[items[0].id]:status(true),[items[1].id]:status(true)},new Map(items.slice(0,2).map(item=>[item.id,item])))
    const beforePage=snapshot()
    await realSync([], [{...items[0],installStatusKnown:true,systemInstalled:true,active:false}], {preserveSourceCheckpoint:true})
    const afterPage=snapshot()
    assert.deepEqual(afterPage.rows.map(row=>row.installed),[1,0,1])
    assert.deepEqual(afterPage.sources,beforePage.sources,'partial page repair advanced whole authority receipt')
    assert.equal(afterPage.meta.find(row=>row.key==='sourcesKey').value,beforePage.meta.find(row=>row.key==='sourcesKey').value)
    for(const item of items)assert.equal(fs.readFileSync(item.path,'utf8'),'unchanged fixture bytes')
  } finally { if(host){await host.close();const proof=host.closeProof();assert.equal(proof.remainingChildren,0);assert.equal(proof.remainingDatabaseOwners,0)} fs.rmSync(directory,{recursive:true,force:true}) }
}
async function pinnedAuthorityCases(transforms={}) {
  const load=loader({}, {}, transforms), directory=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-pinned-authority-')), machines=path.join(directory,'machines')
  fs.mkdirSync(machines);const source=path.join(machines,'install.sqlite'), merged=new DatabaseSync(':memory:'), writer=new DatabaseSync(source)
  const item={path:'C:\\fonts\\a.ttf',fileName:'a.ttf',fileSize:1,modifiedAt:100}
  item.id=load('src/main/fonts/fontFileIdentity.ts').fileRuntimeFontId(item.path,1,100)
  const expected=load('src/main/install/status/installStatusSignatureRuntime.ts').installStatusSignatureValue(item)
  writer.exec('PRAGMA journal_mode=WAL;CREATE TABLE install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT,checked_at TEXT)')
  writer.prepare("INSERT INTO install_status VALUES (?,?,0,'none','[]','a')").run(item.id,expected)
  merged.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE sources(root_path TEXT PRIMARY KEY,index_db_path TEXT,install_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT,synced_at TEXT);CREATE TABLE entries(root_path TEXT,relative_path TEXT,file_size INTEGER,modified_at REAL,font_json TEXT,status TEXT,is_deleted INTEGER,installed INTEGER,installed_by TEXT,matches_json TEXT)")
  merged.prepare("INSERT INTO sources VALUES ('C:\\fonts','offline-index',?,'index-kept','old-install','metadata-kept','unchanged')").run(source)
  merged.prepare("INSERT INTO entries VALUES ('C:\\fonts','a.ttf',1,100,?,'ok',0,1,'system','[]')").run(JSON.stringify(item))
  const getMeta=(_db,key)=>merged.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value||'',setMeta=(_db,key,value)=>merged.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key,value)
  const shape=row=>({root:row.root_path,indexDbPath:row.index_db_path,installDbPath:row.install_db_path,indexSignature:row.index_signature,installSignature:row.install_signature,sharedMetadataSignature:row.shared_metadata_signature}), key=rows=>JSON.stringify(rows)
  setMeta(null,'sourcesKey',key(merged.prepare('SELECT * FROM sources').all().map(shape)))
  let changedDuringRead=false, unavailable=false, opens=0, updateCalls=0
  const prepareMerged=merged.prepare.bind(merged)
  merged.prepare=sql=>{const statement=prepareMerged(sql);if(/^UPDATE entries SET installed=/i.test(sql)){const run=statement.run.bind(statement);statement.run=(...args)=>{updateCalls++;return run(...args)}}return statement}
  const expectWrites=async(expectedWrites,label)=>{const before=updateCalls;const result=await migrate(merged,options);assert.equal(updateCalls-before,expectedWrites,label);return result}
  const options={machineDirectory:machines,exists:async file=>{assert.equal(file,source);return true},open:file=>{
    opens++;if(unavailable)throw Error('controlled unreadable local authority')
    const db=new DatabaseSync(file),prepare=db.prepare.bind(db)
    db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('MAX(checked_at)')){const get=statement.get.bind(statement);statement.get=(...args)=>{const receipt=get(...args);if(!changedDuringRead){changedDuringRead=true;writer.exec("UPDATE install_status SET installed=1,by_type='system',checked_at='b'")};return receipt}}return statement};return db
  },close:db=>db.close(),getMeta,setMeta,sourcesKey:key,appendLog(){},force:true,acknowledgeSources:true}
  const migrate=load('src/main/indexing/merged-page/mergedIndexInstallAuthorityRuntime.ts').migrateMergedInstallAuthority
  try {
    await expectWrites(1,'first authority correction must change its row')
    assert.equal(merged.prepare('SELECT installed FROM entries').get().installed,0,'PINNED_INSTALL_SNAPSHOT: rows drifted past receipt snapshot')
    assert.equal(merged.prepare('SELECT install_signature FROM sources').get().install_signature,'install-content-v1|1|0|0|a')
    await expectWrites(1,'new pinned authority must change its row');assert.equal(merged.prepare('SELECT installed FROM entries').get().installed,1)
    await expectWrites(0,'UNCHANGED_AUTHORITY_NO_UPDATE: stable exact status performed a redundant SQLite update')
    writer.exec("UPDATE install_status SET by_type='managed',matches_json='[\"managed-copy\"]',checked_at='c'")
    await expectWrites(1,'SAME_BOOLEAN_METADATA_REPAIR: same installed flag hid changed authority fields')
    assert.deepEqual(plain(merged.prepare('SELECT installed,installed_by,matches_json FROM entries').get()),{installed:1,installed_by:'managed',matches_json:'["managed-copy"]'})
    await expectWrites(0,'UNCHANGED_AUTHORITY_NO_UPDATE: stable managed status performed a redundant SQLite update')
    unavailable=true
    const first=await expectWrites(1,'unavailable authority must withdraw known state')
    assert.equal(first.unavailable,1);assert.equal(first.changed,1)
    assert.equal(merged.prepare('SELECT installed FROM entries').get().installed,null)
    const retained=plain(merged.prepare('SELECT * FROM sources').get())
    assert.equal(retained.install_signature,'pending:install-signature-authority');assert.equal(retained.index_signature,'index-kept');assert.equal(retained.shared_metadata_signature,'metadata-kept');assert.equal(retained.synced_at,'unchanged')
    const second=await expectWrites(0,'UNCHANGED_AUTHORITY_NO_UPDATE: retained NULL state performed a redundant SQLite update');assert.equal(second.unavailable,1);assert.equal(second.changed,0);assert.deepEqual(plain(merged.prepare('SELECT * FROM sources').get()),retained)
    assert.equal(opens,7)
    unavailable=false;writer.exec('DELETE FROM install_status')
    await expectWrites(0,'UNCHANGED_AUTHORITY_NO_UPDATE: missing evidence rewrote already unknown state')
    writer.prepare("INSERT INTO install_status VALUES (?,?,0,'none','[]','d')").run(item.id,'unknown:'+expected)
    await expectWrites(0,'UNCHANGED_AUTHORITY_NO_UPDATE: explicit unknown rewrote already unknown state')
    writer.prepare('UPDATE install_status SET signature=?').run(expected)
    // Keep the auxiliary fields equal so this control isolates NULL versus 0,
    // rather than succeeding only because by/matches also need repair.
    merged.exec("UPDATE entries SET installed_by='none',matches_json='[]'")
    await expectWrites(1,'NULL_AUTHORITY_REPAIR: exact known false must replace NULL')
    assert.deepEqual(plain(merged.prepare('SELECT installed,installed_by,matches_json FROM entries').get()),{installed:0,installed_by:'none',matches_json:'[]'})
    writer.exec("UPDATE install_status SET checked_at='e'")
    await expectWrites(0,'UNCHANGED_AUTHORITY_NO_UPDATE: receipt-only change rewrote unchanged flags')
    assert.equal(merged.prepare('SELECT install_signature FROM sources').get().install_signature,'install-content-v1|1|0|0|e')
  } finally {merged.close();writer.close();fs.rmSync(directory,{recursive:true,force:true})}
}
async function committedRetryCase(transforms={}) {
  const timers=new Map();let next=0, calls=0, durable=false, fail=true
  const load=loader({}, { setTimeout(fn,delay){if(delay<1000){queueMicrotask(fn);return{unref(){}}}const id={n:++next,unref(){}};timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)} },transforms)
  const item={id:'private',path:'C:\\private.ttf'}, result=status(true)
  const queue=load('src/main/activation/activationInstallStatusSaveQueue.ts').createActivationInstallStatusSaveQueue({ installStatusProjectionOwnedByWriter:true,
    readInstallStatusIndex:async()=>({results:durable?{private:result}:{},misses:durable?[]:[item]}),
    saveInstallStatusIndex:async()=>{calls++;durable=true;if(fail)throw Error('projection failed after save')},
    appWatchedFolders:async()=>[],rootForFontPath:async()=>null,syncMergedIndexAfterInstallStatusRefresh:async()=>{throw Error('duplicate projection')},
    clearFontQueryCaches(){},appendStartupLog(){},batchDelayMs:2000 })
  queue.schedule({private:result},new Map([['private',item]]),'test')
  await assert.rejects(()=>bounded(queue.flush('first'),'failed queue'),/projection failed after save/)
  assert.equal(calls,4);assert.equal(queue.hasPending(),true)
  fail=false;await bounded(queue.flush('retry'),'retry queue')
  assert.equal(calls,5,'COMMITTED_RETRY_PROJECTION: exact source comparison discarded unprojected durable retry')
  assert.equal(queue.hasPending(),false);assert.equal(queue.hasInFlight(),false);timers.clear()
}
async function main(){
  assert.equal(process.platform,'win32','HFM project verification is Windows-only')
  await productionRecoveryCases();await pinnedAuthorityCases();await committedRetryCase()
  const authorityFile=path.join(root,'src/main/indexing/merged-page/mergedIndexInstallAuthorityRuntime.ts')
  const unchangedGuard='if (row.installed === values[0] && row.installed_by === values[1] && row.matches_json === values[2]) continue'
  assert.equal(fs.readFileSync(authorityFile,'utf8').split(unchangedGuard).length-1,1)
  await assert.rejects(()=>pinnedAuthorityCases({[authorityFile]:text=>text.replace(unchangedGuard,'')}),/UNCHANGED_AUTHORITY_NO_UPDATE/)
  await assert.rejects(()=>pinnedAuthorityCases({[authorityFile]:text=>text.replace(unchangedGuard,'if (row.installed === values[0]) continue')}),/SAME_BOOLEAN_METADATA_REPAIR/)
  await assert.rejects(()=>pinnedAuthorityCases({[authorityFile]:text=>text.replace(unchangedGuard,'if ((row.installed ?? 0) === (values[0] ?? 0) && row.installed_by === values[1] && row.matches_json === values[2]) continue')}),/NULL_AUTHORITY_REPAIR/)
  const file=path.join(root,'src/main/activation/activationInstallStatusSaveQueue.ts')
  const anchor='for (const item of affectedItems) projectionPending.add(item.id)\n        mergeFailedBatch(results, itemsById)'
  assert.equal(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n').split(anchor).length-1,1)
  await assert.rejects(()=>committedRetryCase({[file]:text=>text.replaceAll('\r\n','\n').replace(anchor,'mergeFailedBatch(results, itemsById)')}),/COMMITTED_RETRY_PROJECTION/)
  console.log('[diagnostics:install-projection-recovery] durable A/failed projection -> B complete repair with both debt writes counted; SQLite rollback; restart/current-version false ACK; offline roots retained; actual native pages/metrics; same-snapshot changed-row-only calls, NULL/known and metadata-only controls; four causal mutants; failed-write retry debt; source unchanged and zero owners')
}
if(require.main===module){const watchdog=setTimeout(()=>{console.error('install projection diagnostic did not settle within 120s');process.exit(1)},120000);main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>clearTimeout(watchdog))}
