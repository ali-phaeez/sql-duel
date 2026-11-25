// Shared constants and message types for SQL Duel.
// Types only plus constants: no runtime imports, so tests, the Worker and the DO can all use it.

import type { DifficultyFilter, PublicPuzzle } from './puzzles.ts';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const NAME_MAX = 12;

export const ROUND_MS = 90_000;
export const ROUND_END_MS = 15_000;
export const SUBMIT_GAP_MS = 2_000;
export const LOBBY_PRUNE_MS = 60_000;
export const IDLE_MS = 3_600_000;
export const MAX_MESSAGE_BYTES = 16_384;

/** Points for the 1st, 2nd and every later correct answer in a round. */
export const PLACE_POINTS: readonly number[] = [5, 3, 1];
/** Extra point for the shortest correct query of a round (ties all get it). */
export const SHORTEST_BONUS = 1;

export type RoundCount = 5 | 8 | 12;
export const ROUND_COUNTS: readonly RoundCount[] = [5, 8, 12];

export type Phase = 'lobby' | 'round' | 'round_end' | 'game_end';

export interface Settings {
  rounds: RoundCount;
  difficulty: DifficultyFilter;
}

export interface Player {
  id: string;
  secret: string; // never leaves the server except in the owner's own `welcome`
  name: string;
  joinedAt: number;
  connected: boolean;
  lastSeen: number;
  score: number;
}

/** One player's tries in the current round. */
export interface Attempt {
  wrong: number;
  lastSubmitAt: number;
  solvedAt: number | null;
  query: string | null; // the correct query, trimmed
  length: number | null; // queryLength(query)
  points: number; // place points
  bonus: number; // shortest-query bonus, set when the round ends
}

export interface RoomState {
  code: string;
  createdAt: number;
  seq: number;
  phase: Phase;
  hostId: string | null;
  players: Player[];
  settings: Settings;
  puzzleIds: string[];
  roundIndex: number; // 0-based, -1 before the first round
  roundStartedAt: number | null;
  phaseEndsAt: number | null; // round: deadline · round_end: next round
  attempts: Record<string, Attempt>;
  recent: string[]; // puzzle ids of earlier games in this room, used last when picking
  idleSince: number | null; // set when the last socket leaves
}

export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  score: number;
}

export interface Solve {
  playerId: string;
  ms: number; // time from round start
  points: number;
}

export interface RoundView {
  index: number; // 0-based
  total: number;
  puzzle: PublicPuzzle;
  startedAt: number;
  endsAt: number | null;
  solved: Solve[]; // in solve order; never includes queries while the round runs
}

export interface ResultRow {
  playerId: string;
  name: string;
  solved: boolean;
  ms: number | null;
  query: string | null;
  length: number | null;
  wrong: number;
  points: number;
  bonus: number;
}

export interface RankEntry {
  id: string;
  name: string;
  score: number;
  rank: number;
}

export interface MyRound {
  solved: boolean;
  query: string | null;
  wrong: number;
  points: number;
}

export interface Snapshot {
  code: string;
  phase: Phase;
  hostId: string | null;
  players: PublicPlayer[];
  settings: Settings;
  round: RoundView | null;
  results: ResultRow[] | null; // round_end and game_end only
  nextAt: number | null; // round_end: when the next round (or the final screen) starts
  ranking: RankEntry[] | null; // game_end only
  me: MyRound | null;
  seq: number;
}

export type ErrorCode =
  | 'room_full'
  | 'bad_name'
  | 'not_found'
  | 'not_host'
  | 'not_allowed'
  | 'too_fast'
  | 'kicked_duplicate'
  | 'bad_message';

export type ClientMsg =
  | { type: 'submit'; query: string; round: number }
  | { type: 'start' }
  | { type: 'settings'; rounds?: RoundCount; difficulty?: DifficultyFilter }
  | { type: 'next' }
  | { type: 'playAgain' }
  | { type: 'leave' }
  | { type: 'ping'; t: number };

export interface Verdict {
  round: number;
  ok: boolean;
  reason: string;
  points: number;
  wrong: number;
}

export type ServerEvent =
  | { type: 'welcome'; playerId: string; secret: string; state: Snapshot }
  | { type: 'state'; state: Snapshot }
  | ({ type: 'verdict' } & Verdict)
  | { type: 'pong'; t: number }
  | { type: 'error'; code: ErrorCode; message: string };

export type ServerMsg = ServerEvent & { serverNow: number };
