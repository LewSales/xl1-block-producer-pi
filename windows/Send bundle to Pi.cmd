@echo off
setlocal
call "%~dp0_config.cmd"
title XL1 - Send bundle to Pi
echo.
echo   Copying the bundle (including the ~209 MB image tarballs) to the Pi.
echo   Over Wi-Fi on a Pi 3 this takes several minutes.
echo.
scp -r "%~dp0.." %PI_USER%@%PI_HOST%:~/xl1-pi
if errorlevel 1 (
  echo.
  echo   Copy failed. Check that the Pi is reachable: ssh %PI_USER%@%PI_HOST%
  echo.
  pause
  exit /b 1
)
echo.
echo   Done. Next: run "1 - Preflight check.cmd"
echo.
pause
