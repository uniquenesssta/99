#!/usr/bin/env node
// Real queue/preload/IPC/SQLite/signal/view paths. Only Electron/React and OS ports are replaced.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const os = require('node:os')
const ts = require('typescript')
const { DatabaseSync } = require('node:sqlite')
const root = path.resolve(__dirname, '../..')
const plain = v => JSON.parse(JSON.stringify(v))
function loader(mocks = {}, globals = {}, transforms = {}) {
  const cache = new Map()
  function load(file) {
    file = path.resolve(root, file)
    if (mocks[file]) return mocks[file]
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    let source = fs.readFileSync(file, 'utf8')
    if (transforms[file]) source = transforms[file](source)
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const localRequire = id => {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id.startsWith('node:')) return require(id)
      if (id.startsWith('.') || id.startsWith('@shared/')) {
        let target = id.startsWith('@shared/') ? path.join(root, 'src/shared', id.slice(8)) : path.resolve(path.dirname(file), id)
        if (!target.endsWith('.ts')) target += '.ts'
        return load(target)
      }
      throw Error(`Unmocked port: ${file} -> ${id}`)
    }
    vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, console, Date, Map, WeakMap, Set, Math, Buffer, performance, setTimeout, clearTimeout, process, ...globals }, { filename: file })
    return module.exports
  }
  return load
}
const traceFile = 'src/renderer/src/fontOperationTrace.ts'
const ipcFile = 'src/main/ipc/ipcTraceRuntime.ts'
const signalFile = 'src/main/library/tagMutationStateSignalRuntime.ts'
const tick = () => new Promise(resolve => setImmediate(resolve))

function validateChain(events, expectedAttempts = 1) {
  const queued = events.find(e => e.stage === 'queued'); assert(queued?.trace, 'missing renderer intent')
  const operation = queued.trace.operationId
  const dispatches = events.filter(e => e.stage === 'dispatch' && e.trace?.operationId === operation)
  assert.equal(dispatches.length, expectedAttempts)
  assert.equal(new Set(dispatches.map(e => e.trace.attemptId)).size, expectedAttempts, 'retry reused attempt')
  for (const dispatch of dispatches) {
    const attempt = dispatch.trace.attemptId
    assert(events.some(e => e.stage === 'ipc-start' && e.trace?.attemptId === attempt), 'preload/IPC propagation missing')
  }
  const last = dispatches.at(-1).trace.attemptId
  const stages = events.filter(e => e.trace?.attemptId === last).map(e => e.stage)
  for (const stage of ['backend-start','commit','signal','view-apply','queue-settled']) assert(stages.includes(stage), `missing ${stage}`)
  assert(stages.indexOf('backend-start') < stages.indexOf('commit'), 'commit before execution')
  assert(stages.indexOf('commit') < stages.indexOf('signal'), 'signal before commit')
  assert(stages.indexOf('signal') < stages.indexOf('view-apply'), 'view before signal')
  for (const dispatch of dispatches.slice(0,-1)) assert(!events.some(e => e.stage === 'commit' && e.trace?.attemptId === dispatch.trace.attemptId), 'failed transaction claimed commit')
  return operation
}

