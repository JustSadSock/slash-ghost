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

class DuelScene extends Phaser.Scene {
  socket?: WebSocket;
  playerId = '';
  mode: GameMode = 'A';
  connected = false;
  tick = 0;
  lastSnapshotTick = 0;
  players: Map<string, Phaser.GameObjects.Container> = new Map();
  hudText!: Phaser.GameObjects.Text;
  infoText!: Phaser.GameObjects.Text;
  ghostEntities: Map<string, Phaser.GameObjects.Container> = new Map();
  inputState = { moveX: 0, moveY: 0, buttons: { attack: false, shield: false, dash: false, ghost: false }, charge: false, aim: 0 };
  scores: Record<string, number> = {};
  lastPing = 0;
  ping = 0;
  serverUrl = resolveServerUrl();
  name = 'Ronin';

  preload() {}

  create() {
    this.infoText = this.add.text(10, 10, 'Connecting...', { color: '#fff' });
    this.hudText = this.add.text(10, 40, '', { color: '#0ff' });
    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => this.handleKey(e, true));
    this.input.keyboard?.on('keyup', (e: KeyboardEvent) => this.handleKey(e, false));
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const center = { x: this.scale.width / 2, y: this.scale.height / 2 };
      this.inputState.aim = Math.atan2(pointer.worldY - center.y, pointer.worldX - center.x);
    });
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) this.inputState.buttons.shield = true;
      else this.inputState.buttons.attack = true;
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
    this.infoText.setText(`Connecting to ${this.serverUrl}`);
    const ws = new WebSocket(this.serverUrl);
    this.socket = ws;
    ws.onopen = () => {
      this.connected = true;
      const hello: ClientHelloMessage = { type: 'hello', name: this.name, version: PROTOCOL_VERSION };
      ws.send(JSON.stringify(hello));
      const modeMsg: ClientSetModeMessage = { type: 'setMode', mode: this.mode, version: PROTOCOL_VERSION };
      ws.send(JSON.stringify(modeMsg));
      this.time.addEvent({ delay: 1000, loop: true, callback: () => this.sendPing() });
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      this.connected = false;
      this.infoText.setText('Disconnected');
    };
  }

  sendPing() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.lastPing = performance.now();
    const msg: ClientPingMessage = { type: 'ping', ts: this.lastPing, version: PROTOCOL_VERSION };
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
        this.infoText.setText(`Joined as ${this.playerId}`);
        break;
      case 'snapshot':
        this.lastSnapshotTick = (msg as SnapshotMessage).tick;
        this.renderSnapshot(msg as SnapshotMessage);
        break;
      case 'event':
        if ((msg as any).event === 'roundEnd') {
          this.scores = (msg as any).payload.scores;
        }
        break;
      case 'pong':
        this.ping = performance.now() - (msg as any).ts;
        break;
    }
  }

  renderSnapshot(snapshot: SnapshotMessage) {
    snapshot.players.forEach((p) => this.drawPlayer(p));
    snapshot.ghosts.forEach((g) => this.drawGhost(g));
    this.hudText.setText(`Ping ${Math.round(this.ping)}ms | Round scores: ${Object.values(this.scores).join(' : ')} | Mode ${this.mode}`);
  }

  drawPlayer(state: PlayerState) {
    let c = this.players.get(state.id);
    if (!c) {
      const circle = this.add.circle(0, 0, 18, 0x00ffcc);
      const aim = this.add.line(0, 0, 0, 0, 24, 0, 0xffffff);
      c = this.add.container(state.position.x, state.position.y, [circle, aim]);
      this.players.set(state.id, c);
    }
    c.setPosition(state.position.x, state.position.y);
    const aim = c.list[1] as Phaser.GameObjects.Line;
    const len = 26;
    aim.setTo(0, 0, Math.cos(state.aimAngle) * len, Math.sin(state.aimAngle) * len);
    (c.list[0] as Phaser.GameObjects.Arc).setFillStyle(state.isDead ? 0x444444 : 0x00ffcc, state.id === this.playerId ? 1 : 0.6);
  }

  drawGhost(g: any) {
    let c = this.ghostEntities.get(g.id);
    if (!c) {
      const circle = this.add.circle(0, 0, 14, 0xffffff, 0.35);
      c = this.add.container(g.position.x, g.position.y, [circle]);
      this.ghostEntities.set(g.id, c);
    }
    c.setPosition(g.position.x, g.position.y);
    c.setAlpha(g.active ? 0.5 : 0.2);
  }

  update(time: number, delta: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.tick += 1;
    const msg: ClientInputMessage = {
      type: 'input',
      tick: this.tick,
      aimAngle: this.inputState.aim,
      moveX: this.inputState.moveX,
      moveY: this.inputState.moveY,
      buttons: this.inputState.buttons,
      charge: this.inputState.charge,
      version: PROTOCOL_VERSION,
    };
    this.socket.send(JSON.stringify(msg));
  }
}

const hud = document.createElement('div');
hud.style.position = 'fixed';
hud.style.top = '10px';
hud.style.right = '10px';
hud.style.background = 'rgba(0,0,0,0.4)';
hud.style.padding = '10px';
hud.style.color = '#fff';
hud.style.zIndex = '10';
hud.innerHTML = `<label>Server URL <input id="serverUrl" value="${resolveServerUrl()}" size="40"/></label><br/>` +
  `<label>Mode <select id="mode"><option value="A">Loop Echo</option><option value="B">Lag Shadow</option><option value="C">Mana Shadow</option></select></label>` +
  `<button id="play">Play</button>`;
document.body.appendChild(hud);

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1024,
  height: 768,
  parent: 'app',
  physics: { default: 'arcade' },
  backgroundColor: '#0b0c10',
  scene: [DuelScene],
};

let game: Phaser.Game | null = null;

function startGame() {
  if (game) game.destroy(true);
  const scene = new DuelScene();
  const serverInput = document.getElementById('serverUrl') as HTMLInputElement;
  const modeSelect = document.getElementById('mode') as HTMLSelectElement;
  localStorage.setItem('serverUrl', serverInput.value);
  scene.serverUrl = serverInput.value;
  scene.mode = modeSelect.value as GameMode;
  game = new Phaser.Game({ ...config, scene: [scene] });
}

document.getElementById('play')?.addEventListener('click', () => {
  startGame();
});

startGame();
