@echo off
setlocal

set "ROOT=%~dp0.."
set "ELECTRON_DIR=%ROOT%\electron"
set "DIST_DIR=%ROOT%\dist\openlink"
set "INNO_SCRIPT=%ROOT%\scripts\openlink-windows-installer.iss"
set "ISCC_EXE="

if not exist "%ELECTRON_DIR%\package.json" (
  echo Missing electron project: %ELECTRON_DIR%
  exit /b 1
)

pushd "%ELECTRON_DIR%"
if not exist "node_modules" (
  echo Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    popd
    exit /b 1
  )
)

echo Building OpenLink Windows app...
call npm run build:win
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" exit /b %RC%

if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" (
  set "ISCC_EXE=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
) else if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" (
  set "ISCC_EXE=%ProgramFiles%\Inno Setup 6\ISCC.exe"
)

if not exist "%INNO_SCRIPT%" (
  echo Inno Setup script not found: %INNO_SCRIPT%
  echo Skipping Inno Setup compile.
  exit /b 0
)

if "%ISCC_EXE%"=="" (
  echo Inno Setup compiler not found (ISCC.exe).
  echo Install Inno Setup 6 or add ISCC.exe to PATH, then rerun.
  exit /b 0
)

echo Building Inno Setup installer...
"%ISCC_EXE%" /Qp "%INNO_SCRIPT%"
set "INNO_RC=%ERRORLEVEL%"
if not "%INNO_RC%"=="0" (
  echo Inno Setup build failed with exit code %INNO_RC%
  exit /b %INNO_RC%
)

echo Inno Setup build complete.
if exist "%DIST_DIR%\OpenLink-Inno-Setup.exe" (
  echo Output: %DIST_DIR%\OpenLink-Inno-Setup.exe
)

exit /b 0
