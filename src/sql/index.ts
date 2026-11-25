// SQL Duel's SELECT engine. Pure TypeScript with no dependencies: the Worker uses it to check submissions,
// and the browser loads the same code (emitted to public/engine) for the live preview.

export { SqlError } from './errors.ts';
export type { Pos } from './errors.ts';
export { tokenize, KEYWORDS, UNSUPPORTED } from './tokenizer.ts';
export type { Token, TokenKind } from './tokenizer.ts';
export { parse, MAX_QUERY_LENGTH } from './parser.ts';
export type * from './ast.ts';
export { runQuery, execute, DEFAULT_LIMITS } from './evaluator.ts';
export type { Limits } from './evaluator.ts';
export { resultsMatch, queryLength, normalizeQuery, formatTable } from './match.ts';
export type { MatchVerdict } from './match.ts';
export { formatValue, isValue, rowKey, sortCompare, typeName, valuesEqual } from './values.ts';
export type { QueryResult, Table, Value } from './values.ts';
