import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { performance } from "perf_hooks";

const LCG_MOD = 2147483647;
const LCG_SEED_ADJUST = 2147483646;
const LCG_MULT = 16807;
const GHOST_DELAY_TOLERANCE = 0.02;
import {
  BASE_MOVE_SPEED,
  CHARGE_SLOW,
  CHARGE_SUPER_THRESHOLD,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_SPEED,
  GameMode,
  GHOST_RESPAWN,
  INPUT_HISTORY_SECONDS,
  InputButtons,
  MAX_CHARGE,
  MANA_DRAIN,
  MANA_MAX,
  MANA_REGEN,
  MatchState,
  ObstacleRect,
  PLAYER_RADIUS,
  PROTOCOL_VERSION,
  RoundMap,
  SHIELD_BREAK_LOCKOUT,
  SHIELD_COOLDOWN,
  SHIELD_DURABILITY,
  SHIELD_PARRY_WINDOW,
  SHIELD_RECOVERY_TIME,
  SNAPSHOT_RATE,
  SERVER_TICK_RATE,
  ServerMessage,
  Vector2,
  ClientMessage,
  PlayerState,
  GhostState,
} from "@slime-sync/shared";

interface ClientSession {
  id: string;
  ws: WebSocket;
  name: string;
  mode: GameMode;
  input: InputButtons;
  lastInputTick: number;
  state: PlayerState;
  inputHistory: { time: number; position: Vector2; input: InputButtons }[];
  ghost?: GhostInstance;
  ghostCooldown: number;
  isReady: boolean;
  attackThisTick: AttackInfo | null;
}

interface AttackInfo {
  attacker: ClientSession | GhostInstance;
  angle: number;
  superAttack: boolean;
  range: number;
}

interface GhostInstance {
  id: string;
  ownerId: string;
  state: GhostState;
  playback?: { time: number; input: InputButtons; position: Vector2 }[];
  playbackIndex: number;
  mode: GameMode;
  respawnTimer: number;
  persistent: boolean;
  lastInput?: InputButtons;
}

