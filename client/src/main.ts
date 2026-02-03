import Phaser from "phaser";
import * as Shared from "@slime-sync/shared";
const {
  BASE_MOVE_SPEED,
  GameMode,
  PLAYER_RADIUS,
  PROTOCOL_VERSION,
  ServerMessage,
  ClientMessage,
  InputButtons,
  PlayerState,
  GhostState,
  RoundMap,
} = Shared;

const DEFAULT_SERVER = "wss://irgri.uk/ws";

function resolveServerUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const query = params.get("server");
  if (query) {
    localStorage.setItem("serverUrl", query);
    return query;
  }
  const stored = localStorage.getItem("serverUrl");
  if (stored) return stored;
  const envUrl = import.meta.env?.VITE_SERVER_URL as string | undefined;
  if (envUrl) return envUrl;
  return DEFAULT_SERVER;
}

class InputTracker {
  keys: Record<string, Phaser.Input.Keyboard.Key>;
  pointerAngle = 0;
  attackQueued = false;
  chargeHeld = false;
  shieldHeld = false;
  dashHeld = false;
  ghostHeld = false;
  toggleGhostQueued = false;
  constructor(private scene: Phaser.Scene) {
    this.keys = scene.input.keyboard!.addKeys("W,A,S,D,SHIFT,G,T") as any;

    scene.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      this.pointerAngle = Phaser.Math.Angle.Between(
        scene.cameras.main.width / 2,
        scene.cameras.main.height / 2,
        p.x,
        p.y
      );
    });
    scene.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (p.leftButtonDown()) {
        this.chargeHeld = true;
      }
      if (p.rightButtonDown()) {
        this.shieldHeld = true;
      }
    });
    scene.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (p.leftButtonReleased()) {
        this.chargeHeld = false;
        this.attackQueued = true;
      }
      if (p.rightButtonReleased()) {
        this.shieldHeld = false;
      }
    });
    this.keys.G.on("down", () => (this.ghostHeld = true));
    this.keys.G.on("up", () => (this.ghostHeld = false));
    this.keys.T.on("down", () => (this.toggleGhostQueued = true));
  }

  consume(): InputButtons {
    const moveX = (this.keys.D.isDown ? 1 : 0) - (this.keys.A.isDown ? 1 : 0);
    const moveY = (this.keys.S.isDown ? 1 : 0) - (this.keys.W.isDown ? 1 : 0);
    const input: InputButtons = {
      moveX,
      moveY,
      aim: this.pointerAngle,
      attack: this.attackQueued,
      charge: this.chargeHeld,
      shield: this.shieldHeld,
      dash: this.keys.SHIFT.isDown,
      ghost: this.ghostHeld,
      toggleGhost: this.toggleGhostQueued,
    };
    this.attackQueued = false;
    this.toggleGhostQueued = false;
    return input;
  }
}

class NetClient {
  private socket?: WebSocket;
  private tick = 0;
  private inputTimer?: number;
  public latestPlayers: Map<string, PlayerState> = new Map();
  public latestGhosts: Map<string, GhostState> = new Map();
  public map?: RoundMap;
  public playerId?: string;
  public matchText: string = "Waiting for players...";
  constructor(private inputTracker: InputTracker, private hud: HTMLElement) {}

  connect(name: string, mode: GameMode, url: string) {
    if (this.socket) this.socket.close();
    this.socket = new WebSocket(url);
    this.socket.onopen = () => {
      this.send({
        type: "hello",
        name,
        version: PROTOCOL_VERSION,
      });
      this.send({ type: "setMode", mode });
      this.hud.innerText = "Connected. Waiting for opponent...";
      this.startInputLoop();
    };
    this.socket.onmessage = (ev) => this.handleMessage(ev.data);
    this.socket.onclose = () => {
      this.hud.innerText = "Disconnected.";
      window.clearInterval(this.inputTimer);
    };
  }

  private startInputLoop() {
    this.tick = 0;
    window.clearInterval(this.inputTimer);
    this.inputTimer = window.setInterval(() => {
      this.tick++;
      const input = this.inputTracker.consume();
      this.send({ type: "input", tick: this.tick, input });
    }, 1000 / 60);
  }

