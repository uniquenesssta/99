#!/usr/bin/env node
// Current production owners + real SQLite/files; network and Windows process ports are controlled.
const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const { execFileSync, spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const stateFile = 'src/main/path/startupPathAvailabilityRuntime.ts'
const tagsFile = 'src/main/library/sharedKnownTagsRuntime.ts'
const catalogFile = 'src/main/library/runtime/sharedRootCatalogRuntime.ts'
const baseline = '3cfc5716a5971e588270a44bd872a5d0da61c749'
const crlf = process.argv.includes('--crlf'), old = process.argv.includes('--baseline')
const transforms = {}
for (const file of [stateFile,tagsFile,catalogFile,'src/main/path/pathCanonicalizer.ts']) transforms[path.join(root,file)] = text => {
  if(old && file===tagsFile) text=execFileSync('git',['show',baseline+':'+file],{cwd:root,encoding:'utf8'})
  return crlf ? text.replace(/\r?\n/g,'\r\n') : text
}
const plain = x => JSON.parse(JSON.stringify(x))
const tick = () => new Promise(r=>setImmediate(r))
const deferred = () => {let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}}
const cases=[]
const passed = name => cases.push(name)
function stateLoader(mocks, globals, transforms) {
  const stat = mocks['node:fs']?.promises?.stat
  if (stat) mocks[path.join(root,'src/main/path/sharedPathProbeRuntime.ts')] = {
    probeStartupDirectory: async value => (await stat(value)).isDirectory()
  }
  return loader(mocks, globals, transforms)
}
async function stateCases() {
  let time=1000, gate=deferred(), calls=0, fail=false
  class Clock extends Date {static now(){return time}}
  const load=stateLoader({'node:fs':{promises:{stat:async()=>{calls++;await gate.promise;if(fail)throw Error('offline');return{isDirectory:()=>true}}}}}, {Date:Clock}, transforms)
  const state=load(stateFile), a='\\\\nas\\a'
  assert.equal(state.getStartupPathRootState(a).state,'checking')
  const first=state.ensureStartupPathRootAvailable(a), duplicate=state.ensureStartupPathRootAvailable(a)
  await tick();assert.equal(calls,1)
  state.markStartupPathRootUnavailable(a,Error('disconnected'))
  const generation=state.getStartupPathRootState(a).generation
  gate.resolve();assert.equal(await first,false);assert.equal(await duplicate,false)
  assert.equal(state.getStartupPathRootState(a).generation,generation)
  assert.equal(state.getStartupPathRootState(a).state,'offline')
  assert.equal(state.getStartupPathRootState('//NAS/a/').rootId,state.getStartupPathRootState(a).rootId)
  time+=40000;gate=deferred()
  const retry=state.ensureStartupPathRootAvailable(a);await tick()
  assert.equal(state.getStartupPathRootState(a).state,'recovering')
  gate.resolve();assert.equal(await retry,true);assert.equal(state.getStartupPathRootState(a).state,'online')
  const snap=state.getStartupPathRootState(a);assert(Object.isFrozen(snap))
  const stableGeneration=snap.generation
  time+=40000;gate=deferred();fail=false
  const healthyRefresh=state.ensureStartupPathRootAvailable(a);await tick()
  assert.equal(state.getStartupPathRootState(a).state,'online')
  assert.equal(state.getStartupPathRootState(a).generation,stableGeneration,'healthy probe must not invalidate in-flight reads')
  gate.resolve();assert.equal(await healthyRefresh,true)
  assert.equal(state.getStartupPathRootState(a).generation,stableGeneration,'healthy probe success must preserve root epoch')
  time+=40000;gate=deferred();fail=true
  const failedRefresh=state.ensureStartupPathRootAvailable(a);await tick();gate.resolve()
  assert.equal(await failedRefresh,false)
  assert.equal(state.getStartupPathRootState(a).state,'offline')
  assert.notEqual(state.getStartupPathRootState(a).generation,stableGeneration,'offline transition must advance root epoch')
  assert.equal(stateLoader({}, {}, transforms)(stateFile).getStartupPathRootState(a).state,'checking')
  passed('state transitions, aliases, in-flight coalescing, stale result, restart')

  let probes=0, processCalls=0, synchronous=0
  const winLoad=stateLoader({'node:fs':{promises:{stat:async()=>{probes++;throw Error('ENETUNREACH')}}},'node:child_process':{
    execFileSync(){synchronous++;throw Error('must not block')},
    execFile(file,args,options,done){processCalls++;assert.equal(file,'powershell.exe');assert.equal(args[3],'-EncodedCommand');assert.equal(options.shell,false);assert.equal(options.timeout,1500);setImmediate(()=>done(null,Buffer.from(JSON.stringify([{drive:'O:',remote:'\\\\nas\\share'}])).toString('base64')))}
  }},{process:{...process,platform:'win32'}},transforms)
  const win=winLoad(stateFile)
  assert.equal(await win.ensureStartupPathRootAvailable('O:\\fonts'),false)
  assert.equal(win.getStartupPathRootState('O:\\fonts').rootId,win.getStartupPathRootState('\\\\nas\\share\\fonts').rootId)
  assert.equal(await win.ensureStartupPathRootAvailable('o:/fonts'),false)
  assert.equal(probes,1);assert.equal(processCalls,1);assert.equal(synchronous,0)
  const mapping=await winLoad('src/main/path/pathCanonicalizer.ts').mappedDriveTableAsync()
  assert.equal(mapping.get('O:'),'\\\\nas\\share')
  passed('mapped drive async classification, shared UNC identity, TTL')
  let attempts=0
  const failed=stateLoader({'node:child_process':{execFile(f,a,o,cb){attempts++;setImmediate(()=>cb(Error('timeout')))}},'node:fs':{promises:{stat:async()=>{throw Error('disconnected')}}}}, {process:{...process,platform:'win32'}},transforms)
  assert.equal(await failed(stateFile).ensureStartupPathRootAvailable('P:\\fonts'),false)
  assert.equal(await failed(stateFile).ensureStartupPathRootAvailable('P:\\fonts'),false)
  assert.equal(attempts,1)
  passed('mapping lookup failure stays conservative and is cached')
}
async function catalogCases(dir) {
  const roots=[path.join(dir,'a'),path.join(dir,'b')];for(const r of roots)await fsp.mkdir(r)
  const dbPath=path.join(dir,'library.sqlite'), db=new DatabaseSync(dbPath)
  let failTransaction=false
  const adapter={exec:sql=>db.exec(sql),prepare:sql=>db.prepare(sql),transaction:fn=>()=>{db.exec('BEGIN');try{const v=fn();if(failTransaction)throw Error('injected disk commit failure');db.exec('COMMIT');return v}catch(e){db.exec('ROLLBACK');throw e}}}
  let values=[['A','both'],['B','both']], broken=new Set(), aggregate=false, blocked=null, unavailable=new Set(), requests=0
  const tags=()=>db.prepare('SELECT name FROM tags ORDER BY sort_order').all().map(r=>r.name)
  const load=loader({}, {}, transforms)
  load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(adapter)
  db.prepare('INSERT INTO folders VALUES (?,?)').run(roots[0],0)
  db.prepare('INSERT INTO folders VALUES (?,?)').run(roots[1],1)
  db.prepare('INSERT INTO folder_nodes VALUES (?,?,?)').run('retained-node',JSON.stringify({id:'retained-node',rootPath:roots[1]}),0)
  const deps={uniqueResolvedFolders:x=>x,sharedMetadataDbPathForRoot:r=>path.join(r,'metadata.sqlite'),openLibraryDb:async()=>adapter,
    loadLibraryShellFromSqlite:()=>({tags:tags()}),appendStartupLog(){},
    runRustSharedMetadataKnownTags:async({roots:input})=>{
      requests++
      const captured=input.map(r=>({...r,signature:broken.has(r.rootPath)?'metadata:error':'metadata-v2|test',knownTags:broken.has(r.rootPath)?[]:[...values[roots.indexOf(r.rootPath)]],rows:1}))
      if(blocked){const wait=blocked;blocked=null;wait.enter.resolve();await wait.gate.promise}
      return {knownTags:captured.flatMap(r=>r.knownTags),...(aggregate?{}:{roots:captured})}
    }}
  let runtime=load(tagsFile).createSharedKnownTagsRuntime(deps), state=load(stateFile)
  const expect=async(want,opts)=>assert.deepEqual(plain(await runtime.refreshKnownSharedTagsFromMetadata(roots,opts)),want.slice().sort((a,b)=>a.localeCompare(b,'zh-Hans-CN')))
  db.prepare('INSERT INTO tags VALUES (?,?)').run('legacy',0)
  state.markStartupPathRootUnavailable(roots[1],Error('offline'))
  await expect(['legacy','A','both'])
  if(old)return // The old owner must fail the assertion above.
  assert(tags().includes('legacy'))
  passed('legacy partial read preserves unattributed tags (old implementation rejected)')
  // A new owner models app restart; online state is never persisted.
  const reload=()=>{const l=loader({}, {}, transforms);state=l(stateFile);runtime=l(tagsFile).createSharedKnownTagsRuntime(deps)}
  reload();await expect(['A','B','both'])
  let row=JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get('sharedRootCatalog').value)
  assert.equal(row.roots.length,2);assert.equal(row.unattributedTags.length,0)
  values[0]=[];state.markStartupPathRootUnavailable(roots[1],Error('offline'))
  await expect(['B','both']);assert(!tags().includes('A'))
  passed('confirmed online empty replaces only that root; shared tag survives offline root')
  const reader=new DatabaseSync(dbPath);assert.deepEqual(reader.prepare('SELECT name FROM tags ORDER BY sort_order').all().map(r=>r.name),tags());reader.close()
  reload();for(const r of roots)state.markStartupPathRootUnavailable(r,Error('startup offline'))
  const beforeRequests=requests;await expect(['B','both']);assert.equal(requests,beforeRequests)
  await assert.rejects(runtime.refreshKnownSharedTagsFromMetadata(roots,{requireFresh:true}),/暂时不可用/)
  const folders=await loader({'../path/startupPathAvailabilityRuntime':{filterStartupAvailableRoots:async()=>({availableRoots:[],skippedRoots:roots})}}, {},transforms)('src/main/folders/folderCacheRootAvailabilityRuntime.ts').filterFolderCacheAvailableRoots(roots)
  assert.deepEqual(plain(folders.configuredFolders),roots);assert.deepEqual(plain(folders.folders),[])
  assert.deepEqual(db.prepare('SELECT path FROM folders ORDER BY sort_order').all().map(r=>r.path),roots)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM folder_nodes').get().n,1)
  passed('real SQLite reopen, all roots offline on restart, configured roots retained')
  reload();broken.add(roots[1]);values[0]=['new'];await expect(['new','B','both'])
  await assert.rejects(runtime.refreshKnownSharedTagsFromMetadata(roots,{requireFresh:true}),/不能确认/)
  assert.equal(state.getStartupPathRootState(roots[1]).state,'online','metadata failure must not mark whole root offline')
  passed('metadata:error retains root snapshot and rejects complete-read claims')
  broken.clear();values=[[],[]];await expect([])
  passed('all confirmed empty deletes old tags normally')
  values=[['live'],[]];await expect(['live'])
  aggregate=true;values=[[],[]];await expect(['live']);await assert.rejects(runtime.refreshKnownSharedTagsFromMetadata(roots,{requireFresh:true}),/不能确认/);aggregate=false
  passed('old aggregate-only protocol cannot prove an empty catalog')
  db.prepare('UPDATE meta SET value=? WHERE key=?').run('{broken','sharedRootCatalog')
  state.markStartupPathRootUnavailable(roots[1],Error('offline'));values[0]=['new'];await expect(['live','new'])
  passed('corrupt provenance falls back to existing published directory')
  reload();values=[['stable'],[]];await expect(['stable'])
  const rawBefore=db.prepare('SELECT value FROM meta WHERE key=?').get('sharedRootCatalog').value
  values[0]=['failed'];failTransaction=true
  await assert.rejects(runtime.refreshKnownSharedTagsFromMetadata(roots),/injected disk/);failTransaction=false
  assert.deepEqual(tags(),['stable']);assert.equal(db.prepare('SELECT value FROM meta WHERE key=?').get('sharedRootCatalog').value,rawBefore)
  passed('tags and root provenance rollback atomically on write failure')
  values[0]=['old'];blocked={gate:deferred(),enter:deferred()};let wait=blocked
  const stale=runtime.refreshKnownSharedTagsFromMetadata(roots);await wait.enter.promise
  values[0]=['latest'];await expect(['latest']);wait.gate.resolve();await stale;assert.deepEqual(tags(),['latest'])
  values[0]=['late'];blocked={gate:deferred(),enter:deferred()};wait=blocked
  const late=runtime.refreshKnownSharedTagsFromMetadata(roots);await wait.enter.promise
  state.markStartupPathRootUnavailable(roots[0],Error('offline during read'));wait.gate.resolve();await late;assert.deepEqual(tags(),['latest'])
  passed('older requests and invalidated root generations cannot publish')
  // A genuine empty directory has no metadata file; the current reader confirms ENOENT + readable root.
  reload();deps.runRustSharedMetadataKnownTags=async({roots:input})=>({knownTags:[],roots:input.map(r=>({...r,signature:'metadata:none',knownTags:[],rows:0}))})
  await expect([])
  passed('real empty directory is distinct from metadata read failure')
  db.prepare('INSERT INTO tags VALUES (?,?)').run('keep-on-error',0)
  deps.runRustSharedMetadataKnownTags=async()=>{throw Error('EIO')}
  await expect(['keep-on-error']);await assert.rejects(runtime.refreshKnownSharedTagsFromMetadata(roots,{requireFresh:true}),/未成功/)
  passed('Rust transport failure preserves directory and does not silently enable fallback')
  // Explicit compatibility uses actual metadata SQLite handles; malformed JSON is an error, not empty.
  const metadataPaths=roots.map(r=>path.join(r,'metadata.sqlite'))
  for(const file of metadataPaths){const m=new DatabaseSync(file);m.exec('CREATE TABLE font_metadata(tag_names_json TEXT)');m.prepare('INSERT INTO font_metadata VALUES (?)').run('["bound"]');m.close()}
  let opened=0,closed=0
  deps.openSharedMetadataDb=async r=>{opened++;return new DatabaseSync(path.join(r,'metadata.sqlite'))}
  deps.closeSqliteDb=m=>{closed++;m.close()}
  const compatLoad=loader({}, {process:{...process,env:{...process.env,HFM_NODE_STATE_FALLBACK:'1'}}},transforms)
  runtime=compatLoad(tagsFile).createSharedKnownTagsRuntime(deps);state=compatLoad(stateFile)
  await expect(['keep-on-error']);assert.equal(opened,0)
  passed('explicit compatibility cannot reopen SQLite after failed Rust read')
  // The original compatibility controls still run when no Rust read port is supplied.
  deps.runRustSharedMetadataKnownTags=undefined
  await expect(['bound'])
  const malformed=new DatabaseSync(metadataPaths[1]);malformed.prepare('UPDATE font_metadata SET tag_names_json=?').run('{bad');malformed.close()
  const empty=new DatabaseSync(metadataPaths[0]);empty.exec('DELETE FROM font_metadata');empty.close()
  await expect(['bound']);await assert.rejects(runtime.refreshKnownSharedTagsFromMetadata(roots,{requireFresh:true}),/不能确认/)
  assert.equal(opened,closed)
  passed('explicit Node compatibility: real reads, corrupt root retained, all borrowed handles closed')
  db.prepare('INSERT INTO tags VALUES (?,?)').run('unbound',1)
  const denied=await runtime.deleteKnownSharedTagIfUnbound(roots,'unbound');assert.equal(denied.deleted,false);assert(tags().includes('unbound'))
  const fixed=new DatabaseSync(metadataPaths[1]);fixed.exec('DELETE FROM font_metadata');fixed.close()
  assert.equal((await runtime.renameKnownSharedTagIfUnbound(roots,'unbound','renamed')).renamed,true)
  assert(tags().includes('renamed'));assert(!tags().includes('unbound'))
  assert.equal((await runtime.deleteKnownSharedTagIfUnbound(roots,'renamed')).deleted,true)
  assert(!tags().includes('renamed'));await expect([]);assert.equal(opened,closed)
  passed('zero-binding rename/delete: failures deny, successful explicit removal never resurrects')
  db.close()
}
async function main(){
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'hfm-root-retention-'))
  try {if(!old)await stateCases();await catalogCases(dir)} finally {await fsp.rm(dir,{recursive:true,force:true})}
  if(!old&&!crlf){
    const result=spawnSync(process.execPath,[__filename,'--baseline'],{encoding:'utf8'})
    assert.equal(result.status,1);assert.match(result.stderr,/AssertionError/);assert.match(result.stderr,/legacy/);passed('historical production owner rejected by current retention assertion')
  }
  console.log(JSON.stringify({passed:cases.length,cases,crlf}))
}
main().catch(e=>{console.error(e);process.exitCode=1})
