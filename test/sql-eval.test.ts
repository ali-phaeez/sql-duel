import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, SqlError } from '../src/sql/index.ts';
import type { Table, Value } from '../src/sql/index.ts';
import { TABLES } from './helpers/fixtures.ts';

const rows = (sql: string, tables: Table[] = TABLES): Value[][] => runQuery(sql, tables).rows;
const one = (expr: string): Value => rows(`SELECT ${expr}`)[0][0];
function err(sql: string, tables: Table[] = TABLES): string {
  try {
    runQuery(sql, tables);
  } catch (e) {
    assert.ok(e instanceof SqlError, `expected SqlError, got ${e}`);
    return e.message;
  }
  assert.fail(`expected an error for: ${sql}`);
}

// ---- SELECT / FROM ----

test('SELECT * returns every column in table order', () => {
  const r = runQuery('SELECT * FROM customers', TABLES);
  assert.deepEqual(r.columns, ['id', 'name', 'city']);
  assert.equal(r.rows.length, 4);
});

test('column names: declared name for columns, alias with AS, source text for expressions', () => {
  const r = runQuery('SELECT NAME, id * 2, city AS town FROM customers', TABLES);
  assert.deepEqual(r.columns, ['name', 'id * 2', 'town']);
});

test('table and column names are case-insensitive; quoted names work too', () => {
  assert.deepEqual(rows('SELECT "Name" FROM CUSTOMERS WHERE ID = 2'), [['Bob']]);
});

test('SELECT without FROM evaluates once', () => {
  assert.deepEqual(rows('SELECT 1 + 1, \'a\' || \'b\''), [[2, 'ab']]);
});

test('t.* expands one table of a join', () => {
  const r = runQuery('SELECT o.* FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.id = 2', TABLES);
  assert.deepEqual(r.columns, ['id', 'customer_id', 'total']);
  assert.deepEqual(r.rows, [[12, 2, 5]]);
});

test('unknown table lists the tables that exist', () => {
  assert.equal(err('SELECT * FROM custmers'), 'no such table "custmers" (tables here: customers, orders, products) at 1:15');
});

test('unknown column has a position', () => {
  assert.equal(err('SELECT nme FROM customers'), 'no such column "nme" at 1:8');
  assert.equal(err('SELECT c.nme FROM customers c'), 'no such column "c.nme" at 1:8');
});

test('an aliased table must be referred to by its alias', () => {
  assert.match(err('SELECT customers.name FROM customers c'), /no such table or alias "customers" \(it is called "c" in this query\)/);
});

test('using the same table twice needs an alias', () => {
  assert.match(err('SELECT 1 FROM customers, customers'), /used twice in FROM/);
  assert.equal(rows('SELECT count(*) FROM customers a, customers b')[0][0], 16);
});

// ---- joins ----

test('comma join is a cross join, filtered by WHERE', () => {
  assert.deepEqual(rows('SELECT c.name, o.id FROM customers c, orders o WHERE o.customer_id = c.id AND c.id = 2'), [['Bob', 12]]);
});

test('INNER JOIN ... ON keeps matching pairs only', () => {
  const r = rows('SELECT c.name, o.total FROM customers c INNER JOIN orders o ON o.customer_id = c.id');
  assert.equal(r.length, 5);
  assert.ok(!r.some((x) => x[0] === 'Dee'));
});

test('three-way join', () => {
  const tables: Table[] = [
    { name: 'a', columns: ['id'], rows: [[1], [2]] },
    { name: 'b', columns: ['a_id', 'c_id'], rows: [[1, 7], [2, 8], [2, 7]] },
    { name: 'c', columns: ['id', 'label'], rows: [[7, 'x'], [8, 'y']] },
  ];
  assert.deepEqual(rows('SELECT a.id, c.label FROM a JOIN b ON b.a_id = a.id JOIN c ON c.id = b.c_id ORDER BY 1, 2', tables), [
    [1, 'x'], [2, 'x'], [2, 'y'],
  ]);
});

test('ON can only see tables joined so far', () => {
  assert.match(err('SELECT 1 FROM customers c JOIN orders o ON o.customer_id = p.sku JOIN products p ON 1 = 1'), /no such table or alias "p"/);
});

