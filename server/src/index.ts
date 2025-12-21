import http, { IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { nanoid } from 'nanoid';
import {
  ClientHelloMessage,
  ClientInputMessage,
  ClientMessage,
  ClientPingMessage,
  ClientSetModeMessage,
  GAME_CONSTANTS,
  GameMode,
  Obstacle,
  PROTOCOL_VERSION,
  PlayerState,
  ServerMessage,
  SnapshotMessage,
  Vector2,
  distanceSq,
  normalize,
  clamp,
  InputRecord,
  GhostState,
} from '@slash-ghost/shared';

const TICK_RATE = GAME_CONSTANTS.tickRate;
const SNAPSHOT_RATE = GAME_CONSTANTS.snapshotRate;
const MS_PER_TICK = 1000 / TICK_RATE;
const MAX_INPUT_BUFFER = TICK_RATE * GAME_CONSTANTS.ghostDelay;

const neutralInput: InputRecord = {
  tick: 0,
  moveX: 0,
  moveY: 0,
  buttons: { attack: false, shield: false, dash: false, ghost: false },
  aimAngle: 0,
  charge: false,
};

function seededRandom(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

class Player {
  id = nanoid();
  name: string;
  socket: WebSocket;
  position: Vector2 = { x: 0, y: 0 };
  velocity: Vector2 = { x: 0, y: 0 };
  aimAngle = 0;
  shieldUp = false;
  shieldDurability = GAME_CONSTANTS.shieldDurability;
  shieldBrokenUntil = 0;
  shieldLockUntil = 0;
  lastShieldRaise = -Infinity;
  dashCooldown = 0;
  dashTimer = 0;
  attackCooldown = 0;
  charging = false;
  chargeTime = 0;
  isDead = false;
  ghostEnergy = GAME_CONSTANTS.manaMax;
  mode: GameMode = 'A';
  latestInput: InputRecord = { ...neutralInput };
  inputHistory: InputRecord[] = [];
  positionHistory: Vector2[] = [];
  lastClientTickProcessed = 0;
  prevButtons: InputRecord['buttons'] = { ...neutralInput.buttons };
  replayGhost?: Ghost;
  possessReady = false;

  constructor(name: string, socket: WebSocket) {
    this.name = name || 'Ronin';
    this.socket = socket;
  }
}

class Ghost {
  id = 'g-' + nanoid();
  owner: Player;
  position: Vector2 = { x: 0, y: 0 };
  velocity: Vector2 = { x: 0, y: 0 };
  active = false;
  alpha = 0.6;
  replayQueue: InputRecord[] = [];
  replayIndex = 0;
  respawnTimer = 0;

  constructor(owner: Player) {
    this.owner = owner;
  }
}

class Room {
  id = nanoid();
  players: Player[] = [];
  ghosts: Ghost[] = [];
  round = 0;
  scores: Record<string, number> = {};
  playersOrdered: string[] = [];
  seed = Date.now();
  obstacles: Obstacle[] = [];
  lastSnapshot = 0;
  tickCount = 0;
  running = false;
  accumulator = 0;

  addPlayer(player: Player) {
    this.players.push(player);
    this.scores[player.id] = 0;
    const ghost = new Ghost(player);
    this.ghosts.push(ghost);
    if (this.players.length === 2) {
      this.playersOrdered = this.players.map((p) => p.id);
      this.startMatch();
    }
  }

  startMatch() {
    this.running = true;
    this.round = 0;
    this.broadcast({ type: 'matchStart', players: this.exportPlayers(), version: PROTOCOL_VERSION });
    this.startRound();
  }

  startRound() {
    this.round += 1;
    this.seed = Math.floor(Math.random() * 100000);
    this.generateObstacles(this.seed);
    const spawns: Vector2[] = [
      { x: 200, y: 200 },
      { x: 800, y: 600 },
    ];
    this.players.forEach((p, i) => {
      p.position = { ...spawns[i] };
      p.velocity = { x: 0, y: 0 };
      p.isDead = false;
      p.shieldDurability = GAME_CONSTANTS.shieldDurability;
      p.shieldBrokenUntil = 0;
      p.shieldLockUntil = 0;
      p.dashCooldown = 0;
      p.chargeTime = 0;
      p.charging = false;
      p.attackCooldown = 0;
      p.ghostEnergy = GAME_CONSTANTS.manaMax;
      p.replayGhost = this.getGhost(p);
      if (p.replayGhost) {
        p.replayGhost.active = p.mode === 'B';
        p.replayGhost.respawnTimer = 0;
      }
      p.inputHistory = [];
      p.positionHistory = [];
      p.latestInput = { ...neutralInput };
      p.prevButtons = { ...neutralInput.buttons };
      p.lastClientTickProcessed = 0;
    });
    this.broadcast({
      type: 'roundStart',
      round: this.round,
      seed: this.seed,
      obstacles: this.obstacles,
      spawns,
      version: PROTOCOL_VERSION,
    });
  }

  getGhost(owner: Player) {
    return this.ghosts.find((g) => g.owner === owner);
  }

  generateObstacles(seed: number) {
    const rng = seededRandom(seed);
    this.obstacles = [];
    for (let i = 0; i < 6; i++) {
      const w = 80 + rng() * 60;
      const h = 60 + rng() * 60;
      const x = 100 + rng() * 700;
      const y = 100 + rng() * 500;
      this.obstacles.push({ id: 'o' + i, x, y, w, h });
    }
  }

  broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    this.players.forEach((p) => {
      if (p.socket.readyState === WebSocket.OPEN) p.socket.send(data);
    });
  }

  tick(dt: number) {
    if (!this.running) return;
    this.tickCount++;
    this.players.forEach((p) => this.simulatePlayer(p, dt));
    this.simulateGhosts(dt);
    if (this.tickCount % Math.round(TICK_RATE / SNAPSHOT_RATE) === 0) {
      this.sendSnapshot();
    }
  }

  simulatePlayer(p: Player, dt: number) {
    p.attackCooldown = Math.max(0, p.attackCooldown - dt);
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.dashTimer = Math.max(0, p.dashTimer - dt);
    if (p.shieldBrokenUntil > 0) p.shieldBrokenUntil = Math.max(0, p.shieldBrokenUntil - dt);
    if (p.shieldLockUntil > 0) p.shieldLockUntil = Math.max(0, p.shieldLockUntil - dt);
    if (!p.shieldUp) {
      p.shieldDurability = clamp(p.shieldDurability + dt * 3, 0, GAME_CONSTANTS.shieldDurability);
    }

    const buf = p.latestInput ?? neutralInput;
    p.lastClientTickProcessed = buf.tick;
    p.aimAngle = buf.aimAngle;
    p.charging = buf.charge && !p.isDead;
    if (p.charging) p.chargeTime += dt; else p.chargeTime = 0;

    let speed = GAME_CONSTANTS.moveSpeed;
    if (p.charging) speed *= GAME_CONSTANTS.chargeSlow;

    let dir = normalize({ x: buf.moveX, y: buf.moveY });
    if (p.dashTimer > 0) {
      dir = normalize({ x: Math.cos(p.aimAngle), y: Math.sin(p.aimAngle) });
      speed = GAME_CONSTANTS.dashSpeed;
    }

    p.velocity = { x: dir.x * speed, y: dir.y * speed };
    p.position.x += p.velocity.x * dt;
    p.position.y += p.velocity.y * dt;
    this.resolveObstacles(p);

    if (!p.isDead) {
      this.processButtons(p, buf.buttons, dt);
    }

    const manaDelta = p.mode === 'C'
      ? (p.replayGhost?.active ? -GAME_CONSTANTS.manaDrain * dt : GAME_CONSTANTS.manaRegen * dt)
      : 0;
    p.ghostEnergy = clamp(p.ghostEnergy + manaDelta, 0, GAME_CONSTANTS.manaMax);
    if (p.mode === 'C' && p.replayGhost) {
      if (p.replayGhost.active && p.ghostEnergy <= 0) p.replayGhost.active = false;
    }

    p.inputHistory.push({ ...buf });
    if (p.inputHistory.length > MAX_INPUT_BUFFER) p.inputHistory.shift();
    p.positionHistory.push({ ...p.position });
    if (p.positionHistory.length > MAX_INPUT_BUFFER) p.positionHistory.shift();
  }

  resolveObstacles(p: Player) {
    this.obstacles.forEach((o) => {
      const cx = clamp(p.position.x, o.x, o.x + o.w);
      const cy = clamp(p.position.y, o.y, o.y + o.h);
      const dx = p.position.x - cx;
      const dy = p.position.y - cy;
      if (dx * dx + dy * dy < GAME_CONSTANTS.playerRadius * GAME_CONSTANTS.playerRadius) {
        const dist = Math.hypot(dx, dy) || 1;
        const push = GAME_CONSTANTS.playerRadius - dist + 0.5;
        p.position.x += (dx / dist) * push;
        p.position.y += (dy / dist) * push;
      }
    });
  }

  processButtons(p: Player, buttons: InputRecord['buttons'], dt: number) {
    const now = this.tickCount * (MS_PER_TICK / 1000);
    if (
      buttons.shield &&
      now - p.lastShieldRaise > GAME_CONSTANTS.shieldRaiseCd &&
      p.shieldBrokenUntil <= 0 &&
      p.shieldLockUntil <= 0
    ) {
      if (!p.shieldUp) {
        p.shieldDurability = GAME_CONSTANTS.shieldDurability;
        p.lastShieldRaise = now;
      }
      p.shieldUp = true;
    } else {
      p.shieldUp = false;
    }

    const dashPressed = buttons.dash && !p.prevButtons.dash;
    if (dashPressed && p.dashCooldown <= 0) {
      p.dashCooldown = GAME_CONSTANTS.dashCooldown;
      p.dashTimer = GAME_CONSTANTS.dashDuration;
    }

    const attackPressed = buttons.attack && !p.prevButtons.attack;
    if (attackPressed && p.attackCooldown <= 0) {
      if (p.charging) {
        // release charge
        p.attackCooldown = GAME_CONSTANTS.attackCooldown;
        const bonus = Math.min(p.chargeTime, GAME_CONSTANTS.superThreshold);
        const dashBoost = 20 * (bonus / GAME_CONSTANTS.superThreshold);
        p.position.x += Math.cos(p.aimAngle) * dashBoost;
        p.position.y += Math.sin(p.aimAngle) * dashBoost;
      } else {
        p.attackCooldown = GAME_CONSTANTS.attackCooldown;
      }
      this.registerAttack(p);
      p.charging = false;
      p.chargeTime = 0;
    }

    const ghostPressed = buttons.ghost && !p.prevButtons.ghost;
    if (ghostPressed) {
      this.triggerGhost(p);
    }

    p.prevButtons = { ...buttons };
  }

  triggerGhost(p: Player) {
    const ghost = this.getGhost(p);
    if (!ghost) return;
    if (p.mode === 'A') {
      if (p.inputHistory.length >= MAX_INPUT_BUFFER) {
        ghost.replayQueue = p.inputHistory.slice(-MAX_INPUT_BUFFER);
        ghost.replayIndex = 0;
        ghost.active = true;
        const rewindIndex = Math.max(0, p.positionHistory.length - MAX_INPUT_BUFFER);
        ghost.position = { ...(p.positionHistory[rewindIndex] || p.position) };
      }
    } else if (p.mode === 'C') {
      if (p.ghostEnergy > 0) ghost.active = !ghost.active;
    }
  }

  simulateGhosts(dt: number) {
    this.ghosts.forEach((g) => {
      if (!g.owner) return;
      if (g.owner.mode === 'B') {
        if (g.respawnTimer > 0) {
          g.respawnTimer = Math.max(0, g.respawnTimer - dt);
          if (g.respawnTimer === 0) {
            g.active = true;
          }
        }
        if (!g.active) return;
        // delay playback of owner history
        const buffer = g.owner.inputHistory;
        const delayedIndex = Math.max(0, buffer.length - Math.floor(GAME_CONSTANTS.ghostDelay * TICK_RATE));
        const input = buffer[delayedIndex];
        if (input) this.stepGhostWithInput(g, input, dt);
      } else if (g.owner.mode === 'C') {
        if (g.active && g.owner.ghostEnergy > 0) {
          const buffer = g.owner.inputHistory;
          const delayedIndex = Math.max(0, buffer.length - Math.floor(GAME_CONSTANTS.ghostDelay * TICK_RATE));
          const input = buffer[delayedIndex];
          if (input) this.stepGhostWithInput(g, input, dt);
        }
      } else if (g.owner.mode === 'A') {
        if (!g.active) return;
        const rec = g.replayQueue[g.replayIndex];
        if (rec) {
          this.stepGhostWithInput(g, rec, dt);
          g.replayIndex++;
          if (g.replayIndex >= g.replayQueue.length) g.active = false;
        }
      }
    });
  }

  stepGhostWithInput(g: Ghost, input: InputRecord, dt: number) {
    const dir = normalize({ x: input.moveX, y: input.moveY });
    const speed = GAME_CONSTANTS.moveSpeed * 0.9;
    g.velocity = { x: dir.x * speed, y: dir.y * speed };
    g.position.x += g.velocity.x * dt;
    g.position.y += g.velocity.y * dt;
  }

  registerAttack(attacker: Player) {
    const isSuper = attacker.chargeTime >= GAME_CONSTANTS.superThreshold;
    this.players.forEach((target) => {
      if (target === attacker || target.isDead) return;
      const inRange = distanceSq(attacker.position, target.position) <
        Math.pow(GAME_CONSTANTS.attackRange + GAME_CONSTANTS.chargeBonusRange * (attacker.chargeTime / GAME_CONSTANTS.superThreshold), 2);
      if (!inRange) return;
      const angleTo = Math.atan2(target.position.y - attacker.position.y, target.position.x - attacker.position.x);
      let diff = Math.abs(angleTo - attacker.aimAngle);
      if (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
      if (diff > GAME_CONSTANTS.attackArc) return;
      const shieldParryWindow = this.tickCount * (MS_PER_TICK / 1000) - target.lastShieldRaise;
      const parry = target.shieldUp && shieldParryWindow <= GAME_CONSTANTS.shieldParryWindow;
      const blocking = target.shieldUp && !parry && target.shieldDurability > 0 && !isSuper;
      if (parry) {
        attacker.shieldLockUntil = GAME_CONSTANTS.shieldLockAfterParry;
        attacker.attackCooldown = 0.2;
        this.broadcast({ type: 'event', event: 'parry', payload: { target: target.id, attacker: attacker.id }, version: PROTOCOL_VERSION });
        return;
      }
      if (blocking) {
        target.shieldDurability -= 1;
        if (target.shieldDurability <= 0) {
          target.shieldBrokenUntil = GAME_CONSTANTS.shieldBreakLock;
          this.broadcast({ type: 'event', event: 'shieldBreak', payload: { target: target.id }, version: PROTOCOL_VERSION });
        }
        return;
      }
      // kill
      this.handleKill(attacker, target);
    });
  }

  handleKill(attacker: Player, target: Player) {
    // clash check
    const sameTickAttackers = this.players.filter((p) => p !== attacker && p.attackCooldown === GAME_CONSTANTS.attackCooldown);
    const simultaneous = sameTickAttackers.some((p) => distanceSq(p.position, attacker.position) < GAME_CONSTANTS.attackRange * GAME_CONSTANTS.attackRange);
    if (simultaneous) {
      this.broadcast({ type: 'event', event: 'clash', version: PROTOCOL_VERSION });
      return;
    }
    target.isDead = true;
    if (target.mode === 'B') {
      const ghost = this.getGhost(target);
      if (ghost && ghost.active) {
        // possession
        target.isDead = false;
        target.position = { ...ghost.position };
        ghost.active = false;
      }
    }
    this.broadcast({ type: 'event', event: 'kill', payload: { attacker: attacker.id, victim: target.id }, version: PROTOCOL_VERSION });
    this.checkRoundEnd();
  }

  checkRoundEnd() {
    const alive = this.players.filter((p) => !p.isDead);
    if (alive.length <= 1) {
      const winner = alive[0];
      if (winner) {
        this.scores[winner.id] = (this.scores[winner.id] || 0) + 1;
      }
      this.broadcast({ type: 'event', event: 'roundEnd', payload: { scores: this.scores }, version: PROTOCOL_VERSION });
      if (winner && this.scores[winner.id] >= 2) {
        this.broadcast({ type: 'event', event: 'matchEnd', payload: { winner: winner.id }, version: PROTOCOL_VERSION });
        this.running = false;
      } else {
        this.startRound();
      }
    }
  }

  exportPlayers(): PlayerState[] {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      velocity: p.velocity,
      aimAngle: p.aimAngle,
      shieldUp: p.shieldUp,
      shieldDurability: p.shieldDurability,
      shieldBrokenUntil: p.shieldBrokenUntil,
      dashCooldown: p.dashCooldown,
      charging: p.charging,
      chargeTime: p.chargeTime,
      isDead: p.isDead,
      ghostEnergy: p.ghostEnergy,
      lastClientTickProcessed: p.lastClientTickProcessed,
    }));
  }

  exportGhosts(): GhostState[] {
    return this.ghosts.map((g) => ({
      id: g.id,
      ownerId: g.owner.id,
      position: g.position,
      velocity: g.velocity,
      active: g.active,
      alpha: g.alpha,
    }));
  }

  sendSnapshot() {
    const msg: SnapshotMessage = {
      type: 'snapshot',
      tick: this.tickCount,
      round: this.round,
      scores: this.scores,
      playersOrdered: this.playersOrdered,
      players: this.exportPlayers(),
      ghosts: this.exportGhosts(),
      projectiles: [],
      version: PROTOCOL_VERSION,
    };
    this.broadcast(msg);
  }
}

