import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPlayer, advance, applySettings, bookOf, dedupeName, endRound, ensureHost, maybeEndEarly, newRoom, nextDeadline,
  nextRound, playAgain, prune, ranking, sanitizeName, snapshot, startGame, submit,
} from '../src/game.ts';
import { CODE_ALPHABET, generateCode, isValidCode, normalizeCode } from '../src/codes.ts';
import { IDLE_MS, LOBBY_PRUNE_MS, ROUND_END_MS, ROUND_MS, SUBMIT_GAP_MS } from '../src/protocol.ts';
import type { RoomState } from '../src/protocol.ts';
import { loadPack } from './helpers/pack.ts';

const T0 = 1_700_000_000_000;
const pack = loadPack();
const book = bookOf(pack.puzzles);

function room(names: string[] = ['Ann', 'Bob', 'Cid']): RoomState {
  const s = newRoom('BCDF', T0);
  names.forEach((name, i) => addPlayer(s, { id: `p${i}`, secret: `s${i}`, name, now: T0 + i }));
  return s;
}
const player = (s: RoomState, name: string) => s.players.find((p) => p.name === name)!;
const answer = (s: RoomState): string => book.get(s.puzzleIds[s.roundIndex])!.answer;
function started(names?: string[]): RoomState {
  const s = room(names);
  startGame(s, T0, book, Math.random);
  return s;
}

// ---- codes and names ----

test('room codes are 4 letters from the consonant alphabet', () => {
  for (let i = 0; i < 50; i++) assert.ok(isValidCode(generateCode()));
  assert.equal(generateCode(() => 0), CODE_ALPHABET[0].repeat(4));
  assert.equal(generateCode(() => 0.99999), CODE_ALPHABET[CODE_ALPHABET.length - 1].repeat(4));
  assert.equal(normalizeCode(' bcdf '), 'BCDF');
  assert.equal(isValidCode('ABCD'), false);
});

test('names are cleaned, limited to 12 characters, and made unique', () => {
  assert.equal(sanitizeName('  Ann \n Lee  '), 'Ann Lee');
  assert.equal(sanitizeName('   '), null);
  assert.equal(sanitizeName('A'.repeat(20)), 'A'.repeat(12));
  assert.equal(dedupeName('ann', ['Ann']), 'ann 2');
  assert.equal(dedupeName('Ann', ['Ann', 'Ann 2']), 'Ann 3');
  assert.equal(dedupeName('Bartholomew1', ['bartholomew1']).length, 12);
});

test('the first player is host; host passes on when the host disconnects', () => {
  const s = room();
  assert.equal(s.hostId, 'p0');
  player(s, 'Ann').connected = false;
  assert.equal(ensureHost(s), true);
  assert.equal(s.hostId, 'p1');
});

test('settings accept only 5/8/12 rounds and easy/mixed/hard', () => {
  const s = room();
  assert.equal(applySettings(s, 8, 'hard'), true);
  assert.deepEqual(s.settings, { rounds: 8, difficulty: 'hard' });
  assert.equal(applySettings(s, 7, 'brutal'), false);
  assert.deepEqual(s.settings, { rounds: 8, difficulty: 'hard' });
});

// ---- rounds and scoring ----

test('starting a game picks N puzzles and opens a 90 s round', () => {
  const s = room();
  applySettings(s, 8, 'easy');
  startGame(s, T0, book, Math.random);
  assert.equal(s.puzzleIds.length, 8);
  assert.equal(s.phase, 'round');
  assert.equal(s.roundIndex, 0);
  assert.equal(s.phaseEndsAt, T0 + ROUND_MS);
});

test('first correct gets 5, second 3, later ones 1', () => {
  const s = started(['Ann', 'Bob', 'Cid', 'Dee']);
  const q = answer(s);
  for (const [i, name] of ['Ann', 'Bob', 'Cid'].entries()) {
    const r = submit(s, player(s, name), q, 0, T0 + 1000 * (i + 1), book);
    assert.ok(r.ok && r.verdict.ok);
  }
  assert.deepEqual(['Ann', 'Bob', 'Cid'].map((n) => player(s, n).score), [5, 3, 1]);
  assert.equal(s.phase, 'round', 'Dee has not solved yet');
});

