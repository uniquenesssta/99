"""Real Windows resident DirectWrite protocol and independent lifetime checks."""
import base64, hashlib, ctypes, importlib.util, json, os, queue, struct, subprocess, sys, tempfile, threading
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
EXE = ROOT/'build/native/directwrite/hfm-directwrite-preview.exe'

def line_reader(stream):
    lines = queue.Queue()
    def run():
        for line in iter(stream.readline, b''): lines.put(line)
        lines.put(None)
    threading.Thread(target=run, daemon=True).start()
    return lines

def receive(lines):
    line = lines.get(timeout=6)
    assert line is not None, 'process closed without receipt'
    return json.loads(line)

def frame(font, output, request_id=1, generation=7, text='A', face=0, source_generation=3, font_identity=None, width=720, height=260):
    if font_identity is None:
        font_identity=hashlib.sha256(Path(font).read_bytes()).hexdigest()
    data = struct.pack('<8Id',2,generation,request_id,source_generation,1,face,width,height,44.0) + font_identity.encode('ascii') + b'b'*32
    for value in [str(font),text,str(output)]:
        encoded=value.encode('utf-16le'); data += struct.pack('<I',len(encoded)//2)+encoded
    return struct.pack('<I',len(data))+data

def kernel():
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    from ctypes import wintypes as w
    k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD]; k.OpenProcess.restype=w.HANDLE
    k.OpenThread.argtypes=[w.DWORD,w.BOOL,w.DWORD]; k.OpenThread.restype=w.HANDLE
    k.CreateToolhelp32Snapshot.argtypes=[w.DWORD,w.DWORD];k.CreateToolhelp32Snapshot.restype=w.HANDLE
    k.CloseHandle.argtypes=[w.HANDLE];k.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD]
    k.SuspendThread.argtypes=[w.HANDLE];k.SuspendThread.restype=w.DWORD
    k.GetThreadTimes.argtypes=[w.HANDLE,ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME)]
    return k

def suspend_main(pid):
    # Suspend only the oldest (rendering) thread. Reader and parent watchdog
    # remain runnable, proving they work even when DirectWrite never returns.
    from ctypes import wintypes as w
    class ThreadEntry(ctypes.Structure):
        _fields_=[('size',w.DWORD),('usage',w.DWORD),('tid',w.DWORD),('pid',w.DWORD),('base',w.LONG),('delta',w.LONG),('flags',w.DWORD)]
    k=kernel(); k.Thread32First.argtypes=[w.HANDLE,ctypes.POINTER(ThreadEntry)];k.Thread32Next.argtypes=k.Thread32First.argtypes
    snapshot=k.CreateToolhelp32Snapshot(4,0);assert snapshot != ctypes.c_void_p(-1).value
    entry=ThreadEntry();entry.size=ctypes.sizeof(entry); candidates=[]
    try:
        more=k.Thread32First(snapshot,ctypes.byref(entry))
        while more:
            if entry.pid==pid:
                handle=k.OpenThread(0x0802,False,entry.tid)
                if handle:
                    created,exit,kernel_time,user=(w.FILETIME() for _ in range(4))
                    if k.GetThreadTimes(handle,ctypes.byref(created),ctypes.byref(exit),ctypes.byref(kernel_time),ctypes.byref(user)):
                        candidates.append(((created.dwHighDateTime<<32)|created.dwLowDateTime,handle))
                    else:k.CloseHandle(handle)
            more=k.Thread32Next(snapshot,ctypes.byref(entry))
        assert len(candidates)>=3, 'resident watchdog/reader threads missing'
        assert k.SuspendThread(min(candidates,key=lambda pair:pair[0])[1]) != 0xffffffff
    finally:
        for _,handle in candidates:k.CloseHandle(handle)
        k.CloseHandle(snapshot)

