// SQL Duel room rules as pure functions over RoomState. No I/O and no clocks: callers pass `now`.
// The Durable Object (src/room.ts) is a thin shell: advance(state, now) -> apply a command -> persist + broadcast.

import { pickPuzzles, publicPuzzle } from './puzzles.ts';
import type { DifficultyFilter, Puzzle } from './puzzles.ts';
import { DIFFICULTY_FILTERS } from './puzzles.ts';
import {
  IDLE_MS, LOBBY_PRUNE_MS, MAX_PLAYERS, NAME_MAX, PLACE_POINTS, ROUND_COUNTS, ROUND_END_MS, ROUND_MS,
  SHORTEST_BONUS, SUBMIT_GAP_MS,
} from './protocol.ts';
import type {
  Attempt, ErrorCode, MyRound, Player, PublicPlayer, RankEntry, ResultRow, RoomState, RoundCount, Snapshot, Verdict,
} from './protocol.ts';
import { MAX_QUERY_LENGTH, queryLength, resultsMatch, runQuery, SqlError } from './sql/index.ts';

export type Rng = () => number;
export type PuzzleBook = ReadonlyMap<string, Puzzle>;

export function bookOf(puzzles: readonly Puzzle[]): PuzzleBook {
  return new Map(puzzles.map((p) => [p.id, p]));
}

// ---- room and players ----

export function newRoom(code: string, now: number): RoomState {
  return {
    code,
    createdAt: now,
    seq: 0,
    phase: 'lobby',
    hostId: null,
    players: [],
    settings: { rounds: 5, difficulty: 'mixed' },
    puzzleIds: [],
    roundIndex: -1,
    roundStartedAt: null,
    phaseEndsAt: null,
    attempts: {},
    recent: [],
    idleSince: null,
  };
}

export function sanitizeName(raw: string): string | null {
  const s = raw
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return s.length ? s : null;
}

