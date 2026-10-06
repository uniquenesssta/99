// Pure screenshot evidence test, not a production renderer or a font identity test.
// Coordinates are CSS pixels mapped to the captured viewport's actual pixel size.
function compareGlyphPixels(input) {
  const { source, captured, rect, clip, viewport, theme }=input
  const reasons=[],width=source.width,height=source.height
  if(!['light','dark'].includes(theme))return {pass:false,reasons:['unsupported-theme']}
  if(!(rect.width>0&&rect.height>0&&viewport.width>0&&viewport.height>0))return {pass:false,reasons:['empty-geometry']}
  const sx=captured.width/viewport.width,sy=captured.height/viewport.height
  if(Math.abs(sx-sy)>0.02||sx<0.5||sx>4)return {pass:false,reasons:['unsupported-capture-scale']}
  if(source.pixels.length!==width*height*4||captured.pixels.length!==captured.width*captured.height*4)return {pass:false,reasons:['incomplete-pixels']}
  const luminance=(pixels,index)=>(pixels[index]+pixels[index+1]+pixels[index+2])/3
  const screen=(x,y)=>[Math.floor((rect.x+(x+.5)*rect.width/width)*sx),Math.floor((rect.y+(y+.5)*rect.height/height)*sy)]
  const valid=(x,y)=>x>=0&&y>=0&&x<captured.width&&y<captured.height
  const backgrounds=[]
  for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2){
    const i=(y*width+x)*4;if(source.pixels[i+3]>2)continue
    const cssX=rect.x+(x+.5)*rect.width/width,cssY=rect.y+(y+.5)*rect.height/height
    if(cssX<clip.x||cssY<clip.y||cssX>=clip.x+clip.width||cssY>=clip.y+clip.height)continue
    const [px,py]=screen(x,y);if(valid(px,py))backgrounds.push(luminance(captured.pixels,(py*captured.width+px)*4))
  }
  if(backgrounds.length<16)return {pass:false,reasons:['missing-local-background']}
  backgrounds.sort((a,b)=>a-b);const background=backgrounds[Math.floor(backgrounds.length/2)]
  let opaque=0,matched=0,clipped=0,contrastSum=0,minX=width,minY=height,maxX=-1,maxY=-1
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;if(source.pixels[i+3]<192)continue
    opaque++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)
    const cssX=rect.x+(x+.5)*rect.width/width,cssY=rect.y+(y+.5)*rect.height/height
    if(cssX<clip.x||cssY<clip.y||cssX>=clip.x+clip.width||cssY>=clip.y+clip.height){clipped++;continue}
    const [px,py]=screen(x,y);let best=0
    // A one-pixel neighborhood tolerates fractional device scaling, not shifted text.
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(valid(px+dx,py+dy)){
      const value=luminance(captured.pixels,((py+dy)*captured.width+px+dx)*4)
      best=Math.max(best,theme==='light'?background-value:value-background)
    }
    if(best>=60)matched++
    contrastSum+=best
  }
  let negativeSamples=0,unexpectedForeground=0
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
    if(source.pixels[(y*width+x)*4+3]>2)continue
    let nearInk=false
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(x+dx>=0&&y+dy>=0&&x+dx<width&&y+dy<height&&source.pixels[((y+dy)*width+x+dx)*4+3]>8)nearInk=true
    if(nearInk)continue
    const [px,py]=screen(x,y);if(!valid(px,py))continue
    negativeSamples++;let lowest=255
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(valid(px+dx,py+dy)){
      const value=luminance(captured.pixels,((py+dy)*captured.width+px+dx)*4)
      lowest=Math.min(lowest,theme==='light'?background-value:value-background)
    }
    if(lowest>=30)unexpectedForeground++
  }
  const negativeError=negativeSamples?unexpectedForeground/negativeSamples:1
  const coverage=opaque?matched/opaque:0,meanContrast=opaque?contrastSum/opaque:0
  if(opaque<50)reasons.push('missing-source-ink')
  if(clipped)reasons.push('clipped-glyph')
  if(coverage<0.6)reasons.push('glyph-mask-not-visible')
  if(meanContrast<60)reasons.push('insufficient-contrast')
  if(negativeSamples<20)reasons.push('insufficient-shape-negative-samples')
  if(negativeError>0.1)reasons.push('unexpected-foreground-in-glyph-gaps')
  return {pass:reasons.length===0,reasons,opaque,matched,clipped,coverage,meanContrast,negativeSamples,unexpectedForeground,negativeError,background,captureScale:{x:sx,y:sy},thresholds:{sourceAlpha:192,coverage:0.6,contrast:60,minimumInk:50,minimumNegativeSamples:20,maximumNegativeError:0.1}}
}
module.exports={compareGlyphPixels}