def child_process():
    p=subprocess.Popen([str(EXE),'--serve','7',str(os.getpid())],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    lines=line_reader(p.stdout)
    ready=receive(lines)
    assert ready==dict(type='ready',protocolVersion=2,renderVersion=1,engine='directwrite',resident=True,serviceGeneration=7,parentPid=os.getpid(),variableFonts=False,cacheVersion=1),ready
    return p,lines

def main():
    assert os.name=='nt','Windows required; no simulated native pass'
    if len(sys.argv)>1 and sys.argv[1]=='--suspend-main':suspend_main(int(sys.argv[2]));return
    spec=importlib.util.spec_from_file_location('native_pixels',ROOT/'build/diagnostics/check-directwrite-native.py')
    pixel_test=importlib.util.module_from_spec(spec);spec.loader.exec_module(pixel_test)
    with tempfile.TemporaryDirectory(prefix='hfm-dw-resident-') as temp:
        directory=Path(temp);fixtures=json.loads((ROOT/'build/diagnostics/fixtures/directwrite/fonts.json').read_text())
        font=directory/'faces.ttc';font.write_bytes(base64.b64decode(fixtures['faces.ttc']))
        p,lines=child_process()
        try:
            images=[]
            for i,face in enumerate([0,1,0],1):
                output=directory/f'{i}.png';p.stdin.write(frame(font,output,i,face=face));p.stdin.flush()
                receipt=receive(lines)
                assert receipt['ok'] and receipt['engine']=='directwrite' and receipt['serviceGeneration']==7
                assert receipt['requestId']==i and receipt['sourceGeneration']==3 and receipt['fontIdentity']==hashlib.sha256(font.read_bytes()).hexdigest()
                assert receipt['outputIdentity']=='b'*32 and receipt['faceIndex']==face
                images.append(pixel_test.pixels(output))
            assert images[0]==images[2] and images[0]!=images[1], 'resident face identity/PNG mismatch'
            # Invalid local input is a correlated failure, not silent fallback.
            p.stdin.write(frame(Path(r'\\server\share\font.ttf'),directory/'nas.png',4,font_identity='a'*64));p.stdin.flush()
            rejected=receive(lines);assert not rejected['ok'] and rejected['reason']=='LOCAL_PATH_REQUIRED'
            assert not (directory/'nas.png').exists()
            # EOF must stop even a stuck rendering thread.
            suspend_main(p.pid);p.stdin.close();assert p.wait(timeout=5)==0
        finally:
            if p.poll() is None:p.kill();p.wait(timeout=5)
        for case in ['oversized','version','generation','trailing','replayed-id','token']:
            p,lines=child_process()
            try:
                data=bytearray(frame(font,directory/f'{case}.png'))
                if case=='oversized':data=struct.pack('<I',65537)
                elif case=='version':struct.pack_into('<I',data,4,9)
                elif case=='generation':struct.pack_into('<I',data,8,8)
                elif case=='trailing':data+=b'x';struct.pack_into('<I',data,0,len(data)-4)
                elif case=='token':data[44]=ord('!')
                elif case=='replayed-id':
                    p.stdin.write(data);p.stdin.flush();assert receive(lines)['ok']
                p.stdin.write(data);p.stdin.flush();assert p.wait(timeout=5)!=0,case
            finally:
                if p.poll() is None:p.kill();p.wait(timeout=5)
        # Grandparent holds stdin open. Kill ONLY the real parent, with the
        # rendering thread suspended: pipe EOF/tree kill cannot explain success.
        script="import subprocess,sys,os,json,time; p=subprocess.Popen([sys.argv[1],'--serve','7',str(os.getpid())],stdin=sys.stdin.buffer,stdout=sys.stdout.buffer); print(json.dumps({'childPid':p.pid}),flush=True); time.sleep(60)"
        parent=subprocess.Popen([sys.executable,'-u','-c',script,str(EXE)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        lines=line_reader(parent.stdout);child_pid=None;handle=None;k=kernel()
        try:
            messages=[receive(lines),receive(lines)]
            child_pid=next(m['childPid'] for m in messages if 'childPid' in m)
            assert next(m for m in messages if m.get('type')=='ready')['parentPid']==parent.pid
            handle=k.OpenProcess(0x100000,False,child_pid);assert handle
            suspend_main(child_pid)
            parent.kill();parent.wait(timeout=5)
            assert k.WaitForSingleObject(handle,5000)==0,'orphan after parent force kill'
        finally:
            if parent.poll() is None:parent.kill();parent.wait(timeout=5)
            parent.stdin.close()
            if handle:
                if k.WaitForSingleObject(handle,0)!=0:
                    subprocess.run(['taskkill','/PID',str(child_pid),'/F'],capture_output=True,timeout=5)
                k.CloseHandle(handle)
    print(json.dumps({'actualWindowsApi':True,'residentFaceRenders':3,'malformedCases':6,'stdinEofWhileRenderSuspended':True,'parentForceKilledWithStdinHeldOpen':True}))

if __name__=='__main__':main()
