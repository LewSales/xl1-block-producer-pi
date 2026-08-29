@echo off
setlocal
call "%~dp0_config.cmd"
title XL1 - Fetch backup
echo.
echo   Making an encrypted backup on the Pi, then copying it here.
echo   You will be asked for a passphrase. Do not lose it.
echo.
ssh -t %PI_USER%@%PI_HOST% "sudo xl1ctl backup /tmp/xl1-backup.tar.gz.enc && sudo chown %PI_USER% /tmp/xl1-backup.tar.gz.enc"
if errorlevel 1 goto fail

set STAMP=%DATE:~-4%%DATE:~4,2%%DATE:~7,2%-%TIME:~0,2%%TIME:~3,2%
set STAMP=%STAMP: =0%
scp %PI_USER%@%PI_HOST%:/tmp/xl1-backup.tar.gz.enc "%~dp0xl1-backup-%STAMP%.tar.gz.enc"
if errorlevel 1 goto fail

ssh %PI_USER%@%PI_HOST% "rm -f /tmp/xl1-backup.tar.gz.enc"
echo.
echo   Saved to %~dp0xl1-backup-%STAMP%.tar.gz.enc
echo   This file contains your seed phrase, encrypted. Store it somewhere safe.
echo.
pause
exit /b 0

:fail
echo.
echo   Backup failed. Is the Pi reachable and provisioned?
echo.
pause
