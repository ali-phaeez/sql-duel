import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUERY_LENGTH, parse, SqlError } from '../src/sql/index.ts';

function err(sql: string): string {
  try {
    parse(sql);
  } catch (e) {
    assert.ok(e instanceof SqlError, `expected SqlError, got ${e}`);
    return e.message;
  }
  assert.fail(`expected a parse error for: ${sql}`);
}

test('parses every clause of the supported SELECT', () => {
  const q = parse(
    'SELECT DISTINCT c.name AS n, count(*) FROM customers AS c JOIN orders o ON o.customer_id = c.id, products ' +
      "WHERE c.city <> 'Rome' GROUP BY c.name HAVING count(*) > 1 ORDER BY n DESC, 2 LIMIT 5 OFFSET 1;",
  );
  assert.equal(q.distinct, true);
  assert.equal(q.items.length, 2);
  assert.deepEqual(q.from.map((f) => [f.table, f.alias, f.join]), [
    ['customers', 'c', 'first'],
    ['orders', 'o', 'inner'],
    ['products', null, 'comma'],
  ]);
  assert.ok(q.from[1].on);
  assert.ok(q.where);
  assert.equal(q.groupBy.length, 1);
  assert.ok(q.having);
  assert.deepEqual(q.orderBy.map((o) => o.desc), [true, false]);
  assert.ok(q.limit && q.offset);
});

test('the example typo: SELECT * FORM t points at FORM', () => {
  assert.equal(err('SELECT * FORM t'), 'near "FORM" at 1:10: expected FROM, a comma, or AS before an alias');
});

test('positions in errors follow lines', () => {
  assert.match(err('SELECT name,\n  city\n FORM t'), /near "FORM" at 3:2/);
});

test('column aliases need AS, so a missing comma is caught', () => {
  assert.match(err('SELECT name city FROM t'), /near "city" at 1:13/);
});

test('table aliases work with and without AS', () => {
  assert.equal(parse('SELECT 1 FROM t x').from[0].alias, 'x');
  assert.equal(parse('SELECT 1 FROM t AS x').from[0].alias, 'x');
});

test('precedence: AND binds tighter than OR, * tighter than +', () => {
  const q = parse('SELECT 1 FROM t WHERE a OR b AND c');
  assert.equal(q.where?.kind === 'binary' && q.where.op, 'OR');
  const s = parse('SELECT 1 + 2 * 3').items[0];
  assert.ok(s.kind === 'expr' && s.expr.kind === 'binary' && s.expr.op === '+');
});

test('NOT LIKE / NOT IN / NOT BETWEEN / IS NOT NULL parse to negated nodes', () => {
  const q = parse("SELECT 1 FROM t WHERE a NOT LIKE 'x%' AND b NOT IN (1, 2) AND c NOT BETWEEN 1 AND 2 AND d IS NOT NULL");
  const flat: string[] = [];
  const walk = (e: any): void => {
    if (e.kind === 'binary') { walk(e.left); walk(e.right); } else flat.push(`${e.kind}:${e.not}`);
  };
  walk(q.where);
  assert.deepEqual(flat, ['like:true', 'in:true', 'between:true', 'isnull:true']);
});

test('== is = and <> is !=', () => {
  const q = parse('SELECT 1 FROM t WHERE a == 1 AND b <> 2');
  assert.ok(q.where?.kind === 'binary');
  const w = q.where as any;
  assert.equal(w.left.op, '=');
  assert.equal(w.right.op, '!=');
});

test('a negative number literal folds into the literal', () => {
  const it = parse('SELECT -5').items[0];
  assert.ok(it.kind === 'expr' && it.expr.kind === 'literal' && it.expr.value === -5);
});

test('t.* and count(DISTINCT x) parse', () => {
  const q = parse('SELECT o.*, count(DISTINCT city) FROM orders o');
  assert.deepEqual(q.items[0], { kind: 'star', table: 'o', pos: { offset: 7, line: 1, col: 8 } });
  const c = q.items[1];
  assert.ok(c.kind === 'expr' && c.expr.kind === 'call' && c.expr.distinct);
});

test('unsupported SQL words are named in the error', () => {
  assert.match(err('SELECT * FROM a LEFT JOIN b ON a.id = b.id'), /near "LEFT" at 1:17: LEFT is not supported/);
  assert.match(err('SELECT CASE WHEN a THEN 1 END FROM t'), /CASE is not supported/);
  assert.match(err('SELECT 1 FROM t UNION SELECT 2 FROM t'), /UNION is not supported/);
});

test('subqueries and multiple statements are rejected', () => {
  assert.match(err('SELECT 1 FROM t WHERE a IN (SELECT b FROM u)'), /subqueries are not supported/);
  assert.match(err('SELECT 1; SELECT 2'), /only one SELECT statement/);
});

test('the query must start with SELECT', () => {
  assert.match(err('DELETE FROM t'), /near "DELETE" at 1:1/);
  assert.match(err('   '), /type a SELECT query/);
});

test('incomplete queries report the end of the query', () => {
  assert.match(err('SELECT a FROM t WHERE'), /end of query \(1:22\)/);
  assert.match(err('SELECT a FROM'), /expected a table name/);
  assert.match(err('SELECT (1 + 2'), /expected "\)"/);
});

test('JOIN needs ON; GROUP and ORDER need BY', () => {
  assert.match(err('SELECT 1 FROM a JOIN b'), /expected ON/);
  assert.match(err('SELECT 1 FROM a GROUP x'), /expected BY after GROUP/);
  assert.match(err('SELECT 1 FROM a ORDER x'), /expected BY after ORDER/);
});

test('keywords cannot be bare names but can be quoted', () => {
  assert.match(err('SELECT order FROM t'), /not the keyword ORDER/);
  const it = parse('SELECT "order" FROM t').items[0];
  assert.ok(it.kind === 'expr' && it.expr.kind === 'column' && it.expr.name === 'order');
});

test('an empty IN list is an error', () => {
  assert.match(err('SELECT 1 FROM t WHERE a IN ()'), /IN list cannot be empty/);
});

test(`queries longer than ${MAX_QUERY_LENGTH} characters are rejected before parsing`, () => {
  assert.match(err('SELECT ' + '1+'.repeat(1000) + '1'), /Query is too long: 2008 characters/);
});

test('very deep nesting is an error, not a stack overflow', () => {
  assert.match(err('SELECT ' + '('.repeat(150) + '1' + ')'.repeat(150)), /nested too deeply/);
  assert.match(err('SELECT ' + 'NOT '.repeat(150) + '1'), /nested too deeply/);
});
