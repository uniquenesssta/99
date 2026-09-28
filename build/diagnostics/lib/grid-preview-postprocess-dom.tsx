import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { FontCard } from '../../../src/renderer/src/components/FontCard'
import { usePreviewController } from '../../../src/renderer/src/runtime/app/usePreviewController'
import { createRendererClosingLifecycleRuntime } from '../../../src/renderer/src/runtime/app/rendererClosingLifecycleRuntime'
import { gridPreviewPostprocess as processing } from '../../../src/renderer/src/runtime/preview/gridNativePreviewImageTrimRuntime'

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const noop = () => {}
const check = (ok: unknown, message: string) => { if (!ok) throw Error('[grid-postprocess] ' + message) }
;(window as any).checkGridPostprocess = async () => {
 const host = document.getElementById('fixture')!, root = createRoot(host)
 const closing = createRendererClosingLifecycleRuntime()
 let controller: ReturnType<typeof usePreviewController>
 const sources = Array.from({ length: 5 }, (_, i) => {
  const c = document.createElement('canvas'); c.width = 4096; c.height = 128
  const ctx = c.getContext('2d')!; ctx.fillStyle = `rgb(${30+i*35},80,100)`;ctx.fillRect(2000,30,70+i*9,60)
  const value = c.toDataURL('image/png');c.width = 0;c.height = 0;return value
 })
 let decodes = 0, scans = 0
 const originalImage = window.Image, originalCreate = document.createElement, originalScan = CanvasRenderingContext2D.prototype.getImageData
 const canvases: HTMLCanvasElement[] = []
 ;(window as any).Image = function () { decodes++;return new originalImage() }
 document.createElement = function (name: string, options?: any): any {
  const node = originalCreate.call(document, name, options)
  if (name === 'canvas') canvases.push(node as HTMLCanvasElement)
  return node
 } as typeof document.createElement
 CanvasRenderingContext2D.prototype.getImageData = function (...args: any[]): ImageData {
  scans++;return (originalScan as any).apply(this,args)
 }
 function Fixture({ compact, source, hidden = false }: {compact:boolean;source:string;hidden?:boolean}) {
  controller = usePreviewController({closingLifecycle:closing,previewText:'Ag',previewLayoutMode:compact?'list':'grid',listPreviewFontSize:42,
   hfm:{} as any,selectedFontId:'',selectedFontIds:[],indexingActive:false,rendererUserActive:()=>false,isBadFontRecord:()=>false,setStatus:noop,updateFont:noop})
  return <div style={{position:'fixed',left:20,top:hidden?2000:20,width:300}}><FontCard font={{id:'postprocess',path:'C:/font.ttf',family:'Arial',fileName:'font.ttf',format:'ttf',fileSize:100,style:'Regular'} as any}
   closingLifecycle={closing} compact={compact} active={false} selected={false} previewImage={source} previewText="Ag" listPreviewFontSize={42}
   onSelect={noop} onOpenDetail={noop} onVisible={noop}/></div>
 }
 const render = (compact:boolean,source:string,hidden=false) => flushSync(()=>root.render(<StrictMode><Fixture compact={compact} source={source} hidden={hidden}/></StrictMode>))
 const waitFor = async (condition:()=>boolean,label:string) => {
  for(let i=0;i<240;i++){await frame();if(condition())return}
  throw Error('[grid-postprocess] '+label+' '+JSON.stringify({decodes,scans,...processing.getStats()}))
 }
 const loaded = () => !!(host.querySelector('.grid-preview img') as HTMLImageElement)?.complete && processing.getStats().active===0 && processing.getStats().pending===0
 const waitFrames = async () => { for(let i=0;i<4;i++) await frame() }
 try {
  processing.setPaused(true);processing.setPaused(false)
  render(true,sources[0]);await waitFrames();check(decodes===0&&scans===0,'list mounted image postprocessing')
  render(false,sources[0],true);await waitFrames();check(decodes===0,'offscreen card admitted decode')
  render(false,sources[0]);await waitFor(loaded,'visible grid did not complete')
  check(decodes===1&&scans===1,'StrictMode/shared admission duplicated crop')
  for(let i=0;i<5;i++) {render(true,sources[0]);await waitFrames();render(false,sources[0]);await waitFor(loaded,'mode reuse failed')}
  check(decodes===1&&scans===1,'mode switches repeatedly decoded same PNG')
  const shown=(host.querySelector('.grid-preview img') as HTMLImageElement).src
  flushSync(()=>controller.beginFontListScroll(150))
  check(processing.getStats().paused,'scroll owner did not pause postprocessing')
  check((host.querySelector('.grid-preview img') as HTMLImageElement)?.src===shown,'scroll pause removed completed preview')
  render(false,sources[1]);await frame();check(decodes===1,'scroll admitted new decode')
  await waitFor(loaded,'150ms idle did not resume');check(decodes===2,'new source did not process once')
  check((host.querySelector('.grid-preview img') as HTMLImageElement).src!==shown,'previous source remained')
  flushSync(()=>closing.beginClosing());check(processing.getStats().paused&&processing.getStats().cacheBytes===0,'close did not freeze/clear budget')
  render(false,sources[2]);await waitFrames();check(decodes===2,'closing admitted image work')
  flushSync(()=>closing.resume());await waitFor(loaded,'cancelled close did not resume mounted hook');check(decodes===3,'cancelled close duplicated decode')
  render(false,sources[3]);flushSync(()=>root.render(null));await waitFrames()
  check(decodes===3,'unmounted queued card decoded')
  check(processing.getStats().active===0&&processing.getStats().pending===0&&processing.getStats().cacheBytes===0,'controller teardown retained resources')
  check(canvases.every(c=>c.width===0&&c.height===0),'completed crop retained canvas backing store')
  return {modeSwitches:10,decodes,scans,listDecodes:0,offscreenDecodes:0,closingResume:true,canvasReleased:canvases.length}
 } finally {
  flushSync(()=>root.unmount());processing.setPaused(false)
  window.Image=originalImage;document.createElement=originalCreate;CanvasRenderingContext2D.prototype.getImageData=originalScan
 }
}
