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
  const physicalIds=new Map();const physicalId=p=>{if(!physicalIds.has(p))physicalIds.set(p,physicalIds.size+1);return physicalIds.get(p)}
  const io={access:async p=>{if(trashedPaths.has(p))throw Object.assign(Error('missing'),{code:'ENOENT'})},realpath:async p=>p,stat:async p=>({isFile:()=>true,size:8,mtimeMs:1,ctimeMs:1,dev:1,ino:physicalId(p)}),readFile:async()=>Buffer.from('0001000000000000','hex'),mkdir:async()=>{},copyFile:async()=>effects.push('copy'),unlink:async()=>effects.push('unlink')}
  let protectAfterPermission=''
  const runtimeLoad=loader({electron:{shell:{trashItem:async()=>effects.push('trash')}},
    'node:fs':{existsSync:()=>true},
    'node:child_process':{execFile:(exe,_args,_options,done)=>{effects.push(exe==='net'?'permission-check':'registry-native');if(exe==='net'&&protectAfterPermission)blocked.add(protectAfterPermission);done(null,'')}},
    [portFile]:{sharedFileSystem:io,withSharedIoPriority:(_priority,run)=>run(),executeSharedFile:async request=>{assert.equal(request.operation,'trash');effects.push('trash');trashedPaths.add(request.path)}},
    [path.join(root,'src/main/rust-core/rustSharedIoCommandRuntime.ts')]:{sharedIoResourceKeys:async()=>[]},
    [path.join(root,'src/main/storage/runtime/sharedLeaseLockRuntime.ts')]:{withSharedLeaseLock:async(_opts,action)=>action()}})
  const authority2=runtimeLoad('src/main/install/fontProtectionAuthorityRuntime.ts').createFontProtectionAuthorityRuntime({roots:async()=>[],read:async item=>{if(offline)throw Error('offline');return blocked.has(item.path)},lock:async(_items,_roots,action)=>action(),log(){}})
  const installedPath='C:\\user-fonts\\sample.ttf'
  const records=[{path:installedPath,fileName:'sample.ttf',registryName:'Sample',value:installedPath,source:'HKCU'}]
  const receiptDb=database()
  const deps={readUninstallActivationClaims:async()=>[],openUninstallReceipts:async()=>runtimeLoad('src/main/install/fontUninstallReceiptRuntime.ts').openFontUninstallReceipts(receiptDb),persistUninstallResult:async()=>{},deactivateForFileDelete:async()=>({ok:true,message:'settled'}),readUninstallRegistry:async()=>records.filter(record=>!record.__removed),
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
  effects=[]
  const failureLogs=[]
  deps.appendStartupLog=message=>failureLogs.push(message)
  deps.readUninstallRegistry=async()=>{throw Error('registry snapshot decode: scope=HKCU, name="bad-font", type=7')}
  const rejected=await system.uninstallFontSystemWide([source])
  assert.equal(rejected.ok,false)
  assert.match(rejected.results[source.id].message,/scope=HKCU.*bad-font/)
  assert(failureLogs.some(message=>message.includes('"stage":"registry-snapshot"')&&message.includes('bad-font')),'snapshot failure lost its stage or specific record')
  assert.deepEqual(effects,[],'failed snapshot reached registry/file mutation')
  records[0]={source:'HKCU',path:installedPath,value:installedPath,fileName:'sample.ttf',registryName:'Sample'}
  deps.readUninstallRegistry=async()=>records.filter(record=>!record.__removed)
  deps.createMutationSession=async()=>({close(){},execute:async(plan,check)=>{
    await check()
    if(plan.delete_file)return {ok:false,message:'sharing violation',completedSteps:0,fileRemoved:false,code:32}
    effects.push('registry-delete');for(const entry of records)if(plan.records.some(record=>record.scope===entry.source&&record.name===entry.registryName))entry.__removed=true;return {ok:true,message:'record removed',completedSteps:plan.records.length,fileRemoved:false}
  }})
  const incomplete=await system.uninstallFontSystemWide(source)
  assert.equal(incomplete.ok,false);assert.equal(incomplete.uninstall.completedSteps,1)
  assert.deepEqual(Array.from(incomplete.uninstall.remainingPaths),[installedPath]);assert.equal(incomplete.uninstall.stage,'file-delete')
  assert.match(incomplete.message,/安装文件尚未清理完成/);assert.deepEqual(effects,['registry-delete'])
  receiptDb.close()
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
  const load=loader({[path.join(root,'src/main/path/sharedFileSystemRuntime.ts')]:{sharedFileSystem:{realpath:async p=>p,stat:async()=>({isFile:()=>true,size:8,mtimeMs:1,ctimeMs:1,dev:1,ino:1}),readFile:async()=>Buffer.from('0001000000000000','hex')}}})
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
  const response=facade.queryFontsInLibrary({activeFilter:{kind:'favorites'}});await tick();facade.clearFontMetricsQueryCache();release();await assert.rejects(response,/查询修订已变化/,'in-flight favorite IDs must stop without fallback after invalidation')
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
  const contents=new Map(),stats=new Map(),aliases=new Map(),failures=new Map(),readCounts=new Map(),a='C:\\source\\face.ttf',b='C:\\user-fonts\\face.ttf',other='C:\\user-fonts-other\\face.ttf'
  const bytes=Buffer.from('0001000000000000','hex'),different=Buffer.from('0001000000000001','hex')
  for(const [i,file] of [a,b,other].entries()){contents.set(file,bytes);stats.set(file,i+1)}
  const missing=()=>Object.assign(Error('missing'),{code:'ENOENT'})
  const io={realpath:async p=>{if(failures.has(p))throw failures.get(p);if(!contents.has(aliases.get(p)||p))throw missing();return aliases.get(p)||p},stat:async p=>{
    if(p==='C:\\')return {isDirectory:()=>true}
    if(failures.has(p))throw failures.get(p)
    if(!contents.has(p))throw missing()
    return {isFile:()=>true,size:contents.get(p).length,mtimeMs:1,ctimeMs:1,dev:1,ino:stats.get(p)||99}
  },readFile:async p=>{readCounts.set(p,(readCounts.get(p)||0)+1);return contents.get(p)}}
  const load=loader({
    'node:path':path.win32,
    [path.join(root,'src/main/path/sharedFileSystemRuntime.ts')]:{sharedFileSystem:io,withSharedIoPriority:(_priority,run)=>run()},
    // The runtime below injects its controlled mutation session. Refuse the
    // default OS launcher rather than importing Electron or spawning a worker.
    [path.join(root,'src/main/install/fontMutationProcessRuntime.ts')]:{createFontMutationSession:async()=>{throw Error('uninstall planning must use the injected mutation session')}},
  })
  const plan=load('src/main/install/fontUninstallPlanRuntime.ts').planFontUninstall
  const evidence=load('src/main/install/fontInstallEvidenceRuntime.ts'),compare=load('src/main/install/fontInstallCompare.ts').createInstallCompareRuntime({appName:'HFM'})
  const item={id:'source',path:a,fileName:'face.ttf',fileSize:8,modifiedAt:1,systemInstallMatches:[]}
  const record={source:'HKCU',path:b,fileName:'face.ttf',registryName:'Face',value:b}
  let result=await plan(item,[record],[record],['C:\\user-fonts'],()=>false)
  assert.equal(result.length,2);assert.equal(result[0].records[0].name,'Face');assert.equal(result[1].delete_file,true)
  assert.equal(result[0].preflight_file,true,'copy attributes must be checked before registry effects')
  assert(result.every(p=>p.allow_readonly_copy),'separate current-user copy was not authorized')
  const selected=await plan({...item,path:b},[record],[record],['C:\\user-fonts'],()=>false)
  assert(selected.every(p=>!p.allow_readonly_copy&&!p.delete_file&&!p.preflight_file),'selected original file or its attributes were changed')
  const system=await plan(item,[record],[record],['C:\\another-user','C:\\user-fonts'],()=>false)
  assert(system.every(p=>!p.allow_readonly_copy),'system directory must not clear readonly')
  contents.set(b,different)
  const candidate=compare.compareFontInstalledWithList(item,[record])
  assert.equal(candidate.known,false,'name hits granted an authoritative verdict')
  let confirmed=await evidence.createFontInstallEvidenceSession().confirm(item,candidate)
  assert.equal(confirmed.installed,false);assert.equal(confirmed.known,true);assert.match(confirmed.reason,/content-mismatch=1/)
  assert.equal((await plan(item,[record],[record],['C:\\user-fonts'],()=>false)).length,0,'same name authorized different bytes')
  contents.set(b,bytes)
  const session=evidence.createFontInstallEvidenceSession();readCounts.clear()
  for(let i=0;i<20;i++)assert.equal((await session.confirm(item,compare.compareFontInstalledWithList(item,[record]))).installed,true)
  assert.deepEqual([...readCounts.values()],[1,1],'one operation rehashed duplicate source/candidate paths')
  assert.equal((await evidence.createFontInstallEvidenceSession().confirm(item,compare.compareFontInstalledWithList(item,[record]))).by,'user','permanent app copy was classified as temporary activation')
  const activePath='C:\\user-fonts\\HFM_ACTIVE_source.ttf';contents.set(activePath,bytes);stats.set(activePath,8)
  const activeRecord={source:'HKCU',path:activePath,value:activePath,fileName:'HFM_ACTIVE_source.ttf',registryName:'Face [owned-session]'}
  const owned={fontId:item.id,sourcePath:a,installPath:activePath,registryName:activeRecord.registryName,fileName:activeRecord.fileName}
  assert.equal(compare.compareFontInstalledWithList(item,[activeRecord]).matches.length,0)
  const writes=[]
  const refresh=load('src/main/install/refresh/installStatusCompareRuntime.ts').createInstallStatusCompareRuntime({getSystemInstalledFontsCached:async()=>[activeRecord],readTemporaryActiveFonts:async()=>({records:[owned]}),buildInstalledFontLookupIndex:compare.buildInstalledFontLookupIndex,compareFontInstalledWithLookupIndex:compare.compareFontInstalledWithLookupIndex,saveInstallStatusIndex:async results=>writes.push(plain(results)),delayToEventLoop:async()=>{},appName:'HFM'})
  const refreshed=await refresh.compareFontsInstalled([item],{force:true})
  assert.equal(refreshed[item.id].by,'managed');assert.equal(refreshed[item.id].installed,true);assert.equal(writes[0][item.id].known,true,'forced comparison erased the owned temporary installation')
  const foreign=await evidence.createFontInstallEvidenceSession({installed:[activeRecord],temporaryRecords:[{...owned,registryName:'another-session'}]}).confirm(item,compare.compareFontInstalledWithList(item,[activeRecord]))
  assert.equal(foreign.installed,false,'unconfirmed temporary ownership granted active state')
  await assert.rejects(plan(item,[record,{...record,path:other,value:other}],[],['C:\\user-fonts'],()=>false),/多个内容相同/)
  result=await plan({...item,path:other},[{...record,path:other,value:other}],[{...record,path:other,value:other}],['C:\\user-fonts'],()=>false)
  assert(result.every(p=>!p.delete_file),'prefix sibling escaped path boundary')
  const renamed='C:\\user-fonts\\different.ttf';contents.set(renamed,bytes);stats.set(renamed,4)
  const renamedRecord={...record,path:renamed,value:renamed,fileName:'different.ttf'}
  result=await plan(item,[renamedRecord],[renamedRecord],['C:\\user-fonts'],()=>false)
  assert.equal(result.length,2,'main-owned names did not discover a renamed content-confirmed installation')
  contents.set(renamed,different)
  assert.equal((await plan(item,[renamedRecord],[renamedRecord],['C:\\user-fonts'],()=>false)).length,0,'renamed same-name candidate granted different content')
  const unrelated={...renamedRecord,registryName:'Unrelated'}
  assert.equal((await plan({...item,systemInstallMatches:[unrelated]},[unrelated],[unrelated],['C:\\user-fonts'],()=>false)).length,0,'renderer hints became candidate authority')
  stats.set(b,stats.get(a))
  result=await plan(item,[record],[record],['C:\\user-fonts'],()=>false)
  assert(result.every(p=>!p.delete_file&&!p.allow_readonly_copy&&!p.preflight_file),'hard link granted file or readonly mutation')
  const numericStat=io.stat
  io.stat=async p=>{const s=await numericStat(p);return p===b?{...s,dev:String(s.dev),ino:String(s.ino)}:s}
  result=await plan(item,[record],[record],['C:\\user-fonts'],()=>false)
  assert(result.every(p=>!p.delete_file&&!p.allow_readonly_copy),'mixed native string/local numeric IDs granted hard-link mutation')
  stats.set(b,2)
  result=await plan(item,[record],[record],['C:\\user-fonts'],()=>false)
  assert(result.some(p=>p.delete_file),'native decimal IDs rejected an independent content-confirmed copy')
  io.stat=numericStat
  stats.set(b,2);aliases.set(b,a)
  result=await plan(item,[record],[record],['C:\\user-fonts'],()=>false)
  assert(result.every(p=>!p.delete_file&&!p.allow_readonly_copy),'physical path alias granted source deletion')
  aliases.clear()
  await assert.rejects(plan({...item,path:b},[record],[{...record,registryName:'temporary'}],['C:\\user-fonts'],r=>r.registryName==='temporary'),/临时激活/)
  failures.set(b,Object.assign(Error('access denied'),{code:'EACCES'}))
  confirmed=await evidence.createFontInstallEvidenceSession().confirm(item,compare.compareFontInstalledWithList(item,[record]))
  assert.equal(confirmed.known,false);assert.equal(confirmed.installed,false)
  await assert.rejects(plan(item,[record],[record],['C:\\user-fonts'],()=>false),/当前不可访问/)
  failures.clear()
  const source=await load('src/main/fonts/fontContentIdentityRuntime.ts').readFontContentIdentity(a)
  const stamp=JSON.parse(source.stamp)
  const historical={...item,recoveryContentHash:source.sha256,recoveryFileStamp:JSON.stringify([String(stamp[0]),String(stamp[1]),...stamp.slice(2)])}
  contents.delete(a)
  const missingItem={...item,fileAvailability:'missing',recoveryContentHash:'0'.repeat(64),systemInstalled:true}
  confirmed=await evidence.createFontInstallEvidenceSession({readHistorical:async()=>historical}).confirm(missingItem,compare.compareFontInstalledWithList(missingItem,[record]))
  assert.equal(confirmed.known,true);assert.equal(confirmed.installed,true);assert.match(confirmed.reason,/source=main-history/)
  const historicalSource=await evidence.readInstallSourceIdentity(missingItem,async()=>historical)
  assert.equal(historicalSource.dev,1);assert.equal(historicalSource.ino,1,'native historical file IDs were not normalized')
  const reports=[]
  result=await plan(missingItem,[record],[record],['C:\\user-fonts'],()=>false,{source:historicalSource,report:x=>reports.push(plain(x))})
  assert.equal(result.length,2);assert.equal(reports[0].sourceKind,'main-history');assert.equal(reports[0].confirmed[0].independentCopy,true)
  await assert.rejects(evidence.readInstallSourceIdentity(missingItem,async()=>undefined),/历史完整内容指纹/)
  await assert.rejects(evidence.readInstallSourceIdentity(missingItem,async()=>({...historical,id:'foreign'})),/历史完整内容指纹/)
  failures.set(a,Object.assign(Error('source denied'),{code:'EACCES'}))
  await assert.rejects(evidence.readInstallSourceIdentity(missingItem,async()=>historical),/source denied/)
  failures.clear()
  const stat=io.stat;io.stat=async p=>{if(p==='C:\\')throw Object.assign(Error('drive offline'),{code:'ENETUNREACH'});return stat(p)}
  await assert.rejects(evidence.readInstallSourceIdentity(missingItem,async()=>historical),/drive offline/)
  io.stat=stat
  io.stat=async p=>{const s=await stat(p);return p===b?{...s,dev:String(s.dev),ino:String(s.ino)}:s}
  const effects=[];let liveRegistry=[record],changed=false,targetChanged=false
  const receiptDb=database()
  const runtime=load('src/main/install/systemFontInstallRuntime.ts').createSystemFontInstallRuntime({
    openUninstallReceipts:async()=>load('src/main/install/fontUninstallReceiptRuntime.ts').openFontUninstallReceipts(receiptDb),readUninstallActivationClaims:async()=>[],
    readHistoricalFont:async()=>historical,ensureWindows(){},withFontProtection:async(_items,fn)=>fn(async()=>{}),
    currentUserFontsDir:()=> 'C:\\user-fonts',windowsFontsDir:()=> 'C:\\Windows\\Fonts',normalizePathForCacheCompare:p=>p.toLowerCase(),isTemporaryActiveInstalledRecord:()=>false,
    getSystemInstalledFonts:async()=>liveRegistry,readUninstallRegistry:async()=>liveRegistry,clearInstalledFontsMemoryCache(){},appendStartupLog(){},persistUninstallResult:async()=>effects.push('persist'),advancedFontRefresh:async()=>{},
    createMutationSession:async()=>({close(){},execute:async(p,check)=>{if(changed)contents.set(a,different);if(targetChanged)stats.set(b,historicalSource.ino);await check();effects.push(p.delete_file?'file':'registry');if(p.records.length)liveRegistry=[];if(p.delete_file)contents.delete(p.path);return {ok:true,message:'controlled',completedSteps:1,fileRemoved:p.delete_file}}}),
  })
  assert.equal((await runtime.uninstallFontSystemWide(missingItem)).ok,true,'trusted missing source could not execute its exact plan')
  assert.deepEqual(effects,['registry','file','persist']);assert.equal(contents.has(a),false,'uninstall recreated missing source')
  liveRegistry=[record];contents.set(b,bytes);effects.length=0;changed=true
  const stopped=await runtime.uninstallFontSystemWide(missingItem)
  assert.equal(stopped.ok,false);assert.equal(stopped.uninstall.completedSteps,0);assert.deepEqual(effects,[],'reappeared/replaced source crossed effect gate')
  contents.delete(a);assert.equal(contents.get(b).equals(bytes),true)
  changed=false;targetChanged=true;effects.length=0
  const replaced=await runtime.uninstallFontSystemWide(missingItem)
  assert.equal(replaced.ok,false);assert.equal(replaced.uninstall.completedSteps,0);assert.deepEqual(effects,[],'same-content target replacement crossed the physical identity gate')
  io.stat=stat
  receiptDb.close()
  await uninstallTransport()
  await require('./check-font-uninstall-recovery.cjs').run()
  console.log('[F10] whole-content status/planning, renamed candidates, unknown access, historical missing source, effect gates, distinct copies, aliases/hard links and original preservation passed')
}

