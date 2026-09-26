"""Build actual source mutations; compilation failure never counts as a killed mutant."""
import os, subprocess, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'native-src/preview-renderer/directwrite/preview.cpp'
BUILD=ROOT/'native-src/preview-renderer/directwrite/build-win.cmd'
TEST=ROOT/'build/diagnostics/check-directwrite-native.py'
RESIDENT=ROOT/'native-src/preview-renderer/directwrite/resident.cpp'
RESIDENT_TEST=ROOT/'build/diagnostics/check-directwrite-resident.py'

def build():
    subprocess.run(['cmd','/c',str(BUILD)],cwd=ROOT,check=True,timeout=120)

def main():
    if os.name!='nt': raise SystemExit('Windows/MSVC required')
    original=SOURCE.read_text(encoding='utf-8')
    resident_original=RESIDENT.read_text(encoding='utf-8')
    mutations=[
      ('wrong TTC face', 'CreateFontFaceReference(file.Get(), request.faceIndex,', 'CreateFontFaceReference(file.Get(), 0,'),
      ('removed input limits', 'if (!preview_input::valid(request.width, request.height, request.fontSize, request.text.size()) || !validUtf16(request.text))', 'if (false)'),
    ]
    try:
        for name,before,after in mutations:
            assert original.count(before)==1, name
            SOURCE.write_text(original.replace(before,after),encoding='utf-8')
            build()
            result=subprocess.run([sys.executable,str(TEST)],cwd=ROOT,capture_output=True,text=True,timeout=120)
            assert result.returncode!=0 and 'AssertionError' in result.stderr, (name,result.stdout,result.stderr)
            print('Rejected actual source mutant:',name,flush=True)
        SOURCE.write_text(original,encoding='utf-8')
        before='stop(2);'
        assert resident_original.count(before)==1
        RESIDENT.write_text(resident_original.replace(before,'for (;;) Sleep(1000);'),encoding='utf-8')
        build()
        result=subprocess.run([sys.executable,str(RESIDENT_TEST)],cwd=ROOT,capture_output=True,text=True,timeout=120)
        assert result.returncode!=0 and 'orphan after parent force kill' in result.stderr, (result.stdout,result.stderr)
        print('Rejected actual source mutant: removed parent-death termination',flush=True)
    finally:
        SOURCE.write_text(original,encoding='utf-8')
        RESIDENT.write_text(resident_original,encoding='utf-8')
        build() # Uploaded binary must contain restored production code.
    subprocess.run([sys.executable,str(TEST)],cwd=ROOT,check=True,timeout=120)
    subprocess.run([sys.executable,str(RESIDENT_TEST)],cwd=ROOT,check=True,timeout=120)

if __name__=='__main__': main()
