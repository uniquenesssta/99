// Small real React surface; production cards, menu, commands, page hook and
// preview owners. This deliberately is not an App.tsx startup claim.
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
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
import { previewImageTrace, previewEvent } from '../../../src/renderer/src/runtime/preview/previewTraceRuntime'
const noop=()=>{}, ref=(current:any)=>({current}), stableEmpty:any[]=[], activeFilter={kind:'all'}
const host=document.createElement('main');document.body.append(host)
let api:any, preview:any
function App({shell}:any) {
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
    snapshot:()=>({ready:derived.databasePageReady,page,library,status,refreshToken,requestSeq:seq.current,acceptedRevision:acceptedRevision.current,busy:[...busy.current],failed,revision,mode}),
    // Deliberately stale UI is used only to challenge authority; source preview
    // always takes the truthful query row, never this stale library mutation.
    staleInstalled:(id:string)=>setLibrary((old:any)=>({...old,fonts:{...old.fonts,[id]:{...old.fonts[id],systemInstalled:true,installStatusKnown:true}}})),
  }
  return <><p id="chain-status">{status}</p><select aria-label="安装状态" value={installStatus} onChange={event=>setInstallStatus(event.currentTarget.value)}><option value="all">全部状态</option><option value="installed">已安装</option><option value="notInstalled">未安装</option></select>
    <div id="cards">{(page?.items||[]).map((font:any)=><FontCard key={font.id} {...{font,active:false,selected:false,compact:mode==='list',previewText:'Ag fj',listPreviewFontSize:44,onSelect:noop,onOpenDetail:noop,onVisible:()=>{if(preview?.targets.has(font.id))preview.runtime.requestPreviewFont(font,'high')},onContextMenu:(event:any)=>{event.preventDefault();open(font)},previewStateForFont:(item:any)=>preview?.runtime.previewStateForFont?.(item)} as any} />)}</div>
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
;(window as any).startRecoveryChain=(shell:any)=>{createRoot(host).render(<App shell={shell}/>)}
;(window as any).recoveryChain={
  snapshot:()=>api?.snapshot(),refresh:()=>api.refresh(),filter:(status:string)=>api.setInstallStatus(status),staleInstalled:(id:string)=>api.staleInstalled(id),
  preview:(ids:string[],mode:'list'|'grid')=>{const fonts=ids.map(id=>api.getFont(id));if(fonts.some(font=>!font))throw Error('preview item must come from current query page');makePreview(fonts,mode)},
  previewSnapshot:()=>preview?{error:preview.error,decoded:[...preview.decoded.values()],queued:preview.options.previewQueue.current.length,running:preview.options.activePreviewLoads.current,loading:preview.options.loadingFonts.current.size}:null,
  reRequest:(id:string,metadataOnly=false)=>{const item=api.getFont(id);preview.runtime.requestPreviewFont(metadataOnly?{...item,favorite:!item.favorite,localTagNames:[...item.localTagNames,'metadata-only']}:item,'high')},
  disposePreview:()=>{preview?.runtime.disposePreviewQueue();preview=undefined;api.bump()},
}
