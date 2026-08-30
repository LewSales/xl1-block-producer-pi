@echo off
setlocal
if not exist "%~dp0_config.cmd" copy /Y "%~dp0_config.cmd.template" "%~dp0_config.cmd" >nul
call "%~dp0_config.cmd"
title XL1 - Provision the Pi
echo.
echo   XL1 - Provision the Pi
echo   %PI_USER%@%PI_HOST%
echo.
ssh -t %PI_USER%@%PI_HOST% "cd ~/xl1-pi 2>/dev/null && sudo ./provision.sh || echo 'bundle not found in ~/xl1-pi'"
if errorlevel 1 (
  echo.
  echo   Could not reach %PI_HOST%.
  echo   - Is the Pi powered on and on the network?
  echo   - If mDNS is not working, put the Pi's IP in _config.cmd
  echo.
)
pause