test('ambiguous columns must be qualified', () => {
  assert.match(err('SELECT id FROM customers, orders'), /ambiguous column name "id" \(it is in customers and orders/);
});

// ---- WHERE and operators ----

test('WHERE with comparison operators', () => {
  assert.deepEqual(rows('SELECT id FROM orders WHERE total >= 10'), [[10], [11]]);
  assert.deepEqual(rows('SELECT id FROM orders WHERE total < 10'), [[12], [13]]);
  assert.deepEqual(rows('SELECT id FROM orders WHERE total <= 7 AND total > 5'), [[13]]);
  assert.deepEqual(rows('SELECT id FROM orders WHERE total == 5'), [[12]]);
  assert.deepEqual(rows("SELECT id FROM customers WHERE city != 'Oslo'"), [[2]]);
  assert.deepEqual(rows("SELECT id FROM customers WHERE city <> 'Oslo'"), [[2]]);
});

test('arithmetic follows JavaScript numbers: / is real division', () => {
  assert.equal(one('7 / 2'), 3.5);
  assert.equal(one('7 % 3'), 1);
  assert.equal(one('-7 % 3'), -1);
  assert.equal(one('2 + 3 * 4'), 14);
  assert.equal(one('(2 + 3) * 4'), 20);
  assert.equal(one('10 - 2 - 3'), 5);
  assert.equal(one('0.1 + 0.2'), 0.1 + 0.2);
});

test('division or modulo by zero gives NULL', () => {
  assert.equal(one('1 / 0'), null);
  assert.equal(one('1 % 0'), null);
});

test('unary minus', () => {
  assert.deepEqual(rows('SELECT -total FROM orders WHERE id = 12'), [[-5]]);
  assert.equal(one('- (2 + 3)'), -5);
});

test('|| concatenates and turns numbers into text', () => {
  assert.equal(one("'No. ' || 7"), 'No. 7');
  assert.equal(one("'a' || NULL"), null);
});

test('arithmetic on text is an error, not a JavaScript coercion', () => {
  assert.match(err("SELECT name + 1 FROM customers"), /"\+" needs a number, got text 'Ann' at 1:13/);
  assert.match(err("SELECT -name FROM customers"), /unary minus needs a number/);
});

test('ordering comparisons between a number and text are an error; = and != are just false/true', () => {
  assert.match(err("SELECT id FROM customers WHERE id < 'x'"), /cannot compare number 1 with text 'x'/);
  assert.deepEqual(rows("SELECT id FROM customers WHERE id = '1'"), []);
  assert.equal(rows("SELECT id FROM customers WHERE id != '1'").length, 4);
});

test('text compares by code unit, so upper case sorts before lower case', () => {
  assert.equal(one("'B' < 'a'"), 1);
  assert.equal(one("'apple' < 'banana'"), 1);
});

test('comparisons return 1 or 0', () => {
  assert.deepEqual(rows('SELECT 2 > 1, 2 < 1'), [[1, 0]]);
});

test('LIKE with % and _ is case-insensitive', () => {
  assert.deepEqual(rows("SELECT title FROM products WHERE title LIKE '%an%'"), [['Banana']]);
  assert.deepEqual(rows("SELECT title FROM products WHERE title LIKE 'c%'"), [['cherry']]);
  assert.deepEqual(rows("SELECT sku FROM products WHERE sku LIKE '_2'"), [['B2']]);
  assert.deepEqual(rows("SELECT title FROM products WHERE title NOT LIKE '%e%'"), [['Banana']]);
  assert.equal(one("'a.c' LIKE 'a_c'"), 1);
  assert.equal(one("'abc' LIKE 'a.c'"), 0);
});

test('IN and NOT IN', () => {
  assert.deepEqual(rows('SELECT id FROM customers WHERE id IN (1, 3)'), [[1], [3]]);
  assert.deepEqual(rows("SELECT id FROM customers WHERE city NOT IN ('Oslo')"), [[2]]);
});

test('BETWEEN and NOT BETWEEN are inclusive', () => {
  assert.deepEqual(rows('SELECT id FROM orders WHERE total BETWEEN 7 AND 10'), [[10], [13]]);
  assert.deepEqual(rows('SELECT id FROM orders WHERE total NOT BETWEEN 7 AND 10'), [[11], [12]]);
});

test('IS NULL and IS NOT NULL', () => {
  assert.deepEqual(rows('SELECT name FROM customers WHERE city IS NULL'), [['Dee']]);
  assert.equal(rows('SELECT name FROM customers WHERE city IS NOT NULL').length, 3);
});

test('a text value is not a condition', () => {
  assert.match(err('SELECT id FROM customers WHERE name'), /expected a true\/false condition, got text 'Ann'/);
});

// ---- NULL logic ----

test('NULL in arithmetic and comparisons gives NULL', () => {
  assert.deepEqual(rows('SELECT 1 + NULL, NULL * 2, NULL = NULL, NULL <> 1, NULL < 1'), [[null, null, null, null, null]]);
});

test('WHERE keeps only rows where the condition is true (not unknown)', () => {
  assert.equal(rows("SELECT id FROM customers WHERE city = 'Oslo' OR city <> 'Oslo'").length, 3);
  assert.equal(rows("SELECT id FROM customers WHERE NOT (city = 'Oslo')").length, 1);
});

test('three-valued AND / OR / NOT', () => {
  assert.deepEqual(rows('SELECT NULL AND 0, NULL AND 1, NULL OR 1, NULL OR 0, NOT NULL'), [[0, null, 1, null, null]]);
});

test('IN with NULL in the list follows SQL rules', () => {
  assert.deepEqual(rows('SELECT 1 IN (1, NULL), 2 IN (1, NULL), 2 NOT IN (1, NULL), NULL IN (1)'), [[1, null, null, null]]);
});

test('BETWEEN and LIKE with NULL are unknown', () => {
  assert.deepEqual(rows("SELECT NULL BETWEEN 1 AND 2, NULL LIKE 'a', 'a' LIKE NULL"), [[null, null, null]]);
});

test('coalesce picks the first non-NULL value', () => {
  assert.deepEqual(rows("SELECT name, coalesce(city, 'unknown') FROM customers WHERE id = 4"), [['Dee', 'unknown']]);
});

// ---- functions ----

test('scalar functions', () => {
  assert.deepEqual(rows("SELECT lower('AbC'), upper('AbC'), length('hello'), abs(-3), abs(2.5)"), [['abc', 'ABC', 5, 3, 2.5]]);
  assert.deepEqual(rows('SELECT lower(NULL), length(NULL), abs(NULL)'), [[null, null, null]]);
  assert.equal(one('length(12345)'), 5);
});

test('round rounds half away from zero, with optional digits', () => {
  assert.deepEqual(rows('SELECT round(2.5), round(-2.5), round(1.005, 2), round(1234.5678, 1), round(1250, -2)'), [[3, -3, 1.01, 1234.6, 1300]]);
  assert.match(err('SELECT round(1, 0.5)'), /round\(\) digits must be a whole number/);
});

test('function errors: unknown name, wrong argument count, misplaced DISTINCT', () => {
  assert.match(err('SELECT len(name) FROM customers'), /no such function len\(\) at 1:8/);
  assert.match(err('SELECT lower(name, 1) FROM customers'), /lower\(\) takes exactly 1 argument/);
  assert.match(err('SELECT round() FROM customers'), /round\(\) takes 1 or 2 arguments/);
  assert.match(err('SELECT upper(DISTINCT name) FROM customers'), /DISTINCT is only allowed inside aggregate/);
  assert.match(err('SELECT sum(*) FROM orders'), /only count\(\*\) takes \*/);
});

// ---- aggregates, GROUP BY, HAVING ----

test('aggregates over the whole table', () => {
  assert.deepEqual(rows('SELECT count(*), count(total), sum(total), min(total), max(total) FROM orders'), [[5, 4, 42.5, 5, 20.5]]);
  assert.deepEqual(rows('SELECT avg(total) FROM orders'), [[42.5 / 4]]);
});

test('aggregates over no rows: count is 0, the others NULL', () => {
  assert.deepEqual(rows('SELECT count(*), sum(total), avg(total), max(total) FROM orders WHERE id > 99'), [[0, null, null, null]]);
});

test('count(DISTINCT expr) and min/max of text', () => {
  assert.deepEqual(rows('SELECT count(DISTINCT city), min(name), max(name) FROM customers'), [[2, 'Ann', 'Dee']]);
});

test('sum of text is an error', () => {
  assert.match(err('SELECT sum(name) FROM customers'), /sum\(\) needs a number/);
});

test('GROUP BY makes one row per group, NULL forms its own group', () => {
  assert.deepEqual(rows('SELECT city, count(*) FROM customers GROUP BY city ORDER BY city'), [[null, 1], ['Oslo', 2], ['Rome', 1]]);
});

test('GROUP BY an expression, and select an expression of the group key', () => {
  assert.deepEqual(rows('SELECT upper(city), count(*) FROM customers WHERE city IS NOT NULL GROUP BY city ORDER BY 1'), [['OSLO', 2], ['ROME', 1]]);
  assert.deepEqual(rows('SELECT id % 2, count(*) FROM customers GROUP BY id % 2 ORDER BY 1'), [[0, 2], [1, 2]]);
});

test('GROUP BY a qualified or unqualified column matches either spelling in SELECT', () => {
  assert.deepEqual(rows('SELECT c.name, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY name ORDER BY 2 DESC, 1'), [
    ['Ann', 3], ['Bob', 1], ['Cid', 1],
  ]);
});

test('a bare column outside GROUP BY is an error', () => {
  assert.match(err('SELECT name, count(*) FROM customers'), /column "name" must be in GROUP BY or inside an aggregate function/);
  assert.match(err('SELECT city, name FROM customers GROUP BY city'), /column "name" must be in GROUP BY/);
  assert.match(err('SELECT * FROM customers GROUP BY city'), /must be in GROUP BY/);
});

test('aggregates are not allowed in WHERE or GROUP BY, and cannot nest', () => {
  assert.match(err('SELECT id FROM orders WHERE sum(total) > 1'), /aggregate function sum\(\) is not allowed in WHERE/);
  assert.match(err('SELECT 1 FROM orders GROUP BY count(*)'), /not allowed in GROUP BY/);
  assert.match(err('SELECT max(count(*)) FROM orders'), /cannot be nested/);
});

test('HAVING filters groups', () => {
  assert.deepEqual(rows('SELECT customer_id, sum(total) FROM orders GROUP BY customer_id HAVING count(*) > 1'), [[1, 37.5]]);
  assert.deepEqual(rows('SELECT customer_id FROM orders GROUP BY customer_id HAVING sum(total) >= 5 ORDER BY 1'), [[1], [2]]);
});

test('HAVING without GROUP BY treats the table as one group', () => {
  assert.deepEqual(rows('SELECT count(*) FROM orders HAVING count(*) > 3'), [[5]]);
  assert.deepEqual(rows('SELECT count(*) FROM orders HAVING count(*) > 9'), []);
});

test('aggregate arithmetic', () => {
  assert.deepEqual(rows('SELECT round(sum(total) / count(total), 3) FROM orders'), [[10.625]]);
});

test('SELECT aliases are not visible in WHERE', () => {
  assert.match(err('SELECT total * 2 AS dbl FROM orders WHERE dbl > 10'), /no such column "dbl" \(a SELECT alias can only be used in ORDER BY\)/);
});

// ---- DISTINCT ----

test('DISTINCT removes duplicate rows, NULLs count as equal', () => {
  assert.deepEqual(rows('SELECT DISTINCT city FROM customers ORDER BY city'), [[null], ['Oslo'], ['Rome']]);
  assert.deepEqual(rows('SELECT DISTINCT customer_id FROM orders ORDER BY 1'), [[1], [2], [3]]);
});

test('DISTINCT keeps 1 and \'1\' apart', () => {
  const t: Table[] = [{ name: 't', columns: ['v'], rows: [[1], ['1'], [1]] }];
  assert.deepEqual(rows('SELECT DISTINCT v FROM t', t), [[1], ['1']]);
});

// ---- ORDER BY ----

test('ORDER BY a column, ASC by default, DESC on request', () => {
  assert.deepEqual(rows('SELECT name FROM customers ORDER BY name DESC'), [['Dee'], ['Cid'], ['Bob'], ['Ann']]);
  assert.deepEqual(rows('SELECT name FROM customers ORDER BY id ASC'), [['Ann'], ['Bob'], ['Cid'], ['Dee']]);
});

test('ORDER BY an alias and by column number', () => {
  assert.deepEqual(rows('SELECT name, id * -1 AS neg FROM customers ORDER BY neg'), [['Dee', -4], ['Cid', -3], ['Bob', -2], ['Ann', -1]]);
  assert.deepEqual(rows('SELECT id, name FROM customers ORDER BY 2 DESC LIMIT 1'), [[4, 'Dee']]);
});

test('ORDER BY a column number after a star counts the expanded columns', () => {
  assert.deepEqual(rows('SELECT *, id * 10 AS k FROM customers ORDER BY k DESC LIMIT 1'), [[4, 'Dee', null, 40]]);
});

test('ORDER BY an expression that is not selected', () => {
  assert.deepEqual(rows('SELECT name FROM customers ORDER BY length(name) * -1, name LIMIT 2'), [['Ann'], ['Bob']]);
});

test('ORDER BY several keys; ties keep table order', () => {
  assert.deepEqual(rows('SELECT customer_id, id FROM orders WHERE total IS NOT NULL ORDER BY customer_id DESC, total'), [
    [2, 12], [1, 13], [1, 10], [1, 11],
  ]);
  assert.deepEqual(rows('SELECT id FROM orders ORDER BY customer_id'), [[10], [11], [13], [12], [14]]);
});

test('NULL sorts first ascending and last descending', () => {
  assert.deepEqual(rows('SELECT total FROM orders ORDER BY total').map((r) => r[0]), [null, 5, 7, 10, 20.5]);
  assert.deepEqual(rows('SELECT total FROM orders ORDER BY total DESC').map((r) => r[0]), [20.5, 10, 7, 5, null]);
});

test('ORDER BY an aggregate in a grouped query', () => {
  assert.deepEqual(rows('SELECT customer_id FROM orders GROUP BY customer_id ORDER BY count(*) DESC, customer_id LIMIT 1'), [[1]]);
});

test('ORDER BY column number out of range', () => {
  assert.match(err('SELECT name FROM customers ORDER BY 2'), /ORDER BY column number 2 is out of range \(the result has 1 column\)/);
});

// ---- LIMIT / OFFSET ----

test('LIMIT and OFFSET', () => {
  assert.deepEqual(rows('SELECT id FROM customers ORDER BY id LIMIT 2'), [[1], [2]]);
  assert.deepEqual(rows('SELECT id FROM customers ORDER BY id LIMIT 2 OFFSET 3'), [[4]]);
  assert.deepEqual(rows('SELECT id FROM customers LIMIT 0'), []);
});

test('LIMIT must be a whole number of 0 or more', () => {
  assert.match(err('SELECT id FROM customers LIMIT -1'), /LIMIT must be a whole number/);
  assert.match(err('SELECT id FROM customers LIMIT 1.5'), /LIMIT must be a whole number/);
  assert.match(err('SELECT id FROM customers LIMIT id'), /no such column "id"/);
});

// ---- limits ----

const big: Table[] = [{ name: 'n', columns: ['v'], rows: Array.from({ length: 30 }, (_, i) => [i]) }];

test('too many intermediate rows is a clear error', () => {
  assert.match(err('SELECT count(*) FROM n a, n b, n c', big), /too many rows: more than 10,000 intermediate rows/);
});

test('too many evaluation steps is a clear error, never a hang', () => {
  const sql = 'SELECT count(*) FROM n a, n b WHERE ' + Array.from({ length: 60 }, (_, i) => `a.v + b.v <> ${i + 1000}`).join(' AND ');
  const t0 = Date.now();
  assert.match(err(sql, big), /too expensive: it needs more than 200,000 evaluation steps/);
  assert.ok(Date.now() - t0 < 2000);
});

test('limits can be tightened by the caller', () => {
  assert.throws(() => runQuery('SELECT * FROM n', big, { maxRows: 10, maxSteps: 1_000_000 }), /more than 10 intermediate rows/);
  assert.throws(() => runQuery('SELECT v + 1 FROM n', big, { maxRows: 10_000, maxSteps: 50 }), /more than 50 evaluation steps/);
});