test('the shortest correct query gets +1; ties all get it', () => {
  const s = started();
  const q = answer(s);
  submit(s, player(s, 'Ann'), q, 0, T0 + 1000, book);
  submit(s, player(s, 'Bob'), `  ${q.replace(/ /g, '   ')}  `, 0, T0 + 2000, book); // same length after collapsing
  submit(s, player(s, 'Cid'), `${q} -- a comment makes it longer`, 0, T0 + 3000, book);
  assert.equal(s.phase, 'round_end', 'everyone solved: the round ends early');
  assert.deepEqual(['Ann', 'Bob', 'Cid'].map((n) => player(s, n).score), [6, 4, 1]);
});

test('wrong answers and engine errors count as wrong tries and tell the player why', () => {
  const s = started();
  const ann = player(s, 'Ann');
  const r1 = submit(s, ann, 'SELECT 1', 0, T0 + 1000, book);
  assert.ok(r1.ok && !r1.verdict.ok && r1.verdict.wrong === 1);
  const r2 = submit(s, ann, 'SELECT * FORM x', 0, T0 + 4000, book);
  assert.ok(r2.ok && !r2.verdict.ok);
  assert.match(r2.ok ? r2.verdict.reason : '', /^Error: near "FORM"/);
  assert.equal(s.attempts[ann.id].wrong, 2);
  assert.equal(ann.score, 0);
});

test('at most one try per 2 s per player; a refused try is not counted', () => {
  const s = started();
  const ann = player(s, 'Ann');
  submit(s, ann, 'SELECT 1', 0, T0 + 1000, book);
  const fast = submit(s, ann, 'SELECT 2', 0, T0 + 1000 + SUBMIT_GAP_MS - 1, book);
  assert.ok(!fast.ok && fast.code === 'too_fast');
  assert.equal(s.attempts[ann.id].wrong, 1);
  const later = submit(s, ann, 'SELECT 2', 0, T0 + 1000 + SUBMIT_GAP_MS, book);
  assert.ok(later.ok);
  // another player is not slowed down
  assert.ok(submit(s, player(s, 'Bob'), 'SELECT 3', 0, T0 + 1001, book).ok);
});

test('after solving, further submissions are refused', () => {
  const s = started();
  submit(s, player(s, 'Ann'), answer(s), 0, T0 + 1000, book);
  const again = submit(s, player(s, 'Ann'), answer(s), 0, T0 + 5000, book);
  assert.ok(!again.ok && /already solved/.test(again.message));
  assert.equal(player(s, 'Ann').score, 5);
});

test('answers for an old round, empty queries and over-long queries are refused', () => {
  const s = started();
  assert.ok(!submit(s, player(s, 'Ann'), answer(s), 3, T0 + 1000, book).ok);
  assert.ok(!submit(s, player(s, 'Ann'), '   ', 0, T0 + 1000, book).ok);
  const long = submit(s, player(s, 'Ann'), 'SELECT ' + '1'.repeat(2001), 0, T0 + 1000, book);
  assert.ok(!long.ok && long.code === 'bad_message');
});

test('the round ends early only when every connected player is correct', () => {
  const s = started();
  player(s, 'Cid').connected = false;
  submit(s, player(s, 'Ann'), answer(s), 0, T0 + 1000, book);
  assert.equal(s.phase, 'round');
  submit(s, player(s, 'Bob'), answer(s), 0, T0 + 2000, book);
  assert.equal(s.phase, 'round_end');
});

test('a disconnect can end the round when the rest have solved', () => {
  const s = started();
  submit(s, player(s, 'Ann'), answer(s), 0, T0 + 1000, book);
  submit(s, player(s, 'Bob'), answer(s), 0, T0 + 2000, book);
  player(s, 'Cid').connected = false;
  assert.equal(maybeEndEarly(s, T0 + 3000), true);
  assert.equal(s.phase, 'round_end');
});

test('the timer ends the round at 90 s; nobody solving is fine', () => {
  const s = started();
  assert.equal(advance(s, T0 + ROUND_MS - 1), false);
  assert.equal(advance(s, T0 + ROUND_MS), true);
  assert.equal(s.phase, 'round_end');
  assert.equal(s.phaseEndsAt, T0 + ROUND_MS + ROUND_END_MS);
  assert.ok(s.players.every((p) => p.score === 0));
});

