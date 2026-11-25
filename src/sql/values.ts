// The value model: every SQL value is a JavaScript number, a string, or null (SQL NULL).
// Booleans are numbers: comparisons give 1 (true), 0 (false) or null (unknown).

export type Value = number | string | null;

export interface Table {
  name: string;
  columns: string[];
  rows: Value[][];
}

export interface QueryResult {
  columns: string[];
  rows: Value[][];
}

export function typeName(v: Value): string {
  if (v === null) return 'NULL';
  return typeof v === 'number' ? 'number' : 'text';
}

/** Equality used for GROUP BY, DISTINCT, IN lists and result matching. Here NULL equals NULL. */
export function valuesEqual(a: Value, b: Value): boolean {
  return a === b;
}

/** Total order used by ORDER BY, min() and max(): NULL first, then numbers, then text. */
export function sortCompare(a: Value, b: Value): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A string key that is equal for two rows exactly when every value is equal (numbers and text stay apart). */
export function rowKey(row: readonly Value[]): string {
  return JSON.stringify(row);
}

export function formatValue(v: Value): string {
  if (v === null) return 'NULL';
  return String(v);
}

export function isValue(v: unknown): v is Value {
  return v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}
