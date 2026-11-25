@echo off
title 3D Rose Explorer - Science Buddy
color 0A
echo.
echo  =========================================
echo   3D Rose Explorer ^& Science Buddy
echo  =========================================
echo.

:: Find node.exe
set NODE_PATH=
for %%p in (
  "C:\Program Files\nodejs\node.exe"
  "C:\Program Files (x86)\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
) do (
  if exist %%p set NODE_PATH=%%~p
)

if "%NODE_PATH%"=="" (
  where node >nul 2>&1
  if %ERRORLEVEL%==0 (
    set NODE_PATH=node
  ) else (
    echo  ERROR: Node.js not found!
    echo  Please install from: https://nodejs.org
    pause
    exit /b 1
  )
)

echo  Node found: %NODE_PATH%
echo  Starting server on http://localhost:3000 ...
echo.
echo  IMPORTANT: Open http://localhost:3000 in your browser!
echo  Press Ctrl+C here to stop the server.
echo.

"%NODE_PATH%" server.js

pause
