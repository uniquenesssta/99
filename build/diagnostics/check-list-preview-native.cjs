#!/usr/bin/env node
// Windows integration: actual Rust worker, C++ helper and PowerShell GDI+.
// No renderer fallback policy is enabled in the application; adapters are called
// directly with controlled test files. PNG pixels come from real OS backends.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),zlib=require('node:zlib'),assert=require('node:assert/strict')
const {loader}=require('./check-operation-chain.cjs')
const {previewBridge}=require('./lib/preview-preload-harness.cjs')
const root=path.resolve(__dirname,'../..'),out=path.join(root,'artifacts/list-preview')
function decode(file){
 const data=fs.readFileSync(file),chunks=[];let w,h,bpp
 for(let p=8;p<data.length;){const n=data.readUInt32BE(p),name=data.toString('ascii',p+4,p+8),bytes=data.subarray(p+8,p+8+n);if(name==='IHDR'){w=bytes.readUInt32BE(0);h=bytes.readUInt32BE(4);assert.equal(bytes[8],8);bpp=bytes[9]===6?4:0;assert(bpp,'expected RGBA PNG')}if(name==='IDAT')chunks.push(bytes);p+=n+12}
 const raw=zlib.inflateSync(Buffer.concat(chunks)),stride=w*bpp,rgba=Buffer.alloc(stride*h)
 const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}
 for(let y=0;y<h;y++){const filter=raw[y*(stride+1)],row=y*stride;for(let x=0;x<stride;x++){const a=x>=bpp?rgba[row+x-bpp]:0,b=y?rgba[row+x-stride]:0,c=y&&x>=bpp?rgba[row+x-stride-bpp]:0;rgba[row+x]=(raw[y*(stride+1)+1+x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255}}
 let left=w,top=h,right=-1,bottom=-1,ink=0
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(rgba[(y*w+x)*4+3]>8){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);ink++}
 return {w,h,rgba,bounds:{left,top,right,bottom,ink}}
}
function run(file,args){const r=cp.spawnSync(file,args,{cwd:root,encoding:'utf8',timeout:120000});if(r.status!==0)throw Error(`${file} status=${r.status} signal=${r.signal} args=${JSON.stringify(args)}: ${r.error||r.stderr||r.stdout}`);return r.stdout}
async function main(){
 assert.equal(process.platform,'win32','native display gate requires Windows')
 fs.mkdirSync(out,{recursive:true})
 const worker=path.join(root,'native-src/hfm-core-worker/target/release/hfm-core-worker.exe'),helper=path.join(root,'build/native/hfm-preview-renderer.exe')
 const handshake=JSON.parse(run(worker,['--handshake']).trim());assert(handshake.capabilities.includes('preview-layout-list-v1'))
 const shared=loader()('src/shared/preview-layout/previewTextFitRuntime.ts'),ps=loader()('src/main/preview/runtime/nativePreviewScriptRuntime.ts')
 // Feed Rust with the arguments delivered by the application's runtime preload
 // and IPC handler, instead of constructing a layout that bypasses the bridge.
 function nativeBridge(options) {
  return previewBridge({renderFontPreviewImage:async(item,text,fontSize,width,height,layout)=>{
   const inputPath=item.outputPath+'.json'
   fs.writeFileSync(inputPath,JSON.stringify({fontPath:item.path,text,fontSize,width,height,layout,outputPath:item.outputPath}))
   try {run(worker,['--preview-render-image','--input',inputPath]);return item.outputPath}
   finally {fs.unlinkSync(inputPath)}
  },appendLog(){}},options).api
 }
 const bridge=nativeBridge()
 const fonts=[['Arial','arial.ttf'],['Gabriola','Gabriola.ttf'],['Microsoft YaHei','msyh.ttc']].filter(([,name])=>fs.existsSync(path.join(process.env.WINDIR,'Fonts',name)))
 assert(fonts.some(([name])=>name==='Arial'))
 const report=[],domSamples=[],failures=[]
 for(const engine of ['cpp','powershell','rust']) { try { for(const [family,file] of fonts)for(const size of [18,44,72])for(const [kind,text] of [['short','Ag jf'],['two','字体 Ag\n汉字 fj'],['long','Wide Ag '.repeat(100)+'\nSecond'],['blank','\nAg']]){
  const d=shared.getCardPreviewLayout('list',text,size),stem=`${engine}-${family.replaceAll(' ','_')}-${size}-${kind}`,outputPath=path.join(out,stem+'.png'),inputPath=path.join(out,stem+'.json')
  const request={fontPath:path.join(process.env.WINDIR,'Fonts',file),text:d.text,fontSize:size,width:d.width,height:d.height,layout:d.nativeLayout,outputPath}
  fs.writeFileSync(inputPath,JSON.stringify(request))
  if(engine==='rust')await bridge.renderPreviewImage({path:request.fontPath,outputPath},d.text,size,d.width,d.height,undefined,d.nativeLayout)
  if(engine==='cpp'){const result=JSON.parse(run(helper,['--input',inputPath]));assert.equal(result.layoutVersion,'list-v1')}
  if(engine==='powershell')run('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(ps.buildNativePreviewPowerShellScript(inputPath),'utf16le').toString('base64')])
  const image=decode(outputPath);assert.equal(image.w,d.width);assert.equal(image.h,d.height);assert(image.bounds.ink>0,stem+' empty')
  assert(image.bounds.left<120,stem+' centered inside PNG');assert(image.bounds.top>0&&image.bounds.bottom<image.h-1,stem+' clipped vertically')
  if(kind==='short')assert(image.bounds.right<400,stem+' font unexpectedly enlarged')
  if(kind==='long')assert(image.bounds.right>1000,stem+' unexpected wrapping or shrink')
  report.push({engine,family,size,kind,...image.bounds,width:image.w,height:image.h})
  if(engine==='rust'&&family==='Arial')domSamples.push({size,text,image:'data:image/png;base64,'+fs.readFileSync(outputPath).toString('base64'),width:d.width,height:d.height})
  if(fs.existsSync(inputPath))fs.unlinkSync(inputPath)
 }
 } catch(error) { failures.push(String(error)) } }
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({fonts,report,failures},null,2));fs.writeFileSync(path.join(out,'dom-samples.json'),JSON.stringify(domSamples))
 if(failures.length)throw Error(failures.join('\n'))
 // The exact pre-fix bridge must reproduce a short sample centered far outside
 // the initial viewport; the unmodified bridge must put its ink near the left.
 const regression={}
 const d=shared.getCardPreviewLayout('list','Ag',35)
 for(const [label,api] of [['before',nativeBridge({transformSource:source=>source.replaceAll('...(layout ? [layout] : []), ','')})],['after',bridge]]){
  const outputPath=path.join(out,`bridge-${label}.png`)
  await api.renderPreviewImage({path:path.join(process.env.WINDIR,'Fonts','arial.ttf'),outputPath},d.text,d.fontSize,d.width,d.height,undefined,d.nativeLayout)
  regression[label]=decode(outputPath).bounds
 }
 assert(regression.before.left>1000,'dropped-layout bridge did not reproduce centered ink')
 assert(regression.after.left<120,'runtime bridge still hides first ink outside initial viewport')
 // Rust/C++ use identical native drawing configuration. System.Drawing has
 // different terminal glyph rasterization/advances: compare its origin and
 // vertical extent, not bit-identical horizontal ink width. Canvas dimensions,
 // fixed UnitPixel size, long-line width and no-wrap checks remain independent.
 for(const row of report.filter(r=>r.engine==='rust'))for(const engine of ['cpp','powershell']) {
  const other=report.find(r=>r.engine===engine&&r.family===row.family&&r.size===row.size&&r.kind===row.kind)
  const edges=engine==='cpp'?['left','top','right','bottom']:['left','top','bottom']
  for(const edge of edges)assert(Math.abs(row[edge]-other[edge])<=2,`${row.family}/${row.size}/${row.kind} ${engine} ${edge}: rust=${row[edge]} other=${other[edge]}`)
 }
 // Same suffix line must be pixel-identical under short/very long first lines.
 // Reintroducing automatic wrap makes this fail without source-string checks.
 for(const engine of ['rust','cpp','powershell']){
  function render(text,name){const d=shared.getCardPreviewLayout('list',text,44),outputPath=path.join(out,`${engine}-${name}.png`),inputPath=outputPath+'.json';fs.writeFileSync(inputPath,JSON.stringify({fontPath:path.join(process.env.WINDIR,'Fonts','arial.ttf'),text,fontSize:44,width:d.width,height:d.height,layout:d.nativeLayout,outputPath}));if(engine==='rust')run(worker,['--preview-render-image','--input',inputPath]);else if(engine==='cpp')run(helper,['--input',inputPath]);else run('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(ps.buildNativePreviewPowerShellScript(inputPath),'utf16le').toString('base64')]);fs.unlinkSync(inputPath);return decode(outputPath)}
  const short=render('Ag\nSecond','wrap-short'),long=render('Ag '.repeat(200)+'\nSecond','wrap-long')
  const y=Math.ceil(20+44*1.16);assert.deepEqual(long.rgba.subarray(y*long.w*4),short.rgba.subarray(y*short.w*4),engine+' auto-wrapped first line changed second line')
 }
 const sample=shared.getCardPreviewLayout('list','Ag',44)
 for(const engine of ['rust','cpp','powershell'])for(const patch of [{layout:null},{layout:{...sample.nativeLayout,version:'old'}},{layout:{...sample.nativeLayout,pixelRatio:2}},{width:760},{text:'a\nb\nc'}]){
  const outputPath=path.join(out,'invalid.png'),inputPath=outputPath+'.json'
  fs.writeFileSync(inputPath,JSON.stringify({fontPath:path.join(process.env.WINDIR,'Fonts','arial.ttf'),text:'Ag',fontSize:44,width:sample.width,height:sample.height,layout:sample.nativeLayout,outputPath,...patch}))
  let error
  try{if(engine==='rust')run(worker,['--preview-render-image','--input',inputPath]);else if(engine==='cpp')run(helper,['--input',inputPath]);else run('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(ps.buildNativePreviewPowerShellScript(inputPath),'utf16le').toString('base64')])}catch(e){error=e}
  assert(error,engine+' accepted invalid layout');assert(!fs.existsSync(outputPath),'invalid input created output');fs.unlinkSync(inputPath)
 }
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({fonts,report,bridgeRegression:regression},null,2));fs.writeFileSync(path.join(out,'dom-samples.json'),JSON.stringify(domSamples))
 console.log('[list-preview-native]',report.length,'real PNGs; runtime bridge before/after:',JSON.stringify(regression),'; no-wrap suffix checks passed; fonts:',fonts.map(f=>f[0]).join(', '))
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1})
module.exports={decode}
