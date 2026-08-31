@echo off
setlocal EnableExtensions

echo [hfm-preview-renderer] build started
cd /d "%~dp0"
if errorlevel 1 goto fail

set "SCRIPT_DIR=%cd%"
for %%I in ("%SCRIPT_DIR%\..\..") do set "PROJECT_ROOT=%%~fI"
set "OUTPUT_DIR=%PROJECT_ROOT%\build\native"
set "OUTPUT_EXE=%OUTPUT_DIR%\hfm-preview-renderer.exe"

echo [hfm-preview-renderer] script dir: %SCRIPT_DIR%
echo [hfm-preview-renderer] project root: %PROJECT_ROOT%
echo [hfm-preview-renderer] output: %OUTPUT_EXE%

where cl >nul 2>nul
if errorlevel 1 (
  echo [hfm-preview-renderer] ERROR: cl.exe not found.
  echo [hfm-preview-renderer] Open "x64 Native Tools Command Prompt for VS 2022" and run this script again.
  exit /b 9009
)

echo [hfm-preview-renderer] compiler:
where cl

if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"
if errorlevel 1 goto fail

echo [hfm-preview-renderer] compiling...
cl /nologo /EHsc /std:c++17 /O2 hfm-preview-renderer.cpp /Fe:"%OUTPUT_EXE%" /link gdiplus.lib gdi32.lib user32.lib
if errorlevel 1 goto fail

if not exist "%OUTPUT_EXE%" (
  echo [hfm-preview-renderer] ERROR: build finished but output exe was not found.
  exit /b 2
)

echo [hfm-preview-renderer] SUCCESS: %OUTPUT_EXE%
exit /b 0

:fail
echo [hfm-preview-renderer] FAILED with errorlevel %errorlevel%
exit /b %errorlevel%
