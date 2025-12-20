import Phaser from 'phaser';
import {
  GAME_CONSTANTS,
  PROTOCOL_VERSION,
  ClientHelloMessage,
  ClientInputMessage,
  ClientPingMessage,
  ClientSetModeMessage,
  ServerMessage,
  PlayerState,
  SnapshotMessage,
  GameMode,
} from '@slash-ghost/shared';

const DEFAULT_SERVER = 'wss://irgri.uk/ws';

function normalizeServerUrl(url: string, enforceSecure: boolean): string {
  try {
    const parsed = new URL(url);
    if (enforceSecure && parsed.protocol === 'ws:') parsed.protocol = 'wss:';
    return parsed.toString();
  } catch {
    return url;
  }
}

function resolveServerUrl(): string {
  const url = new URL(window.location.href);
  const enforceSecure = url.protocol === 'https:';
  const fromQuery = url.searchParams.get('server');
  if (fromQuery) return normalizeServerUrl(fromQuery, enforceSecure);
  const stored = localStorage.getItem('serverUrl');
  if (stored) return normalizeServerUrl(stored, enforceSecure);
  if (import.meta.env.VITE_SERVER_URL) return normalizeServerUrl(import.meta.env.VITE_SERVER_URL as string, enforceSecure);
  return normalizeServerUrl(DEFAULT_SERVER, enforceSecure);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function createStyle() {
  const style = document.createElement('style');
  style.textContent = `
  :root {
    --panel: rgba(12,12,20,0.88);
    --accent: #6cf0ff;
    --accent-2: #ff69b4;
    --text: #e9f2ff;
  }
  #ui-root { position: fixed; inset: 0; pointer-events: none; font-family: 'Inter', system-ui, sans-serif; color: var(--text); }
  .menu-card { pointer-events: auto; max-width: 380px; margin: 60px auto; padding: 20px 24px; background: var(--panel); border: 1px solid #1f2a44; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.45); }
  .menu-title { font-size: 28px; margin: 0 0 12px 0; letter-spacing: 1px; text-align: center; }
  .menu-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .menu-field label { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #9fb7d6; }
  .menu-field input, .menu-field select { padding: 10px 12px; border-radius: 8px; border: 1px solid #27324d; background: #0d1628; color: var(--text); }
  .menu-actions { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .menu-actions button { flex: 1; padding: 12px; border: none; border-radius: 10px; background: linear-gradient(135deg, #38d9ff, #6f7cff); color: #05080f; font-weight: 700; cursor: pointer; transition: transform 120ms ease, box-shadow 120ms ease; }
  .menu-actions button:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(111,124,255,0.35); }
  #status { font-size: 13px; color: #b7c9ff; text-align: center; margin-top: 10px; }
  #hud { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; pointer-events: none; padding: 14px; }
  #hud .top-row { display: flex; justify-content: space-between; align-items: center; }
  #hud .meters { display: flex; gap: 10px; align-items: center; }
  .pip { width: 12px; height: 12px; border-radius: 50%; border: 1px solid #88d4ff; background: rgba(136,212,255,0.3); }
  .pip.empty { background: rgba(255,255,255,0.08); border-color: #5a6a84; }
  .bar { position: relative; width: 160px; height: 12px; border-radius: 8px; background: rgba(255,255,255,0.08); overflow: hidden; border: 1px solid #1f2a44; }
  .bar .fill { position: absolute; inset: 0; background: linear-gradient(90deg, var(--accent), #9d7bff); transform-origin: left center; }
  .bar.super::after { content: 'SUPER'; position: absolute; right: 4px; top: -18px; font-size: 10px; color: #ffd166; }
  .score { font-weight: 700; letter-spacing: 0.08em; }
  #hud .mode { font-size: 12px; color: #a8b8db; }
  `;
  document.head.appendChild(style);
}

function createUI() {
  const root = document.createElement('div');
  root.id = 'ui-root';
  root.innerHTML = `
    <div class="menu-card" id="menu">
      <h1 class="menu-title">Slash Ghost</h1>
      <div class="menu-field">
        <label for="server">Server URL</label>
        <input id="server" type="text" value="${resolveServerUrl()}" />
      </div>
      <div class="menu-field">
        <label for="mode">Mode</label>
        <select id="mode">
          <option value="A">Loop Echo (record & replay)</option>
          <option value="B">Lag Shadow (delayed ghost)</option>
          <option value="C">Mana Shadow (toggle ghost)</option>
        </select>
      </div>
      <div class="menu-actions">
        <button id="play">Play</button>
      </div>
      <div id="status">Pick a mode and hit Play</div>
    </div>
    <div id="hud" style="display:none;">
      <div class="top-row">
        <div class="score" id="scoreboard">Round: 0 | Score: 0 - 0</div>
        <div class="mode" id="hud-mode"></div>
      </div>
      <div class="meters">
        <div class="bar" id="dash"><div class="fill" style="transform:scaleX(1)"></div></div>
        <div class="bar super" id="charge"><div class="fill" style="transform:scaleX(0)"></div></div>
        <div class="bar" id="mana" style="display:none;"><div class="fill" style="transform:scaleX(1)"></div></div>
        <div id="shield"></div>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  const status = root.querySelector('#status') as HTMLDivElement;
  const play = root.querySelector('#play') as HTMLButtonElement;
  const menu = root.querySelector('#menu') as HTMLDivElement;
  const hud = root.querySelector('#hud') as HTMLDivElement;
  const serverInput = root.querySelector('#server') as HTMLInputElement;
  const modeSelect = root.querySelector('#mode') as HTMLSelectElement;
  const score = root.querySelector('#scoreboard') as HTMLDivElement;
  const hudMode = root.querySelector('#hud-mode') as HTMLDivElement;
  const shield = root.querySelector('#shield') as HTMLDivElement;
  const dash = root.querySelector('#dash .fill') as HTMLDivElement;
  const charge = root.querySelector('#charge .fill') as HTMLDivElement;
  const mana = root.querySelector('#mana') as HTMLDivElement;
  return { root, status, play, menu, hud, serverInput, modeSelect, score, hudMode, shield, dash, charge, mana };
}

type UIHandles = ReturnType<typeof createUI>;

type PlayerVisual = {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Arc;
  aim: Phaser.GameObjects.Line;
  glow: Phaser.GameObjects.Arc;
  shield: Phaser.GameObjects.Arc;
};

class DuelScene extends Phaser.Scene {
  socket?: WebSocket;
  playerId = '';
  mode: GameMode = 'A';
  connected = false;
  tick = 0;
  lastSnapshotTick = 0;
  players: Map<string, PlayerVisual> = new Map();
  ghostEntities: Map<string, Phaser.GameObjects.Container> = new Map();
  inputState = { moveX: 0, moveY: 0, buttons: { attack: false, shield: false, dash: false, ghost: false }, charge: false, aim: 0 };
  scores: Record<string, number> = {};
  lastPing = 0;
  ping = 0;
  serverUrl: string;
  name = 'Ronin';
  sendTimer?: number;
  targetPositions: Map<string, Phaser.Math.Vector2> = new Map();
  stateCache: Map<string, PlayerState> = new Map();
  ui: UIHandles;
  infoText?: Phaser.GameObjects.Text;

  constructor(opts: { serverUrl: string; mode: GameMode; ui: UIHandles; playerName?: string }) {
    super('DuelScene');
    this.serverUrl = opts.serverUrl;
    this.mode = opts.mode;
    this.ui = opts.ui;
    if (opts.playerName) this.name = opts.playerName;
  }

  preload() {}

  create() {
    this.ui.menu.style.display = 'none';
    this.ui.hud.style.display = 'flex';
    this.ui.hudMode.textContent = `Mode ${this.mode}`;
    this.infoText = this.add.text(10, 10, 'Connecting...', { color: '#fff' });
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => this.handleKey(e, true));
    this.input.keyboard?.on('keyup', (e: KeyboardEvent) => this.handleKey(e, false));
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const center = { x: this.scale.width / 2, y: this.scale.height / 2 };
      this.inputState.aim = Math.atan2(pointer.worldY - center.y, pointer.worldX - center.x);
    });
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) this.inputState.buttons.shield = true;
      else {
        this.inputState.buttons.attack = true;
        this.spawnSlashEffect(this.playerId);
      }
    });
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (pointer.wasTouch) {
        this.inputState.buttons.attack = false;
        this.inputState.buttons.shield = false;
      } else if (pointer.rightButtonReleased()) this.inputState.buttons.shield = false;
      else this.inputState.buttons.attack = false;
    });
    this.connect();
  }

  connect() {
    this.ui.status.textContent = `Connecting to ${this.serverUrl}`;
    const ws = new WebSocket(this.serverUrl);
    this.socket = ws;
    ws.onopen = () => {
      this.connected = true;
      const hello: ClientHelloMessage = { type: 'hello', name: this.name, version: PROTOCOL_VERSION };
      ws.send(JSON.stringify(hello));
      const modeMsg: ClientSetModeMessage = { type: 'setMode', mode: this.mode, version: PROTOCOL_VERSION };
      ws.send(JSON.stringify(modeMsg));
      this.time.addEvent({ delay: 1000, loop: true, callback: () => this.sendPing() });
      this.sendTimer = window.setInterval(() => this.sendInput(), 1000 / 60);
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      this.connected = false;
      this.ui.status.textContent = 'Disconnected';
      if (this.sendTimer) window.clearInterval(this.sendTimer);
    };
  }

  sendPing() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.lastPing = performance.now();
    const msg: ClientPingMessage = { type: 'ping', ts: this.lastPing, version: PROTOCOL_VERSION };
    this.socket.send(JSON.stringify(msg));
  }

  sendInput() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.tick += 1;
    const msg: ClientInputMessage = {
      type: 'input',
      tick: this.tick,
      aimAngle: this.inputState.aim,
      moveX: clamp(this.inputState.moveX, -1, 1),
      moveY: clamp(this.inputState.moveY, -1, 1),
      buttons: { ...this.inputState.buttons },
      charge: this.inputState.charge,
      version: PROTOCOL_VERSION,
    };
    this.socket.send(JSON.stringify(msg));
  }

  handleKey(e: KeyboardEvent, down: boolean) {
    switch (e.code) {
      case 'KeyW':
        this.inputState.moveY = down ? -1 : 0;
        break;
      case 'KeyS':
        this.inputState.moveY = down ? 1 : 0;
        break;
      case 'KeyA':
        this.inputState.moveX = down ? -1 : 0;
        break;
      case 'KeyD':
        this.inputState.moveX = down ? 1 : 0;
        break;
      case 'ShiftLeft':
        this.inputState.buttons.dash = down;
        break;
      case 'Space':
        this.inputState.buttons.ghost = down;
        break;
      case 'ArrowUp':
        this.inputState.charge = down;
        break;
    }
  }

  handleMessage(raw: any) {
    const msg = JSON.parse(raw) as ServerMessage & { type: string };
    switch (msg.type) {
      case 'welcome':
        this.playerId = (msg as any).playerId;
        this.ui.status.textContent = `Joined as ${this.playerId}`;
        break;
      case 'snapshot':
        this.lastSnapshotTick = (msg as SnapshotMessage).tick;
        this.renderSnapshot(msg as SnapshotMessage);
        break;
      case 'event':
        if ((msg as any).event === 'roundEnd') {
          this.scores = (msg as any).payload.scores;
        }
        if ((msg as any).event === 'parry') {
          const payload = (msg as any).payload;
          this.parryFlash(payload?.target);
        }
        break;
      case 'pong':
        this.ping = performance.now() - (msg as any).ts;
        break;
    }
  }

  renderSnapshot(snapshot: SnapshotMessage) {
    snapshot.players.forEach((p) => {
      this.stateCache.set(p.id, p);
      this.targetPositions.set(p.id, new Phaser.Math.Vector2(p.position.x, p.position.y));
      this.drawPlayer(p);
    });
    snapshot.ghosts.forEach((g) => this.drawGhost(g));
    const values = Object.values(this.scores);
    this.ui.score.textContent = `Round: ${snapshot.tick} | Score: ${values.join(' - ') || '0 - 0'} | Ping ${Math.round(this.ping)}ms`;
    const playerState = this.stateCache.get(this.playerId);
    if (playerState) {
      this.updateHud(playerState);
    }
  }

  drawPlayer(state: PlayerState) {
    let visual = this.players.get(state.id);
    if (!visual) {
      const body = this.add.circle(0, 0, 18, 0x00ffcc, 0.9);
      const glow = this.add.circle(0, 0, 26, 0x6cf0ff, 0.18);
      const aim = this.add.line(0, 0, 0, 0, 28, 0, 0xffffff, 0.9);
      const shield = this.add.circle(0, 0, 24, 0xffffff, 0.12);
      const container = this.add.container(state.position.x, state.position.y, [glow, body, shield, aim]);
      visual = { container, body, aim, glow, shield };
      this.players.set(state.id, visual);
    }
    const target = this.targetPositions.get(state.id);
    if (target) {
      // Smooth position
      const current = visual.container;
      current.x = Phaser.Math.Linear(current.x, target.x, 0.18);
      current.y = Phaser.Math.Linear(current.y, target.y, 0.18);
    }

    const aimAngle = state.id === this.playerId ? this.inputState.aim : state.aimAngle;
    const len = 30;
    visual.aim.setTo(0, 0, Math.cos(aimAngle) * len, Math.sin(aimAngle) * len);
    visual.body.setFillStyle(state.isDead ? 0x444444 : 0x00ffcc, state.id === this.playerId ? 1 : 0.7);
    visual.shield.setVisible(state.shieldUp);
    visual.shield.setScale(1 + Math.max(0, (state.shieldDurability - 1) * 0.08));
    visual.shield.setFillStyle(0x88d4ff, state.shieldUp ? 0.18 : 0);
    const glowAlpha = state.charging ? 0.32 : 0.18;
    visual.glow.setFillStyle(0x6cf0ff, glowAlpha + Math.min(state.chargeTime, 1) * 0.1);
  }

  drawGhost(g: any) {
    let c = this.ghostEntities.get(g.id);
    if (!c) {
      const circle = this.add.circle(0, 0, 14, 0xffffff, 0.25);
      const trail = this.add.circle(0, 0, 22, 0xffffff, 0.05);
      c = this.add.container(g.position.x, g.position.y, [trail, circle]);
      this.ghostEntities.set(g.id, c);
    }
    c.setPosition(g.position.x, g.position.y);
    c.setAlpha(g.active ? 0.6 : 0.25);
  }

  update(_time: number, delta: number): void {
    this.players.forEach((visual, id) => {
      const state = this.stateCache.get(id);
      if (!state) return;
      if (id === this.playerId && this.socket?.readyState === WebSocket.OPEN) {
        const dt = delta / 1000;
        const dir = new Phaser.Math.Vector2(this.inputState.moveX, this.inputState.moveY).normalize();
        const speed = state.charging ? GAME_CONSTANTS.moveSpeed * GAME_CONSTANTS.chargeSlow : GAME_CONSTANTS.moveSpeed;
        visual.container.x += dir.x * speed * dt;
        visual.container.y += dir.y * speed * dt;
      }
    });
  }

  spawnSlashEffect(playerId: string) {
    const visual = this.players.get(playerId);
    if (!visual) return;
    const gfx = this.add.graphics({ x: visual.container.x, y: visual.container.y });
    gfx.fillStyle(0xffffff, 0.4);
    gfx.slice(0, 0, 36, this.inputState.aim - Math.PI / 5, this.inputState.aim + Math.PI / 5, false);
    gfx.fillPath();
    this.tweens.add({ targets: gfx, alpha: 0, scale: 1.3, duration: 200, onComplete: () => gfx.destroy() });
  }

  parryFlash(targetId: string) {
    const visual = this.players.get(targetId);
    if (!visual) return;
    const ring = this.add.circle(visual.container.x, visual.container.y, 40, 0xffffff, 0.35);
    this.tweens.add({ targets: ring, scale: 1.4, alpha: 0, duration: 200, onComplete: () => ring.destroy() });
    this.cameras.main.shake(80, 0.0025);
  }

  updateHud(state: PlayerState) {
    const shield = this.ui.shield;
    shield.innerHTML = '';
    for (let i = 0; i < GAME_CONSTANTS.shieldDurability; i++) {
      const pip = document.createElement('div');
      pip.className = 'pip' + (i < state.shieldDurability ? '' : ' empty');
      shield.appendChild(pip);
    }
    const dashPct = clamp(1 - state.dashCooldown / GAME_CONSTANTS.dashCooldown, 0, 1);
    this.ui.dash.style.transform = `scaleX(${dashPct})`;
    const chargePct = clamp(state.chargeTime / GAME_CONSTANTS.superThreshold, 0, 1);
    this.ui.charge.style.transform = `scaleX(${chargePct})`;
    if (this.mode === 'C') {
      this.ui.mana.style.display = 'block';
      const fill = this.ui.mana.querySelector('.fill') as HTMLDivElement;
      fill.style.transform = `scaleX(${clamp(state.ghostEnergy / GAME_CONSTANTS.manaMax, 0, 1)})`;
    } else {
      this.ui.mana.style.display = 'none';
    }
  }
}

createStyle();
const ui = createUI();

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1024,
  height: 768,
  parent: 'app',
  physics: { default: 'arcade' },
  backgroundColor: '#0b0c10',
};

let game: Phaser.Game | null = null;

function startGame() {
  if (game) game.destroy(true);
  const serverInput = ui.serverInput.value.trim();
  const mode = ui.modeSelect.value as GameMode;
  localStorage.setItem('serverUrl', serverInput);
  const scene = new DuelScene({ serverUrl: serverInput, mode, ui });
  game = new Phaser.Game({ ...config, scene: [scene] });
}

ui.play.addEventListener('click', () => {
  startGame();
});

// Auto-start with defaults for quick iteration
startGame();
