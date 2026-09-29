#!/usr/bin/env node
// Windows integration: real transport, file protocol, index snapshots and Rust tag mutations.
const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript'), vm = require('node:vm')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..'), abs = p => path.join(root, p)
const worker = path.resolve(process.env.HFM_TEST_NATIVE_WORKER || 'build/native/hfm-core-worker.exe')
assert.equal(process.platform, 'win32', 'this acceptance gate must run on Windows')
assert(fs.existsSync(worker), 'real native worker is required; no simulated success')

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-traced-delete-'))
  const logs = [], appendStartupLog = s => logs.push(s)
  const load = loader({ electron: { app: { isPackaged: false, getAppPath: () => root } },
    [abs('src/main/rust-core/rustCoreWorkerPathRuntime.ts')]: {
      resolveRustCoreWorkerPathWithDiagnostics: () => ({path:worker,candidates:[worker]}),
    },
  }, { setInterval, clearInterval })
  const traceContext = load('src/main/logging/operationTraceContext.ts')
  const trace = { version:1, sessionId:'native-delete', operationId:'delete-1', attemptId:'attempt-1', batchId:'batch-1', domain:'sharedTags', members:['delete-1'], omitted:0 }
  const traced = action => traceContext.withOperationTrace(trace, appendStartupLog, action)
  const transport = load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({enabled:true,required:true,appendStartupLog})
  const shared = load('src/main/path/sharedFileSystemRuntime.ts')
  const { SharedIoProcessError } = load('src/main/path/sharedIoProcessRuntime.ts')
  const paths = load('src/main/app/appDataPaths.ts').createAppDataPaths({appName:'HFM',dataDirName:'HFM',appendLog:appendStartupLog})
  const constants = load('src/main/cache/constants.ts')
  const routing = load('src/main/rust-core/rustSharedIoCommandRuntime.ts')
  const client = load('src/main/rust-core/clients/rustMetadataClientRuntime.ts').createRustMetadataClientRuntime({...transport,appendStartupLog})
  const rootCacheDir = r => path.join(r, '.hfm-cache')
  const rootIndexDbPath = r => path.join(rootCacheDir(r), 'database', 'index.sqlite')
  const deps = {appName:'HFM',fontScanCacheVersion:1,scriptDetectionVersion:1,exists:paths.exists,appendStartupLog,
    openStableSqliteDb:p=>new DatabaseSync(p),closeSqliteDb:db=>db.close()}
  const database = load('src/main/indexing/root-index/rootIndexDatabaseRuntime.ts').createRootIndexDatabaseRuntime(deps)
  const manifest = load('src/main/indexing/root-index/rootIndexManifestRuntime.ts').createRootIndexManifestRuntime(deps)
  const fileRuntime = load('src/main/indexing/root-index/rootIndexFileRuntime.ts')
  const latest = load('src/main/indexing/root-index/rootIndexLatestRuntime.ts')
  const metadataPath = load('src/main/indexing/shared-metadata/sharedMetadataPathsRuntime.ts').sharedMetadataDbPathForRoot
  let overlayCalls = 0
  const folders = load('src/main/folders/folderCacheRuntime.ts').createFolderCacheRuntime({...deps,...database,...manifest,rootCacheDir,rootIndexDbPath,
    applySharedMetadataOverlay:async(_r,cache)=>{overlayCalls++;return cache}, recoveryMessage:String,
  })
  // Execute the actual composition wrapper, so a dropped options argument fails the gate.
  const source = fs.readFileSync(abs('src/main/bootstrap/mainDataStorageCompositionRuntime.ts'),'utf8')
  const ast = ts.createSourceFile('composition.ts',source,ts.ScriptTarget.Latest,true)
  let wrapper
  const visit = node => {if(ts.isFunctionDeclaration(node)&&node.name?.text==='loadExistingFolderCache')wrapper=node.getText(ast);ts.forEachChild(node,visit)}
  visit(ast);assert(wrapper,'missing production cache forwarding function')
  const js = ts.transpileModule(wrapper,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  const loadCache = vm.runInNewContext(js+'\nloadExistingFolderCache',{requireFolderCacheRuntime:()=>folders})
  const metadata = load('src/main/indexing/shared-metadata/sharedFontMetadataRuntime.ts').createSharedFontMetadataRuntime({...deps,...client,
    loadExistingFolderCache:loadCache, uniqueResolvedFolders:items=>[...new Set(items.map(p=>path.resolve(p)))],
    findBestWatchedRootForFile:(file,roots)=>roots.find(r=>file.startsWith(r+path.sep)),
    cacheKeyForRootFile:(r,file)=>path.relative(r,file),cacheEntryRuntimePath:(r,p)=>path.resolve(r,p),normalizePathForCacheCompare:p=>p.toLowerCase(),
  })
  const syncs = []
  const mutations = load('src/main/library/sharedFontMetadataMutations.ts').createSharedFontMetadataMutations({
    ...metadata,uniqueResolvedFolders:items=>items,appendLog:appendStartupLog,invalidateSharedFontRuntimeCaches(){},
    syncSharedMetadataChangedIdsToMergedIndex:async ids=>syncs.push(ids),
    refreshKnownSharedTagsFromMetadata:async roots=>(await client.runRustSharedMetadataKnownTags({roots:roots.map(rootPath=>({rootPath,dbPath:metadataPath(rootPath)}))})).knownTags,
  })
  try {
    const status = await transport.diagnoseRustCoreWorker()
    assert(status.capabilities.includes('shared-file-trace-v1'))
    const compatibility = load('src/main/rust-core/rustCoreProtocolRuntime.ts').rustCoreWorkerIsCompatible
    assert.equal(compatibility({...status,capabilities:status.capabilities.filter(c=>c!=='shared-file-trace-v1')}).ok,false,'stale worker accepted')
    const roots = []
    for (const name of ['mapped-root-字体','unc-root-字体']) {
      // Physical SMB/mapping is not simulated: these are Windows local directories
      // registered with the real isolated-root router to exercise native transport.
      const r=path.join(dir,name),cache=rootCacheDir(r),snapshot=path.join(cache,'database','index.2026-09-29.snapshot.sqlite')
      await fsp.mkdir(path.dirname(snapshot),{recursive:true});roots.push(r)
      const font={id:name,path:path.join(r,'a.ttf'),fileName:'a.ttf',format:'ttf',tagNames:[]}
      const db=new DatabaseSync(snapshot)
      database.initializeRootIndexDb(db,r,'root')
      database.writeFullRootIndexToOpenDb(db,{version:1,entries:{'a.ttf':{path:'a.ttf',cacheKey:'a',fileSize:1,modifiedAt:1,status:'ok',font,cachedAt:new Date().toISOString()}}})
      db.close()
      await fsp.writeFile(latest.rootIndexLatestPointerPath(cache),JSON.stringify({pointerType:'root-index-latest',activeDatabase:'database/'+path.basename(snapshot)}))
      await fsp.writeFile(fileRuntime.rootCacheManifestPath(cache),JSON.stringify({schemaVersion:constants.ROOT_INDEX_DB_SCHEMA_VERSION,indexCacheVersion:1,activeDatabase:'database/'+path.basename(snapshot),fileCount:1}))
      routing.registerIsolatedRoot(r)
      assert.equal((await loadCache(r)).cachePath,snapshot)
      const before=overlayCalls
      assert.equal((await traced(()=>loadCache(r,{applySharedMetadataOverlay:false}))).cachePath,snapshot)
      assert.equal(overlayCalls,before,'composition dropped applySharedMetadataOverlay:false')
      assert.equal(fs.existsSync(rootIndexDbPath(r)),false,'fixture must have no legacy index.sqlite')
      await traced(()=>client.runRustSharedMetadataApply({rootPath:r,dbPath:metadataPath(r),updatedAt:new Date().toISOString(),updatedBy:'fixture',writerPid:process.pid,
        rows:[{fontId:font.id,relativePath:'a.ttf',pathKey:font.path,tagNamesJson:JSON.stringify(['delete-me','keep']),baseTagNamesJson:'[]',favorite:false,deleteProtected:true,eventType:'update',payloadJson:'{}',mergePolicy:'replace'}]}))
    }
    const result=await traced(()=>mutations.deleteSharedFontTagInIndex('delete-me',roots))
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.updatedIds.length,2)
    assert.deepEqual(Array.from(result.mutationProtocol.knownTags),['keep']);assert.equal(syncs.length,1)
    for(const r of roots) {
      const db=new DatabaseSync(metadataPath(r));const row=db.prepare('SELECT tag_names_json,delete_protected FROM font_metadata').get();db.close()
      assert.deepEqual(JSON.parse(row.tag_names_json),['keep']);assert.equal(row.delete_protected,1)
    }
    assert(logs.some(s=>s.includes('label=shared-file-io:readFile')))
    assert(logs.some(s=>s.includes('label=shared-file-io:sqliteSnapshot')))
    assert(logs.some(s=>s.includes('label=shared-metadata-remove-tag')))
    assert.equal((await traced(()=>mutations.deleteSharedFontTagInIndex('delete-me',roots))).ok,true,'repeat delete must be safe')
    // Missing latest pointer still recovers a real immutable snapshot.
    await fsp.unlink(latest.rootIndexLatestPointerPath(rootCacheDir(roots[0])))
    assert((await traced(()=>loadCache(roots[0],{applySharedMetadataOverlay:false}))).cachePath.includes('snapshot.sqlite'))
    // Genuine absence remains distinct from a protocol rejection.
    assert.equal(await traced(()=>paths.exists(path.join(roots[0],'missing.sqlite'))),false)
    const invalid=transport.createTemporaryJsonFile('hfm-invalid-file-request')
    try {
      await traced(()=>invalid.writeJson({operation:'access',path:rootIndexDbPath(roots[0]),unexpectedBusinessField:true}))
      await assert.rejects(transport.runRustCoreScheduledCommand(worker,['--shared-file-io','--input',invalid.path],{timeout:5000,sharedIo:{paths:roots,write:false}}),e=>e.reason==='process-exit'&&e.message.includes('unknown field')&&e.message.includes('unexpectedBusinessField'))
      assert(logs.some(s=>s.includes('shared io failed:')&&s.includes('unknown field')))
    } finally {await invalid.dispose()}
    // Controlled boundary failures must propagate without inventing a missing index.
    for(const reason of ['process-exit','EACCES','timeout']) {
      shared.configureSharedFileExecutor(async()=>{throw new SharedIoProcessError('controlled '+reason,'unknown',reason)})
      await assert.rejects(traced(()=>paths.exists(rootIndexDbPath(roots[0]))),e=>e.reason===reason)
      await assert.rejects(traced(()=>loadCache(roots[0])),e=>e.reason===reason)
      const failed=await traced(()=>mutations.deleteSharedFontTagInIndex('keep',roots))
      assert.equal(failed.ok,false);assert.equal(failed.updatedIds.length,0)
      assert(failed.failed.every(f=>f.message.includes(reason)&&!f.message.includes('没有找到共享索引库')))
    }
    console.log('[shared-tag-native-delete] traced/untraced immutable index, production options forwarding, real Rust two-root delete and persistent readback, repeat delete, missing pointer recovery, unknown field and failure classification passed')
  } finally {
    transport.stopRustCoreDaemon()
    await fsp.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})
  }
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1})
