@echo off
rem pnpm shim for the green package (0.4.1): routes bare `pnpm` to the bundled
rem node.exe + the pnpm package vendored beside the dsh engine, so the official
rem `dsh plugin` forwarder (spawnSync "pnpm") works on machines without a
rem system Node/pnpm. main.js prepends this directory to the engine PATH.
rem In a dev checkout (no bundled node.exe yet) it falls back to the system
rem `node`, still running the VENDORED pnpm.
if exist "%~dp0..\node.exe" (
  "%~dp0..\node.exe" "%~dp0..\vendor\node_modules\pnpm\bin\pnpm.cjs" %*
) else (
  node "%~dp0..\vendor\node_modules\pnpm\bin\pnpm.cjs" %*
)
exit /b %ERRORLEVEL%
