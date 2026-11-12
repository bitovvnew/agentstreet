@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
where node >nul 2>&1
if errorlevel 1 goto missingnode
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto missingnode

if not exist src\NUL goto wizard
if not exist node_modules\NUL call npm ci
if errorlevel 1 goto fail
call npm run build
if errorlevel 1 goto fail

:wizard
node bin\agentstreet.js setup %*
set "agentstreetExit=%errorlevel%"
popd
exit /b %agentstreetExit%

:missingnode
echo AgentStreet requires Node.js 20 or newer. 1>&2
:fail
popd
exit /b 1
