#!/usr/bin/env node
// F02 production identity acceptance using actual Windows Rust and Electron.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process')
assert.equal(process.platform, 'win32', 'F01 reproduction requires Windows; no simulated platform')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const worker = path.resolve(root, process.env.HFM_TEST_NATIVE_WORKER || 'native-src/hfm-core-worker/target/release/hfm-core-worker.exe')
assert(fs.existsSync(worker), 'real Rust worker required')
const output = path.resolve(root, 'artifacts/font-identity-f01')
fs.mkdirSync(output, { recursive: true })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-identity-'))
const report = { phase:'F02-production-identity', platform:process.platform, commit:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), repaired:true, observations:{}, limits:['Temporary local roots, not a real SMB or drive mapping.', 'Fixture index metadata; no scan, install, activation or delete of system fonts.', 'User screenshot database not supplied.'] }
try {
  const roots = ['root-a','root-b','root-c'].map(name => path.join(temp,name))
  const source = path.join(process.env.WINDIR, 'Fonts', 'arial.ttf')
  assert(fs.existsSync(source),'Windows font fixture source required')
  for(const dir of roots) {
    fs.mkdirSync(dir,{recursive:true}); const dest=path.join(dir,'same.ttf')
    fs.copyFileSync(source,dest);fs.utimesSync(dest,1700000000,1700000000)
  }
  const stats=roots.map(dir=>fs.statSync(path.join(dir,'same.ttf')))
  assert(stats.every(s=>s.size===stats[0].size && s.mtimeMs===stats[0].mtimeMs))
  const dbPath=path.join(temp,'merged.sqlite'), libraryPath=path.join(temp,'library.sqlite')
  const db=new DatabaseSync(dbPath), library=new DatabaseSync(libraryPath)
  library.exec('CREATE TABLE local_font_favorites(font_id TEXT, font_path TEXT, favorite INTEGER); CREATE TABLE local_font_tags(font_id TEXT, font_path TEXT, tag_name TEXT)')
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('schemaVersion','8');
    INSERT INTO meta VALUES('sourcesKey','fixture-v2');
    INSERT INTO meta VALUES('installEvidenceVersion','content-v1');
    CREATE TABLE sources(root_path TEXT PRIMARY KEY,index_db_path TEXT,install_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT,synced_at TEXT);
    CREATE TABLE entries(root_path TEXT,relative_path TEXT,cache_key TEXT,file_size INTEGER,modified_at REAL,created_at REAL,status TEXT,font_json TEXT,message TEXT,cached_at TEXT,is_deleted INTEGER,installed INTEGER,installed_by TEXT,matches_json TEXT,category_index TEXT,search_text TEXT,PRIMARY KEY(root_path,relative_path));`)
  for(const [i,dir] of roots.entries()) {
    db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(dir,'fixture-index','fixture-install','fixture','fixture','metadata:none','fixture')
    if(i===1) library.prepare('INSERT INTO local_font_tags VALUES (?,?,?)').run('source-1',path.join(dir,'same.ttf').replaceAll('/', '\\').toLowerCase(),'私有%_标记')
    const font={id:`source-${i}`,path:path.join(dir,'same.ttf'),fileName:'same.ttf',family:'Arial',fullName:'F01 same',format:'ttf',tagNames:[],scripts:['latin']}
    db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(dir,'same.ttf',`cache-${i}`,stats[i].size,stats[i].mtimeMs,stats[i].mtimeMs,'ok',JSON.stringify(font),'','fixture',0,i===1?0:1,i===1?'none':'system','[]','sans','f01 same arial')
  }
  db.close();library.close()
  // Replace only build-time environment syntax; run actual runtime helpers.
  const load=loader({react:{}}, {}, {
    [path.join(root,'src/renderer/src/constants/environmentConstants.ts')]: source=>source.replace(/import\.meta/g, '({})')
  })
  const sqlBuilder=load('src/main/indexing/root-query/mergedIndexPageQuerySql.ts').buildMergedIndexQuerySql
  function query(kind='all',offset=0,limit=100,keyword='',scope={}) {
    const request={sidebarPage:'library',activeFilter:{kind},installStatus:'all',sortMode:'nameAsc',keyword,offset,limit,...scope}
    const input={queryKey:JSON.stringify(request),request,offset,limit,roots,mergedIndexDbPath:dbPath,libraryDbPath:libraryPath,schemaVersion:8,sql:sqlBuilder(request,limit,offset)}
    const file=path.join(temp,'query.json');fs.writeFileSync(file,JSON.stringify(input))
    const result=cp.spawnSync(worker,['--merged-index-query-page','--input',file],{encoding:'utf8',timeout:30000,windowsHide:true})
    if(result.error)throw result.error
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr)
    const parsed=JSON.parse(result.stdout.trim());assert.equal(parsed.ok,true);return parsed
  }
  function queryIds() {
    const request={sidebarPage:'library',activeFilter:{kind:'all'},sortMode:'nameAsc'}
    const sql=load('src/main/indexing/root-query/mergedIndexPageQuerySql.ts').buildMergedIndexIdsQuerySql(request,100)
    const file=path.join(temp,'ids.json');fs.writeFileSync(file,JSON.stringify({queryKey:'ids',request,limit:100,roots,mergedIndexDbPath:dbPath,libraryDbPath:libraryPath,schemaVersion:8,sql}))
    const result=cp.spawnSync(worker,['--merged-index-query-ids','--input',file],{encoding:'utf8',timeout:30000,windowsHide:true})
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr)
    const parsed=JSON.parse(result.stdout.trim());assert.equal(parsed.ok,true);return parsed.ids
  }
  const all=query(), installed=query('installed'), notInstalled=query('notInstalled'), absent=query('all',0,100,'not-a-font-f01')
  assert.deepEqual(queryIds().sort(),all.items.map(font=>font.id).sort(),'Rust SQL IDs disagree with row conversion')
  assert.equal(all.items.length,3);assert.equal(new Set(all.items.map(f=>f.path)).size,3)
  assert.equal(new Set(all.items.map(f=>f.id)).size,3,'production IDs must isolate all roots')
  assert.equal(installed.items.length,2);assert.equal(notInstalled.items.length,1);assert.equal(absent.items.length,0)
  assert(installed.items.every(f=>f.systemInstalled));assert(notInstalled.items.every(f=>!f.systemInstalled))
  for(const sidebarPage of ['library','tags','folders','filters']) {
    const tagged=query('all',0,100,'私有%_标记',{sidebarPage})
    assert.equal(tagged.total,1,'Rust local tag search/count '+sidebarPage)
    assert.equal(tagged.items[0].path,path.join(roots[1],'same.ttf'))
    assert.equal(query('all',0,100,'absent-token',{sidebarPage}).total,0)
  }
  assert.equal(query('all',0,100,'已安装').total,2,'Rust live install search')
  assert.equal(query('all',0,100,'未安装').total,1,'Rust live not-installed search')
  const page1=query('all',0,2),page2=query('all',2,2)
  const pageRuntime=load('src/renderer/src/runtime/database/useRendererDatabasePageRuntime.ts')
  const merged=pageRuntime.mergeIncrementalDatabasePage(page1,page2)
  assert.equal(merged.items.length,3,'production pagination must retain every path')
  const libRuntime=load('src/renderer/src/library-normalize/libraryNormalizeStateRuntime.ts')
  const base=load('src/renderer/src/library-normalize/libraryNormalizeBase.ts').createEmptyLibrary()
  const mergedLibrary=libRuntime.libraryWithMergedFonts(base,all.items)
  assert.equal(Object.keys(mergedLibrary.fonts).length,3,'production dictionary must retain every path')
  report.observations.native={rows:all.items.map(f=>({id:f.id,sourceId:f.sourceId,path:f.path,installed:f.systemInstalled})), distinctPaths:3,distinctIds:3,installedRows:2,notInstalledRows:1,searchAbsentRows:0,pagination:{before:page1.items.length+page2.items.length,after:merged.items.length,total:merged.total},dictionaryRows:Object.keys(mergedLibrary.fonts).length}
  // Verify the production Rust IDs against the TypeScript contract, without rewriting inputs.
  const {fileRuntimeFontId}=load('src/main/fonts/fontFileIdentity.ts')
  const vectors=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/font-file-identity.json'),'utf8'))
  for(const vector of vectors) assert.equal(fileRuntimeFontId(vector.path,vector.size,vector.mtimeMs),vector.expected)
  assert.throws(()=>fileRuntimeFontId('same.ttf',1234,1))
  assert.throws(()=>fileRuntimeFontId('C:\\a\\..\\same.ttf',1234,1))
  for(const font of all.items) assert.equal(font.id,fileRuntimeFontId(font.path,font.fileSize,font.modifiedAt))
  const scoped=all.items
  assert.equal(new Set(scoped.map(font=>font.id)).size,3)
  assert.deepEqual(scoped.map(font=>font.sourceId),all.items.map(font=>font.sourceId))
  const candidatePage=pageRuntime.mergeIncrementalDatabasePage({...page1,items:scoped.slice(0,2)},{...page2,items:scoped.slice(2)})
  assert.equal(candidatePage.items.length,3)
  const candidateLibrary=libRuntime.libraryWithMergedFonts(base,scoped)
  assert.equal(Object.keys(candidateLibrary.fonts).length,3)
  report.observations.identityCandidate={productionEnabled:true,vectorCount:vectors.length,distinctIds:3,paginationRows:candidatePage.items.length,dictionaryRows:Object.keys(candidateLibrary.fonts).length,sourceIdsPreserved:true}
  fs.writeFileSync(path.join(output,'native.json'),JSON.stringify(all.items))
  const bundle=require('esbuild').buildSync({entryPoints:[path.join(__dirname,'lib/font-identity-reproduction-dom.tsx')],bundle:true,write:false,format:'iife',platform:'browser',alias:{'@shared':path.join(root,'src/shared')},define:{'process.env.NODE_ENV':'"development"','import.meta.env':'{}'}}).outputFiles[0].text
  const html=path.join(temp,'identity.html')
  fs.writeFileSync(html,'<!doctype html><meta charset="utf-8"><div id="fixture"></div><script>window.nativeFonts='+JSON.stringify(all.items).replace(/</g,'\\u003c')+';window.scopedFonts='+JSON.stringify(scoped).replace(/</g,'\\u003c')+';</script><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>')
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const dom=cp.spawnSync(require('electron'),[path.join(__dirname,'lib/font-identity-reproduction-electron.cjs'),html,output],{cwd:root,env,encoding:'utf8',timeout:90000})
  process.stdout.write(dom.stdout||'');process.stderr.write(dom.stderr||'');if(dom.error)throw dom.error
  assert.equal(dom.status,0,'Electron reproduction did not establish expected production behavior')
  report.observations.dom=JSON.parse(fs.readFileSync(path.join(output,'dom.json'),'utf8'))
  report.status='production-identity-accepted'
  console.log('[F02] Production identity and UI acceptance passed.')
} catch(error) {
  report.status='reproduction-incomplete';report.error=String(error.stack||error);process.exitCode=1
  console.error(error)
} finally {
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  fs.rmSync(temp,{recursive:true,force:true})
}
