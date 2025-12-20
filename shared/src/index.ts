export const PROTOCOL_VERSION = 2;

export type Vector2 = { x: number; y: number };

export type InputButtons = {
  attack: boolean;
  shield: boolean;
  dash: boolean;
  ghost: boolean;
};

export type ClientInputMessage = {
  type: 'input';
  tick: number;
  aimAngle: number;
  moveX: number;
  moveY: number;
  buttons: InputButtons;
  charge: boolean;
  version: number;
};

export type ClientHelloMessage = {
  type: 'hello';
  name: string;
  version: number;
};

export type ClientSetModeMessage = {
  type: 'setMode';
  mode: GameMode;
  version: number;
};

export type ClientPingMessage = { type: 'ping'; ts: number; version: number };

export type ClientMessage =
  | ClientHelloMessage
  | ClientSetModeMessage
  | ClientInputMessage
  | ClientPingMessage;

export type PlayerState = {
  id: string;
  name: string;
  position: Vector2;
  velocity: Vector2;
  aimAngle: number;
  shieldUp: boolean;
  shieldDurability: number;
  shieldBrokenUntil: number;
  dashCooldown: number;
  charging: boolean;
  chargeTime: number;
  isDead: boolean;
  ghostEnergy: number;
  lastClientTickProcessed?: number;
};

export type GhostState = {
  id: string;
  ownerId: string;
  position: Vector2;
  velocity: Vector2;
  active: boolean;
  alpha: number;
};

export type Obstacle = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type RoundState = {
  round: number;
  scores: Record<string, number>;
};

export type SnapshotMessage = {
  type: 'snapshot';
  tick: number;
  round: number;
  scores: Record<string, number>;
  playersOrdered?: string[];
  players: PlayerState[];
  ghosts: GhostState[];
  projectiles: never[];
  version: number;
};

export type EventMessage = {
  type: 'event';
  event: 'parry' | 'shieldBreak' | 'clash' | 'kill' | 'roundEnd' | 'matchEnd';
  payload?: any;
  version: number;
};

export type WelcomeMessage = {
  type: 'welcome';
  playerId: string;
  players: PlayerState[];
  version: number;
};

export type RoundStartMessage = {
  type: 'roundStart';
  round: number;
  seed: number;
  obstacles: Obstacle[];
  spawns: Vector2[];
  version: number;
};

export type MatchStartMessage = {
  type: 'matchStart';
  players: PlayerState[];
  version: number;
};

export type PongMessage = { type: 'pong'; ts: number; version: number };

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | EventMessage
  | RoundStartMessage
  | MatchStartMessage
  | PongMessage;

export type GameMode = 'A' | 'B' | 'C';

export const GAME_CONSTANTS = {
  tickRate: 60,
  snapshotRate: 20,
  moveSpeed: 260,
  chargeSlow: 0.55,
  playerRadius: 18,
  dashSpeed: 780,
  dashCooldown: 1.4,
  dashDuration: 0.13,
  attackCooldown: 0.35,
  attackRange: 60,
  attackArc: Math.PI / 3,
  chargeBonusRange: 35,
  superThreshold: 2.0,
  shieldDurability: 3,
  shieldRaiseCd: 0.45,
  shieldParryWindow: 0.18,
  shieldBreakLock: 1.0,
  shieldLockAfterParry: 1.5,
  ghostDelay: 5,
  manaMax: 8,
  manaDrain: 1,
  manaRegen: 0.5,
  ghostRespawn: 5,
};

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function distanceSq(a: Vector2, b: Vector2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function normalize(v: Vector2): Vector2 {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

export type InputRecord = {
  tick: number;
  moveX: number;
  moveY: number;
  buttons: InputButtons;
  aimAngle: number;
  charge: boolean;
};

export type ReplayFrame = InputRecord & { dt: number };

