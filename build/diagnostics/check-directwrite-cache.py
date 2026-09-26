"""Actual resident DirectWrite cache identity, LRU, release and memory budgets."""
import base64, hashlib, importlib.util, json, os, struct, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def main():
    assert os.name=='nt','Windows required; no mocked cache acceptance'
    wire=module('check-directwrite-resident');pixels=module('check-directwrite-native').pixels
    with tempfile.TemporaryDirectory(prefix='hfm-dw-cache-') as directory:
        directory=Path(directory)
        fixtures=json.loads((ROOT/'build/diagnostics/fixtures/directwrite/fonts.json').read_text())
        for name,data in fixtures.items():(directory/name).write_bytes(base64.b64decode(data))
        p,lines=wire.child_process();sequence=0;peak=0
        def draw(font='narrow.ttf',text='A',face=0,source=3,expected=None,ok=True,size=44.0):
            nonlocal sequence,peak
            sequence+=1;file=directory/font;output=directory/f'output-{sequence}.png'
            digest=hashlib.sha256(file.read_bytes()).hexdigest() if expected is None else expected
            p.stdin.write(wire.frame(file,output,sequence,text=text,face=face,source_generation=source,font_identity=digest,width=64,height=32,font_size=size));p.stdin.flush()
            result=wire.receive(lines);assert result['ok']==ok,result
            cache=result['cache'];assert cache['entries']<=128 and cache['bytes']<=256*1024*1024,cache
            assert cache['liveEntries']==cache['entries'] and cache['liveBytes']<=cache['bytes'],cache
            assert 0<cache['privateBytes']<=cache['peakPrivateBytes']<=512*1024*1024,cache
            peak=max(peak,cache['peakPrivateBytes'])
            if ok:assert result['contentHash']==digest,result
            return result,pixels(output) if ok else None
        try:
            first,image=draw();second,_=draw(text='B');third,_=draw(text='AB')
            assert not first['cacheHit'] and second['cacheHit'] and third['cacheHit'],'font objects not reused'
            assert first['fontObjectId']==second['fontObjectId']==third['fontObjectId']
            assert third['cache']['loads']==1 and third['cache']['hits']==2
            assert third['cache']['sourceReads']==3,'unverified caller identity bypassed source read'
            sized,sized_image=draw(size=8.0)
            assert sized['cacheHit'] and sized['fontObjectId']==first['fontObjectId'] and sized_image!=image,'font size change reused old layout'
            wide,wide_image=draw('wide.ttf');assert wide_image!=image and wide['fontObjectId']!=first['fontObjectId']
            face0,face0_image=draw('faces.ttc',face=0);face1,face1_image=draw('faces.ttc',face=1)
            assert face0_image==image and face1_image==wide_image and face0['fontObjectId']!=face1['fontObjectId']
            changed,_=draw(source=4);assert not changed['cacheHit'] and changed['fontObjectId']!=first['fontObjectId']
            # Same path/size/mtime replacement: cache must use content, not metadata.
            old=(directory/'narrow.ttf').read_bytes();new=(directory/'wide.ttf').read_bytes();length=max(len(old),len(new))
            target=directory/'replace.ttf';target.write_bytes(old.ljust(length,b'\0'));stamp=target.stat().st_mtime_ns
            before,before_image=draw('replace.ttf');old_digest=before['contentHash']
            target.write_bytes(new.ljust(length,b'\0'));os.utime(target,ns=(stamp,stamp))
            stale,_=draw('replace.ttf',expected=old_digest,ok=False);assert stale['reason']=='FONT_IDENTITY_MISMATCH'
            after,after_image=draw('replace.ttf');assert after_image!=before_image and not after['cacheHit']
            assert after['fontObjectId']!=before['fontObjectId']
            # Cached memory fonts must not pin the source, even before eviction.
            target.rename(directory/'renamed.ttf');(directory/'renamed.ttf').unlink()
            failed,_=draw('replace.ttf',expected=after['contentHash'],ok=False);assert not failed['ok']
            # LRU: refresh first of 128 distinct paths; entry 1, not entry 0, is evicted.
            for i in range(130):(directory/f'font-{i}.ttf').write_bytes(old)
            ids={}
            for i in range(128):ids[i]=draw(f'font-{i}.ttf')[0]['fontObjectId']
            touched,_=draw('font-0.ttf');assert touched['cacheHit']
            draw('font-128.ttf')
            retained,_=draw('font-0.ttf');assert retained['cacheHit'] and retained['fontObjectId']==ids[0]
            evicted,_=draw('font-1.ttf');assert not evicted['cacheHit'],'LRU eviction did not release least recent object'
            (directory/'font-1.ttf').unlink()
            assert evicted['cache']['evictions']>0
            # Steady churn must release bytes/COM objects, not grow with requests.
            checkpoints=[]
            for i in range(1000):
                r,_=draw(f'font-{i%130}.ttf' if i%130!=1 else 'font-129.ttf',text='A' if i%2 else 'B')
                if i in (199,599,999):checkpoints.append(r['cache']['privateBytes'])
            assert max(checkpoints)-min(checkpoints)<64*1024*1024,checkpoints
            # 40MiB padded valid fonts exercise byte quota before the 128-item cap.
            for i in range(8):
                (directory/f'large-{i}.ttf').write_bytes(old+b'\0'*(40*1024*1024-len(old)-1)+bytes([i]))
                last,_=draw(f'large-{i}.ttf')
            assert last['cache']['entries']<=6,'byte limit failed to evict cached objects'
            assert last['cache']['liveBytes']<=256*1024*1024
            # OS-level process commit cap is enforced, not merely an output counter.
            import ctypes
            from ctypes import wintypes as w
            k=wire.kernel();k.VirtualAllocEx.argtypes=[w.HANDLE,ctypes.c_void_p,ctypes.c_size_t,w.DWORD,w.DWORD];k.VirtualAllocEx.restype=ctypes.c_void_p
            k.VirtualFreeEx.argtypes=[w.HANDLE,ctypes.c_void_p,ctypes.c_size_t,w.DWORD]
            handle=k.OpenProcess(0x0008,False,p.pid);assert handle
            try:
                allocation=k.VirtualAllocEx(handle,None,600*1024*1024,0x3000,4)
                if allocation:k.VirtualFreeEx(handle,allocation,0,0x8000)
                assert not allocation,'process memory limit not enforced'
            finally:k.CloseHandle(handle)
            draw('large-7.ttf')
            print(json.dumps({'actualWindowsApi':True,'requests':sequence,'peakPrivateBytes':peak,'churnPrivateBytes':checkpoints,'entries':last['cache']['entries'],'cacheBytes':last['cache']['bytes'],'loads':last['cache']['loads'],'evictions':last['cache']['evictions']}))
        finally:
            if p.poll() is None:p.stdin.close();p.wait(timeout=5)

if __name__=='__main__':main()