test('after the round-end pause the next round starts with a full 90 s, even if the alarm is late', () => {
  const s = started();
  advance(s, T0 + ROUND_MS);
  const late = T0 + ROUND_MS + ROUND_END_MS + 5000;
  advance(s, late);
  assert.equal(s.phase, 'round');
  assert.equal(s.roundIndex, 1);
  assert.equal(s.roundStartedAt, late);
  assert.equal(s.phaseEndsAt, late + ROUND_MS);
  assert.deepEqual(s.attempts, {});
});

test('after the last round the game ends; play again returns to the lobby with scores reset', () => {
  const s = started();
  for (let i = 0; i < 5; i++) {
    submit(s, player(s, 'Ann'), answer(s), i, (s.roundStartedAt as number) + 500, book);
    endRound(s, (s.roundStartedAt as number) + 1000);
    nextRound(s, (s.roundStartedAt as number) + 2000);
  }
  assert.equal(s.phase, 'game_end');
  assert.equal(player(s, 'Ann').score, 30);
  assert.deepEqual(ranking(s).map((r) => [r.name, r.score, r.rank]), [['Ann', 30, 1], ['Bob', 0, 2], ['Cid', 0, 2]]);
  const played = s.puzzleIds.slice();
  playAgain(s);
  assert.equal(s.phase, 'lobby');
  assert.ok(s.players.every((p) => p.score === 0));
  assert.deepEqual(s.recent, played);
});

// ---- what players can see ----

test('snapshots never contain reference answers or other players\' running queries', () => {
  const s = started();
  const q = answer(s);
  submit(s, player(s, 'Ann'), q, 0, T0 + 1000, book);
  const bobView = JSON.stringify(snapshot(s, 'p1', book));
  assert.ok(!bobView.includes(q), 'Bob must not see the answer or Ann\'s query during the round');
  assert.ok(!bobView.includes('"answer"'));
  assert.ok(!bobView.includes('secret') && !bobView.includes('"s0"'));
  const annView = snapshot(s, 'p0', book);
  assert.equal(annView.me?.query, q, 'Ann sees her own query (for a reload)');
  assert.deepEqual(annView.round?.solved.map((x) => [x.playerId, x.ms, x.points]), [['p0', 1000, 5]]);
});

test('round-end results show every query, time, wrong tries and points', () => {
  const s = started();
  const q = answer(s);
  submit(s, player(s, 'Bob'), 'SELECT 1', 0, T0 + 500, book);
  submit(s, player(s, 'Ann'), q, 0, T0 + 1000, book);
  submit(s, player(s, 'Bob'), q, 0, T0 + 4000, book);
  endRound(s, T0 + 5000);
  const snap = snapshot(s, 'p2', book);
  assert.deepEqual(
    snap.results?.map((r) => [r.name, r.solved, r.ms, r.query, r.wrong, r.points, r.bonus]),
    [
      ['Ann', true, 1000, q, 0, 5, 1],
      ['Bob', true, 4000, q, 1, 3, 1],
      ['Cid', false, null, null, 0, 0, 0],
    ],
  );
  assert.equal(snap.nextAt, T0 + 5000 + ROUND_END_MS);
  assert.ok(!JSON.stringify(snap).includes('"answer"'));
});

// ---- housekeeping ----

test('lobby players who left are pruned after a minute; in-game players keep their seat', () => {
  const s = room();
  const bob = player(s, 'Bob');
  bob.connected = false;
  bob.lastSeen = T0;
  assert.equal(nextDeadline(s, T0), T0 + LOBBY_PRUNE_MS);
  assert.equal(prune(s, T0 + LOBBY_PRUNE_MS - 1), false);
  assert.equal(prune(s, T0 + LOBBY_PRUNE_MS), true);
  assert.equal(s.players.length, 2);

  const g = started();
  player(g, 'Bob').connected = false;
  assert.equal(prune(g, T0 + 10 * LOBBY_PRUNE_MS), false);
  assert.equal(g.players.length, 3);
});

test('the next alarm is the earliest of phase deadline and idle expiry', () => {
  const s = started();
  s.idleSince = T0;
  assert.equal(nextDeadline(s, T0), T0 + ROUND_MS);
  const l = room();
  l.idleSince = T0;
  assert.equal(nextDeadline(l, T0), T0 + IDLE_MS);
  assert.equal(nextDeadline(room(), T0), null);
});