class GameServer {
  private server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200);
    res.end("Slash Ghost server");
  });

  private wss = new WebSocketServer({ server: this.server, path: "/ws" });
  private sessions: Map<string, ClientSession> = new Map();
  private tickInterval?: NodeJS.Timeout;
  private snapshotInterval?: NodeJS.Timeout;
  private tick: number = 0;
  private matchState: MatchState = {
    matchStarted: false,
    round: 0,
    bestOf: 3,
    score: {},
  };
  private currentMap?: RoundMap;

  start(port = Number(process.env.PORT) || 3000) {
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.server.listen(port, "0.0.0.0", () => {
      console.log(`[server] listening on port ${port} (0.0.0.0)`);
    });
    const tickMs = 1000 / SERVER_TICK_RATE;
    this.tickInterval = setInterval(() => this.update(tickMs / 1000), tickMs);
    const snapshotMs = 1000 / SNAPSHOT_RATE;
    this.snapshotInterval = setInterval(() => this.broadcastSnapshot(), snapshotMs);
  }

  private handleConnection(ws: WebSocket) {
    const sessionId = uuid();
    const defaultInput: InputButtons = {
      moveX: 0,
      moveY: 0,
      aim: 0,
      attack: false,
      shield: false,
      dash: false,
      ghost: false,
      toggleGhost: false,
      charge: false,
    };
    const state: PlayerState = {
      id: sessionId,
      name: "Player",
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      facing: 0,
      alive: true,
      score: 0,
      shield: {
        durability: SHIELD_DURABILITY,
        raised: false,
        breakTimer: 0,
        parryWindow: 0,
        cooldown: 0,
        lockout: 0,
      },
      dash: { cooldown: 0, active: false, timer: 0 },
      charge: { charging: false, chargeTime: 0, superReady: false },
      mode: GameMode.LoopEcho,
      ghostActive: false,
      ghostPossessed: false,
      mana: { mana: MANA_MAX, maxMana: MANA_MAX, draining: false },
    };
    const session: ClientSession = {
      id: sessionId,
      ws,
      name: "Player",
      mode: GameMode.LoopEcho,
      input: defaultInput,
      lastInputTick: 0,
      state,
      ghostCooldown: 0,
      ghost: undefined,
      inputHistory: [],
      isReady: false,
      attackThisTick: null,
    };
    this.sessions.set(sessionId, session);

    ws.on("message", (data) => this.handleMessage(session, data.toString()));
    ws.on("close", () => this.handleClose(session));
    ws.send(JSON.stringify(<ServerMessage>{
      type: "welcome",
      playerId: sessionId,
      mode: session.mode,
      state: this.matchState,
    }));
  }

  private handleMessage(session: ClientSession, raw: string) {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    switch (parsed.type) {
      case "hello":
        if (parsed.version !== PROTOCOL_VERSION) {
          session.ws.close(1002, "Protocol mismatch");
          return;
        }
        session.name = parsed.name || "Player";
        session.state.name = session.name;
        session.isReady = true;
        this.tryStartMatch();
        break;
      case "setMode":
        session.mode = parsed.mode;
        session.state.mode = parsed.mode;
        break;
      case "input":
        session.input = parsed.input;
        session.state.facing = parsed.input.aim;
        session.lastInputTick = parsed.tick;
        break;
      case "ping":
        session.ws.send(JSON.stringify(<ServerMessage>{ type: "pong", time: parsed.time }));
        break;
    }
  }

  private handleClose(session: ClientSession) {
    this.sessions.delete(session.id);
    if (this.sessions.size < 2) {
      this.matchState.matchStarted = false;
    }
  }

  private tryStartMatch() {
    if (this.matchState.matchStarted) return;
    if ([...this.sessions.values()].filter((s) => s.isReady).length >= 2) {
      this.matchState.matchStarted = true;
      this.matchState.round = 0;
      this.matchState.score = {};
      console.log("[match] starting match");
      this.broadcast(<ServerMessage>{ type: "matchStart", state: this.matchState });
      this.startRound();
    }
  }

  private startRound() {
    this.matchState.round += 1;
    this.currentMap = this.generateMap(Date.now());
    let spawnIdx = 0;
    for (const session of this.sessions.values()) {
      session.state.position = this.currentMap.spawns[spawnIdx % this.currentMap.spawns.length];
      session.state.velocity = { x: 0, y: 0 };
      session.state.alive = true;
      session.state.shield = {
        durability: SHIELD_DURABILITY,
        raised: false,
        breakTimer: 0,
        parryWindow: 0,
        cooldown: 0,
        lockout: 0,
      };
      session.state.dash = { cooldown: 0, active: false, timer: 0 };
      session.state.charge = { charging: false, chargeTime: 0, superReady: false };
      session.state.ghostActive = false;
      session.state.ghostPossessed = false;
      session.state.mana = { mana: MANA_MAX, maxMana: MANA_MAX, draining: false };
      session.attackThisTick = null;
      session.ghost = undefined;
      session.ghostCooldown = 0;
      session.inputHistory = [];
      spawnIdx++;
    }
    this.broadcast(<ServerMessage>{
      type: "roundStart",
      map: this.currentMap,
      state: this.matchState,
    });
  }

  private generateMap(seed: number): RoundMap {
    const obstacles: ObstacleRect[] = [];
    const rng = this.makeRng(seed);
    const radius = 400;
    for (let i = 0; i < 6; i++) {
      const angle = rng() * Math.PI * 2;
      const r = 80 + rng() * (radius - 150);
      const width = 60 + rng() * 80;
      const height = 60 + rng() * 80;
      obstacles.push({
        id: `o${i}`,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        width,
        height,
        rotation: rng() * Math.PI,
      });
    }
    const spawns: Vector2[] = [
      { x: -radius / 2, y: 0 },
      { x: radius / 2, y: 0 },
    ];
    return { seed, obstacles, spawns };
  }

  private makeRng(seed: number) {
    let s = seed % LCG_MOD;
    if (s <= 0) s += LCG_SEED_ADJUST;
    return () => (s = (s * LCG_MULT) % LCG_MOD) / LCG_MOD;
  }

  private update(dt: number) {
    this.tick++;
    this.updatePlayers(dt);
    this.resolveAttacks();
    this.updateGhosts(dt);
  }

  private updatePlayers(dt: number) {
    for (const session of this.sessions.values()) {
      const { state, input } = session;
      // Record history for ghost features
      session.inputHistory.push({
        time: performance.now() / 1000,
        position: { ...state.position },
        input: { ...input },
      });
      const maxHistory = INPUT_HISTORY_SECONDS * SERVER_TICK_RATE;
      if (session.inputHistory.length > maxHistory) {
        session.inputHistory.shift();
      }

      // Timers
      state.shield.parryWindow = Math.max(0, state.shield.parryWindow - dt);
      state.shield.cooldown = Math.max(0, state.shield.cooldown - dt);
      state.shield.lockout = Math.max(0, state.shield.lockout - dt);
      state.dash.cooldown = Math.max(0, state.dash.cooldown - dt);
      if (state.dash.active) {
        state.dash.timer -= dt;
        if (state.dash.timer <= 0) state.dash.active = false;
      }

      // Mana handling (Mode C)
      if (state.mode === GameMode.ManaShadow && state.mana) {
        if (state.ghostActive) {
          state.mana.mana = Math.max(0, state.mana.mana - MANA_DRAIN * dt);
          state.mana.draining = true;
          if (state.mana.mana <= 0) {
            state.ghostActive = false;
            state.mana.draining = false;
          }
        } else {
          state.mana.mana = Math.min(state.mana.maxMana, state.mana.mana + MANA_REGEN * dt);
          state.mana.draining = false;
        }
      }

      // Shield raise/lower
      if (input.shield && state.shield.lockout <= 0 && state.shield.cooldown <= 0) {
        if (!state.shield.raised) {
          state.shield.parryWindow = SHIELD_PARRY_WINDOW;
        }
        state.shield.raised = true;
      } else {
        if (state.shield.raised) {
          state.shield.cooldown = SHIELD_COOLDOWN;
        }
        state.shield.raised = false;
        if (state.shield.cooldown <= SHIELD_COOLDOWN - SHIELD_RECOVERY_TIME) {
          state.shield.durability = SHIELD_DURABILITY;
        }
      }

      // Movement
      const moveMag = Math.hypot(input.moveX, input.moveY);
      let speed = BASE_MOVE_SPEED;
      if (state.charge.charging) speed *= CHARGE_SLOW;
      if (state.dash.active) speed = DASH_SPEED;
      if (moveMag > 0.01) {
        state.velocity.x = (input.moveX / moveMag) * speed;
        state.velocity.y = (input.moveY / moveMag) * speed;
      } else {
        state.velocity.x = 0;
        state.velocity.y = 0;
      }
      state.position.x += state.velocity.x * dt;
      state.position.y += state.velocity.y * dt;

      // Dash trigger
      if (input.dash && state.dash.cooldown <= 0 && !state.dash.active) {
        state.dash.active = true;
        state.dash.timer = DASH_DURATION;
        state.dash.cooldown = DASH_COOLDOWN;
      }

      // Charge + Attack
      const wasCharging = state.charge.charging;
      if (input.charge) {
        state.charge.charging = true;
        state.charge.chargeTime = Math.min(MAX_CHARGE, state.charge.chargeTime + dt);
        state.charge.superReady = state.charge.chargeTime >= CHARGE_SUPER_THRESHOLD;
      } else {
        state.charge.charging = false;
      }
      const attackTriggered = input.attack && !session.attackThisTick;
      if (attackTriggered) {
        const attackInfo: AttackInfo = {
          attacker: session,
          angle: input.aim,
          superAttack: wasCharging && state.charge.chargeTime >= CHARGE_SUPER_THRESHOLD,
          range: 70 + state.charge.chargeTime * 40,
        };
        session.attackThisTick = attackInfo;
        state.charge.chargeTime = 0;
        state.charge.superReady = false;
      } else {
        session.attackThisTick = null;
      }

      // Ghost mechanics
      this.handleGhostControls(session);
    }
  }

  private handleGhostControls(session: ClientSession) {
    const now = performance.now() / 1000;
    const input = session.input;
    const targetTime = now - INPUT_HISTORY_SECONDS;

    if (session.state.mode === GameMode.LoopEcho && input.ghost) {
      if (!session.ghost && session.inputHistory.length > 10) {
        const playback = session.inputHistory.filter((f) => f.time >= targetTime);
        const start = playback[0] ?? session.inputHistory[0];
        session.ghost = {
          id: `g-${session.id}`,
          ownerId: session.id,
          state: {
            id: `g-${session.id}`,
            ownerId: session.id,
            position: { ...start.position },
            velocity: { x: 0, y: 0 },
            facing: start.input.aim,
            alive: true,
          },
          playback,
          playbackIndex: 0,
          mode: session.state.mode,
          respawnTimer: 0,
          persistent: false,
        };
        session.state.ghostActive = true;
      }
    }

    if (session.state.mode === GameMode.LagShadow) {
      if (!session.ghost && session.ghostCooldown <= 0) {
        session.ghost = this.spawnDelayedGhost(session, targetTime, true);
        session.state.ghostActive = !!session.ghost;
      }
    }

    if (session.state.mode === GameMode.ManaShadow) {
      if (input.toggleGhost && !session.state.ghostActive) {
        session.state.ghostActive = true;
      } else if (input.toggleGhost && session.state.ghostActive) {
        session.state.ghostActive = false;
      }
      if (session.state.ghostActive && !session.ghost && session.state.mana?.mana) {
        session.ghost = this.spawnDelayedGhost(session, targetTime, true);
      }
      if (!session.state.ghostActive && session.ghost) {
        session.ghost = undefined;
      }
    }
  }

  private spawnDelayedGhost(session: ClientSession, targetTime: number, persistent: boolean): GhostInstance | undefined {
    if (!session.inputHistory.length) return;
    const playback = session.inputHistory.filter((f) => f.time >= targetTime);
    const start = playback[0] ?? session.inputHistory[0];
    return {
      id: `g-${session.id}`,
      ownerId: session.id,
      state: {
        id: `g-${session.id}`,
        ownerId: session.id,
        position: { ...start.position },
        velocity: { x: 0, y: 0 },
        facing: start.input.aim,
        alive: true,
      },
      playback,
      playbackIndex: 0,
      mode: session.state.mode,
      respawnTimer: 0,
      persistent,
    };
  }

  private updateGhosts(dt: number) {
    for (const session of this.sessions.values()) {
      const ghost = session.ghost;
      if (!ghost) continue;
      if (!ghost.state.alive) {
        ghost.respawnTimer += dt;
        if (ghost.persistent && ghost.respawnTimer >= GHOST_RESPAWN) {
          ghost.respawnTimer = 0;
          ghost.state.alive = true;
        }
        continue;
      }
      const now = performance.now() / 1000;
      const targetTime = now - INPUT_HISTORY_SECONDS;
      if (ghost.playback && ghost.playbackIndex < ghost.playback.length) {
        const frame = ghost.playback[ghost.playbackIndex];
        if (frame.time <= now) {
          ghost.state.position = { ...frame.position };
          ghost.state.facing = frame.input.aim;
          ghost.lastInput = frame.input;
          ghost.playbackIndex++;
        }
      } else if (ghost.persistent) {
        // Follow delayed inputs
        const frame = session.inputHistory.find((f) => Math.abs(f.time - targetTime) < GHOST_DELAY_TOLERANCE);
        if (frame) {
          ghost.state.position = { ...frame.position };
          ghost.state.facing = frame.input.aim;
          ghost.lastInput = frame.input;
        }
      }

      // If owner dies and ghost alive -> possession (Mode B rule)
      if (session.state.mode === GameMode.LagShadow && !session.state.alive && ghost.state.alive) {
        session.state.position = { ...ghost.state.position };
        session.state.alive = true;
        ghost.state.alive = false;
        session.state.ghostPossessed = true;
      }
    }
  }

  private resolveAttacks() {
    const attacks: AttackInfo[] = [];
    for (const session of this.sessions.values()) {
      if (session.attackThisTick) attacks.push(session.attackThisTick);
    }

    // Ghosts do damage like players when active playback frame indicates attack flag
    for (const session of this.sessions.values()) {
      if (session.ghost && session.ghost.state.alive && session.ghost.lastInput?.attack) {
        const ghostAttack: AttackInfo = {
          attacker: session.ghost,
          angle: session.ghost.state.facing,
          superAttack: false,
          range: 60,
        };
        attacks.push(ghostAttack);
      }
    }

    if (!attacks.length) return;

    // Clash detection
    if (attacks.length === 2) {
      const a = attacks[0];
      const b = attacks[1];
      const attackerPos = this.getAttackerPosition(a.attacker);
      const targetPos = this.getAttackerPosition(b.attacker);
      if (attackerPos && targetPos && this.distance(attackerPos, targetPos) < PLAYER_RADIUS * 2 + 10) {
        this.broadcast(<ServerMessage>{ type: "event", event: "clash" });
        return;
      }
    }

    for (const atk of attacks) {
      for (const session of this.sessions.values()) {
        if (!session.state.alive) continue;
        const isOwner = atk.attacker instanceof Object && "id" in atk.attacker ? (atk.attacker as any).id === session.id : false;
        if (atk.attacker instanceof Object && "ownerId" in atk.attacker && (atk.attacker as GhostInstance).ownerId === session.id) {
          continue; // ghost won't hurt owner
        }
        if ((atk.attacker as ClientSession).id === session.id) continue;
        const attackerPos = this.getAttackerPosition(atk.attacker);
        if (!attackerPos) continue;
        const toTarget = {
          x: session.state.position.x - attackerPos.x,
          y: session.state.position.y - attackerPos.y,
        };
        const dist = Math.hypot(toTarget.x, toTarget.y);
        if (dist > atk.range) continue;
        // Shield check
        if (session.state.shield.raised && session.state.shield.lockout <= 0) {
          if (session.state.shield.parryWindow > 0) {
            // Parry
            session.state.shield.parryWindow = 0;
            session.state.shield.cooldown = SHIELD_COOLDOWN;
            session.state.shield.raised = false;
            this.broadcast(<ServerMessage>{ type: "event", event: "parry", sourceId: session.id, targetId: this.getAttackerId(atk.attacker) });
            this.applyShieldLock(atk.attacker);
            continue;
          }
          if (!atk.superAttack) {
            session.state.shield.durability -= 1;
            if (session.state.shield.durability <= 0) {
              session.state.shield.lockout = SHIELD_BREAK_LOCKOUT;
              session.state.shield.raised = false;
              this.broadcast(<ServerMessage>{ type: "event", event: "shieldBreak", targetId: session.id });
            }
            continue;
          }
        }
        // Kill
        session.state.alive = false;
        this.broadcast(<ServerMessage>{ type: "event", event: "kill", sourceId: this.getAttackerId(atk.attacker), targetId: session.id });
        this.checkRoundEnd();
      }
    }
  }

  private applyShieldLock(attacker: ClientSession | GhostInstance) {
    if (this.isGhost(attacker)) {
      const owner = this.sessions.get(attacker.ownerId);
      if (owner) owner.state.shield.lockout = SHIELD_BREAK_LOCKOUT;
      return;
    }
    attacker.state.shield.lockout = SHIELD_BREAK_LOCKOUT;
  }

  private isGhost(attacker: ClientSession | GhostInstance): attacker is GhostInstance {
    return (attacker as GhostInstance).ownerId !== undefined;
  }

  private getAttackerPosition(attacker: ClientSession | GhostInstance): Vector2 | undefined {
    return this.isGhost(attacker) ? attacker.state.position : attacker.state.position;
  }

  private getAttackerId(attacker: ClientSession | GhostInstance): string {
    return this.isGhost(attacker) ? attacker.state.id : attacker.id;
  }

  private checkRoundEnd() {
    const alivePlayers = [...this.sessions.values()].filter((s) => s.state.alive);
    if (alivePlayers.length <= 1 && this.matchState.matchStarted) {
      const winner = alivePlayers[0];
      if (winner) {
        this.matchState.score[winner.id] = (this.matchState.score[winner.id] || 0) + 1;
      }
      this.broadcast(<ServerMessage>{
        type: "roundEnd",
        winnerId: winner?.id || "",
        state: this.matchState,
      });
      const needed = Math.floor(this.matchState.bestOf / 2) + 1;
      const leaderScore = winner ? this.matchState.score[winner.id] || 0 : 0;
      if (leaderScore >= needed) {
        this.broadcast(<ServerMessage>{
          type: "matchEnd",
          winnerId: winner?.id || "",
          state: this.matchState,
        });
        this.matchState.matchStarted = false;
      } else {
        setTimeout(() => this.startRound(), 1000);
      }
    }
  }

  private broadcastSnapshot() {
    const msg: ServerMessage = {
      type: "snapshot",
      tick: this.tick,
      players: [...this.sessions.values()].map((s) => s.state),
      ghosts: [...this.sessions.values()]
        .map((s) => s.ghost?.state)
        .filter((g): g is GhostState => !!g),
    };
    this.broadcast(msg);
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const s of this.sessions.values()) {
      if (s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(data);
      }
    }
  }

  private distance(a: Vector2, b: Vector2) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}

const gameServer = new GameServer();
gameServer.start(3000);
