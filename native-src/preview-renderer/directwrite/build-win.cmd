@echo off
setlocal
cd /d "%~dp0"
where cl >nul 2>nul
if errorlevel 1 (
  if not exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" exit /b 9009
  for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do call "%%i\Common7\Tools\VsDevCmd.bat" -arch=x64
)
where cl >nul 2>nul
if errorlevel 1 exit /b 9009
if not exist "..\..\..\build\native\directwrite" mkdir "..\..\..\build\native\directwrite"
cl /nologo /EHsc /std:c++17 /utf-8 /W4 /O2 /DUNICODE /D_UNICODE /DNOMINMAX /D_WIN32_WINNT=0x0A00 cli.cpp preview.cpp resident.cpp fontCache.cpp localFontFile.cpp memoryBudget.cpp fontStaging.cpp /Fo"..\..\..\build\native\directwrite\\" /Fe"..\..\..\build\native\directwrite\hfm-directwrite-preview.exe" /link dwrite.lib d2d1.lib windowscodecs.lib ole32.lib bcrypt.lib psapi.lib
exit /b %errorlevel%
