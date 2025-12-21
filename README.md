# Slash Ghost Duel

A minimal 2D top-down 1v1 PvP katana brawler with three ghost-driven modes. Built with TypeScript end-to-end (Phaser client, Node WebSocket authoritative server, shared protocol package).

## Features
- One-hit-kill katana duels with charge/super attacks, shield block and parry, dash, and three-round matches.
- Ghost mechanic variants:
  - **Mode A (Loop Echo):** Spawn a 5s replay ghost on demand.
  - **Mode B (Lag Shadow):** Always-on delayed ghost with possession on death.
  - **Mode C (Mana Shadow):** Toggle ghost draining mana.
- Deterministic server simulation at 60 Hz with 20 Hz snapshots; client-side prediction + snapshot interpolation for responsive controls.
- Procedural obstacle layout each round based on a server seed.
- Netlify-friendly client build and Cloudflared tunnel for exposing the local server.

## Repository layout
```
client/      # Phaser + Vite static client
server/      # Node WebSocket authoritative server
shared/      # Shared protocol/types/constants
cloudflared/ # Tunnel config template
scripts/     # Helper batch scripts
```

## Prerequisites
- Node.js 18+
- npm
- cloudflared (logged in and a tunnel named `irgri-tunnel` configured)
- Windows for the provided batch workflow (Linux/macOS still work with manual commands)

## Setup & build
```bash
npm install
npm run build
```

## Run server locally
```bash
npm run start
# server listens on http://localhost:3000 (health at /health, ws at /ws)
```

## All-in-one Windows script
`scripts/run-local+tunnel.bat` will install dependencies, build all workspaces, start the compiled server, and start the cloudflared tunnel:
```
cloudflared tunnel --config cloudflared\config.yml run irgri-tunnel
```
Keep the two spawned consoles (server + tunnel) open.

## Cloudflared configuration
`cloudflared/config.yml` is a template. Update the `credentials-file` path for your Windows user if different. The tunnel exposes `irgri.uk` to `127.0.0.1:3000` and disables IPv6 "happy eyeballs" to avoid Windows loopback issues. After starting the server you can verify connectivity with:

```bash
curl http://127.0.0.1:3000/health
curl https://irgri.uk/health
```

## Netlify Deploy
- **Option A (manual):**
  - Run `npm ci`, then `npm run build -w shared && npm run build -w client`.
  - Drag-and-drop only the contents of `client/dist` into Netlify Deploys.
- **Option B (Git):** push this repo with the root `netlify.toml`; Netlify will use the configured build/publish settings without extra UI tweaks.
- Server URL resolution order: query `?server=...` > `localStorage` override > `import.meta.env.VITE_SERVER_URL` > default `wss://irgri.uk/ws`.
- To point at a different server, set the `VITE_SERVER_URL` environment variable in Netlify or pass `?server=wss://...` when loading the page.

## Playing
1. Start the server locally and cloudflared tunnel using the batch script.
2. Deploy the client to Netlify or open `client/dist/index.html` after running `npm run build` in `client`.
3. Open the game in two browser tabs. Enter the tunnel WSS URL if different, choose mode A/B/C, click **Play**.
4. Controls:
   - Move: **WASD**
   - Aim: mouse
   - Attack: **Left Mouse** (hold to charge; release performs a boosted lunge; super at 2s is unblockable except parry)
   - Shield/Parry: **Right Mouse** (parry window immediately after raising)
   - Dash: **Shift**
   - Ghost: **Space** (Mode A spawn; Mode B runs automatically; Mode C toggle + mana)
   - Charge hold helper: **Arrow Up** key mirrors mouse hold for keyboard-only testing.

HUD shows ping, scores, and mode. Server matchmaking pairs two clients into a best-of-3 match.

## Development notes
- The server is authoritative and enforces move speed, dash cooldowns, shield/parry timings, and resolves hits/clash.
- Fixed 60 Hz tick with 20 Hz snapshots; client sends inputs each frame including a monotonic tick number.
- Protocol version (`PROTOCOL_VERSION`) is **2** and must match between client and server; mismatches are rejected.
- Latency handling: the server processes only the latest input per tick, clients predict their own movement locally (then reconcile on authoritative snapshots), and remote players are interpolated from buffered snapshots to avoid rubber-banding.

