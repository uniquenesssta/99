#!/usr/bin/env node
const assert=require('node:assert/strict'), crypto=require('node:crypto'), vm=require('node:vm'), path=require('node:path')
const {DatabaseSync}=require('node:sqlite'), {loader}=require('./check-operation-chain.cjs')
assert.equal(process.platform,'win32','F02 compatibility requires Windows')
const load=loader({fontkit:{},[path.resolve(__dirname,'../../src/main/path/sharedFileSystemRuntime.ts')]:{sharedFileSystem:require('node:fs').promises},[path.resolve(__dirname,'../../src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{sharedIoResourceKeys:async()=>[]},[path.resolve(__dirname,'../../src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts')]:{hasDirectWritePreviewHelper:()=>false}}), plain=x=>JSON.parse(JSON.stringify(x)), hash=x=>crypto.createHash('sha1').update(x).digest('hex')
const identity=load('src/main/fonts/fontFileIdentity.ts')
const cached=load('src/main/fonts/fontRuntime.ts').createCachedFontRuntime({sharedFontId:(key,size,mtime)=>hash(`${key.toLowerCase()}|${size}|${Math.round(mtime)}`)})
const roots=['C:\\root-a','C:\\root-b'],stat={size:42,mtimeMs:100}
const legacy=cached.sanitizeCachedFont({id:'old',path:'',favorite:false,deleteProtected:true,tagNames:['shared']},'same.ttf',roots[0]+'\\same.ttf',stat)
const fonts=roots.map(root=>cached.cachedFontForRuntime(legacy,root+'\\same.ttf',stat,'same.ttf'))
assert.notEqual(fonts[0].id,fonts[1].id)
assert.equal(fonts[0].sourceId,legacy.id)
assert.equal(cached.sanitizeCachedFont(fonts[0],'same.ttf',fonts[0].path,stat).id,legacy.id,'runtime ID leaked into shared cache')
const context={module:{exports:{}},process,require:id=>id==='better-sqlite3'?DatabaseSync:require(id)}
vm.runInNewContext(load('src/main/db/query-worker/dbQueryWorkerSharedSource.ts').buildDbQueryWorkerSharedSource()+'\nmodule.exports={fontFromMergedRow,fileRuntimeFontId,hydrateLocalTags}',context)
const nodeWorker=context.module.exports
const rows=roots.map(root=>({root_path:root,relative_path:'same.ttf',file_size:42,modified_at:100,status:'ok',font_json:JSON.stringify(legacy),installed:0,installed_by:'none'}))
for(let i=0;i<2;i++)assert.equal(nodeWorker.fontFromMergedRow(rows[i]).id,fonts[i].id)
for(const vector of require('./fixtures/font-file-identity.json'))assert.equal(nodeWorker.fileRuntimeFontId(vector.path,vector.size,vector.mtimeMs),vector.expected)
function database(){const db=new DatabaseSync(':memory:');db.transaction=fn=>()=>{db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}};return db}
const db=database()
db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT,checked_at TEXT,system_default INTEGER)')
const confirmedSig=load('src/main/install/status/installStatusSignatureRuntime.ts').createInstallStatusSignatureRuntime({sha1:hash,normalizePathForCacheCompare:p=>p.toLowerCase()}).installStatusSignature
const sig=font=>confirmedSig(font).slice('content-v1:'.length) // Legacy identity migration preserves unconfirmed status.
const oldFont={...fonts[0],id:legacy.id}
const names=load('src/main/install/fontInstallCompare.ts').createInstallCompareRuntime({appName:'HFM'})
for(const font of fonts) {
 assert(!/[<>:"/\\|?*]/.test(names.safeManagedFontName(font)))
 assert(!/[<>:"/\\|?*]/.test(names.safeTemporaryActiveFontName(font)))
}
assert.notEqual(names.safeManagedFontName(fonts[0]),names.safeManagedFontName(fonts[1]))
db.prepare('INSERT INTO install_status VALUES (?,?,1,?, ?,?,0)').run(legacy.id,sig(oldFont),'system','[]','original')
const original=plain(db.prepare('SELECT * FROM install_status').get())
const migration=load('src/main/install/status/installStatusIdentityMigration.ts'),migrate=migration.migrateInstallStatusIdentity
assert.equal(migrate(db,rows),1)
assert.notEqual(sig(fonts[0]),confirmedSig(fonts[0]),'legacy name-only row gained content confirmation')
assert.equal(db.prepare('SELECT signature FROM install_status WHERE font_id=?').get(fonts[0].id).signature,sig(fonts[0]))
assert.equal(db.prepare('SELECT 1 FROM install_status WHERE font_id=?').get(fonts[1].id),undefined,'legacy install signature leaked across roots')
assert.deepEqual(JSON.parse(db.prepare('SELECT payload_json FROM install_identity_migrations').get().payload_json),original)
assert.equal(migrate(db,rows),0)
db.prepare('DELETE FROM install_status WHERE font_id=?').run(fonts[0].id)
assert.equal(migrate(db,rows),0,'deleted new install status was resurrected')
const failed=database();failed.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT,checked_at TEXT,system_default INTEGER)')
failed.prepare('INSERT INTO install_status VALUES (?,?,1,?, ?,?,0)').run(legacy.id,sig(oldFont),'system','[]','original')
failed.exec("CREATE TRIGGER deny_identity BEFORE INSERT ON install_status WHEN NEW.font_id LIKE 'file-v2:%' BEGIN SELECT RAISE(ABORT,'denied'); END")
assert.throws(()=>migrate(failed,rows),/denied/)
assert.equal(failed.prepare('SELECT COUNT(*) n FROM install_identity_migrations').get().n,0)
assert.deepEqual(plain(failed.prepare('SELECT * FROM install_status').get()),original)
failed.close()
// Historical display names are accepted only for the same proven physical
// identity. Unresolved rows retain their original payload and an honest reason.
const diagnostic=database();diagnostic.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT,checked_at TEXT,system_default INTEGER)')
const namedSource={...oldFont,fileName:'Original Display Name.ttf'}
const namedRows=[{...rows[0],font_json:JSON.stringify(namedSource)}]
diagnostic.prepare('INSERT INTO install_status VALUES (?,?,1,?,?,?,0)').run(legacy.id,sig(namedSource),'system','[]','original-name')
let report
assert.equal(migrate(diagnostic,namedRows,value=>{report=plain(value)}),1)
assert.equal(report.unresolved,0)
assert.equal(diagnostic.prepare('SELECT signature FROM install_status WHERE font_id=?').get(fonts[0].id).signature,sig(fonts[0]))
diagnostic.prepare('INSERT INTO install_status VALUES (?,?,1,?,?,?,0)').run('missing-old-id','opaque-signature','system','[]','retained')
diagnostic.prepare('UPDATE install_status SET signature=? WHERE font_id=?').run('changed-signature',legacy.id)
assert.equal(migrate(diagnostic,namedRows,value=>{report=plain(value)}),0)
assert.deepEqual(report,{migrated:0,unresolved:2,noIdentityCandidate:1,signatureMismatch:1,ambiguous:0,invalidCandidates:0,invalidSamples:[]})
assert.equal(diagnostic.prepare('SELECT checked_at FROM install_status WHERE font_id=?').get('missing-old-id').checked_at,'retained')
assert.doesNotThrow(()=>migration.installIdentitySnapshotKey([...namedRows,{root_path:'',relative_path:'relative.ttf',file_size:1,modified_at:1,font_json:'{}'},{...namedRows[0],font_json:'invalid-json'}]),'one invalid migration candidate must not poison valid rows')
assert.equal(migration.installIdentitySnapshotKey(namedRows),migration.installIdentitySnapshotKey([{...namedRows[0],font_json:JSON.stringify({...namedSource,tagNames:['changed'],favorite:true,active:true})}]),'labels/state forced identity migration retry')
assert.notEqual(migration.installIdentitySnapshotKey(namedRows),migration.installIdentitySnapshotKey([{...namedRows[0],modified_at:101}]),'changed file identity did not permit migration retry')
diagnostic.close()
// Real root join and generated ID expression agree with runtime identity.
db.exec("ATTACH DATABASE ':memory:' AS install_db; CREATE TABLE install_db.install_status AS SELECT * FROM install_status; CREATE TABLE entries(root_path TEXT,relative_path TEXT,file_size INTEGER,modified_at INTEGER,font_json TEXT)")
identity.registerFileIdentitySql(db)
for(const row of rows)db.prepare('INSERT INTO entries VALUES (?,?,?,?,?)').run(row.root_path,row.relative_path,row.file_size,row.modified_at,row.font_json)
const sql=load('src/main/indexing/root-query/rootIndexQuerySharedSql.ts')
assert.deepEqual(db.prepare('SELECT '+sql.rootIndexRuntimeFontIdExpr()+' AS id FROM entries ORDER BY root_path').all().map(r=>r.id),fonts.map(f=>f.id))
// Persisted shared metadata remains addressable by the root-relative key.
const match=load('src/main/indexing/shared-metadata/sharedMetadataEntryMatchRuntime.ts').findSharedMetadataMatchedEntry
const matchDeps={cacheKeyForRootFile:(r,p)=>path.relative(r,p).replaceAll('\\','/'),cacheEntryRuntimePath:(r,p)=>path.join(r,p),normalizePathForCacheCompare:p=>p.toLowerCase()}
const synthetic=match(matchDeps,roots[0],{cache:{entries:{}}},fonts[0])
assert.equal(synthetic.font.id,legacy.id)
const protectedEntry={...legacy,deleteProtected:true,tagNames:['kept']}
const restored=match(matchDeps,roots[0],{cache:{entries:{'same.ttf':{status:'ok',path:'same.ttf',font:protectedEntry}}}},fonts[0])
const protectedRuntime=cached.cachedFontForRuntime(restored.font,fonts[0].path,stat,'same.ttf')
assert.equal(protectedRuntime.id,fonts[0].id);assert.equal(protectedRuntime.deleteProtected,true);assert.deepEqual(plain(protectedRuntime.tagNames),['kept'])
const other={...legacy,id:fonts[0].id,path:'other.ttf'}
const selected=match(matchDeps,roots[0],{cache:{entries:{'other.ttf':{status:'ok',path:'other.ttf',font:other}}}},fonts[0])
assert.equal(selected.relativePath,'same.ttf','shared write followed a colliding ID to a different file')
// UNC tags retain compatibility with the existing local tag path storage format.
db.exec("ATTACH DATABASE ':memory:' AS local_db; CREATE TABLE local_db.local_font_tags(font_id TEXT,font_path TEXT,tag_name TEXT)")
const unc={...fonts[0],path:'\\\\server\\share\\same.ttf'}
const tagPath=load('src/main/library/runtime/localFontTagIdentityRuntime.ts').localTagFontPath(unc)
db.prepare('INSERT INTO local_db.local_font_tags VALUES (?,?,?)').run('historical',tagPath,'private')
assert.deepEqual(plain(nodeWorker.hydrateLocalTags(db,[unc])[0].localTagNames),['private'])
// Actual production storage keys must hydrate through generated worker and SQL.
const localIdentity=load('src/main/library/runtime/localFontTagIdentityRuntime.ts')
for (const vector of require('./fixtures/tag-font-path-identity.json')) {
  assert.equal(localIdentity.normalizeLocalTagFontPath(vector.path),vector.stored)
  assert.equal(localIdentity.localTagFontStorageId({id:'irrelevant',path:vector.path}),'local-path:'+vector.stored)
  db.exec('DELETE FROM local_db.local_font_tags; DELETE FROM entries')
  db.prepare('INSERT INTO local_db.local_font_tags VALUES (?,?,?)').run('historical',vector.stored,'private')
  for (const candidate of [vector.path,vector.canonical]) {
    assert.deepEqual(plain(nodeWorker.hydrateLocalTags(db,[{...unc,path:candidate}])[0].localTagNames),['private'])
  }
  db.prepare('INSERT INTO entries VALUES (?,?,?,?,?)').run(path.win32.dirname(vector.canonical),path.win32.basename(vector.canonical),42,100,JSON.stringify(legacy))
  const predicate=sql.rootIndexLocalTagMatchExpr('lft')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries WHERE EXISTS (SELECT 1 FROM local_db.local_font_tags lft WHERE '+predicate+')').get().n,1)
  db.prepare('UPDATE local_db.local_font_tags SET font_path=?').run(vector.stored+'.other')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries WHERE EXISTS (SELECT 1 FROM local_db.local_font_tags lft WHERE '+predicate+')').get().n,0,'path-bearing metadata ID borrowed another file')
}
// Preview cache keys and storage routing do not use the runtime ID.
const preview=load('src/main/preview/runtime/previewBatchRowsRuntime.ts').createPreviewBatchRowsRuntime({sha1:hash,normalizePathForCacheCompare:p=>p.toLowerCase()},()=>({storage:'local',dir:'C:\\preview',identity:'same.ttf'}))
const previewRow=font=>[...preview.buildPreviewCacheGroups([font],{},'Text',36,400,80).values()][0].rows[0]
const beforePreview=previewRow(oldFont),afterPreview=previewRow(fonts[0])
assert.equal(beforePreview.previewKey,afterPreview.previewKey)
assert.equal(beforePreview.outputPath,afterPreview.outputPath)
assert.notEqual(beforePreview.id,afterPreview.id)
assert.equal(afterPreview.sourcePath,fonts[0].path)
db.close()
async function operations(){
 // Exercise the existing mapping authority; no live network share is required.
 const mappingMocks={
  'node:child_process':{execFile:(_exe,_args,_opts,done)=>done(null,JSON.stringify([{drive:'Z:',remote:'\\\\server\\share'}]))},
  [path.resolve(__dirname,'../../src/main/rust-core/rustCoreWorkerPathRuntime.ts')]:{resolveRustCoreWorkerPath:()=> 'fixture-worker'}
 }
 const canonical=loader(mappingMocks)('src/main/path/pathCanonicalizer.ts')
 await canonical.mappedDriveTableAsync()
 assert.equal(identity.fileRuntimeFontId(canonical.canonicalizeWatchedFolderPathText('Z:\\same.ttf'),42,100),identity.fileRuntimeFontId('\\\\server\\share\\same.ttf',42,100))
 const offline=loader({...mappingMocks,'node:child_process':{execFile:(_exe,_args,_opts,done)=>done(Error('offline'))}})('src/main/path/pathCanonicalizer.ts')
 await offline.mappedDriveTableAsync()
 assert.notEqual(identity.fileRuntimeFontId(offline.canonicalizeWatchedFolderPathText('Z:\\same.ttf'),42,100),identity.fileRuntimeFontId('\\\\server\\share\\same.ttf',42,100))

 const calls=[],saved=[]
 // Historical IDs collide deliberately; only the selected path may be settled.
 const records=fonts.map((f,i)=>({fontId:legacy.id,sourcePath:f.path,installPath:`C:\\managed\\${i}.ttf`,registryName:`HFM_${i}`,fileName:f.fileName,activatedAt:'before'}))
 const deps={normalizePathForCacheCompare:p=>p.toLowerCase(),ensureWindows(){},appendStartupLog(){},loadTemporaryActiveFonts:async()=>({version:1,records}),saveTemporaryActiveFonts:async s=>saved.push(plain(s)),removeFontResourceSessionBatch:async paths=>{calls.push(...paths);return Object.fromEntries(paths.map(p=>[p,{ok:true,count:1}]))},scheduleBackgroundFontRefreshTail(){},clearInstalledFontsMemoryCache(){},getSystemInstalledFontsCached:async()=>[],compareFontInstalledWithList:()=>({installed:false,by:'none',matches:[]}),isTemporaryActiveInstalledRecord:()=>false,scheduleActivationInstallStatusSave(){}}
 const cleanup={verifyManagedRecord:async()=>true,persistRecordStage:async()=>{},deleteManagedRegistryRecords:async()=>{},queueTemporaryFontFileDeletes:async values=>Object.fromEntries(values.map(r=>[r.installPath,{ok:true}]))}
 const batch=load('src/main/activation/runtime/fontDeactivationBatchRuntime.ts').createFontDeactivationBatchRuntime(deps,cleanup)
 const deactivated=await batch.deactivateFontSessionsBatch([fonts[1]])
 assert.equal(deactivated.ok,true)
 assert.deepEqual(calls,[records[1].installPath])
 assert.deepEqual(saved.at(-1).records.map(r=>r.sourcePath),[fonts[0].path])
 // Execute production trash target selection with controlled filesystem/shell I/O.
 const trashed=[]
 const trashLoad=loader({electron:{shell:{trashItem:async p=>trashed.push(p)}},[path.resolve(__dirname,'../../src/main/path/sharedFileSystemRuntime.ts')]:{sharedFileSystem:{access:async p=>{if(trashed.includes(p))throw Object.assign(Error('missing'),{code:'ENOENT'})},realpath:async p=>p,stat:async()=>({isFile:()=>true,size:8,mtimeMs:1,ino:1}),readFile:async()=>Buffer.from("0001000000000000","hex")},executeSharedFile:async request=>{assert.equal(request.operation,'trash');trashed.push(request.path)}},[path.resolve(__dirname,'../../src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{sharedIoResourceKeys:async()=>[]},[path.resolve(__dirname,'../../src/main/storage/runtime/sharedLeaseLockRuntime.ts')]:{withSharedLeaseLock:async(_opts,fn)=>fn()}})
 const trash=trashLoad('src/main/install/fontTrashDeleteRuntime.ts').deleteFontFilesToTrashRuntime
 const ProtectionError=trashLoad('src/main/install/fontProtectionAuthorityRuntime.ts').FontProtectionError
 let authorityProtected=true
 const trashDeps={prepareSourceDelete:async item=>{if(authorityProtected)throw new ProtectionError("protected")},withFontProtection:async(_items,action)=>{const check=async()=>{if(authorityProtected)throw new ProtectionError('protected')};await check();return action(check)},fontExtensions:new Set(['.ttf']),isCleanWindowsDefaultItem:()=>false,isPathInsideAnyRoot:()=>true,appendStartupLog(){}}
 // Cache sanitization clears protection; operation fixtures must set it explicitly.
 const unprotectedFont={...fonts[1],deleteProtected:false,systemInstalled:false,systemImported:false,active:false}
 const protectedFont={...unprotectedFont,deleteProtected:true}
 const protectedResult=await trash([protectedFont],roots,trashDeps)
 assert.equal(protectedResult.skippedProtected,1,JSON.stringify(protectedResult))
 assert.equal(protectedResult.deleted,0);assert.deepEqual(plain(protectedResult.deletedIds),[])
 assert.deepEqual(trashed,[],'protected font reached the filesystem port')
 authorityProtected=false
 const deleted=await trash([unprotectedFont],roots,trashDeps)
 assert.equal(deleted.ok,true,JSON.stringify(deleted));assert.equal(deleted.deleted,1,JSON.stringify(deleted))
 assert.deepEqual(trashed,[fonts[1].path]);assert.deepEqual(plain(deleted.deletedIds),[fonts[1].id])
 console.log('[F02] Node/SQL identity, install migration/rollback, shared metadata and precise operation targets passed')
}
operations().catch(e=>{console.error(e);process.exitCode=1})
