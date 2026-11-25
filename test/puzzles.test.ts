import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPuzzleShape, computeTarget, pickPuzzles, publicPuzzle, validatePack } from '../src/puzzles.ts';
import type { Puzzle } from '../src/puzzles.ts';
import { resultsMatch, runQuery } from '../src/sql/index.ts';
import { loadPack } from './helpers/pack.ts';

const pack = loadPack();

test('the pack has at least 30 puzzles across easy, medium and hard', () => {
  assert.ok(pack.puzzles.length >= 30, `only ${pack.puzzles.length} puzzles`);
  for (const d of ['easy', 'medium', 'hard'] as const) {
    assert.ok(pack.puzzles.filter((p) => p.difficulty === d).length >= 12, `fewer than 12 ${d} puzzles (needed for a 12-round game)`);
  }
});

test('every reference answer, run through the engine, gives exactly the stored target', () => {
  for (const p of pack.puzzles) {
    const got = runQuery(p.answer, p.tables);
    assert.deepEqual(got.rows, p.target.rows, p.id);
    assert.deepEqual(got.columns, p.target.columns, p.id);
    assert.equal(resultsMatch(got, p.target, p.ordered).ok, true, p.id);
  }
});

test('the whole pack validates: shapes, unique ids, 1-3 tables, targets up to date', () => {
  assert.deepEqual(validatePack(pack), []);
});

test('targets do not depend on table row order (no ties under ORDER BY / LIMIT)', () => {
  for (const p of pack.puzzles) assert.doesNotThrow(() => computeTarget(p), p.id);
});

test('ordered puzzles really need the order: a shuffled target fails', () => {
  for (const p of pack.puzzles.filter((x) => x.ordered && x.target.rows.length > 1)) {
    const reversed = { columns: p.target.columns, rows: p.target.rows.slice().reverse() };
    assert.equal(resultsMatch(reversed, p.target, true).ok, false, p.id);
  }
});

test('a stale target is reported', () => {
  const p: Puzzle = structuredClone(pack.puzzles[0]);
  p.target.rows = p.target.rows.slice(1);
  assert.match(validatePack({ version: 1, puzzles: [p] }).join('\n'), /stored target does not match/);
});

test('shape checks catch bad tables', () => {
  const p: Puzzle = structuredClone(pack.puzzles[0]);
  p.tables[0].rows.push([1, 2]);
  p.tables[0].columns.push('Bad Name');
  const errs = checkPuzzleShape(p).join('\n');
  assert.match(errs, /bad column name/);
  assert.match(errs, /wrong number of values/);
});

test('the public view never carries the reference answer', () => {
  for (const p of pack.puzzles) {
    const view = publicPuzzle(p);
    assert.equal('answer' in view, false);
    assert.ok(!JSON.stringify(view).includes(p.answer), p.id);
  }
});

test('pickPuzzles: the right count, no repeats, filters by difficulty', () => {
  let seed = 7;
  const rng = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const filter of ['easy', 'mixed', 'hard'] as const) {
    for (const n of [5, 8, 12]) {
      const ids = pickPuzzles(pack.puzzles, filter, n, rng);
      assert.equal(ids.length, n);
      assert.equal(new Set(ids).size, n);
      const diffs = ids.map((id) => pack.puzzles.find((p) => p.id === id)!.difficulty);
      if (filter === 'easy') assert.ok(diffs.every((d) => d === 'easy'));
      if (filter === 'hard') assert.ok(diffs.every((d) => d === 'hard'));
      if (filter === 'mixed') {
        const rank = { easy: 0, medium: 1, hard: 2 };
        for (let i = 1; i < diffs.length; i++) assert.ok(rank[diffs[i - 1]] <= rank[diffs[i]], 'mixed games get harder, never easier');
      }
    }
  }
});

test('pickPuzzles puts recently played puzzles last', () => {
  const easy = pack.puzzles.filter((p) => p.difficulty === 'easy').map((p) => p.id);
  const avoid = easy.slice(0, 7);
  const ids = pickPuzzles(pack.puzzles, 'easy', 5, Math.random, avoid);
  assert.ok(ids.every((id) => !avoid.includes(id)));
});
