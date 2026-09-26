"""Actual Windows staging command: a missing entry point must fail this gate."""
import json, os, pathlib, subprocess, tempfile, hashlib, ctypes
EXE = pathlib.Path('build/native/directwrite/hfm-directwrite-preview.exe').resolve()
def stage(source, expected, target, known='-'):
    p = subprocess.run([str(EXE), '--stage-font', str(source), str(expected), str(target), known, str(os.getpid())], capture_output=True, text=True, timeout=10)
    return p, json.loads(p.stdout)
def network():
    # Controlled loopback SMB is not a claim of real NAS outage acceptance.
    with tempfile.TemporaryDirectory(prefix='hfm-dw-smb-') as temp:
        root=pathlib.Path(temp).resolve(); (root/'source.ttf').write_bytes(b'smb private font')
        share='HfmDw'+str(os.getpid()); remote='\\\\localhost\\'+share
        drive=next((c+':' for c in 'ZYXWVUTSR' if not pathlib.Path(c+':/').exists()),None)
        assert drive, 'fixture requires a free drive letter'
        def ps(script):
            return subprocess.run(['powershell','-NoProfile','-NonInteractive','-Command',script],capture_output=True,text=True,timeout=30)
        created=False; mapped=False
        try:
            made=ps("$ErrorActionPreference='Stop'; New-SmbShare -Name '"+share+"' -Path '"+str(root).replace("'","''")+"' -FullAccess ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) | Out-Null")
            assert made.returncode==0,(made.stdout,made.stderr);created=True
            p=subprocess.run(['net','use',drive,remote,'/persistent:no'],capture_output=True,text=True,timeout=30)
            assert p.returncode==0,(p.stdout,p.stderr);mapped=True
            unc=remote+'\\source.ttf'; target=root/'copy.font'
            _,r=stage(unc,unc,target);assert r['ok'] and target.read_bytes()==b'smb private font';target.unlink()
            _,r=stage(drive+'\\source.ttf',unc,target);assert r['ok'];target.unlink()
            # The resident renderer's local-only gate rejects both network forms.
            for source in [unc,drive+'\\source.ttf']:
                p=subprocess.run([str(EXE),'--render',source,'0','AB','44','720','260',str(root/'bad.png')],capture_output=True,text=True,timeout=10)
                assert not json.loads(p.stdout)['ok'] and not (root/'bad.png').exists()
            removed=ps("Remove-SmbShare -Name '"+share+"' -Force -Confirm:$false"); assert removed.returncode==0;created=False
            _,r=stage(unc,unc,target);assert not r['ok'] and not target.exists()
        finally:
            if mapped: subprocess.run(['net','use',drive,'/delete','/y'],capture_output=True,timeout=30)
            if created: ps("Remove-SmbShare -Name '"+share+"' -Force -Confirm:$false")
    print('loopback SMB UNC/mapped alias, unavailable share, resident network refusal passed')

def main():
    with tempfile.TemporaryDirectory(prefix='hfm-dw-stage-') as temp:
        root=pathlib.Path(temp).resolve(); source=root/'source.ttf'; target=root/'snapshot.font'
        source.write_bytes(b'first font bytes')
        p,r=stage(source,source,target)
        assert p.returncode == 0 and r['type']=='font-stage' and r['ok'], (p.stdout,p.stderr)
        assert r['digest']==hashlib.sha256(source.read_bytes()).hexdigest()
        assert target.read_bytes()==source.read_bytes()
        target.unlink(); p,r=stage(source,source,target,r['digest']); assert r['reused'] and not target.exists()
        stamp=source.stat(); source.write_bytes(b'other font bytes'); os.utime(source,ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
        p,r=stage(source,source,target,hashlib.sha256(b'first font bytes').hexdigest()); assert not r['reused']
        assert target.read_bytes()==b'other font bytes'
        target.unlink(); _,r=stage(source,root/'different.ttf',target); assert not r['ok'] and not target.exists()
        target.write_bytes(b'keep'); _,r=stage(source,source,target); assert not r['ok'] and target.read_bytes()==b'keep'
        # A junction is authorized by its real target, never its lexical alias.
        target.unlink(); junction=root/'alias'; actual=root/'actual'; actual.mkdir(); (actual/'font.ttf').write_bytes(b'private')
        subprocess.run(['cmd','/c','mklink','/J',str(junction),str(actual)],check=True,capture_output=True)
        _,r=stage(junction/'font.ttf',junction/'font.ttf',target); assert not r['ok']
        _,r=stage(junction/'font.ttf',actual/'font.ttf',target); assert r['ok']; target.unlink()
        _,r=stage(source,source,junction/'bad.font'); assert not r['ok'] and not (actual/'bad.font').exists()
        junction.rmdir()
        # Existing writable handles must exclude a snapshot reader; never accept
        # a mixed file merely because before/after size and mtime agree.
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p]
        kernel.CreateFileW.restype=ctypes.c_void_p; kernel.CloseHandle.argtypes=[ctypes.c_void_p]
        handle=kernel.CreateFileW(str(source),0x40000000,7,None,3,0,None)
        assert handle not in (None,ctypes.c_void_p(-1).value)
        try:
            _,r=stage(source,source,target); assert not r['ok'] and not target.exists()
        finally: kernel.CloseHandle(handle)
        source.write_bytes(b'x'*(64*1024*1024+1)); _,r=stage(source,source,target); assert not r['ok'] and not target.exists()
    print('directwrite staging native checks passed')
if __name__=='__main__':
    main()
    if '--network' in __import__('sys').argv: network()
