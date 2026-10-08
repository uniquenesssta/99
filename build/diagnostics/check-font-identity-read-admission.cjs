#!/usr/bin/env node
'use strict'
// Windows-only local fixture. Real native identity/tree receipts are checked
// separately from scripted child holds, which prove scheduler lifetime only.
// No timing here is an actual NAS or native hashing performance measurement.
const assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os')
const cp=require('node:child_process'),crypto=require('node:crypto')
const {loader}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'),core='src/main/rust-core/'
const sentinel='configured-root:font-content-identity-read'
const tick=()=>new Promise(resolve=>setTimeout(resolve,10))
async function until(check,label){const end=Date.now()+5000;while(!check()){assert(Date.now()<end,label);await tick()}}
const digest=value=>crypto.createHash('sha256').update(value).digest('hex')
const inputPath=args=>args[args.indexOf('--input')+1]

async function runFontIdentityReadAdmissionRegressions(){
  assert.equal(process.platform,'win32','Identity admission diagnostic executes only on Windows')
  const worker=path.join(root,'build/native/hfm-core-worker.exe')
  assert(fs.statSync(worker).isFile(),'Build the matching Windows native worker first')
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-identity-admission-'))
  const fonts=path.join(directory,'fonts'),junction=path.join(directory,'junction')
  fs.mkdirSync(fonts)
  const systemFonts=path.join(process.env.WINDIR,'Fonts')
  const font=fs.readdirSync(systemFonts).filter(name=>/\.ttf$/i.test(name)).sort()[0]
  assert(font,'A real Windows font is required')
  const source=path.join(fonts,'identity.ttf');fs.copyFileSync(path.join(systemFonts,font),source)
  fs.symlinkSync(fonts,junction,'junction')
  const bytes=fs.readFileSync(source),expectedDigest=digest(bytes),scopes=[]
  let serial=0

  async function scope({diagnose=true}={}){
    const children=new Set(),controls=new Map(),captures=[],files=[],logs=[],pausedWrites=new Map()
    const spawn=(file,args,options)=>{
      const row=captures.find(row=>row.input===inputPath(args));assert(row,'Spawn escaped actual shared pool observation')
      const control=controls.get(inputPath(args))
      let child
      if(control){
        assert.equal(args[0],'--shared-file-io','Unexpected controlled command')
        const script=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(control.ready)},'ready');const poll=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(control.release)}))return;clearInterval(poll);process.stdout.write(${JSON.stringify(JSON.stringify({ok:true,operation:control.operation,value:null}))},()=>process.exit(0));},10);`
        child=cp.spawn(process.execPath,['-e',script],options)
        control.child=child;control.spawnedAt=performance.now()
        const kill=child.kill.bind(child)
        child.kill=signal=>{control.killRequested=signal;if(control.deferTermination&&signal==='SIGTERM')return true;return kill(signal)}
        child.once('close',()=>{control.closedAt=performance.now()})
      }else{
        assert.equal(file,worker,'Unexpected real worker path')
        assert.equal(args[0],'--shared-file-io','Unexpected unheld native operation')
        const input=JSON.parse(fs.readFileSync(inputPath(args),'utf8'))
        assert(['fontContentIdentity','treeSnapshot','stat'].includes(input.operation),'Real diagnostic worker may only read identity/tree/stat')
        child=cp.spawn(file,args,options)
      }
      row.spawnedAt=performance.now();row.spawnArgs=Array.from(args);row.pid=child.pid
      children.add(child);child.once('close',()=>children.delete(child));return child
    }
    const load=loader({
      electron:{app:{get isPackaged(){throw Error('Unexpected app/build access')},getAppPath(){throw Error('Unexpected app/path access')}}},
      'node:child_process':{...cp,spawn,spawnSync(){throw Error('Automatic build forbidden')}},
      'node:fs':{...fs,promises:{...fsp,async writeFile(file,...args){const pause=pausedWrites.get(file)
        if(pause){pause.entered=true;if(pause.error){if(pause.writeBeforeError)await fsp.writeFile(file,...args);throw pause.error}await pause.pending}
        return fsp.writeFile(file,...args)}}},
      [path.join(root,core+'rustCoreWorkerPathRuntime.ts')]:{resolveRustCoreWorkerPathWithDiagnostics:()=>({path:worker,candidates:[worker]}),resolveRustCoreWorkerPath:()=>worker},
      [path.join(root,core+'rustCoreWorkerAutoBuildRuntime.ts')]:{tryBuildRustCoreWorkerForDevelopment(){throw Error('Automatic build forbidden')}},
    },{Error,setImmediate,clearImmediate,queueMicrotask})
    const transport=load(core+'rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({enabled:true,required:true,appendStartupLog:line=>logs.push(line)})
    const pool=load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(),originalRun=pool.run
    pool.run=function(request){
      const row={input:inputPath(request.args),args:Array.from(request.args),roots:Array.from(request.roots),accesses:request.accesses,
        write:request.write,verifiedReadOnly:request.verifiedReadOnly===true,startedAt:performance.now()}
      captures.push(row)
      return originalRun.call(this,{...request,onClose(){row.closedAt=performance.now();request.onClose?.()}})
        .then(value=>{row.result=value;return value},error=>{row.error=error;throw error})
    }
    const shared=load(core+'rustSharedIoCommandRuntime.ts'),io=load('src/main/path/sharedFileSystemRuntime.ts')
    shared.registerIsolatedRoot(fonts);shared.registerIsolatedRoot(junction)
    shared.registerIsolatedRoot('Z:\\identity-alias','\\\\alias-host\\writer-share\\canonical')
    const status=diagnose?await transport.diagnoseRustCoreWorker():undefined
    if(status){assert.equal(status.available,true);assert.equal(status.path,worker)}
    function control(operation){
      const id=++serial;return {operation,ready:path.join(directory,`ready-${id}`),release:path.join(directory,`release-${id}`)}
    }
    async function plan({operation='fontContentIdentity',fontPath=source,write=false,target,inputExtra={},held=true,writeInitial=true}={}){
      const input=transport.createTemporaryJsonFile('hfm-identity-admission-input'),transfer=transport.createTemporaryJsonFile('hfm-identity-admission-transfer')
      files.push(input,transfer)
      const value={operation,path:fontPath,transferPath:transfer.path,...inputExtra}
      if(writeInitial)await input.writeJson(value)
      const item={input,transfer,value,args:['--shared-file-io','--input',input.path,'--transfer',transfer.path],worker,
        target:target||{paths:[fontPath,'',''],write},control:held?control(operation):undefined}
      if(item.control)controls.set(input.path,item.control)
      item.start=(options={})=>{
        const pending=transport.runRustCoreScheduledCommand(item.worker,item.args,{timeout:load(core+'rustCoreWorkerTransportRuntime.ts').FONT_CONTENT_IDENTITY_TIMEOUT_MS,sharedIo:item.target,...options})
          .then(value=>{item.settled=true;return value},error=>{item.settled=true;item.error=error;throw error})
        pending.catch(()=>undefined);item.pending=pending;return pending
      }
      return item
    }
    const release=item=>{fs.writeFileSync(item.control.release,'release')}
    const started=item=>until(()=>item.control.child&&fs.existsSync(item.control.ready),'Controlled child did not become ready')
    const captured=item=>captures.find(row=>row.input===item.input.path)
    async function queued(item){await until(()=>captured(item)&&pool.status().queued>0,'Request did not remain queued');assert.equal(captured(item).spawnedAt,undefined,'Blocked request spawned early')}
    async function close(){
      for(const pause of pausedWrites.values())pause.resolve?.()
      for(const c of controls.values())fs.writeFileSync(c.release,'release')
      transport.stopRustCoreDaemon()
      for(const child of children)child.kill('SIGKILL')
      await until(()=>children.size===0,'Controlled/native children did not close')
      await pool.whenIdle();pool.run=originalRun
      for(const file of files)await file.dispose()
      assert.equal(pool.status().pids.length,0)
    }
    const api={load,transport,pool,shared,io,status,children,controls,captures,files,pausedWrites,plan,release,started,queued,captured,close}
    scopes.push(api);return api
  }
  function assertGlobal(row,{verified,write=false,identity=true}={}){
    assert(row,'Actual shared-pool request missing')
    assert.equal(row.verifiedReadOnly,verified,'Identity read exemption mismatch')
    assert.equal(row.write,write,'Identity target write effect changed')
    assert.equal(row.accesses,undefined,'Unknown canonical aliases gained a precise footprint')
    assert(row.roots.some(value=>value.startsWith('configured-root:')),'Global unknown-alias barrier missing')
    if(identity)assert(row.roots.includes(sentinel),'Dedicated identity alias sentinel missing')
  }
  try{
    const s=await scope()
    // Actual executor, owned input and native file-byte/identity receipt.
    let nativeIdentity
    for(const file of [source,path.join(junction,'identity.ttf')]){
      const response=await s.io.executeSharedFile({operation:'fontContentIdentity',path:file})
      assert.equal(response.result.ok,true)
      const value=response.result.value,normalize=s.load('src/main/path/pathCanonicalizer.ts').normalizeNativePathText
      assert.equal(value.sha256,expectedDigest);assert.equal(value.readBytes,bytes.length);assert.equal(value.size,bytes.length)
      assert.equal(normalize(value.path).toLowerCase(),normalize(fs.realpathSync.native(file)).toLowerCase())
      assert.equal(typeof value.dev,'string');assert(value.dev);assert.equal(typeof value.ino,'string');assert(value.ino)
      if(nativeIdentity)assert.deepEqual([value.dev,value.ino],nativeIdentity,'Junction changed native file identity')
      else nativeIdentity=[value.dev,value.ino]
      assertGlobal(s.captures.at(-1),{verified:true})
    }
    const ordinary=await s.io.executeSharedFile({operation:'stat',path:source})
    assert.equal(ordinary.result.ok,true);assert.equal(ordinary.result.value.size,bytes.length)
    assert.equal(s.io.sharedFileAccesses({operation:'fontContentIdentity',path:source}),undefined,'Identity gained a lexical footprint')
    const held=await s.plan();held.start();await s.started(held)
    assertGlobal(s.captured(held),{verified:true})
    const tree=await s.io.executeSharedFile({operation:'treeSnapshot',path:fonts})
    assert.equal(tree.result.ok,true);assert.deepEqual(Object.keys(tree.result.value),['identity.ttf'])
    assert.equal(tree.result.value['identity.ttf'][0],bytes.length)
    assert.equal(held.control.child.exitCode,null,'Identity hold ended before the real native tree read')
    assert(!held.settled);s.release(held);await held.pending

    // Cross-share and declared canonical alias writers, in both active orders.
    // This is a controlled scheduler descriptor, not the physical location of
    // the local native-byte fixture. It makes the compulsory global sentinel
    // essential even when the ordinary root registry has a known UNC identity.
    s.shared.registerIsolatedRoot(fonts,'\\\\identity-host\\identity-share\\fonts')
    const writerPaths=['\\\\other-host\\other-share\\writer.bin','Z:\\identity-alias\\writer.bin']
    for(const writerPath of writerPaths){
      const writer=()=>s.plan({operation:'writeFile',fontPath:writerPath,write:true,
        target:{paths:[writerPath],write:true,accesses:[{path:writerPath,mode:'write',scope:'file'}]}})
      const identity=await s.plan(),after=await writer();identity.start();await s.started(identity);after.start();await s.queued(after)
      assertGlobal(s.captured(identity),{verified:true})
      assert(s.captured(identity).roots.includes('\\\\identity-host\\identity-share'),'Controlled known-share identity was not exercised')
      s.release(identity);await identity.pending;await s.started(after)
      assert(after.control.spawnedAt>=s.captured(identity).closedAt,'Writer started before identity physical close')
      s.release(after);await after.pending
      const before=await writer(),read=await s.plan();before.start();await s.started(before);read.start();await s.queued(read)
      s.release(before);await before.pending;await s.started(read)
      assert(read.control.spawnedAt>=s.captured(before).closedAt,'Identity started before writer physical close')
      s.release(read);await read.pending
    }
    // A pending writer also excludes later higher-priority verified readers.
    const first=await s.plan(),writerPath=writerPaths[0],writer=await s.plan({operation:'writeFile',fontPath:writerPath,write:true})
    const later=await s.plan();first.start();await s.started(first);writer.start();await s.queued(writer)
    s.io.withSharedIoPriority('foreground',()=>later.start());await s.queued(later);s.release(first);await first.pending;await s.started(writer)
    assert(!later.control.child,'Later identity overtook a queued writer')
    s.release(writer);await writer.pending;await s.started(later);s.release(later);await later.pending

    // Cancellation/timeout does not release exclusion until the child closes.
    for(const reason of ['cancelled','timeout']){
      const identity=await s.plan(),writer=await s.plan({operation:'writeFile',fontPath:writerPaths[0],write:true}),controller=new AbortController()
      identity.control.deferTermination=true;identity.start({signal:controller.signal})
      await s.started(identity)
      // The production identity execution budget exceeds the ordinary queue
      // budget. Submit the timeout follower only after cancellation is observed
      // so this case proves physical-close exclusion, not a queue-timeout retry.
      if(reason==='timeout')await until(()=>identity.control.killRequested==='SIGTERM','Identity execution deadline did not cancel')
      writer.start();await s.queued(writer)
      if(reason==='cancelled')controller.abort()
      await until(()=>identity.control.killRequested==='SIGTERM','Native cancellation was not requested')
      assert(!identity.settled&&!writer.control.child,'Cancelled child lost physical-close ownership')
      assert.equal(identity.control.child.exitCode,null);s.release(identity)
      await assert.rejects(identity.pending,error=>error.reason===reason&&error.outcome==='unknown')
      await s.started(writer);assert(writer.control.spawnedAt>=s.captured(identity).closedAt)
      s.release(writer);await writer.pending
    }

    // Each malformed proof remains a global conservative request. The child is
    // scripted: no invalid native input is presented as a successful real read.
    const negatives=[
      ['worker-mismatch',item=>{item.worker=path.join(directory,'other-worker.exe')}],
      ['capability-missing',()=>{s.status.capabilities=s.status.capabilities.filter(x=>x!=='font-content-identity-v1')}],
      ['shared-capability-missing',()=>{s.status.capabilities=s.status.capabilities.filter(x=>x!=='shared-file-io-v1')}],
      ['cached-path-mismatch',()=>{s.status.path=path.join(directory,'other-worker.exe')}],
      ['cached-unavailable',()=>{s.status.available=false}],
      ['extra-target',item=>{item.target.paths.push(writerPaths[0])}],
      ['caller-write',item=>{item.target.write=true}],
      ['caller-write-read-accesses',item=>{item.target.write=true;item.target.accesses=[{path:source,mode:'read',scope:'file'}]}],
      ['preview-flag',item=>{item.target.preview=true}],
      ['empty-accesses',item=>{item.target.accesses=[]}],
      ['extra-read-footprint',item=>{item.target.accesses=[{path:source,mode:'read',scope:'file'}]}],
      ['extra-write-footprint',item=>{item.target.accesses=[{path:writerPaths[0],mode:'write',scope:'file'}]}],
      ['wrong-target-path',item=>{item.target.paths=[path.join(fonts,'different.ttf')]}],
      ['missing-transfer-cli',item=>{item.args=item.args.slice(0,3)}],
      ['wrong-transfer-cli',item=>{item.args[4]=path.join(directory,'unowned-transfer')}],
      ['same-input-transfer',item=>{item.args[4]=item.input.path}],
      ['extra-cli',item=>{item.args.push('--unexpected')}],
      ['reordered-cli',item=>{item.args=['--shared-file-io','--transfer',item.transfer.path,'--input',item.input.path]}],
      ['duplicate-input-cli',item=>{item.args.push('--input',item.input.path)}],
      ['extra-source',()=>{}, {inputExtra:{source:writerPaths[0]}}],
      ['extra-dest',()=>{}, {inputExtra:{dest:writerPaths[0]}}],
      ['extra-paths',()=>{}, {inputExtra:{paths:[writerPaths[0]]}}],
      ['changed-path',()=>{}, {inputExtra:{path:path.join(fonts,'changed.ttf')}}],
      ['relative-path',()=>{}, {inputExtra:{path:'relative.ttf'}}],
      ['nul-path',()=>{}, {inputExtra:{path:source+'\0.ttf'}}],
      ['nonfont-path',()=>{}, {inputExtra:{path:path.join(fonts,'other.bin')}}],
      ['wrong-availability-root',()=>{}, {inputExtra:{availabilityRoot:writerPaths[0]}}],
      ['extra-field',()=>{}, {inputExtra:{unknown:true}}],
      ['unregistered-transfer',item=>{item.args[4]=path.join(directory,'foreign-transfer')}, {inputExtra:{transferPath:path.join(directory,'foreign-transfer')}}],
    ]
    const originalStatus={path:s.status.path,available:s.status.available,capabilities:Array.from(s.status.capabilities)}
    for(const [name,mutate,options]of negatives){
      const item=await s.plan(options);await mutate(item)
      try{
        item.start();await s.started(item);assertGlobal(s.captured(item),{verified:false,write:true})
        const read=await s.plan({operation:'treeSnapshot',fontPath:fonts,held:false,target:{paths:[fonts],write:false,accesses:[{path:fonts,mode:'read',scope:'tree'}]}})
        read.start();await s.queued(read)
        s.release(item);await item.pending;await read.pending
      }finally{Object.assign(s.status,{...originalStatus,capabilities:Array.from(originalStatus.capabilities)})}
      assert(name)
    }
    for(const operation of ['readFile','sqliteSnapshot']){
      const item=await s.plan({operation});item.start();await s.started(item)
      const row=s.captured(item);assert.equal(row.verifiedReadOnly,false);assert.equal(row.accesses,undefined)
      assert(!row.roots.includes(sentinel),'Other operations borrowed the identity effect proof');s.release(item);await item.pending
    }
    // Owned-but-disposed, unregistered, and in-flight rewritten input cannot
    // borrow the proof from a prior immutable JSON value.
    const foreign=await s.plan(),foreignPath=path.join(directory,'foreign-input.json')
    fs.writeFileSync(foreignPath,JSON.stringify(foreign.value));s.controls.set(foreignPath,foreign.control);foreign.args[2]=foreignPath
    async function unavailable(item){
      const count=s.captures.length;item.start()
      await assert.rejects(item.pending,error=>error.reason==='shared-input-unavailable'&&error.outcome==='not-started')
      assert.equal(s.captures.length,count,'Unregistered input reached shared admission');assert(!item.control.child)
    }
    await unavailable(foreign)
    const disposed=await s.plan();await disposed.input.dispose();await unavailable(disposed)
    const absent=await s.plan();absent.args[2]=path.join(directory,'absent-input');await unavailable(absent)
    async function unstable(item){
      const count=s.captures.length;item.start()
      await assert.rejects(item.pending,error=>error.reason==='identity-input-unstable'&&error.outcome==='not-started')
      assert.equal(s.captures.length,count,'Unstable identity reached shared admission');assert(!item.control.child)
    }
    const repeated=await s.plan();await repeated.input.writeJson({...repeated.value,path:path.join(fonts,'changed.ttf')});await unstable(repeated)
    const changedOperation=await s.plan();await changedOperation.input.writeJson({...changedOperation.value,operation:'stat'});await unstable(changedOperation)
    const failedWrite=await s.plan({writeInitial:false});s.pausedWrites.set(failedWrite.input.path,{error:Error('Controlled input write failure')})
    await assert.rejects(failedWrite.input.writeJson(failedWrite.value),/Controlled input write failure/);await unstable(failedWrite);s.pausedWrites.delete(failedWrite.input.path)
    const failedRewrite=await s.plan();s.pausedWrites.set(failedRewrite.input.path,{error:Error('Controlled failed rewrite'),writeBeforeError:true})
    await assert.rejects(failedRewrite.input.writeJson({...failedRewrite.value,operation:'writeFile'}),/Controlled failed rewrite/)
    assert.equal(JSON.parse(fs.readFileSync(failedRewrite.input.path,'utf8')).operation,'writeFile','Failed rewrite did not leave different physical JSON')
    await unstable(failedRewrite);s.pausedWrites.delete(failedRewrite.input.path)
    const rewriting=await s.plan();let finishWrite
    const pause={pending:new Promise(resolve=>{finishWrite=resolve}),resolve:()=>finishWrite(),entered:false};s.pausedWrites.set(rewriting.input.path,pause)
    const pendingWrite=rewriting.input.writeJson({...rewriting.value,path:path.join(fonts,'changed.ttf')})
    await until(()=>pause.entered,'Owned input rewrite was not held')
    await unstable(rewriting)
    pause.resolve();await pendingWrite;s.pausedWrites.delete(rewriting.input.path)
    const firstWrite=await s.plan({writeInitial:false});let finishFirst
    const firstPause={pending:new Promise(resolve=>{finishFirst=resolve}),resolve:()=>finishFirst(),entered:false};s.pausedWrites.set(firstWrite.input.path,firstPause)
    const writingFirst=firstWrite.input.writeJson(firstWrite.value);await until(()=>firstPause.entered,'First input write was not held')
    await unstable(firstWrite)
    const overlapping=firstWrite.input.writeJson({...firstWrite.value,path:path.join(fonts,'overlap.ttf')})
    await unstable(firstWrite);firstPause.resolve();await Promise.all([writingFirst,overlapping]);s.pausedWrites.delete(firstWrite.input.path)
    await unstable(firstWrite)
    const sealed=await s.plan();sealed.start();await s.started(sealed);assertGlobal(s.captured(sealed),{verified:true})
    const originalBytes=fs.readFileSync(sealed.input.path)
    await assert.rejects(sealed.input.writeJson({...sealed.value,path:path.join(fonts,'changed.ttf')}),error=>error.reason==='identity-input-sealed')
    await assert.rejects(sealed.input.writeJson({...sealed.value,operation:'writeFile'}),error=>error.reason==='identity-input-sealed')
    assert.deepEqual(fs.readFileSync(sealed.input.path),originalBytes,'Sealed active input bytes changed')
    await sealed.input.dispose();assert(fs.existsSync(sealed.input.path),'Active identity lost its owned input before close')
    const beforeReplay=s.captures.length
    await assert.rejects(s.transport.runRustCoreScheduledCommand(sealed.worker,sealed.args,{sharedIo:sealed.target}),error=>error.reason==='shared-input-unavailable'&&error.outcome==='not-started')
    assert.equal(s.captures.length,beforeReplay,'Disposed active input admitted another command')
    assert.equal(sealed.control.child.exitCode,null,'Disposed active input released its original child')
    s.release(sealed);await sealed.pending;await until(()=>!fs.existsSync(sealed.input.path),'Disposed active input was not released after close')
    const sealingWriter=await s.plan({operation:'writeFile',fontPath:writerPaths[0],write:true}),queuedSeal=await s.plan()
    const originalArgs=Array.from(queuedSeal.args)
    sealingWriter.start();await s.started(sealingWriter);queuedSeal.start();await s.queued(queuedSeal)
    const queuedBytes=fs.readFileSync(queuedSeal.input.path)
    await assert.rejects(queuedSeal.input.writeJson({...queuedSeal.value,path:path.join(fonts,'changed.ttf')}),error=>error.reason==='identity-input-sealed')
    await assert.rejects(queuedSeal.input.writeJson({...queuedSeal.value,operation:'writeFile'}),error=>error.reason==='identity-input-sealed')
    assert.deepEqual(fs.readFileSync(queuedSeal.input.path),queuedBytes,'Sealed queued input bytes changed')
    queuedSeal.args.splice(0,queuedSeal.args.length,'--shared-file-io','--input',foreignPath,'--transfer',path.join(directory,'changed-transfer'))
    assert.deepEqual(s.captured(queuedSeal).args,originalArgs,'Queued caller mutation changed captured arguments')
    s.release(sealingWriter);await sealingWriter.pending;await s.started(queuedSeal)
    assert.deepEqual(s.captured(queuedSeal).spawnArgs,originalArgs,'Queued caller mutation changed spawned arguments')
    assert.deepEqual(fs.readFileSync(queuedSeal.input.path),queuedBytes,'Queued caller mutation changed owned input')
    s.release(queuedSeal);await queuedSeal.pending
    const uncached=await scope({diagnose:false}),noCache=await uncached.plan();noCache.start();await uncached.started(noCache)
    assertGlobal(uncached.captured(noCache),{verified:false,write:true});uncached.release(noCache);await noCache.pending

    // Actual generation owner rejects queued and completed stale reads.
    const availability=s.load('src/main/path/startupPathAvailabilityRuntime.ts')
    for(const active of [false,true]){
      const generationRoot=path.join(directory,`generation-${active}`);fs.mkdirSync(generationRoot);s.shared.registerIsolatedRoot(generationRoot)
      const item=await s.plan({fontPath:path.join(generationRoot,'font.ttf')})
      let blocker
      if(!active){blocker=await s.plan({operation:'writeFile',fontPath:writerPaths[0],write:true});blocker.start();await s.started(blocker)}
      item.start();if(active)await s.started(item);else await s.queued(item)
      availability.markStartupPathRootUnavailable(generationRoot,Error('Controlled generation transition'))
      if(blocker){s.release(blocker);await blocker.pending}else s.release(item)
      await assert.rejects(item.pending,error=>error.reason==='stale-generation')
      if(!active)assert(!item.control.child,'Stale queued identity spawned')
    }
    console.log('[diagnostics:font-identity-read-admission] real native bytes/junction/tree receipts; controlled read overlap, alias writers/fairness, cancellation/close, generation and strict proof negatives passed; no NAS measurement')
  }finally{
    for(const s of scopes.reverse())await s.close()
    fs.rmSync(junction,{recursive:true,force:true});fs.rmSync(directory,{recursive:true,force:true})
  }
}
module.exports={runFontIdentityReadAdmissionRegressions}
if(require.main===module)runFontIdentityReadAdmissionRegressions().catch(error=>{console.error(error);process.exitCode=1})
