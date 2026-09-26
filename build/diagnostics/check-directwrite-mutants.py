"""Build actual source mutations; compilation failure never counts as a killed mutant."""
import os, subprocess, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'native-src/preview-renderer/directwrite/preview.cpp'
BUILD=ROOT/'native-src/preview-renderer/directwrite/build-win.cmd'
TEST=ROOT/'build/diagnostics/check-directwrite-native.py'
RESIDENT=ROOT/'native-src/preview-renderer/directwrite/resident.cpp'
CACHE=ROOT/'native-src/preview-renderer/directwrite/fontCache.cpp'
CACHE_TEST=ROOT/'build/diagnostics/check-directwrite-cache.py'
STAGING=ROOT/'native-src/preview-renderer/directwrite/fontStaging.cpp'
STAGING_TEST=ROOT/'build/diagnostics/check-directwrite-staging.py'
RESIDENT_TEST=ROOT/'build/diagnostics/check-directwrite-resident.py'

def build():
    subprocess.run(['cmd','/c',str(BUILD)],cwd=ROOT,check=True,timeout=120)

def main():
    if os.name!='nt': raise SystemExit('Windows/MSVC required')
    original=SOURCE.read_text(encoding='utf-8')
    resident_original=RESIDENT.read_text(encoding='utf-8')
    cache_original=CACHE.read_text(encoding='utf-8')
    staging_original=STAGING.read_text(encoding='utf-8')
    mutations=[
      ('wrong TTC face', 'CreateFontFaceReference(font.file.Get(), request.faceIndex,', 'CreateFontFaceReference(font.file.Get(), 0,'),
      ('removed input limits', 'if (!preview_input::valid(request.width, request.height, request.fontSize, request.text.size()) || !validUtf16(request.text))', 'if (false)'),
    ]
    try:
        for name,before,after in mutations:
            target,content=(CACHE,cache_original) if name=='wrong TTC face' else (SOURCE,original)
            assert content.count(before)==1, name
            target.write_text(content.replace(before,after),encoding='utf-8')
            build()
            result=subprocess.run([sys.executable,str(TEST)],cwd=ROOT,capture_output=True,text=True,timeout=120)
            assert result.returncode!=0 and 'AssertionError' in result.stderr, (name,result.stdout,result.stderr)
            print('Rejected actual source mutant:',name,flush=True)
            target.write_text(content,encoding='utf-8')
        SOURCE.write_text(original,encoding='utf-8')
        before='stop(2);'
        assert resident_original.count(before)==1
        RESIDENT.write_text(resident_original.replace(before,'for (;;) Sleep(1000);'),encoding='utf-8')
        build()
        result=subprocess.run([sys.executable,str(RESIDENT_TEST)],cwd=ROOT,capture_output=True,text=True,timeout=120)
        assert result.returncode!=0 and 'orphan after parent force kill' in result.stderr, (result.stdout,result.stderr)
        print('Rejected actual source mutant: removed parent-death termination',flush=True)
        RESIDENT.write_text(resident_original,encoding='utf-8')
        for name,before,after in [
            ('disabled font reuse','font->path == snapshot.path && font->digest == snapshot.digest','false && font->path == snapshot.path && font->digest == snapshot.digest'),
            ('ignored cache face','font->faceIndex == request.faceIndex','true'),
            ('removed object count limit','entries.size() >= maxEntries','false'),
            ('removed cache byte limit','counters.bytes + bytes > maxBytes','false'),
        ]:
            assert cache_original.count(before)==1,name
            CACHE.write_text(cache_original.replace(before,after),encoding='utf-8')
            build()
            result=subprocess.run([sys.executable,str(CACHE_TEST)],cwd=ROOT,capture_output=True,text=True,timeout=180)
            assert result.returncode!=0 and 'AssertionError' in result.stderr,(name,result.stdout,result.stderr)
            print('Rejected actual source mutant:',name,flush=True)
            CACHE.write_text(cache_original,encoding='utf-8')
        for name,before,after in [
            ('removed staging handle identity','samePath(finalPath(input.value),expected)','true'),
            ('allowed source writers','GENERIC_READ,FILE_SHARE_READ,nullptr','GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr'),
        ]:
            assert before in staging_original
            STAGING.write_text(staging_original.replace(before,after),encoding='utf-8')
            build()
            result=subprocess.run([sys.executable,str(STAGING_TEST)],cwd=ROOT,capture_output=True,text=True,timeout=120)
            assert result.returncode!=0 and 'AssertionError' in result.stderr,(name,result.stdout,result.stderr)
            print('Rejected actual source mutant:',name,flush=True)
            STAGING.write_text(staging_original,encoding='utf-8')
    finally:
        STAGING.write_text(staging_original,encoding='utf-8')
        SOURCE.write_text(original,encoding='utf-8')
        RESIDENT.write_text(resident_original,encoding='utf-8')
        CACHE.write_text(cache_original,encoding='utf-8')
        build() # Uploaded binary must contain restored production code.
    subprocess.run([sys.executable,str(STAGING_TEST)],cwd=ROOT,check=True,timeout=120)
    subprocess.run([sys.executable,str(TEST)],cwd=ROOT,check=True,timeout=120)
    subprocess.run([sys.executable,str(RESIDENT_TEST)],cwd=ROOT,check=True,timeout=120)
    subprocess.run([sys.executable,str(CACHE_TEST)],cwd=ROOT,check=True,timeout=180)

if __name__=='__main__': main()
