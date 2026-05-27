@echo off
setlocal EnableExtensions

set "ROOT=%~dp0.."
set "PROJECT=%ROOT%\apps\windows\OpenLink.Windows\OpenLink.Windows.csproj"
set "PUBLISH_DIR=%ROOT%\dist\native-windows\OpenLink"
set "INNO_SCRIPT=%ROOT%\scripts\openlink-windows-installer.iss"
set "DOTNET_EXE=%ProgramFiles%\dotnet\dotnet.exe"
set "ISCC_EXE="
set "PF86=%ProgramFiles(x86)%"
set "PF64=%ProgramFiles%"
set "INSTALL_DIR=%ProgramFiles%\OpenLink"
set "INSTALL_LOCAL=%OPENLINK_INSTALL_LOCAL%"
set "LAUNCH_LOCAL=%OPENLINK_LAUNCH_LOCAL%"

if not exist "%PROJECT%" goto missing_project
if not exist "%DOTNET_EXE%" set "DOTNET_EXE=dotnet"

echo Building native OpenLink Windows app...
"%DOTNET_EXE%" publish "%PROJECT%" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "%PUBLISH_DIR%"
if errorlevel 1 goto fail

if exist "%ROOT%\apps\windows\OpenLink.Windows\Assets" (
  robocopy "%ROOT%\apps\windows\OpenLink.Windows\Assets" "%PUBLISH_DIR%\Assets" /E /NFL /NDL /NJH /NJS /NP
  if %ERRORLEVEL% GEQ 8 exit /b %ERRORLEVEL%
)

if exist "%PF86%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%PF86%\Inno Setup 6\ISCC.exe"
if not defined ISCC_EXE if exist "%PF64%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%PF64%\Inno Setup 6\ISCC.exe"

if not exist "%INNO_SCRIPT%" goto missing_iss
if not defined ISCC_EXE goto missing_iscc

echo Building native Inno Setup installer...
"%ISCC_EXE%" /Qp "%INNO_SCRIPT%"
if errorlevel 1 goto fail

if exist "%ROOT%\dist\openlink\OpenLink-Inno-Setup.exe" echo Output: "%ROOT%\dist\openlink\OpenLink-Inno-Setup.exe"

if /I "%INSTALL_LOCAL%"=="1" call :install_local
if /I "%LAUNCH_LOCAL%"=="1" call :launch_local

echo Build complete.
exit /b 0

:install_local
echo Updating local OpenLink install at "%INSTALL_DIR%"...
taskkill /IM OpenLink.exe /F >nul 2>nul
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
robocopy "%PUBLISH_DIR%" "%INSTALL_DIR%" /MIR /NFL /NDL /NJH /NJS /NP
if %ERRORLEVEL% GEQ 8 exit /b %ERRORLEVEL%
exit /b 0

:launch_local
if exist "%INSTALL_DIR%\OpenLink.exe" (
  echo Relaunching local OpenLink install...
  start "" "%INSTALL_DIR%\OpenLink.exe"
) else (
  echo Local OpenLink executable not found at "%INSTALL_DIR%\OpenLink.exe".
)
exit /b 0

:missing_project
echo Missing native Windows project: %PROJECT%
exit /b 1

:missing_iss
echo Inno Setup script not found: %INNO_SCRIPT%
echo Skipping Inno Setup compile.
exit /b 0

:missing_iscc
echo Inno Setup compiler not found (ISCC.exe).
echo Install Inno Setup 6 or add ISCC.exe to PATH, then rerun.
exit /b 0

:fail
set "RC=%ERRORLEVEL%"
exit /b %RC%
