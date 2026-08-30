@echo off
setlocal
if not exist "%~dp0_config.cmd" copy /Y "%~dp0_config.cmd.template" "%~dp0_config.cmd" >nul
call "%~dp0_config.cmd"
title XL1 - Doctor
echo.
echo   XL1 - Doctor
echo   %PI_USER%@%PI_HOST%
echo.
ssh -t %PI_USER%@%PI_HOST% "xl1ctl doctor"
if errorlevel 1 (
  echo.
  echo   Could not reach %PI_HOST%.
  echo   - Is the Pi powered on and on the network?
  echo   - If mDNS is not working, put the Pi's IP in _config.cmd
  echo.
)
pause
