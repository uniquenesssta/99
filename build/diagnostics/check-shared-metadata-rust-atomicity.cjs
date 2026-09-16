'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const root=path.resolve(__dirname,'../..')
const file='native-src/hfm-core-worker/src/shared_metadata/state_machine.rs'
function check(source,signature) {
  source=source.replace(/\r\n/g,'\n')
  for (const [name,end] of [['apply_on_connection','pub fn remove_shared_metadata_tag_state_machine'],['remove_on_connection','fn find_targets']]) {
    const start=source.indexOf(`fn ${name}(`);assert(start>=0,name)
    const body=source.slice(start,source.indexOf(end,start))
    const lock=body.indexOf('transaction_with_behavior(TransactionBehavior::Immediate)');assert(lock>=0)
    if(name==='remove_on_connection')assert(body.indexOf('find_targets(&tx,')>lock)
    const tail=body.slice(body.indexOf('set_meta(&tx, "updatedAt"'))
    let previous=-1
    for(const token of ['set_meta(&tx, "updatedAt"','set_meta(&tx, "writerHost"','set_meta(&tx, "rootPath"','shared_metadata_signature_for_transaction(&tx)','tx.commit()','trace.committed()','mutation_state_signal(','trace.finish(']) {const index=tail.indexOf(token);assert(index>previous,`${name}: ${token}`);previous=index}
    assert.equal((body.match(/tx\.commit\(\)/g)||[]).length,1)
    assert(!/set_meta\(&conn|signature_for_transaction\(&conn|find_targets\(&conn/.test(body))
  }
  assert(signature.includes('read_meta(tx, "updatedAt")?.unwrap_or_default()'))
  assert(signature.includes('[key], |row| row.get(0)).optional()'))
  const algorithms=source.slice(source.indexOf('fn find_targets(')).split('#[cfg(test)]')[0].trim()
  assert.equal(require('node:crypto').createHash('sha256').update(algorithms).digest('hex'),'fcf08cda5da43d6608401e0a938cda04405a0a9fa6114f2d6d0a8a422a76f2c3','merge, revision/op IDs and signal algorithms unchanged')
}
async function main() {
  const source=fs.readFileSync(path.join(root,file),'utf8'), signature=fs.readFileSync(path.join(root,'native-src/hfm-core-worker/src/shared_metadata/signature.rs'),'utf8')
  check(source,signature);check(source.replace(/\n/g,'\r\n'),signature)
  for(const mutate of [
    s=>s.replace('set_meta(&tx, "updatedAt"','set_meta(&conn, "updatedAt"'),
    s=>s.replace('set_meta(&tx, "writerHost"','set_meta(&conn, "writerHost"'),
    s=>s.replace('shared_metadata_signature_for_transaction(&tx)','shared_metadata_signature_for_transaction(&conn)'),
    s=>s.replace('find_targets(&tx,','find_targets(&conn,'),
    s=>s.replace('TransactionBehavior::Immediate','TransactionBehavior::Deferred'),
    s=>s.replace('    tx.commit().map_err(|error| error.to_string())?;\n    trace.committed();','    trace.committed();\n    tx.commit().map_err(|error| error.to_string())?;')
  ])assert.throws(()=>check(mutate(source),signature))
  assert.throws(()=>check(source,signature.replace('read_meta(tx, "updatedAt")?','read_meta(conn, "updatedAt")')))
  await postCommit()
  await assert.rejects(()=>postCommit({[path.join(root,'src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts')]:s=>s.replaceAll('appendAfterCommit(`','runtimeDeps.appendStartupLog(`')}),/committed result/)
  console.log('[diagnostics:shared-metadata-rust-atomicity] structure/algorithm freeze, LF/CRLF, 12 real TS scenarios and 8 mutations passed; native tests require --native')
}
async function postCommit(transforms={}) {
  const {loader}=require('./check-operation-chain.cjs')
  const runtimeFile='src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts'
  for(const method of ['updateSharedFontMetadataEntries','renameSharedTagInMetadataIndexes','removeSharedTagFromMetadataIndexes']) {
    for(const fail of [false,true,'offline','lease']) {
      let writes=0,nodeWrites=0,signals=0,closed=0
      const font={id:'a',path:'/root/a.ttf',fileName:'a.ttf',tagNames:['old'],favorite:true,deleteProtected:true}
      const run=async()=>{writes++;if(fail===true)throw Error('native outcome unknown');return {ok:true,written:1,updated:1,changedIds:['a'],updatedIds:['a'],stateSignal:{changedIds:['a'],sharedMetadataChanged:true}}}
      const runtimeDeps={
        uniqueResolvedFolders:x=>x,findBestWatchedRootForFile:()=>'/root',
        loadExistingFolderCache:async()=>{if(fail==='offline')throw Error('root offline');return {cache:{entries:{'a.ttf':{path:'a.ttf',status:'ok',font}}}}},
        cacheKeyForRootFile:()=> 'a.ttf',cacheEntryRuntimePath:()=>'/root/a.ttf',normalizePathForCacheCompare:x=>x,
        runRustSharedMetadataApply:run,runRustSharedMetadataRemoveTag:run,
        appendStartupLog(){throw Error('log disk failure')},onSharedMetadataMutationStateSignal(){signals++;throw Error('notification failure')},
        closeSqliteDb(){closed++}
      }
      const load=loader({}, {}, transforms)
      const runtime=load(runtimeFile).createSharedMetadataMutationRuntime({runtimeDeps,
        ensureLegacyMetadataImported:async()=>{},withSharedMetadataWriteLock:async(_,fn)=>{if(fail==='lease')throw Error('lease unavailable');return fn()},
        openSharedMetadataDb:async()=>({prepare:()=>({all:()=>[{font_id:'a',tag_names_json:'["old"]',favorite:1,delete_protected:1,revision:1}],run(){nodeWrites++;throw Error('unexpected Node replay')}}),exec(){nodeWrites++;throw Error('unexpected Node replay')}}),
        writeMeta(){nodeWrites++;throw Error('unexpected Node replay')}
      })
      const result=method==='updateSharedFontMetadataEntries'
        ? await runtime[method]({items:[font],watchedFolders:['/root'],mergePolicy:'favorite',mutateFont:f=>({...f,favorite:false})})
        : method==='renameSharedTagInMetadataIndexes' ? await runtime[method]('old','new',['/root']) : await runtime[method]('old',['/root'])
      assert.equal(writes,typeof fail==='string'?0:1);assert.equal(nodeWrites,0)
      assert.equal(result.failed.length,fail?1:0,`${method}: committed result must survive logging failure`)
      assert.deepEqual(Array.from(result.updatedIds),fail?[]:['a']);assert.equal(signals,fail?0:1)
      assert.equal(closed,method==='renameSharedTagInMetadataIndexes'&&typeof fail!=='string'?1:0)
    }
  }
}

function native() {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const manifest = path.join(root, 'native-src/hfm-core-worker/Cargo.toml')
  function cargo(args, env = process.env) {
    const result = spawnSync('cargo', args, { cwd:root, encoding:'utf8', env })
    if (result.error) throw result.error
    return result
  }
  const current = cargo(['test', '--manifest-path', manifest, 'shared_metadata_atomicity'])
  process.stdout.write(current.stdout); process.stderr.write(current.stderr)
  assert.equal(current.status, 0, 'native corrected implementation must pass')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-r03-mutant-'))
  try {
    // Feed an actual native receipt through the production signal runtime and R-01 validator.
    const metadata = cargo(['metadata','--manifest-path',manifest,'--no-deps','--format-version','1'])
    assert.equal(metadata.status,0)
    const binary = path.join(JSON.parse(metadata.stdout).target_directory, 'debug', process.platform === 'win32' ? 'hfm-core-worker.exe' : 'hfm-core-worker')
    const input = path.join(dir,'trace-input.json'), dbPath = path.join(dir,'trace.sqlite')
    fs.writeFileSync(input, JSON.stringify({dbPath,updatedAt:'r03-native',rows:[{fontId:'a',tagNamesJson:'[\"new\"]',favorite:true}],trace:{version:1,sessionId:'r03',operationId:'intent',attemptId:'attempt',batchId:'batch',domain:'sharedMetadata',members:['intent'],omitted:0,spanId:'native-span'}}))
    const receipt = spawnSync(binary,['--shared-metadata-apply','--input',input],{encoding:'utf8'})
    if(receipt.error) throw receipt.error
    assert.equal(receipt.status,0,receipt.stderr)
    const events = receipt.stderr.split(/\r?\n/).filter(s=>s.startsWith('operation-chain: ')).map(s=>JSON.parse(s.slice(17)))
    const {loader,validateNativeStages} = require('./check-operation-chain.cjs')
    const appendStartupLog = s=>{if(s.startsWith('operation-chain: '))events.push(JSON.parse(s.slice(17)))}
    const load=loader({electron:{BrowserWindow:{getAllWindows:()=>[]}}})
    const oldDetail=process.env.HFM_LOG_DETAIL
    try {
      process.env.HFM_LOG_DETAIL='debug'
      const tagMetadataRevisionBarrier=load('src/main/library/tagMetadataRevisionBarrierRuntime.ts').createTagMetadataRevisionBarrierRuntime({appendStartupLog})
      const signals=load('src/main/library/tagMutationStateSignalRuntime.ts').createTagMutationStateSignalRuntime({tagMetadataRevisionBarrier,appendStartupLog,clearFontQueryCaches(){}})
      signals.handleSharedMetadataMutationStateSignal(JSON.parse(receipt.stdout).stateSignal)
      validateNativeStages(events)
      console.log('[native:shared-metadata-rust-atomicity] actual worker receipt -> production signal -> R-01 causal validator passed')
    } finally { if(oldDetail===undefined)delete process.env.HFM_LOG_DETAIL;else process.env.HFM_LOG_DETAIL=oldDetail }
    const origin = path.dirname(manifest)
    for (const name of ['src', 'tests', 'Cargo.toml', 'Cargo.lock']) fs.cpSync(path.join(origin,name), path.join(dir,name), {recursive:true})
    const target = path.join(dir,'src/shared_metadata/state_machine.rs')
    const source = fs.readFileSync(path.join(root,file),'utf8')
    const old = execFileSync('git', ['show', `cee79701ca72e63a4d829fdcccf93b099d449886:${file}`], {cwd:root,encoding:'utf8'})
    const line = '    set_meta(&tx, "updatedAt", &payload.updated_at).map_err(|error| error.to_string())?;'
    const mutant = source.replace(line, '').replace('    trace.committed();', '    trace.committed();\n' + line.replace('&tx', '&conn'))
    assert.notEqual(mutant, source)
    for (const [label,text] of [['pre-fix',old],['metadata-after-commit',mutant]]) {
      fs.writeFileSync(target,text)
      const result = cargo(['test','--manifest-path',path.join(dir,'Cargo.toml'),'--test','shared_metadata_atomicity','shared_metadata_atomicity_faults_restore_rows_ops_events_and_meta','--','--nocapture'], {...process.env,CARGO_TARGET_DIR:path.join(origin,'target/r03-negative')})
      const output = result.stdout + result.stderr
      assert.notEqual(result.status,0, `${label} must fail`)
      assert(output.includes('updatedAt leaked partial writes'), `${label} must fail on database assertion, not compilation: ${output}`)
      console.log(`[native:shared-metadata-rust-atomicity] ${label}: actual metadata rollback assertion rejected`)
    }
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
}
if (require.main === module) main().then(()=>{if(process.argv.includes('--native'))native()}).catch(e=>{console.error(e);process.exitCode=1})
module.exports = { check }
