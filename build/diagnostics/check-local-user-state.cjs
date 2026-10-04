'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { loader: baseLoader } = require('./check-operation-chain.cjs')
const { execFileSync, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const selected = process.argv.find(arg=>arg.startsWith('--case='))?.slice(7)
const baseline = process.argv.includes('--baseline')
const mutant = process.argv.includes('--mutant')
const crlf = process.argv.includes('--crlf')
function loader(mocks={},globals={}) {
  const transforms={}
  const targets={
    tags: ['src/main/library/tagMutationWriteProtocolRuntime.ts','src/main/library/sharedFontMetadataMutations.ts','src/main/bootstrap/mainTagCompositionRuntime.ts'],
    activation: ['src/main/activation/runtime/fontDeactivationBatchRuntime.ts'],
    favorites: ['src/main/indexing/root-query/mergedIndexPageQuerySql.ts','src/main/indexing/root-query/rootIndexQuerySharedSql.ts'],
    metrics: ['src/main/library/fontMetricsRequestCoalescerRuntime.ts'],
  }
  for(const [kind,files] of Object.entries(targets))for(const file of files)transforms[path.join(root,file)]=source=>{
    if(baseline && kind===selected)source=execFileSync('git',['show','398eabb:'+file],{cwd:root,encoding:'utf8'})
    if(mutant && kind===selected){
      const replacements={
        'src/main/bootstrap/mainTagCompositionRuntime.ts':['knownTags: result.mutationProtocol!.knownTags','knownTags: undefined'],
        'src/main/activation/runtime/fontDeactivationBatchRuntime.ts':['unique.filter(item => results[item.id]?.ok','unique.filter(item => recordsByItemId.has(item.id) && results[item.id]?.ok'],
        'src/main/indexing/root-query/mergedIndexPageQuerySql.ts':['${mergedIndexLocalFavoriteExpr()} = 1',"COALESCE(json_extract(entries.font_json, '$.favorite'), 0) = 1"],
        'src/main/library/fontMetricsRequestCoalescerRuntime.ts':['return requestGeneration === cacheGeneration ? result : run(args)','return result'],
      }
      if(replacements[file]){const [from,to]=replacements[file];assert(source.includes(from),'mutation anchor missing');source=source.replace(from,to)}
    }
    return crlf?source.replace(/\r?\n/g,'\r\n'):source
  }
  return baseLoader(mocks,globals,transforms)
}
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const font = (id, extra = {}) => ({ id, path:`C:\\fonts\\${id}.ttf`, fileName:`${id}.ttf`, favorite:false, active:false, tagNames:[], localTagNames:['private'], deleteProtected:true, ...extra })
function database() {
  const db = new DatabaseSync(':memory:')
  db.transaction = fn => () => { db.exec('BEGIN'); try { const result=fn(); db.exec('COMMIT'); return result } catch(e) { db.exec('ROLLBACK'); throw e } }
  return db
}
async function protection() {
  const create=loader()('src/main/library/runtime/localFontProtectionRuntime.ts').createLocalFontProtectionRuntime
  const db=database();let roots=[],invalidated=0
  const make=()=>create({openLibraryDb:async()=>db,watchedFolders:async()=>roots,invalidate:()=>invalidated++})
  let runtime=make()
  const a=font('a',{path:'C:\\outside\\a.ttf',deleteProtected:false,systemImported:true,systemInstalled:true})
  const copy={...a,path:'D:\\copy\\a.ttf'}
  assert.equal((await runtime.hydrate([a]))[0].deleteProtected,false,'installed flag created protection')
  await runtime.set([a],true);runtime=make()
  const changed={...a,id:'changed',systemInstalled:false}
  assert.deepEqual((await runtime.hydrate([changed,copy])).map(f=>f.deleteProtected),[true,false],'restart/identity/copy protection mismatch')
  await runtime.set([changed],false)
  assert.equal((await runtime.hydrate([{...a,deleteProtected:true}]))[0].deleteProtected,false,'stale scan resurrected local protection')
  roots=['C:\\outside']
  assert.equal((await runtime.hydrate([{...a,deleteProtected:true}]))[0].deleteProtected,true,'local false cleared shared protection')
  await runtime.set([a],true)
  await runtime.clear([a])
  assert.equal((await runtime.hydrate([a]))[0].deleteProtected,false,'shared ownership handoff retained local flag')
  roots=[];await runtime.set([a],true)
  db.exec("CREATE TRIGGER deny_protection BEFORE INSERT ON local_font_protection WHEN NEW.font_path LIKE '%bad.ttf' BEGIN SELECT RAISE(ABORT, 'disk'); END")
  await assert.rejects(runtime.set([a,{...a,id:'bad',path:'C:\\outside\\bad.ttf'}],false),/disk/)
  assert.equal((await runtime.hydrate([a]))[0].deleteProtected,true,'partial protection write escaped transaction')
  await assert.rejects(runtime.set([{...a,path:''}],false),/路径为空/)
  assert(invalidated>0)
  db.close()
  await assert.rejects(runtime.hydrate([a]),'unreadable authority silently became unprotected')
  const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'hfm-protection-'))
  const diskPath=path.join(directory,'library.sqlite')
  const open=()=>{const handle=new DatabaseSync(diskPath);handle.transaction=fn=>()=>{handle.exec('BEGIN');try{const value=fn();handle.exec('COMMIT');return value}catch(error){handle.exec('ROLLBACK');throw error}};return handle}
  let disk=open()
  const persisted=()=>create({openLibraryDb:async()=>disk,watchedFolders:async()=>[],invalidate(){}})
  try {
    await persisted().set([a],true);disk.close();disk=open()
    assert.equal((await persisted().hydrate([{...a,id:'restart-id'}]))[0].deleteProtected,true,'disk reopen lost protection')
    await persisted().set([a],false);disk.close();disk=open()
    assert.equal((await persisted().hydrate([{...a,deleteProtected:true}]))[0].deleteProtected,false,'disk reopen resurrected protection')
  } finally {disk.close();fs.rmSync(directory,{recursive:true,force:true})}
  await protectionAuthority()
  console.log('[local-protection] explicit decisions, restart, path identity, shared precedence, cancellation and failed-write atomicity passed')
}
async function protectionAuthority() {
  const load=loader(), authorityModule=load('src/main/install/fontProtectionAuthorityRuntime.ts')
  const {createFontProtectionAuthorityRuntime:create,readSharedFontProtection:readShared}=authorityModule
  const shared=database()
  shared.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE font_metadata(relative_path TEXT,path_key TEXT,delete_protected INTEGER,font_id TEXT)')
  const source=font('source',{path:'C:\\fonts\\sample.ttf',fileName:'sample.ttf',deleteProtected:false,systemInstalled:false})
  assert.throws(()=>readShared(shared,source,'C:\\fonts'),/迁移尚未确认/)
  shared.prepare('INSERT INTO meta VALUES (?,?)').run('legacyRootIndexMetadataImportedAt','done')
  assert.equal(readShared(shared,source,'C:\\fonts'),false)
  shared.prepare('INSERT INTO font_metadata(relative_path,path_key,delete_protected) VALUES (?,?,?)').run('sample.ttf','',0)
  shared.prepare('INSERT INTO font_metadata(relative_path,path_key,delete_protected) VALUES (?,?,?)').run('SAMPLE.TTF','',1)
  assert.equal(readShared(shared,source,'C:\\fonts'),true,'one protected collection member must protect the physical file')
  assert.equal(readShared(shared,{...source,path:'D:\\copy\\sample.ttf'},'C:\\fonts'),false,'different root inherited protection')
  shared.exec('UPDATE font_metadata SET delete_protected=7')
  assert.throws(()=>readShared(shared,source,'C:\\fonts'),/格式无效/)
  shared.close()

  let roots=[],effects=[],blocked=new Set(),offline=false
  const authority=create({roots:async()=>roots,read:async item=>{if(offline)throw Error('offline');return blocked.has(item.path)},lock:async(_items,_roots,action)=>action(),log(){}})
  blocked.add(source.path)
  await assert.rejects(authority.guard([source],async()=>effects.push('bad')),/手动保护/)
  blocked.clear();offline=true
  await assert.rejects(authority.guard([source],async()=>effects.push('bad')),/保护状态未知/)
  offline=false
  await assert.rejects(authority.guard([source],async check=>{blocked.add(source.path);await check();effects.push('bad')}),/手动保护/)
  blocked.clear()
  await assert.rejects(authority.guard([source],async check=>{roots=['C:\\new'];await check();effects.push('bad')}),/保护状态未知/)
  roots=[]
  let release;const barrier=new Promise(resolve=>release=resolve)
  const write=authority.mutate([source],async()=>{await barrier;blocked.add(source.path)})
  const remove=authority.guard([source],async()=>effects.push('bad'))
  release();await write;await assert.rejects(remove,/手动保护/)
  assert.deepEqual(effects,[],'protected or unknown target reached a side effect')
  await authority.mutate([source],async()=>blocked.clear())
  await authority.guard([source],async check=>{await check();effects.push('allowed')})
  assert.deepEqual(effects,['allowed'],'failed guard poisoned the operation queue')
  effects=[]
  let begin,continueWaiting
  const entered=new Promise(resolve=>begin=resolve),waiting=new Promise(resolve=>continueWaiting=resolve)
  const pendingOperation=authority.guard([source],async check=>{begin();await waiting;await check();effects.push('bad')})
  await entered
  const pendingProtection=authority.mutate([source],async()=>blocked.add(source.path))
  continueWaiting()
  await assert.rejects(pendingOperation,/保护修改正在等待提交/);await pendingProtection
  assert.deepEqual(effects,[],'pending protection intent was ignored during a wait')
  blocked.clear()


  // Exercise real install/uninstall/trash code. Only OS mutation ports are
  // replaced; authority, candidate planning and per-effect rechecks are real.
  effects=[]
  const portFile=path.join(root,'src/main/path/sharedFileSystemRuntime.ts')
  const trashedPaths=new Set()
  const io={access:async p=>{if(trashedPaths.has(p))throw Object.assign(Error('missing'),{code:'ENOENT'})},realpath:async p=>p,stat:async()=>({isFile:()=>true,size:8,mtimeMs:1,ino:1}),readFile:async()=>Buffer.from('0001000000000000','hex'),mkdir:async()=>{},copyFile:async()=>effects.push('copy'),unlink:async()=>effects.push('unlink')}
  let protectAfterPermission=''
  const runtimeLoad=loader({electron:{shell:{trashItem:async()=>effects.push('trash')}},
    'node:fs':{existsSync:()=>true},
    'node:child_process':{execFile:(exe,_args,_options,done)=>{effects.push(exe==='net'?'permission-check':'registry-native');if(exe==='net'&&protectAfterPermission)blocked.add(protectAfterPermission);done(null,'')}},
    [portFile]:{sharedFileSystem:io,executeSharedFile:async request=>{assert.equal(request.operation,'trash');effects.push('trash');trashedPaths.add(request.path)}},
    [path.join(root,'src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{sharedIoResourceKeys:async()=>[]},
    [path.join(root,'src/main/storage/runtime/sharedLeaseLockRuntime.ts')]:{withSharedLeaseLock:async(_opts,action)=>action()}})
  const authority2=runtimeLoad('src/main/install/fontProtectionAuthorityRuntime.ts').createFontProtectionAuthorityRuntime({roots:async()=>[],read:async item=>{if(offline)throw Error('offline');return blocked.has(item.path)},lock:async(_items,_roots,action)=>action(),log(){}})
  const installedPath='C:\\user-fonts\\sample.ttf'
  const records=[{path:installedPath,fileName:'sample.ttf',registryName:'Sample',value:installedPath,source:'HKCU'}]
  const deps={persistUninstallResult:async()=>{},deactivateForFileDelete:async()=>({ok:true,message:'settled'}),readUninstallRegistry:async()=>records.filter(record=>!record.__removed),
    createMutationSession:async()=>({close(){},execute:async(plan,check)=>{
      let count=0;
      if(plan.records.some(r=>r.scope==='HKLM')){effects.push('permission-check');if(protectAfterPermission)blocked.add(protectAfterPermission)}
      try {
        await check();
        for(const record of plan.records){await check();effects.push(record.scope==='HKLM'?'registry-native':'registry-delete');count++}
        if(plan.delete_file){await check();effects.push('unlink');count++}
        // The controlled native port reflects committed registry removals.
        for(const record of plan.records){const found=records.find(r=>r.registryName===record.name&&r.source===record.scope);if(found)found.__removed=true}
        return {ok:true,message:'native',completedSteps:count,fileRemoved:plan.delete_file}
      }catch(error){return {ok:false,message:String(error),completedSteps:count,fileRemoved:false}}
    }}),withFontProtection:authority2.guard,fontExtensions:new Set(['.ttf']),ensureWindows(){},currentUserFontsDir:()=> 'C:\\user-fonts',windowsFontsDir:()=> 'C:\\Windows\\Fonts',registryNameFor:()=> 'Sample',normalizePathForCacheCompare:p=>p.toLowerCase(),normalizeCompareText:s=>s.toLowerCase(),isCleanWindowsDefaultFontName:()=>true,isCleanWindowsDefaultCandidate:()=>true,isCleanWindowsDefaultItem:()=>true,isTemporaryActiveInstalledRecord:()=>false,isPathInsideAnyRoot:()=>true,getSystemInstalledFonts:async()=>records,getSystemInstalledFontsCached:async()=>records,clearInstalledFontsMemoryCache(){},writeFontRegistryValuesHKCUBatch:async()=>effects.push('registry-write'),deleteFontRegistryValuesHKCUBatch:async()=>effects.push('registry-delete'),advancedFontRefresh:async()=>{},activationTraceStep:async(_label,_id,fn)=>fn(),appendStartupLog(){}}
  const system=runtimeLoad('src/main/install/systemFontInstallRuntime.ts').createSystemFontInstallRuntime(deps)
  blocked.add(installedPath)
  assert.equal((await system.uninstallFontSystemWide(source)).ok,false)
  await assert.rejects(system.installFontSystemWide(source),/手动保护/)
  assert.deepEqual(effects,[],'protected installation copy was changed')
  blocked.clear();blocked.add(source.path)
  assert.equal((await system.uninstallFontSystemWide(source)).ok,false)
  assert.deepEqual(effects,[],'forged false bypassed source protection')
  blocked.clear();offline=true
  assert.equal((await system.uninstallFontSystemWide(source)).ok,false)
  assert.deepEqual(effects,[],'offline authority caused registry/file effects')
  offline=false
  assert.equal((await system.uninstallFontSystemWide({...source,deleteProtected:true})).ok,true,'default classification or stale snapshot still blocked unprotected font')
  assert.deepEqual(effects,['registry-delete','unlink'])
  delete records[0].__removed
  effects=[];await system.installFontSystemWide(source)
  assert.deepEqual(effects,['copy','registry-write']);assert.equal(blocked.size,0,'installation created implicit protection')
  effects=[];blocked.add(source.path)
  const other={...source,id:'other',path:'C:\\fonts\\other.ttf'}
  const deleted=await system.deleteFontFilesToTrash([source,other],['C:\\fonts'])
  assert.equal(deleted.skippedProtected,1);assert.equal(deleted.deleted,1)
  assert.deepEqual(effects,['trash'],'mixed batch damaged protected member')
  effects=[];blocked.clear()
  records[0]={...records[0],source:'HKLM',path:'C:\\Windows\\Fonts\\arial.ttf',value:'C:\\Windows\\Fonts\\arial.ttf'}
  source.systemInstallMatches=records
  protectAfterPermission=records[0].path
  assert.equal((await system.uninstallFontSystemWide(source)).ok,false)
  assert.deepEqual(effects,['permission-check'],'protection changed during permission wait but registry/file was modified')
  effects=[];blocked.clear();protectAfterPermission=''
  assert.equal((await system.uninstallFontSystemWide(source)).ok,true)
  assert.deepEqual(effects,['permission-check','registry-native','unlink'],'HKLM/default filename still implicitly protected')
  console.log('[protection-authority] shared SQLite, unknown/offline, queue ordering, recheck, collection paths, install copies, mixed batch and zero protected effects passed')
}
async function favorites() {
  const load = loader()
  const schema = load('src/main/library/runtime/librarySchemaRuntime.ts')
  const create = load('src/main/library/runtime/localFontFavoritesRuntime.ts').createLocalFontFavoritesRuntime
  const a=database(), b=database();schema.initializeLibraryDb(a);schema.initializeLibraryDb(b)
  let migrated=0, invalidated=0
  const make = (db, snapshot) => create({openLibraryDb:async()=>db,loadLegacyLocalSnapshot:async()=>{migrated++;return snapshot},invalidate(){invalidated++},appendLog(){}})
  let ra=make(a,[font('a',{favorite:true})]), rb=make(b,[])
  await Promise.all([ra.initialize(),ra.initialize()]);assert.equal(migrated,1,'migration must coalesce')
  const incoming=[font('a',{favorite:true}),font('b',{favorite:true})]
  assert.deepEqual((await ra.hydrate(incoming)).map(f=>f.favorite),[true,false], 'shared favorite leaked into local machine')
  assert.deepEqual((await rb.hydrate(incoming)).map(f=>f.favorite),[false,false], 'machine B inherited A/shared favorite')
  await ra.setFavorite([incoming[0]],[],false)
  ra=make(a,incoming);await ra.initialize()
  assert.deepEqual((await ra.hydrate(incoming)).map(f=>f.favorite),[false,false], 'restart re-imported shared favorites')
  await ra.setFavorite([font('b')],[],true)
  const changedId=font('new',{path:font('b').path})
  assert.equal((await ra.hydrate([changedId]))[0].favorite,true,'path alias lost local favorite')
  await ra.setFavorite([changedId],[],false)
  assert.equal((await ra.hydrate([font('b',{favorite:true})]))[0].favorite,false,'old ID resurrected canceled favorite')
  await ra.setFavorite([font('a')],[],true)
  a.exec("CREATE TRIGGER deny_bad BEFORE INSERT ON local_font_favorites WHEN NEW.font_path LIKE '%bad.ttf' BEGIN SELECT RAISE(ABORT, 'disk'); END")
  await assert.rejects(ra.setFavorite([font('a'),font('bad')],[],false),/disk/)
  assert.equal((await ra.hydrate([font('a')]))[0].favorite,true,'partial local write escaped transaction')
  const hydrated=(await ra.hydrate([font('a')]))[0]
  assert.equal(hydrated.deleteProtected,true);assert.deepEqual(plain(hydrated.localTagNames),['private'])
  // Real generated page/ID/count SQL, with a stale shared favorite and active flag.
  a.exec("ATTACH DATABASE ':memory:' AS local_db")
  a.exec('CREATE TABLE local_db.local_font_favorites AS SELECT * FROM main.local_font_favorites')
  a.exec(`CREATE TABLE entries(root_path TEXT,relative_path TEXT,cache_key TEXT,file_size INTEGER,modified_at INTEGER,created_at INTEGER,status TEXT,font_json TEXT,message TEXT,cached_at TEXT,installed INTEGER,installed_by TEXT,matches_json TEXT,is_deleted INTEGER,search_text TEXT,category_index TEXT)`)
  a.function('hfm_shared_font_id',(relative,_size,_mtime)=>String(relative).replace('.ttf',''))
  require('./check-operation-chain.cjs').loader()('src/main/fonts/fontFileIdentity.ts').registerFileIdentitySql(a)
  const insert=a.prepare("INSERT INTO entries VALUES ('C:\\fonts',?, '',1,1,1,'ok',?,'','',0,'none','[]',0,'','')")
  insert.run('a.ttf',JSON.stringify(font('a',{favorite:false,active:true})))
  insert.run('b.ttf',JSON.stringify(font('b',{favorite:true,active:true})))
  const sql=load('src/main/indexing/root-query/mergedIndexPageQuerySql.ts')
  let built=sql.buildMergedIndexQuerySql({activeFilter:{kind:'favorites'}},50,0)
  assert.equal(a.prepare(built.countSql).get(...built.countParams).count,1)
  assert.deepEqual(a.prepare(built.sql).all(...built.params).map(row=>row.relative_path),['a.ttf'])
  const ids=sql.buildMergedIndexIdsQuerySql({activeFilter:{kind:'favorites'}},50)
  assert.deepEqual(a.prepare(ids.sql).all(...ids.params).map(row=>row.id),[load('src/main/fonts/fontFileIdentity.ts').fileRuntimeFontId('C:\\fonts\\a.ttf',1,1)])
  built=sql.buildMergedIndexQuerySql({activeFilter:{kind:'active'}},50,0)
  assert.equal(a.prepare(built.countSql).get(...built.countParams).count,0,'shared active flag overrode local inactive snapshot')
  built=sql.buildMergedIndexQuerySql({},1,0)
  assert.equal(a.prepare(built.sql).get(...built.params).relative_path,'a.ttf','smart sort used shared favorite')
  const localCounts=load('src/main/library/fontMetricsRuntime.ts').readLocalUserMetricsFromMergedIndex
  a.prepare('UPDATE entries SET root_path=?').run(path.resolve('C:\\fonts'))
  let closed=0
  const metricOptions={roots:['C:\\fonts'],expectedTotal:2,openLibraryDb:async()=>a,
    openMergedIndexDb:async()=>({exec:sql=>assert(sql.includes('ATTACH DATABASE')),prepare:sql=>a.prepare(sql)}),
    librarySqlitePath:()=>':memory:',closeSqliteDb:()=>closed++,applyPendingActivationState:fonts=>fonts.map(font=>font.id===load('src/main/fonts/fontFileIdentity.ts').fileRuntimeFontId('C:\\fonts\\a.ttf',1,1)?{...font,active:true}:font)}
  assert.deepEqual(plain(await localCounts(metricOptions)),{favoriteCount:1,activeCount:1},'local metrics missed favorites or pending activation')
  assert.equal(await localCounts({...metricOptions,expectedTotal:3}),null,'incomplete snapshot must fall back')
  assert.equal(await localCounts({...metricOptions,roots:['/other']}),null,'old root snapshot leaked into new root metrics')
  assert.equal(closed,3)
  assert(invalidated>=4)
  a.close();b.close()
}
async function legacyIdentity() {
  const load=loader(), legacy=load('src/main/library/runtime/localFontLegacyIdentityRuntime.ts')
  const db=database(), index=database()
  load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(db)
  index.exec('CREATE TABLE sources(root_path TEXT,index_signature TEXT); CREATE TABLE entries(root_path TEXT,relative_path TEXT,file_size INTEGER,modified_at INTEGER,font_json TEXT,is_deleted INTEGER,status TEXT)')
  const roots=['C:\\one','C:\\two']
  for(const root of roots)index.prepare("INSERT INTO sources VALUES (?,'snapshot')").run(root)
  const row=(root,id,rel='same.ttf')=>({root_path:root,relative_path:rel,file_size:10,modified_at:100,font_json:JSON.stringify({id})})
  const rows=[row(roots[0],'shared'),row(roots[1],'shared'),row(roots[0],'unique','unique.ttf')]
  for(const r of rows)index.prepare("INSERT INTO entries VALUES (?,?,?,?,?,0,'ok')").run(...Object.values(r))
  const addTag=(id,tag)=>db.prepare("INSERT INTO local_font_tags VALUES (?,'',?,'old')").run(id,tag)
  const addFavorite=(id,value)=>db.prepare("INSERT INTO local_font_favorites VALUES (?,'',?)").run(id,value)
  addTag('shared','ambiguous');addFavorite('shared',1);addTag('unique','retained');addTag('unique','another');addFavorite('unique',1)
  addTag('absent','missing')
  const before=plain(db.prepare('SELECT * FROM local_font_tags ORDER BY font_id,tag_name').all())
  assert.equal(legacy.archivePathlessFontState(db),6)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM local_font_tags').get().n,0)
  assert.deepEqual(db.prepare("SELECT payload_json FROM local_font_legacy_state WHERE kind='tag' ORDER BY font_id,tag_name").all().map(r=>JSON.parse(r.payload_json)),before)
  assert.equal(legacy.readCompleteFontIdentityIndex(index,[...roots,'C:\\offline']),null,'partial catalog was treated as complete')
  assert.equal(legacy.reconcileLegacyFontState(db,null).deferred,6)
  const report=legacy.reconcileLegacyFontState(db,legacy.readCompleteFontIdentityIndex(index,roots))
  assert.deepEqual(plain(report),{resolved:3,ambiguous:2,missing:1,deferred:0})
  assert.deepEqual(db.prepare('SELECT tag_name FROM local_font_tags ORDER BY tag_name').all().map(r=>r.tag_name),['another','retained'])
  assert.equal(db.prepare('SELECT font_path FROM local_font_favorites').get().font_path,'c:\\one\\unique.ttf')
  // A one-row page must not assign a globally ambiguous record; the production
  // owner reads the complete snapshot, never the incoming page.
  let logs=[],invalidated=0
  for(const root of roots)db.prepare('INSERT INTO folders VALUES (?,0)').run(root)
  const owner=legacy.createLocalFontLegacyIdentityRuntime({readCompleteIndex:async requested=>legacy.readCompleteFontIdentityIndex(index,requested),appendLog:x=>logs.push(x),invalidate:()=>invalidated++})
  await owner.prepare(db)
  assert.equal(db.prepare("SELECT status FROM local_font_legacy_state WHERE font_id='shared' LIMIT 1").get().status,'ambiguous')
  assert(logs.some(x=>x.includes('多义=2')))
  const tags=load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts').createLocalFontTagNodePersistenceRuntime(async()=>db)
  const writer=await tags.openWriter()
  writer.deleteLocalFontTag('ambiguous')
  assert.equal(db.prepare("SELECT status FROM local_font_legacy_state WHERE kind='tag' AND font_id='shared'").get().status,'dismissed')
  // User clears a tag while its historical binding cannot yet be resolved.
  writer.setLocalFontTags(font('current',{path:'C:\\one\\missing.ttf'}),[],'now')
  legacy.reconcileLegacyFontState(db,[...rows,row(roots[0],'absent','missing.ttf')])
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_font_tags WHERE tag_name='missing'").get().n,0)
  assert.equal(db.prepare("SELECT status FROM local_font_legacy_state WHERE font_id='absent'").get().status,'superseded')
  // Existing explicit false wins over late legacy favorite resolution.
  db.prepare('INSERT INTO local_font_favorites VALUES (?,?,0)').run('local-path:c:\\one\\same.ttf','c:\\one\\same.ttf')
  legacy.reconcileLegacyFontState(db,[rows[0],rows[2]])
  assert.equal(db.prepare('SELECT favorite FROM local_font_favorites WHERE font_path=?').get('c:\\one\\same.ttf').favorite,0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_font_tags WHERE tag_name='ambiguous'").get().n,0)
  assert.equal(legacy.archivePathlessFontState(db),0,'repeat preparation must be idempotent')
  // Archive and active-table removal are atomic even if the second table fails.
  const fault=database();load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(fault)
  fault.exec("INSERT INTO local_font_tags VALUES ('x','','original','before'); INSERT INTO local_font_favorites VALUES ('x','',1); CREATE TRIGGER fail_archive BEFORE DELETE ON local_font_favorites BEGIN SELECT RAISE(ABORT,'archive failure'); END;")
  assert.throws(()=>legacy.archivePathlessFontState(fault),/archive failure/)
  assert.equal(fault.prepare('SELECT COUNT(*) AS n FROM local_font_tags').get().n,1)
  assert.equal(fault.prepare('SELECT COUNT(*) AS n FROM local_font_legacy_state').get().n,0)
  fault.exec('DROP TRIGGER fail_archive');legacy.archivePathlessFontState(fault)
  fault.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON local_font_favorites BEGIN SELECT RAISE(ABORT,'restore failure'); END;")
  assert.throws(()=>legacy.reconcileLegacyFontState(fault,[row(roots[0],'x')]),/restore failure/)
  assert.equal(fault.prepare('SELECT COUNT(*) AS n FROM local_font_tags').get().n,0)
  assert.equal(fault.prepare("SELECT COUNT(*) AS n FROM local_font_legacy_state WHERE status='pending'").get().n,2)
  const more=database();load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(more)
  more.exec("INSERT INTO local_font_tags VALUES ('overlap','','once','old'); INSERT INTO local_font_favorites VALUES ('left','',0),('right','',1)")
  legacy.archivePathlessFontState(more)
  const overlapping=[row(roots[0],'overlap','nested\\same.ttf'),row(roots[0]+'\\nested','overlap')]
  assert.equal(legacy.reconcileLegacyFontState(more,overlapping).resolved,1,'overlapping roots must deduplicate physical paths')
  const conflict=row(roots[0],'left');conflict.font_json=JSON.stringify({id:'left',sourceId:'right'})
  assert.equal(legacy.reconcileLegacyFontState(more,[conflict]).ambiguous,2,'conflicting favorites must remain archived')
  const favorites=load('src/main/library/runtime/localFontFavoritesRuntime.ts').createLocalFontFavoritesRuntime({openLibraryDb:async()=>more,loadLegacyLocalSnapshot:async()=>{throw Error('archived local history must suppress stale snapshot import')},invalidate(){},appendLog(){}})
  await favorites.initialize()
  assert.equal(more.prepare('SELECT COUNT(*) AS n FROM local_font_favorites').get().n,0)
  const malformed={...conflict,font_json:'invalid'}
  assert.throws(()=>legacy.reconcileLegacyFontState(more,[conflict,malformed]))
  assert.equal(more.prepare('SELECT COUNT(*) AS n FROM local_font_favorites').get().n,0)
  more.prepare('INSERT INTO folders VALUES (?,0)').run(roots[0])
  const moving=legacy.createLocalFontLegacyIdentityRuntime({readCompleteIndex:async()=>{more.prepare('INSERT INTO folders VALUES (?,1)').run(roots[1]);return [conflict]},appendLog(){},invalidate(){}})
  await moving.prepare(more)
  assert.equal(more.prepare('SELECT COUNT(*) AS n FROM local_font_favorites').get().n,0,'root changes must defer ownership')
  index.exec("UPDATE sources SET index_signature='pending-snapshot'")
  assert.equal(legacy.readCompleteFontIdentityIndex(index,roots),null,'pending sources must not authorize resolution')
  more.close();fault.close();index.close();db.close()
}
async function localIdentityPaths() {
  const load=loader(), db=database()
  load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(db)
  const first=font('legacy',{path:'C:\\one\\same.ttf',sourceId:'shared'})
  const second=font('legacy',{path:'C:\\two\\same.ttf',sourceId:'shared'})
  const favorite=load('src/main/library/runtime/localFontFavoritesRuntime.ts').createLocalFontFavoritesRuntime({
    openLibraryDb:async()=>db,loadLegacyLocalSnapshot:async()=>[],invalidate(){},appendLog(){},
  })
  await favorite.initialize()
  db.prepare('INSERT INTO local_font_favorites VALUES (?,?,1)').run('legacy',first.path.toLowerCase())
  assert.deepEqual((await favorite.hydrate([second])).map(f=>f.favorite),[false], 'path-bearing old ID leaked to another copy')
  await favorite.setFavorite([first,second],[],true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM local_font_favorites').get().n,2,'same-ID batch lost a path')
  await favorite.setFavorite([first],[],false)
  assert.deepEqual((await favorite.hydrate([first,second])).map(f=>f.favorite),[false,true],'clear removed another copy')
  const tags=load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts').createLocalFontTagNodePersistenceRuntime(async()=>db)
  const writer=await tags.openWriter()
  db.prepare('INSERT INTO local_font_tags VALUES (?,?,?,?)').run('shared',first.path.toLowerCase(),'old','before')
  assert.deepEqual(plain((await tags.hydrateLocalTagsForFonts([second]))[0].localTagNames),[],'path-bearing tag leaked through shared alias')
  writer.setLocalFontTags(first,['one'],'now');writer.setLocalFontTags(second,['two'],'now')
  // Distinct response IDs model the F02 candidate while persisted aliases still collide.
  const items=[{...first,id:'one'},{...second,id:'two'}]
  assert.deepEqual(plain((await tags.hydrateLocalTagsForFonts(items)).map(f=>f.localTagNames)),[['one'],['two']])
  writer.setLocalFontTags(first,[],'later')
  assert.deepEqual(plain((await tags.hydrateLocalTagsForFonts(items)).map(f=>f.localTagNames)),[[],['two']])
  db.prepare('INSERT INTO local_font_tags VALUES (?,?,?,?)').run('shared',first.path.toLowerCase(),'old','before')
  db.exec("ATTACH DATABASE ':memory:' AS local_db; CREATE TABLE local_db.local_font_tags AS SELECT * FROM main.local_font_tags; CREATE TABLE local_db.local_font_favorites AS SELECT * FROM main.local_font_favorites;")
  // Actual generated worker hydration, including its independent alias reader.
  const context={module:{exports:{}},require:id=>id==='better-sqlite3'?DatabaseSync:require(id)}
  require('node:vm').runInNewContext(load('src/main/db/query-worker/dbQueryWorkerSharedSource.ts').buildDbQueryWorkerSharedSource()+'\nmodule.exports={hydrateLocalTags}',{...context,process})
  assert.deepEqual(plain(context.module.exports.hydrateLocalTags(db,items).map(f=>f.localTagNames)),[['old'],['two']])
  db.exec("CREATE TABLE entries(root_path TEXT, relative_path TEXT, file_size INTEGER, modified_at INTEGER, font_json TEXT)")
  db.prepare('INSERT INTO entries VALUES (?,?,?,?,?)').run('C:\\one','same.ttf',1,1,JSON.stringify({id:'shared'}))
  db.prepare('INSERT INTO entries VALUES (?,?,?,?,?)').run('C:\\two','same.ttf',1,1,JSON.stringify({id:'shared'}))
  db.function('hfm_shared_font_id',(_relative,_size,_mtime)=> 'legacy')
  require('./check-operation-chain.cjs').loader()('src/main/fonts/fontFileIdentity.ts').registerFileIdentitySql(db)
  const sql=load('src/main/indexing/root-query/rootIndexQuerySharedSql.ts')
  assert.deepEqual(db.prepare('SELECT '+sql.mergedIndexLocalFavoriteExpr()+' AS favorite FROM entries ORDER BY root_path').all().map(r=>r.favorite),[0,1])
  assert.deepEqual(db.prepare("SELECT root_path FROM entries WHERE EXISTS (SELECT 1 FROM local_db.local_font_tags lft WHERE lft.tag_name='old' AND "+sql.rootIndexLocalTagMatchExpr()+')').all().map(r=>r.root_path),['C:\\one'])
  const metrics=await load('src/main/library/fontMetricsRuntime.ts').createFontMetricsRuntime({
    appWatchedFolders:async()=>[],loadSharedFontsForFolders:async()=>items,
    hydrateInstallStatusForFonts:async fonts=>fonts,hydrateLocalTagsForFonts:tags.hydrateLocalTagsForFonts,
    openLibraryDb:async()=>db,loadLibraryShellFromSqlite:()=>({}),saveMetricsSnapshot:async()=>{},
    inferFontSearchCategory:()=> 'sansSerif',sharedFontMatchesPathPrefixes:()=>false,
  }).getFontMetricsFromLibrary()
  assert.deepEqual(plain(metrics.localTagCounts),{old:1,two:1},'fallback counts lost path-owned tags')
  db.close()
}
async function tags() {
  const db=database();db.exec('CREATE TABLE bindings(root TEXT, id TEXT, tags TEXT)')
  let view={fonts:{a:font('a',{tagNames:['11']})},tags:['11','empty'],localTags:['private'],folders:[],__sharedTagAuthorityKnown:true}
  let catalog=['11','empty'], saved=0, signalListener
  const load=loader({electron:{BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{send:(_ch,payload)=>signalListener?.(payload)}}]}},'react':{useRef:value=>({current:value}),useEffect:fn=>fn()},'../../../fontOperationTrace':{reportFontOperation(){}},'./fontOperationTrace':{reportFontOperation(){}},'../../../rendererPerformance':{reportRendererTrace(){}}})
  load('src/renderer/src/runtime/app/effects/useFontTagStateSignalEventRuntime.ts').useFontTagStateSignalEventRuntime({
    hfm:{onFontTagStateSignal:fn=>{signalListener=fn;return()=>{}}},getCurrentLibrary:()=>view,
    commitLibraryUpdate:next=>{view=next;return next},saveLibraryImmediately:async()=>{saved++;return true},refreshDatabaseDerivedState(){},setStatus(){},
  })
  const composition=load('src/main/bootstrap/mainTagCompositionRuntime.ts').createMainTagCompositionRuntime({clearFontQueryCaches(){},appendStartupLog(){}})
  db.prepare('INSERT INTO bindings VALUES (?,?,?)').run('r1','a','["11"]')
  let failRoot=false
  const mutation=load('src/main/library/sharedFontMetadataMutations.ts').createSharedFontMetadataMutations({
    uniqueResolvedFolders:x=>x,invalidateSharedFontRuntimeCaches(){},syncSharedMetadataRootsToMergedIndex:async()=>{},
    deleteKnownSharedTagIfUnbound:async(_r,tag)=>{
      const bound=db.prepare('SELECT tags FROM bindings').all().some(r=>JSON.parse(r.tags).includes(tag))
      if(bound)return {deleted:false}
      catalog=catalog.filter(t=>t!==tag);return {deleted:true,nextTags:catalog}
    },
    renameSharedTagInMetadataIndexes:async (oldTag,newTag)=>{
      const ids=[];for(const row of db.prepare('SELECT * FROM bindings').all()){
        const tags=JSON.parse(row.tags);if(!tags.includes(oldTag))continue
        db.prepare('UPDATE bindings SET tags=? WHERE id=?').run(JSON.stringify(tags.map(tag=>tag===oldTag?newTag:tag)),row.id);ids.push(row.id)
      }
      return {updatedIds:ids,failed:[]}
    },
    removeSharedTagFromMetadataIndexes:async tag=>{
      const rows=db.prepare('SELECT * FROM bindings').all();const updatedIds=[],failed=[]
      for(const row of rows){if(failRoot&&row.root==='r2'){failed.push({id:row.id,message:'offline'});continue}
        const tags=JSON.parse(row.tags);if(!tags.includes(tag))continue
        db.prepare('UPDATE bindings SET tags=? WHERE id=?').run(JSON.stringify(tags.filter(t=>t!==tag)),row.id);updatedIds.push(row.id)
      }
      // Backend per-root notifications deliberately have no knownTags.
      composition.tagMutationStateSignalRuntime.handleSharedMetadataMutationStateSignal({changedIds:updatedIds,mutationKind:'removeTag'})
      return {updatedIds,failed,mutationProtocols:[{command:'removeTag',domain:'sharedMetadata',changedIds:updatedIds}]}
    },
    refreshKnownSharedTagsFromMetadata:async(_roots,options)=>{
      catalog=[...new Set([...catalog.filter(t=>!options.dropTags?.includes(t)),...db.prepare('SELECT tags FROM bindings').all().flatMap(row=>JSON.parse(row.tags))])];return catalog
    },
  })
  const remove=tag=>composition.tagMutationWriteProtocolRuntime.run({scope:'shared',mutationKind:'deleteTag',action:()=>mutation.deleteSharedFontTagInIndex(tag,['r1','r2'])})
  if(!baseline&&!mutant){
    await composition.tagMutationWriteProtocolRuntime.run({scope:'shared',mutationKind:'renameTag',action:()=>mutation.renameSharedFontTagInIndex('11','22',['r1','r2'])})
    assert.deepEqual(plain(view.tags),['22','empty'],'rename did not publish new catalog')
    await composition.tagMutationWriteProtocolRuntime.run({scope:'shared',mutationKind:'renameTag',action:()=>mutation.renameSharedFontTagInIndex('22','11',['r1','r2'])})
  }
  let result=await remove('11');assert.equal(result.ok,true);assert.deepEqual(plain(view.tags),['empty']);assert.deepEqual(plain(view.fonts.a.tagNames),[])
  await remove('empty');assert.deepEqual(plain(view.tags),[],'last/zero-bound tag survived deletion')
  await tick();assert.equal(saved,0,'backend notification wrote stale renderer snapshot back to DB')
  catalog=['shared'];view={...view,tags:['shared']};db.prepare('INSERT INTO bindings VALUES (?,?,?)').run('r2','b','["shared"]');failRoot=true
  result=await remove('shared');assert.equal(result.ok,false);assert.deepEqual(plain(view.tags),['shared'],'partial deletion erased unread root catalog')
  db.close()
}
async function activation() {
  const load=loader()
  const f=font('a',{active:true,installStatusKnown:true,managedInstallPath:'C:\\temp\\a.ttf'})
  let updates={},readFails=false,permanent=false,reads=0,osWrites=0
  const deps={ensureWindows(){},loadTemporaryActiveFonts:async()=>({records:[]}),saveTemporaryActiveFonts:async()=>{osWrites++},removeFontResourceSessionBatch:async()=>{osWrites++;return{}},deleteFontRegistryValuesHKCUBatch:async()=>{osWrites++},scheduleBackgroundFontRefreshTail(){},appendStartupLog(){},normalizePathForCacheCompare:x=>x.toLowerCase(),clearInstalledFontsMemoryCache(){},getSystemInstalledFontsCached:async force=>{assert.equal(force,true);reads++;if(readFails)throw Error('registry unavailable');return permanent?[{source:'HKLM',path:'C:\\Windows\\Fonts\\a.ttf'}]:[]},isTemporaryActiveInstalledRecord:()=>false,compareFontInstalledWithList:(_font,records)=>({installed:records.length>0,by:records.length?'system':'none',matches:records}),scheduleActivationInstallStatusSave:rows=>{updates={...updates,...rows}}}
  const batch=load('src/main/activation/runtime/fontDeactivationBatchRuntime.ts').createFontDeactivationBatchRuntime(deps,{queueTemporaryFontFileDeletes:async()=>{osWrites++;return{}}})
  let result=await batch.deactivateFontSessionsBatch([f]);assert.equal(result.ok,true);assert.equal(updates.a?.by,'none','no-record branch did not reconcile')
  assert.equal(osWrites,0,'no-record branch removed permanent/system resource')
  const facade=load('src/main/library/fontQueryFacadeRuntime.ts').createFontQueryFacadeRuntime({readInstallStatusIndex:async()=>({results:updates}),appendLog(){}})
  assert.equal((await facade.hydrateInstallStatusForFonts([f]))[0].active,false)
  permanent=true;result=await batch.deactivateFontSessionsBatch([f]);assert.equal(result.ok,true);assert.equal(updates.a.by,'system');assert.equal(updates.a.installed,true)
  readFails=true;result=await batch.deactivateFontSessionsBatch([f]);assert.equal(result.ok,false,'read failure reported success');assert.equal(updates.a.by,'system','read failure erased installation')
  readFails=false;permanent=false
  const status=load('src/main/activation/runtime/fontActivationInstallStatusRuntime.ts').createFontActivationInstallStatusRuntime(deps)
  const session=load('src/main/activation/runtime/fontActivationSessionRuntime.ts').createFontActivationSessionRuntime(deps,status,{removeTemporaryActiveRecord:async()=>{osWrites++;return true}},{activateFontSessionTransaction:async()=>{}})
  assert.equal((await session.deactivateFontSession(f)).ok,true);assert.equal(updates.a.by,'none');assert.equal(osWrites,0)
  assert.equal(reads,4)
  const lingering={source:'HKCU',path:'C:\\temp\\a.ttf'}
  const reconciliation=load('src/main/activation/runtime/fontActivationInstallStatusRuntime.ts').createFontActivationInstallStatusRuntime({...deps,
    getSystemInstalledFontsCached:async()=>[lingering,{source:'HKLM',path:'C:\\Windows\\Fonts\\a.ttf'}],
    isTemporaryActiveInstalledRecord:record=>record===lingering,
    compareFontInstalledWithList:(_font,records)=>({installed:records.length>0,by:'both',matches:records}),
  })
  const reconciled=await reconciliation.reconcileDeactivatedInstallStatus([f],[lingering.path])
  assert.equal(reconciled.a.by,'system');assert.equal(reconciled.a.matches.length,1)
  // Use the real permanent comparator, which deliberately skips temp records.
  const comparison=load('src/main/install/fontInstallCompare.ts').createInstallCompareRuntime({appName:'HFM'})
  const tempName=comparison.safeTemporaryActiveFontName(f)
  const temporary={source:'HKCU',path:'C:\\temp\\'+tempName,fileName:tempName,registryName:comparison.temporaryActiveRegistryNameFor(f)}
  const system={source:'HKLM',path:'C:\\Windows\\Fonts\\a.ttf',fileName:'a.ttf',registryName:'a (TrueType)'}
  const actualStatus=load('src/main/activation/runtime/fontActivationInstallStatusRuntime.ts').createFontActivationInstallStatusRuntime({...deps,...comparison,getSystemInstalledFontsCached:async()=>[temporary,system]})
  assert.equal((await actualStatus.reconcileDeactivatedInstallStatus([f])).a.by,'both','orphan temporary resource was hidden by permanent comparator')
  assert.equal((await actualStatus.reconcileDeactivatedInstallStatus([f],[temporary.path])).a.by,'system','permanent installation was erased when removing temporary resource')

}

async function metricsRace() {
  const runtime=loader()('src/main/library/fontMetricsRequestCoalescerRuntime.ts').createFontMetricsRequestCoalescerRuntime()
  let release;const blocked=new Promise(r=>release=r);let calls=0
  const args={appendLog(){},load:async()=>{calls++;if(calls===1){await blocked;return {activeCount:3,favoriteCount:1}}return{activeCount:0,favoriteCount:0}}}
  const old=runtime.run(args);runtime.clear();release();assert.deepEqual(plain(await old),{activeCount:0,favoriteCount:0},'invalidated metrics leaked to old caller')
}
async function knownCatalog() {
  const db=database()
  let unavailable=false, bound=[]
  const load=loader({'../path/startupPathAvailabilityRuntime':{getStartupPathRootState:root=>({generation:1,state:unavailable&&root==='r2'?'offline':'online'}),filterStartupAvailableRoots:async roots=>({availableRoots:unavailable?roots.slice(0,1):roots,skippedRoots:unavailable?roots.slice(1):[]})}})
  load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(db)
  const insert=db.prepare('INSERT INTO tags VALUES (?,?)');insert.run('last',0);insert.run('empty',1)
  const runtime=load('src/main/library/sharedKnownTagsRuntime.ts').createSharedKnownTagsRuntime({
    uniqueResolvedFolders:x=>x,sharedMetadataDbPathForRoot:root=>root+'/metadata',openLibraryDb:async()=>db,
    loadLibraryShellFromSqlite:()=>({tags:db.prepare('SELECT name FROM tags ORDER BY sort_order').all().map(row=>row.name)}),
    appendStartupLog(){},runRustSharedMetadataKnownTags:async({roots})=>({knownTags:bound,roots:roots.map(root=>({...root,signature:'metadata-v2|fixture',knownTags:bound,rows:bound.length}))}),
  })
  assert.deepEqual(plain(await runtime.refreshKnownSharedTagsFromMetadata(['r1','r2'],{allowEmptyOverwrite:false,dropTags:['last']})),['empty'])
  assert.deepEqual(plain(await runtime.refreshKnownSharedTagsFromMetadata(['r1','r2'],{allowEmptyOverwrite:false,dropTags:['empty']})),[], 'actual known-tag owner revived the last deleted tag')
  insert.run('keep',0);unavailable=true
  assert.deepEqual(plain(await runtime.refreshKnownSharedTagsFromMetadata(['r1','r2'],{allowEmptyOverwrite:false,dropTags:['keep']})),['keep'],'unavailable root lost catalog')
  await assert.rejects(runtime.refreshKnownSharedTagsFromMetadata(['r1','r2'],{allowEmptyOverwrite:false,dropTags:['keep'],requireFresh:true}),/暂时不可用/)
  unavailable=false;bound=['keep']
  assert.deepEqual(plain(await runtime.refreshKnownSharedTagsFromMetadata(['r1','r2'],{allowEmptyOverwrite:false,dropTags:['keep']})),['keep'],'remaining binding lost its directory entry')
  db.close()
}
async function compositionPorts() {
  const {createHarness,entry}=require('./helpers/mainCompositionHarness.cjs')
  const h=createHarness();h.load(entry);h.reset()
  await h.payload.setSharedFontFavoriteInIndex([font('a')],['/root'],true)
  assert(h.calls.some(call=>call[0]==='createLocalFontFavoritesRuntime.setFavorite'),'IPC favorite is not wired to the local owner')
  assert(!h.calls.some(call=>/SharedFontMetadata|MergedIndex/.test(call[0])),'favorite crossed shared mutation boundary')
  h.reset();h.options('createLocalFontFavoritesRuntime').invalidate()
  assert(!h.calls.some(call=>call[0]==='createFolderCacheRuntime.invalidateSharedFontRuntimeCaches'),'local favorite invalidated NAS font cache')
}
async function pageRace() {
  const load=loader();let release;const gate=new Promise(r=>release=r);let calls=0
  const page=load('src/main/library/fontPageQueryCacheRuntime.ts').createFontPageQueryCacheRuntime({pageCacheMax:10,pageCacheTtlMs:1000,appendStartupLog(){},queryUncached:async()=>{calls++;if(calls===1){await gate;return{total:1,items:[font('a',{favorite:true})]}}return{total:0,items:[]}}})
  const old=page.queryFontPageInLibrary({activeFilter:{kind:'favorites'}});page.invalidateFontQueryPageCache();release()
  assert.equal((await old).total,0,'favorite page total survived invalidation')
}
async function idsRace() {
  const load=loader();let release;const gate=new Promise(r=>release=r);let calls=0
  const facade=load('src/main/library/fontQueryFacadeRuntime.ts').createFontQueryFacadeRuntime({fontSearchResultLimitDefault:100,appWatchedFolders:async()=>['/root'],appendLog(){},scheduleMergedIndexBackgroundValidation(){},mergedIndexDbPath:()=>'/merged',librarySqlitePath:()=>'/app',cleanSharedFontsForQuery:async()=>[],rustCoreWorkerRuntime:{runRustMergedIndexIdsQuery:async()=>{calls++;await gate;return {ids:['old'],total:1,engine:'sql'}}}})
  const response=facade.queryFontsInLibrary({activeFilter:{kind:'favorites'}});await tick();facade.clearFontMetricsQueryCache();release();assert.deepEqual(plain((await response).ids),[],'in-flight favorite IDs survived invalidation')
  await facade.queryFontsInLibrary({activeFilter:{kind:'active'}});assert.equal(calls,1,'active IDs bypassed pending install state')
}
async function main(){
  if(selected==='legacy-identity'){await legacyIdentity();return}
  if(selected==='uninstall-native'){await uninstallNative();return}
  if(selected==='uninstall'){await uninstallPlanning();return}
  if(selected==='protection'){await protection();return}
  if(selected==='identity'){await localIdentityPaths();return}
  const cases={favorites,tags,activation,metrics:metricsRace}
  if(selected){await cases[selected]();return}
  for(const run of Object.values(cases))await run()
  await protection();await legacyIdentity();await localIdentityPaths();await knownCatalog();await idsRace();await pageRace();await compositionPorts()
  if(!crlf){
    for(const kind of Object.keys(cases)){
      for(const mode of ['--mutant','--baseline']){
        const result=spawnSync(process.execPath,[__filename,'--case='+kind,mode],{encoding:'utf8'})
        assert.notEqual(result.status,0,kind+' '+mode+' escaped')
        assert(result.stderr.includes('AssertionError'),kind+' '+mode+' failed outside business assertion: '+result.stderr)
      }
    }
    const windows=spawnSync(process.execPath,[__filename,'--crlf'],{encoding:'utf8'});assert.equal(windows.status,0,windows.stderr)
  }
  console.log('[diagnostics:local-user-state] real SQLite/local isolation + catalog/view + single/batch deactivation + page/ID/metrics races; LF/CRLF and 4 old-code/4 regression assertions passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})

async function uninstallPlanning() {
  const contents=new Map(),stats=new Map(),a='C:\\source\\face.ttf',b='C:\\user-fonts\\face.ttf',other='C:\\user-fonts-other\\face.ttf'
  const bytes=Buffer.from('0001000000000000','hex')
  for(const file of [a,b,other])contents.set(file,bytes)
  const io={realpath:async p=>p,stat:async p=>{if(!contents.has(p))throw Error('missing');return {isFile:()=>true,size:contents.get(p).length,mtimeMs:1,ino:stats.get(p)||1}},readFile:async p=>contents.get(p)}
  const load=loader({[path.join(root,'src/main/path/sharedFileSystemRuntime.ts')]:{sharedFileSystem:io}})
  const plan=load('src/main/install/fontUninstallPlanRuntime.ts').planFontUninstall
  const item={id:'source',path:a,fileName:'face.ttf',systemInstallMatches:[]}
  const record={source:'HKCU',path:b,registryName:'Face',value:b}
  let result=await plan(item,[record],[record],['C:\\user-fonts'],()=>false)
  assert.equal(result.length,2);assert.equal(result[0].records[0].name,'Face');assert.equal(result[1].delete_file,true)
  contents.set(b,Buffer.from('0001000000000001','hex'))
  assert.equal((await plan(item,[record],[record],['C:\\user-fonts'],()=>false)).length,0,'same name authorized different bytes')
  contents.set(b,bytes)
  await assert.rejects(plan(item,[record,{...record,path:other,value:other}],[],['C:\\user-fonts'],()=>false),/多个内容相同/)
  result=await plan({...item,path:other},[{...record,path:other,value:other}],[{...record,path:other,value:other}],['C:\\user-fonts'],()=>false)
  assert(result.every(p=>!p.delete_file),'prefix sibling escaped path boundary')
  const renamed='C:\\user-fonts\\different.ttf';contents.set(renamed,bytes)
  assert.equal((await plan(item,[{...record,path:renamed,value:renamed}],[],['C:\\user-fonts'],()=>false)).length,0,'fuzzy display name matched')
  await assert.rejects(plan({...item,path:b},[record],[{...record,registryName:'temporary'}],['C:\\user-fonts'],r=>r.registryName==='temporary'),/临时激活/)
  console.log('[F06] exact-content planning, ambiguous copies, names and directory boundaries passed')
}

async function uninstallNative() {
  assert.equal(process.platform,'win32','F06 native acceptance requires Windows')
  const {spawn}=require('node:child_process'),{createInterface}=require('node:readline'),crypto=require('node:crypto')
  const worker=path.join(root,'build/native/hfm-core-worker.exe')
  const userRoot=path.join(process.env.LOCALAPPDATA,'Microsoft/Windows/Fonts')
  fs.mkdirSync(userRoot,{recursive:true})
  const token='HFM_F06_TEST_'+crypto.randomUUID()+'_中文',target=path.join(userRoot,token+'.ttf')
  const original=path.join(process.env.WINDIR,'Fonts/arial.ttf')
  const regRoot='HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
  const reg=(args)=>execFileSync('reg',args,{encoding:'utf8',windowsHide:true})
  // Create a writable fixture from bytes, without inheriting system-file
  // attributes. Read-only behavior is exercised explicitly below.
  const make=()=>{fs.writeFileSync(target,fs.readFileSync(original),{flag:'wx'});assert.equal(fs.statSync(target).mode & 0o200,0o200);reg(['add',regRoot,'/v',token,'/t','REG_SZ','/d',target,'/f'])}
  const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  const child=spawn(worker,['--font-mutation-broker'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,HFM_PARENT_PID:String(process.pid)}})
  const line=createInterface({input:child.stdout}),queue=[],wait=[];let failure,stderr=''
  child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b)})
  child.on('error',e=>{failure=e;for(const w of wait.splice(0))w.reject(e)})
  child.on('exit',code=>{failure=Error(`broker exit ${code}: ${stderr}`);for(const w of wait.splice(0))w.reject(failure)})
  line.on('line',s=>{const value=JSON.parse(s),w=wait.shift();if(w)w.resolve(value);else queue.push(value)})
  const next=()=>queue.length?Promise.resolve(queue.shift()):failure?Promise.reject(failure):new Promise((resolve,reject)=>wait.push({resolve,reject}))
  const timeout=setTimeout(()=>child.kill(),45000)
  async function command(plan,onGate=()=>true) {
    child.stdin.write(JSON.stringify(plan)+'\n');const effects=[],gates=[];let done
    for(;;){const r=await next();if(r.gate){const allow=await onGate(r.gate);gates.push({stage:r.gate,allow});child.stdin.write(JSON.stringify({allow})+'\n')}if(r.effect)effects.push(r);if(r.done)done=r;if(r.brokerDone)return {...r,effects,gates,elevated:done}}
  }
  try {
    assert.equal((await next()).protocol,'font-mutation-v1');make()
    child.stdin.write('{"snapshot":true}\n');const snapshot=await next();assert(snapshot.ok);assert(snapshot.records.some(r=>r.registryName===token&&r.path===target),'native registry snapshot corrupted Unicode')
    let plan={path:target,sha256:digest(),delete_file:true,records:[{scope:'HKCU',name:token,value:target}]}
    let r=await command(plan,()=>false);assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert(fs.existsSync(target));assert.doesNotThrow(()=>reg(['query',regRoot,'/v',token]))
    r=await command({...plan,sha256:'0'.repeat(64)});assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert(fs.existsSync(target))
    r=await command(plan,stage=>{if(stage==='registry')reg(['add',regRoot,'/v',token,'/t','REG_SZ','/d',original,'/f']);return true})
    assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert(fs.existsSync(target));assert(reg(['query',regRoot,'/v',token]).includes('arial.ttf'))
    reg(['add',regRoot,'/v',token,'/t','REG_SZ','/d',target,'/f'])
    fs.chmodSync(target,0o444)
    r=await command(plan);assert.equal(r.ok,false);assert.match(r.message,/read-only/);assert.equal(r.effects.length,0,'read-only preflight removed an installation record');assert(fs.existsSync(target));assert.doesNotThrow(()=>reg(['query',regRoot,'/v',token]))
    fs.chmodSync(target,0o666)
    r=await command(plan);assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.effects.map(e=>e.effect),['registry','file']);assert(!fs.existsSync(target));assert.throws(()=>reg(['query',regRoot,'/v',token]));assert(fs.existsSync(original),'test touched the original system font')
    make();plan={...plan,sha256:digest()}
    r=await command({...plan,path:path.join(require('node:os').tmpdir(),token+'.ttf')});assert.equal(r.ok,false);assert.equal(r.effects.length,0)
    r=await command({...plan,records:[{scope:'HKCU',name:token,value:original}]});assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert(fs.existsSync(target))
    r=await command(plan,stage=>stage!=='file');assert.equal(r.ok,false);assert.deepEqual(r.effects.map(e=>e.effect),['registry']);assert(fs.existsSync(target),'partial failure lost the remaining file')
    let fileGates=0
    r=await command({...plan,records:[]},stage=>stage!=='file'||++fileGates<2);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.effects.length,0,'protection change during resource release reached deletion');assert.equal(fileGates,2);assert(fs.existsSync(target))
    r=await command({...plan,records:[]});assert.equal(r.ok,true,JSON.stringify({scenario:'remaining-file-retry',receipt:r,targetExists:fs.existsSync(target),targetMode:fs.existsSync(target)?fs.statSync(target).mode:null,stderr}));assert.deepEqual(r.effects.map(e=>e.effect),['file'],'remaining-step retry must perform exactly one file effect');assert(!fs.existsSync(target),'remaining-step retry failed')
    const invalid=spawnSync(worker,['--font-mutation-elevated','bad-pipe','1'],{encoding:'utf8',timeout:5000,windowsHide:true});assert.notEqual(invalid.status,0,'unauthenticated elevated endpoint accepted')
    console.log('[F06 native] original-user HKCU/file effects, denial, content mismatch, changed registry, boundary refusal, partial completion and remaining-step retry passed; real UAC/HKLM/UNC remain manual acceptance')
  } catch(error) {
    // Evidence only: retain the original failing assertion even if the probe
    // can subsequently delete this disposable fixture. Never probe real fonts.
    const evidence={failure:String(error),stderr,probe:null}
    try {
      if(fs.existsSync(target)) {
        const probe=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'lib/font-disposition-probe.ps1')],{encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,HFM_DISPOSITION_FIXTURE:target,HFM_DISPOSITION_SHA256:digest()}})
        evidence.probe={status:probe.status,stdout:probe.stdout,stderr:probe.stderr,error:probe.error?.message}
        console.error('[F06 disposition probe]',JSON.stringify(evidence.probe))
      }
      const dir=path.join(root,'artifacts/font-identity-f06');fs.mkdirSync(dir,{recursive:true})
      fs.writeFileSync(path.join(dir,'disposition-failure.json'),JSON.stringify(evidence,null,2))
    } catch(probeError) { console.error('[F06 disposition probe failed]',probeError) }
    throw error
  } finally {
    clearTimeout(timeout);child.kill();line.close()
    try{reg(['delete',regRoot,'/v',token,'/f'])}catch{}
    try{fs.chmodSync(target,0o666);fs.unlinkSync(target)}catch(e){if(e.code!=='ENOENT')throw e}
  }
}
