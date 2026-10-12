'use strict'
// Production writer -> library -> committed locator -> merged projection, with real SQLite.
// The Node gate enables only the existing compatibility flag. Native caller supplies the real Rust client.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('../check-operation-chain.cjs')
const plain = value => JSON.parse(JSON.stringify(value))

async function runCommittedLocatorCases({ rustClient, transforms = {} } = {}) {
  assert.equal(process.platform, 'win32', 'shared metadata acceptance runs only on Windows')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-committed-locators-'))
  const roots = ['one', 'two'].map(name => path.join(dir, name))
  const normalize = value => path.resolve(value).replaceAll('\\', '/').toLowerCase()
  const sourceRoot = path.resolve(__dirname, '../../..')
  const load = loader({[path.join(sourceRoot,'src/main/path/startupPathAvailabilityRuntime.ts')]: {
    assertStartupPathRootGuardCurrent() {},
    ensureStartupPathRootAvailable: async root => roots.includes(root),
    getStartupPathRootState: root => Object.freeze({rootId:normalize(root),state:'online',generation:1}),
  }}, {}, transforms)
  const dbPathForRoot = load('src/main/indexing/shared-metadata/sharedMetadataPathsRuntime.ts').sharedMetadataDbPathForRoot
  const { initializeSharedMetadataDb } = load('src/main/indexing/shared-metadata/sharedMetadataDbRuntime.ts').createSharedMetadataDbRuntime({})
  const databases = new Map(), caches = new Map(), receipts = [], located = [], snapshots = [], reads = [], logs = []
  const merged = new DatabaseSync(':memory:')
  merged.exec(`CREATE TABLE entries(root_path TEXT, relative_path TEXT, source_id TEXT, tag_names_json TEXT, PRIMARY KEY(root_path,relative_path));
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE sources(root_path TEXT PRIMARY KEY,index_db_path TEXT,install_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT,synced_at TEXT);`)
  const projection = load('src/main/indexing/mergedIndexRuntime.ts').createMergedIndexRuntime({dataPath:(...parts)=>path.join(dir,...parts)})
  const sourceRevisions = new Map(roots.map(root=>[root,1])), resolvedSources = []
  const currentSource = root => ({root,indexDbPath:dbPathForRoot(root),indexSignature:'root-v3|fixture',installSignature:'none',sharedMetadataSignature:`metadata-v2|${sourceRevisions.get(root)}`})
  const getMeta = (_,key) => merged.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value || ''
  const setMeta = (_,key,value) => merged.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,value)
  for(const root of roots){const source=currentSource(root);merged.prepare('INSERT INTO sources VALUES(?,?,NULL,?,?,?,?)').run(root,source.indexDbPath,source.indexSignature,source.installSignature,source.sharedMetadataSignature,'before')}
  setMeta(null,'schemaVersion','7');setMeta(null,'sourcesKey',projection.mergedIndexSourcesKey(roots.map(currentSource)))
  let failRoot, unavailableRoot, failAfterCommit = false, catalogFailure = false, applyCalls = 0
  const oldFallback = process.env.HFM_NODE_STATE_FALLBACK
  const oldMigration = process.env.HFM_RUST_FULL_MIGRATION
  process.env.HFM_RUST_FULL_MIGRATION = '1'
  process.env.HFM_NODE_STATE_FALLBACK = rustClient ? '0' : '1'
  const baseFont = (root, relative, id) => ({ id, path:path.join(root,relative), fileName:path.basename(relative), tagNames:['base'], favorite:true, deleteProtected:true, fileSize:11, modifiedAt:12 })
  const existing = baseFont(roots[0], 'a.ttf', 'legacy-source')
  const second = baseFont(roots[1], 'b.ttf', 'legacy-source')
  const insertMetadata = (db, id, relative) => db.prepare(`INSERT INTO font_metadata
    (font_id,relative_path,path_key,tag_names_json,favorite,delete_protected,revision,updated_at,updated_by)
    VALUES(?,?,?,'["base","concurrent"]',1,1,1,'before','fixture')`).run(id,relative,relative)
  try {
    for (const [index, root] of roots.entries()) {
      fs.mkdirSync(path.dirname(dbPathForRoot(root)), {recursive:true})
      const db = new DatabaseSync(dbPathForRoot(root)); initializeSharedMetadataDb(db); databases.set(root, db)
      const font = index ? second : existing, relative = index ? 'b.ttf' : 'a.ttf'
      caches.set(root, {cache:{entries:{[relative]:{path:relative,status:'ok',font}}}})
      insertMetadata(db, font.id, relative)
      if (!index) for (let i=1;i<1499;i++) insertMetadata(db, 'filler-'+i, 'filler-'+i+'.ttf')
    }
    const writer = load('src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts').createSharedMetadataMutationRuntime({
      runtimeDeps: {
        uniqueResolvedFolders: values => [...new Set(values.map(value=>path.resolve(value)))],
        findBestWatchedRootForFile: (file, watched) => [...watched].sort((a,b)=>b.length-a.length).find(root=>normalize(file).startsWith(normalize(root)+'/')),
        loadExistingFolderCache: async root => caches.get(root),
        cacheKeyForRootFile: (root,file) => path.relative(root,file).replaceAll('\\','/'),
        cacheEntryRuntimePath: (root,relative) => path.resolve(root,relative), normalizePathForCacheCompare:normalize,
        appendStartupLog: message => {if(failAfterCommit && /wrote by rust|renamed by rust|removed by rust|path fallback/.test(message))throw Error('postcommit log unavailable');logs.push(message)},
        closeSqliteDb: () => {if(failAfterCommit)throw Error('postcommit close unavailable')},
        onSharedMetadataMutationStateSignal: () => {if(failAfterCommit)throw Error('postcommit signal unavailable')},
        ...(rustClient ? {
          runRustSharedMetadataApply: async input => {applyCalls++;return rustClient.runRustSharedMetadataApply(input)},
          runRustSharedMetadataRemoveTag: input => rustClient.runRustSharedMetadataRemoveTag(input),
          runRustSharedMetadataOverlayRead: input => rustClient.runRustSharedMetadataOverlayRead(input),
        } : {}),
      },
      ensureLegacyMetadataImported: async()=>{},
      withSharedMetadataWriteLock: async(_root,fn)=>fn(),
      openSharedMetadataDb: async root => databases.get(root),
      writeMeta: (db,key,value) => {if(key==='writerHost'&&db===databases.get(failRoot))throw Error('controlled metadata failure');db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,value)},
    })
    const sourceRuntime = {
      mergedIndexSourcesForRoots: async requested=>{resolvedSources.push([...requested]);assert(requested.length===1&&roots.includes(requested[0]),'committed projection resolved an unrelated source');return requested.map(currentSource)},
      relativePathsFromFontIndexPayload: (root,payload)=>payload.upserts.map(item=>path.relative(root,item.path).replaceAll('\\','/')),
      readMergedRowsForSource: async(source,relativePaths)=> {
        assert(relativePaths?.length, 'normal committed refresh must never read the whole source')
        reads.push({root:source.root,relativePaths:[...relativePaths]})
        return relativePaths.flatMap(relative=>databases.get(source.root).prepare('SELECT font_id,relative_path,tag_names_json FROM font_metadata WHERE relative_path=?').all(relative))
      },
    }
    const mergedAdapter = {prepare:sql=>merged.prepare(sql),transaction:fn=>()=>{merged.exec('BEGIN');try{fn();merged.exec('COMMIT')}catch(error){merged.exec('ROLLBACK');throw error}}}
    const mergedOwner = load('src/main/indexing/merged-page/mergedIndexSyncRuntime.ts').createMergedIndexSyncRuntime({
      runMergedIndexMutation:async(_label,fn)=>fn({commit(){}}),normalizePathForCacheCompare:load('src/main/path/cachePath.ts').normalizePathForCacheCompare,
      appWatchedFolders:async()=>roots,schemaVersion:7,mergedIndexSourcesKey:projection.mergedIndexSourcesKey,mergedIndexRootsKey:projection.mergedIndexRootsKey,getSqliteMeta:getMeta,
      sqliteTableExists:(_,table)=>!!merged.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
      mergedIndexSourcesMatchRoots:()=>true,openMergedIndexDb:async()=>mergedAdapter,closeSqliteDb(){},
      rustCoreWorkerRuntime:{runRustMergedIndexSync:async()=>null},mergedIndexDbPath:()=>path.join(dir,'unused-merged.sqlite'),
      mergedIndexInsertStatement:()=>merged.prepare('INSERT OR REPLACE INTO entries VALUES(@root_path,@relative_path,@source_id,@tag_names_json)'),
      bindMergedIndexRow:(row,root)=>({root_path:root,relative_path:row.relative_path,source_id:row.font_id,tag_names_json:row.tag_names_json}),
      writeMergedIndexSourceRow(){throw Error('partial committed locator advanced a whole-root receipt')},setSqliteMeta:setMeta,mergedIndexReadyProcessKeys:new Set(),appendStartupLog:message=>logs.push(message),
    },sourceRuntime,{rebuildMergedIndexDb:async()=>{throw Error('unexpected whole-index rebuild')}})
    const sync = load('src/main/library/sharedMetadataMergedIndexSyncRuntime.ts').createSharedMetadataMergedIndexSyncRuntime({
      uniqueResolvedFolders:values=>[...new Set(values.map(value=>path.resolve(value)))],normalizePathForCacheCompare:normalize,appendLog:message=>logs.push(message),
      openMetadataDb:async root=>{located.push(root);if(root===unavailableRoot)throw Error('offline');return databases.get(root)},closeMetadataDb(){},
      syncMergedIndexForRootIncremental:mergedOwner.syncMergedIndexForRootIncremental,
      syncMergedIndexForRootSnapshot:async root=>snapshots.push(root),
    })
    // Model each durable writer receipt as a changed source generation. The
    // locator and projection are real; this fixture does not measure signature I/O.
    const capture = method => async(...args)=>{const result=await writer[method](...args);receipts.push(plain(result));for(const root of new Set((result.committedLocators||[]).map(locator=>locator.rootPath)))sourceRevisions.set(root,sourceRevisions.get(root)+1);return result}
    const mutation = load('src/main/library/sharedFontMetadataMutations.ts').createSharedFontMetadataMutations({
      ...sync,uniqueResolvedFolders:values=>values,appendLog:message=>logs.push(message),invalidateSharedFontRuntimeCaches(){},
      updateSharedFontMetadataEntries:capture('updateSharedFontMetadataEntries'),renameSharedTagInMetadataIndexes:capture('renameSharedTagInMetadataIndexes'),removeSharedTagFromMetadataIndexes:capture('removeSharedTagFromMetadataIndexes'),
      refreshKnownSharedTagsFromMetadata:async()=>{if(catalogFailure)throw Error('catalog unavailable');return ['base','concurrent']},
    })
    const add = (font,id,tag)=>({...font,id,tagNames:['stale-renderer'],favorite:false,deleteProtected:false,__sharedTagWriteMode:'add',__sharedTagWriteTag:tag})
    const set = (item,folders=roots)=>mutation.setSharedFontTagsInIndex([item],folders,['stale-renderer'])
    const last = ()=>receipts.at(-1)
    const assertScope = (start,expected)=>assert.deepEqual(plain(reads.slice(start).map(read=>[read.root,read.relativePaths])),expected)
    let start=reads.length
    const ui = add(existing,'file-v2:live-runtime','added')
    assert.equal((await set(ui)).ok,true)
    assert.deepEqual(last().updatedIds,[ui.id]);assert.deepEqual(last().committedLocators,[{rootPath:roots[0],sourceFontId:existing.id}])
    assert.equal(snapshots.length,0,'one source row must not fall back to a root snapshot for a differing UI ID')
    assertScope(start,[[roots[0],['a.ttf']]]);assert.deepEqual(located,[roots[0]]);assert(resolvedSources.every(requested=>requested.length===1&&requested[0]===roots[0]))
    assert.equal(merged.prepare('SELECT shared_metadata_signature FROM sources WHERE root_path=?').get(roots[0]).shared_metadata_signature,'metadata-v2|1','partial locator marked the whole root current')
    assert.equal(databases.get(roots[0]).prepare('SELECT COUNT(*) AS n FROM font_metadata').get().n,1499)
    assert.deepEqual(JSON.parse(merged.prepare('SELECT tag_names_json FROM entries WHERE root_path=? AND relative_path=?').get(roots[0],'a.ttf').tag_names_json).sort(),['added','base','concurrent'])
    const committed=databases.get(roots[0]).prepare('SELECT favorite,delete_protected FROM font_metadata WHERE font_id=?').get(existing.id)
    assert.equal(committed.favorite,1);assert.equal(committed.delete_protected,1,'renderer snapshot changed unrelated protection')

    // Repeating the same intent has no updated IDs, locators, or refresh work.
    start=reads.length;await set(ui);assert.deepEqual(last().updatedIds,[]);assert.deepEqual(last().committedLocators,[]);assert.equal(reads.length,start)
    // Same source ID in two roots must survive deduplication and refresh each exact root once.
    start=reads.length
    const batch=await mutation.setSharedFontTagsBatchInIndex([{item:add(existing,'file-v2:first','both'),tagNames:[]},{item:add(second,'file-v2:second','both'),tagNames:[]}],roots)
    assert.equal(batch.ok,true);assert.deepEqual(last().updatedIds,['file-v2:first','file-v2:second'])
    assert.deepEqual(last().committedLocators,roots.map(rootPath=>({rootPath,sourceFontId:'legacy-source'})))
    assertScope(start,[[roots[0],['a.ttf']],[roots[1],['b.ttf']]])

    // Native canonicalizes source keys; public UI acknowledgements must still use the original item ID.
    const spaced=baseFont(roots[0],'trimmed.ttf',' trimmed-source ')
    caches.get(roots[0]).cache.entries['trimmed.ttf']={path:'trimmed.ttf',status:'ok',font:spaced}
    const canonicalId=rustClient?'trimmed-source':spaced.id
    insertMetadata(databases.get(roots[0]),canonicalId,'trimmed.ttf')
    start=reads.length;assert.equal((await set(add(spaced,'file-v2:trimmed','trimmed-add'))).ok,true)
    assert.deepEqual(last().updatedIds,['file-v2:trimmed']);assert.deepEqual(last().committedLocators,[{rootPath:roots[0],sourceFontId:canonicalId}]);assertScope(start,[[roots[0],['trimmed.ttf']]])

    // Recovery/source ID and both synthetic legacy/file-v2 UI IDs use the production matcher.
    for(const [id,relative,sourceId,missing] of [['recovery:missing','missing.ttf','recovery-source',true],['legacy-runtime','legacy.ttf',undefined,false],['file-v2:synthetic','synthetic.ttf',undefined,false]]) {
      const item=add(baseFont(roots[0],relative,id),id,'synthetic-add')
      item.sourceId=sourceId;if(missing)item.fileAvailability='missing'
      const expected=sourceId||createHash('sha1').update(`${relative.toLowerCase()}|11|12`).digest('hex')
      start=reads.length;assert.equal((await set(item)).ok,true)
      assert.deepEqual(last().updatedIds,[id]);assert.deepEqual(last().committedLocators,[{rootPath:roots[0],sourceFontId:expected}]);assertScope(start,[[roots[0],[relative]]])
    }
    // Rename/delete consume authoritative source IDs while retaining each root in their receipts.
    start=reads.length;assert.equal((await mutation.renameSharedFontTagInIndex('both','renamed',roots)).ok,true)
    assert.deepEqual(last().updatedIds,['legacy-source']);assert.equal(last().committedLocators.length,2);assertScope(start,[[roots[0],['a.ttf']],[roots[1],['b.ttf']]])
    start=reads.length;assert.equal((await mutation.deleteSharedFontTagInIndex('renamed',roots)).ok,true)
    assert.equal(last().committedLocators.length,2);assertScope(start,[[roots[0],['a.ttf']],[roots[1],['b.ttf']]])
    start=reads.length;await mutation.deleteSharedFontTagInIndex('renamed',roots);assert.deepEqual(last().committedLocators,[]);assert.equal(reads.length,start)

    // A second-root transaction failure must not publish rolled-back IDs or locators.
    const failingDb=databases.get(roots[1])
    const transactionState=()=>plain({rows:failingDb.prepare('SELECT * FROM font_metadata ORDER BY font_id').all(),events:failingDb.prepare('SELECT * FROM metadata_events ORDER BY event_id').all(),ops:failingDb.prepare('SELECT * FROM shared_tag_ops ORDER BY op_id').all(),meta:failingDb.prepare("SELECT * FROM meta WHERE key IN ('updatedAt','writerHost') ORDER BY key").all()})
    const beforeFailure=transactionState()
    if(rustClient)failingDb.exec("CREATE TRIGGER fail_commit BEFORE INSERT ON meta WHEN NEW.key='writerHost' BEGIN SELECT RAISE(ABORT,'controlled metadata failure'); END")
    else failRoot=roots[1]
    start=reads.length
    const partial=await mutation.setSharedFontTagsBatchInIndex([{item:add(existing,'file-v2:committed','partial'),tagNames:[]},{item:add(second,'file-v2:failed','partial'),tagNames:[]}],roots)
    assert.equal(partial.ok,false);assert.deepEqual(last().updatedIds,['file-v2:committed']);assert.deepEqual(last().committedLocators,[{rootPath:roots[0],sourceFontId:'legacy-source'}]);assertScope(start,[[roots[0],['a.ttf']]])
    assert(!JSON.parse(failingDb.prepare('SELECT tag_names_json FROM font_metadata WHERE font_id=?').get('legacy-source').tag_names_json).includes('partial'))
    assert.deepEqual(transactionState(),beforeFailure,'failed apply leaked rows, events, ops, or commit metadata')
    for(const method of ['renameSharedFontTagInIndex','deleteSharedFontTagInIndex']) {
      start=reads.length
      const result=method==='renameSharedFontTagInIndex'?await mutation[method]('base','renamed-base',[roots[1]]):await mutation[method]('base',[roots[1]])
      assert.equal(result.ok,false);assert.deepEqual(last().updatedIds,[]);assert.deepEqual(last().committedLocators,[]);assert.equal(reads.length,start)
      assert(JSON.parse(failingDb.prepare('SELECT tag_names_json FROM font_metadata WHERE font_id=?').get('legacy-source').tag_names_json).includes('base'))
      assert.deepEqual(transactionState(),beforeFailure,`${method} leaked transaction state`)
    }
    if(rustClient)failingDb.exec('DROP TRIGGER fail_commit');else failRoot=undefined

    // Postcommit failures must not create a replayable failure or discard the commit locator.
    failAfterCommit=true;catalogFailure=true;start=reads.length
    const before=applyCalls,result=await set(add(existing,'file-v2:postcommit','postcommit'))
    assert.equal(result.ok,true);assert.deepEqual(last().updatedIds,['file-v2:postcommit']);assert.equal(last().committedLocators.length,1);assertScope(start,[[roots[0],['a.ttf']]])
    if(rustClient)assert.equal(applyCalls-before,1)
    failAfterCommit=false;catalogFailure=false

    // A missing/inaccessible/invalid row falls back only for its committed root.
    for(const locator of [{rootPath:roots[0],sourceFontId:'absent'},{rootPath:roots[0],sourceFontId:''}]) {
      const before=snapshots.length;await sync.syncSharedMetadataChangedIdsToMergedIndex([locator],roots,'shared-tags-unknown');assert.deepEqual(snapshots.slice(before),[roots[0]])
    }
    unavailableRoot=roots[0]
    start=reads.length;let fallback=snapshots.length
    await sync.syncSharedMetadataChangedIdsToMergedIndex(roots.map(rootPath=>({rootPath,sourceFontId:'legacy-source'})),roots,'shared-tags-offline')
    assert.deepEqual(snapshots.slice(fallback),[roots[0]]);assertScope(start,[[roots[1],['b.ttf']]]);unavailableRoot=undefined
    for(const relative of ['', '../outside.ttf', path.join(roots[0],'absolute.ttf'), '.']) {
      databases.get(roots[0]).prepare('UPDATE font_metadata SET relative_path=? WHERE font_id=?').run(relative,'legacy-source')
      fallback=snapshots.length;await sync.syncSharedMetadataChangedIdsToMergedIndex([{rootPath:roots[0],sourceFontId:'legacy-source'}],roots,'shared-tags-invalid-path')
      assert.deepEqual(snapshots.slice(fallback),[roots[0]])
    }
    databases.get(roots[0]).prepare('UPDATE font_metadata SET relative_path=? WHERE font_id=?').run('nested/a.ttf','legacy-source')
    start=reads.length;await sync.syncSharedMetadataChangedIdsToMergedIndex([{rootPath:roots[0],sourceFontId:'legacy-source'}],[...roots,path.join(roots[0],'nested')],'shared-tags-nested')
    assertScope(start,[[roots[0],['nested/a.ttf']]])
    fallback=snapshots.length;await sync.syncSharedMetadataChangedIdsToMergedIndex([{rootPath:path.join(dir,'unknown'),sourceFontId:'legacy-source'}],roots,'shared-tags-unknown-root')
    assert.deepEqual(snapshots.slice(fallback),roots)
    const legacy=load('src/main/library/sharedFontMetadataMutations.ts').createSharedFontMetadataMutations({...sync,uniqueResolvedFolders:x=>x,invalidateSharedFontRuntimeCaches(){},updateSharedFontMetadataEntries:async()=>({updatedIds:['legacy-ui'],failed:[]}),refreshKnownSharedTagsFromMetadata:async()=>[]})
    fallback=snapshots.length;await legacy.setSharedFontTagsInIndex([ui],roots,['legacy']);assert.deepEqual(snapshots.slice(fallback),roots,'missing contract must not silently skip refresh')
    console.log(`[shared-metadata-committed-locators] ${rustClient?'real Rust':'gated Node'}: 1499-row one-row scope, authoritative projection, UI/source/legacy/recovery IDs, multiroot, partial rollback, no-op, postcommit and conservative fallback passed`)
  } finally {
    if(oldFallback===undefined)delete process.env.HFM_NODE_STATE_FALLBACK;else process.env.HFM_NODE_STATE_FALLBACK=oldFallback
    if(oldMigration===undefined)delete process.env.HFM_RUST_FULL_MIGRATION;else process.env.HFM_RUST_FULL_MIGRATION=oldMigration
    for(const db of databases.values())db.close();merged.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})
  }
}
module.exports = { runCommittedLocatorCases }

