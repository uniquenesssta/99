// Real React mounting, production cards/panel/layout and transition owners.
// Font data and detail content are fixtures; no native renderer or database I/O.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AppLayout } from '../../../src/renderer/src/components/app/AppLayout'
import { FontListPanel } from '../../../src/renderer/src/components/app/FontListPanel'
import { FontCard } from '../../../src/renderer/src/components/FontCard'
import { useSelectionController } from '../../../src/renderer/src/runtime/app/useSelectionController'
import { useFontLayoutScrollAnchor } from '../../../src/renderer/src/runtime/app/useFontScrollRestoreRuntime'
import { usePendingDetailRevealRuntime } from '../../../src/renderer/src/runtime/app/usePendingDetailRevealRuntime'
import { useFontViewportResizeObserverRuntime } from '../../../src/renderer/src/runtime/app/effects/useFontViewportResizeObserverRuntime'
import { buildFontViewLayout } from '../../../src/renderer/src/runtime/app/fontViewLayoutRuntime'
import { buildVirtualLayout } from '../../../src/renderer/src/fontViewRuntime'
import { createFontDetailPanelRuntime } from '../../../src/renderer/src/fontDetailPanelRuntime'

const fonts = Array.from({length:403},(_,i)=>({id:`f${i}`,path:`C:/fonts/f${i}.ttf`,fileName:`Font ${i}.ttf`,family:'Arial',fullName:`Font ${i}`,format:'ttf',tagNames:[],scripts:['latin'],systemInstalled:true,installStatusKnown:true})) as any
const noop=()=>{}
let current:any
function Fixture({mode, offset=0, scope='all'}:any) {
  const node=useRef<HTMLDivElement>(null), before=useRef<(visible:boolean)=>void>(noop)
  const selection=useSelectionController(scope, visible=>before.current(visible))
  const [viewport,setViewport]=useState({width:1300,height:520,scrollTop:0})
  useFontViewportResizeObserverRuntime({fontScrollerRef:node,viewportKey:mode,detailVisible:selection.detailVisible,setVirtualViewport:setViewport})
  const layout=buildFontViewLayout(mode,'comfortable',viewport.width,52,2)
  const visible=offset?fonts.slice(offset,offset+100):fonts
  const virtual=buildVirtualLayout({...layout,visibleFonts:visible,virtualViewport:viewport,databasePageReady:!!offset,databasePageResult:offset?{offset,total:fonts.length,items:visible} as any:null})
  before.current=useFontLayoutScrollAnchor({layout,fonts:visible,viewport,fontScrollerRef:node,setVirtualViewport:setViewport,preferredFontId:selection.selectedFontId,enabled:true,detailVisible:selection.detailVisible,scopeKey:scope,fontOffset:offset})
  usePendingDetailRevealRuntime({detailVisible:selection.detailVisible,pendingDetailRevealFontId:selection.pendingDetailRevealFontId,fontScrollerRef:node,virtualLayout:virtual,virtualViewport:viewport,setVirtualViewport:setViewport,setPendingDetailRevealFontId:selection.setPendingDetailRevealFontId})
  const detail=createFontDetailPanelRuntime({...selection,selectedFont:undefined,previewFamilies:{},library:{},hfm:{}} as any)
  const interaction=selection.createInteractionRuntime({visibleFonts:visible,setStatus:noop,setSingleFontSelection:id=>selection.setSelectedFontIds([id]),toggleFontDetail:detail.toggleFontDetail,hydrateFont:noop,reportUserActivity:noop,userActivityIdleWindowMs:150})
  current={node:node.current,layout,viewport,selection,virtual,scroll:(top:number)=>{node.current!.scrollTop=top;setViewport(v=>({...v,scrollTop:node.current!.scrollTop}))},close:detail.closeDetail}
  return <div className="app"><header className="topbar"/><AppLayout detailVisible={selection.detailVisible} renderSidebar={()=> <aside className="sidebar"/>}>
    <FontListPanel {...({sidebarPage:'library',activeFilter:{kind:'all'},status:'',search:'',installStatus:'all',viewMode:'comfortable',cardPoolViewMode:mode,listPreviewFontSize:52,fontScrollerRef:node,updatePageToolbar:noop,visibleFonts:visible,visibleFontTotal:fonts.length,databasePageReady:!!offset,virtualLayout:virtual,viewLayout:layout,handleFontScroll:(e:any)=>{const top=e.currentTarget.scrollTop;setViewport(v=>({...v,scrollTop:top}))},closeDetailFromBlankClick:noop,beginMarqueeSelection:noop,
      renderFontCard:(font:any,compact:boolean)=><FontCard key={font.id} font={font} compact={compact} active={selection.detailVisible&&selection.selectedFontId===font.id} selected={selection.selectedFontIds.includes(font.id)} previewFamily="Arial" previewText={'Wide '.repeat(60)+'\nSecond'} listPreviewFontSize={52} onVisible={noop} onSelect={event=>interaction.handleFontSelect(event,font)} onOpenDetail={event=>interaction.handleFontOpenDetail(event,font)}/>
    } as any)}/>
    {selection.detailVisible&&<section className="detail-panel detail-dock-panel"><button id="cancel-detail" onClick={detail.closeDetail}>取消</button></section>}
  </AppLayout></div>
}
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()))
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
let scenario=''
function check(ok:any,label:string) {if(!ok)throw Error(`${scenario}: ${label}`)}
function snapshot(id?:string) {
 const node=document.querySelector('[data-virtual-layout="cards"]') as HTMLElement
 const cards=[...node.querySelectorAll<HTMLElement>('[data-font-id]')]
 const target=id?cards.find(c=>c.dataset.fontId===id):cards.find(c=>c.getBoundingClientRect().bottom>node.getBoundingClientRect().top+20)
 const r=target?.getBoundingClientRect()
 return {top:node.scrollTop,width:node.clientWidth,id:target?.dataset.fontId,x:r?.x,y:r?.y,preview:(target?.querySelector('.list-preview-scroll') as HTMLElement)?.scrollLeft||0}
}
async function settleAndTrack(id:string) {
 const samples=[]
 for(let n=0;n<22;n++){await frame();samples.push(snapshot(id))}
 for(const sample of samples) {
   check(Math.abs(sample.top-samples[0].top)<=1,'post-paint scroll jump '+JSON.stringify(samples))
   check(sample.width===samples[0].width,'post-paint width reflow')
   if(sample.y!==undefined&&samples[0].y!==undefined)check(Math.abs(sample.y-samples[0].y)<=1,'post-paint card jump')
   check(current.viewport.width===current.node.clientWidth,'virtual width differs from DOM')
 }
 return samples[0]
}
;(window as any).checkDetailTransitions=async()=>{
 const host=document.getElementById('fixture')!,root=createRoot(host)
 let count=0
 for(const mode of ['grid','list'])for(const offset of [0,100])for(const position of ['top','middle','bottom']) {
   scenario=`${innerWidth}/${mode}/${offset}/${position}`
   flushSync(()=>root.render(<Fixture key={`${mode}/${offset}/${position}`} mode={mode} offset={offset}/>))
   await wait(350)
   check(current.node.clientHeight>100&&current.node.clientHeight<innerHeight,'fixture must use the bounded app viewport')
   flushSync(()=>current.scroll(offset?current.layout.panelPadding+Math.floor((offset+(position==='top'?0:position==='middle'?40:85))/current.layout.columns)*current.layout.rowHeight+17:position==='top'?0:position==='middle'?8000:1e9))
   await frame()
   const original=snapshot();check(original.id,'no visible card '+JSON.stringify({original,viewport:current.viewport,layout:current.layout,virtualStart:current.virtual.startIndex,virtualEnd:current.virtual.endIndex,scrollHeight:current.node.scrollHeight}))
   const preview=document.querySelector(`[data-font-id="${original.id}"] .list-preview-scroll`) as HTMLElement
   if(preview)preview.scrollLeft=173
   const before=snapshot(original.id)
   for(let round=0;round<2;round++) {
     const card=document.querySelector(`[data-font-id="${before.id}"]`) as HTMLElement
     // Native click targets exercise production FontCard and selection entry.
     const target=mode==='list'?card.querySelector('.font-row-name-simple') as HTMLElement:card
     flushSync(()=>round===0?target.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true})):card.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
     check(current.selection.detailVisible,`${mode}/${offset}/${position}/${round}: card input failed to open detail`)
     await settleAndTrack(before.id!)
     check(document.querySelector(`[data-font-id="${before.id}"]`),'selected card disappeared')
     if(round===1)flushSync(()=>current.scroll(current.node.scrollTop+600))
     flushSync(()=>document.getElementById('cancel-detail')!.click())
     const after=await settleAndTrack(before.id!)
     check(Math.abs(after.top-before.top)<=1,`${mode}/${offset}/${position} cancel scroll mismatch ${after.top}/${before.top}`)
     check(after.x===before.x&&after.y===before.y,`${mode} cancel card position mismatch`)
     check(after.preview===before.preview,`${mode} cancel horizontal preview mismatch ${after.preview}/${before.preview}`)
     count++
   }
 }
 flushSync(()=>root.unmount())
 return {detailTransitions:count,frameSamples:count*44}
}
