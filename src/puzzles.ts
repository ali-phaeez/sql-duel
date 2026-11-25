// Puzzle pack: types, validation, the public (answer-free) view, and selection for a game.
// Pure module: the Worker passes the bundled pack in, tests and tools pass a parsed puzzles/pack.json.

import { resultsMatch, runQuery } from './sql/index.ts';
import type { QueryResult, Table } from './sql/index.ts';
import { isValue } from './sql/values.ts';

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

export interface Puzzle {
  id: string;
  title: string;
  difficulty: Difficulty;
  story: string;
  ordered: boolean;
  tables: Table[];
  /** Reference answer. Server-side only: never part of PublicPuzzle. */
  answer: string;
  /** Produced by running `answer` through the engine (npm run puzzles), never typed by hand. */
  target: QueryResult;
}

export interface Pack {
  version: number;
  puzzles: Puzzle[];
}

/** What players receive: everything except the reference answer. */
export interface PublicPuzzle {
  id: string;
  title: string;
  difficulty: Difficulty;
  story: string;
  ordered: boolean;
  tables: Table[];
  target: QueryResult;
}

export function publicPuzzle(p: Puzzle): PublicPuzzle {
  return { id: p.id, title: p.title, difficulty: p.difficulty, story: p.story, ordered: p.ordered, tables: p.tables, target: p.target };
}

export const MAX_TABLES = 3;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Structural checks for one puzzle (not the target). Returns a list of problems, empty when fine. */
export function checkPuzzleShape(p: Puzzle): string[] {
  const errs: string[] = [];
  const at = `puzzle ${JSON.stringify(p?.id)}`;
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) errs.push(`${at}: id must be lower-case-words-with-dashes`);
  if (typeof p.title !== 'string' || !p.title.trim()) errs.push(`${at}: title is missing`);
  if (!DIFFICULTIES.includes(p.difficulty)) errs.push(`${at}: difficulty must be easy, medium or hard`);
  if (typeof p.story !== 'string' || !p.story.trim()) errs.push(`${at}: story is missing`);
  if (typeof p.ordered !== 'boolean') errs.push(`${at}: ordered must be true or false`);
  if (typeof p.answer !== 'string' || !p.answer.trim()) errs.push(`${at}: answer is missing`);
  if (!Array.isArray(p.tables) || p.tables.length < 1 || p.tables.length > MAX_TABLES) {
    errs.push(`${at}: needs 1 to ${MAX_TABLES} tables`);
    return errs;
  }
  const names = new Set<string>();
  for (const t of p.tables) {
    const tn = `${at}, table ${JSON.stringify(t?.name)}`;
    if (typeof t.name !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(t.name)) errs.push(`${tn}: bad table name`);
    if (names.has(t.name)) errs.push(`${tn}: duplicate table name`);
    names.add(t.name);
    if (!Array.isArray(t.columns) || t.columns.length === 0) {
      errs.push(`${tn}: needs columns`);
      continue;
    }
    const cols = new Set(t.columns.map((c) => String(c).toLowerCase()));
    if (cols.size !== t.columns.length) errs.push(`${tn}: duplicate column names`);
    for (const c of t.columns) if (typeof c !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(c)) errs.push(`${tn}: bad column name ${JSON.stringify(c)}`);
    if (!Array.isArray(t.rows) || t.rows.length === 0) errs.push(`${tn}: needs rows`);
    else {
      t.rows.forEach((r, i) => {
        if (!Array.isArray(r) || r.length !== t.columns.length) errs.push(`${tn}: row ${i + 1} has the wrong number of values`);
        else if (!r.every(isValue)) errs.push(`${tn}: row ${i + 1} has a value that is not a number, text or null`);
      });
    }
  }
  return errs;
}

/** Runs the reference answer; also runs it on the tables with their rows reversed to catch ties that make the target depend on row order. */
export function computeTarget(p: Puzzle): QueryResult {
  const target = runQuery(p.answer, p.tables);
  const reversed = p.tables.map((t) => ({ ...t, rows: t.rows.slice().reverse() }));
  const again = runQuery(p.answer, reversed);
  if (!resultsMatch(again, target, p.ordered).ok) {
    throw new Error(`puzzle "${p.id}": the answer gives a different result when table rows are reordered (a tie in ORDER BY or LIMIT?)`);
  }
  if (target.rows.length === 0) throw new Error(`puzzle "${p.id}": the answer returns no rows`);
  return target;
}

/** Full check of a pack: shapes, unique ids, and every reference answer reproduces its stored target. */
export function validatePack(pack: Pack): string[] {
  const errs: string[] = [];
  if (!pack || !Array.isArray(pack.puzzles)) return ['pack.puzzles must be an array'];
  const ids = new Set<string>();
  for (const p of pack.puzzles) {
    errs.push(...checkPuzzleShape(p));
    if (ids.has(p.id)) errs.push(`puzzle "${p.id}": duplicate id`);
    ids.add(p.id);
    try {
      const got = runQuery(p.answer, p.tables);
      if (!p.target || !resultsMatch(got, p.target, true).ok || got.columns.join('\u0000') !== p.target.columns.join('\u0000')) {
        errs.push(`puzzle "${p.id}": stored target does not match the reference answer (run npm run puzzles)`);
      }
    } catch (e) {
      errs.push(`puzzle "${p.id}": reference answer fails: ${(e as Error).message}`);
    }
  }
  return errs;
}

export type DifficultyFilter = 'easy' | 'mixed' | 'hard';
export const DIFFICULTY_FILTERS: readonly DifficultyFilter[] = ['easy', 'mixed', 'hard'];

const RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };

function shuffled<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Picks `count` puzzle ids for a game.
 * easy: easy puzzles (topped up with medium) · hard: hard puzzles (topped up with medium) ·
 * mixed: everything, played from easiest to hardest. Puzzles in `avoid` (recently played) are used last.
 */
export function pickPuzzles(
  puzzles: readonly Puzzle[],
  filter: DifficultyFilter,
  count: number,
  rng: () => number,
  avoid: readonly string[] = [],
): string[] {
  const recent = new Set(avoid);
  const fresh = (list: readonly Puzzle[]): Puzzle[] => {
    const s = shuffled(list, rng);
    return [...s.filter((p) => !recent.has(p.id)), ...s.filter((p) => recent.has(p.id))];
  };
  const of = (d: Difficulty): Puzzle[] => puzzles.filter((p) => p.difficulty === d);
  let chosen: Puzzle[];
  if (filter === 'mixed') chosen = fresh(puzzles).slice(0, count);
  else {
    const main = fresh(of(filter));
    chosen = [...main, ...fresh(of('medium')), ...fresh(of(filter === 'easy' ? 'hard' : 'easy'))].slice(0, count);
  }
  return chosen
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (filter === 'mixed' ? RANK[a.p.difficulty] - RANK[b.p.difficulty] : 0) || a.i - b.i)
    .map((x) => x.p.id);
}
