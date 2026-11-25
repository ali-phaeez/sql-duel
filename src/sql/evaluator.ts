// Evaluator: Select AST + in-memory tables -> result table.
//
// Pipeline: FROM/JOIN (nested loops) -> WHERE -> GROUP BY/HAVING -> SELECT -> DISTINCT -> ORDER BY -> LIMIT/OFFSET.
// Before any row is read, every expression is "bound": column names are resolved to positions in the joined row,
// functions are checked, and in grouped queries every bare column must be a GROUP BY expression.
// Hard limits: intermediate rows and evaluation steps. Exceeding either throws a SqlError; nothing can loop forever.

import type { Expr, Select } from './ast.ts';
import { errorAt, SqlError } from './errors.ts';
import type { Pos } from './errors.ts';
import {
  AGGREGATES, arithmetic, between, bool, callAggregate, callScalar, compareOp, inList, like,
  logicalAnd, logicalNot, logicalOr, negate, SCALARS, truth,
} from './functions.ts';
import { parse } from './parser.ts';
import { rowKey, sortCompare } from './values.ts';
import type { QueryResult, Table, Value } from './values.ts';

export interface Limits {
  maxRows: number;
  maxSteps: number;
}

export const DEFAULT_LIMITS: Limits = { maxRows: 10_000, maxSteps: 200_000 };

/** Parses and runs one SELECT against the given tables. Throws SqlError on any problem. */
export function runQuery(sql: string, tables: readonly Table[], limits: Limits = DEFAULT_LIMITS): QueryResult {
  return execute(parse(sql), tables, limits);
}

// ---- bound expressions ----

type B =
  | { k: 'lit'; v: Value; pos: Pos }
  | { k: 'col'; i: number; pos: Pos }
  | { k: 'gkey'; i: number; pos: Pos }
  | { k: 'neg'; e: B; pos: Pos }
  | { k: 'not'; e: B; pos: Pos }
  | { k: 'bin'; op: Extract<Expr, { kind: 'binary' }>['op']; l: B; r: B; pos: Pos }
  | { k: 'like'; e: B; p: B; not: boolean; pos: Pos }
  | { k: 'in'; e: B; list: B[]; not: boolean; pos: Pos }
  | { k: 'between'; e: B; lo: B; hi: B; not: boolean; pos: Pos }
  | { k: 'isnull'; e: B; not: boolean; pos: Pos }
  | { k: 'fn'; name: string; args: B[]; pos: Pos }
  | { k: 'agg'; name: string; arg: B | null; distinct: boolean; pos: Pos };

interface Source {
  name: string;
  key: string;
  table: Table;
  offset: number;
  pos: Pos;
}

interface BindCtx {
  sources: Source[];
  clause: string;
  grouped: boolean;
  groupKeys: string[];
  inAgg: boolean;
  aliases: Set<string>;
}

interface Group {
  keys: Value[];
  rows: Value[][];
}

function keyOf(b: B): string {
  switch (b.k) {
    case 'lit': return `L${JSON.stringify(b.v)}`;
    case 'col': return `C${b.i}`;
    case 'gkey': return `G${b.i}`;
    case 'neg':
    case 'not': return `${b.k}(${keyOf(b.e)})`;
    case 'bin': return `(${keyOf(b.l)} ${b.op} ${keyOf(b.r)})`;
    case 'like': return `like${b.not ? '!' : ''}(${keyOf(b.e)},${keyOf(b.p)})`;
    case 'in': return `in${b.not ? '!' : ''}(${keyOf(b.e)};${b.list.map(keyOf).join(',')})`;
    case 'between': return `btw${b.not ? '!' : ''}(${keyOf(b.e)},${keyOf(b.lo)},${keyOf(b.hi)})`;
    case 'isnull': return `isnull${b.not ? '!' : ''}(${keyOf(b.e)})`;
    case 'fn': return `${b.name}(${b.args.map(keyOf).join(',')})`;
    case 'agg': return `${b.name}${b.distinct ? '!' : ''}(${b.arg ? keyOf(b.arg) : '*'})`;
  }
}

