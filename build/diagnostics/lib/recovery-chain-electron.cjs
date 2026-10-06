const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {DatabaseSync}=require('node:sqlite')
const {createChain}=require('./recovery-chain-runtime.cjs')
const {createRuntime}=require('./preview-chain-performance-runtime.cjs')
const {hash}=require('./operation-work-performance.cjs')
const plain=value=>JSON.parse(JSON.stringify(value))
async function run({directory,html,preload,config,electron}) {
  const {app,BrowserWindow,ipcMain}=electron
  // Reopen and asynchronous cleanup intentionally have a no-window interval.
  // The existing runner, not Electron's default window-close policy, owns exit.
  const keepAlive=()=>{};app.on('window-all-closed',keepAlive)
  process.env.ELECTRON_RENDERER_URL=require('node:url').pathToFileURL(html).href
  process.env.HFM_LOG_DETAIL='debug';process.env.HFM_VERBOSE_LOGS='0';process.env.HFM_RUST_CORE_WORKER=config.workerPath;process.env.HFM_RUST_CORE_AUTOBUILD='0'
  const report={sourceSha:config.sourceSha,platform:process.platform,versions:process.versions,workerSha256:config.workerSha256,manifest:config.manifest,passed:false,
    scope:'same persisted tag page/real React cards/menu/actions/preload/IPC/content status Rust DB/private-file PNG/controlled exact OS effects/reopen; remote snapshot and WebFont-failure trigger controlled; no actual registry mutation, NAS or full App startup; merged-index projection not exercised',checkpoints:[],previews:[],cases:[],sessions:[],logs:[]}
  let chain,preview,win,pickerCalls=0,pendingPicker,channels=[]
  const receipts=[];report.receipts=receipts
  const timer=setTimeout(()=>{report.passed=false;report.error='F14 integration watchdog';report.logs.push(...(chain?.logs||[]));fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(directory,'operation-chain.log'),report.logs.join('\n'));console.error(report.error);app.exit(1)},180000)
  const wait=async(test,label,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await test();if(value)return value;await new Promise(resolve=>setTimeout(resolve,15))}throw Error('F14 wait timed out: '+label)}
  const js=code=>win.webContents.executeJavaScript(code)
  const ui=()=>js('window.recoveryChain.snapshot()')
  const ready=()=>wait(async()=>{const value=await ui();if(value?.failed)throw Error(value.status);return value?.ready&&value.availability?.roots.some(root=>chain.key(root.path)===chain.key(config.fixtureDirectory))&&value.availability.roots.every(root=>root.state==='online')&&value},'authoritative React page and availability')
  const click=async label=>{await js(`(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)});if(!button||button.disabled)throw Error('enabled button absent: '+${JSON.stringify(label)});button.click()})()`)}
  const menu=async id=>{await js(`(()=>{const card=[...document.querySelectorAll('[data-font-id]')].find(card=>card.dataset.fontId===${JSON.stringify(id)});if(!card)throw Error('font card missing');card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))})()`);await wait(()=>js("!!document.querySelector('.context-menu')"),'actual card menu')}
  const refresh=async()=>{const before=(await ui()).acceptedRevision;await js('window.recoveryChain.refresh()');await wait(async()=>{const value=await ready();return value.acceptedRevision>before&&value},'fresh page')}
  const checkpoint=async label=>{const value=await chain.checkpoint(label),browser=await ready();const fields=Object.keys(value.states.all.items[0]||{}),items=browser.page.items.map(item=>Object.fromEntries(fields.map(field=>[field,item[field]])));assert.deepEqual(plain(items),plain(value.states.all.items),'browser rows do not match current same-state query');value.browser={items,availability:browser.availability,ids:browser.page.items.map(item=>item.id),total:browser.page.total,requestSeq:browser.requestSeq,acceptedRevision:browser.acceptedRevision};report.checkpoints.push(value);console.log('[F14 checkpoint]',label)}
  const useCommand=async(item,label,confirm=true)=>{const initial=await ui(),before=initial.refreshToken;await menu(item.id);await click(label);if(label!=='安装'){await wait(()=>js("!!document.querySelector('dialog[open]')"),'real confirmation');await js(`document.querySelector('[data-confirmation="${confirm?'accept':'cancel'}"]').click()`)}await wait(async()=>{const value=await ui();return !value.busy.length&&(confirm?value.refreshToken>before:/已取消/.test(value.status))},label+' settlement');if(confirm)await wait(async()=>{const value=await ready();return value.acceptedRevision>initial.acceptedRevision&&value},label+' authoritative refresh')}
  async function start(reopen=false) {
    const controlledElectron={...electron,dialog:{...electron.dialog,showOpenDialog:async()=>{pickerCalls++;return new Promise(resolve=>{pendingPicker=resolve})}}}
    chain=await createChain({sourceRoot:config.sourceRoot,directory,fixtureDirectory:config.fixtureDirectory,manifest:config.manifest,workerPath:config.workerPath,electron:controlledElectron,reopen})
    chain.observeNative=(request,result,receipt)=>{assert(receipt,'raw native transport receipt missing');assert.equal(receipt.outputPath,request.outputPath);chain.observed.nativeRequests.push({fontPath:request.fontPath,preferSystemFont:!!request.preferSystemFont,engine:receipt.engine,normalizedClientEngine:result?.engine,ok:receipt.ok,rawReceipt:receipt,width:request.width,height:request.height,sourceSha256:request.fontPath?hash(fs.readFileSync(request.fontPath)):null})}
    preview=await createRuntime({directory:path.join(directory,'preview'),baseline:false,sourceRoot:config.sourceRoot,controlled:true,observer:chain.observer,fixture:chain,appendLog:chain.appendLog,electron})
    fs.writeFileSync(preload,chain.load('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource)
    const traceModule=chain.load('src/main/ipc/ipcTraceRuntime.ts'),traced=traceModule.registerTracedIpcHandler
    // Observe real root registration/receipts while preserving its admission,
    // shutdown guards, trusted-sender validation and per-domain handlers.
    traceModule.registerTracedIpcHandler=(runtime,channel,handler)=>{channels.push(channel);traced(runtime,channel,async(event,...args)=>{const result=await handler(event,...args);if(['fonts:recoverTagFiles','fonts:installSystem','fonts:uninstallSystem'].includes(channel))receipts.push({channel,result:plain(result)});return result})}
    chain.runtime.reportPerformanceEvent=payload=>{if(payload?.kind==='operation-chain')chain.appendLog('operation-chain: '+payload.details.event);return {ok:true}}
    const runtime=new Proxy(chain.runtime,{get(target,key){if(key in target)return target[key];if(key in preview.runtime)return preview.runtime[key];return ()=>{throw Error('unexpected production port '+String(key))}}})
    chain.load('src/main/ipc/ipcHandlers.ts').registerIpcHandlers(runtime)
    win=new BrowserWindow({show:true,width:1100,height:900,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}})
    win.webContents.on('console-message',event=>{if(event.level==='warning'||event.level==='error')chain.appendLog('renderer: '+event.message)})
    await win.loadFile(html);await js(`window.startRecoveryChain(${JSON.stringify(await chain.runtime.loadLibraryShell())})`);await ready()
  }
  async function close() {
    if(win){await js('window.recoveryChain.disposePreview()').catch(()=>{});win.destroy();win=undefined}
    const endingChain=chain,endingPreview=preview;chain=undefined;preview=undefined
    endingChain?.stopTransport()
    const closed=await Promise.allSettled([endingPreview?.close(),endingChain?.close()])
    if(endingChain){report.logs.push(...endingChain.logs);report.sessions.push({observed:plain(endingChain.observed),effects:plain(endingChain.effects),work:endingChain.observer.snapshot()});assert.equal(endingChain.observer.children.size,0)}
    for(const channel of channels)ipcMain.removeHandler(channel);channels=[]
    for(const result of closed)if(result.status==='rejected')throw result.reason
  }
  async function previewSource(item,mode,label) {
    const row=(await ready()).page.items.find(font=>font.id===item.id)
    assert(row.installStatusKnown&&!row.systemInstalled&&!row.active&&!row.systemInstallMatches.length,'source preview must use truthful uninstalled row')
    const before=chain.observed.nativeRequests.length
    await js(`window.recoveryChain.preview([${JSON.stringify(item.id)}],${JSON.stringify(mode)})`)
    const result=await wait(async()=>{const value=await js('window.recoveryChain.previewSnapshot()');if(value?.error)throw Error(value.error);return value?.decoded.length===1&&value.running===0&&value.loading===0&&value.queued===0&&value},'private PNG decode')
    const decoded=result.decoded[0],imageSha256=hash(Buffer.from(decoded.image.split(',')[1],'base64'))
    const expectedCard=await js(`window.recoveryChain.expectedCardImage(${JSON.stringify(item.id)},${JSON.stringify(mode)})`)
    const cardImage=await wait(()=>js(`(()=>{const card=[...document.querySelectorAll('[data-font-id]')].find(card=>card.dataset.fontId===${JSON.stringify(item.id)});const image=card&&[...card.querySelectorAll('img')].find(image=>image.src===${JSON.stringify(expectedCard.image)});return image?.complete&&image.naturalWidth?{width:image.naturalWidth,height:image.naturalHeight}:null})()`),'actual FontCard image load')
    assert.equal(cardImage.width,expectedCard.width);assert.equal(cardImage.height,expectedCard.height);assert(cardImage.width>0&&cardImage.width<=decoded.width);assert.equal(cardImage.height,decoded.height);cardImage.route=expectedCard.route;cardImage.sha256=hash(Buffer.from(expectedCard.image.split(',')[1],'base64'))
    fs.writeFileSync(path.join(directory,`${label}-${mode}.png`),(await win.webContents.capturePage()).toPNG())
    delete decoded.image
    const requests=chain.observed.nativeRequests.slice(before)
    for(const request of requests){assert.equal(chain.key(request.fontPath),chain.key(item.path));assert.equal(request.preferSystemFont,false);assert.equal(request.engine,'rust-private-gdi');assert.equal(request.ok,true);assert.equal(request.sourceSha256,hash(fs.readFileSync(item.path)))}
    if(!report.previews.length)assert.equal(requests.length,1,'cold recovered source must really render')
    report.previews.push({label,mode,decoded,cardImage,imageSha256,requests,controlledTrigger:'supported prior WebFont failure hint; actual native file rendering'})
    return {decoded,imageSha256}
  }
  try {
    await app.whenReady();await start()
    // An old name-only installed row stays present, but cannot authorize the UI.
    const installDb=new DatabaseSync(await chain.status.fallbackInstallStatusDbPath())
    installDb.prepare("INSERT INTO install_status(font_id,signature,installed,by_type,matches_json) VALUES (?,'legacy-name-only',1,'system','[]')").run(chain.old[0].id);installDb.close()
    chain.invalidate();await refresh();await checkpoint('missing-old-row')
    let state=await ready();assert.equal(state.page.total,8);assert(state.page.items.every(font=>font.fileAvailability==='missing'));assert(state.page.items.every(font=>!font.installStatusKnown))
    const cancelRefreshToken=(await ui()).refreshToken,initialSource=chain.sourceManifest(),initialBindings=plain(chain.raw.prepare('SELECT * FROM local_font_tags ORDER BY font_path,tag_name').all())
    await menu(chain.old[0].id);await click('重新链接文件');await wait(()=>pendingPicker,'picker')
    await menu(chain.old[0].id);await click('重新链接文件');await new Promise(resolve=>setTimeout(resolve,50));assert.equal(pickerCalls,1);assert.equal(chain.observed.transactions,0)
    pendingPicker({canceled:true,filePaths:[]});pendingPicker=undefined
    await wait(()=>receipts.some(row=>row.channel==='fonts:recoverTagFiles'&&row.result.canceled),'cancel receipt')
    assert.deepEqual(plain(chain.raw.prepare('SELECT * FROM local_font_tags ORDER BY font_path,tag_name').all()),initialBindings);assert.equal((await ui()).refreshToken,cancelRefreshToken)
    report.cases.push({name:'cancel-and-repeat-click',passed:true,pickerCalls,transactions:0})
    await menu(chain.old[0].id);await click('重新链接文件');await wait(()=>pendingPicker,'second picker');pendingPicker({canceled:false,filePaths:[chain.next[0].path]});pendingPicker=undefined
    await wait(async()=>{const value=await ready();return value.page.items.every(font=>font.fileAvailability==='available')},'recovered browser page')
    const recovered=receipts.filter(row=>row.channel==='fonts:recoverTagFiles').at(-1).result
    assert.equal(recovered.linked,8);assert.equal(recovered.remaining,0);assert.equal(pickerCalls,2);assert.equal(chain.observed.transactions,1);assert.equal(chain.observed.registrations.length,0);assert.equal(chain.effects.length,0)
    for(const item of chain.next)await chain.confirmAndSave(item)
    await refresh();await checkpoint('recovered-known-not-installed');const recoveredBindings=plain(chain.raw.prepare('SELECT * FROM local_font_tags ORDER BY font_path,tag_name').all())
    state=await ready();assert(state.page.items.every(font=>font.installStatusKnown&&!font.systemInstalled));assert(state.page.items.find(font=>font.id===chain.next[0].id).favorite);assert(state.page.items.find(font=>font.id===chain.next[4].id).deleteProtected)
    await previewSource(chain.next[0],'list','recovered-before-install');await previewSource(chain.next[0],'grid','recovered-before-install')
    const nativeCount=chain.observed.nativeRequests.length
    await js(`window.recoveryChain.reRequest(${JSON.stringify(chain.next[0].id)},true)`);await new Promise(resolve=>setTimeout(resolve,120));assert.equal(chain.observed.nativeRequests.length,nativeCount,'metadata-only request rerendered source')
    await useCommand(chain.next[0],'安装');await wait(async()=>{const value=await ready();return value.page.items.find(font=>font.id===chain.next[0].id)?.systemInstalled},'installed page')
    await checkpoint('installed')
    await js("window.recoveryChain.filter('installed')");await wait(async()=>{const value=await ready();return value.page.total===1&&value.page.items[0].id===chain.next[0].id},'installed filter')
    await js("window.recoveryChain.filter('notInstalled')");await wait(async()=>{const value=await ready();return value.page.total===7&&!value.page.items.some(font=>font.id===chain.next[0].id)},'not-installed filter')
    await js("window.recoveryChain.filter('all')");await wait(async()=>{const value=await ready();return value.page.total===8},'all filter')
    // Cancel the real destructive confirmation before authorizing the controlled effect.
    await useCommand(chain.next[0],'卸载字体',false);assert.equal(chain.effects.length,0)
    await useCommand(chain.next[0],'卸载字体');await wait(async()=>!(await ready()).page.items.find(font=>font.id===chain.next[0].id).systemInstalled,'uninstalled page')
    assert.equal(chain.effects.filter(row=>row[0]==='file').length,1);assert.equal(chain.records.length,0);assert.equal(chain.store().load(chain.next[0].path),undefined)
    await js(`window.recoveryChain.staleInstalled(${JSON.stringify(chain.next[0].id)})`);await refresh();assert.equal((await ui()).library.fonts[chain.next[0].id].systemInstalled,false)
    const afterPreview=await previewSource(chain.next[0],'list','after-uninstall');assert.equal(afterPreview.imageSha256,report.previews[0].imageSha256);assert.deepEqual(plain(chain.raw.prepare('SELECT * FROM local_font_tags ORDER BY font_path,tag_name').all()),recoveredBindings);await checkpoint('uninstalled-source-retained')
    report.cases.push({name:'same-state-recovery-install-filter-private-preview-uninstall',passed:true})
    // Partial OS effects are real temp-file/controlled registration changes. The
    // second attempted step fails before effect and leaves a durable receipt.
    await useCommand(chain.next[1],'安装');await wait(async()=>!!(await ready()).page.items.find(font=>font.id===chain.next[1].id).systemInstalled,'second installed')
    chain.controls.mutation='blocked';await useCommand(chain.next[1],'卸载字体')
    await wait(async()=>!!(await ready()).page.items.find(font=>font.id===chain.next[1].id).pendingUninstall,'pending page')
    const partialRow=(await ready()).page.items.find(font=>font.id===chain.next[1].id);assert.equal(partialRow.installStatusKnown,true);assert.equal(partialRow.systemInstalled,true,'residual directory candidate remains content-confirmed');assert(partialRow.systemInstallMatches.some(record=>record.registryName===path.basename(record.path)));assert(!partialRow.systemInstallMatches.some(record=>record.registryName===chain.observed.registrations.at(-1).name));
    const pending=chain.store().load(chain.next[1].path);assert(pending);assert.equal(pending.completedSteps,1);assert.equal(chain.records.length,0)
    await menu(chain.next[1].id);assert((await js("[...document.querySelectorAll('button')].map(button=>button.textContent)")).includes('重试卸载'))
    // Receipt overlay must be reapplied even to a cached page after removal/re-add.
    const cachedRequest={sidebarPage:'tags',selectedTagName:'Recover',limit:500},cached=await chain.runtime.queryFontPageInLibrary(cachedRequest)
    chain.store().remove(pending);const cleared=await chain.runtime.queryFontPageInLibrary(cachedRequest);assert(!cleared.items.find(item=>item.id===chain.next[1].id).pendingUninstall)
    chain.store().save({...pending,revision:0});const restored=await chain.runtime.queryFontPageInLibrary(cachedRequest);assert(restored.items.find(item=>item.id===chain.next[1].id).pendingUninstall);assert.equal(cached.total,restored.total)
    await checkpoint('partial-before-reopen');const reopenSource=chain.sourceManifest(),oldLoader=chain.load,paths=chain.next.map(item=>item.path)
    await close();await start(true);assert.notEqual(chain.load,oldLoader);assert.deepEqual(chain.next.map(item=>item.path),paths);assert.deepEqual(chain.sourceManifest(),reopenSource);assert.deepEqual(chain.sourceManifest(),initialSource)
    await checkpoint('same-db-reopened-pending');assert(report.checkpoints.at(-1).installRows.some(row=>row.font_id===chain.old[0].id&&row.signature==='legacy-name-only'&&row.installed===1),'legacy row was destructively removed');await wait(async()=>!!(await ready()).page.items.find(font=>font.id===chain.next[1].id).pendingUninstall,'reopened retry')
    const residual=chain.store().load(chain.next[1].path).steps.find(step=>step.plan.delete_file).plan.path
    const prior=fs.readFileSync(residual),backup=residual+'.original';fs.renameSync(residual,backup);fs.writeFileSync(residual,prior)
    const effectCount=chain.effects.length;await useCommand(chain.next[1],'重试卸载');assert.equal(chain.effects.length,effectCount);assert(chain.store().load(chain.next[1].path),'replaced copy must retain receipt')
    fs.unlinkSync(residual);fs.renameSync(backup,residual);await useCommand(chain.next[1],'重试卸载');await wait(async()=>!(await ready()).page.items.find(font=>font.id===chain.next[1].id).pendingUninstall,'retry settled')
    assert.equal(chain.effects.filter(row=>row[0]==='file').length,1);assert.equal(chain.effects.filter(row=>row[0]==='registry').length,0);assert(!fs.existsSync(residual));await checkpoint('reopened-retry-settled')
    const retryEffects=chain.effects.length;const repeated=await chain.runtime.uninstallFontSystemWide(chain.next[1]);assert.equal(repeated.ok,false);assert.equal(chain.effects.length,retryEffects);
    const reopenedPreview=await previewSource(chain.next[0],'list','same-db-reopened-source');assert.equal(reopenedPreview.imageSha256,report.previews[0].imageSha256);
    report.cases.push({name:'partial-effect-same-db-reopen-physical-replacement-refusal-exact-retry',passed:true})
    // Same-content independent copies are ambiguous; two registrations naming
    // one physical copy are not. Both cases flow back through status/page/UI.
    await useCommand(chain.next[2],'安装');await wait(async()=>!!(await ready()).page.items.find(font=>font.id===chain.next[2].id).systemInstalled,'ambiguity installed')
    const primary=chain.records.find(row=>row.path.endsWith('renamed-2.ttf')),extra=path.join(chain.folders.installed,'independent-copy.ttf');fs.copyFileSync(primary.path,extra)
    const identity=chain.load('src/main/fonts/fontContentIdentityRuntime.ts');const physical=[await identity.readFontContentIdentity(primary.path),await identity.readFontContentIdentity(extra)];assert.notEqual(identity.fontPhysicalKey(physical[0]),identity.fontPhysicalKey(physical[1]))
    chain.records.push({...primary,path:extra,value:extra,registryName:primary.registryName+' extra'});chain.saveExternalState();await chain.confirmAndSave(chain.next[2]);await refresh()
    let beforeEffects=chain.effects.length;await useCommand(chain.next[2],'卸载字体');assert.equal(chain.effects.length,beforeEffects);assert.match(receipts.at(-1).result.results[chain.next[2].id].message,/多个/);assert(fs.existsSync(primary.path)&&fs.existsSync(extra))
    chain.records.splice(chain.records.findIndex(row=>row.path===extra),1);fs.unlinkSync(extra);chain.records.push({...primary,registryName:primary.registryName+' alias'});chain.saveExternalState();await chain.confirmAndSave(chain.next[2]);await refresh()
    await useCommand(chain.next[2],'卸载字体');assert.equal(chain.effects.slice(beforeEffects).filter(row=>row[0]==='registry').length,2);assert.equal(chain.effects.slice(beforeEffects).filter(row=>row[0]==='file').length,1)
    // A candidate with the same names but different bytes cannot assert installed.
    const wrong=path.join(chain.folders.installed,path.basename(chain.next[3].path));fs.copyFileSync(chain.next[7].path,wrong)
    chain.records.push({source:'HKCU',path:wrong,value:wrong,fileName:path.basename(wrong),registryName:chain.next[3].fullName,nameCandidates:[chain.next[3].fullName,chain.next[3].family]});chain.saveExternalState()
    const mismatch=await chain.confirmAndSave(chain.next[3]);assert.equal(mismatch.known,true);assert.equal(mismatch.installed,false);await refresh();assert.equal((await ready()).page.items.find(font=>font.id===chain.next[3].id).systemInstalled,false)
    beforeEffects=chain.effects.length;const refused=await chain.runtime.uninstallFontSystemWide(chain.next[3]);assert.equal(refused.ok,false);assert.equal(chain.effects.length,beforeEffects);assert(fs.existsSync(wrong))
    const sharedRequest={sidebarPage:'sharedTags',selectedTagName:'SharedKeep',limit:500}
    const shared=await chain.runtime.queryFontPageInLibrary(sharedRequest);assert.equal(shared.total,1);chain.controls.offline=true;chain.invalidate();const offline=await chain.runtime.queryFontPageInLibrary(sharedRequest);assert.equal(offline.total,1);assert.equal(offline.items[0].fileAvailability,'unavailable');assert.equal(offline.items[0].tagBindingReadOnly,true)
    await assert.rejects(chain.recovery.recover({mode:'relink',scope:'shared',fontPath:offline.items[0].path}),/暂不可访问/);assert.equal(chain.effects.length,beforeEffects);chain.controls.offline=false;chain.invalidate()
    assert.deepEqual(plain(chain.raw.prepare('SELECT * FROM local_font_tags ORDER BY font_path,tag_name').all()),recoveredBindings);await checkpoint('ambiguity-mismatch-offline-preserved');report.cases.push({name:'multi-physical-refusal-one-physical-multiple-records-name-mismatch-offline',passed:true})
    await checkpoint('final-before-exit')
    // Exit while a real picker request is in flight: shutdown epoch prevents its
    // later selection from entering a transaction. No timer/promise is abandoned.
    const exitSource=path.join(chain.folders.old,'exit.ttf');fs.copyFileSync(chain.next[6].path,exitSource)
    const exitItem=await chain.load('src/main/fonts/fontRuntime.ts').fontItemFromPath(exitSource);await chain.snapshots.capture([exitItem]);await chain.runtime.setLocalFontTagsBatch([{item:exitItem,tagNames:['Exit']}]);fs.unlinkSync(exitSource);chain.invalidate()
    const exitRows=plain(chain.raw.prepare('SELECT * FROM local_font_tags ORDER BY font_path,tag_name').all()),exitEffects=chain.effects.length,exitTransactions=chain.observed.transactions
    const exitTask=js(`window.hfm.recoverTagFiles(${JSON.stringify({mode:'relink',scope:'local',fontPath:exitItem.path})})`).then(result=>({result}),error=>({error:String(error)}))
    await wait(()=>pendingPicker,'exit picker')
    let shutdownOutcome
    const shutdown=chain.load('src/main/app/shutdownCoordinatorRuntime.ts').createShutdownCoordinator({log:chain.appendLog,freeze(){},restore(){},closeRenderers:async()=>true,cleanup:async()=>({remaining:0}),save:async()=>{},confirmLoss:async()=>false,drainLogs:async()=>{},terminate:outcome=>{shutdownOutcome=outcome}})
    await shutdown.request();assert.equal(shutdownOutcome.processExitClean,true)
    pendingPicker({canceled:false,filePaths:[chain.next[6].path]});pendingPicker=undefined
    const exitResult=await exitTask;assert.match(exitResult.error,/退出/);assert.equal(chain.observed.transactions,exitTransactions);assert.equal(chain.effects.length,exitEffects)
    assert.deepEqual(plain(chain.raw.prepare('SELECT * FROM local_font_tags ORDER BY font_path,tag_name').all()),exitRows)
    report.cases.push({name:'exit-inflight-picker-old-epoch-zero-commit',passed:true,shutdownScope:'real epoch owner; controlled host shutdown ports; physical child drain checked separately',shutdownOutcome,result:exitResult})
    const events=chain.logs.concat(report.logs).filter(line=>line.startsWith('operation-chain: ')).map(line=>{try{return JSON.parse(line.slice(17))}catch{return null}}).filter(Boolean)
    const observation=events.find(event=>event.stage==='page-view-observed'&&event.trace?.domain==='tag-recovery');assert(observation,'real recovery page postcommit observation missing')
    const operationId=observation.trace.operationId;report.recoveryObservation={operationId,endpoint:'react-commit-observation, not paint',events:events.filter(event=>event.trace?.operationId===operationId)}
    assert(report.recoveryObservation.events.some(event=>event.stage==='page-query-accepted'))
    report.receipts=receipts;report.pickerCalls=pickerCalls;report.finalSource=chain.sourceManifest();report.observed=chain.observed
    fs.writeFileSync(path.join(directory,'final.png'),(await win.webContents.capturePage()).toPNG())
    await close();report.remainingChildren=0
    assert(report.cases.every(row=>row.passed),'incomplete integrated case');report.passed=true;console.log('[F14 integrated]',JSON.stringify({sourceSha:report.sourceSha,cases:report.cases.map(row=>row.name),previews:report.previews.length,remainingChildren:0,passed:true}))
  }catch(error){report.error=error?.stack||String(error);if(win&&!win.isDestroyed()){try{fs.writeFileSync(path.join(directory,'failure.png'),(await win.webContents.capturePage()).toPNG())}catch{}}report.logs.push(...(chain?.logs||[]));fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(directory,'operation-chain.log'),report.logs.join('\n'));throw error}
  finally{try{await close()}catch(error){report.cleanupError=String(error);report.passed=false}report.pickerCalls=pickerCalls;clearTimeout(timer);fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(directory,'operation-chain.log'),report.logs.join('\n'));app.removeListener('window-all-closed',keepAlive)}
}
module.exports={run}
