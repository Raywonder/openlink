@echo off
setlocal EnableExtensions

set "ROOT=%~dp0.."
set "ELECTRON_DIR=%ROOT%\electron"
set "DIST_DIR=%ROOT%\dist\openlink"
set "INNO_SCRIPT=%ROOT%\scripts\openlink-windows-installer.iss"
set "ISCC_EXE="
set "PF86=%ProgramFiles(x86)%"
set "PF64=%ProgramFiles%"

if not exist "%ELECTRON_DIR%\package.json" goto missing_electron

pushd "%ELECTRON_DIR%" || goto fail

if not exist "node_modules" call npm install
if errorlevel 1 goto fail_pop

echo Building OpenLink Windows app...
call npm run build:win
if errorlevel 1 goto fail_pop

popd

if exist "%PF86%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%PF86%\Inno Setup 6\ISCC.exe"
if not defined ISCC_EXE if exist "%PF64%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%PF64%\Inno Setup 6\ISCC.exe"

if not exist "%INNO_SCRIPT%" goto missing_iss
if not defined ISCC_EXE goto missing_iscc

echo Building Inno Setup installer...
"%ISCC_EXE%" /Qp "%INNO_SCRIPT%"
if errorlevel 1 goto fail

if exist "%DIST_DIR%\OpenLink-Inno-Setup.exe" echo Output: %DIST_DIR%\OpenLink-Inno-Setup.exe
echo Build complete.
exit /b 0

:missing_electron
echo Missing electron project: %ELECTRON_DIR%
exit /b 1

:missing_iss
echo Inno Setup script not found: %INNO_SCRIPT%
echo Skipping Inno Setup compile.
exit /b 0

:missing_iscc
echo Inno Setup compiler not found (ISCC.exe).
echo Install Inno Setup 6 or add ISCC.exe to PATH, then rerun.
exit /b 0

:fail_pop
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%

:fail
set "RC=%ERRORLEVEL%"
exit /b %RC%
