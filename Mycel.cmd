@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE goto nonode
"%NODE%" "%~dp0mycel.mjs" open
if errorlevel 1 pause
exit /b
:nonode
echo Node.js 22+ is needed: https://nodejs.org
pause
