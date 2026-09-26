@echo off
setlocal
cd /d "%~dp0"
where cl >nul 2>nul
if errorlevel 1 exit /b 9009
if not exist "..\..\..\build\native\directwrite" mkdir "..\..\..\build\native\directwrite"
cl /nologo /EHsc /std:c++17 /utf-8 /W4 /O2 /DUNICODE /D_UNICODE /DNOMINMAX /D_WIN32_WINNT=0x0A00 cli.cpp preview.cpp resident.cpp /Fo"..\..\..\build\native\directwrite\\" /Fe"..\..\..\build\native\directwrite\hfm-directwrite-preview.exe" /link dwrite.lib d2d1.lib windowscodecs.lib ole32.lib
exit /b %errorlevel%
