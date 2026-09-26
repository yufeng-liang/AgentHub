@echo off
rem AgentHub 网关常驻启动器：开机自启时只拉网关，不拉主 App、不建窗。
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0AgentHub.exe" "%~dp0resources\app.asar\electron\gateway.cjs" --persistent
endlocal