/** "Ann" -> "Ann 2" when "Ann" is taken (case-insensitive), staying within NAME_MAX. */
export function dedupeName(name: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`;
    const candidate = name.slice(0, NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return `${name.slice(0, NAME_MAX - 3)} 99`;
}

export function addPlayer(state: RoomState, init: { id: string; secret: string; name: string; now: number }): Player {
  const p: Player = {
    id: init.id,
    secret: init.secret,
    name: init.name,
    joinedAt: init.now,
    connected: true,
    lastSeen: init.now,
    score: 0,
  };
  state.players.push(p);
  if (!state.hostId) state.hostId = p.id;
  return p;
}

export function removePlayer(state: RoomState, id: string): boolean {
  const before = state.players.length;
  state.players = state.players.filter((p) => p.id !== id);
  delete state.attempts[id];
  return state.players.length !== before;
}

export function isFull(state: RoomState): boolean {
  return state.players.length >= MAX_PLAYERS;
}

export function connectedPlayers(state: RoomState): Player[] {
  return state.players.filter((p) => p.connected);
}

/** Host stays while connected; otherwise it passes to the longest-connected player. */
export function ensureHost(state: RoomState): boolean {
  const host = state.players.find((p) => p.id === state.hostId);
  if (host && host.connected) return false;
  const candidates = connectedPlayers(state).sort((a, b) => a.joinedAt - b.joinedAt);
  const next = candidates[0]?.id ?? host?.id ?? state.players[0]?.id ?? null;
  if (next === state.hostId) return false;
  state.hostId = next;
  return true;
}

// ---- settings ----

export function applySettings(state: RoomState, rounds: unknown, difficulty: unknown): boolean {
  let changed = false;
  if (typeof rounds === 'number' && (ROUND_COUNTS as readonly number[]).includes(rounds) && rounds !== state.settings.rounds) {
    state.settings.rounds = rounds as RoundCount;
    changed = true;
  }
  if (typeof difficulty === 'string' && (DIFFICULTY_FILTERS as readonly string[]).includes(difficulty) && difficulty !== state.settings.difficulty) {
    state.settings.difficulty = difficulty as DifficultyFilter;
    changed = true;
  }
  return changed;
}

// ---- game flow ----

export function startGame(state: RoomState, now: number, book: PuzzleBook, rng: Rng): void {
  state.puzzleIds = pickPuzzles([...book.values()], state.settings.difficulty, state.settings.rounds, rng, state.recent);
  for (const p of state.players) p.score = 0;
  startRound(state, 0, now);
}

export function startRound(state: RoomState, index: number, now: number): void {
  state.phase = 'round';
  state.roundIndex = index;
  state.roundStartedAt = now;
  state.phaseEndsAt = now + ROUND_MS;
  state.attempts = {};
}

export function attemptOf(state: RoomState, playerId: string): Attempt {
  let a = state.attempts[playerId];
  if (!a) {
    a = { wrong: 0, lastSubmitAt: 0, solvedAt: null, query: null, length: null, points: 0, bonus: 0 };
    state.attempts[playerId] = a;
  }
  return a;
}

export function solvedCount(state: RoomState): number {
  return Object.values(state.attempts).filter((a) => a.solvedAt !== null).length;
}

/** Ends the round: shortest-query bonus, then the round-end pause. */
export function endRound(state: RoomState, now: number): void {
  if (state.phase !== 'round') return;
  const solved = Object.entries(state.attempts).filter(([, a]) => a.solvedAt !== null && a.length !== null);
  if (solved.length) {
    const shortest = Math.min(...solved.map(([, a]) => a.length as number));
    for (const [pid, a] of solved) {
      if (a.length === shortest) {
        a.bonus = SHORTEST_BONUS;
        const p = state.players.find((x) => x.id === pid);
        if (p) p.score += SHORTEST_BONUS;
      }
    }
  }
  state.phase = 'round_end';
  state.phaseEndsAt = now + ROUND_END_MS;
}

/** After the round-end pause: the next round, or the final leaderboard. */
export function nextRound(state: RoomState, now: number): void {
  if (state.phase !== 'round_end') return;
  if (state.roundIndex + 1 < state.puzzleIds.length) startRound(state, state.roundIndex + 1, now);
  else {
    state.phase = 'game_end';
    state.phaseEndsAt = null;
  }
}

/** Ends the round early when every connected player has solved it. */
export function maybeEndEarly(state: RoomState, now: number): boolean {
  if (state.phase !== 'round') return false;
  const online = connectedPlayers(state);
  if (online.length === 0) return false;
  if (!online.every((p) => state.attempts[p.id]?.solvedAt != null)) return false;
  endRound(state, now);
  return true;
}

/** Applies every deadline that has passed. Returns true when anything changed. */
export function advance(state: RoomState, now: number): boolean {
  let changed = false;
  for (let guard = 0; guard < 100 && state.phaseEndsAt !== null && state.phaseEndsAt <= now; guard++) {
    if (state.phase === 'round') endRound(state, state.phaseEndsAt);
    else if (state.phase === 'round_end') nextRound(state, now);
    else state.phaseEndsAt = null;
    changed = true;
  }
  return changed;
}

export function playAgain(state: RoomState): void {
  state.recent = [...state.recent, ...state.puzzleIds].slice(-60);
  state.phase = 'lobby';
  state.puzzleIds = [];
  state.roundIndex = -1;
  state.roundStartedAt = null;
  state.phaseEndsAt = null;
  state.attempts = {};
  for (const p of state.players) p.score = 0;
}

export function currentPuzzle(state: RoomState, book: PuzzleBook): Puzzle | null {
  if (state.roundIndex < 0) return null;
  return book.get(state.puzzleIds[state.roundIndex]) ?? null;
}

// ---- submissions ----

export type SubmitResult =
  | { ok: true; verdict: Verdict; changed: boolean }
  | { ok: false; code: ErrorCode; message: string };

/**
 * Checks one submission. Wrong answers and engine errors count as wrong tries.
 * At most one try per SUBMIT_GAP_MS per player; a try inside the gap is refused and not counted.
 */
export function submit(state: RoomState, player: Player, query: unknown, round: unknown, now: number, book: PuzzleBook): SubmitResult {
  if (state.phase !== 'round') return { ok: false, code: 'not_allowed', message: 'The round is over.' };
  if (typeof round === 'number' && round !== state.roundIndex) {
    return { ok: false, code: 'not_allowed', message: 'That answer was for an earlier round.' };
  }
  if (typeof query !== 'string' || !query.trim()) return { ok: false, code: 'bad_message', message: 'Type a query first.' };
  if (query.length > MAX_QUERY_LENGTH) {
    return { ok: false, code: 'bad_message', message: `Queries can be at most ${MAX_QUERY_LENGTH} characters.` };
  }
  const puzzle = currentPuzzle(state, book);
  if (!puzzle) return { ok: false, code: 'not_allowed', message: 'This round has no puzzle.' };
  const a = attemptOf(state, player.id);
  if (a.solvedAt !== null) return { ok: false, code: 'not_allowed', message: 'You already solved this round.' };
  const wait = a.lastSubmitAt + SUBMIT_GAP_MS - now;
  if (wait > 0) return { ok: false, code: 'too_fast', message: `Wait ${Math.ceil(wait / 1000)} s before trying again.` };
  a.lastSubmitAt = now;

  let reason: string;
  try {
    const verdict = resultsMatch(runQuery(query, puzzle.tables), puzzle.target, puzzle.ordered);
    if (verdict.ok) {
      const place = solvedCount(state);
      a.solvedAt = now;
      a.query = query.trim();
      a.length = queryLength(query);
      a.points = PLACE_POINTS[Math.min(place, PLACE_POINTS.length - 1)];
      player.score += a.points;
      maybeEndEarly(state, now);
      return { ok: true, changed: true, verdict: { round: state.roundIndex, ok: true, reason: '', points: a.points, wrong: a.wrong } };
    }
    reason = verdict.reason;
  } catch (e) {
    if (!(e instanceof SqlError)) throw e;
    reason = `Error: ${e.message}`;
  }
  a.wrong++;
  return { ok: true, changed: false, verdict: { round: state.roundIndex, ok: false, reason, points: 0, wrong: a.wrong } };
}

// ---- views ----

export function toPublic(p: Player): PublicPlayer {
  return { id: p.id, name: p.name, connected: p.connected, score: p.score };
}

export function ranking(state: RoomState): RankEntry[] {
  const sorted = state.players
    .slice()
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let rank = 0;
  let last = Number.NaN;
  return sorted.map((p, i) => {
    if (p.score !== last) {
      rank = i + 1;
      last = p.score;
    }
    return { id: p.id, name: p.name, score: p.score, rank };
  });
}

export function roundResults(state: RoomState): ResultRow[] {
  const start = state.roundStartedAt ?? 0;
  const rows = state.players.map((p): ResultRow => {
    const a = state.attempts[p.id];
    const solved = !!a && a.solvedAt !== null;
    return {
      playerId: p.id,
      name: p.name,
      solved,
      ms: solved ? (a.solvedAt as number) - start : null,
      query: solved ? a.query : null,
      length: solved ? a.length : null,
      wrong: a ? a.wrong : 0,
      points: a ? a.points : 0,
      bonus: a ? a.bonus : 0,
    };
  });
  return rows.sort((x, y) => {
    if (x.solved !== y.solved) return x.solved ? -1 : 1;
    if (x.solved && y.solved) return (x.ms as number) - (y.ms as number);
    return x.name.localeCompare(y.name);
  });
}

/** The state as one player may see it. Reference answers and other players' running queries never appear. */
export function snapshot(state: RoomState, viewerId: string | null, book: PuzzleBook): Snapshot {
  const puzzle = currentPuzzle(state, book);
  const inGame = state.phase === 'round' || state.phase === 'round_end' || state.phase === 'game_end';
  const start = state.roundStartedAt ?? 0;
  let me: MyRound | null = null;
  if (viewerId && inGame) {
    const a = state.attempts[viewerId];
    me = { solved: !!a && a.solvedAt !== null, query: a?.query ?? null, wrong: a?.wrong ?? 0, points: a ? a.points + a.bonus : 0 };
  }
  return {
    code: state.code,
    phase: state.phase,
    hostId: state.hostId,
    players: state.players.map(toPublic),
    settings: { ...state.settings },
    round:
      inGame && puzzle && state.roundStartedAt !== null
        ? {
            index: state.roundIndex,
            total: state.puzzleIds.length,
            puzzle: publicPuzzle(puzzle),
            startedAt: start,
            endsAt: state.phase === 'round' ? state.phaseEndsAt : null,
            solved: Object.entries(state.attempts)
              .filter(([, a]) => a.solvedAt !== null)
              .sort(([, x], [, y]) => (x.solvedAt as number) - (y.solvedAt as number))
              .map(([playerId, a]) => ({ playerId, ms: (a.solvedAt as number) - start, points: a.points })),
          }
        : null,
    results: state.phase === 'round_end' || state.phase === 'game_end' ? roundResults(state) : null,
    nextAt: state.phase === 'round_end' ? state.phaseEndsAt : null,
    ranking: state.phase === 'game_end' ? ranking(state) : null,
    me,
    seq: state.seq,
  };
}

// ---- housekeeping ----

/** In the lobby, players who left more than LOBBY_PRUNE_MS ago are removed. During a game they keep their seat and score. */
export function prune(state: RoomState, now: number): boolean {
  if (state.phase !== 'lobby') return false;
  const before = state.players.length;
  state.players = state.players.filter((p) => p.connected || now - p.lastSeen < LOBBY_PRUNE_MS);
  const changed = state.players.length !== before;
  return ensureHost(state) || changed;
}

export function isExpired(state: RoomState, now: number): boolean {
  return state.idleSince !== null && now >= state.idleSince + IDLE_MS;
}

/** Next time the room needs an alarm: a phase deadline, a lobby prune, or idle deletion. */
export function nextDeadline(state: RoomState, now: number): number | null {
  let next = Infinity;
  if (state.phaseEndsAt !== null) next = Math.min(next, state.phaseEndsAt);
  if (state.phase === 'lobby') {
    for (const p of state.players) if (!p.connected) next = Math.min(next, p.lastSeen + LOBBY_PRUNE_MS);
  }
  if (state.idleSince !== null) next = Math.min(next, state.idleSince + IDLE_MS);
  return next === Infinity ? null : Math.max(next, now + 1);
}
