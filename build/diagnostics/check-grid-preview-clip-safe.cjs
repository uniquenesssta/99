#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs')
const path=require('node:path'),{loader}=require('./check-operation-chain.cjs')
async function main(){
 const file='src/renderer/src/runtime/preview/gridNativePreviewImageTrimRuntime.ts'
 let images=0,scans=0,cropSize
 class ImageFixture {naturalWidth=100;naturalHeight=50;set src(value){images++;queueMicrotask(()=>this.onload())}}
 const pixels=new Uint8ClampedArray(100*50*4)
 for(let y=15;y<35;y++)for(let x=30;x<70;x++)pixels[(y*100+x)*4+3]=255
 const load=loader({react:require('react')},{Image:ImageFixture,document:{createElement(){const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData(){scans++;return {data:pixels}}}),toDataURL(){cropSize=[canvas.width,canvas.height];return 'data:image/png;cropped'}};return canvas}}}, {[path.resolve(file)]:s=>s.replace('async function trimGridNativePreviewImage','export async function trimGridNativePreviewImage')})
 const trim=load(file).trimGridNativePreviewImage
 const [a,b]=await Promise.all([trim('data:image/png;first'),trim('data:image/png;first')])
 assert.equal(images,1);assert.equal(scans,1);assert.equal(a,b);assert.deepEqual(cropSize,[76,50]);assert.equal(a.clipped,false)
 pixels[3]=255
 assert.equal((await trim('data:image/png;edge')).clipped,true,'canvas boundary must disclose clipped ink')
 assert.equal((await trim('not-png')).image,'not-png');assert.equal(images,2)
 await trim('data:image/png;first');assert.equal(images,2,'same image should reuse crop')
 pixels.fill(0);const blank=await trim('data:image/png;blank');assert.deepEqual(cropSize,[36,50]);assert.equal(blank.clipped,false,'blank lines must not report overflow')
 const card=fs.readFileSync('src/renderer/src/components/FontCard.tsx','utf8')
 assert(!card.includes('useGridNativePreviewImageTrim'),'list mounts grid-only processing')
 assert(card.indexOf('<GridFontPreview')>card.indexOf('if (compact)'),'grid component must be after compact return')
 console.log('[grid-preview-clip-safe] alpha crop, safe padding, edge warning, same-source in-flight/cache reuse and grid-only entry passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
