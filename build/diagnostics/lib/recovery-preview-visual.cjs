const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const hash=value=>crypto.createHash('sha256').update(value).digest('hex')
const comparable=value=>JSON.stringify(value)
const summarize=value=>{const {currentSrc,...rest}=value;return {...rest,currentSrcSha256:hash(currentSrc||'')}}
async function bounded(promise,deadline){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('F14 visual existing15s deadline exceeded')),Math.max(1,deadline-Date.now()))})])}finally{clearTimeout(timer)}}
async function capturePreviewEvidence({win,js,report,directory,id,mode,label,source,key,deadline}){
 const start=Date.now(),entry={label,mode,id,key,startedAt:new Date().toISOString(),deadlineMs:Math.max(0,deadline-start),zoom:win.webContents.getZoomFactor(),themes:[],passed:false}
 ;(report.visuals||=[]).push(entry)
 const args=`${JSON.stringify(id)},${JSON.stringify(mode)}`
 const snapshot=()=>bounded(js(`window.recoveryChain.visualSnapshot(${args})`),deadline)
 const themes=mode==='grid'?['light','dark','light']:['light']
 const sameTarget=value=>value.connected&&value.id===id&&value.mode===mode&&value.currentSrc===source&&value.key===key&&value.complete
 const recordCapture=async file=>{
  const before=await snapshot(),capture=await bounded(win.webContents.capturePage(),deadline)
  fs.writeFileSync(file,capture.toPNG())
  const observed=await bounded(js(`window.recoveryChain.visualPixels(${args},${JSON.stringify(capture.toDataURL())})`),deadline)
  const after=await snapshot()
  return {before,after,observed,stable:comparable(before)===comparable(observed.before)&&comparable(before)===comparable(observed.after)&&comparable(before)===comparable(after),file:path.basename(file),elapsedMs:Date.now()-start}
 }
 try {
  const initial=await snapshot();assert(sameTarget(initial),'live target differs from decoded current preview')
  const cropFile=path.join(directory,`${label}-${mode}-live-crop.png`)
  fs.writeFileSync(cropFile,Buffer.from(initial.currentSrc.split(',')[1],'base64'))
  entry.crop={file:path.basename(cropFile),sha256:hash(fs.readFileSync(cropFile)),width:initial.naturalWidth,height:initial.naturalHeight}
  for(const [index,theme] of themes.entries()){
   if(index)await bounded(js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`),deadline)
   const phase={theme,index,attempts:[],firstVisibleMs:null,observedVisibilityDelayMs:null,observedBlankUntilVisibleMs:null,passed:false};entry.themes.push(phase)
   const prefix=`${label}-${mode}-${theme}-${index}`
   const first=await recordCapture(path.join(directory,`${prefix}-initial.png`))
   phase.initial={target:summarize(first.before),after:summarize(first.after),pixels:first.observed.pixels,stable:first.stable,file:first.file,elapsedMs:first.elapsedMs}
   phase.initialGlyphVisible=first.observed.pixels.anyPolarityGlyphVisible
   phase.initialExpectedThemeGlyphVisible=first.observed.pixels.pass
   phase.initialEvidenceStable=first.stable&&sameTarget(first.before)&&first.before.visible&&first.before.supported
   if(phase.initialEvidenceStable&&first.observed.pixels.pass)phase.firstVisibleMs=first.elapsedMs
   let stablePasses=0,previous='',last
   while(Date.now()<deadline&&stablePasses<2){
    await bounded(js(`window.recoveryChain.visualFrames(${args},${Math.max(1,deadline-Date.now())})`),deadline)
    last=await recordCapture(path.join(directory,`${prefix}-settled.png`))
    const identity=comparable(last.before),valid=last.stable&&sameTarget(last.before)&&last.before.theme===theme&&last.before.visible&&last.before.supported&&last.observed.pixels.pass
    stablePasses=valid?(identity===previous?stablePasses+1:1):0;previous=identity
    const attempt={elapsedMs:last.elapsedMs,stable:last.stable,valid,stablePasses,target:summarize(last.before),pixels:last.observed.pixels}
    if(phase.attempts.length<12)phase.attempts.push(attempt);phase.lastAttempt=attempt
    if(valid&&phase.firstVisibleMs===null)phase.firstVisibleMs=last.elapsedMs
   }
   assert.equal(stablePasses,2,`Target glyph never visibly settled: ${label}/${mode}/${theme}`)
   phase.observedVisibilityDelayMs=phase.firstVisibleMs-first.elapsedMs
   if(phase.initialEvidenceStable&&!phase.initialGlyphVisible)phase.observedBlankUntilVisibleMs=phase.observedVisibilityDelayMs
   phase.timingScope='Interval between completed screenshot analyses; not exact paint time or proof of a paint-race cause'
   phase.final={target:summarize(last.before),pixels:last.observed.pixels,file:last.file,elapsedMs:last.elapsedMs};phase.passed=true
   if(index===0)fs.copyFileSync(path.join(directory,last.file),path.join(directory,`${label}-${mode}.png`))
  }
  entry.elapsedMs=Date.now()-start;entry.passed=true
 }catch(error){entry.error=error.stack||String(error);entry.elapsedMs=Date.now()-start;throw error}
 finally {if(Date.now()<deadline)await bounded(js("document.documentElement.dataset.theme='light'"),deadline).catch(()=>{})}
 return entry
}
module.exports={capturePreviewEvidence}
