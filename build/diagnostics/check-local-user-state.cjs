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
  console.log('[local-protection] explicit decisions, restart, path identity, shared precedence, cancellation and failed-write atomicity passed')
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
