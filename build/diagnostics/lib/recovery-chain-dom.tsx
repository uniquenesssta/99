// Small real React surface; production cards, menu, commands, page hook and
// preview owners. This deliberately is not an App.tsx startup claim.
import React, { useEffect, useRef, useState } from 'react'
import { compareGlyphPixels } from './recovery-preview-pixels.cjs'
import { createRoot } from 'react-dom/client'
import { SharedAvailabilityProvider, useSharedAvailability } from '../../../src/renderer/src/sharedAvailabilityRuntime'
import { FontCard } from '../../../src/renderer/src/components/FontCard'
import { AppOverlays } from '../../../src/renderer/src/components/app/AppOverlays'
import { createFontDialogContextActions } from '../../../src/renderer/src/fontDialogContextActionsRuntime'
import { createFontInstallActionRuntime } from '../../../src/renderer/src/runtime/system/actions/fontInstallActionRuntime'
import { createFontSystemStateRuntime } from '../../../src/renderer/src/runtime/system/actions/fontSystemStateRuntime'
import { createFontCommandRuntime } from '../../../src/renderer/src/fontCommandRuntime'
import { useRendererDatabasePageRuntime } from '../../../src/renderer/src/runtime/database/useRendererDatabasePageRuntime'
import { refreshDatabaseDerivedStateRuntime } from '../../../src/renderer/src/databaseDerivedStateRuntime'
import { noteFontRefreshRequest, observeFontRefreshPage, cancelFontRefreshObservation } from '../../../src/renderer/src/fontOperationTrace'
import { createFontPreviewQueueRuntime } from '../../../src/renderer/src/runtime/preview/fontPreviewQueueRuntime'
import { getCardPreviewLayout } from '../../../src/shared/preview-layout/previewTextFitRuntime'
import { gridPreviewPostprocess } from '../../../src/renderer/src/runtime/preview/gridNativePreviewImageTrimRuntime'
import { previewImageTrace, previewEvent } from '../../../src/renderer/src/runtime/preview/previewTraceRuntime'
const noop=()=>{}, ref=(current:any)=>({current}), stableEmpty:any[]=[], activeFilter={kind:'all'}
const host=document.createElement('main');document.body.append(host)
let api:any, preview:any
function App({shell}:any) {
  const availability=useSharedAvailability()
  const [library,setLibrary]=useState(shell),[page,setPage]=useState<any>(null),[failed,setFailed]=useState(''),[status,setStatus]=useState(''),[refreshToken,setRefresh]=useState(0),[installStatus,setInstallStatus]=useState<any>('all'),[menu,setMenu]=useState<any>(null),[mode,setMode]=useState<any>('list'),[revision,bump]=useState(0)
  const current=useRef(library);current.current=library
  const refreshTimer=useRef<number|null>(null),acceptedRevision=useRef(0),seq=useRef(0),metrics=useRef(0),busy=useRef(new Set<string>()),loaded=useRef(true),scrolling=useRef(false)
  const refresh=()=>{refreshDatabaseDerivedStateRuntime({timerRef:refreshTimer,clearTimeout:window.clearTimeout.bind(window),setDatabasePageResult:setPage,setDatabaseQueryResult:noop,setDatabaseFontMetrics:noop,setDatabaseRefreshToken:setRefresh,databasePageRequestSeqRef:seq,fontMetricsRequestSeqRef:metrics});noteFontRefreshRequest(seq)}
  const derived=useRendererDatabasePageRuntime({hfm:window.hfm,library,libraryLoadedRef:loaded,databaseRefreshToken:refreshToken,databasePageResult:page,databaseQueryFailedKey:failed,
    virtualViewport:{width:900,height:600,scrollTop:0},viewLayout:{rowHeight:100,minCardWidth:200,columns:1},allFontsLength:Object.keys(library.fonts).length,sidebarPage:'tags',indexingActive:false,deferredSearch:'',activeFilter,
    selectedWatchedFolders:stableEmpty,selectedFormats:stableEmpty,selectedScripts:stableEmpty,selectedCategory:'all',selectedTagName:'Recover',selectedSharedTagName:'',selectedFolderId:'',selectedFontId:'',selectedFontIds:stableEmpty,
    installStatus,timeSortMode:'custom',sortMode:'nameAsc',fontListScrollingRef:scrolling,fontMetricsRequestSeqRef:metrics,databasePageRequestSeqRef:seq,rendererUserActive:()=>false,reportTrace:noop,
    setDatabaseFontMetrics:noop,setDatabasePageResult:setPage,setDatabaseQueryResult:noop,setDatabaseQueryFailedKey:setFailed,setLibrary,setStatus} as any)
  useEffect(()=>{observeFontRefreshPage(page,derived.databasePageReady);if(page&&derived.databasePageReady)acceptedRevision.current++},[page,derived.databasePageReady])
  useEffect(()=>()=>{cancelFontRefreshObservation(seq,'fixture-unmounted');preview?.runtime.disposePreviewQueue()},[])
  const systemOptions:any={hfm:window.hfm,library,getCurrentLibrary:()=>current.current,setLibrary,setStatus,setContextMenu:setMenu,flushProtectionWrites:async()=>true,activeOperationFontIds:busy,refreshDatabaseDerivedState:refresh,setDatabaseFontMetrics:noop}
  const state=createFontSystemStateRuntime(systemOptions)
  const actions=createFontInstallActionRuntime(systemOptions,state,{deactivateFontByCard:async()=>{throw Error('activation is forbidden in this scenario')}})
  const command=createFontCommandRuntime({library,getCurrentLibrary:()=>current.current,selectedFontIds:stableEmpty,getVisibleFonts:()=>page?.items||[],setStatus,...actions} as any)
  const dialog=createFontDialogContextActions({contextMenu:menu,sidebarPage:'tags',hfm:window.hfm,setContextMenu:setMenu,setStatus,refreshDatabaseDerivedState:refresh,flushFontWriteQueue:async()=>true} as any)
  const open=(font:any)=>setMenu({kind:'font',font,x:10,y:10})
  api={refresh,setInstallStatus,setMode,bump:()=>bump(value=>value+1),getFont:(id:string)=>page?.items.find((item:any)=>item.id===id),
    snapshot:()=>({ready:derived.databasePageReady,availability,page,library,status,refreshToken,requestSeq:seq.current,acceptedRevision:acceptedRevision.current,busy:[...busy.current],failed,revision,mode}),
    // Deliberately stale UI is used only to challenge authority; source preview
    // always takes the truthful query row, never this stale library mutation.
    staleInstalled:(id:string)=>setLibrary((old:any)=>({...old,fonts:{...old.fonts,[id]:{...old.fonts[id],systemInstalled:true,installStatusKnown:true}}})),
  }
  return <><p id="chain-status">{status}</p><select aria-label="安装状态" value={installStatus} onChange={event=>setInstallStatus(event.currentTarget.value)}><option value="all">全部状态</option><option value="installed">已安装</option><option value="notInstalled">未安装</option></select>
    <div id="cards" className={mode==='grid'?'f14-grid':'f14-list'}>{(page?.items||[]).map((font:any)=><FontCard key={font.id} {...{font,active:false,selected:false,compact:mode==='list',previewText:'Ag fj',listPreviewFontSize:44,onSelect:noop,onOpenDetail:noop,onVisible:()=>{if(preview?.targets.has(font.id))preview.runtime.requestPreviewFont(font,'high')},onContextMenu:(event:any)=>{event.preventDefault();open(font)},previewStateForFont:(item:any)=>preview?.runtime.previewStateForFont?.(item)} as any} />)}</div>
    <AppOverlays {...{contextMenu:menu,contextSelectedFonts:menu?[menu.font]:[],contextTargetCount:menu?1:0,runFontContextAction:(action:any)=>command(action,[menu.font.id],[menu.font],'font-context'),...dialog,setLeaseLockConflictNotice:noop} as any}/></>
}
function makePreview(fonts:any[],mode:'list'|'grid') {
  preview?.runtime.disposePreviewQueue()
  const spec=getCardPreviewLayout(mode,'Ag fj',44),decoded=new Map<string,any>(),inFlight=new Map<string,Promise<void>>()
  const options:any={hfm:window.hfm,previewText:'Ag fj',previewLayoutMode:mode,listPreviewFontSize:44,previewRequestTokenRef:ref(spec.token),selectedFontId:'',selectedFontIds:[],indexingActive:false,
    previewFamilies:{},nativePreviewImages:{},failedPreviewFontIds:Object.fromEntries(fonts.map(font=>[font.id,true])),loadingFonts:ref(new Set()),queuedPreviewFontIds:ref(new Set()),previewQueue:ref([]),activePreviewLoads:ref(0),fontListScrollingRef:ref(false),
    autoPreviewCacheRunId:ref(0),autoPreviewCacheQueue:ref([]),queuedAutoPreviewCacheIds:ref(new Set()),activeAutoPreviewCacheLoads:ref(0),autoPreviewCacheStats:ref({}),isBadFontRecord:()=>false,rendererUserActive:()=>false,
    setPreviewFamilies(update:any){options.previewFamilies=typeof update==='function'?update(options.previewFamilies):update},
    setFailedPreviewFontIds(update:any){options.failedPreviewFontIds=typeof update==='function'?update(options.failedPreviewFontIds):update},
    setNativePreviewImages(update:any){options.nativePreviewImages=typeof update==='function'?update(options.nativePreviewImages):update;for(const font of fonts){const value=options.nativePreviewImages[font.id];if(!value||inFlight.has(value))continue;const work=(async()=>{const image=new Image();image.src=value;await image.decode();if(image.naturalWidth!==spec.width||image.naturalHeight!==spec.height)throw Error('wrong private PNG dimensions');const trace=previewImageTrace(value,font.id);if(!trace)throw Error('PNG trace missing');previewEvent(trace,'image-load');decoded.set(font.id,{id:font.id,path:font.path,key:preview.runtime.previewStateForFont(font).key,width:image.naturalWidth,height:image.naturalHeight,operationId:trace.operationId,image:value});api.bump()})().catch(error=>{preview.error=String(error)});inFlight.set(value,work)}},setNativeDetailImage:noop,updateFont:noop,setStatus:noop}
  preview={runtime:createFontPreviewQueueRuntime(options),options,targets:new Set(fonts.map(font=>font.id)),decoded,inFlight}
  api.setMode(mode);api.bump()
  for(const font of fonts)preview.runtime.requestPreviewFont(font,'high')
}
const visualNodes = new WeakMap<Element, number>()
let visualNodeSequence = 0
const visualNodeId = (node: Element) => { let id=visualNodes.get(node); if(!id){id=++visualNodeSequence;visualNodes.set(node,id)}return id }
function visualSnapshot(id: string, mode: string) {
  const cards=[...document.querySelectorAll<HTMLElement>('[data-font-id]')].filter(card=>card.dataset.fontId===id)
  if(cards.length!==1)throw Error('visual target is missing or duplicated')
  const card=cards[0],images=[...card.querySelectorAll<HTMLImageElement>('img')].filter(image=>image.classList.contains(mode==='grid'?'grid-native-preview-image':'font-sample-image'))
  if(images.length!==1)throw Error('visual target image is missing or duplicated')
  const image=images[0],rect=(node:Element)=>{const value=node.getBoundingClientRect();return {x:value.x,y:value.y,width:value.width,height:value.height}}
  const ancestors=[];let clip={x:0,y:0,width:window.innerWidth,height:window.innerHeight},visible=true,supported=true
  const intersect=(a:any,b:any)=>{const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)}}
  for(let node:Element|null=image;node;node=node.parentElement){
    const c=getComputedStyle(node),box=rect(node),transform=c.transform
    if(transform!=='none'){const match=/^matrix\(([^)]+)\)$/.exec(transform),values=match?.[1].split(',').map(Number);if(!values||values.length!==6||!values.every(Number.isFinite)||values[0]<=0||values[3]<=0||Math.abs(values[1])>0.0001||Math.abs(values[2])>0.0001)supported=false}
    if(c.display==='none'||c.visibility!=='visible'||Number(c.opacity)<0.99)visible=false
    if(c.clipPath!=='none'||(c.clip!=='auto'&&c.clip!==''))supported=false
    if(c.filter!=='none'&&!(node===image&&c.filter==='invert(1)'))supported=false
    const clipX=/(hidden|clip|auto|scroll)/.test(c.overflowX),clipY=/(hidden|clip|auto|scroll)/.test(c.overflowY)
    if(node!==image&&(clipX||clipY))clip=intersect(clip,{x:clipX?box.x:clip.x,y:clipY?box.y:clip.y,width:clipX?box.width:clip.width,height:clipY?box.height:clip.height})
    ancestors.push({node:visualNodeId(node),tag:node.tagName,className:node.className,rect:box,display:c.display,visibility:c.visibility,opacity:c.opacity,filter:c.filter,transform,transformOrigin:c.transformOrigin,overflowX:c.overflowX,overflowY:c.overflowY,clip:c.clip,clipPath:c.clipPath,background:c.backgroundColor,backgroundImage:c.backgroundImage})
  }
  const style=getComputedStyle(image),box=rect(image)
  if(!['none','fill'].includes(style.objectFit))supported=false
  if(style.objectFit==='none'&&(image.offsetWidth!==image.naturalWidth||image.offsetHeight!==image.naturalHeight))supported=false
  const current=api.getFont(id),state=current&&preview?.runtime.previewStateForFont(current)
  return {id,mode:api.snapshot().mode,node:visualNodeId(image),cardNode:visualNodeId(card),connected:image.isConnected&&card.isConnected,currentSrc:image.currentSrc||image.src,key:state?.key,
    complete:image.complete,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,rect:box,clip,visible,supported,
    objectFit:style.objectFit,objectPosition:style.objectPosition,theme:document.documentElement.dataset.theme,devicePixelRatio:window.devicePixelRatio,viewport:{width:window.innerWidth,height:window.innerHeight},ancestors}
}
async function visualFrames(id:string,mode:string,remainingMs:number) {
  const value=visualSnapshot(id,mode),image=[...document.querySelectorAll<HTMLImageElement>('img')].find(node=>visualNodeId(node)===value.node)!
  let timer:number|undefined
  try {await Promise.race([(async()=>{await image.decode();await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))})(),new Promise((_,reject)=>{timer=window.setTimeout(()=>reject(Error('visual existing deadline')),remainingMs)})])}
  finally {if(timer!==undefined)window.clearTimeout(timer)}
  return visualSnapshot(id,mode)
}
async function visualPixels(id:string,mode:string,capture:string) {
  const before=visualSnapshot(id,mode),image=[...document.querySelectorAll<HTMLImageElement>('img')].find(node=>visualNodeId(node)===before.node)!,shot=new Image(),canvases:HTMLCanvasElement[]=[]
  const pixels=(source:CanvasImageSource,width:number,height:number)=>{const canvas=document.createElement('canvas');canvases.push(canvas);canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(source,0,0);return {width,height,pixels:ctx.getImageData(0,0,width,height).data}}
  try {shot.src=capture;await shot.decode();const source=pixels(image,image.naturalWidth,image.naturalHeight),captured=pixels(shot,shot.naturalWidth,shot.naturalHeight);const input={source,captured,rect:before.rect,clip:before.clip,viewport:before.viewport,theme:before.theme};const result=compareGlyphPixels(input),opposite=compareGlyphPixels({...input,theme:before.theme==='light'?'dark':'light'});return {before,after:visualSnapshot(id,mode),pixels:{...result,anyPolarityGlyphVisible:result.pass||opposite.pass}}}
  finally {shot.removeAttribute('src');for(const canvas of canvases){canvas.width=0;canvas.height=0}}
}
;(window as any).startRecoveryChain=(shell:any)=>{createRoot(host).render(<SharedAvailabilityProvider><App shell={shell}/></SharedAvailabilityProvider>)}
;(window as any).recoveryChain={
  visualSnapshot,visualFrames,visualPixels,
  snapshot:()=>api?.snapshot(),refresh:()=>api.refresh(),filter:(status:string)=>api.setInstallStatus(status),staleInstalled:(id:string)=>api.staleInstalled(id),
  preview:(ids:string[],mode:'list'|'grid')=>{const fonts=ids.map(id=>api.getFont(id));if(fonts.some(font=>!font))throw Error('preview item must come from current query page');makePreview(fonts,mode)},
  expectedCardImage:async(id:string,mode:string)=>{const source=preview.decoded.get(id)?.image;if(!source)throw Error('raw decoded source absent');let image=source;if(mode==='grid'){let release=()=>{};try{image=await new Promise<string>(resolve=>{release=gridPreviewPostprocess.request(source,value=>resolve(value.image))})}finally{release()}}const decoded=new Image();decoded.src=image;await decoded.decode();return {image,width:decoded.naturalWidth,height:decoded.naturalHeight,route:mode==='grid'?'production-grid-crop':'original-list-png'}},
  previewSnapshot:()=>preview?{error:preview.error,decoded:[...preview.decoded.values()],queued:preview.options.previewQueue.current.length,running:preview.options.activePreviewLoads.current,loading:preview.options.loadingFonts.current.size}:null,
  reRequest:(id:string,metadataOnly=false)=>{const item=api.getFont(id);preview.runtime.requestPreviewFont(metadataOnly?{...item,favorite:!item.favorite,localTagNames:[...item.localTagNames,'metadata-only']}:item,'high')},
  disposePreview:()=>{preview?.runtime.disposePreviewQueue();preview=undefined;api.bump()},
}
