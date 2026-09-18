#!/usr/bin/env node
// O-04 evidence, not acceptance. Default pins the pre-O-04 production modules.
const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const {execFileSync,spawnSync} = require('node:child_process')
const {loader} = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname,'../..')
const baseline = '8e9f42befc95e71ecd92e5ad6d6bd54511c67363'
const current = process.argv.includes('--current'), crlf = process.argv.includes('--crlf')
const copyFile = 'src/main/activation/runtime/fontActivationCopyRuntime.ts'
const batchFile = 'src/main/activation/runtime/fontDeactivationBatchRuntime.ts'
const writeFile = 'src/main/install/status/installStatusWriteRuntime.ts'
const transforms = new Proxy({}, {get:(_,file)=>source=>{
  const relative = path.relative(root,file).replaceAll('\\','/')
  const text = current ? source : execFileSync('git',['show',baseline+':'+relative],{cwd:root,encoding:'utf8'})
  return crlf ? text.replace(/\r?\n/g,'\r\n') : text
}})
const globals = {process:{...process,env:{...process.env,HFM_NODE_BRIDGE_FALLBACK:'1',HFM_NODE_STATE_FALLBACK:'0',HFM_RUST_FULL_MIGRATION:'1'}}}
const normalize = value => String(value).replaceAll('\\','/').toLowerCase()
const noOp = () => {}
function load(mocks={}) { return loader(mocks,globals,transforms) }
function copyDeps(extra={}) {return {normalizePathForCacheCompare:normalize,withGlobalIo:(_,fn)=>fn(),appendStartupLog:noOp,...extra}}
async function main() {
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'hfm-o04-baseline-'))
  const defects=[], controls=[]
  try {
    const source=path.join(dir,'source.ttf'),dest=path.join(dir,'HFM_ACTIVE_copy.ttf')
    await fsp.writeFile(source,'AAAA');await fsp.writeFile(dest,'BBBB')
    const when=new Date('2026-01-01T00:00:00Z');await fsp.utimes(source,when,when);await fsp.utimes(dest,when,when)
    const item={id:'font-a',path:source,fileName:'source.ttf',fullName:'Source',family:'Source'}
    const copy=load()(copyFile).createFontActivationCopyRuntime(copyDeps())
    const reused=await copy.copyTemporaryActiveFontWithTrace(item,dest)
    if(reused==='reused' && await fsp.readFile(dest,'utf8')==='BBBB') defects.push('same-size-time-different-content-reused')
    await fsp.unlink(dest)
    await copy.copyTemporaryActiveFontWithTrace(item,dest)
    assert.equal(await fsp.readFile(dest,'utf8'),'AAAA');controls.push('successful-compatible-copy-is-local')
    await fsp.unlink(dest)
    const injectedFs={...fs,promises:{...fsp,copyFile:async (_source,target)=>{await fsp.writeFile(target,'AA');throw Error('injected source disconnect')}}}
    const partial=load({'node:fs':injectedFs})(copyFile).createFontActivationCopyRuntime(copyDeps())
    await assert.rejects(partial.copyTemporaryActiveFontWithTrace(item,dest),/source disconnect/)
    if(await fsp.readFile(dest,'utf8').catch(()=>null)==='AA') defects.push('failed-copy-leaves-unowned-partial-destination')
    await fsp.unlink(dest)
    const wrongReceipt=load()(copyFile).createFontActivationCopyRuntime(copyDeps({runRustFontActivationFiles:async()=>({copyResults:[{id:'other',source:'other',dest:'other',ok:true,mode:'copied'}]})}))
    let accepted=false
    try {accepted=await wrongReceipt.copyTemporaryActiveFontWithTrace(item,dest)==='copied'} catch {}
    if(accepted && !fs.existsSync(dest)) defects.push('bridge-accepts-unrelated-worker-receipt')
    // Actual deactivation + reconciliation; native side effects are recording ports only.
    const remote={...item,path:'//nas/offline/source.ttf',active:true,managedInstallPath:dest}
    let records=[{fontId:item.id,sourcePath:remote.path,installPath:dest,registryName:'Source (TrueType)',fileName:path.basename(dest)}]
    const calls=[],statusWrites=[]
    let resourceFailure=false
    const deps={ensureWindows:noOp,appendStartupLog:noOp,normalizePathForCacheCompare:normalize,
      loadTemporaryActiveFonts:async()=>({version:1,records}),saveTemporaryActiveFonts:async state=>{records=state.records},
      removeFontResourceSessionBatch:async paths=>{calls.push(...paths);return Object.fromEntries(paths.map(p=>[p,{ok:!resourceFailure,message:'recording port'}]))},
      deleteFontRegistryValuesHKCUBatch:noOp,clearInstalledFontsMemoryCache:noOp,getSystemInstalledFontsCached:async()=>[],
      compareFontInstalledWithList:()=>({installed:false,by:'none',matches:[]}),isTemporaryActiveInstalledRecord:()=>false,
      scheduleActivationInstallStatusSave:(results,items)=>statusWrites.push({results,items}),scheduleBackgroundFontRefreshTail:noOp,
      safeTemporaryActiveFontName:()=>path.basename(dest),temporaryActiveRegistryNameFor:()=> 'Source (TrueType)'}
    const cleanup={queueTemporaryFontFileDeletes:async values=>Object.fromEntries(values.map(v=>[v.installPath,{ok:true,message:'controlled durable queue'}]))}
    const batch=load()(batchFile).createFontDeactivationBatchRuntime(deps,cleanup)
    const result=await batch.deactivateFontSessionsBatch([remote])
    assert.equal(result.deactivated,1);assert.equal(records.length,0);assert.deepEqual(calls,[dest]);controls.push('resource-removal-uses-recorded-local-copy')
    const routed=[],workerWrites=[]
    const writer=load()(writeFile).createInstallStatusWriteRuntime({
      appWatchedFolders:async()=>['//nas/offline'],appendStartupLog:noOp,isCleanWindowsDefaultCompareResult:()=>false,
      saveInstallStatusIndexInWorker:async groups=>{workerWrites.push(...groups);throw Error('network write forbidden after deactivation')},
    },{
      rootForFontPath:async value=>{routed.push(value);return '//nas/offline'},
      installStatusSignature:()=> 'controlled-signature',installStatusDbPathForRoot:async root=>root+'/.cache/machines/test/install.sqlite',
    })
    await assert.rejects(writer.saveInstallStatusIndex(statusWrites[0].results,statusWrites[0].items),/fallback disabled/)
    assert.equal(workerWrites.length,1);assert.equal(workerWrites[0].rows[0].fontId,item.id)
    if(routed.includes(remote.path) && workerWrites[0].dbPath.startsWith('//nas/offline/')) defects.push('post-deactivation-index-save-routes-shared-source')
    const foreign=path.join(dir,'not-managed','permanent.ttf')
    records=[{fontId:item.id,sourcePath:remote.path,installPath:foreign,registryName:'Permanent',fileName:'permanent.ttf'}]
    calls.length=0;resourceFailure=true
    const rejected=await batch.deactivateFontSessionsBatch([remote])
    assert.equal(rejected.failed,1);assert.equal(records.length,1);controls.push('resource-failure-retains-session-record')
    if(calls.includes(foreign)) defects.push('foreign-record-reaches-resource-removal-before-ownership-check')
    const missing=await batch.deactivateFontSessionsBatch([{...remote,id:'other',path:'//nas/offline/other.ttf'}])
    assert.equal(missing.skippedAlreadyActive,1);controls.push('missing-record-does-not-remove-permanent-font')
    if(!current) assert.equal(defects.length,5,'pinned defect evidence changed')
    if(process.argv.includes('--strict')) assert.equal(defects.length,0,'O-04 acceptance blocked: '+defects.join(', '))
    if(!current && !crlf) {
      const check=spawnSync(process.execPath,[__filename,'--crlf'],{cwd:root,encoding:'utf8',timeout:30000})
      assert.equal(check.status,0,check.stdout+check.stderr)
      const strict=spawnSync(process.execPath,[__filename,'--strict'],{cwd:root,encoding:'utf8',timeout:30000})
      assert.equal(strict.status,1);assert.match(strict.stderr,/O-04 acceptance blocked/)
    }
    console.log(`[diagnostics:local-activation-baseline] ${current?'current':baseline}: ${defects.length} observed defects, ${controls.length} controls; ${crlf?'CRLF':'LF'}. Native worker/Windows not executed.`)
    for(const defect of defects) console.log('observed: '+defect)
  } finally {await fsp.rm(dir,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
