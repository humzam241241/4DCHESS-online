@echo off
cd /d "%~dp0"

echo Installing dependencies...
call npm install

echo.
echo Starting 4D Chess server...
start http://localhost:3000
call node server.js

echo.
echo Server stopped.
pause
