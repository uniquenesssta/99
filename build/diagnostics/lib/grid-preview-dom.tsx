import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { GridFontPreview } from '../../../src/renderer/src/components/GridFontPreview'
import { getCardPreviewLayout } from '../../../src/shared/preview-layout/previewTextFitRuntime'
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()))
function check(ok:unknown,label:string){if(!ok)throw Error('[grid-preview] '+label)}
;(window as any).checkGridPreviews=async()=>{
 const host=document.getElementById('fixture')!,root=createRoot(host)
 let count=0
 const render=(text:string,width:number,image?:string,family='Arial',listSize=18)=>{
  const layout=getCardPreviewLayout('grid',text,listSize)
  flushSync(()=>root.render(<div className="font-card" style={{width,padding:0,height:170,display:'block'}}>
   <GridFontPreview layout={layout} image={image} fontFamily={family} onImageLoad={()=>{}} onImageError={()=>{}}/>
  </div>));return layout
 }
 const inspect=async(text:string,layout:any,native=false)=>{
  for(let n=0;n<120;n++){
   await frame()
   if(!native||(host.querySelector('img') as HTMLImageElement)?.complete)break
  }
  await frame()
  const viewport=host.querySelector('.grid-preview-viewport') as HTMLElement,content=host.querySelector('.grid-preview-content') as HTMLElement
  const rect=content.getBoundingClientRect(),box=viewport.getBoundingClientRect(),scale=rect.width/Math.max(1,content.offsetWidth)
  check(scale<=1.001&&scale>=26/layout.fontSize-.001,'scale outside reading floor')
  check(Math.abs((rect.left+rect.right)/2-(box.left+box.right)/2)<1,'not horizontally centered')
  if(!native){
   const lines=[...host.querySelectorAll('.font-sample-line')]
   check(lines.map(e=>e.textContent).join('\n')===layout.text,'text was shortened or whitespace lost')
   if(layout.lines.some((s:string)=>s===''))check(lines.every(e=>e.getBoundingClientRect().height>0),'empty explicit line collapsed')
  }else check(!!host.querySelector('img'),'PNG never displayed')
  const overflow=host.querySelector('.grid-preview')!.getAttribute('data-overflow')==='true'
  if(rect.width>box.width+1||rect.height>box.height+1)check(overflow,'clipping without disclosure')
  if(overflow)check(host.querySelector('.grid-preview-hint')!.textContent!.includes('打开详情'),'missing overflow hint')
  count++;return {scale,overflow,text:content.textContent}
 }
 for(const text of ['安盛aaaa','  Ag  \nSecond','\nAg','Wide '.repeat(80)+'\nSecond']){
  for(const width of [180,300,520]){
   const layout=render(text,width);await inspect(text,layout)
   const before=(host.querySelector('.grid-preview-content') as HTMLElement).style.transform
   render(text,width,undefined,'Arial',72);await inspect(text,layout)
   check((host.querySelector('.grid-preview-content') as HTMLElement).style.transform===before,'hidden list size changed grid')
  }
 }
 // A real delayed FontFace arrival must cause a new measurement without changing text.
 const encoded=(window as any).gridWebFontData
 if(encoded){
  const text='Wide Mixed WWW iii',layout=render(text,250,undefined,'HfmGridLate, monospace')
  await inspect(text,layout)
  const bytes=Uint8Array.from(atob(encoded),(c:string)=>c.charCodeAt(0))
  const face=new FontFace('HfmGridLate',bytes.buffer);await face.load();document.fonts.add(face)
  await document.fonts.ready;await inspect(text,layout)
  // Compare with a fresh mount using the now-loaded face; stale fit cannot differ.
  const after=(host.querySelector('.grid-preview-content') as HTMLElement).style.transform
  flushSync(()=>root.render(null));render(text,250,undefined,'HfmGridLate, monospace');await inspect(text,layout)
  check((host.querySelector('.grid-preview-content') as HTMLElement).style.transform===after,'late font retained stale fit')
  document.fonts.delete(face)
 }
 for(const sample of (window as any).gridNativeSamples||[]){
  for(const width of [180,520]){const layout=render(sample.text,width,sample.image);await inspect(sample.text,layout,true)}
 }
 // Switch PNG -> text and verify the old source cannot survive on the new route.
 const layout=render('安盛aaaa',300);await inspect('安盛aaaa',layout)
 check(!host.querySelector('img'),'PNG remained after route change')
 flushSync(()=>root.unmount());return {gridCases:count,nativeSamples:((window as any).gridNativeSamples||[]).length}
}