const rooms: Room[] = [];

function findOrCreateRoom(): Room {
  let room = rooms.find((r) => r.players.length < 2 && !r.running);
  if (!room) {
    room = new Room();
    rooms.push(room);
  }
  return room;
}

function handleClient(ws: WebSocket) {
  let player: Player | null = null;
  let room: Room | null = null;

  ws.on('message', (data: RawData) => {
    try {
      const msg = JSON.parse(data.toString()) as ClientMessage;
      if (msg.version !== PROTOCOL_VERSION) {
        ws.send(JSON.stringify({ type: 'error', reason: 'Protocol mismatch' }));
        ws.close();
        return;
      }
      switch (msg.type) {
        case 'hello':
          if (player) return;
          player = new Player((msg as ClientHelloMessage).name, ws);
          room = findOrCreateRoom();
          room.addPlayer(player);
          ws.send(JSON.stringify({ type: 'welcome', playerId: player.id, players: room.exportPlayers(), version: PROTOCOL_VERSION }));
          break;
        case 'setMode':
          if (!player) return;
          player.mode = (msg as ClientSetModeMessage).mode;
          break;
        case 'input':
          if (!player || !room) return;
          const imsg = msg as ClientInputMessage;
          const rec: InputRecord = {
            tick: imsg.tick,
            moveX: clamp(imsg.moveX, -1, 1),
            moveY: clamp(imsg.moveY, -1, 1),
            buttons: imsg.buttons,
            aimAngle: clamp(imsg.aimAngle, -Math.PI, Math.PI),
            charge: imsg.charge,
          };
          player.latestInput = rec;
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', ts: (msg as ClientPingMessage).ts, version: PROTOCOL_VERSION }));
          break;
      }
    } catch (err) {
      console.error('Bad message', err);
    }
  });

  ws.on('close', () => {
    if (room && player) {
      room.players = room.players.filter((p) => p !== player);
      room.ghosts = room.ghosts.filter((g) => g.owner !== player);
      if (room.players.length === 0) {
        const idx = rooms.indexOf(room);
        if (idx >= 0) rooms.splice(idx, 1);
      }
    }
  });
}

function main() {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', handleClient);

  server.listen(3000, () => {
    console.log('Server listening on 3000');
  });

  let last = Date.now();
  function loop() {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    rooms.forEach((r) => r.tick(dt));
    setTimeout(loop, MS_PER_TICK);
  }
  loop();
}

main();
