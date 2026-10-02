// Actual production panel/card renderer/layout. Data comes from real Rust page query.
// Separate unique-ID control changes fixture IDs only; no production fix is applied.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { FontListPanel } from '../../../src/renderer/src/components/app/FontListPanel'
import { useFontCardRenderer } from '../../../src/renderer/src/components/app/FontCardRenderer'
import { buildVirtualLayout, createRendererFontQueryRequest, buildVisibleFonts } from '../../../src/renderer/src/fontViewRuntime'
import { buildFontViewLayout } from '../../../src/renderer/src/runtime/app/fontViewLayoutRuntime'
import { toggleFontSelectionId } from '../../../src/renderer/src/fontSelectionRuntime'
const noop=()=>{}
const selections:any[]=[]
const check=(ok:any,msg:string)=>{if(!ok)throw Error(msg)}
const messages:string[]=[]
const oldError=console.error
console.error=(...args:any[])=>{messages.push(args.map(String).join(' '));oldError(...args)}
function Fixture({fonts,mode,search='',kind='all'}:any) {
  const ref=useRef<HTMLDivElement>(null)
  const [selected,setSelected]=useState<string[]>([])
  const select=(_event:any,font:any)=>{selections.push({id:font.id,path:font.path});setSelected(ids=>toggleFontSelectionId(ids,font.id))}
  const renderer=useFontCardRenderer({detailVisible:false,selectedFontIdSet:new Set(selected),selectedFontIds:selected,previewFamilies:{},nativePreviewImages:{},previewText:'F01 example',listPreviewFontSize:38,handleFontSelect:select,handleFontOpenDetail:noop,requestPreviewFont:noop,fontListScrolling:()=>false,openFontMenu:noop,setDraggingFontId:noop})
  const layout=buildFontViewLayout(mode,'comfortable',1000,38,1)
  const virtual=buildVirtualLayout({...layout,visibleFonts:fonts,virtualViewport:{width:1000,height:800,scrollTop:0},databasePageReady:false,databasePageResult:null})
  return <FontListPanel {...({sidebarPage:'library',activeFilter:{kind},status:'F01 audit fixture',search,installStatus:'all',sortMode:'nameAsc',timeSortMode:'created',viewMode:'comfortable',cardPoolViewMode:mode,listPreviewFontSize:38,fontScrollerRef:ref,visibleFonts:fonts,visibleFontTotal:fonts.length,databasePageReady:false,virtualLayout:virtual,viewLayout:layout,renderFontCard:renderer.renderFontCard,closeDetail:noop,beginMarqueeSelection:noop,handleFontScroll:noop,updatePageToolbar:noop,setCardPoolViewMode:noop,setListPreviewFontSize:noop} as any)}/>
}
;(window as any).checkIdentityReproduction=async()=>{
  const native=(window as any).nativeFonts
  const results:any[]=[]
  for(const mode of ['list','grid']) for(const unique of [false,true]) {
    const host=document.createElement('div');document.getElementById('fixture')!.append(host)
    const root=createRoot(host)
    const fonts=unique?(window as any).scopedFonts:native
    const neutral={...fonts[0],id:'neutral',family:'Neutral',fileName:'neutral.ttf'}
    const render=(items:any[],search='',kind='all')=>flushSync(()=>root.render(<Fixture fonts={items} mode={mode} search={search} kind={kind}/>))
    render(fonts)
    check(host.querySelectorAll('[data-font-id]').length===3,'initial real card mount failed')
    if(unique) {
      const cards=[...host.querySelectorAll<HTMLElement>('[data-font-id]')]
      for(const card of cards) flushSync(()=>card.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})))
      check(host.querySelectorAll('.font-card.selected').length===3,'candidate IDs must select all three separately')
      const targets=selections.slice(-3)
      check(new Set(targets.map(row=>row.path)).size===3,'selection callbacks lost concrete file targets')
      flushSync(()=>cards[0].dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:' '})))
      check(host.querySelectorAll('.font-card.selected').length===2,'candidate deselection affected other copies')
    }
    render([neutral],'neutral')
    const afterNonempty=host.querySelectorAll('[data-font-id]').length
    render([],'','favorites')
    const remaining=[...host.querySelectorAll<HTMLElement>('[data-font-id]')].map(n=>n.dataset.fontId)
    check(!!host.querySelector('.empty-state'),'production empty state missing')
    check((host.querySelector('.search-input') as HTMLInputElement).value==='','input not cleared')
    check(unique?remaining.length===0:remaining.length===2,`unexpected baseline/control DOM ${mode}/${unique}: ${remaining.length}`)
    results.push({mode,uniqueControl:unique,afterNonempty,afterEmpty:remaining.length,remaining,emptyState:true,search:''})
    flushSync(()=>root.unmount());host.remove()
  }
  // Actual request builder: changing/clearing keywords is represented in query payload.
  const requestBase:any={databasePageOffset:0,databasePageLimit:100,sidebarPage:'library',activeFilter:{kind:'all'},selectedWatchedFolders:[],selectedFormats:[],selectedScripts:[],selectedCategory:'all',selectedTagName:'',selectedSharedTagName:'',selectedFolderId:'',installStatus:'all',timeSortMode:'created',sortMode:'nameAsc'}
  check(createRendererFontQueryRequest({...requestBase,deferredSearch:' abc '}).keyword==='abc','keyword forwarding')
  check(createRendererFontQueryRequest({...requestBase,deferredSearch:''}).keyword==='','keyword clearing')
  // Independent stale-memory counterexample after eliminating duplicate identities.
  const font={...native[0],id:'status-control',systemInstalled:false,installStatusKnown:true}
  const shown=buildVisibleFonts({...requestBase,databasePageReady:true,databasePageResult:{items:[font],total:1,offset:0},allFonts:[],fontIndexById:new Map(),deferredSearch:'',activeFilter:{kind:'notInstalled'},library:{fonts:{[font.id]:{...font,systemInstalled:true}}}} as any)
  check(shown.length===1&&shown[0].systemInstalled===true,'stale-memory baseline no longer present')
  check(messages.some(m=>m.includes('same key')),'expected actual React duplicate-key warning')
  return {cases:results,duplicateKeyWarnings:messages.filter(m=>m.includes('same key')).length,staleMemoryInstalledOnNotInstalledPage:true,requestBuilderSearchClear:true,candidateSelectionTargets:selections,scope:'Production React panel/card renderer/layout with Rust fixture rows; not the full App IPC interaction or user database.'}
}
