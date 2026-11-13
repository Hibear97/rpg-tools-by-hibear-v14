@echo off
chcp 65001 >nul
cd /d "%~dp0"
title RPG-Tools - Discord-бот голосовых портретов

where node >nul 2>nul || (
  echo Не найден Node.js. Установите Node.js 24 LTS с https://nodejs.org и запустите этот файл снова.
  start "" https://nodejs.org
  pause & exit /b
)

rem Из папки модуля бот переносится в постоянную папку (%LOCALAPPDATA%\RPG-Tools\discord-bot)
rem и запускается уже оттуда — тогда обновления модуля не стирают токен и не ломают бота.
node launcher.mjs --install
if errorlevel 10 (
  start "" /d "%LOCALAPPDATA%\RPG-Tools\discord-bot" "%LOCALAPPDATA%\RPG-Tools\discord-bot\start-windows.bat"
  exit /b
)
if errorlevel 1 (pause & exit /b)

node launcher.mjs
pause
