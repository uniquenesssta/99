#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict')
const {decode}=require('./check-list-preview-native.cjs'),{loader}=require('./check-operation-chain.cjs'),{previewBridge}=require('./lib/preview-preload-harness.cjs')
const root=path.resolve(__dirname,'../..'),out=path.join(root,'artifacts/list-preview/grid')
const worker=path.join(root,'native-src/hfm-core-worker/target/release/hfm-core-worker.exe'),helper=path.join(root,'build/native/hfm-preview-renderer.exe')
function run(file,args){const r=cp.spawnSync(file,args,{cwd:root,encoding:'utf8',timeout:120000});if(r.status!==0)throw Error(`${file}: ${r.status}: ${r.stderr||r.stdout||r.error}`);return r.stdout}
async function main(){
 assert.equal(process.platform,'win32','grid native gate requires Windows');fs.mkdirSync(out,{recursive:true})
 assert(JSON.parse(run(worker,['--handshake'])).capabilities.includes('preview-layout-grid-v1'))
 const load=loader(),shared=load('src/shared/preview-layout/previewTextFitRuntime.ts'),ps=load('src/main/preview/runtime/nativePreviewScriptRuntime.ts')
 const bridge=previewBridge({renderFontPreviewImage:async(item,text,fontSize,width,height,layout)=>{
  const input=item.outputPath+'.json';fs.writeFileSync(input,JSON.stringify({fontPath:item.path,outputPath:item.outputPath,text,fontSize,width,height,layout}))
  try{assert.equal(JSON.parse(run(worker,['--preview-render-image','--input',input])).layoutVersion,'grid-v1')}finally{fs.unlinkSync(input)}return item.outputPath
 },appendLog(){}}).api
 const fonts=[['Arial','arial.ttf'],['Gabriola','Gabriola.ttf'],['Microsoft YaHei','msyh.ttc']].filter(([,file])=>fs.existsSync(path.join(process.env.WINDIR,'Fonts',file)))
 const samples=['Ag jf','安盛aaaa','  Ag  \nSecond','\nAg','Wide '.repeat(50)+'\nSecond','Wide '.repeat(200)+'\nSecond'],report=[],dom=[]
 for(const engine of ['rust','cpp','powershell'])for(const [family,file] of fonts)for(const [i,text] of samples.entries()){
  const d=shared.getCardPreviewLayout('grid',text,72),outputPath=path.join(out,`${engine}-${file}-${i}.png`),input=outputPath+'.json'
  const request={fontPath:path.join(process.env.WINDIR,'Fonts',file),outputPath,text:d.text,fontSize:d.fontSize,width:d.width,height:d.height,layout:d.nativeLayout}
  fs.writeFileSync(input,JSON.stringify(request))
  if(engine==='rust')await bridge.renderPreviewImage({path:request.fontPath,outputPath},d.text,d.fontSize,d.width,d.height,undefined,d.nativeLayout)
  if(engine==='cpp')assert.equal(JSON.parse(run(helper,['--input',input])).layoutVersion,'grid-v1')
  if(engine==='powershell')run('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(ps.buildNativePreviewPowerShellScript(input),'utf16le').toString('base64')])
  if(fs.existsSync(input))fs.unlinkSync(input)
  const png=decode(outputPath),b=png.bounds
  assert.equal(png.w,d.width);assert.equal(png.h,d.height);assert(b.ink>0)
  assert(b.top>0&&b.bottom<png.h-1,'unexpected vertical clipping '+outputPath)
  if(i<4)assert(Math.abs((b.left+b.right)/2-d.width/2)<d.fontSize,'not centered '+outputPath)
  if(i===4)assert(b.right-b.left>1000,'long line wrapped or shrunk '+outputPath)
  report.push({engine,family,i,fontSize:d.fontSize,...b})
  if(engine==='rust')dom.push({text,image:'data:image/png;base64,'+fs.readFileSync(outputPath).toString('base64'),family,fontSize:d.fontSize})
 }
 for(const engine of ['rust','cpp','powershell'])for(const [,file] of fonts){
  const a=decode(path.join(out,`${engine}-${file}-4.png`)),b=decode(path.join(out,`${engine}-${file}-5.png`))
  const row=Math.ceil(20+26*1.04);assert.deepEqual(a.rgba.subarray(row*a.w*4),b.rgba.subarray(row*b.w*4),'first line length moved second line')
 }
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(out,'dom-samples.json'),JSON.stringify(dom))
 console.log('[grid-preview-native]',report.length,'real PNGs: runtime bridge, centered glyphs, full mixed text, explicit lines and no-wrap suffix passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
