// Tokenizer: query text -> tokens with positions. Keywords and identifiers are case-insensitive.

import { syntaxError } from './errors.ts';
import type { Pos } from './errors.ts';

export type TokenKind = 'keyword' | 'ident' | 'number' | 'string' | 'op' | 'eof';

export interface Token {
  kind: TokenKind;
  /** keyword: upper case · ident: as written (quotes removed) · string: content · op: the operator · number: the digits */
  text: string;
  /** Exact source slice, used in error messages. */
  raw: string;
  /** Only for numbers. */
  num: number;
  /** True for "double-quoted" identifiers, which are never keywords. */
  quoted: boolean;
  pos: Pos;
  end: number;
}

/** Words the parser understands. They cannot be used as bare identifiers (quote them: "order"). */
export const KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'FROM', 'AS', 'JOIN', 'INNER', 'ON', 'WHERE', 'GROUP', 'BY', 'HAVING',
  'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'AND', 'OR', 'NOT', 'LIKE', 'IN', 'BETWEEN', 'IS', 'NULL',
]);

/** Common SQL words this engine does not support. Reserved so the error names them instead of guessing. */
export const UNSUPPORTED = new Set([
  'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'USING', 'UNION', 'INTERSECT', 'EXCEPT', 'WITH',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'CAST', 'ESCAPE', 'INSERT', 'UPDATE', 'DELETE', 'DROP',
  'CREATE', 'ALTER', 'VALUES', 'INTO', 'SET', 'TABLE', 'WINDOW', 'OVER', 'PARTITION', 'FETCH',
]);

const TWO_CHAR_OPS = new Set(['<=', '>=', '<>', '!=', '==', '||']);
const ONE_CHAR_OPS = new Set(['=', '<', '>', '+', '-', '*', '/', '%', '(', ')', ',', '.', ';']);

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const posAt = (offset: number): Pos => ({ offset, line, col: offset - lineStart + 1 });
  const advanceTo = (to: number): void => {
    for (; i < to; i++) {
      if (sql[i] === '\n') {
        line++;
        lineStart = i + 1;
      }
    }
  };
  const push = (kind: TokenKind, text: string, start: Pos, end: number, num = 0, quoted = false): void => {
    tokens.push({ kind, text, raw: sql.slice(start.offset, end), num, quoted, pos: start, end });
  };

  while (i < sql.length) {
    const c = sql[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f') {
      advanceTo(i + 1);
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      advanceTo(nl === -1 ? sql.length : nl);
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const start = posAt(i);
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) throw syntaxError('/*', start, 'this comment is never closed with */');
      advanceTo(close + 2);
      continue;
    }
    const start = posAt(i);
    if (isDigit(c) || (c === '.' && isDigit(sql[i + 1] ?? ''))) {
      let j = i;
      while (j < sql.length && isDigit(sql[j])) j++;
      if (sql[j] === '.') {
        j++;
        while (j < sql.length && isDigit(sql[j])) j++;
      }
      const text = sql.slice(i, j);
      push('number', text, start, j, Number(text));
      advanceTo(j);
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < sql.length && isIdentPart(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      if (KEYWORDS.has(upper)) push('keyword', upper, start, j);
      else push('ident', word, start, j);
      advanceTo(j);
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= sql.length) {
          throw syntaxError(c, start, c === "'" ? 'this string is never closed with \'' : 'this quoted name is never closed with "');
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            text += c;
            j += 2;
            continue;
          }
          break;
        }
        text += sql[j];
        j++;
      }
      if (c === "'") push('string', text, start, j + 1);
      else {
        if (text === '') throw syntaxError('""', start, 'a quoted name cannot be empty');
        push('ident', text, start, j + 1, 0, true);
      }
      advanceTo(j + 1);
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push('op', two, start, i + 2);
      advanceTo(i + 2);
      continue;
    }
    if (ONE_CHAR_OPS.has(c)) {
      push('op', c, start, i + 1);
      advanceTo(i + 1);
      continue;
    }
    throw syntaxError(c, start, 'unexpected character');
  }
  tokens.push({ kind: 'eof', text: '', raw: '', num: 0, quoted: false, pos: posAt(sql.length), end: sql.length });
  return tokens;
}
