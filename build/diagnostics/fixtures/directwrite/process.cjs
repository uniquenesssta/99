// Deliberately hostile real subprocess for the production TS transport/owner.
// Its synthetic PNG header is not evidence of DirectWrite rendering.
const fs = require('node:fs')
const log = process.argv[2], serve = process.argv.indexOf('--serve')
const generation = Number(process.argv[serve + 1]), parentPid = Number(process.argv[serve + 2])
const event = value => fs.appendFileSync(log, JSON.stringify({pid:process.pid,...value})+'\n')
const send = value => process.stdout.write(JSON.stringify(value)+'\n')
event({type:'spawn'})
if (process.argv.includes('--no-ready')) setInterval(()=>{},1000)
else send({type:'ready',protocolVersion:2,renderVersion:1,engine:'directwrite',resident:true,serviceGeneration:generation,parentPid,variableFonts:false,cacheVersion:1})
let buffer=Buffer.alloc(0)
process.stdin.on('end',()=>process.exit())
process.stdin.on('data',chunk=>{
 buffer=Buffer.concat([buffer,chunk])
 while(buffer.length>=4 && buffer.length>=4+buffer.readUInt32LE(0)) {
  const frame=buffer.subarray(4,4+buffer.readUInt32LE(0)); buffer=buffer.subarray(4+frame.length)
  let offset=136
  const wide=()=>{const length=frame.readUInt32LE(offset)*2;offset+=4;const value=frame.subarray(offset,offset+length).toString('utf16le');offset+=length;return value}
  const font=wide(), text=wide(), output=wide()
  event({type:'request',text,id:frame.readUInt32LE(8),generation,font,output})
  if(text==='hang') continue
  if(text==='crash') {process.exit(9);return}
  const response={type:'result',protocolVersion:2,renderVersion:1,engine:'directwrite',serviceGeneration:generation,
   requestId:frame.readUInt32LE(8),sourceGeneration:frame.readUInt32LE(12),fontIdentity:frame.subarray(40,104).toString(),
   outputIdentity:frame.subarray(104,136).toString(),faceIndex:frame.readUInt32LE(20),ok:true,reason:'',glyphRuns:1,missingGlyphs:0,elapsedMs:1,cacheHit:false,fontObjectId:frame.readUInt32LE(8),
   contentHash:frame.subarray(40,104).toString(),cache:{hits:0,misses:frame.readUInt32LE(8),loads:frame.readUInt32LE(8),evictions:0,entries:1,bytes:1024,liveEntries:1,liveBytes:1024,sourceReads:frame.readUInt32LE(8),sourceBytes:1024,privateBytes:1000000,peakPrivateBytes:1000000}}
  const emit=()=>{
   const png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(frame.readUInt32LE(24),16);png.writeUInt32BE(frame.readUInt32LE(28),20)
   fs.writeFileSync(output,png)
   if(text==='wrong-id') response.requestId++
   if(text==='wrong-generation') response.serviceGeneration++
   if(text==='wrong-source') response.sourceGeneration++
   if(text==='wrong-output') response.outputIdentity='0'.repeat(32)
   if(text==='wrong-font') response.fontIdentity='0'.repeat(64)
   if(text==='wrong-engine') response.engine='rust-private-gdi+'
   if(text==='bad-cache') response.cache.entries=129
   if(text==='bad-private') response.cache.peakPrivateBytes=600*1024*1024
   if(text==='bad-content') response.contentHash='0'.repeat(64)
   if(text==='missing-cache') delete response.cache
   if(text==='missing') delete response.faceIndex
   if(text==='invalid') {process.stdout.write('{bad}\n');return}
   if(text==='oversized') {process.stdout.write('x'.repeat(10000));return}
   if(text==='duplicate') {process.stdout.write(JSON.stringify(response)+'\n'+JSON.stringify(response)+'\n');return}
   if(text==='duplicate-field') {process.stdout.write(JSON.stringify(response).replace('"ok":true','"ok":false,"ok":true')+'\n');return}
   send(response)
  }
  setTimeout(emit,text==='delay'?150:5)
 }
})