async function uninstallTransport() {
  const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),crypto=require('node:crypto')
  const worker='C:\\hfm\\worker.exe',target='C:\\user-fonts\\中文.ttf',bytes=Buffer.from('controlled worker')
  const hash=crypto.createHash('sha256').update(bytes).digest('hex'),logs=[],queries=[],replies=[],sent=[]
  let queryError=null,queryValue={ok:true,target,processes:[{pid:123,name:'字体程序',service:'',started:'000001'}]}
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough()
  child.kill=()=>{child.stdout.end();child.stderr.end();return true}
  child.stdin.on('data',data=>{sent.push(JSON.parse(String(data)));for(const reply of replies.shift())child.stdout.write(JSON.stringify(reply)+'\n')})
  const load=loader({
    electron:{app:{isPackaged:false}},
    'node:fs':{promises:{readFile:async file=>file.endsWith('.sha256')?hash:bytes}},
    'node:child_process':{
      spawn:()=>{setImmediate(()=>child.stdout.write('{"protocol":"font-mutation-v1"}\n'));return child},
      execFile:(file,args,options,done)=>{queries.push({file,args,options});done(queryError,JSON.stringify(queryValue));return {}},
    },
    [path.join(root,'src/main/rust-core/rustCoreWorkerPathRuntime.ts')]:{resolveRustCoreWorkerPath:()=>worker},
    [path.join(root,'src/main/security/appIntegrityRuntime.ts')]:{verifyPackagedAppIntegrity:()=>({ok:true})},
  })
  const usage=load('src/main/install/fontFileUsageRuntime.ts')
  assert.throws(()=>usage.parseFontFileUsage(JSON.stringify({...queryValue,target:'C:\\other.ttf'}),target),/目标不一致/)
  assert.throws(()=>usage.parseFontFileUsage(JSON.stringify({...queryValue,processes:[{pid:-1}]}),target),/编号无效/)
  assert.equal(usage.parseFontFileUsage(JSON.stringify({...queryValue,processes:[]}),target).status,'unidentified','empty result claimed no occupancy')
  const session=await load('src/main/install/fontMutationProcessRuntime.ts').createFontMutationSession(message=>logs.push(message))
  const request={path:target,sha256:hash,delete_file:true,records:[]}
  try {
    replies.push([{brokerDone:true,ok:false,code:5,message:'permission denied',stage:'open-font'}])
    let result=await session.execute(request,async()=>{})
    assert.equal(result.ok,false);assert.equal(queries.length,0,'permission refusal was mislabeled as occupancy')
    replies.push([{brokerDone:true,ok:false,code:32,message:'sharing violation',stage:'open-font'}])
    result=await session.execute(request,async()=>{})
    assert.equal(result.ok,false);assert.equal(result.code,32);assert.match(result.message,/字体程序.*PID 123/)
    assert.deepEqual(plain(queries[0].args),['--font-file-usage',target]);assert.equal(queries[0].options.timeout,3000)
    assert.equal(queries[0].file,worker);assert.equal(queries[0].options.env.HFM_PARENT_PID,String(process.pid))
    replies.push([{effect:'registry'},{done:true,ok:false,code:5,message:'cannot delete',stage:'file-disposition',ntstatus:0xc0000121},{brokerDone:true,ok:true,stage:'open-font'}])
    result=await session.execute(request,async()=>{})
    assert.equal(result.completedSteps,1);assert.equal(result.fileRemoved,false);assert.equal(result.ntstatus,0xc0000121)
    assert.equal(result.stage,'file-disposition');assert.equal(queries.length,2);assert.match(result.message,/C0000121/)
    queryError=Error('query timeout')
    replies.push([{brokerDone:true,ok:false,code:32,message:'sharing violation',stage:'open-font'}])
    result=await session.execute(request,async()=>{})
    assert.equal(result.code,32);assert.equal(result.usage.status,'unavailable');assert.equal(result.ok,false)
    assert.match(result.message,/sharing violation/);assert.match(result.message,/查询未完成/)
    replies.push([{effect:'file'},{brokerDone:true,ok:true}])
    result=await session.execute(request,async()=>{})
    assert.equal(result.ok,true);assert.equal(result.fileRemoved,true);assert.equal(queries.length,3,'successful deletion ran unnecessary diagnostics')
    assert(logs.some(line=>line.includes('font file usage:')&&line.includes('123')))
    const before=sent.length
    result=await session.execute(request,async()=>{throw Error('initial protection refused')})
    assert.equal(result.ok,false);assert.equal(sent.length,before,'initial refusal reached the worker')
    for(const stage of ['attributes','before-uac','registry','file']) {
      let checks=0
      replies.push([{gate:stage,references:[]}],[{brokerDone:true,ok:false,message:'gate refused'}])
      result=await session.execute(request,async()=>{if(++checks===2)throw Error('protection changed at '+stage)})
      assert.equal(checks,2);assert.equal(result.ok,false);assert.equal(result.completedSteps,0)
      assert.deepEqual(sent.at(-1),{allow:false},stage+' refusal was not sent to worker')
      assert(result.message.includes('protection changed at '+stage))
    }
    replies.push([{gate:'registry',references:[]}],[{brokerDone:true,ok:false,uncertain:true,stage:'elevated-transport',message:'child disconnected after allow'}])
    const stages=[]
    result=await session.execute(request,async(_references,stage)=>{stages.push(stage)})
    assert.equal(result.uncertain,true,'broker transport failure lost uncertainty');assert.equal(result.ok,false);assert(stages.includes('registry'))
    assert.deepEqual(sent.at(-1),{allow:true})
    const cancelStart=sent.length
    replies.push([{done:true,ok:false,code:1223,message:'cancelled'},{brokerDone:true,ok:true}])
    result=await session.execute(request,async()=>{})
    assert.equal(result.ok,false);assert.equal(result.code,1223);assert.equal(result.completedSteps,0);assert.equal(result.cancelled,true)
    assert.equal(sent.length,cancelStart+1,'UAC cancellation replayed the request')
    replies.push([{effect:'registry'},{gate:'file',references:[]}],[{brokerDone:true,ok:false,message:'gate refused'}])
    let checks=0
    result=await session.execute(request,async()=>{if(++checks===2)throw Error('protected after registry removal')})
    assert.equal(result.ok,false);assert.equal(result.completedSteps,1);assert.equal(result.fileRemoved,false)
    assert.deepEqual(sent.at(-1),{allow:false});assert.equal(queries.length,3,'protection/UAC refusal triggered occupancy query')

  } finally {session.close()}
}

