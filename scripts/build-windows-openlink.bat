@echo off
setlocal

set "ROOT=%~dp0.."
set "ELECTRON_DIR=%ROOT%\electron"

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
exit /b %RC%