function containsAggregate(e: Expr): boolean {
  switch (e.kind) {
    case 'literal':
    case 'column': return false;
    case 'unary': return containsAggregate(e.expr);
    case 'binary': return containsAggregate(e.left) || containsAggregate(e.right);
    case 'like': return containsAggregate(e.expr) || containsAggregate(e.pattern);
    case 'in': return containsAggregate(e.expr) || e.list.some(containsAggregate);
    case 'between': return containsAggregate(e.expr) || containsAggregate(e.low) || containsAggregate(e.high);
    case 'isnull': return containsAggregate(e.expr);
    case 'call': return AGGREGATES.has(e.name) || e.args.some(containsAggregate);
  }
}

const colLabel = (table: string | null, name: string): string => (table ? `${table}.${name}` : name);

function resolveColumn(e: Extract<Expr, { kind: 'column' }>, ctx: BindCtx): number {
  const name = e.name.toLowerCase();
  if (e.table !== null) {
    const tkey = e.table.toLowerCase();
    const src = ctx.sources.find((s) => s.key === tkey);
    if (!src) {
      const renamed = ctx.sources.find((s) => s.table.name.toLowerCase() === tkey);
      const hint = renamed ? ` (it is called "${renamed.name}" in this query)` : '';
      throw errorAt(`no such table or alias "${e.table}"${hint}`, e.pos);
    }
    const ci = src.table.columns.findIndex((c) => c.toLowerCase() === name);
    if (ci < 0) throw errorAt(`no such column "${colLabel(e.table, e.name)}"`, e.pos);
    return src.offset + ci;
  }
  const hits: { src: Source; ci: number }[] = [];
  for (const src of ctx.sources) {
    const ci = src.table.columns.findIndex((c) => c.toLowerCase() === name);
    if (ci >= 0) hits.push({ src, ci });
  }
  if (hits.length === 1) return hits[0].src.offset + hits[0].ci;
  if (hits.length > 1) {
    throw errorAt(`ambiguous column name "${e.name}" (it is in ${hits.map((h) => h.src.name).join(' and ')}; write table.${e.name})`, e.pos);
  }
  if (ctx.aliases.has(name)) {
    throw errorAt(`no such column "${e.name}" (a SELECT alias can only be used in ORDER BY)`, e.pos);
  }
  throw errorAt(`no such column "${e.name}"`, e.pos);
}

function bind(e: Expr, ctx: BindCtx): B {
  if (ctx.grouped && !ctx.inAgg && !containsAggregate(e)) {
    const rowBound = bind(e, { ...ctx, grouped: false });
    const gi = ctx.groupKeys.indexOf(keyOf(rowBound));
    if (gi >= 0) return { k: 'gkey', i: gi, pos: e.pos };
    if (e.kind === 'literal') return rowBound;
    if (e.kind === 'column') {
      throw errorAt(`column "${colLabel(e.table, e.name)}" must be in GROUP BY or inside an aggregate function such as count() or max()`, e.pos);
    }
  }
  switch (e.kind) {
    case 'literal': return { k: 'lit', v: e.value, pos: e.pos };
    case 'column': return { k: 'col', i: resolveColumn(e, ctx), pos: e.pos };
    case 'unary': return { k: e.op === '-' ? 'neg' : 'not', e: bind(e.expr, ctx), pos: e.pos };
    case 'binary': return { k: 'bin', op: e.op, l: bind(e.left, ctx), r: bind(e.right, ctx), pos: e.pos };
    case 'like': return { k: 'like', e: bind(e.expr, ctx), p: bind(e.pattern, ctx), not: e.not, pos: e.pos };
    case 'in': return { k: 'in', e: bind(e.expr, ctx), list: e.list.map((x) => bind(x, ctx)), not: e.not, pos: e.pos };
    case 'between':
      return { k: 'between', e: bind(e.expr, ctx), lo: bind(e.low, ctx), hi: bind(e.high, ctx), not: e.not, pos: e.pos };
    case 'isnull': return { k: 'isnull', e: bind(e.expr, ctx), not: e.not, pos: e.pos };
    case 'call': return bindCall(e, ctx);
  }
}