async function uninstallNative() {
  assert.equal(process.platform,'win32','F06 native acceptance requires Windows')
  assert(process.argv.includes('--local'),'Real font mutation is local-only; use npm run test:font-system-local')
  assert(!process.env.CI && !process.env.GITHUB_ACTIONS,'Real font mutation must not run in CI')
  const crypto=require('node:crypto')
  const run={runId:process.env.HFM_NATIVE_ACCEPTANCE_RUN_ID||crypto.randomUUID(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),worktreeDirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),startedAt:new Date().toISOString(),scenarios:[]}
  // Each scenario owns a fresh UUID fixture and broker. A combined-contract
  // failure must not prevent evidence from the production-shaped split control.
  for(const scenario of ['combined','split']) {
    const evidenceFile=path.join(root,'artifacts/font-identity-f06',`native-${scenario}-evidence.json`)
    try {await uninstallNativeScenario(scenario,run);run.scenarios.push({scenario,ok:true,evidenceFile})}
    catch(error) {
      run.scenarios.push({scenario,ok:false,errorName:error?.name,errorCode:error?.code,errorSummary:String(error?.message||error).slice(0,512),evidenceFile})
      console.error(`[F06 native ${scenario}] failed; full primary assertion and receipt: ${evidenceFile}`)
    }
  }
  run.finishedAt=new Date().toISOString()
  const dir=path.join(root,'artifacts/font-identity-f06');fs.mkdirSync(dir,{recursive:true})
  fs.writeFileSync(path.join(dir,'native-scenarios.json'),JSON.stringify(run,null,2))
  const failed=run.scenarios.filter(scenario=>!scenario.ok)
  assert.equal(failed.length,0,`Native acceptance remains failed: ${failed.map(value=>value.scenario).join(', ')}. See native-scenarios.json and the per-scenario evidence; later probes never turn a failed assertion into a pass.`)
}

