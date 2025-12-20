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
const INTERPOLATION_TICKS = 6;

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

function normalize(x: number, y: number) {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function createStyle() {
  const style = document.createElement('style');
  style.textContent = `
  :root {
    --panel: rgba(6,8,20,0.9);
    --accent: #5df2ff;
    --accent-2: #ff7ddf;
    --bg: radial-gradient(circle at 20% 20%, rgba(111,124,255,0.14), transparent 35%),
          radial-gradient(circle at 80% 30%, rgba(93,242,255,0.14), transparent 40%),
          #05070f;
    --text: #e9f2ff;
  }
  body { margin: 0; background: var(--bg); overflow: hidden; }
  #ui-root { position: fixed; inset: 0; pointer-events: none; font-family: 'Inter', system-ui, sans-serif; color: var(--text); }
  .menu-card { pointer-events: auto; max-width: 420px; margin: 60px auto; padding: 22px 26px; background: var(--panel); border: 1px solid #1a2440; border-radius: 14px; box-shadow: 0 14px 40px rgba(0,0,0,0.55); }
  .menu-title { font-size: 30px; margin: 0 0 12px 0; letter-spacing: 1px; text-align: center; }
  .menu-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .menu-field label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #9fb7d6; }
  .menu-field input, .menu-field select { padding: 11px 12px; border-radius: 10px; border: 1px solid #27324d; background: #0b1221; color: var(--text); }
  .menu-actions { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .menu-actions button { flex: 1; padding: 12px; border: none; border-radius: 10px; background: linear-gradient(135deg, #38d9ff, #6f7cff); color: #05080f; font-weight: 700; cursor: pointer; transition: transform 120ms ease, box-shadow 120ms ease; }
  .menu-actions button.secondary { background: #11182c; color: var(--text); border: 1px solid #24314d; }
  .menu-actions button:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(111,124,255,0.35); }
  #status { font-size: 13px; color: #b7c9ff; text-align: center; margin-top: 10px; }
  #hud { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; pointer-events: none; padding: 14px; }
  #hud .top-row { display: flex; justify-content: space-between; align-items: center; }
  #hud .meters { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .pip { width: 12px; height: 12px; border-radius: 50%; border: 1px solid #88d4ff; background: rgba(136,212,255,0.3); }
  .pip.empty { background: rgba(255,255,255,0.08); border-color: #5a6a84; }
  .bar { position: relative; width: 180px; height: 12px; border-radius: 8px; background: rgba(255,255,255,0.08); overflow: hidden; border: 1px solid #1f2a44; }
  .bar .fill { position: absolute; inset: 0; background: linear-gradient(90deg, var(--accent), #9d7bff); transform-origin: left center; }
  .bar.super::after { content: 'SUPER'; position: absolute; right: 4px; top: -18px; font-size: 10px; color: #ffd166; }
  .score { font-weight: 700; letter-spacing: 0.08em; }
  #hud .mode { font-size: 12px; color: #a8b8db; }
  #overlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; font-size: 22px; color: #c8d6ff; background: rgba(6,8,16,0.35); }
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
        <div class="mode" id="ping">Ping: --</div>
        <button class="secondary" id="back" style="pointer-events:auto; padding:8px 10px;">Back to menu</button>
      </div>
    </div>
    <div id="overlay">Waiting for opponent…</div>
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
  const ping = root.querySelector('#ping') as HTMLDivElement;
  const overlay = root.querySelector('#overlay') as HTMLDivElement;
  const back = root.querySelector('#back') as HTMLButtonElement;
  return { root, status, play, menu, hud, serverInput, modeSelect, score, hudMode, shield, dash, charge, mana, ping, overlay, back };
}

type UIHandles = ReturnType<typeof createUI>;

type PlayerVisual = {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Arc;
  blade: Phaser.GameObjects.Line;
  glow: Phaser.GameObjects.Arc;
  shield: Phaser.GameObjects.Arc;
};

type PendingInput = { tick: number; msg: ClientInputMessage };

type PredictedState = {
  position: Phaser.Math.Vector2;
  velocity: Phaser.Math.Vector2;
  aimAngle: number;
  dashCooldown: number;
  dashTimer: number;
  charging: boolean;
  chargeTime: number;
  attackCooldown: number;
};

class DuelScene extends Phaser.Scene {
  socket?: WebSocket;
  playerId = '';
  mode: GameMode = 'A';
  tick = 0;
  latestServerTick = 0;
  snapshotBuffer: SnapshotMessage[] = [];
  players: Map<string, PlayerVisual> = new Map();
  ghostEntities: Map<string, Phaser.GameObjects.Container> = new Map();
  inputState = { moveX: 0, moveY: 0, buttons: { attack: false, shield: false, dash: false, ghost: false }, charge: false, aim: 0 };
  pendingInputs: PendingInput[] = [];
  predicted?: PredictedState;
  lastAuthState?: PlayerState;
  lastPing = 0;
  ping = 0;
  serverUrl: string;
  name = 'Ronin';
  sendTimer?: number;
  interpolationDelay = INTERPOLATION_TICKS;
  ui: UIHandles;
  playerOrder: string[] = [];
  scoreState: Record<string, number> = {};
  pointerWorld = new Phaser.Math.Vector2();
  chargeStart = 0;
  chargeActive = false;
  attackPulse = false;
  queuedChargeAttack = false;
  dashPulse = false;
  ghostPulse = false;
  cam?: Phaser.Cameras.Scene2D.Camera;
  dead = false;
  pingEvent?: Phaser.Time.TimerEvent;

  constructor(opts: { serverUrl: string; mode: GameMode; ui: UIHandles; playerName?: string }) {
    super('DuelScene');
    this.serverUrl = opts.serverUrl;
    this.mode = opts.mode;
    this.ui = opts.ui;
    if (opts.playerName) this.name = opts.playerName;
  }

  preload() {}

  create() {
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());

    this.ui.menu.style.display = 'none';
    this.ui.hud.style.display = 'flex';
    this.ui.hudMode.textContent = `Mode ${this.mode}`;
    this.ui.overlay.style.display = 'flex';

    const grid = this.add.grid(640, 360, 1600, 1200, 64, 64, 0x0b1024, 0.15, 0x1a2644, 0.25);
    grid.setBlendMode(Phaser.BlendModes.ADD);
    const vignette = this.add.rectangle(640, 360, 1600, 1200, 0x000000, 0.25);
    vignette.setStrokeStyle(3, 0x1a1f35, 0.35);

    this.cam = this.cameras.main;
    this.cam.setBackgroundColor('#05070f');

    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => this.handleKey(e, true));
    this.input.keyboard?.on('keyup', (e: KeyboardEvent) => this.handleKey(e, false));
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.pointerWorld.set(pointer.worldX, pointer.worldY);
      this.updateAim();
    });
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => this.handlePointerDown(pointer));
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => this.handlePointerUp(pointer));

    this.connect();
  }

  connect() {
    if (this.dead) return;
    this.ui.status.textContent = `Connecting to ${this.serverUrl}`;
    const ws = new WebSocket(this.serverUrl);
    this.socket = ws;
    ws.onopen = () => {
      if (this.dead) return;
      const hello: ClientHelloMessage = { type: 'hello', name: this.name, version: PROTOCOL_VERSION };
      ws.send(JSON.stringify(hello));
      const modeMsg: ClientSetModeMessage = { type: 'setMode', mode: this.mode, version: PROTOCOL_VERSION };
      ws.send(JSON.stringify(modeMsg));
      this.pingEvent = this.time.addEvent({ delay: 1000, loop: true, callback: () => this.sendPing() });
      this.sendTimer = window.setInterval(() => this.sendInput(), 1000 / 60);
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      this.ui.status.textContent = 'Disconnected';
      this.ui.overlay.textContent = 'Disconnected';
      this.ui.overlay.style.display = 'flex';
      if (this.sendTimer) window.clearInterval(this.sendTimer);
      if (this.pingEvent) this.pingEvent.remove(false);
    };
  }

  teardown() {
    if (this.dead) return;
    this.dead = true;
    if (this.sendTimer) {
      window.clearInterval(this.sendTimer);
      this.sendTimer = undefined;
    }
    if (this.pingEvent) {
      this.pingEvent.remove(false);
      this.pingEvent.destroy();
      this.pingEvent = undefined;
    }
    if (this.socket) {
      try {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onerror = null;
        this.socket.onclose = null;
        this.socket.close();
      } catch (e) {
        console.warn('socket close error', e);
      }
      this.socket = undefined;
    }
  }

  sendPing() {
    if (this.dead || !this.sys.isActive()) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.lastPing = performance.now();
    const msg: ClientPingMessage = { type: 'ping', ts: this.lastPing, version: PROTOCOL_VERSION };
    this.socket.send(JSON.stringify(msg));
  }

  handlePointerDown(pointer: Phaser.Input.Pointer) {
    if (pointer.rightButtonDown()) {
      this.inputState.buttons.shield = true;
      return;
    }
    this.chargeActive = true;
    this.inputState.charge = true;
    this.chargeStart = performance.now();
  }

  handlePointerUp(pointer: Phaser.Input.Pointer) {
    if (pointer.rightButtonReleased()) {
      this.inputState.buttons.shield = false;
      return;
    }
    const held = performance.now() - this.chargeStart;
    if (held > 150) {
      this.queuedChargeAttack = true;
    } else {
      this.attackPulse = true;
    }
    this.chargeActive = false;
    this.inputState.charge = false;
  }

  sendInput() {
    if (this.dead || !this.sys.isActive()) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.tick += 1;

    const buttons = {
      attack: this.attackPulse || this.queuedChargeAttack,
      shield: this.inputState.buttons.shield,
      dash: this.dashPulse,
      ghost: this.ghostPulse,
    };

    const msg: ClientInputMessage = {
      type: 'input',
      tick: this.tick,
      aimAngle: this.inputState.aim,
      moveX: clamp(this.inputState.moveX, -1, 1),
      moveY: clamp(this.inputState.moveY, -1, 1),
      buttons,
      charge: this.chargeActive || this.queuedChargeAttack,
      version: PROTOCOL_VERSION,
    };

    this.socket.send(JSON.stringify(msg));
    this.pendingInputs.push({ tick: this.tick, msg });
    this.applyLocalPrediction(msg);

    this.attackPulse = false;
    this.dashPulse = false;
    this.ghostPulse = false;
    if (this.queuedChargeAttack) {
      this.queuedChargeAttack = false;
      this.attackPulse = false;
      this.chargeActive = false;
      this.inputState.charge = false;
    }
  }

  applyLocalPrediction(msg: ClientInputMessage) {
    if (!this.predicted) return;
    const dt = 1 / 60;
    this.predicted.attackCooldown = Math.max(0, this.predicted.attackCooldown - dt);
    this.predicted.dashCooldown = Math.max(0, this.predicted.dashCooldown - dt);
    this.predicted.dashTimer = Math.max(0, this.predicted.dashTimer - dt);

    if (msg.charge) {
      this.predicted.charging = true;
      this.predicted.chargeTime += dt;
    } else {
      this.predicted.charging = false;
      this.predicted.chargeTime = 0;
    }

    if (msg.buttons.dash && this.predicted.dashCooldown <= 0) {
      this.predicted.dashCooldown = GAME_CONSTANTS.dashCooldown;
      this.predicted.dashTimer = GAME_CONSTANTS.dashDuration;
    }

    if (msg.buttons.attack && this.predicted.attackCooldown <= 0) {
      if (this.predicted.charging) {
        const bonus = Math.min(this.predicted.chargeTime, GAME_CONSTANTS.superThreshold);
        const dashBoost = 20 * (bonus / GAME_CONSTANTS.superThreshold);
        this.predicted.position.x += Math.cos(msg.aimAngle) * dashBoost;
        this.predicted.position.y += Math.sin(msg.aimAngle) * dashBoost;
      }
      this.predicted.attackCooldown = GAME_CONSTANTS.attackCooldown;
      this.predicted.charging = false;
      this.predicted.chargeTime = 0;
    }

    let speed = GAME_CONSTANTS.moveSpeed;
    if (this.predicted.charging) speed *= GAME_CONSTANTS.chargeSlow;
    let dir = normalize(msg.moveX, msg.moveY);
    if (this.predicted.dashTimer > 0) {
      dir = normalize(Math.cos(msg.aimAngle), Math.sin(msg.aimAngle));
      speed = GAME_CONSTANTS.dashSpeed;
    }
    this.predicted.aimAngle = msg.aimAngle;
    this.predicted.velocity.set(dir.x * speed, dir.y * speed);
    this.predicted.position.x += this.predicted.velocity.x * dt;
    this.predicted.position.y += this.predicted.velocity.y * dt;
  }

  handleKey(e: KeyboardEvent, down: boolean) {
    switch (e.code) {
      case 'KeyW':
        this.inputState.moveY = down ? -1 : this.inputState.moveY === -1 ? 0 : this.inputState.moveY;
        break;
      case 'KeyS':
        this.inputState.moveY = down ? 1 : this.inputState.moveY === 1 ? 0 : this.inputState.moveY;
        break;
      case 'KeyA':
        this.inputState.moveX = down ? -1 : this.inputState.moveX === -1 ? 0 : this.inputState.moveX;
        break;
      case 'KeyD':
        this.inputState.moveX = down ? 1 : this.inputState.moveX === 1 ? 0 : this.inputState.moveX;
        break;
      case 'ShiftLeft':
        if (down) this.dashPulse = true;
        break;
      case 'Space':
        if (down) this.ghostPulse = true;
        break;
    }
  }

  updateAim() {
    if (!this.predicted) return;
    this.inputState.aim = Math.atan2(this.pointerWorld.y - this.predicted.position.y, this.pointerWorld.x - this.predicted.position.x);
  }

  handleMessage(raw: any) {
    if (this.dead || !this.sys.isActive()) return;
    const msg = JSON.parse(raw) as ServerMessage & { type: string };
    if ('version' in msg && msg.version !== PROTOCOL_VERSION) {
      this.ui.status.textContent = 'Protocol mismatch';
      this.ui.overlay.textContent = 'Protocol mismatch';
      this.ui.overlay.style.display = 'flex';
      this.socket?.close();
      return;
    }
    switch (msg.type) {
      case 'welcome':
        this.playerId = (msg as any).playerId;
        this.ui.status.textContent = `Joined as ${this.playerId}`;
        if ((msg as any).players) {
          this.playerOrder = (msg as any).players.map((p: PlayerState) => p.id);
        }
        break;
      case 'matchStart':
        this.playerOrder = (msg as any).players?.map((p: PlayerState) => p.id) || this.playerOrder;
        break;
      case 'snapshot':
        this.latestServerTick = (msg as SnapshotMessage).tick;
        this.snapshotBuffer.push(msg as SnapshotMessage);
        if (this.snapshotBuffer.length > 60) this.snapshotBuffer.shift();
        this.renderSnapshot(msg as SnapshotMessage);
        break;
      case 'event':
        if ((msg as any).event === 'roundEnd') {
          this.scoreState = (msg as any).payload.scores;
        }
        if ((msg as any).event === 'parry') {
          const payload = (msg as any).payload;
          this.parryFlash(payload?.target);
        }
        break;
      case 'pong':
        this.ping = performance.now() - (msg as any).ts;
        this.ui.ping.textContent = `Ping: ${Math.round(this.ping)}ms`;
        break;
    }
  }

  reconcile(localState: PlayerState) {
    if (!this.predicted) {
      this.predicted = {
        position: new Phaser.Math.Vector2(localState.position.x, localState.position.y),
        velocity: new Phaser.Math.Vector2(localState.velocity.x, localState.velocity.y),
        aimAngle: localState.aimAngle,
        dashCooldown: localState.dashCooldown,
        dashTimer: 0,
        charging: localState.charging,
        chargeTime: localState.chargeTime,
        attackCooldown: 0,
      };
    }
    if (localState.lastClientTickProcessed == null) return;
    this.predicted.position.set(localState.position.x, localState.position.y);
    this.predicted.velocity.set(localState.velocity.x, localState.velocity.y);
    this.predicted.aimAngle = localState.aimAngle;
    this.predicted.chargeTime = localState.chargeTime;
    this.predicted.charging = localState.charging;
    this.predicted.dashCooldown = localState.dashCooldown;

    this.pendingInputs = this.pendingInputs.filter((p) => p.tick > (localState.lastClientTickProcessed || 0));
    for (const pending of this.pendingInputs) {
      this.applyLocalPrediction(pending.msg);
    }
  }

  renderSnapshot(snapshot: SnapshotMessage) {
    if (this.dead || !this.sys.isActive()) return;
    this.scoreState = snapshot.scores || this.scoreState;
    this.playerOrder = snapshot.playersOrdered?.length ? snapshot.playersOrdered : this.playerOrder;

    const seenPlayerIds = new Set<string>();
    snapshot.players.forEach((p) => {
      seenPlayerIds.add(p.id);
      if (p.id === this.playerId) {
        this.lastAuthState = p;
        this.reconcile(p);
      }
      const existing = this.players.get(p.id);
      this.drawPlayer(p, existing, 0, p.id === this.playerId);
    });

    for (const [id, vis] of Array.from(this.players.entries())) {
      if (!seenPlayerIds.has(id)) {
        vis.container.destroy(true);
        this.players.delete(id);
      }
    }

    const seenGhostIds = new Set<string>();
    snapshot.ghosts.forEach((g) => {
      seenGhostIds.add(g.id);
      this.drawGhost(g);
    });
    for (const [id, vis] of Array.from(this.ghostEntities.entries())) {
      if (!seenGhostIds.has(id)) {
        vis.destroy(true);
        this.ghostEntities.delete(id);
      }
    }

    const ordered = this.playerOrder.length ? this.playerOrder : snapshot.players.map((p) => p.id);
    const scores = ordered.map((id) => this.scoreState[id] || 0);
    this.ui.score.textContent = `Round: ${snapshot.round} | Score: ${scores.join(' - ')} | Ping ${Math.round(this.ping)}ms`;
    const playerState = this.lastAuthState;
    if (playerState) {
      this.updateHud(playerState);
    }

    const waiting = snapshot.players.length < 2;
    this.ui.overlay.style.display = waiting ? 'flex' : 'none';
  }

  interpolatePlayer(id: string) {
    const renderTick = this.latestServerTick - this.interpolationDelay;
    let prev: { snap: SnapshotMessage; state: PlayerState } | null = null;
    let next: { snap: SnapshotMessage; state: PlayerState } | null = null;
    for (const snap of this.snapshotBuffer) {
      const state = snap.players.find((p) => p.id === id);
      if (!state) continue;
      if (snap.tick <= renderTick) prev = { snap, state };
      if (snap.tick >= renderTick) {
        next = { snap, state };
        break;
      }
    }
    if (!prev && next) prev = next;
    if (!next && prev) next = prev;
    if (!prev || !next) return null;
    const t = clamp((renderTick - prev.snap.tick) / Math.max(1, next.snap.tick - prev.snap.tick), 0, 1);
    const lerpPos = new Phaser.Math.Vector2(
      Phaser.Math.Linear(prev.state.position.x, next.state.position.x, t),
      Phaser.Math.Linear(prev.state.position.y, next.state.position.y, t)
    );
    const aim = Phaser.Math.Angle.ShortestBetween(prev.state.aimAngle, next.state.aimAngle) * t + prev.state.aimAngle;
    return { ...next.state, position: { x: lerpPos.x, y: lerpPos.y }, aimAngle: aim } as PlayerState;
  }

  update(_time: number, delta: number): void {
    if (this.dead || !this.sys.isActive()) return;
    const dt = delta / 1000;
    this.players.forEach((visual, id) => {
      let state: PlayerState | null = null;
      if (id === this.playerId && this.predicted) {
        state = {
          ...(this.lastAuthState || ({} as PlayerState)),
          position: { x: this.predicted.position.x, y: this.predicted.position.y },
          velocity: { x: this.predicted.velocity.x, y: this.predicted.velocity.y },
          aimAngle: this.predicted.aimAngle,
        } as PlayerState;
      } else {
        state = this.interpolatePlayer(id) || this.lastAuthState || null;
      }
      if (!state) return;
      this.drawPlayer(state, visual, dt, id === this.playerId);
    });
  }

  drawPlayer(state: PlayerState, visual?: PlayerVisual, _dt = 0, isLocal = false) {
    let vis = visual ?? this.players.get(state.id);
    if (!vis) {
      const body = this.add.circle(0, 0, 18, 0x5df2ff, 0.95);
      const glow = this.add.circle(0, 0, 30, 0x5df2ff, 0.14);
      const blade = this.add.line(0, 0, 0, 0, 42, 0, 0xffffff, 0.9);
      const shield = this.add.circle(0, 0, 28, 0xffffff, 0.12);
      const container = this.add.container(state.position.x, state.position.y, [glow, body, shield, blade]);
      container.setDepth(10);
      vis = { container, body, blade, glow, shield };
      this.players.set(state.id, vis);
      if (isLocal && this.cam) {
        this.cam.startFollow(container, true, 0.12, 0.12);
      }
    }

    vis.container.x = state.position.x;
    vis.container.y = state.position.y;

    const aimAngle = isLocal ? this.inputState.aim : state.aimAngle;
    const len = 38;
    vis.blade.setTo(0, 0, Math.cos(aimAngle) * len, Math.sin(aimAngle) * len);
    vis.body.setFillStyle(state.isDead ? 0x303848 : 0x5df2ff, isLocal ? 1 : 0.7);
    vis.shield.setVisible(state.shieldUp);
    vis.shield.setScale(1 + Math.max(0, (state.shieldDurability - 1) * 0.08));
    vis.shield.setFillStyle(0x88d4ff, state.shieldUp ? 0.18 : 0);
    vis.glow.setFillStyle(0x5df2ff, state.charging ? 0.28 : 0.16);
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
    const chargePct = clamp((this.predicted?.chargeTime ?? state.chargeTime) / GAME_CONSTANTS.superThreshold, 0, 1);
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
  width: 1280,
  height: 720,
  parent: 'app',
  physics: { default: 'arcade' },
  backgroundColor: '#05070f',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1280,
    height: 720,
  },
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

ui.back.addEventListener('click', () => {
  if (game) {
    game.destroy(true);
    game = null;
  }
  ui.hud.style.display = 'none';
  ui.menu.style.display = 'block';
  ui.overlay.style.display = 'none';
});
