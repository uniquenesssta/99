#!/usr/bin/env node
// Synthetic acceptance counterexamples; never reported as browser paint evidence.
const assert=require('node:assert/strict'),{compareGlyphPixels}=require('./lib/recovery-preview-pixels.cjs')
function make(theme,variant='visible'){
 const width=40,height=32,source=new Uint8Array(width*height*4),captured=new Uint8Array(120*80*4),background=theme==='light'?250:20,ink=theme==='light'?8:242
 for(let i=0;i<captured.length;i+=4){captured[i]=captured[i+1]=captured[i+2]=background;captured[i+3]=255}
 const glyph=(x,y)=>y>=4&&y<28&&((x>=5&&x<8)||(x>=28&&x<31)||(x>=8&&x<28&&y>=14&&y<18))
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const isInk=glyph(x,y),at=(y*width+x)*4
  if(isInk){source[at]=242;source[at+1]=244;source[at+2]=248;source[at+3]=255}
  let paint=isInk
  if(variant==='rectangle')paint=x>=5&&x<31&&y>=4&&y<28
  if(variant==='wrong-shape')paint=y>=4&&y<28&&((x>=17&&x<20)||(x>=5&&x<31&&y>=14&&y<18))
  if(variant==='blank'||!paint)continue
  const shift=variant==='neighbor'?55:variant==='shifted'?38:0,screen=((20+y)*120+20+x+shift)*4
  captured[screen]=captured[screen+1]=captured[screen+2]=ink
 }
 return {source:{width,height,pixels:source},captured:{width:120,height:80,pixels:captured},rect:{x:20,y:20,width,height},clip:{x:20,y:20,width,height},viewport:{width:120,height:80},theme}
}
for(const theme of ['light','dark']){
 assert.equal(compareGlyphPixels(make(theme)).pass,true,theme+' real glyph mask rejected')
 for(const variant of ['blank','neighbor','shifted','rectangle','wrong-shape'])assert.equal(compareGlyphPixels(make(theme,variant)).pass,false,theme+' '+variant+' falsely accepted')
 const clipped=make(theme);clipped.clip.width=7;assert.equal(compareGlyphPixels(clipped).pass,false)
 const absent=make(theme);absent.source.pixels.fill(0);assert.equal(compareGlyphPixels(absent).pass,false)
 const wrongContrast=make(theme);wrongContrast.theme=theme==='light'?'dark':'light';assert.equal(compareGlyphPixels(wrongContrast).pass,false)
}
console.log('[diagnostics:recovery-preview-pixels] light/dark source mask, blank, neighbor-only, shifted, clipped and wrong-contrast counterexamples passed')
