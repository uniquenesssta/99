#!/usr/bin/env node
// Real write protocol, revision owner, signals and query facade; deterministic clock/worker boundary.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const barrierFile = 'src/main/library/tagMetadataRevisionBarrierRuntime.ts'
const protocolFile = 'src/main/library/tagMutationWriteProtocolRuntime.ts'
const signalFile = 'src/main/library/tagMutationStateSignalRuntime.ts'
const tick = () => new Promise(resolve => setImmediate(resolve))
async function exercise(transforms = {}) {
  let now = 1000
  const timers = [], broadcasts = []
  class Clock extends Date { static now() { return now } }
  const load = loader({electron:{BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{send:(_,p)=>broadcasts.push(p)}}]}}}, {
    Date:Clock, setTimeout(fn,ms){timers.push(ms);now+=ms;fn();return 1},clearTimeout(){}
  }, transforms)
  const barrier = load(barrierFile).createTagMetadataRevisionBarrierRuntime({appendStartupLog(){}})
  const protocol = load(protocolFile).createTagMutationWriteProtocolRuntime({tagMetadataRevisionBarrier:barrier,clearFontQueryCaches(){}})
  const signal = load(signalFile).createTagMutationStateSignalRuntime({tagMetadataRevisionBarrier:barrier,clearFontQueryCaches(){},appendStartupLog(){}})
  for (const scope of ['local','shared']) {
    const request={sidebarPage:scope==='local'?'tags':'sharedTags',activeFilter:{kind:'all'}}
    const other={sidebarPage:scope==='local'?'sharedTags':'tags'}
    for(const kind of ['set','deleteTag']) {
      let release
      const pending = protocol.run({scope,mutationKind:kind,inputIds:['a'],action:()=>new Promise(resolve=>release=resolve)})
      await tick()
      assert.equal(barrier.indexedQueryDelayMsForRequest(request),220,'unconfirmed write keeps grace')
      assert.equal(barrier.indexedQueryDelayMsForRequest(other),0,'scope isolation')
      const before=barrier.snapshotForRequest(request)
      release({ok:true,updatedIds:['a'],mutationProtocol:{mutationKind:kind,changedIds:['a']}})
      await pending
      assert.equal(barrier.indexedQueryDelayMsForRequest(request),0,'committed write must not restart 220ms grace')
      assert(barrier.hasActiveBarrierForRequest(request),'keep dirty/version protection')
      assert(barrier.resultBecameStaleForRequest(request,before),'reject old in-flight result')
      assert(barrier.shouldBypassFastMetrics());assert.equal(barrier.shouldBypassFastMetrics(),false)
    }
    // Empty catalogs and standalone receipts also mean the database is committed.
    signal[scope==='local'?'handleLocalTagsMutationStateSignal':'handleSharedMetadataMutationStateSignal']({mutationId:scope,mutationKind:'deleteTag',dbPath:'/db',rootPath:'/root',changedIds:[],knownTags:[]})
    assert.equal(barrier.indexedQueryDelayMsForRequest(request),0,'receipt with no font IDs must be immediate')
    assert.equal(broadcasts.at(-1).knownTags.length,0)
    let queryCount=0, changeInQuery=false, omitRevision=false
    const facade=load('src/main/library/fontQueryFacadeRuntime.ts').createFontQueryFacadeRuntime({
      appendLog(){},tagMetadataRevisionBarrier:barrier,fontSearchResultLimitDefault:100,
      appWatchedFolders:async()=>['/fonts'],scheduleMergedIndexBackgroundValidation(){},
      mergedIndexDbPath:()=>'/merged',librarySqlitePath:()=>'/local',
      queryFontPageFromMergedIndexWorker:async()=>{
        queryCount++
        const requested=barrier.snapshotForRequest(request)
        if(changeInQuery){changeInQuery=false;barrier.noteMutation({scope,reason:'another-commit',committed:true})}
        return {items:[{id:'a'}],total:1,engine:'sql',tagRevision:omitRevision?undefined:{requested}}
      },
      cleanSharedFontsForQuery:async()=>[{id:'fresh-memory'}],hydrateLocalTagsForFonts:async x=>x,
      rustCoreWorkerRuntime:{runRustMergedIndexIdsQuery:async args=>({ids:['a'],total:1,truncated:false,engine:'sql',tagRevision:{requested:args.tagRevision}})}
    })
    timers.length=0
    assert.equal((await facade.queryFontPageInLibraryUncached(request,100,0)).items[0].id,'a')
    assert.equal(timers.length,0,'page query must execute without grace after commit')
    assert.equal((await facade.queryFontsInLibrary(request)).ids[0],'a')
    assert.equal(timers.length,0,'ID query must execute without grace after commit')
    changeInQuery=true
    const previous=queryCount
    await facade.queryFontPageInLibraryUncached(request,100,0)
    assert.equal(queryCount-previous,2,'concurrent commit still forces retry')
    omitRevision=true
    assert.equal((await facade.queryFontPageInLibraryUncached(request,100,0)).items[0].id,'fresh-memory','unproven version falls back')
    await assert.rejects(protocol.run({scope,mutationKind:'set',inputIds:['a'],action:async()=>{throw Error('write failed')}}),/write failed/)
    assert.equal(barrier.indexedQueryDelayMsForRequest(request),220,'failure is not a commit')
    now+=220
    assert.equal(barrier.indexedQueryDelayMsForRequest(request),0)
  }
}
async function main(){
  const files = [barrierFile, protocolFile, signalFile]
  for (const eol of ['\n', '\r\n']) {
    await exercise(Object.fromEntries(files.map(file => [path.join(root, file), source => source.replace(/\r\n/g, '\n').replace(/\n/g, eol)])))
    for(const file of files) {
      const transform=file===barrierFile?s=>s.replaceAll('input.committed ? 0 : now','now')
        :file===protocolFile?s=>s.replace('updatedIds, true)','updatedIds)')
        :s=>s.replaceAll('      true,\n','')
      const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')
      const changed = transform(source)
      assert.notEqual(changed, source, `mutation anchor missing: ${file}`)
      await assert.rejects(exercise({[path.join(root,file)]:()=>changed.replace(/\n/g,eol)}),{name:'AssertionError'},`regression must detect ${file}`)
    }
  }
  console.log('tag commit query checks passed (local/shared, set/delete, signals, query retry, version rejection, failure, 3 applied regression mutations in LF/CRLF)')
}
main().catch(error=>{console.error(error);process.exitCode=1})
