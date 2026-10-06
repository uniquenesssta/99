const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {createFixture,createObserver}=require('./operation-work-performance.cjs')
const {createRuntime}=require('./preview-chain-performance-runtime.cjs')
async function run({directory,html,preload,config,electron}) {
 const {app,BrowserWindow,ipcMain}=electron
 process.env.ELECTRON_RENDERER_URL=require('node:url').pathToFileURL(html).href
 process.env.HFM_LOG_DETAIL='';process.env.HFM_VERBOSE_LOGS='0';process.env.HFM_RUST_CORE_WORKER=config.workerPath;process.env.HFM_RUST_CORE_AUTOBUILD='0'
 const timer=setTimeout(()=>{console.error('F13 workload watchdog');app.exit(1)},180000)
 let fixture,active,win
 const report={...config,platform:process.platform,versions:process.versions,scope:'actual source-root code, temporary real fonts/SQLite, real queues/native PNG/browser decode; picker and registry/mutation ports controlled; no system mutation or NAS claim',phases:[]}
 try {
  await app.whenReady()
  fixture=await createFixture({sourceRoot:config.sourceRoot,directory,fixtureDirectory:config.fixtureDirectory,manifest:config.manifest,workerPath:config.workerPath,electron})
  report.operations=await fixture.operations();report.watcher=await fixture.watcher();report.contention=await fixture.contention()
  // Existing image attribution is explicitly opt-in in the actual preload.
  // Work/count reductions above were measured with detailed logging disabled.
  process.env.HFM_LOG_DETAIL='debug'
  report.logging={operations:'off',contention:'off',preview:'debug for existing image receipt attribution'}
  const bootstrap=fixture.load
  fs.writeFileSync(preload,bootstrap('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource)
  const traced=bootstrap('src/main/ipc/ipcTraceRuntime.ts').registerTracedIpcHandler
  const runtime=new Proxy({appendLog:fixture.appendLog},{get(target,key){return key in target?target[key]:(...args)=>active.runtime[key](...args)}})
  bootstrap('src/main/ipc/handlers/previewAndFolderIpcHandlers.ts').registerPreviewAndFolderIpcHandlers((channel,handler)=>traced({appendLog:fixture.appendLog},channel,handler),runtime)
  ipcMain.handle('performance:rendererTrace',(_event,payload)=>{if(payload?.kind==='operation-chain')fixture.appendLog('operation-chain: '+payload.details.event);return true})
  win=new BrowserWindow({show:true,width:900,height:700,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}})
  await win.loadFile(html)
  const fonts=Array.from({length:12},(_,index)=>({...fixture.next[index%8],id:`visible-${index}`,fileName:`visible-${index}.ttf`,active:true}))
  const route=fixture.load('src/main/preview/runtime/previewInstalledFontRouteRuntime.ts').resolveInstalledFontPreviewRoute
  const distinctKeys=new Set(fonts.map(font=>route(font).cacheIdentity)).size
  report.previewRoute='installed-family DirectWrite PNG; copied-file font-byte loading not claimed'
  report.visibleFonts=12;report.distinctInstalledPreviewKeys=distinctKeys
  for(const mode of ['list','grid']) {
   const cacheDir=path.join(directory,'preview',mode)
   for(const cache of ['cold','disk-hot','memory-hot']) {
    if(cache!=='memory-hot'){
     await active?.close();active=undefined;fixture.observer.reset()
     active=await createRuntime({directory:cacheDir,baseline:false,sourceRoot:config.sourceRoot,controlled:true,observer:fixture.observer,fixture,appendLog:fixture.appendLog,electron})
    }else fixture.observer.reset()
    const nativeBefore=active.native(),ranges=[]
    for(const visible of [fonts.slice(0,6),fonts.slice(6)])ranges.push(await win.webContents.executeJavaScript(`window.measurePreviewChain(${JSON.stringify(visible)},${JSON.stringify(mode)})`))
    assert.equal(active.counts(),0,'F13 crossed the synthetic historical counter')
    const row={mode,cache,nativeRenders:active.native()-nativeBefore,decoded:ranges.reduce((n,r)=>n+r.decoded,0),ranges,work:fixture.observer.snapshot()}
    assert.equal(row.decoded,12);assert.equal(row.nativeRenders,cache==='cold'?distinctKeys:0)
    report.phases.push(row);console.log('[F13 preview]',JSON.stringify({variant:config.variant,mode,cache,nativeRenders:row.nativeRenders,decoded:row.decoded}))
   }
  }
  await active.close();active=undefined
  report.remainingChildren=fixture.observer.children.size;assert.equal(report.remainingChildren,0)
  report.operationSummaries=fixture.logs.filter(line=>line.startsWith('operation work:')).map(line=>JSON.parse(line.slice(16)))
  report.passed=true
 }catch(error){report.passed=false;report.error=error?.stack||String(error);throw error}
 finally {
  try{await active?.close()}catch(error){report.cleanupError=String(error)}
  try{fixture?.close()}catch(error){report.cleanupError=String(error)}
  fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(directory,'operation-chain.log'),fixture?.logs.join('\n')||'')
  win?.destroy();clearTimeout(timer)
 }
}
module.exports={run}
