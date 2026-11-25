// Result matching and the "shortest query" length rule.

import { rowKey } from './values.ts';
import type { QueryResult, Value } from './values.ts';

export interface MatchVerdict {
  ok: boolean;
  /** Short, player-facing reason when ok is false. */
  reason: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Same column count, same rows as a multiset; row order matters only when `ordered`.
 * Column names are ignored. Values compare with the engine's equality (numbers and text never equal each other).
 */
export function resultsMatch(actual: QueryResult, target: QueryResult, ordered: boolean): MatchVerdict {
  const want = target.columns.length;
  const got = actual.columns.length;
  if (got !== want) return { ok: false, reason: `Your result has ${plural(got, 'column')}; the target has ${want}.` };
  if (actual.rows.length !== target.rows.length) {
    return { ok: false, reason: `Your result has ${plural(actual.rows.length, 'row')}; the target has ${target.rows.length}.` };
  }
  const counts = new Map<string, number>();
  for (const r of target.rows) {
    const k = rowKey(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const r of actual.rows) {
    const k = rowKey(r);
    const n = counts.get(k) ?? 0;
    if (n === 0) return { ok: false, reason: 'Some rows or values differ from the target.' };
    counts.set(k, n - 1);
  }
  if (ordered) {
    for (let i = 0; i < actual.rows.length; i++) {
      if (rowKey(actual.rows[i]) !== rowKey(target.rows[i])) {
        return { ok: false, reason: 'The rows are right, but the target needs them in a specific order.' };
      }
    }
  }
  return { ok: true, reason: '' };
}

/** Length used for the shortest-query bonus: trimmed, with every whitespace run collapsed to one space. */
export function queryLength(sql: string): number {
  return normalizeQuery(sql).length;
}

export function normalizeQuery(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ');
}

/** Plain-text table for the CLI and for debugging. */
export function formatTable(result: QueryResult): string {
  const cell = (v: Value): string => (v === null ? 'NULL' : String(v));
  const head = result.columns;
  const body = result.rows.map((r) => r.map(cell));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const isNum = head.map((_, i) => result.rows.length > 0 && result.rows.every((r) => r[i] === null || typeof r[i] === 'number'));
  const line = (cells: string[], align: boolean): string =>
    '| ' + cells.map((c, i) => (align && isNum[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(' | ') + ' |';
  const rule = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const out = [rule, line(head, false), rule, ...body.map((r) => line(r, true)), rule];
  out.push(`(${plural(result.rows.length, 'row')})`);
  return out.join('\n');
}
