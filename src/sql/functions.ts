// Scalar operators and functions over the value model. Pure, no limits; the evaluator counts the steps.

import type { BinaryOp } from './ast.ts';
import { errorAt } from './errors.ts';
import type { Pos } from './errors.ts';
import { sortCompare, typeName } from './values.ts';
import type { Value } from './values.ts';

export const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);

/** name -> [min args, max args] */
export const SCALARS: Record<string, [number, number]> = {
  lower: [1, 1],
  upper: [1, 1],
  length: [1, 1],
  abs: [1, 1],
  round: [1, 2],
  coalesce: [1, Infinity],
};

const show = (v: Value): string => (typeof v === 'string' ? `'${v.length > 20 ? v.slice(0, 20) + '…' : v}'` : String(v));

/** Normalizes a numeric result: non-finite becomes NULL, -0 becomes 0. */
function num(n: number): Value {
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n;
}

function needNumber(v: Value, what: string, pos: Pos): number {
  if (typeof v !== 'number') throw errorAt(`${what} needs a number, got text ${show(v)}`, pos);
  return v;
}

/** Truth value for WHERE / HAVING / ON / AND / OR / NOT: true, false, or null (unknown). */
export function truth(v: Value, pos: Pos): boolean | null {
  if (v === null) return null;
  if (typeof v === 'number') return v !== 0;
  throw errorAt(`expected a true/false condition, got text ${show(v)}`, pos);
}

export const bool = (b: boolean | null): Value => (b === null ? null : b ? 1 : 0);

export function compareOp(op: BinaryOp, a: Value, b: Value, pos: Pos): Value {
  if (a === null || b === null) return null;
  if (op === '=') return a === b ? 1 : 0;
  if (op === '!=') return a !== b ? 1 : 0;
  if (typeof a !== typeof b) throw errorAt(`cannot compare ${typeName(a)} ${show(a)} with ${typeName(b)} ${show(b)} using ${op}`, pos);
  switch (op) {
    case '<': return a < b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    default: throw errorAt(`unknown comparison ${op}`, pos);
  }
}

export function arithmetic(op: BinaryOp, a: Value, b: Value, pos: Pos): Value {
  if (op === '||') return a === null || b === null ? null : String(a) + String(b);
  if (a === null || b === null) return null;
  const x = needNumber(a, `"${op}"`, pos);
  const y = needNumber(b, `"${op}"`, pos);
  switch (op) {
    case '+': return num(x + y);
    case '-': return num(x - y);
    case '*': return num(x * y);
    case '/': return y === 0 ? null : num(x / y);
    case '%': return y === 0 ? null : num(x % y);
    default: throw errorAt(`unknown operator ${op}`, pos);
  }
}

export function negate(v: Value, pos: Pos): Value {
  if (v === null) return null;
  return num(-needNumber(v, 'unary minus', pos));
}

export function logicalAnd(a: boolean | null, b: boolean | null): Value {
  if (a === false || b === false) return 0;
  if (a === null || b === null) return null;
  return 1;
}

export function logicalOr(a: boolean | null, b: boolean | null): Value {
  if (a === true || b === true) return 1;
  if (a === null || b === null) return null;
  return 0;
}

export function logicalNot(a: boolean | null): Value {
  return a === null ? null : a ? 0 : 1;
}

/**
 * Wildcard match without regular expressions (no catastrophic backtracking): % is any run, _ is one character.
 * Greedy with a single backtrack point, so the work is at most |text| x |pattern| character steps.
 */
function wildcardMatch(text: string[], pattern: string[]): boolean {
  let t = 0;
  let p = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '_' || (pattern[p] !== '%' && pattern[p] === text[t]))) {
      t++;
      p++;
    } else if (p < pattern.length && pattern[p] === '%') {
      starP = p++;
      starT = t;
    } else if (starP >= 0) {
      p = starP + 1;
      t = ++starT;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '%') p++;
  return p === pattern.length;
}

/** LIKE: % matches any run of characters, _ matches one character. Case-insensitive. */
export function like(value: Value, pattern: Value): Value {
  if (value === null || pattern === null) return null;
  return wildcardMatch(Array.from(String(value).toLowerCase()), Array.from(String(pattern).toLowerCase())) ? 1 : 0;
}

/** Evaluation steps charged for one LIKE, so long strings against long patterns hit the step limit instead of the CPU. */
export function likeCost(value: Value, pattern: Value): number {
  if (value === null || pattern === null) return 0;
  return Math.ceil((String(value).length * String(pattern).length) / 100);
}

/** x IN (list) with SQL NULL rules: no match and a NULL in the list (or x NULL) gives NULL. */
export function inList(x: Value, list: Value[]): Value {
  if (x === null) return null;
  let sawNull = false;
  for (const v of list) {
    if (v === null) sawNull = true;
    else if (v === x) return 1;
  }
  return sawNull ? null : 0;
}

export function between(x: Value, low: Value, high: Value, pos: Pos): Value {
  const lo = compareOp('>=', x, low, pos);
  const hi = compareOp('<=', x, high, pos);
  return logicalAnd(lo === null ? null : lo === 1, hi === null ? null : hi === 1);
}


function roundTo(x: number, digits: number): number {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  let r = Number(Math.round(Number(`${abs}e${digits}`)) + `e${-digits}`);
  if (!Number.isFinite(r)) {
    const f = 10 ** digits;
    r = Math.round(abs * f) / f;
  }
  return sign * r;
}

export function callScalar(name: string, args: Value[], pos: Pos): Value {
  switch (name) {
    case 'lower': return args[0] === null ? null : String(args[0]).toLowerCase();
    case 'upper': return args[0] === null ? null : String(args[0]).toUpperCase();
    case 'length': return args[0] === null ? null : String(args[0]).length;
    case 'abs': return args[0] === null ? null : num(Math.abs(needNumber(args[0], 'abs()', pos)));
    case 'round': {
      if (args[0] === null || (args.length > 1 && args[1] === null)) return null;
      const x = needNumber(args[0], 'round()', pos);
      const d = args.length > 1 ? needNumber(args[1], 'round()', pos) : 0;
      if (!Number.isInteger(d) || d < -15 || d > 15) throw errorAt('round() digits must be a whole number from -15 to 15', pos);
      return num(roundTo(x, d));
    }
    case 'coalesce': {
      for (const a of args) if (a !== null) return a;
      return null;
    }
    default:
      throw errorAt(`no such function ${name}()`, pos);
  }
}

/** Aggregate over the non-NULL values of a group (count(*) is handled by the caller). */
export function callAggregate(name: string, values: Value[], pos: Pos): Value {
  switch (name) {
    case 'count': return values.length;
    case 'sum':
    case 'avg': {
      if (values.length === 0) return null;
      let total = 0;
      for (const v of values) total += needNumber(v, `${name}()`, pos);
      return num(name === 'sum' ? total : total / values.length);
    }
    case 'min':
    case 'max': {
      if (values.length === 0) return null;
      let best = values[0];
      for (const v of values) {
        const c = sortCompare(v, best);
        if (name === 'min' ? c < 0 : c > 0) best = v;
      }
      return best;
    }
    default:
      throw errorAt(`no such aggregate ${name}()`, pos);
  }
}