  private send(msg: ClientMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(msg));
  }

  private handleMessage(raw: string) {
    const msg = JSON.parse(raw) as ServerMessage;
    switch (msg.type) {
      case "welcome":
        this.playerId = msg.playerId;
        break;
      case "snapshot":
        this.latestPlayers = new Map(msg.players.map((p) => [p.id, p]));
        this.latestGhosts = new Map(msg.ghosts.map((g) => [g.id, g]));
        break;
      case "roundStart":
        this.map = msg.map;
        this.matchText = `Round ${msg.state.round}`;
        break;
      case "roundEnd":
        this.matchText = `Round won by ${msg.winnerId.substring(0, 4)}`;
        break;
      case "matchEnd":
        this.matchText = `Match winner ${msg.winnerId.substring(0, 4)}`;
        break;
    }
    this.hud.innerText = this.matchText;
  }
}

class DuelScene extends Phaser.Scene {
  private graphics!: Phaser.GameObjects.Graphics;
  private inputTracker!: InputTracker;
  private client!: NetClient;
  private hudEl: HTMLElement;
  constructor(hudEl: HTMLElement) {
    super("duel");
    this.hudEl = hudEl;
  }
  preload() {}
  create() {
    this.graphics = this.add.graphics();
    this.inputTracker = new InputTracker(this);
    this.client = new NetClient(this.inputTracker, this.hudEl);
    this.cameras.main.setBackgroundColor("#0b0c10");
    setupMenu((name, mode, url) => {
      this.client.connect(name, mode, url);
    });
  }

  update(_: number, delta: number) {
    this.renderWorld();
  }

  private renderWorld() {
    this.graphics.clear();
    const cx = this.cameras.main.width / 2;
    const cy = this.cameras.main.height / 2;
    // Obstacles
    const map = (this.client as any).map as RoundMap | undefined;
    if (map) {
      this.graphics.lineStyle(2, 0x455a64, 0.6);
      map.obstacles.forEach((o) => {
        const x = cx + o.x;
        const y = cy + o.y;
        this.graphics.strokeRect(x - o.width / 2, y - o.height / 2, o.width, o.height);
      });
    }
    // Players
    this.client.latestPlayers.forEach((p) => {
      const isSelf = p.id === this.client.playerId;
      this.graphics.fillStyle(isSelf ? 0x66fcf1 : 0xf64c72, 1);
      const px = cx + p.position.x;
      const py = cy + p.position.y;
      this.graphics.fillCircle(px, py, PLAYER_RADIUS);
      // facing
      this.graphics.lineStyle(3, 0xffffff, 0.8);
      this.graphics.beginPath();
      this.graphics.moveTo(px, py);
      this.graphics.lineTo(
        px + Math.cos(p.facing) * (PLAYER_RADIUS + 12),
        py + Math.sin(p.facing) * (PLAYER_RADIUS + 12)
      );
      this.graphics.strokePath();
      // charge meter
      const chargeRatio = p.charge.chargeTime / 2.5;
      this.graphics.fillStyle(0xffc107, 0.7);
      this.graphics.fillRect(px - 18, py + 22, 36 * chargeRatio, 4);
      // shield durability
      this.graphics.fillStyle(0x00e676, 0.6);
      this.graphics.fillRect(px - 18, py - 30, 12 * p.shield.durability, 4);
    });
    // Ghosts
    this.client.latestGhosts.forEach((g) => {
      this.graphics.fillStyle(0x9c27b0, 0.4);
      this.graphics.fillCircle(cx + g.position.x, cy + g.position.y, PLAYER_RADIUS - 4);
    });
  }
}

function setupMenu(onPlay: (name: string, mode: GameMode, url: string) => void) {
  const menu = document.getElementById("menu")!;
  const nameInput = document.getElementById("playerName") as HTMLInputElement;
  const modeSelect = document.getElementById("mode") as HTMLSelectElement;
  const serverInput = document.getElementById("serverUrl") as HTMLInputElement;
  serverInput.value = resolveServerUrl();
  document.getElementById("playBtn")!.addEventListener("click", () => {
    const url = serverInput.value || DEFAULT_SERVER;
    localStorage.setItem("serverUrl", url);
    onPlay(nameInput.value || "Ronin", modeSelect.value as GameMode, url);
    menu.style.display = "none";
  });
}

const hud = document.getElementById("hud")!;
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  parent: document.body,
  scene: new DuelScene(hud),
};

window.addEventListener("load", () => {
  new Phaser.Game(config);
});