function bindCall(e: Extract<Expr, { kind: 'call' }>, ctx: BindCtx): B {
  if (AGGREGATES.has(e.name)) {
    if (ctx.inAgg) throw errorAt(`aggregate functions cannot be nested (${e.name}() inside another aggregate)`, e.pos);
    if (!ctx.grouped) throw errorAt(`aggregate function ${e.name}() is not allowed in ${ctx.clause}`, e.pos);
    if (e.star) {
      if (e.name !== 'count') throw errorAt(`${e.name}(*) is not valid; only count(*) takes *`, e.pos);
      return { k: 'agg', name: 'count', arg: null, distinct: false, pos: e.pos };
    }
    if (e.args.length !== 1) throw errorAt(`${e.name}() takes exactly one argument`, e.pos);
    const arg = bind(e.args[0], { ...ctx, grouped: false, inAgg: true });
    return { k: 'agg', name: e.name, arg, distinct: e.distinct, pos: e.pos };
  }
  const arity = SCALARS[e.name];
  if (!arity) throw errorAt(`no such function ${e.name}()`, e.pos);
  if (e.star) throw errorAt(`${e.name}(*) is not valid`, e.pos);
  if (e.distinct) throw errorAt(`DISTINCT is only allowed inside aggregate functions`, e.pos);
  const [min, max] = arity;
  if (e.args.length < min || e.args.length > max) {
    const want = min === max ? `exactly ${min}` : max === Infinity ? `at least ${min}` : `${min} or ${max}`;
    throw errorAt(`${e.name}() takes ${want} argument${min === 1 && max === 1 ? '' : 's'}`, e.pos);
  }
  return { k: 'fn', name: e.name, args: e.args.map((a) => bind(a, ctx)), pos: e.pos };
}

// ---- execution ----

class Machine {
  private steps = 0;
  private readonly limits: Limits;

  constructor(limits: Limits) {
    this.limits = limits;
  }

  tick(n = 1): void {
    this.steps += n;
    if (this.steps > this.limits.maxSteps) {
      throw new SqlError(`Query is too expensive: it needs more than ${this.limits.maxSteps.toLocaleString('en-US')} evaluation steps`);
    }
  }

  checkRows(n: number): void {
    if (n > this.limits.maxRows) {
      throw new SqlError(`Query produces too many rows: more than ${this.limits.maxRows.toLocaleString('en-US')} intermediate rows (check your join conditions)`);
    }
  }

  cond(b: B, row: Value[], group: Group | null): boolean | null {
    return truth(this.eval(b, row, group), b.pos);
  }

