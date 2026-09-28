import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { buildFontViewLayout } from '../../../src/renderer/src/runtime/app/fontViewLayoutRuntime'
import { buildVirtualLayout } from '../../../src/renderer/src/fontViewRuntime'
import { useRendererDatabasePageRuntime } from '../../../src/renderer/src/runtime/database/useRendererDatabasePageRuntime'
import { rendererFontQueryCacheKey } from '../../../src/renderer/src/appRuntime'
import { setupFloatingScrollbars } from '../../../src/renderer/src/utils/floatingScrollbars'
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()))
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const check=(ok:unknown,message:string)=>{if(!ok)throw Error('[view-feedback] '+message)}
const empty:any[]=[],noop=()=>{},filter={kind:'all'},allFonts=Array.from({length:10000},(_,i)=>({id:'p'+i,path:'C:/fonts/'+i+'.ttf',fileName:'Font '+i,tagNames:[],scripts:[]}))
let current:any,calls:number[]=[]
const hfm={queryFontPage:async(request:any)=>{
 calls.push(request.offset);await wait(request.offset===0?15:35)
 return {queryKey:rendererFontQueryCacheKey(request),items:allFonts.slice(request.offset,request.offset+request.limit),offset:request.offset,limit:request.limit,total:allFonts.length,truncated:true,engine:'fixture',elapsedMs:1}
}}
function Paging({mode}:{mode:'list'|'grid'}) {
 const [page,setPage]=useState<any>(null),[failed,setFailed]=useState(''),[library,setLibrary]=useState<any>({fonts:{},folders:['C:/fonts'],collections:[],tags:[],localTags:[]})
 const [top,setTop]=useState(0),node=useRef<HTMLDivElement>(null),loaded=useRef(true),seq=useRef(0),metrics=useRef(0),scrolling=useRef(false)
 const width=innerWidth-40,layout=buildFontViewLayout(mode,'comfortable',width,57,1),viewport={width,height:420,scrollTop:top}
 const database=useRendererDatabasePageRuntime({hfm,library,libraryLoadedRef:loaded,databaseRefreshToken:0,databasePageResult:page,databaseQueryFailedKey:failed,virtualViewport:viewport,viewLayout:layout,
 allFontsLength:10000,sidebarPage:'library',indexingActive:false,deferredSearch:'',activeFilter:filter,selectedWatchedFolders:empty,selectedFormats:empty,selectedScripts:empty,selectedCategory:'all',selectedTagName:'',selectedSharedTagName:'',selectedFolderId:'',selectedFontId:'',selectedFontIds:empty,installStatus:'all',timeSortMode:'none',sortMode:'name-asc',fontListScrollingRef:scrolling,fontMetricsRequestSeqRef:metrics,databasePageRequestSeqRef:seq,rendererUserActive:()=>false,reportTrace:noop,setDatabaseFontMetrics:noop,setDatabasePageResult:setPage,setDatabaseQueryResult:noop,setDatabaseQueryFailedKey:setFailed,setLibrary,setStatus:noop} as any)
 const virtual=buildVirtualLayout({...layout,visibleFonts:page?.items||[],databasePageReady:database.databasePageReady,databasePageResult:page,virtualViewport:viewport})
 current={node,layout,virtual,page,ready:database.databasePageReady}
 return <div ref={node} className="font-virtual-scroller" style={{height:420,width,position:'relative',overflow:'auto',flex:'none'}} onScroll={e=>setTop(e.currentTarget.scrollTop)}>
  <div style={{height:virtual.totalHeight,position:'relative'}}><div style={{position:'absolute',top:virtual.top,display:'grid',gridTemplateColumns:`repeat(${layout.columns},1fr)`,gap:layout.rowGap,width:'100%'}}>
   {virtual.items.map(font=><div key={font.id} data-page-font={font.id} style={{height:layout.cardHeight}}>{font.fileName}</div>)}
  </div></div>
 </div>
}
;(window as any).checkViewFeedback=async()=>{
 const host=document.getElementById('fixture')!,root=createRoot(host)
 let checks=0
 for(const mode of ['list','grid'] as const){
  calls=[];flushSync(()=>root.render(<Paging key={mode} mode={mode}/>))
  for(let n=0;n<90&&!current.ready;n++)await frame()
  check(current.ready,'initial database page not ready')
  const node=current.node.current as HTMLElement,height=node.scrollHeight
  for(const fraction of [.82,.12,.97,0]){
   const target=Math.round((height-node.clientHeight)*fraction)
   // Rapid middle-autoscroll/drag-like input: old page responses arrive after
   // the viewport has moved. The real page hook must settle at the latest range.
   for(let n=1;n<=5;n++){node.scrollTop=target*n/5;node.dispatchEvent(new Event('scroll'));await frame()}
   for(let n=0;n<70;n++){
    await frame()
    check(node.scrollHeight===height,'page arrival changed total scroll height')
    check(Math.abs(node.scrollTop-target)<=1,'late page response pulled viewport backwards')
    const first=Math.floor(Math.max(0,target-14)/current.layout.rowHeight)*current.layout.columns
    if(current.page?.offset<=first&&current.page.offset+current.page.items.length>first)break
    if(n===69)throw Error('[view-feedback] visible page never loaded: '+JSON.stringify({mode,target,first,page:current.page?.offset,calls}))
   }
   const index=Math.floor(Math.max(0,target-14)/current.layout.rowHeight)*current.layout.columns
   check(!!host.querySelector(`[data-page-font="p${index}"]`),'visible row mapped to wrong database offset')
   check(host.querySelectorAll('[data-page-font]').length<100,'page accumulation escaped virtualization')
   checks++
  }
  check(calls.some(offset=>offset>7000),'fast jump did not request its destination page')
 }
 flushSync(()=>root.unmount())
 return {fastPageJumps:checks}
}
let scrollHost:HTMLDivElement,cleanup:()=>void,removeProbe:()=>void,events:any[]=[]
;(window as any).prepareScrollbarDrag=async()=>{
 scrollHost=document.createElement('div');scrollHost.className='font-virtual-scroller'
 scrollHost.style.cssText='position:fixed;left:40px;top:80px;width:500px;height:300px;overflow:auto;z-index:1;'
 scrollHost.innerHTML='<div style="height:10000px;width:1200px"></div>';document.body.append(scrollHost)
 cleanup=setupFloatingScrollbars();scrollHost.dispatchEvent(new MouseEvent('mouseenter'))
 events=[]
 const probe=(event:Event)=>{
  const target=event.target as HTMLElement,pointer=event as PointerEvent
  if(target!==scrollHost&&!target?.closest?.('.hfm-floating-scrollbar'))return
  events.push({type:event.type,target:target.className,trusted:event.isTrusted,buttons:pointer.buttons,id:pointer.pointerId,x:pointer.clientX,y:pointer.clientY})
  if(events.length>80)events.shift()
 }
 const types=['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture','mouseenter','mouseleave','focus','blur','scroll']
 types.forEach(type=>document.addEventListener(type,probe,true))
 removeProbe=()=>types.forEach(type=>document.removeEventListener(type,probe,true))
 await frame();await frame()
 const vertical=[...document.querySelectorAll<HTMLElement>('.hfm-floating-scrollbar.vertical.visible')].find(el=>Math.abs(el.getBoundingClientRect().right-537)<2)!
 check(vertical,'visible scrollbar missing or outside host')
 const r=vertical.getBoundingClientRect(),thumb=vertical.firstElementChild!.getBoundingClientRect()
 check(Math.abs(r.top-84)<1&&Math.abs(r.bottom-376)<1,'fixed scrollbar uses static body origin')
 const horizontal=[...document.querySelectorAll<HTMLElement>('.hfm-floating-scrollbar.horizontal.visible')].find(el=>Math.abs(el.getBoundingClientRect().top-371)<2)!
 check(horizontal,'horizontal overflow has no position indicator')
 horizontal.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))
 const maxLeft=scrollHost.scrollWidth-scrollHost.clientWidth
 check(maxLeft>600&&scrollHost.scrollLeft===maxLeft,'horizontal scrollbar cannot navigate: '+JSON.stringify({actual:scrollHost.scrollLeft,maxLeft,clientWidth:scrollHost.clientWidth,scrollWidth:scrollHost.scrollWidth}))
 return {x:Math.round(thumb.x+thumb.width/2),y:Math.round(thumb.y+thumb.height/2),endY:Math.round(r.bottom-2)}
}
;(window as any).finishScrollbarDrag=async()=>{
 await frame();await frame()
 check(events.some(event=>event.type==='pointerdown'&&event.trusted&&event.buttons===1)&&events.some(event=>event.type==='pointerup'&&event.trusted&&event.buttons===0),'native drag button lifecycle missing: '+JSON.stringify(events))
 check(scrollHost.scrollTop>9000,'trusted pointer drag did not reach bottom')
 const focusedBeforeIdle=(document.activeElement as HTMLElement)?.className
 // Keyboard focus deliberately keeps a scrollbar visible. Idle means both
 // pointer and focus have left, rather than merely a pause during navigation.
 ;(document.activeElement as HTMLElement)?.blur()
 scrollHost.dispatchEvent(new MouseEvent('mouseleave'))
 for(const bar of document.querySelectorAll('.hfm-floating-scrollbar'))bar.dispatchEvent(new MouseEvent('mouseleave'))
 await wait(1050);await frame()
 check(document.querySelectorAll('.hfm-floating-scrollbar.visible').length===0,'idle scrollbar failed to hide: '+JSON.stringify({focusedBeforeIdle,active:(document.activeElement as HTMLElement)?.className,events,visible:[...document.querySelectorAll<HTMLElement>('.hfm-floating-scrollbar.visible')].map(el=>({class:el.className,hover:el.matches(':hover'),capture:el.hasPointerCapture(1),top:el.getBoundingClientRect().top,left:el.getBoundingClientRect().left}))}))
 removeProbe();cleanup();scrollHost.remove()
 check(document.querySelectorAll('.hfm-floating-scrollbar').length===0,'scrollbar observers/hosts leaked on cleanup')
 return {drag:true,autoHide:true,cleanup:true,focusedBeforeIdle}
}
