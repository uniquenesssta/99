"""Execute real Windows DirectWrite and inspect decoded PNG pixels (stdlib only)."""
import base64, json, os, struct, subprocess, sys, tempfile, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def pixels(path):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    offset, compressed = 8, b''
    while offset < len(data):
        size = struct.unpack('>I', data[offset:offset+4])[0]
        kind, chunk = data[offset+4:offset+8], data[offset+8:offset+8+size]
        assert zlib.crc32(kind+chunk) & 0xffffffff == struct.unpack('>I', data[offset+8+size:offset+12+size])[0]
        if kind == b'IHDR':
            width,height,depth,color,_,_,interlace = struct.unpack('>IIBBBBB',chunk)
            assert (depth,color,interlace) == (8,6,0), (depth,color,interlace)
        if kind == b'IDAT': compressed += chunk
        offset += size+12
    raw = zlib.decompress(compressed); stride = width*4
    assert len(raw) == (stride+1)*height
    rows, previous = [], bytearray(stride)
    for y in range(height):
        mode = raw[y*(stride+1)]; row = bytearray(raw[y*(stride+1)+1:(y+1)*(stride+1)])
        assert mode in range(5)
        for x in range(stride):
            a = row[x-4] if x >= 4 else 0; b=previous[x]; c=previous[x-4] if x>=4 else 0
            if mode == 1: value=a
            elif mode == 2: value=b
            elif mode == 3: value=(a+b)//2
            elif mode == 4:
                p=a+b-c; distances=[abs(p-a),abs(p-b),abs(p-c)]
                value=[a,b,c][distances.index(min(distances))]
            else: value=0
            row[x]=(row[x]+value)&255
        rows.append(row);previous=row
    return width,height,rows

def main():
    if os.name != 'nt': raise SystemExit('Windows required; no simulated DirectWrite pass')
    exe = Path(sys.argv[1] if len(sys.argv)>1 else ROOT/'build/native/directwrite/hfm-directwrite-preview.exe').resolve()
    probe = json.loads(subprocess.check_output([str(exe),'--probe'],text=True,timeout=10))
    assert probe['ok'] and probe['engine']=='directwrite' and probe['protocolVersion']==1 and not probe['resident']
    with tempfile.TemporaryDirectory(prefix='hfm-dw-') as directory:
        directory=Path(directory)
        fixture=json.loads((ROOT/'build/diagnostics/fixtures/directwrite/fonts.json').read_text())
        for name,data in fixture.items(): (directory/name).write_bytes(base64.b64decode(data))
        count=0
        def render(name='narrow.ttf',face=0,text='A',size=44,width=720,height=260,ok=True,output=None):
            nonlocal count
            count+=1; output=output or directory/f'out-{count}.png'
            result=subprocess.run([str(exe),'--render',str(directory/name),str(face),text,str(size),str(width),str(height),str(output)],capture_output=True,text=True,timeout=15)
            receipt=json.loads(result.stdout)
            assert receipt['ok']==ok and (result.returncode==0)==ok, (receipt,result.stderr)
            if not ok:
                if output.name.startswith('out-'): assert not output.exists(), 'failed request published image'
                return receipt,None
            assert receipt['engine']=='directwrite' and receipt['faceIndex']==face
            w,h,rows=pixels(output); assert (w,h)==(width,height)
            ink=[(x,y) for y,row in enumerate(rows) for x in range(w) if row[x*4+3]>8]
            if text.strip():
                assert ink, 'nonblank text produced empty image'
                xs,ys=zip(*ink)
                assert min(xs)>0 and max(xs)<w-1 and min(ys)>0 and max(ys)<h-1, 'clipped ink'
                assert abs(min(xs)+max(xs)-(w-1))<=3 and abs(min(ys)+max(ys)-(h-1))<=3, 'ink not centered'
            else: assert not ink
            # Transparent background and straight-alpha foreground, no premultiplied dark edge.
            assert rows[0][3]==0
            for row in rows:
                for x in range(w):
                    r,g,b,a=row[x*4:x*4+4]
                    if a>=64: assert abs(r-242)<=4 and abs(g-244)<=4 and abs(b-248)<=4, (r,g,b,a)
            return receipt,rows
        _,narrow=render();_,wide=render('wide.ttf');assert narrow!=wide, 'same-name private files conflated'
        _,face0=render('faces.ttc',0);_,face1=render('faces.ttc',1)
        assert face0==narrow and face1==wide and face0!=face1, 'TTC face ignored'
        render('outline.otf')
        for text in ['中文','A\u0301','😀','אב','fi','A\nB','A'*200,'']:
            render(text=text)
        render(text='   ')
        receipt,_=render(text='\u2603');assert receipt['missingGlyphs']>0, 'missing glyph silently fell back'
        render(size=320,width=64,height=32)
        for values in [dict(face=99),dict(face=-1),dict(size='nan'),dict(width=63),dict(height=2049),dict(text='A'*4097)]: render(ok=False,**values)
        (directory/'bad.ttf').write_bytes(b'invalid')
        render('bad.ttf',ok=False)
        receipt,_=render('variable.ttf',ok=False);assert receipt['reason']=='VARIABLE_FONT_UNSUPPORTED'
        render(r'\\not-a-server\share\font.ttf',ok=False)
        sentinel=directory/'existing.png';sentinel.write_bytes(b'preserve')
        render(ok=False,output=sentinel);assert sentinel.read_bytes()==b'preserve'
        # All native handles are gone after each invocation.
        for name in fixture:
            file=directory/name;new=directory/(name+'.released');file.rename(new);new.unlink()
        print(json.dumps({'passed':count,'engine':'directwrite','actualWindowsApi':True,'ttf':True,'cff':True,'ttcFaces':2,'pngPixelChecks':True,'guiVisualAcceptance':False}))

if __name__=='__main__': main()
