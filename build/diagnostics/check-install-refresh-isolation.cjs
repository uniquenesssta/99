'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { DatabaseSync } = require('node:sqlite')
const root = path.resolve(__dirname, '../..')
function loader(stubs = {}) {
  const cache = new Map()
  function load(file) {
    file = path.resolve(file)
    if (Object.hasOwn(stubs, file)) return stubs[file]
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(id => Object.hasOwn(stubs,id) ? stubs[id] : id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts')) : require(id), module, module.exports)
    return module.exports
  }
  return relative => load(path.join(root, relative))
}
const at = relative => path.join(root, relative)
const identity = (file, size, modified) => `file-v2:${file.toLowerCase()}|${size}|${modified}`
const a = 'C:\\fonts', b = '\\\\nas\\share\\fonts'
const item = (folder, name) => ({ id: identity(path.win32.join(folder, name), 4, 1), path: path.win32.join(folder, name), fileSize: 4, modifiedAt: 1, family: 'Old name' })
async function main() {
  assert.equal(process.platform, 'win32', 'This diagnostic is Windows-only')
  let generation = 1
  const load = loader({
    [at('src/main/watcher/folderWatcherRegistrationRuntime.ts')]: { currentFolderWatcherRegistrationGeneration: () => generation },
    [at('src/main/path/startupPathAvailabilityRuntime.ts')]: { getStartupPathRootState: root => ({ rootId: root, generation: 1, state: 'online' }) },
    [at('src/main/fonts/fontFileIdentity.ts')]: { fileRuntimeFontId: identity },
  })
  const { loadInstallRefreshCandidates } = load('src/main/install/refresh/installRefreshCandidatesRuntime.ts')
  const good = item(a, 'good.ttf'), bad = item(b, 'bad.ttf'), staleGood = item(a, 'stale.ttf')
  let healthyReads = 0
  const healthy = await loadInstallRefreshCandidates([a,b], async roots => { healthyReads++; assert.deepEqual(roots,[a,b]); return [good,bad] }, async()=>{throw Error('Healthy complete load must not read a snapshot')})
  assert.equal(healthyReads,1);assert.equal(healthy.scope,'all-roots');assert.equal(healthy.snapshotIds.size,0)
  const calls = []
  const readRoot = async roots => { calls.push(roots); if (roots.includes(b)) throw new Error('malformed root db'); return [good] }
  let result = await loadInstallRefreshCandidates([b,a], readRoot, async () => [bad, staleGood])
  assert.deepEqual(calls, [[b,a],[b],[a]])
  assert.deepEqual(result.items.map(x => x.id), [good.id,bad.id])
  assert.equal(result.scope, 'snapshot'); assert.deepEqual(result.unavailableRoots, [b])
  assert.deepEqual([...result.snapshotIds], [bad.id])
  result = await loadInstallRefreshCandidates([b,a], readRoot, async () => null)
  assert.equal(result.scope, 'available-roots'); assert.deepEqual(result.items, [good])

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE sources(root_path TEXT,index_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT); CREATE TABLE entries(root_path TEXT,relative_path TEXT,file_size INTEGER,modified_at REAL,status TEXT,font_json TEXT,is_deleted INTEGER);')
  const getMeta = (_, key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value || ''
  const setMeta = (key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,value)
  const sources = [a,b].map(root => ({root,indexDbPath:root+'\\index.sqlite',installDbPath:undefined,indexSignature:'root-v3|1',installSignature:'none',sharedMetadataSignature:'metadata-v2|1'}))
  for (const source of sources) db.prepare('INSERT INTO sources VALUES(?,?,?,?,?)').run(source.root,source.indexDbPath,source.indexSignature,source.installSignature,source.sharedMetadataSignature)
  for (const font of [good,bad]) db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,0)').run(path.win32.dirname(font.path),path.win32.basename(font.path),4,1,'ok',JSON.stringify(font))
  setMeta('schemaVersion','7'); setMeta('sourcesKey',JSON.stringify(sources))
  let roots = [a,b]
  const ctx = {schemaVersion:7,getSqliteMeta:getMeta,sqliteTableExists:(_,table)=>!!db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table),
    mergedIndexSourcesKey:JSON.stringify,mergedIndexRootsKey:roots=>JSON.stringify([...roots].sort()),normalizePathForCacheCompare:x=>x.toLowerCase(),
    appWatchedFolders:async()=>roots,openMergedIndexDb:async()=>db,closeSqliteDb(){},mergedIndexLocalSnapshotUsable:()=>true,
    pathInsideFolder:(root,file)=>file.startsWith(root+'\\'),fontFromRootIndexPageRow:(_,row)=>JSON.parse(row.font_json)}
  const { readInstallRefreshSnapshot } = load('src/main/indexing/merged-page/mergedIndexInstallCandidateRuntime.ts').createMergedIndexInstallCandidateRuntime(ctx)
  // No root-db port exists: any accidental NAS read fails this isolated fixture.
  assert.equal((await readInstallRefreshSnapshot(roots)).length,2)
  const before = db.prepare('SELECT * FROM sources').all()
  setMeta('sourcesKey','pending:'+ctx.mergedIndexRootsKey(roots))
  assert.equal(await readInstallRefreshSnapshot(roots),null)
  setMeta('sourcesKey',JSON.stringify(sources)); roots = [a]
  assert.equal(await readInstallRefreshSnapshot(roots),null)
  assert.deepEqual(db.prepare('SELECT * FROM sources').all(),before)
  roots = [a,b]
  generation++
  const delayedCtx = { ...ctx, openMergedIndexDb: async () => { generation++; return db } }
  const delayed = load('src/main/indexing/merged-page/mergedIndexInstallCandidateRuntime.ts').createMergedIndexInstallCandidateRuntime(delayedCtx)
  assert.equal(await delayed.readInstallRefreshSnapshot(roots),null)
  db.close()

  const statuses = new Map(), persisted = [], summaryWrites = []
  const missing = Array.from({length:13},(_,i)=>item(b,`missing-${i}.ttf`))
  let changed = false, namesChanged = false
  const runLoad = loader({
    [at('src/main/watcher/folderWatcherRegistrationRuntime.ts')]: {currentFolderWatcherRegistrationGeneration:()=>generation},
    [at('src/main/path/sharedFileSystemRuntime.ts')]: {withSharedIoPriority:(_,fn)=>fn()},
    [at('src/main/path/cachePath.ts')]: {normalizePathForCacheCompare:x=>x.toLowerCase()},
    [at('src/main/fonts/fontFileIdentity.ts')]: {fileRuntimeFontId:identity},
    [at('src/main/app/shutdownCoordinatorRuntime.ts')]: {applicationWorkEpoch:()=>1,assertApplicationOpen(){}},
    [at('src/main/path/startupPathAvailabilityRuntime.ts')]: {getStartupPathRootState:root=>({rootId:root,state:'online',generation:1})},
    [at('src/main/install/refresh/installRefreshSnapshotEvidenceRuntime.ts')]: {assertInstallSnapshotNamesCurrent:async()=>{if(namesChanged)throw new Error('fresh name changed')}},
    [at('src/main/install/fontInstallEvidenceRuntime.ts')]: {createFontInstallEvidenceSession:()=>({
      read:async path=>({path,size:changed?8:4,modified:1,sha256:'a'.repeat(64)}),
      confirm:async item=>({installed:!item.path.endsWith('11.ttf')&&!item.path.endsWith('12.ttf'),known:true,by:item.path.endsWith('11.ttf')||item.path.endsWith('12.ttf')?'none':'user',matches:[]})})},
  })
  const runner = runLoad('src/main/install/refresh/installStatusRefreshRunner.ts').createInstallStatusRefreshRunner({
    appWatchedFolders:async()=>[a,b],loadSharedFontsForFolders:async roots=>{if(roots.includes(b))throw Error('malformed');return []},
    readInstallRefreshSnapshot:async()=>missing,
    readInstallStatusIndex:async items=>({results:Object.fromEntries(items.filter(x=>statuses.has(x.id)).map(x=>[x.id,statuses.get(x.id)])),misses:items.filter(x=>!statuses.has(x.id))}),
    saveInstallStatusIndex:async(results,items,options)=>{options.assertCurrent();persisted.push(options);for(const [id,value] of Object.entries(results))statuses.set(id,value)},
    saveInstalledTotalSummaryForRoots:async(...args)=>summaryWrites.push(args),readInstalledTotalSummaryForRoots:async()=>null,
    getSystemInstalledFontsCached:async()=>[],buildInstalledFontLookupIndex:()=>({}),compareFontInstalledWithLookupIndex:()=>({installed:false,by:'none',matches:[]}),
    rootForFontPath:async()=>b,installStatusProjectionOwnedByWriter:true,
    emitInstallStatusProgress(){},waitForRendererIdle:async()=>{},delayToEventLoop:async()=>{},withGlobalIo:(_,fn)=>fn(),appendStartupLog(){},
  },{installStatusRefreshBatchSize:20,lightweightMissingThreshold:32,readSystemInstalledFontsLightweight:async()=>[]})
  let refresh = await runner.refreshInstallStatusIndex({}, {emitProgress:false})
  assert.equal(refresh.scope,'snapshot');assert.equal(refresh.updatedCount,13);assert.equal(refresh.installedCount,11);assert.equal(refresh.notInstalledCount,2)
  assert.equal(summaryWrites.length,0);assert(persisted.every(options=>options.preserveSourceCheckpoint))
  statuses.clear(); changed=true
  refresh = await runner.refreshInstallStatusIndex({}, {emitProgress:false})
  assert.equal(refresh.missingCount,13);assert.equal(refresh.notInstalledCount,0)
  statuses.clear();changed=false;namesChanged=true
  refresh = await runner.refreshInstallStatusIndex({}, {emitProgress:false})
  assert.equal(refresh.missingCount,13);assert.equal(refresh.notInstalledCount,0)
  let unblock, entered
  const started = new Promise(resolve=>{entered=resolve}), gate = new Promise(resolve=>{unblock=resolve})
  let writes = 0
  const writer = load('src/main/install/status/installStatusProjectionWriteRuntime.ts').createInstallStatusProjectionWriteRuntime({
    saveInstallStatusIndex:async()=>{writes++;entered();await gate},syncMergedIndexAfterInstallStatusRefresh:async()=>{},
  })
  const first = writer.saveInstallStatusIndex({[good.id]:{installed:true,by:'user',matches:[]}},new Map([[good.id,good]]))
  await started
  const captured = generation
  const second = writer.saveInstallStatusIndex({[bad.id]:{installed:true,by:'user',matches:[]}},new Map([[bad.id,bad]]),{assertCurrent:()=>{if(generation!==captured)throw Error('registration changed')}})
  const rejected = assert.rejects(second,/registration changed/)
  generation++;unblock();await first;await rejected;assert.equal(writes,1)
  const bytes = Buffer.from('synthetic-font-content'), hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
  const nameLoad = loader({
    [at('src/main/fonts/fontContentIdentityRuntime.ts')]:{readFontContentIdentity:async()=>({sha256:hash,stamp:'same'})}
  })
  const names = nameLoad('src/main/install/refresh/installRefreshSnapshotEvidenceRuntime.ts').assertInstallSnapshotNamesCurrent
  const fresh = {...bad,family:'Fresh',fullName:'Fresh Regular',postscriptName:'Fresh-Regular',style:'Regular'}
  const source = {size:bytes.length,sha256:hash,stamp:'same'}
  const native = async jobs=>({results:[{...jobs[0],signatureValid:true,sourceStability:'stable',parseDisposition:{scripts:'unsupported'},nameHint:{familyName:'Fresh Legacy',preferredFamily:'Fresh',fullName:'Fresh Regular',postscriptName:'Fresh-Regular',preferredSubfamily:'Regular'}}],errors:[]})
  await names(fresh,source,native)
  for (const disposition of [undefined, 'io-error', 'resource-limit', 'not-requested']) {
    const incomplete = async jobs => {
      const response = await native(jobs)
      response.results[0].parseDisposition = disposition ? {scripts:disposition} : undefined
      // All 16 samples are unrelated: absence of a name sample is no evidence.
      response.results[0].metadataDiagnostics = Array.from({length:16},()=>({stage:'cmap',kind:'unsupported-format',detail:'sample'}))
      return response
    }
    await assert.rejects(names(fresh,source,incomplete),/completeness unavailable/)
  }
  await assert.rejects(names({...fresh,family:'Old'},source,native),/names changed/)
  await assert.rejects(names(fresh,{...source,sha256:'0'.repeat(64)},native),/source changed/)
  await assert.rejects(names(fresh,source),/reader unavailable/)
  // A real SFNT name table distinguishes legacy ID 1/2 from preferred ID 16/17.
  // No cmap is supplied: name evidence must remain valid despite script diagnostics.
  const nameRecords = [[1,'Legacy Family Bold'],[2,'Regular'],[4,'Preferred Family Bold'],[6,'PreferredFamily-Bold'],[16,'Preferred Family'],[17,'Bold']]
  const encoded = nameRecords.map(([id,text])=>{const value=Buffer.from(text,'utf16le');value.swap16();return {id,value}})
  const nameTable = Buffer.alloc(6+12*encoded.length+encoded.reduce((n,x)=>n+x.value.length,0))
  nameTable.writeUInt16BE(encoded.length,2);nameTable.writeUInt16BE(6+12*encoded.length,4)
  let offset = 0
  encoded.forEach(({id,value},index)=>{const at=6+12*index;[3,1,0x409,id,value.length,offset].forEach((n,j)=>nameTable.writeUInt16BE(n,at+2*j));value.copy(nameTable,6+12*encoded.length+offset);offset+=value.length})
  const header=Buffer.alloc(28);header.writeUInt32BE(0x10000,0);header.writeUInt16BE(1,4);header.write('name',12);header.writeUInt32BE(28,20);header.writeUInt32BE(nameTable.length,24)
  const fontBytes=Buffer.concat([header,nameTable]), directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'hfm-install-name-'))
  try {
    const file=path.join(directory,'preferred.ttf');fs.writeFileSync(file,fontBytes);const stat=fs.statSync(file)
    const fontHash=require('node:crypto').createHash('sha256').update(fontBytes).digest('hex')
    const nativeLoad=loader({[at('src/main/fonts/fontContentIdentityRuntime.ts')]:{readFontContentIdentity:async()=>({sha256:fontHash,stamp:'native-fixture'})}})
    const verify=nativeLoad('src/main/install/refresh/installRefreshSnapshotEvidenceRuntime.ts').assertInstallSnapshotNamesCurrent
    const nativeRead=async jobs=>{
      const input=path.join(directory,'input.json');fs.writeFileSync(input,JSON.stringify({jobs,fullHash:true}))
      const stdout=require('node:child_process').execFileSync(path.join(root,'build/native/hfm-core-worker.exe'),['--font-parse-batch','--input',input],{encoding:'utf8',timeout:30000})
      const payload=JSON.parse(stdout.split(/\r?\n/).find(line=>line.startsWith('{')));assert.equal(payload.ok,true)
      assert.equal(payload.results[0].nameHint.preferredFamily,'Preferred Family')
      return payload
    }
    await verify({...fresh,id:'fixture-native-name',path:file,fileName:'preferred.ttf',fileSize:stat.size,modifiedAt:stat.mtimeMs,
      family:'Preferred Family',fullName:'Preferred Family Bold',postscriptName:'PreferredFamily-Bold',style:'Bold'},
      {sha256:fontHash,stamp:'native-fixture'},nativeRead)
  } finally { fs.rmSync(directory,{recursive:true,force:true}) }
  console.log('install refresh isolation: passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