async function uninstallNativeScenario(scenario,run) {
  assert.equal(process.platform,'win32','F06 native acceptance requires Windows')
  assert(process.argv.includes('--local'),'Real font mutation is local-only; use npm run test:font-system-local')
  assert(!process.env.CI && !process.env.GITHUB_ACTIONS,'Real font mutation must not run in CI')
  const {spawn}=require('node:child_process'),{createInterface}=require('node:readline'),crypto=require('node:crypto')
  const worker=path.join(root,'build/native/hfm-core-worker.exe')
  const manifest=file=>{const stat=fs.statSync(file);return {path:file,size:stat.size,mtimeMs:stat.mtimeMs,birthtimeMs:stat.birthtimeMs,mode:stat.mode,dev:stat.dev,ino:stat.ino,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}}
  const started=process.hrtime.bigint(),timeline=[]
  const mark=(phase,extra={})=>{const value={phase,at:new Date().toISOString(),elapsedMs:Number(process.hrtime.bigint()-started)/1e6,...extra};timeline.push(value);return value}
  const evidence={schemaVersion:2,runId:run.runId,commit:run.commit,worktreeDirty:run.worktreeDirty,scenario,startedAt:new Date().toISOString(),worker:{path:worker,sha256:crypto.createHash('sha256').update(fs.readFileSync(worker)).digest('hex')},failure:null,stderr:'',receipt:null,usage:null,probe:null,timeline,cleanup:null}
  const evidenceDir=path.join(root,'artifacts/font-identity-f06')
  const evidenceFile=path.join(evidenceDir,`native-${scenario}-evidence.json`)
  const failureFile=path.join(evidenceDir,scenario==='combined'?'disposition-failure.json':'split-disposition-failure.json')
  const saveEvidence=()=>{fs.mkdirSync(evidenceDir,{recursive:true});const serialized=JSON.stringify(evidence,null,2);fs.writeFileSync(evidenceFile,serialized);if(evidence.failure)fs.writeFileSync(failureFile,serialized)}
  const userRoot=path.join(process.env.LOCALAPPDATA,'Microsoft/Windows/Fonts')
  fs.mkdirSync(userRoot,{recursive:true})
  const token='HFM_F06_TEST_'+crypto.randomUUID()+'_中文',target=path.join(userRoot,token+'.ttf')
  const original=path.join(process.env.WINDIR,'Fonts/arial.ttf')
  evidence.originalBefore=manifest(original)
  evidence.fixture={token,target}
  const regRoot='HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
  const reg=(args)=>execFileSync('reg',args,{encoding:'utf8',windowsHide:true})
  // Create a writable fixture from bytes, without inheriting system-file
  // attributes. Read-only behavior is exercised explicitly below.
  let fixtureCreated=false,metadataCreated=false,primaryFailure=false
  const metadataToken=token+'_metadata'
  const make=()=>{fs.writeFileSync(target,fs.readFileSync(original),{flag:'wx'});fixtureCreated=true;assert.equal(fs.statSync(target).mode & 0o200,0o200);reg(['add',regRoot,'/v',token,'/t','REG_SZ','/d',target,'/f']);evidence.fixture.created=manifest(target);mark('fixture-created')}
  const verifyCleanup=()=>{
    const result={targetAbsent:false,registryReadable:false,fixtureRegistrationAndMetadataAbsent:false,originalUnchanged:false,errors:[]}
    try{fs.statSync(target)}catch(error){if(error.code==='ENOENT')result.targetAbsent=true;else result.errors.push(`target verification: ${error.message}`)}
    // A failed query of one value does not prove absence: require a successful
    // root read, then search the UUID's ASCII stem in both supported byte forms.
    const query=spawnSync('reg',['query',regRoot],{windowsHide:true,timeout:5000,maxBuffer:4*1024*1024})
    result.registryReadable=query.status===0&&!query.error
    if(result.registryReadable){const stem=token.slice(0,-'中文'.length);result.fixtureRegistrationAndMetadataAbsent=!query.stdout.includes(Buffer.from(stem))&&!query.stdout.includes(Buffer.from(stem,'utf16le'))}
    else result.errors.push(`registry verification: exit=${query.status}, error=${query.error?.message||'none'}`)
    try{evidence.originalAfter=manifest(original);result.originalUnchanged=JSON.stringify(evidence.originalAfter)===JSON.stringify(evidence.originalBefore)}catch(error){result.errors.push(`original verification: ${error.message}`)}
    result.ok=result.targetAbsent&&result.registryReadable&&result.fixtureRegistrationAndMetadataAbsent&&result.originalUnchanged&&result.errors.length===0
    return result
  }
  const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  const child=spawn(worker,['--font-mutation-broker'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,HFM_PARENT_PID:String(process.pid)}})
  const brokerClosed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({observed:true,code,signal})))
  evidence.worker.pid=child.pid;mark('broker-started',{pid:child.pid})
  const line=createInterface({input:child.stdout}),queue=[],wait=[];let failure,stderr='',lastReceipt=null
  child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b)})
  child.on('error',e=>{failure=e;for(const w of wait.splice(0))w.reject(e)})
  child.on('exit',code=>{failure=Error(`broker exit ${code}: ${stderr}`);for(const w of wait.splice(0))w.reject(failure)})
  line.on('line',s=>{const value=JSON.parse(s),w=wait.shift();if(w)w.resolve(value);else queue.push(value)})
  const next=()=>queue.length?Promise.resolve(queue.shift()):failure?Promise.reject(failure):new Promise((resolve,reject)=>wait.push({resolve,reject}))
  const timeout=setTimeout(()=>child.kill(),45000)
  async function command(plan,onGate=()=>true) {
    mark('command-start',{deleteFile:plan.delete_file,records:plan.records.length})
    child.stdin.write(JSON.stringify(plan)+'\n');const effects=[],gates=[],events=[];let done
    for(;;){const r=await next();events.push(r);if(r.gate){mark('gate',{stage:r.gate});const allow=await onGate(r.gate,r);gates.push({stage:r.gate,allow});child.stdin.write(JSON.stringify({allow})+'\n')}if(r.effect)effects.push(r);if(r.done)done=r;if(r.brokerDone){lastReceipt={...r,effects,gates,events,elevated:done};mark('command-finished',{ok:r.ok,stage:r.stage,code:r.code,ntstatus:r.ntstatus,effects:effects.map(effect=>effect.effect)});return lastReceipt}}
  }
  try {
    assert.equal((await next()).protocol,'font-mutation-v1')
    // Establish registry readability before creating any real font fixture.
    child.stdin.write('{"snapshot":true}\n');const initialSnapshot=await next();assert.equal(initialSnapshot.ok,true,JSON.stringify(initialSnapshot))
    reg(['add',regRoot,'/v',metadataToken,'/t','REG_DWORD','/d','1','/f']);metadataCreated=true
    make()
    child.stdin.write('{"snapshot":true}\n');const snapshot=await next();assert.equal(snapshot.ok,true,JSON.stringify(snapshot));assert(snapshot.records.some(r=>r.registryName===token&&r.path===target),'native registry snapshot corrupted Unicode')
    assert(!snapshot.records.some(r=>r.registryName===metadataToken),'numeric metadata became a font reference')
    assert.match(reg(['query',regRoot,'/v',metadataToken]),/REG_DWORD/,'snapshot altered metadata')
    const discovered=JSON.parse(execFileSync(worker,['--system-installed-fonts','--windows-fonts-dir',path.join(process.env.WINDIR,'Fonts'),'--current-user-fonts-dir',userRoot,'--extensions','ttf,otf,ttc,otc'],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:32*1024*1024}))
    assert.equal(discovered.ok,true,JSON.stringify(discovered))
    assert(discovered.items.some(r=>r.registryName===token&&r.value===target&&r.path===target),'installed-font reader corrupted Unicode registry data')
    assert(!discovered.items.some(r=>r.registryName===metadataToken),'installed-font reader included numeric metadata')
    let plan={path:target,sha256:digest(),delete_file:true,records:[{scope:'HKCU',name:token,value:target}]}
    if(scenario==='split') {
      let before=manifest(target)
      const sameTarget=()=>assert.deepEqual(manifest(target),before,'split target identity/content changed')
      const noReferences=reply=>assert(!reply.references.some(record=>record.path?.toLowerCase()===target.toLowerCase()),'split file step still has a registered reference')
      const registry=await command({...plan,delete_file:false,preflight_file:true,allow_readonly_copy:true},()=>{sameTarget();return true})
      assert.equal(registry.ok,true,JSON.stringify(registry));assert.deepEqual(registry.effects.map(effect=>effect.effect),['registry'])
      assert(fs.existsSync(target),'registry-only split step removed its file')
      sameTarget();assert.throws(()=>reg(['query',regRoot,'/v',token]))
      assert(registry.events.some(event=>event.notification==='registry-change'),'split registry removal did not notify')
      // First collect the direct production-shaped registry -> file sequence.
      // Do not insert a refused gate, deliberate wait or probe before this case.
      let filePlan={...plan,records:[],allow_readonly_copy:true}
      let file=await command(filePlan,(_stage,reply)=>{sameTarget();noReferences(reply);return true})
      assert.equal(file.ok,true,JSON.stringify(file));assert.deepEqual(file.effects.map(effect=>effect.effect),['file'])
      assert(!fs.existsSync(target),'split file step did not remove the target')
      // A fresh fixture also covers refusing the separate file gate, retaining
      // that file, and retrying only the remaining step. No registration replay.
      make();before=manifest(target);plan={...plan,sha256:digest()}
      const retryRegistry=await command({...plan,delete_file:false,preflight_file:true,allow_readonly_copy:true},()=>{sameTarget();return true})
      assert.equal(retryRegistry.ok,true,JSON.stringify(retryRegistry));assert.deepEqual(retryRegistry.effects.map(effect=>effect.effect),['registry']);sameTarget()
      filePlan={...plan,records:[],allow_readonly_copy:true}
      file=await command(filePlan,(stage,reply)=>{sameTarget();noReferences(reply);return stage!=='file'})
      assert.equal(file.ok,false,JSON.stringify(file));assert.equal(file.effects.length,0);sameTarget()
      file=await command(filePlan,(_stage,reply)=>{sameTarget();noReferences(reply);return true})
      assert.equal(file.ok,true,JSON.stringify(file));assert.deepEqual(file.effects.map(effect=>effect.effect),['file'])
      assert(!fs.existsSync(target),'split remaining-file retry did not remove the target')
      assert.deepEqual(manifest(original),evidence.originalBefore,'split cleanup modified the original font')
      console.log('[F06 native split] separate registry/file plans, refused file gate and remaining-step retry passed; full application orchestration remains separately covered')
      return
    }
    let r=await command(plan,()=>false);assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert(fs.existsSync(target));assert.doesNotThrow(()=>reg(['query',regRoot,'/v',token]))
    r=await command({...plan,sha256:'0'.repeat(64)});assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert(fs.existsSync(target))
    r=await command(plan,stage=>{if(stage==='registry')reg(['add',regRoot,'/v',token,'/t','REG_SZ','/d',original,'/f']);return true})
    assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert(fs.existsSync(target));assert(reg(['query',regRoot,'/v',token]).includes('arial.ttf'))
    reg(['add',regRoot,'/v',token,'/t','REG_SZ','/d',target,'/f'])
    r=await command(plan,stage=>{if(stage==='registry')reg(['add',regRoot,'/v',token,'/t','REG_DWORD','/d','1','/f']);return true})
    assert.equal(r.ok,false);assert.equal(r.effects.length,0,'changed numeric target was deleted');assert(fs.existsSync(target));assert.match(reg(['query',regRoot,'/v',token]),/REG_DWORD/)
    reg(['add',regRoot,'/v',token,'/t','REG_SZ','/d',target,'/f'])
    fs.chmodSync(target,0o444)
    r=await command(plan);assert.equal(r.ok,false);assert.match(r.message,/read-only/);assert.equal(r.effects.length,0,'read-only preflight removed an installation record');assert(fs.existsSync(target));assert.doesNotThrow(()=>reg(['query',regRoot,'/v',token]))
    const readonlyRegistry={...plan,delete_file:false,preflight_file:true}
    r=await command(readonlyRegistry);assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert.doesNotThrow(()=>reg(['query',regRoot,'/v',token]))
    r=await command({...readonlyRegistry,allow_readonly_copy:true},stage=>stage!=='attributes')
    assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert.equal(fs.statSync(target).mode&0o200,0,'denied attribute gate changed readonly')
    fs.chmodSync(target,0o666)
    r=await command(plan);assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.effects.map(e=>e.effect),['registry','file']);assert(!fs.existsSync(target));assert.throws(()=>reg(['query',regRoot,'/v',token]));assert(fs.existsSync(original),'test touched the original system font')
    const notified=r.events.findIndex(event=>event.notification==='registry-change')
    assert(notified>r.events.findIndex(event=>event.effect==='registry')&&notified<r.events.findIndex(event=>event.gate==='file'),'registry notification did not precede file cleanup')
    make();plan={...plan,sha256:digest()}
    fs.chmodSync(target,0o444)
    r=await command({...plan,delete_file:false,preflight_file:true,allow_readonly_copy:true})
    assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.effects.map(e=>e.effect),['registry'])
    assert(fs.existsSync(target));assert(fs.statSync(target).mode&0o200,'verified installation copy is still readonly')
    assert(r.events.findIndex(e=>e.gate==='attributes')<r.events.findIndex(e=>e.effect==='registry'),'readonly normalization came after registry deletion')
    fs.chmodSync(target,0o444) // Also cover an already orphaned readonly installation copy.
    r=await command({...plan,records:[],allow_readonly_copy:true})
    assert.equal(r.ok,true,JSON.stringify(r));assert(!fs.existsSync(target));assert(fs.existsSync(original))
    make();plan={...plan,sha256:digest()}
    r=await command({...plan,path:path.join(require('node:os').tmpdir(),token+'.ttf')});assert.equal(r.ok,false);assert.equal(r.effects.length,0)
    r=await command({...plan,records:[{scope:'HKCU',name:token,value:original}]});assert.equal(r.ok,false);assert.equal(r.effects.length,0);assert(fs.existsSync(target))
    r=await command(plan,stage=>stage!=='file');assert.equal(r.ok,false);assert.deepEqual(r.effects.map(e=>e.effect),['registry']);assert(fs.existsSync(target),'partial failure lost the remaining file')
    assert(r.events.some(event=>event.notification==='registry-change'),'partial completion did not notify registry removal')
    let fileGates=0
    r=await command({...plan,records:[]},stage=>stage!=='file'||++fileGates<2);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.effects.length,0,'protection change during resource release reached deletion');assert.equal(fileGates,2);assert(fs.existsSync(target))
    r=await command({...plan,records:[]});assert.equal(r.ok,true,JSON.stringify({scenario:'remaining-file-retry',receipt:r,targetExists:fs.existsSync(target),targetMode:fs.existsSync(target)?fs.statSync(target).mode:null,stderr}));assert.deepEqual(r.effects.map(e=>e.effect),['file'],'remaining-step retry must perform exactly one file effect');assert(!fs.existsSync(target),'remaining-step retry failed')
    const invalid=spawnSync(worker,['--font-mutation-elevated','bad-pipe','1'],{encoding:'utf8',timeout:5000,windowsHide:true});assert.notEqual(invalid.status,0,'unauthenticated elevated endpoint accepted')
    assert.match(reg(['query',regRoot,'/v',metadataToken]),/REG_DWORD/,'uninstall removed unrelated metadata')
    console.log('[F06 native] original-user HKCU/file effects, denial, content mismatch, changed registry, boundary refusal, partial completion and remaining-step retry passed; real UAC/HKLM/UNC remain manual acceptance')
  } catch(error) {
    // Snapshot the primary failure BEFORE diagnostics or cleanup. Never replace
    // its receipt or verdict with a later successful probe/control scenario.
    primaryFailure=true
    evidence.failure=String(error);evidence.stderr=stderr;evidence.receipt=lastReceipt?plain(lastReceipt):null
    evidence.primaryFailedAt=new Date().toISOString();mark('primary-failed')
    try{saveEvidence()}catch(writeError){console.error('[F06 evidence write failed]',writeError)}
    try {
      if(lastReceipt?.code===32 || lastReceipt?.ntstatus===0xc0000121) {
        mark('usage-start')
        evidence.usage=await loader()('src/main/install/fontFileUsageRuntime.ts').readFontFileUsage(worker,target)
        mark('usage-finished',{status:evidence.usage.status})
        console.error('[F06 file usage]',JSON.stringify(evidence.usage))
      }
      if(lastReceipt?.ok===false && lastReceipt.code===5 && lastReceipt.gates.some(gate=>gate.stage==='file'&&gate.allow) && fs.existsSync(target)) {
        mark('probe-start');evidence.probeBefore=manifest(target)
        const probe=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'lib/font-disposition-probe.ps1')],{encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,HFM_DISPOSITION_FIXTURE:target,HFM_DISPOSITION_SHA256:digest()}})
        evidence.probe={status:probe.status,stdout:probe.stdout,stderr:probe.stderr,error:probe.error?.message}
        mark('probe-finished',{status:probe.status})
        console.error('[F06 disposition probe]',JSON.stringify(evidence.probe))
      }
    } catch(probeError) {evidence.diagnosticError=String(probeError);console.error('[F06 disposition probe failed]',probeError)}
    throw error
  } finally {
    mark('cleanup-start');clearTimeout(timeout);child.kill();line.close()
    let closeTimer
    try{evidence.brokerClose=await Promise.race([brokerClosed,new Promise(resolve=>{closeTimer=setTimeout(()=>resolve({observed:false,error:'broker close was not observed within 3000 ms'}),3000)})])}
    finally{clearTimeout(closeTimer)}
    // Keep the primary snapshot intact, but include drained diagnostic output.
    evidence.stderrFinal=stderr
    const cleanupErrors=[]
    if(!evidence.brokerClose.observed)cleanupErrors.push(evidence.brokerClose.error)
    if(metadataCreated) {try{reg(['delete',regRoot,'/v',metadataToken,'/f'])}catch(error){cleanupErrors.push(`metadata cleanup: ${error.message}`);console.error('[F06 metadata cleanup failed]',error)}}
    if(fixtureCreated) {
      try{reg(['delete',regRoot,'/v',token,'/f'])}catch{}
      try{fs.chmodSync(target,0o666);fs.unlinkSync(target)}catch(error){if(error.code!=='ENOENT'){cleanupErrors.push(`fixture cleanup: ${error.message}`);console.error('[F06 fixture cleanup failed]',error)}}
    }
    evidence.cleanup=verifyCleanup();evidence.cleanup.errors.push(...cleanupErrors)
    evidence.cleanup.ok&&=cleanupErrors.length===0
    evidence.finishedAt=new Date().toISOString();mark('cleanup-finished',{ok:evidence.cleanup.ok})
    if(!primaryFailure){evidence.stderr=stderr;evidence.receipt=lastReceipt?plain(lastReceipt):null}
    try{saveEvidence()}catch(writeError){console.error('[F06 evidence write failed]',writeError);if(!primaryFailure)throw writeError}
    // A cleanup failure cannot mask an earlier assertion or make a passing case green.
    if(!primaryFailure)assert.equal(evidence.cleanup.ok,true,JSON.stringify(evidence.cleanup))
  }
}
