@echo off
rem Klik dua kali file ini (Windows) untuk memasang Klipin ke AI agent (Claude Desktop, Claude Code, Cursor).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js belum terpasang. Halaman download akan dibuka:
  echo   pilih versi LTS, pasang seperti aplikasi biasa, lalu klik dua kali file ini lagi.
  start "" "https://nodejs.org/id/download"
  echo.
  pause
  exit /b 1
)
node setup.mjs %*
pause
