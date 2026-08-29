@echo off
setlocal
call "%~dp0_config.cmd"
title XL1 - Dashboard
echo.
echo   Opening http://%PI_HOST%:%DASH_PORT%
start "" "http://%PI_HOST%:%DASH_PORT%"
timeout /t 2 >nul
