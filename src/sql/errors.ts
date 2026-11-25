// Every error the engine raises is a SqlError. When the problem has a place in the query text,
// the message ends with that place as line:column (1-based), and `line`/`col` carry it too.

export interface Pos {
  offset: number;
  line: number;
  col: number;
}

export class SqlError extends Error {
  readonly line: number | null;
  readonly col: number | null;

  constructor(message: string, pos?: Pos | null) {
    super(message);
    this.name = 'SqlError';
    this.line = pos ? pos.line : null;
    this.col = pos ? pos.col : null;
  }
}

/** `near "FORM" at 1:10: expected FROM` */
export function syntaxError(near: string, pos: Pos, detail: string): SqlError {
  const what = near === '' ? 'end of query' : `"${near}"`;
  const where = near === '' ? `at the ${what} (${pos.line}:${pos.col})` : `near ${what} at ${pos.line}:${pos.col}`;
  return new SqlError(`${where}: ${detail}`, pos);
}

/** `no such column "nme" at 1:8` */
export function errorAt(message: string, pos: Pos): SqlError {
  return new SqlError(`${message} at ${pos.line}:${pos.col}`, pos);
}
