#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const indexFile = 'src/main/watcher/watchedFolderIndexRuntime.ts'
const plain = x => JSON.parse(JSON.stringify(x))
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const drain = async () => { for (let i=0;i<30;i++) await Promise.resolve() }
function load(file, mocks = {}, globals = {}, transform = s => s) {
  const exports = {}
  const code = ts.transpileModule(transform(read(file)), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  vm.runInNewContext(code, { exports, console, process, ...globals, require(id) {
    if (Object.hasOwn(mocks,id)) return mocks[id]
    if (id==='node:path') return path
    if (id.startsWith('.')) return load(path.relative(root,path.resolve(root,path.dirname(file),id+'.ts')),mocks,globals)
    throw Error(`Unmocked dependency ${file} -> ${id}`)
  } }, { filename:file })
  return exports
}
const fail = code => Object.assign(Error(code), { code })
async function indexCase(mode, transform = s => s) {
  const folder = path.resolve('/fonts'), file = path.join(folder,'a.ttf')
  const existing = { status:'ok', font:{ id:'a',path:file,favorite:true },cacheKey:'old' }
  const cache = { entries:{ 'a.ttf':existing } }, writes = [], directoryWrites = []
  const context = { cache, directoryUpdates:[] }
  const stat = async p => {
    if (p===folder) { if(mode==='offline') throw fail('ENOENT'); return { isDirectory:()=>true, isFile:()=>false,mtimeMs:2 } }
    if(['ENOENT','ENOTDIR','EACCES','ETIMEDOUT','offline'].includes(mode)) throw fail(mode==='offline'?'ENOENT':mode)
    return { isDirectory:()=>false,isFile:()=>true }
  }
  const runtime = load(indexFile, {
    'node:fs':{promises:{stat,readdir:async()=>[]}},
    '../cache/cachePaths':{fileCacheSignature:()=>'',isIgnoredInternalDirectoryName:()=>false,isRootIndexDbPath:()=>true}
  },{},transform).createWatchedFolderIndexRuntime({
    isIgnoredWatcherPath:()=>false, fontExtensions:new Set(['.ttf']), withGlobalIo:(_label,fn)=>fn(),
    ensureRootScanCacheStorage:async()=>({cachePath:'/index.db',storage:'root'}),makeRootScanCacheContext:()=>context,
    readRootDirectorySignatures:async()=>new Map(),relativeDirectoryPathForRoot:()=>'',
    cacheKeyForRootFile:()=> 'a.ttf',cacheKeyInsideDirectory:()=>true,
    listFontFilesWithDirectoryCache:async (_ctx,errors)=>{ context.directoryUpdates.push({relativePath:''}); if(mode==='partial-list')errors.push({path:folder,message:'EACCES'});return [] },
    upsertFontIndexEntry:async()=>{ if(mode==='parse-ENOENT')throw fail('ENOENT'); if(mode==='parse')throw Error('metadata'); cache.entries['a.ttf']={...existing,cacheKey:'new'};return existing.font },
    fontIndexEntryChanged:(a,b)=>a!==b,fontIndexDeleteRecord:(_root,key)=>({path:file,relativePath:key,id:'a'}),
    removeFontIndexEntriesForPath:()=>[{path:file,relativePath:'a.ttf',id:'a'}],
    saveRootIndexSqliteChanges:async(_db,_root,_storage,changed,deleted)=>writes.push(plain({changed,deleted})),
    saveRootDirectorySignatures:async()=>directoryWrites.push(true),appendStartupLog(){}
  })
  const payload = await runtime.applyWatchedFolderChangesToIndex([{folder,eventType:'rename',fileName:mode.includes('list')?'.':'a.ttf',receivedAt:0}])
  return {payload:plain(payload),writes,directoryWrites,remaining:Object.keys(cache.entries)}
}
async function deletionCheck(transform = s => s) {
  for(const mode of ['EACCES','ETIMEDOUT','offline','parse','parse-ENOENT','partial-list']) {
    const r=await indexCase(mode,transform)
    assert.deepEqual(r.payload.deletes,[],mode)
    assert.deepEqual(r.remaining,['a.ttf'],mode)
    assert.equal(r.writes.length,0,mode)
    assert.equal(r.directoryWrites.length,0,mode)
    assert(r.payload.errors.length>0,mode+' must surface error')
  }
  for(const mode of ['ENOENT','ENOTDIR','complete-list']) {
    const r=await indexCase(mode,transform);assert.equal(r.payload.deletes.length,1,mode);assert.deepEqual(r.remaining,[])
  }
  const r=await indexCase('changed',transform);assert.equal(r.payload.upserts.length,1);assert.equal(r.writes.length,1)
}
async function main(){ await deletionCheck();
  await assert.rejects(()=>deletionCheck(s=>s.replace('if (!confirmedMissing) {','if (false) {')),assert.AssertionError)
  await assert.rejects(()=>deletionCheck(s=>s.replace('if (errors.length > errorCount) return false','')),assert.AssertionError)
console.log('[diagnostics:watcher-index-consistency] stat/parse errors and incomplete listing retain index; confirmed deletes and updates pass') }
main().catch(e=>{console.error(e);process.exitCode=1})
