@echo off
setlocal
echo === Slash Ghost setup ===
call npm install || goto :error
echo === Building shared, server, client ===
call npm run build || goto :error
echo === Starting server (port 3000) ===
start "SlashGhostServer" cmd /k "npm run start"
echo === Starting cloudflared tunnel ===
start "Cloudflared" cmd /k "cloudflared tunnel --config cloudflared\\config.yml run irgri-tunnel"
echo Ready! Use the client at the Netlify site or local build.
goto :eof

:error
echo Build/start failed. Check logs above.
pause
