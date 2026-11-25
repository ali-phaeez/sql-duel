import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqlError, tokenize } from '../src/sql/index.ts';

const kinds = (sql: string): string[] => tokenize(sql).map((t) => `${t.kind}:${t.text}`);

test('keywords are case-insensitive and come out upper case; identifiers keep their spelling', () => {
  assert.deepEqual(kinds('select Name from T'), ['keyword:SELECT', 'ident:Name', 'keyword:FROM', 'ident:T', 'eof:']);
});

test('numbers: integers, decimals and a leading dot', () => {
  const nums = tokenize('1 2.5 .75 10.').filter((t) => t.kind === 'number').map((t) => t.num);
  assert.deepEqual(nums, [1, 2.5, 0.75, 10]);
});

test("strings use single quotes and '' escapes a quote", () => {
  const t = tokenize("'it''s'")[0];
  assert.equal(t.kind, 'string');
  assert.equal(t.text, "it's");
});

test('double-quoted identifiers are never keywords', () => {
  const t = tokenize('"order"')[0];
  assert.equal(t.kind, 'ident');
  assert.equal(t.text, 'order');
  assert.equal(t.quoted, true);
});

test('two-character operators win over one-character ones', () => {
  assert.deepEqual(kinds('<= >= <> != == || < = >').slice(0, -1).map((k) => k.split(':')[1]), [
    '<=', '>=', '<>', '!=', '==', '||', '<', '=', '>',
  ]);
});

test('line and column positions are 1-based and follow newlines', () => {
  const toks = tokenize('SELECT a,\n  b\nFROM t');
  const b = toks.find((t) => t.text === 'b')!;
  assert.deepEqual([b.pos.line, b.pos.col], [2, 3]);
  const from = toks.find((t) => t.text === 'FROM')!;
  assert.deepEqual([from.pos.line, from.pos.col], [3, 1]);
});

test('-- line comments and /* block */ comments are skipped', () => {
  assert.deepEqual(kinds('SELECT 1 -- hi\n/* x */ , 2'), ['keyword:SELECT', 'number:1', 'op:,', 'number:2', 'eof:']);
});

test('an unterminated string is an error at the opening quote', () => {
  assert.throws(() => tokenize("SELECT 'abc"), (e: SqlError) => e instanceof SqlError && e.line === 1 && e.col === 8 && /never closed/.test(e.message));
});

test('an unterminated block comment is an error', () => {
  assert.throws(() => tokenize('SELECT 1 /* oops'), /never closed with \*\//);
});

test('an unknown character is an error with its position', () => {
  assert.throws(() => tokenize('SELECT a # b'), /near "#" at 1:10: unexpected character/);
});
