@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Runs Mangarino Hub from source. Most people should use Mangarino-Hub.exe from the releases.
rem Prefer the panelizer's Python: it has the graphics-card tools for panel detection.
set "PYEXE=%~dp0..\panelizer\.venv\Scripts\python.exe"
set "PYARGS="
if exist "%PYEXE%" goto found

where py >nul 2>&1
if not errorlevel 1 (
  set "PYEXE=py"
  set "PYARGS=-3"
  goto found
)

rem Skip the Microsoft Store shortcut, which only opens the Store.
for /f "delims=" %%P in ('where python 2^>nul') do (
  echo %%P | find /i "\WindowsApps\" >nul
  if errorlevel 1 (
    set "PYEXE=%%P"
    goto found
  )
)

echo.
echo Python was not found on this PC.
echo Install Python 3.11 or newer from https://www.python.org/downloads/
echo (tick "Add python.exe to PATH"), then double-click this file again.
echo.
pause
exit /b 1

:found
"%PYEXE%" %PYARGS% -c "import segno, webview, pystray, PIL" >nul 2>&1
if errorlevel 1 (
  echo Installing what the hub needs (its window, tray icon and QR code^), one moment...
  "%PYEXE%" %PYARGS% -m pip install --quiet --disable-pip-version-check -r "%~dp0requirements.txt"
  if errorlevel 1 (
    echo Installing failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

rem Start it without a console window: pythonw.exe next to python.exe, or pyw for the launcher.
if /i "%PYEXE%"=="py" (
  start "" pyw %PYARGS% "%~dp0hub.py" %*
  exit /b 0
)
for %%D in ("%PYEXE%") do set "PYW=%%~dpDpythonw.exe"
if exist "%PYW%" (
  start "" "%PYW%" %PYARGS% "%~dp0hub.py" %*
  exit /b 0
)
"%PYEXE%" %PYARGS% "%~dp0hub.py" %*
if errorlevel 1 pause
