import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTable, queryLength, resultsMatch } from '../src/sql/index.ts';
import type { QueryResult } from '../src/sql/index.ts';

const T: QueryResult = { columns: ['name', 'n'], rows: [['Ann', 3], ['Bob', 1], ['Bob', 1]] };

test('column names do not matter', () => {
  assert.equal(resultsMatch({ columns: ['x', 'y'], rows: T.rows }, T, false).ok, true);
});

test('rows are a multiset when the puzzle is unordered', () => {
  assert.equal(resultsMatch({ columns: ['a', 'b'], rows: [['Bob', 1], ['Ann', 3], ['Bob', 1]] }, T, false).ok, true);
  const dupMissing = resultsMatch({ columns: ['a', 'b'], rows: [['Bob', 1], ['Ann', 3], ['Ann', 3]] }, T, false);
  assert.equal(dupMissing.ok, false);
  assert.match(dupMissing.reason, /rows or values differ/);
});

test('order matters only for ordered puzzles', () => {
  const swapped: QueryResult = { columns: ['a', 'b'], rows: [['Bob', 1], ['Ann', 3], ['Bob', 1]] };
  const v = resultsMatch(swapped, T, true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /specific order/);
  assert.equal(resultsMatch({ columns: ['a', 'b'], rows: T.rows }, T, true).ok, true);
});

test('column count and row count mismatches say so', () => {
  assert.equal(resultsMatch({ columns: ['a'], rows: [['Ann'], ['Bob'], ['Bob']] }, T, false).reason, 'Your result has 1 column; the target has 2.');
  assert.equal(resultsMatch({ columns: ['a', 'b'], rows: [['Ann', 3]] }, T, false).reason, 'Your result has 1 row; the target has 3.');
});

test('values use the engine equality: 1 and "1" differ, NULL matches NULL', () => {
  assert.equal(resultsMatch({ columns: ['a'], rows: [['1']] }, { columns: ['a'], rows: [[1]] }, false).ok, false);
  assert.equal(resultsMatch({ columns: ['a'], rows: [[null]] }, { columns: ['a'], rows: [[null]] }, false).ok, true);
});

test('query length trims and collapses whitespace', () => {
  assert.equal(queryLength('  SELECT   a\n\n FROM\tt  '), 'SELECT a FROM t'.length);
});

test('formatTable draws a plain text table', () => {
  assert.equal(formatTable({ columns: ['name', 'n'], rows: [['Ann', 3], ['Bo', null]] }), [
    '+------+------+',
    '| name | n    |',
    '+------+------+',
    '| Ann  |    3 |',
    '| Bo   | NULL |',
    '+------+------+',
    '(2 rows)',
  ].join('\n'));
});