async function chain({ failures = 0, runtimePreload = false, transforms = {}, throwingLog = false, tagIntent = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-chain-'))
  const dbPath = path.join(dir, 'test.sqlite'); const db = new DatabaseSync(dbPath)
  const schema = fs.readFileSync(path.join(root, 'src/main/library/runtime/librarySchemaRuntime.ts'), 'utf8')
  for (const table of ['app_state','local_font_tags']) db.exec(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n    \\);`))[0])
  const adapter = { prepare: sql => db.prepare(sql), transaction: fn => () => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error } } }
  const handlers = new Map(), listeners = new Map(), events = [], cleanups = []
  let window = {}, attempts = 0, library = { fonts: { a: { id:'a', path:'/a.ttf', fileName:'a', localTagNames:['new'], favorite:true, deleteProtected:true, tagNames:['shared'] } }, tags:['shared'], localTags:['new'] }
  let committedLibrary, refreshes = 0
  const append = text => { if (throwingLog) throw Error('disk unavailable'); if (text.startsWith('operation-chain: ')) events.push(JSON.parse(text.slice(17))) }
  const electron = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    ipcRenderer: { invoke: (channel, ...args) => Promise.resolve().then(() => handlers.has(channel) ? handlers.get(channel)({sender:{id:1}}, ...args) : true), on: (channel, fn) => listeners.set(channel, fn), removeListener: (channel, fn) => { if (listeners.get(channel)===fn) listeners.delete(channel) } },
    contextBridge: { exposeInMainWorld: (_, api) => { window.hfm = api } },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => listeners.get(channel)?.({}, plain(payload)) } }] }
  }
  const mocks = { electron, react: { useRef: current => ({current}), useEffect: fn => { cleanups.push(fn()) } },
    [path.join(root,'src/main/security/ipcSenderValidation.ts')]: { assertTrustedIpcSender() {} },
    [path.join(root,'src/renderer/src/rendererMemory.ts')]: { rendererMemoryInfo: () => ({}) } }
  const load = loader(mocks, { window }, transforms)
  const context = load('src/main/logging/operationTraceContext.ts')
  // Actual performance receiver route; renderer reporting does not mark user active.
  const perf = load('src/main/performance/rendererInteractionRuntime.ts').createRendererInteractionRuntime({ appendLog: append })
  handlers.set('performance:rendererTrace', (_, payload) => perf.reportPerformanceEvent(payload))
  if (runtimePreload) vm.runInNewContext(load('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource, { require: id => id==='electron' ? electron : require(id), process, Buffer, Date, console })
  else load('src/preload/index.ts')
  const q = load('src/renderer/src/fontWriteQueue.ts'), ft = load(traceFile)
  const writer = await load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts').createLocalFontTagNodePersistenceRuntime(async () => adapter).openWriter()
  const barrier = load('src/main/library/tagMetadataRevisionBarrierRuntime.ts').createTagMetadataRevisionBarrierRuntime({ appendStartupLog() {} })
  const signal = load(signalFile).createTagMutationStateSignalRuntime({ tagMetadataRevisionBarrier:barrier, appendStartupLog:append, clearFontQueryCaches() {} })
  load('src/renderer/src/runtime/app/effects/useFontTagStateSignalEventRuntime.ts').useFontTagStateSignalEventRuntime({ hfm:window.hfm, getCurrentLibrary:()=>library, commitLibraryUpdate:next => { committedLibrary=library=next; return next }, saveLibraryImmediately:async()=>true, refreshDatabaseDerivedState:()=>refreshes++, setStatus(){} })
  load(ipcFile).registerTracedIpcHandler({ appendLog:append }, 'fonts:setLocalTagsBatch', async (_, items) => {
    attempts++
    if (attempts<=failures) db.exec("CREATE TRIGGER fail_tag BEFORE INSERT ON local_font_tags BEGIN SELECT RAISE(ABORT, 'controlled failure'); END;")
    else db.exec('DROP TRIGGER IF EXISTS fail_tag')
    const result = writer.setLocalFontTagsBatch(items, new Date().toISOString())
    db.exec('DROP TRIGGER IF EXISTS fail_tag')
    if (!result.failed.length) signal.handleLocalTagsMutationStateSignal({ mutationKind:'set', changedIds:result.updatedIds, knownTags:result.knownTags, updatedAt:new Date().toISOString(), source:'node-fallback' })
    return { ...result, ok:!result.failed.length, message:'result' }
  })
  try {
    let queue = q.createEmptyQueuedFontWriteState()
    const authority = load('src/renderer/src/fontTagStateAuthorityRuntime.ts')
    if (tagIntent) library.fonts.a = authority.markFontTagsOptimistic(library.fonts.a, 'local', ['new'])
    const entry=ft.trackFontWrite({ item:library.fonts.a, tagNames:['new'] }, 'localTags')
    queue.localTags.set('a',entry)
    for(let i=0;i<=failures;i++) {
      const result=await q.flushQueuedFontWriteQueue({queue,hfm:window.hfm,folders:[]})
      assert.equal(result.wroteCount,i<failures?0:1)
      queue=result.retryQueue
      const reader=new DatabaseSync(dbPath)
      try { assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM local_font_tags').get().n,i<failures?0:1) } finally {reader.close()}
    }
    await tick()
    assert.equal(q.queuedFontWriteCount(queue),0)
    assert.equal(committedLibrary.fonts.a.favorite,true);assert.equal(committedLibrary.fonts.a.deleteProtected,true)
    assert.deepEqual(plain(committedLibrary.fonts.a.tagNames),['shared']);assert.equal(refreshes,1)
    assert.equal(context.currentOperationTrace(),undefined,'context leaked outside invocation')
    if (tagIntent) {
      assert(authority.isFontTagStateDirty(library.fonts.a,'local'),'broadcast cannot confirm the pending token')
      library=authority.captureFontTagReadConfirmation(library)(library,[{...library.fonts.a,localTagNames:['new']}])
      assert(!authority.isFontTagStateDirty(library.fonts.a,'local'),'successful write and accepted read must confirm')
      await tick()
      if (!throwingLog) {
        const intentEvent=events.find(e=>e.stage==='queued')
        const confirmations=events.filter(e=>e.reason==='local-g1-post-ack-read-confirmed')
        assert.equal(confirmations.length,1)
        assert.equal(confirmations[0].trace.operationId,intentEvent.trace.operationId,'confirmation must retain member identity')
      }
    }
    if(!throwingLog) validateChain(events,failures+1)
    for(const dispose of cleanups) dispose?.()
    assert.equal(listeners.size,0,'listener retained after unmount')
    return events
  } finally {db.close();fs.rmSync(dir,{recursive:true,force:true})}
}

async function queueAndLimits() {
  const events=[]
  const window={hfm:{reportPerformanceEvent:async p=>{events.push(JSON.parse(p.details.event));return true}}}
  const load=loader({}, {window}),ft=load(traceFile),q=load('src/renderer/src/fontWriteQueue.ts')
  const queue=q.createEmptyQueuedFontWriteState()
  for(const id of ['a','b']) queue.favorite.set(id,ft.trackFontWrite({font:{id},favorite:true},'favorite'))
  const attempts=[]
  const hfm={setFavorite:async (fonts,folders,favorite,trace)=>{
    attempts.push({ids:fonts.map(f=>f.id),trace:plain(trace)})
    return attempts.length===1?{ok:false,updatedIds:['a'],failed:[{id:'b'}]}:{ok:true,updatedIds:['b'],failed:[]}
  }}
  const first=await q.flushQueuedFontWriteQueue({queue,hfm,folders:[]})
  assert.equal(first.wroteCount,1);assert.equal(first.retryQueue.favorite.size,1)
  await q.flushQueuedFontWriteQueue({queue:first.retryQueue,hfm,folders:[]})
  assert.deepEqual(plain(attempts.map(a=>a.ids)),[['a','b'],['b']])
  assert.notEqual(attempts[0].trace.attemptId,attempts[1].trace.attemptId)
  assert.equal(attempts[0].trace.members[1],attempts[1].trace.members[0])
  const many=Array.from({length:40},()=>ft.trackFontWrite({},'localTags'))
  const batch=ft.dispatchFontWrites(many)
  assert.equal(batch.members.length,16);assert.equal(batch.omitted,24)
  await tick()
  assert.equal(events.filter(e=>e.stage==='dispatch'&&e.trace.batchId===batch.batchId).length,40,'every member must be connected even when envelope truncates')
  const runtimeQueue=q.createEmptyQueuedFontWriteState(),calls=[]
  const runtime=load('src/renderer/src/fontWriteQueueRuntime.ts').createRendererFontWriteQueueRuntime({
    queueRef:{current:runtimeQueue},timerRef:{current:null},retryTimerRef:{current:null},retryAttemptRef:{current:0},activeRef:{current:false},activePromiseRef:{current:null},
    hfm:{setDeleteProtection:async (...args)=>{calls.push(args);return{ok:true,updatedIds:['x'],failed:[]}}},getFolders:()=>[],writeBehindDelayMs:100,writeBehindMaxItems:100,writeBehindMaxBufferBytes:100000,memoryPressure:()=> 'normal',setTimeout:()=>1,clearTimeout(){},setStatus(){},scheduleDatabaseDerivedStateRefresh(){}
  })
  runtime.queueProtectionWrite({id:'x'},true)
  runtime.queueProtectionWrite({id:'x'},false)
  await runtime.flush('test')
  assert.equal(calls.length,1);assert.equal(calls[0][2],false);assert(calls[0][3]?.operationId,'real runtime failed to attach intent')
  assert.equal(runtimeQueue.protection.get('x').font.trace,undefined,'trace persisted in business object')
  await tick();assert(events.some(e=>e.stage==='cancel'))
  // Bounded pending log calls, including a synchronous sink failure and malicious fields.
  const pending=[];window.hfm.reportPerformanceEvent=p=>new Promise(resolve=>pending.push({p,resolve}))
  for(let i=0;i<300;i++) ft.reportFontOperation({stage:'dispatch'})
  assert.equal(pending.length,256)
  for(const p of pending)p.resolve(true)
  await tick()
  let recovered;window.hfm.reportPerformanceEvent=async p=>{recovered=JSON.parse(p.details.event)}
  ft.reportFontOperation({stage:'dispatch'});await tick();assert.equal(recovered.dropped,44)
  window.hfm.reportPerformanceEvent=()=>{throw Error('sink')}
  assert.doesNotThrow(()=>ft.trackFontWrite({},'favorite'))
  window.hfm.reportPerformanceEvent=async p=>{recovered=JSON.parse(p.details.event)}
  ft.reportFontOperation({stage:'dispatch'});await tick();assert(recovered.dropped>0)
  const second=loader({}, {window})(traceFile);const other=second.dispatchFontWrites([second.trackFontWrite({},'localTags')]);assert.notEqual(other.sessionId,batch.sessionId)
  const ctx=load('src/main/logging/operationTraceContext.ts')
  const seen=[]
  await Promise.all([batch,other].map(trace=>ctx.withOperationTrace(trace,()=>{},async()=>{await tick();seen.push(ctx.currentOperationTrace().sessionId)})))
  assert.deepEqual(seen.sort(),[batch.sessionId,other.sessionId].sort());assert.equal(ctx.currentOperationTrace(),undefined)
  // Full-session cap; powers-of-two drop summaries remain bounded and expose loss.
  const records=[];for(let i=0;i<20000;i++)ctx.logOperation({trace:batch,stage:'dispatch'},s=>records.push(s))
  assert(records.some(s=>s.includes('log-capacity')));assert(records.length<20000)
  process.env.HFM_LOG_DETAIL='';let normal=0;ctx.logOperation({trace:batch,stage:'dispatch'},()=>normal++);assert.equal(normal,0);process.env.HFM_LOG_DETAIL='debug'
}

function validatePreviewNativeStages(events, committed = true) {
  const dispatch=events.find(e=>e.stage==='dispatch' && e.trace?.domain==='previewCache')
  assert(dispatch, 'missing preview dispatch')
  const linked=events.filter(e=>e.trace?.operationId===dispatch.trace.operationId && e.trace?.attemptId===dispatch.trace.attemptId)
  const start=linked.find(e=>e.stage==='backend-start' && e.backend==='rust')
  const end=linked.find(e=>e.stage==='backend-result' && e.backend==='rust')
  const result=linked.find(e=>e.stage==='client-result')
  assert(start && end && result,'preview native propagation missing')
  assert(start.trace.spanId && end.trace.spanId===start.trace.spanId && end.backendSequence>start.backendSequence)
  const commits=linked.filter(e=>e.stage==='commit')
  assert.equal(commits.length,committed?1:0)
  if(committed) {
    const c=commits[0];assert(c.trace.spanId===start.trace.spanId && c.backendSequence>start.backendSequence && c.backendSequence<end.backendSequence)
    assert.equal(c.trace.commitSequence,c.backendSequence);assert.equal(end.outcome,'returned');assert.equal(result.outcome,'returned')
  } else {assert.equal(end.outcome,'unknown');assert.equal(result.outcome,'unknown')}
}

function validateNativeStages(events) {
  const commits=events.filter(e=>e.stage==='commit' && e.backend==='rust')
  assert(commits.length,'missing native commit receipt')
  for(const commit of commits) assert(events.some(e=>e.stage==='signal' && e.trace?.spanId===commit.trace?.spanId && e.trace?.commitSequence===commit.backendSequence),'native signal propagation missing')
  for(const signal of events.filter(e=>e.stage==='signal' && e.trace?.commitSequence)) {
    assert(commits.some(c=>c.trace?.spanId===signal.trace.spanId && c.trace?.attemptId===signal.trace.attemptId && c.backendSequence===signal.trace.commitSequence),'signal missing native commit receipt')
  }
  for(const commit of commits) assert(events.some(e=>e.stage==='backend-start'&&e.trace?.spanId===commit.trace?.spanId&&e.backendSequence<commit.backendSequence),'native commit before start')
}
async function transportAndSignals() {
  const events=[],received=[]
  const append=s=>{if(s.startsWith('operation-chain: ')) events.push(JSON.parse(s.slice(17)))}
  const base={version:1,sessionId:'transport-test',operationId:'operation',attemptId:'attempt',batchId:'batch',domain:'localTags',members:['operation'],omitted:0}
  const core='src/main/rust-core/'
  const mocks={
    [path.join(root,core+'rustCoreWorkerAutoBuildRuntime.ts')]:{tryBuildRustCoreWorkerForDevelopment(){}},
    [path.join(root,core+'rustCoreWorkerPathRuntime.ts')]:{resolveRustCoreWorkerPathWithDiagnostics:()=>({path:null})},
    [path.join(root,core+'rustCoreSchedulerRuntime.ts')]:{createRustCoreSchedulerRuntime:()=>({run:(_,fn)=>fn(new AbortController().signal)})},
    [path.join(root,core+'rustCoreDaemonRuntime.ts')]:{createRustCoreDaemonRuntime:()=>({tryRun:async()=>null}),isRustCoreDaemonSubmittedError:()=>false}
  }
  const load=loader(mocks),ctx=load('src/main/logging/operationTraceContext.ts')
  const transport=load(core+'rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({appendStartupLog:append})
  // Scripted child exercises the real transport, NOT the Rust state machine.
  const script=String.raw`const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[1]));process.stderr.write('operation-chain: '+JSON.stringify({trace:v.trace,stage:'backend-start',backend:'rust',backendSequence:1})+'\n');process.stdout.write(JSON.stringify(v));if(process.argv[2]==='fail')process.exitCode=2;`
  await ctx.withOperationTrace(base,append,async()=>{
    const file=transport.createTemporaryJsonFile('hfm-chain-test')
    try {
      await file.writeJson({rows:[],secret:'business-field-not-logged'})
      const input=JSON.parse(await file.readText());assert.equal(input.trace.attemptId,base.attemptId);assert(input.trace.spanId)
      const result=await transport.runRustCoreScheduledCommand(process.execPath,['-e',script,file.path],{timeout:5000})
      assert.equal(JSON.parse(result.stdout).trace.spanId,input.trace.spanId)
      const before=events.filter(e=>e.stage==='backend-start').length
      await assert.rejects(transport.runRustCoreScheduledCommand(process.execPath,['-e',script,file.path,'fail'],{timeout:5000}))
      assert.equal(events.filter(e=>e.stage==='backend-start').length,before+1,'stderr lost on one-shot failure')
    } finally {await file.dispose();assert(!fs.existsSync(file.path))}
  })
  assert(!JSON.stringify(events).includes('business-field'))
  const { EventEmitter }=require('node:events'),childProcess=require('node:child_process')
  const proc=new EventEmitter();proc.env={HFM_LOG_DETAIL:'debug'}
  let child
  const daemonScript=String.raw`const fs=require('fs'),rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(r.type==='shutdown'){rl.close();process.stdin.destroy();return;}if(r.type!=='submit')return;const trace=JSON.parse(fs.readFileSync(r.args[2])).trace;const event='operation-chain: '+JSON.stringify({trace,stage:'backend-start',backend:'rust',backendSequence:1})+'\n';process.stderr.write(event.slice(0,20));process.stderr.write(event.slice(20));process.stdout.write(JSON.stringify({type:'job_finished',id:r.id,stdout:'ok'})+'\n');});`
  const dl=loader({'node:child_process':{spawn:()=>{child=childProcess.spawn(process.execPath,['-e',daemonScript],{stdio:['pipe','pipe','pipe']});return child}}},{process:proc})
  const dc=dl('src/main/logging/operationTraceContext.ts')
  const daemon=dl(core+'rustCoreDaemonRuntime.ts').createRustCoreDaemonRuntime({appendStartupLog:append})
  const file=transport.createTemporaryJsonFile('hfm-daemon-trace')
  await ctx.withOperationTrace(base,append,()=>file.writeJson({rows:[]}))
  try {
    const before=events.filter(e=>e.stage==='backend-start').length
    assert.equal((await dc.withOperationTrace(base,append,()=>daemon.tryRun('scripted-worker',['--local-tags-set','--input',file.path],{timeout:5000}))).stdout,'ok')
    const exited=new Promise(resolve=>child.once('exit',resolve));daemon.stop();await exited
    assert.equal(events.filter(e=>e.stage==='backend-start').length,before+1,'daemon split stderr frame lost')
    assert(events.some(e=>e.stage==='daemon-submit'&&e.jobId))
    assert.equal(daemon.status().pending,0)
  } finally {daemon.stop();await file.dispose()}
  const sl=loader({electron:{BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{send:(_,p)=>received.push(plain(p))}}]}}})
  const barrier=sl('src/main/library/tagMetadataRevisionBarrierRuntime.ts').createTagMetadataRevisionBarrierRuntime({appendStartupLog(){}})
  const signal=sl(signalFile).createTagMutationStateSignalRuntime({tagMetadataRevisionBarrier:barrier,clearFontQueryCaches(){},appendStartupLog:append})
  const trace={...base,spanId:'native-span',commitSequence:2}
  const payload={trace,changedIds:['a'],updatedAt:'time',mutationKind:'set',dbPath:'/fixture',knownTags:['tag']}
  signal.handleRustCoreDaemonDomainEvent({domain:'localTags',stateSignal:payload})
  signal.handleLocalTagsMutationStateSignal(payload,'rust-worker')
  assert.equal(received.length,1);assert.deepEqual(received[0].trace,trace)
  assert(events.some(e=>e.stage==='signal-reject'&&e.reason==='dedupe'))
  signal.handleLocalTagsMutationStateSignal({...payload,trace:undefined,updatedAt:'legacy'},'rust-worker')
  assert.equal(received.length,2);assert.equal(received[1].trace,undefined)
  const sc=sl('src/main/logging/operationTraceContext.ts')
  sc.withOperationTrace(base,append,()=>signal.handleRustCoreDaemonDomainEvent({domain:'localTags',stateSignal:{...payload,trace:undefined,updatedAt:'legacy-daemon'}}))
  assert.equal(received[2].trace,undefined,'legacy daemon inherited unrelated IPC context')
  assert.equal(events.filter(e=>e.stage==='signal').at(-1).linked,false)
  const native=[{trace,stage:'signal'},{trace,stage:'commit',backend:'rust',backendSequence:2},{trace,stage:'backend-start',backend:'rust',backendSequence:1}]
  validateNativeStages(native) // Arrival order across stderr and stdout may differ.
  assert.throws(()=>validateNativeStages(native.slice(0,1)),/receipt/)
  assert.throws(()=>validateNativeStages(native.slice(0,2)),/before start/)
  assert.throws(()=>validateNativeStages(native.slice(1)),/signal propagation/)
}

async function main() {
  process.env.HFM_LOG_DETAIL='debug'
  const shared=loader()('src/shared/operationTrace.ts')
  assert.equal(shared.cleanOperationTrace({}),undefined)
  const circular={};circular.trace=circular
  assert.doesNotThrow(()=>shared.encodeOperationTraceEvent(circular))
  assert.equal(shared.encodeOperationTraceEvent({get stage(){throw Error('bad getter')}}),'')
  await queueAndLimits()
  await transportAndSignals()
  const success=await chain()
  const retry=await chain({failures:2,runtimePreload:true})
  await chain({throwingLog:true})
  const broken=plain(success).filter(e=>e.stage!=='ipc-start')
  assert.throws(()=>validateChain(broken),/propagation/)
  const falseCommit=plain(success);const commit=falseCommit.splice(falseCommit.findIndex(e=>e.stage==='commit'),1)[0];falseCommit.unshift(commit)
  assert.throws(()=>validateChain(falseCommit),/commit before/)
  const sameAttempt=plain(retry);for(const e of sameAttempt) if(e.trace)e.trace.attemptId='same'
  assert.throws(()=>validateChain(sameAttempt,3),/retry reused/)
  // Remove actual preload propagation, not just an event in a fabricated stream.
  await assert.rejects(chain({transforms:{[path.join(root,'src/preload/index.ts')]:s=>s.replaceAll('...(trace ? [{ __hfmOperationTrace: trace }] : [])','...[]')}}),/propagation/)
  if(process.argv.includes('--samples')) {
    console.log(JSON.stringify({success,retry},null,2))
  } else console.log('[diagnostics:operation-chain] real queue/preload/IPC/SQLite/signal/view; two failures then commit; both preloads; log failure; cleanup; bounded batch/retry/concurrency/legacy/transport and seven mutants passed. Rust execution separately required.')
}
if(require.main===module) main().catch(e=>{console.error(e);process.exitCode=1})
module.exports={validatePreviewNativeStages,loader,validateChain,validateNativeStages,chain}
