@echo off
title Jev Fight Coach Server
cd /d "%~dp0backend"
echo ========================================================
echo   Starting Jev Fight Coach on http://localhost:3001
echo ========================================================
start http://localhost:3001
node server.js
pause