// Malformed/legacy native receipts are positive commit acknowledgements, not a
// license to retry the writer or infer UI successes for unreported source rows.
async function runUnconfirmedReceiptCases() {
  assert.equal(process.platform,'win32','shared metadata acceptance runs only on Windows')
  const load=loader(), roots=['receipt-one','receipt-two'].map(name=>path.resolve(os.tmpdir(),name))
  const variants=[
    {name:'missing',count:2,ids:undefined,known:[],hint:true},
    {name:'empty',count:2,ids:[],known:[],hint:true},
    {name:'partial',count:2,ids:['a'],known:['a'],hint:true},
    {name:'duplicate',count:2,ids:['a','a'],known:['a'],hint:true},
    {name:'unknown',count:1,ids:['unknown'],known:[],hint:true},
    {name:'mixed-unknown',count:2,ids:['a','unknown'],known:['a'],hint:true},
    {name:'overreported',count:1,ids:['a','b'],known:[],hint:true},
    {name:'invalid-count',count:NaN,ids:['a'],known:[],hint:true},
    {name:'zero-contradiction',count:0,ids:['a'],known:[],hint:true},
    {name:'true-zero',count:0,ids:[],known:[],hint:false},
    {name:'legacy-zero',count:0,ids:undefined,known:[],hint:false},
    {name:'malformed-zero',count:0,ids:null,known:[],hint:true},
    {name:'complete',count:2,ids:['a','b'],known:['a','b'],hint:false},
  ]
  for(const method of ['set','batch','rename','remove','protection'])for(const variant of variants) {
    const databases=new Map(),cache=new Map(),signals=[],snapshots=[],incremental=[],captured=[],logs=[]
    let calls=0,nodeWrites=0
    try {
      for(const [index,root]of roots.entries()) {
        const db=new DatabaseSync(':memory:');databases.set(root,db)
        db.exec('CREATE TABLE font_metadata(font_id TEXT PRIMARY KEY,relative_path TEXT,path_key TEXT,tag_names_json TEXT,favorite INTEGER,delete_protected INTEGER,revision INTEGER)')
        const entries={}
        for(const id of index?['c']:['a','b']) {
          db.prepare('INSERT INTO font_metadata VALUES(?,?,?,?,1,0,1)').run(id,id+'.ttf',id+'.ttf','["old"]')
          entries[id+'.ttf']={path:id+'.ttf',status:'ok',font:{id,path:path.join(root,id+'.ttf'),tagNames:['old']}}
        }
        cache.set(root,{cache:{entries}})
      }
      const run=async input=>{
        calls++
        const first=input.rootPath===roots[0],count=first?variant.count:1,ids=first?variant.ids:['c']
        // The mock crosses a real SQLite commit before delivering its damaged receipt.
        if(count>0)databases.get(input.rootPath).exec(`BEGIN; UPDATE font_metadata SET tag_names_json='["committed"]'; COMMIT;`)
        const stateSignal={rootPath:input.rootPath,changedIds:ids||['unverified'],sharedMetadataChanged:false,mergedIndexDirty:false,pageQueryDirty:false,metricsDirty:false,cacheInvalidated:false}
        return {written:count,updated:count,changedIds:ids,updatedIds:ids,stateSignal,mutationProtocol:{domain:'sharedMetadata',changedIds:ids||['unverified'],stateSignal,ok:true}}
      }
      const writer=load('src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts').createSharedMetadataMutationRuntime({
        runtimeDeps:{uniqueResolvedFolders:x=>x,findBestWatchedRootForFile:(file,folders)=>folders.find(root=>file.startsWith(root+path.sep)),loadExistingFolderCache:async root=>cache.get(root),
          cacheKeyForRootFile:(root,file)=>path.relative(root,file),cacheEntryRuntimePath:(root,relative)=>path.resolve(root,relative),normalizePathForCacheCompare:x=>x,
          runRustSharedMetadataApply:run,runRustSharedMetadataRemoveTag:run,appendStartupLog:message=>logs.push(message),closeSqliteDb(){},onSharedMetadataMutationStateSignal:signal=>signals.push(plain(signal))},
        ensureLegacyMetadataImported:async()=>{},withSharedMetadataWriteLock:async(_root,fn)=>fn(),openSharedMetadataDb:async root=>databases.get(root),writeMeta(){nodeWrites++;throw Error('receipt replayed through Node')},
      })
      const sync=load('src/main/library/sharedMetadataMergedIndexSyncRuntime.ts').createSharedMetadataMergedIndexSyncRuntime({
        uniqueResolvedFolders:x=>x,normalizePathForCacheCompare:x=>x,appendLog(){},openMetadataDb:async root=>databases.get(root),closeMetadataDb(){},
        syncMergedIndexForRootSnapshot:async root=>snapshots.push(root),syncMergedIndexForRootIncremental:async(root,payload)=>incremental.push({root,ids:payload.upserts.map(item=>item.id)}),
      })
      const capture=name=>async(...args)=>{const result=await writer[name](...args);captured.push(plain(result));return result}
      const mutation=load('src/main/library/sharedFontMetadataMutations.ts').createSharedFontMetadataMutations({...sync,uniqueResolvedFolders:x=>x,appendLog(){},invalidateSharedFontRuntimeCaches(){},
        updateSharedFontMetadataEntries:capture('updateSharedFontMetadataEntries'),renameSharedTagInMetadataIndexes:capture('renameSharedTagInMetadataIndexes'),removeSharedTagFromMetadataIndexes:capture('removeSharedTagFromMetadataIndexes'),refreshKnownSharedTagsFromMetadata:async()=>['committed']})
      const items=roots.flatMap(root=>Object.values(cache.get(root).cache.entries).map(entry=>({...entry.font,id:'ui-'+entry.font.id,__sharedTagWriteMode:'add',__sharedTagWriteTag:'new'})))
      const result=method==='set'?await mutation.setSharedFontTagsInIndex(items,roots,['old','new'])
        :method==='batch'?await mutation.setSharedFontTagsBatchInIndex(items.map(item=>({item,tagNames:['old','new']})),roots)
        :method==='rename'?await mutation.renameSharedFontTagInIndex('old','new',roots)
        :method==='remove'?await mutation.deleteSharedFontTagInIndex('old',roots)
        :await mutation.setFontDeleteProtectionInIndex(items,roots,true)
      const receipt=captured[0],removeUnknown=method==='remove'&&variant.ids?.includes('unknown')
      const expectedKnown=removeUnknown?(variant.count>=variant.ids.length?variant.ids:[]):variant.known
      const expectedHint=removeUnknown?false:variant.hint
      const expectedFallback=expectedHint||removeUnknown
      const uiIds=['set','batch','protection'].includes(method)
      assert.equal(calls,2,`${method}/${variant.name}: committed native write replayed`);assert.equal(nodeWrites,0)
      assert.equal(result.ok,true);assert.deepEqual(plain(result.failed),[])
      assert.deepEqual(receipt.updatedIds,[...expectedKnown,'c'].map(id=>uiIds?'ui-'+id:id),`${method}/${variant.name}: fabricated item acknowledgement`)
      assert.deepEqual(receipt.committedRefreshRoots,expectedHint?[roots[0]]:[])
      assert.deepEqual(snapshots,expectedFallback?[roots[0]]:[],`${method}/${variant.name}: fallback escaped affected root`)
      assert(!incremental.some(entry=>entry.root===roots[0])||!expectedFallback,'unconfirmed root was also incrementally refreshed')
      assert(incremental.some(entry=>entry.root===roots[1]),'healthy root lost precise refresh')
      if(expectedHint) {
        assert(result.message.includes('已提交')&&result.message.includes('尚未完全确认'),'unconfirmed commit reported as definite no-op')
        assert(logs.some(message=>message.includes('committed scope unconfirmed')),'unconfirmed scope was not logged')
        const signal=signals.find(signal=>signal.rootPath===roots[0]);assert.equal(signal.pageQueryDirty,true);assert.equal(signal.mergedIndexDirty,true)
        assert.deepEqual(signal.changedIds,expectedKnown)
        assert.deepEqual(receipt.mutationProtocols[0].changedIds,expectedKnown,'unverified IDs escaped through protocol')
        assert.deepEqual(receipt.mutationProtocols[0].stateSignal.changedIds,expectedKnown)
      }
    } finally {for(const db of databases.values())db.close()}
  }
  // Native changed row counts can exceed distinct IDs for repeated prepared source keys.
  const font={id:'same-source',path:path.join(roots[0],'a.ttf'),tagNames:[]},signals=[]
  const writer=load('src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts').createSharedMetadataMutationRuntime({
    runtimeDeps:{uniqueResolvedFolders:x=>x,findBestWatchedRootForFile:()=>roots[0],loadExistingFolderCache:async()=>({cache:{entries:{'a.ttf':{path:'a.ttf',status:'ok',font}}}}),cacheKeyForRootFile:()=> 'a.ttf',cacheEntryRuntimePath:()=>font.path,normalizePathForCacheCompare:x=>x,closeSqliteDb(){},appendStartupLog(){},onSharedMetadataMutationStateSignal:signal=>signals.push(signal),runRustSharedMetadataApply:async()=>({written:2,changedIds:['same-source']})},
    ensureLegacyMetadataImported:async()=>{},withSharedMetadataWriteLock:async(_root,fn)=>fn(),openSharedMetadataDb:async()=>{throw Error('native commit replayed')},writeMeta(){throw Error('native commit replayed')},
  })
  const duplicate=await writer.updateSharedFontMetadataEntries({items:[{...font,id:'first-ui',favorite:true},{...font,id:'second-ui',favorite:false}],watchedFolders:[roots[0]],mergePolicy:'favorite',mutateFont:(f,item)=>({...f,favorite:item.favorite})})
  assert.deepEqual(plain(duplicate.updatedIds),['first-ui','second-ui']);assert.deepEqual(plain(duplicate.committedRefreshRoots),[],'valid repeated source operations caused fallback')
  assert.deepEqual([...new Set(duplicate.committedLocators.map(locator=>JSON.stringify(locator)))],[JSON.stringify({rootPath:roots[0],sourceFontId:'same-source'})])
  const withoutReader=[]
  const olderAdapter=load('src/main/library/sharedFontMetadataMutations.ts').createSharedFontMetadataMutations({
    uniqueResolvedFolders:x=>x,invalidateSharedFontRuntimeCaches(){},refreshKnownSharedTagsFromMetadata:async()=>[],
    syncSharedMetadataRootsToMergedIndex:async rootPaths=>withoutReader.push(...rootPaths),
    updateSharedFontMetadataEntries:async()=>({updatedIds:['first-ui','other-ui'],failed:[],committedRefreshRoots:[roots[0]],committedLocators:roots.map((rootPath,index)=>({rootPath,sourceFontId:index?'other':'first'}))}),
  })
  const olderResult=await olderAdapter.setSharedFontTagsInIndex([{...font,id:'first-ui'}],roots,['new'])
  assert.equal(olderResult.ok,true);assert.deepEqual(withoutReader,roots,'missing locator reader skipped or duplicated precise roots beside an unconfirmed root')
  console.log('[shared-metadata-committed-receipts] set/batch/rename/delete/protection missing/empty/partial/duplicate/unknown/inconsistent receipts, zero no-op, dirty signals, user warning, root isolation and no replay passed')
}
module.exports.runUnconfirmedReceiptCases=runUnconfirmedReceiptCases
