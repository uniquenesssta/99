// Windows Electron supplies trusted mouse/keyboard events. Only persistence and
// availability ports are controlled; the dialog, detail inputs and tag owner are real.
import React, { useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { setupFloatingScrollbars } from '../../../src/renderer/src/utils/floatingScrollbars'
import { confirmUserAction } from '../../../src/renderer/src/confirmationDialogRuntime'
import { FontDetailPanel } from '../../../src/renderer/src/components/app/FontDetailPanel'
import { SharedAvailabilityProvider } from '../../../src/renderer/src/sharedAvailabilityRuntime'
import { createFontDialogTagActions } from '../../../src/renderer/src/fontDialogTagActionsRuntime'
import { createFontDetailPanelRuntime } from '../../../src/renderer/src/fontDetailPanelRuntime'
const noop=()=>{}
const check=(value:unknown,message:string)=>{if(!value)throw Error('[confirmation-focus] '+message)}
const frames=async()=>{for(let n=0;n<3;n++)await new Promise<void>(r=>requestAnimationFrame(()=>r()))}
const input=(scope:string)=>document.getElementById(`font-${scope}-tag-input`) as HTMLInputElement
const point=(node:HTMLElement)=>{
 node.scrollIntoView({block:'nearest'})
 const r=node.getBoundingClientRect(),p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
 check(r.width>0&&r.height>0&&node.contains(document.elementFromPoint(p.x,p.y)),'target is covered: '+node.outerHTML.slice(0,160))
 return p
}
let host:HTMLDivElement,root:Root,oldHfm:unknown,current:any,writes:any[]=[],outcome:boolean|undefined,executed=0,cleanupScrollbars:()=>void
function Fixture(){
 const font={id:'confirmation-font',path:'C:/fixture/dialog.ttf',fileName:'Dialog.ttf',format:'ttf',fileSize:100,tagNames:[],localTagNames:[],scripts:['latin']}
 const [library,setState]=useState<any>({fonts:{[font.id]:font},folders:[],collections:[],tags:[],localTags:[]})
 const latest=useRef(library),[local,setLocal]=useState(''),[shared,setShared]=useState('')
 const setLibrary=(update:any)=>{latest.current=update(latest.current);setState(latest.current);return latest.current}
 const selected=library.fonts[font.id]
 const tags=createFontDialogTagActions({library,selectedFont:selected,selectedFontIds:[font.id],getVisibleFonts:()=>[selected],commitLibraryUpdate:setLibrary,setLibrary,setStatus:noop,
  setAssignTagName:setLocal,setAssignSharedTagName:setShared,queueLocalTagsWrite:(f:any,t:any)=>writes.push(['local',f.id,t]),queueSharedTagsWrite:(f:any,t:any)=>writes.push(['shared',f.id,t])} as any,noop)
 const props={visible:true,selectedFont:selected,selectedFontIds:[font.id],library,visibleFonts:[selected],runFontCommand:async()=>{},previewText:'',previewFamilies:{},selectedPreviewFamily:'',nativeDetailImage:'',
  assignTagName:local,setAssignTagName:setLocal,assignSharedTagName:shared,setAssignSharedTagName:setShared,localTagSuggestions:[],sharedTagSuggestions:[],activeLocalTagSuggestionIndex:-1,activeSharedTagSuggestionIndex:-1,
  setActiveLocalTagSuggestionIndex:noop,setActiveSharedTagSuggestionIndex:noop,updateFont:noop,applyCompare:(f:any)=>f,...tags}
 const keyboard=createFontDetailPanelRuntime(props as any)
 current={library,local,shared}
 return <SharedAvailabilityProvider><button id="confirmation-open" onClick={async()=>{outcome=await confirmUserAction('测试确认\n<em>按文本显示</em>');if(outcome)executed++}}>打开确认</button>
  <FontDetailPanel {...props} handleLocalTagInputKeyDown={keyboard.handleLocalTagInputKeyDown} handleSharedTagInputKeyDown={keyboard.handleSharedTagInputKeyDown}/></SharedAvailabilityProvider>
}
;(window as any).prepareConfirmationFocus=async()=>{
 writes=[];outcome=undefined;executed=0;oldHfm=(window as any).hfm
 ;(window as any).hfm={getSharedAvailability:async()=>({roots:[],tags:[],unattributedTags:[]})}
 host=document.createElement('div');host.className='app';host.style.cssText='position:fixed;inset:0;z-index:200;display:block;overflow:auto;padding:20px;'
 document.body.append(host);root=createRoot(host);flushSync(()=>root.render(<Fixture/>));cleanupScrollbars=setupFloatingScrollbars()
 for(let n=0;n<60&&(!input('shared')||input('shared').matches(':disabled'));n++)await frames()
 check(!input('shared').matches(':disabled'),'shared fixture did not become available')
 return point(document.getElementById('confirmation-open')!)
}
;(window as any).confirmationOpenPoint=()=>{outcome=undefined;return point(document.getElementById('confirmation-open')!)}
;(window as any).checkConfirmationOpen=async()=>{
 await frames()
 const dialog=document.querySelector<HTMLDialogElement>('dialog.hfm-confirmation-dialog')!
 check(dialog?.open,'dialog is not open')
 check((document.activeElement as HTMLElement)?.dataset.confirmation==='cancel','default focus must be cancel')
 check(!dialog.querySelector('em'),'message was interpreted as HTML')
 check(await confirmUserAction('duplicate')===false,'duplicate confirmation was queued')
 check(document.querySelectorAll('dialog.hfm-confirmation-dialog').length===1,'more than one modal owner')
 input('local').focus();check(document.activeElement!==input('local'),'background input is not inert')
 check(outcome===undefined,'operation resolved before a choice')
 return {accept:point(dialog.querySelector('[data-confirmation="accept"]')!),cancel:point(dialog.querySelector('[data-confirmation="cancel"]')!)}
}
;(window as any).checkConfirmationClosed=async(expected:boolean,accepted:number)=>{
 await frames();check(outcome===expected,'incorrect confirmation result');check(executed===accepted,'operation count changed without acceptance')
 check(!document.querySelector('dialog.hfm-confirmation-dialog'),'closed dialog leaked a blocking layer')
 check(document.hasFocus(),'renderer lost window focus')
 check(document.activeElement===document.getElementById('confirmation-open'),'trigger focus was not restored')
}
;(window as any).confirmationInputPoint=(scope:string)=>point(input(scope))
;(window as any).checkConfirmationTyping=async(scope:string,value:string)=>{
 await frames();check(document.activeElement===input(scope),'native click did not focus '+scope)
 check(input(scope).value===value&&current[scope]===value,'native typing did not update '+scope)
 return point([...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===(scope==='local'?'添加标签':'添加共享标签'))!)
}
;(window as any).checkConfirmationTag=async(scope:string,value:string,total:number)=>{
 await frames();const font=current.library.fonts['confirmation-font']
 check(font[scope==='local'?'localTagNames':'tagNames'].includes(value),'real tag owner did not add '+scope)
 check(writes.length===total&&writes.at(-1)[0]===scope&&writes.at(-1)[2].includes(value),'wrong persistence request')
 check(input(scope).value==='','successful tag input was not cleared')
}
;(window as any).checkConfirmationLifecycle=async()=>{
 // Detached triggers and external close must not strand the singleton.
 const removed=document.createElement('button');host.append(removed);removed.focus()
 const pending=confirmUserAction('external close');removed.remove()
 document.querySelector<HTMLDialogElement>('dialog.hfm-confirmation-dialog')!.close()
 check(await pending===false,'external close did not cancel');await frames()
 const focused=input('local');focused.focus();const next=confirmUserAction('restore input')
 document.querySelector<HTMLButtonElement>('[data-confirmation="cancel"]')!.click()
 check(await next===false&&document.activeElement===focused,'existing input focus was not restored')
 const leaving=confirmUserAction('page exit');window.dispatchEvent(new Event('pagehide'))
 check(await leaving===false&&!document.querySelector('dialog.hfm-confirmation-dialog'),'page exit did not cancel and clean up')
 // Oracle mutation: the same typing assertion must reject an unfocusable input.
 focused.disabled=true;focused.blur();let rejected=false
 try{await (window as any).checkConfirmationTyping('local','untyped')}catch{rejected=true}
 focused.disabled=false;check(rejected,'focus regression oracle accepted a disabled input')
 flushSync(()=>root.unmount());cleanupScrollbars();host.remove();(window as any).hfm=oldHfm
 check(!document.querySelector('dialog.hfm-confirmation-dialog'),'dialog leaked after cleanup')
 return {nativeFocusAndTagWrites:writes.length,accepted:executed,externalClose:true,detachedTrigger:true,pageExit:true,inputFocusRestored:true,mutationRejected:true}
}
