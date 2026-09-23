@echo off
setlocal
title Mangarino demo
set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
rem Set MANGARINO_DEVICE to your tablet's wireless-debugging address, e.g. 192.168.1.50:37000
if "%MANGARINO_DEVICE%"=="" (
  echo Set the MANGARINO_DEVICE environment variable to the tablet's IP:port first.
  pause
  exit /b 1
)
set "DEV=%MANGARINO_DEVICE%"
set "PKG=com.rinoversal.mangarino"

echo Connecting to the tablet at %DEV% ...
"%ADB%" connect %DEV% >nul 2>&1
"%ADB%" -s %DEV% get-state >nul 2>&1
if errorlevel 1 (
  echo.
  echo Tablet not reachable. Check Wireless debugging is on and it is on the same Wi-Fi.
  echo If the port changed, edit DEV at the top of this file.
  pause
  exit /b 1
)

echo Opening Mangarino on the Berserk series screen ...
"%ADB%" -s %DEV% shell am force-stop %PKG% >nul 2>&1
"%ADB%" -s %DEV% shell am start -a android.intent.action.VIEW -d mangarino:///series/1 %PKG% >nul 2>&1
echo.
echo   START RECORDING NOW. Demo begins in:
echo.
for /l %%i in (10,-1,1) do (
  echo      %%i
  timeout /t 1 /nobreak >nul
)
echo      GO
echo.

rem Open volume 1, turn three pages, double-tap zoom in and out
"%ADB%" -s %DEV% shell "input tap 188 798; sleep 5; input tap 200 1400; sleep 2; input tap 200 1400; sleep 2; input tap 200 1400; sleep 2; input tap 700 1200; input tap 700 1200; sleep 3; input tap 700 1200; input tap 700 1200; sleep 2"
echo   ... pages and zoom
rem Show controls, switch to panel mode, hide controls, step six panels
"%ADB%" -s %DEV% shell "input tap 876 1400; sleep 2; input tap 1583 53; sleep 3; input tap 876 1400; sleep 2; input tap 200 1400; sleep 2; input tap 200 1400; sleep 2; input tap 200 1400; sleep 2; input tap 200 1400; sleep 2; input tap 200 1400; sleep 2; input tap 200 1400; sleep 2"
echo   ... panel mode
rem Controls, bookmark, back to page mode, leave the reader (progress shows on the grid), then the library
"%ADB%" -s %DEV% shell "input tap 876 1400; sleep 2; input tap 1692 55; sleep 2; input tap 1464 53; sleep 2; input tap 44 55; sleep 4"
"%ADB%" -s %DEV% shell am start -a android.intent.action.VIEW -d mangarino:/// %PKG% >nul 2>&1
timeout /t 4 /nobreak >nul
echo.
echo Demo finished. Run this file again any time.
pause
