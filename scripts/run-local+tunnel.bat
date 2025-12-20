@echo off
setlocal

ECHO ==== Slash Ghost Setup ====
where npm >nul 2>&1 || (echo npm is required && pause && exit /b 1)
where cloudflared >nul 2>&1 || (echo cloudflared is required && pause && exit /b 1)

ECHO Installing deps...
call npm install || (echo npm install failed & pause & exit /b 1)

ECHO Building client and server...
call npm run build || (echo build failed & pause & exit /b 1)

ECHO Starting server...
start "slash-ghost-server" cmd /k "cd /d %~dp0..\server && node dist/index.js"

echo Starting cloudflared tunnel...
start "cloudflared" cmd /k "cd /d %~dp0.. && cloudflared tunnel --config cloudflared\config.yml run irgri-tunnel"

echo Client build located in client/dist - deploy to Netlify.
echo Windows will stay open for server and tunnel windows.
pause