  eval(b: B, row: Value[], group: Group | null): Value {
    this.tick();
    switch (b.k) {
      case 'lit': return b.v;
      case 'col': return row[b.i] ?? null;
      case 'gkey': return group ? group.keys[b.i] : null;
      case 'neg': return negate(this.eval(b.e, row, group), b.pos);
      case 'not': return logicalNot(this.cond(b.e, row, group));
      case 'bin': {
        if (b.op === 'AND') {
          const l = this.cond(b.l, row, group);
          if (l === false) return 0;
          return logicalAnd(l, this.cond(b.r, row, group));
        }
        if (b.op === 'OR') {
          const l = this.cond(b.l, row, group);
          if (l === true) return 1;
          return logicalOr(l, this.cond(b.r, row, group));
        }
        const l = this.eval(b.l, row, group);
        const r = this.eval(b.r, row, group);
        if (b.op === '=' || b.op === '!=' || b.op === '<' || b.op === '<=' || b.op === '>' || b.op === '>=') {
          return compareOp(b.op, l, r, b.pos);
        }
        return arithmetic(b.op, l, r, b.pos);
      }
      case 'like': {
        const v = like(this.eval(b.e, row, group), this.eval(b.p, row, group));
        return b.not ? logicalNot(v === null ? null : v === 1) : v;
      }
      case 'in': {
        const x = this.eval(b.e, row, group);
        const v = inList(x, b.list.map((item) => this.eval(item, row, group)));
        return b.not ? logicalNot(v === null ? null : v === 1) : v;
      }
      case 'between': {
        const v = between(this.eval(b.e, row, group), this.eval(b.lo, row, group), this.eval(b.hi, row, group), b.pos);
        return b.not ? logicalNot(v === null ? null : v === 1) : v;
      }
      case 'isnull': {
        const isNull = this.eval(b.e, row, group) === null;
        return bool(b.not ? !isNull : isNull);
      }
      case 'fn': return callScalar(b.name, b.args.map((a) => this.eval(a, row, group)), b.pos);
      case 'agg': {
        const rows = group ? group.rows : [];
        this.tick(rows.length);
        if (b.arg === null) return rows.length;
        let values: Value[] = [];
        for (const r of rows) {
          const v = this.eval(b.arg, r, null);
          if (v !== null) values.push(v);
        }
        if (b.distinct) {
          const seen = new Set<string>();
          values = values.filter((v) => {
            const k = rowKey([v]);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        return callAggregate(b.name, values, b.pos);
      }
    }
  }
}

function constantInt(e: Expr, what: string, machine: Machine): number {
  const ctx: BindCtx = { sources: [], clause: what, grouped: false, groupKeys: [], inAgg: false, aliases: new Set() };
  const v = machine.eval(bind(e, ctx), [], null);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw errorAt(`${what} must be a whole number of 0 or more`, e.pos);
  }
  return v;
}

export function execute(q: Select, tables: readonly Table[], limits: Limits = DEFAULT_LIMITS): QueryResult {
  const machine = new Machine(limits);

  // FROM: resolve tables and give every source its slice of the joined row.
  const sources: Source[] = [];
  let width = 0;
  for (const item of q.from) {
    const table = tables.find((t) => t.name.toLowerCase() === item.table.toLowerCase());
    if (!table) {
      const names = tables.map((t) => t.name).join(', ');
      throw errorAt(`no such table "${item.table}"${names ? ` (tables here: ${names})` : ''}`, item.pos);
    }
    const name = item.alias ?? table.name;
    const key = name.toLowerCase();
    if (sources.some((s) => s.key === key)) {
      throw errorAt(`the name "${name}" is used twice in FROM; give one of them an alias with AS`, item.pos);
    }
    sources.push({ name, key, table, offset: width, pos: item.pos });
    width += table.columns.length;
  }

  const aliases = new Set<string>();
  for (const it of q.items) if (it.kind === 'expr' && it.alias) aliases.add(it.alias.toLowerCase());
  const rowCtx = (clause: string, visible: Source[] = sources): BindCtx => ({
    sources: visible, clause, grouped: false, groupKeys: [], inAgg: false, aliases,
  });

  const ons = q.from.map((item, idx) => (item.on ? bind(item.on, rowCtx('ON', sources.slice(0, idx + 1))) : null));
  const where = q.where ? bind(q.where, rowCtx('WHERE')) : null;

  const grouped = q.groupBy.length > 0 || q.having !== null ||
    q.items.some((it) => it.kind === 'expr' && containsAggregate(it.expr)) ||
    q.orderBy.some((o) => containsAggregate(o.expr));
  const groupBy = q.groupBy.map((g) => bind(g, rowCtx('GROUP BY')));
  const outCtx: BindCtx = { sources, clause: 'SELECT', grouped, groupKeys: groupBy.map(keyOf), inAgg: false, aliases };

  // SELECT list: expand stars into column references, then bind.
  const columns: string[] = [];
  const outputs: B[] = [];
  for (const it of q.items) {
    if (it.kind === 'star') {
      let chosen = sources;
      if (it.table !== null) {
        const tkey = it.table.toLowerCase();
        chosen = sources.filter((s) => s.key === tkey);
        if (chosen.length === 0) throw errorAt(`no such table or alias "${it.table}"`, it.pos);
      } else if (sources.length === 0) {
        throw errorAt('SELECT * needs a FROM clause', it.pos);
      }
      for (const s of chosen) {
        for (const c of s.table.columns) {
          columns.push(c);
          outputs.push(bind({ kind: 'column', table: s.name, name: c, pos: it.pos }, outCtx));
        }
      }
    } else {
      outputs.push(bind(it.expr, outCtx));
      const e = it.expr;
      if (it.alias) columns.push(it.alias);
      else if (e.kind === 'column') {
        columns.push(columnNameAt(sources, resolveColumn(e, { ...outCtx, grouped: false })));
      } else columns.push(it.text);
    }
  }
  const having = q.having ? bind(q.having, { ...outCtx, clause: 'HAVING' }) : null;

  // ORDER BY: a column number, a SELECT alias, or any expression.
  const order: { out: number; b: B | null; desc: boolean }[] = q.orderBy.map((o) => {
    const e = o.expr;
    if (e.kind === 'literal' && typeof e.value === 'number') {
      if (!Number.isInteger(e.value) || e.value < 1 || e.value > columns.length) {
        throw errorAt(`ORDER BY column number ${e.value} is out of range (the result has ${columns.length} column${columns.length === 1 ? '' : 's'})`, e.pos);
      }
      return { out: e.value - 1, b: null, desc: o.desc };
    }
    if (e.kind === 'column' && e.table === null) {
      const ai = q.items.findIndex((it) => it.kind === 'expr' && it.alias !== null && it.alias.toLowerCase() === e.name.toLowerCase());
      if (ai >= 0) return { out: outputIndexOfItem(q, sources, ai), b: null, desc: o.desc };
    }
    return { out: -1, b: bind(e, { ...outCtx, clause: 'ORDER BY' }), desc: o.desc };
  });

  const limit = q.limit ? constantInt(q.limit, 'LIMIT', machine) : null;
  const offset = q.offset ? constantInt(q.offset, 'OFFSET', machine) : 0;

  // FROM / JOIN
  let rows: Value[][] = [[]];
  sources.forEach((src, idx) => {
    const next: Value[][] = [];
    const on = ons[idx];
    for (const left of rows) {
      for (const right of src.table.rows) {
        machine.tick();
        const joined = left.concat(right);
        if (on && machine.cond(on, joined, null) !== true) continue;
        next.push(joined);
        machine.checkRows(next.length);
      }
    }
    rows = next;
  });

  // WHERE
  if (where) rows = rows.filter((r) => machine.cond(where, r, null) === true);

  // GROUP BY / HAVING / SELECT
  const records: { values: Value[]; sort: Value[] }[] = [];
  const emit = (row: Value[], group: Group | null): void => {
    const values = outputs.map((b) => machine.eval(b, row, group));
    const sort = order.map((o) => (o.b ? machine.eval(o.b, row, group) : values[o.out]));
    records.push({ values, sort });
  };
  if (grouped) {
    const groups = new Map<string, Group>();
    if (groupBy.length === 0) groups.set('', { keys: [], rows });
    for (const r of groupBy.length ? rows : []) {
      const keys = groupBy.map((g) => machine.eval(g, r, null));
      const k = rowKey(keys);
      let g = groups.get(k);
      if (!g) {
        g = { keys, rows: [] };
        groups.set(k, g);
      }
      g.rows.push(r);
    }
    for (const g of groups.values()) {
      if (having && machine.cond(having, [], g) !== true) continue;
      emit([], g);
    }
  } else {
    for (const r of rows) emit(r, null);
  }

  // DISTINCT
  let result = records;
  if (q.distinct) {
    const seen = new Set<string>();
    result = records.filter((rec) => {
      machine.tick();
      const k = rowKey(rec.values);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ORDER BY (stable: ties keep their earlier order)
  if (order.length) {
    result = result.slice().sort((a, b) => {
      machine.tick();
      for (let i = 0; i < order.length; i++) {
        const c = sortCompare(a.sort[i], b.sort[i]);
        if (c !== 0) return order[i].desc ? -c : c;
      }
      return 0;
    });
  }

  // LIMIT / OFFSET
  const end = limit === null ? undefined : offset + limit;
  const out = result.slice(offset, end).map((rec) => rec.values);
  return { columns, rows: out };
}

function columnNameAt(sources: Source[], idx: number): string {
  for (const s of sources) {
    if (idx >= s.offset && idx < s.offset + s.table.columns.length) return s.table.columns[idx - s.offset];
  }
  return '?';
}

/** Index in the output row of SELECT item number `itemIndex` (stars before it expand to several columns). */
function outputIndexOfItem(q: Select, sources: Source[], itemIndex: number): number {
  let n = 0;
  for (let i = 0; i < itemIndex; i++) {
    const it = q.items[i];
    if (it.kind === 'expr') n++;
    else {
      const chosen = it.table === null ? sources : sources.filter((s) => s.key === it.table!.toLowerCase());
      for (const s of chosen) n += s.table.columns.length;
    }
  }
  return n;
}
