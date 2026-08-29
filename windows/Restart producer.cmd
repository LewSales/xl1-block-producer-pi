@echo off
setlocal
call "%~dp0_config.cmd"
title XL1 - Restart
echo.
echo   XL1 - Restart
echo   %PI_USER%@%PI_HOST%
echo.
ssh -t %PI_USER%@%PI_HOST% "sudo xl1ctl restart"
if errorlevel 1 (
  echo.
  echo   Could not reach %PI_HOST%.
  echo   - Is the Pi powered on and on the network?
  echo   - If mDNS is not working, put the Pi's IP in _config.cmd
  echo.
)
pause
