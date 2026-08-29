@echo off
setlocal
call "%~dp0_config.cmd"
title XL1 - Screen setup
echo.
echo   Sets up a 3.5" SPI panel and puts the console dashboard on it.
echo   The Pi will need a reboot afterwards.
echo.
echo   Panels: tft35a (try this first) mhs35 mhs35b mhs35ips mis35
echo.
set /p PANEL=  Panel [tft35a]: 
if "%PANEL%"=="" set PANEL=tft35a
echo.
ssh -t %PI_USER%@%PI_HOST% "cd ~/xl1-pi && sudo ./scripts/xl1-screen-setup.sh --panel %PANEL%"
echo.
echo   If the panel stays dark, run this again with a different one,
echo   or undo it entirely:
echo     ssh %PI_USER%@%PI_HOST% "cd ~/xl1-pi && sudo ./scripts/xl1-screen-setup.sh --revert"
echo.
pause
