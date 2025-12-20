export const PROTOCOL_VERSION = 1;

export enum GameMode {
  LoopEcho = "A",
  LagShadow = "B",
  ManaShadow = "C",
}

export interface Vector2 {
  x: number;
  y: number;
}

export interface ObstacleRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface RoundMap {
  seed: number;
  obstacles: ObstacleRect[];
  spawns: Vector2[];
}

export interface ShieldState {
  durability: number;
  raised: boolean;
  breakTimer: number;
  parryWindow: number;
  cooldown: number;
  lockout: number;
}

export interface DashState {
  cooldown: number;
  active: boolean;
  timer: number;
}

export interface ChargeState {
  charging: boolean;
  chargeTime: number;
  superReady: boolean;
}

export interface ManaState {
  mana: number;
  maxMana: number;
  draining: boolean;
}

export interface PlayerState {
  id: string;
  name: string;
  position: Vector2;
  velocity: Vector2;
  facing: number;
  alive: boolean;
  score: number;
  shield: ShieldState;
  dash: DashState;
  charge: ChargeState;
  mode: GameMode;
  ghostActive: boolean;
  ghostPossessed: boolean;
  mana?: ManaState;
}

export interface GhostState {
  id: string;
  ownerId: string;
  position: Vector2;
  velocity: Vector2;
  facing: number;
  alive: boolean;
}

export interface SnapshotMessage {
  type: "snapshot";
  tick: number;
  players: PlayerState[];
  ghosts: GhostState[];
}

export interface EventMessage {
  type: "event";
  event: "parry" | "shieldBreak" | "clash" | "kill";
  sourceId?: string;
  targetId?: string;
}

export interface WelcomeMessage {
  type: "welcome";
  playerId: string;
  mode: GameMode;
  state: MatchState;
}

export interface MatchState {
  matchStarted: boolean;
  round: number;
  bestOf: number;
  map?: RoundMap;
  score: Record<string, number>;
}

export interface MatchStartMessage {
  type: "matchStart";
  state: MatchState;
}

export interface RoundStartMessage {
  type: "roundStart";
  map: RoundMap;
  state: MatchState;
}

export interface RoundEndMessage {
  type: "roundEnd";
  winnerId: string;
  state: MatchState;
}

export interface MatchEndMessage {
  type: "matchEnd";
  winnerId: string;
  state: MatchState;
}

export interface PongMessage {
  type: "pong";
  time: number;
}

export type ServerMessage =
  | SnapshotMessage
  | EventMessage
  | WelcomeMessage
  | MatchStartMessage
  | RoundStartMessage
  | RoundEndMessage
  | MatchEndMessage
  | PongMessage;

export interface InputButtons {
  moveX: number;
  moveY: number;
  aim: number;
  attack: boolean;
  shield: boolean;
  dash: boolean;
  ghost: boolean;
  toggleGhost?: boolean;
  charge: boolean;
}

export interface HelloMessage {
  type: "hello";
  name: string;
  version: number;
}

export interface SetModeMessage {
  type: "setMode";
  mode: GameMode;
}

export interface InputMessage {
  type: "input";
  tick: number;
  input: InputButtons;
}

export interface PingMessage {
  type: "ping";
  time: number;
}

export type ClientMessage = HelloMessage | SetModeMessage | InputMessage | PingMessage;

export const SERVER_TICK_RATE = 60;
export const SNAPSHOT_RATE = 20;
export const PLAYER_RADIUS = 18;
export const WORLD_RADIUS = 800;
export const BASE_MOVE_SPEED = 220;
export const DASH_SPEED = 520;
export const DASH_DURATION = 0.18;
export const DASH_COOLDOWN = 1.4;
export const SHIELD_DURABILITY = 3;
export const SHIELD_COOLDOWN = 0.45;
export const SHIELD_BREAK_LOCKOUT = 1.0;
export const SHIELD_PARRY_WINDOW = 0.18;
export const SHIELD_RECOVERY_TIME = 0.7;
export const CHARGE_SUPER_THRESHOLD = 2.0;
export const MAX_CHARGE = 2.5;
export const CHARGE_SLOW = 0.45;
export const INPUT_HISTORY_SECONDS = 5;
export const GHOST_RESPAWN = 5;
export const MANA_MAX = 6;
export const MANA_DRAIN = 1;
export const MANA_REGEN = 0.35;

export interface RingBufferItem<T> {
  tick: number;
  data: T;
}

export interface InputFrame extends InputButtons {
  time: number;
}
