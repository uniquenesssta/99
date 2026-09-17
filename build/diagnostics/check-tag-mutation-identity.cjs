#!/usr/bin/env node
// R-06: load production signal/barrier/adapters. Replace Electron and clock only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { loader, chain } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const signalFile = 'src/main/library/tagMutationStateSignalRuntime.ts'
const identityFile = 'src/main/library/tagMutationSignalIdentityRuntime.ts'
const localEffects = 'src/main/library/runtime/localFontTagMutationEffectsRuntime.ts'
const sharedEffects = 'src/main/indexing/shared-metadata/sharedMetadataMutationSignalRuntime.ts'
const plain = value => JSON.parse(JSON.stringify(value))
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const base = { mutationId:'commit:1', mutationKind:'set', dbPath:'/db/a', rootPath:'/root/a', updatedAt:'same-time', changedIds:['a'], knownTags:['tag'], signature:'sig' }
const trace = attemptId => ({version:1,sessionId:'s',operationId:'o',attemptId,batchId:'b',domain:'localTags',members:['o'],omitted:0})
function harness(transforms = {}, throwingLog = false) {
  let now = 1000
  const sent = [], order = [], logs = []
  const load = loader({electron:{BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{send(channel,payload){assert.equal(channel,'font-tags:stateSignal'); order.push('broadcast'); sent.push(plain(payload))}}}]}}}, {performance:{now:()=>now}}, transforms)
  const append = s => { if (throwingLog) throw Error('log unavailable'); logs.push(s) }
  const barrier = load('src/main/library/tagMetadataRevisionBarrierRuntime.ts').createTagMetadataRevisionBarrierRuntime({appendStartupLog:()=>order.push('revision')})
  const runtime = load(signalFile).createTagMutationStateSignalRuntime({tagMetadataRevisionBarrier:barrier,clearFontQueryCaches:()=>order.push('clear'),appendStartupLog:append})
  function send(scope, signal, daemon=false, protocol=false) {
    if (daemon) runtime.handleRustCoreDaemonDomainEvent({domain:scope==='local'?'localTags':'sharedMetadata',...(protocol?{mutationProtocol:{stateSignal:signal}}:{stateSignal:signal})})
    else runtime[scope==='local'?'handleLocalTagsMutationStateSignal':'handleSharedMetadataMutationStateSignal'](signal)
  }
  function count(n) {
    assert.equal(sent.length,n,'new change lost or duplicate delivered')
    assert.equal(barrier.snapshot().localRevision+barrier.snapshot().sharedRevision,n)
    assert.deepEqual(order,Array.from({length:n},()=>['revision','clear','broadcast']).flat(),'revision/cache/broadcast order')
  }
  return {load,send,count,sent,logs,advance:ms=>now+=ms}
}
function originalFaults(transforms={}, collect=false) {
  const failures=[]
  for(const [scope,a,b] of [
    ['shared',{...base,mutationId:undefined,changedIds:[],rootPath:'/root/a'},{...base,mutationId:undefined,changedIds:[],rootPath:'/root/b'}],
    ['local',{...base,mutationId:undefined,changedIds:Array.from({length:81},(_,i)=>`font${i}`)},{...base,mutationId:undefined,changedIds:[...Array.from({length:80},(_,i)=>`font${i}`),'tail']}],
    ['local',{...base,mutationId:undefined,knownTags:['old']},{...base,mutationId:undefined,knownTags:['new']}]
  ]) {const h=harness(transforms);h.send(scope,a);h.send(scope,b);try{h.count(2)}catch(error){if(!collect)throw error;assert.equal(error.name,'AssertionError');failures.push({scope,expected:2,actual:h.sent.length})}}
  if(collect){console.log(JSON.stringify({baselineFailures:failures}));assert.equal(failures.length,3);throw new assert.AssertionError({message:'all three original signal collisions reproduced',actual:3,expected:0})}
}
function semantics(transforms={}) {
  originalFaults(transforms)
  // Same receipt with distinct storage or complete payload must not collide, even if a producer reuses an ID.
  for(const [scope,patch] of [ ['local',{dbPath:'/db/b'}],['shared',{rootPath:'/root/b'}],['shared',{dbPath:'/db/b'}],['local',{knownTags:[]}],['local',{knownTags:undefined}],['shared',{signature:'new'}],['local',{mutationKind:'deleteTag'}],['local',{updatedAt:'later'}],['local',{pageQueryDirty:false}] ]) {
    const h=harness(transforms);h.send(scope,base);h.send(scope,{...base,...patch});h.count(2)
  }
  const ids=Array.from({length:80},(_,i)=>`font${i}`)
  {const h=harness(transforms);h.send('local',{...base,changedIds:[...ids,'a']});h.send('local',{...base,changedIds:[...ids,'b']});h.count(2)}
  for(const scope of ['local','shared']) for(const reverse of [false,true]) {
    const h=harness(transforms)
    const first={...base,changedIds:['b','a','a'],knownTags:['two','one'],trace:trace('attempt-1')}
    const second={...base,changedIds:['a','b'],knownTags:['one','two','one'],trace:trace('attempt-2'),source:reverse?'rust-worker':'rust-daemon'}
    h.send(scope,first,reverse);h.send(scope,second,!reverse,true);h.count(1)
    h.send(scope,{...first,mutationId:'commit:2'});h.count(2) // identical attempt, separate commit
    h.send(scope,first,true);h.count(2) // out-of-order replay of old commit after newer one
  }
  {const h=harness(transforms);h.send('local',base);h.send('shared',base);h.count(2)}
  // No reliable identity/domain: accept conservatively. Empty catalog differs from missing.
  for(const scope of ['local','shared']) for(const patch of [{mutationId:undefined},{mutationId:''},{mutationId:'x'.repeat(1000)},{dbPath:undefined,rootPath:undefined},{mutationKind:undefined},{changedIds:undefined}]) {
    const h=harness(transforms);const s={...base,...patch};h.send(scope,s,true);h.send(scope,s);h.count(2)
  }
  for(const scope of ['local','shared']) {
    const h=harness(transforms); const unchanged={...base,changedIds:[],localTagsChanged:false,sharedMetadataChanged:false,cacheInvalidated:false,pageQueryDirty:false,metricsDirty:false,mergedIndexDirty:false}
    h.send(scope,unchanged);h.count(0)
    h.send(scope,{...unchanged,cacheInvalidated:true});h.count(1)
  }
  {const h=harness(transforms);h.send('local',base);h.advance(59999);h.send('local',base);h.count(1);h.advance(2);h.send('local',base);h.count(2)}
  {const h=harness(transforms);for(let i=0;i<2049;i++)h.send('local',{...base,mutationId:`commit:${i}`});h.count(2049);h.send('local',{...base,mutationId:'commit:2048'});h.count(2049);h.send('local',{...base,mutationId:'commit:0'});h.count(2050)}
  {const h=harness(transforms,true);h.send('local',base);h.send('local',base,true);h.count(1)}
  {const h=harness(transforms);h.send('local',base);h.send('local',base,true);h.send('local',{...base,mutationId:undefined});const logs=h.logs.filter(s=>s.startsWith('tag mutation identity:'));assert.equal(logs.length,3);assert(logs.some(s=>s.includes('decision=duplicate')));assert(logs.some(s=>s.includes('decision=legacy')));assert(logs.every(s=>s.length<180&&!s.includes('/db/')&&!s.includes('tag]')))}
}
function adapters(transforms={}) {
  for(const scope of ['local','shared']) {
    const h=harness(transforms)
    const local=h.load(localEffects).createLocalFontTagMutationEffectsRuntime({librarySqlitePath:()=>base.dbPath,onLocalTagsMutationStateSignal:s=>h.send('local',s)})
    const shared=h.load(sharedEffects)
    function emit(s) {return scope==='local'?local.emitLocalTagsMutationStateSignal('set','same-time',['a'],['tag'],s,s?'rust-worker':'node-fallback'):shared.emitSharedMetadataMutationStateSignal(s=>h.send('shared',s),s,base.rootPath,'set',['a'],s?'rust-worker':'node-fallback')}
    const receipt={...base};if(scope==='local'){delete receipt.rootPath;delete receipt.signature}else delete receipt.knownTags
    h.send(scope,receipt,true);const adapted=emit(receipt);assert.equal(adapted.mutationId,base.mutationId);h.count(1)
    const legacy=emit({...receipt,mutationId:undefined});assert.equal(legacy.mutationId,undefined);h.count(2)
    const node=emit();assert.match(node.mutationId,/^node:[a-f0-9-]{36}$/);h.count(3)
    h.send(scope,node,true);h.count(3)
    const next=emit();assert.notEqual(next.mutationId,node.mutationId);h.count(4)
    const oldMissing=scope==='local'?local.emitLocalTagsMutationStateSignal('set','same-time',['a'],['tag'],undefined,'rust-worker'):shared.normalizeSharedMetadataMutationStateSignal(undefined,base.rootPath,'set',['a'],'rust-worker')
    assert.equal(oldMissing.mutationId,undefined,'adapter must not invent receipts for legacy Rust')
  }
}
async function transportReceipts() {
  const {createHarness,argsFor}=require('./helpers/rustWorkerTransportHarness.cjs')
  for(const [scope,command,method,kind] of [
    ['local','--local-tags-set','runRustLocalTagsSet','set'],
    ['local','--local-tags-delete-tag','runRustLocalTagsDeleteTag','deleteTag'],
    ['shared','--shared-metadata-apply','runRustSharedMetadataApply','apply'],
    ['shared','--shared-metadata-remove-tag','runRustSharedMetadataRemoveTag','removeTag']
  ]) for(const mode of ['oneshot','daemon']) {
    const signal={...base,mutationKind:kind};if(scope==='local'){delete signal.rootPath;delete signal.signature}else delete signal.knownTags
    const payload={ok:true,updatedIds:['a'],changedIds:['a'],written:1,updated:1,knownTags:['tag'],stateSignal:signal,mutationProtocol:{ok:true,domain:scope==='local'?'localTags':'sharedMetadata',mutationKind:kind,changedIds:['a'],knownTags:['tag'],stateSignal:signal}}
    const transport=createHarness({mode,payloads:{[command]:payload}})
    const receipt=await transport.runtime[method](...argsFor(method,transport))
    assert(receipt);assert.deepEqual(plain(receipt.stateSignal),signal,'metadata client stripped receipt identity')
    assert.equal(transport.files.size,0,'temporary command input leaked')
    const h=harness();h.send(scope,signal,true)
    if(scope==='local')h.load(localEffects).createLocalFontTagMutationEffectsRuntime({librarySqlitePath:()=>signal.dbPath,onLocalTagsMutationStateSignal:s=>h.send(scope,s)}).emitLocalTagsMutationStateSignal(kind,signal.updatedAt,receipt.updatedIds,receipt.knownTags,receipt.stateSignal,'rust-worker')
    else h.load(sharedEffects).emitSharedMetadataMutationStateSignal(s=>h.send(scope,s),receipt.stateSignal,signal.rootPath,kind,receipt.changedIds||receipt.updatedIds,'rust-worker')
    h.count(1)
  }
}
function native() {
  const {spawnSync}=require('node:child_process')
  const manifest=path.join(root,'native-src/hfm-core-worker/Cargo.toml')
  function run(command,args,extra={}) {
    const r=spawnSync(command,args,{cwd:root,encoding:'utf8',timeout:120000,...extra})
    if(r.error)throw r.error
    assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout
  }
  process.stdout.write(run('cargo',['test','--manifest-path',manifest],{timeout:600000}))
  const metadata=JSON.parse(run('cargo',['metadata','--manifest-path',manifest,'--no-deps','--format-version','1']))
  const binary=path.join(metadata.target_directory,'debug',process.platform==='win32'?'hfm-core-worker.exe':'hfm-core-worker')
  const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'hfm-r06-native-'))
  try {
    const jobs=[]
    for(const scope of ['local','shared']) {
      const input=path.join(dir,`${scope}.json`),dbPath=path.join(dir,`${scope}.sqlite`)
      const rows=scope==='local'?[{itemId:'a',aliases:['a'],fontPath:'a.ttf',tagNames:['tag']}]:[{fontId:'a',relativePath:'a.ttf',pathKey:'a',tagNamesJson:'["tag"]',favorite:false,deleteProtected:false,mergePolicy:'replace'}]
      fs.writeFileSync(input,JSON.stringify({dbPath,rootPath:dir,updatedAt:'same-time',updatedBy:'test',writerPid:1,rows,trace:trace('same-attempt')}))
      jobs.push({id:scope,type:'submit',args:[scope==='local'?'--local-tags-set':'--shared-metadata-apply','--input',input]})
    }
    // EOF drains the real daemon lane; domain_event and job_finished come from one execution.
    const events=run(binary,['--core-daemon'],{input:jobs.map(j=>JSON.stringify(j)).join('\n')+'\n'}).trim().split(/\r?\n/).map(s=>JSON.parse(s))
    for(const scope of ['local','shared']) {
      const event=events.find(e=>e.id===scope&&e.type==='domain_event')
      const finished=events.find(e=>e.id===scope&&e.type==='job_finished');assert(finished?.ok);assert(event)
      const result=JSON.parse(finished.stdout);const signal=result.stateSignal
      assert.match(signal.mutationId,/^rust:/);assert.deepEqual(event.stateSignal,signal);assert.equal(result.mutationProtocol.stateSignal.mutationId,signal.mutationId)
      for(const reverse of [false,true]) {
        const h=harness()
        const worker=()=>scope==='local'?h.load(localEffects).createLocalFontTagMutationEffectsRuntime({librarySqlitePath:()=>signal.dbPath,onLocalTagsMutationStateSignal:s=>h.send(scope,s)}).emitLocalTagsMutationStateSignal(signal.mutationKind,signal.updatedAt,signal.changedIds,result.knownTags,signal,'rust-worker'):h.load(sharedEffects).emitSharedMetadataMutationStateSignal(s=>h.send(scope,s),signal,signal.rootPath,signal.mutationKind,signal.changedIds,'rust-worker')
        if(reverse){worker();h.send(scope,event.stateSignal,true)}else{h.send(scope,event.stateSignal,true);worker()}h.count(1)
      }
      const reader=new(require('node:sqlite').DatabaseSync)(signal.dbPath)
      try {assert.equal(reader.prepare(scope==='local'?"SELECT tag_name AS tag FROM local_font_tags WHERE font_id='a'":"SELECT tag_names_json AS tag FROM font_metadata WHERE font_id='a'").get().tag,scope==='local'?'tag':'["tag"]')}finally{reader.close()}
    }
    console.log('R-06 native: Cargo tests, actual daemon/worker receipts, two channel orders and second SQLite connection passed')
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
}
async function main() {
  if(process.argv.includes('--native'))return native()
  const baseline=process.argv.find(s=>s.startsWith('--baseline='))?.slice(11)
  if(baseline){const old=execFileSync('git',['show',`${baseline}:${signalFile}`],{cwd:root,encoding:'utf8'});originalFaults({[path.join(root,signalFile)]:()=>old},true);return}
  const files=[signalFile,identityFile,localEffects,sharedEffects]
  for(const crlf of [false,true]) {
    const transforms=Object.fromEntries(files.map(file=>[path.join(root,file),s=>s.replace(/\r\n/g,'\n').replace(/\n/g,crlf?'\r\n':'\n')]))
    semantics(transforms);adapters(transforms)
    for(const [name,from,to] of [
      ['storage domain', 'signal.dbPath, signal.rootPath', "undefined, undefined"],
      ['complete IDs', 'canonicalStrings(signal.changedIds)', 'canonicalStrings(signal.changedIds.slice(0, 80))'],
      ['trace is not identity', 'signal.mutationId,', "(signal as { trace?: { attemptId?: string } }).trace?.attemptId,"],
      ['capacity', 'while (seen.size > 2048)', 'while (seen.size > 9999)'],
      ['expiry', 'now - at > 60_000', 'now - at > 600_000']
    ]) {
      assert(read(identityFile).includes(from),`mutation target missing: ${name}`)
      const mutated={...transforms,[path.join(root,identityFile)]:s=>transforms[path.join(root,identityFile)](s.replace(from,to))}
      assert.throws(()=>semantics(mutated),{name:'AssertionError'},`survived: ${name}/${crlf?'CRLF':'LF'}`)
    }
  }
  await transportReceipts()
  const prev=process.env.HFM_LOG_DETAIL;process.env.HFM_LOG_DETAIL='debug'
  try {for(const runtimePreload of [false,true])for(const failures of [0,2])await chain({runtimePreload,failures,tagIntent:true})} finally {if(prev===undefined)delete process.env.HFM_LOG_DETAIL;else process.env.HFM_LOG_DETAIL=prev}
  console.log('R-06 complete identity: real signal/barrier/adapters, LF+CRLF, 10 rejected mutants, Node SQLite chains passed; Rust/Windows execution separate')
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
