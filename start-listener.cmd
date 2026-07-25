@echo off
cd /d "%~dp0"
:loop
node listener.js
echo Dinleyici durdu, 10 sn sonra yeniden baslatiliyor...
timeout /t 10 /nobreak >nul
goto loop
