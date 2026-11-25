// Recursive-descent parser: tokens -> Select AST.
//
// Precedence, loosest first:
//   OR · AND · NOT · comparison (= == != <> < <= > >= IS LIKE IN BETWEEN) · || · + - · * / % · unary - · primary

import type { BinaryOp, Expr, FromItem, OrderItem, Select, SelectItem } from './ast.ts';
import { SqlError, syntaxError } from './errors.ts';
import type { Pos } from './errors.ts';
import { tokenize, UNSUPPORTED } from './tokenizer.ts';
import type { Token } from './tokenizer.ts';

export const MAX_QUERY_LENGTH = 2000;
const MAX_DEPTH = 100;

export function parse(sql: string): Select {
  if (sql.length > MAX_QUERY_LENGTH) {
    throw new SqlError(`Query is too long: ${sql.length} characters (the limit is ${MAX_QUERY_LENGTH})`);
  }
  return new Parser(sql, tokenize(sql)).parseStatement();
}

class Parser {
  private readonly sql: string;
  private readonly tokens: Token[];
  private i = 0;
  private depth = 0;

  constructor(sql: string, tokens: Token[]) {
    this.sql = sql;
    this.tokens = tokens;
  }

  // ---- token helpers ----

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.i + ahead, this.tokens.length - 1)];
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.i++;
    return t;
  }
  private isKw(word: string, ahead = 0): boolean {
    const t = this.peek(ahead);
    return t.kind === 'keyword' && t.text === word;
  }
  private isOp(op: string, ahead = 0): boolean {
    const t = this.peek(ahead);
    return t.kind === 'op' && t.text === op;
  }
  private acceptKw(word: string): boolean {
    if (!this.isKw(word)) return false;
    this.i++;
    return true;
  }
  private acceptOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.i++;
    return true;
  }
  private fail(detail: string, t: Token = this.peek()): SqlError {
    if (t.kind === 'ident' && !t.quoted && UNSUPPORTED.has(t.text.toUpperCase())) {
      return syntaxError(t.raw, t.pos, `${t.text.toUpperCase()} is not supported in SQL Duel (see the supported subset)`);
    }
    return syntaxError(t.raw, t.pos, detail);
  }
  private expectKw(word: string, detail = `expected ${word}`): Token {
    if (!this.isKw(word)) throw this.fail(detail);
    return this.next();
  }
  private expectOp(op: string, detail = `expected "${op}"`): Token {
    if (!this.isOp(op)) throw this.fail(detail);
    return this.next();
  }
  /** A plain or "quoted" identifier (not a keyword, not an unsupported word). */
  private isName(ahead = 0): boolean {
    const t = this.peek(ahead);
    return t.kind === 'ident' && (t.quoted || !UNSUPPORTED.has(t.text.toUpperCase()));
  }
  private expectName(detail: string): Token {
    if (!this.isName()) throw this.fail(detail);
    return this.next();
  }

  // ---- statement ----

  parseStatement(): Select {
    const first = this.peek();
    if (!this.isKw('SELECT')) {
      throw this.fail(first.kind === 'eof' ? 'type a SELECT query' : 'a query must start with SELECT');
    }
    const select = this.parseSelect();
    this.acceptOp(';');
    const rest = this.peek();
    if (rest.kind !== 'eof') {
      if (this.isOp(';', -1) || rest.kind === 'keyword' && rest.text === 'SELECT') {
        throw this.fail('only one SELECT statement is allowed', rest);
      }
      throw this.fail(this.expectedAfter(select), rest);
    }
    return select;
  }

  /** What could have come next, for the "unexpected token at the end" message. */
  private expectedAfter(s: Select): string {
    if (s.limit) return 'expected the end of the query';
    if (s.orderBy.length) return 'expected a comma, LIMIT or the end of the query';
    if (s.from.length === 0) return 'expected FROM, a comma, or AS before an alias';
    return 'expected WHERE, GROUP BY, ORDER BY, LIMIT, a JOIN or the end of the query';
  }

  private parseSelect(): Select {
    this.expectKw('SELECT');
    let distinct = false;
    if (this.acceptKw('DISTINCT')) distinct = true;
    else this.acceptKw('ALL');

    const items: SelectItem[] = [this.parseSelectItem()];
    while (this.acceptOp(',')) items.push(this.parseSelectItem());

    const from: FromItem[] = [];
    if (this.acceptKw('FROM')) {
      from.push(this.parseTableRef('first'));
      for (;;) {
        if (this.acceptOp(',')) from.push(this.parseTableRef('comma'));
        else if (this.isKw('JOIN') || this.isKw('INNER')) {
          if (this.acceptKw('INNER') && !this.isKw('JOIN')) throw this.fail('expected JOIN after INNER');
          this.expectKw('JOIN');
          const ref = this.parseTableRef('inner');
          this.expectKw('ON', 'expected ON and a join condition (JOIN ... ON a.id = b.id)');
          ref.on = this.parseExpr();
          from.push(ref);
        } else break;
      }
    } else if (!this.isKw('WHERE') && !this.isKw('GROUP') && !this.isKw('ORDER') && !this.isKw('LIMIT') &&
      !this.isOp(';') && this.peek().kind !== 'eof') {
      throw this.fail('expected FROM, a comma, or AS before an alias');
    }

    let where: Expr | null = null;
    if (this.acceptKw('WHERE')) where = this.parseExpr();

    const groupBy: Expr[] = [];
    if (this.acceptKw('GROUP')) {
      this.expectKw('BY', 'expected BY after GROUP');
      groupBy.push(this.parseExpr());
      while (this.acceptOp(',')) groupBy.push(this.parseExpr());
    }

    let having: Expr | null = null;
    if (this.acceptKw('HAVING')) having = this.parseExpr();

    const orderBy: OrderItem[] = [];
    if (this.acceptKw('ORDER')) {
      this.expectKw('BY', 'expected BY after ORDER');
      do {
        const pos = this.peek().pos;
        const expr = this.parseExpr();
        let desc = false;
        if (this.acceptKw('DESC')) desc = true;
        else this.acceptKw('ASC');
        orderBy.push({ expr, desc, pos });
      } while (this.acceptOp(','));
    }

    let limit: Expr | null = null;
    let offset: Expr | null = null;
    if (this.acceptKw('LIMIT')) {
      limit = this.parseExpr();
      if (this.acceptKw('OFFSET')) offset = this.parseExpr();
    }

    return { distinct, items, from, where, groupBy, having, orderBy, limit, offset };
  }

  private parseSelectItem(): SelectItem {
    const t = this.peek();
    if (this.isOp('*')) {
      this.next();
      return { kind: 'star', table: null, pos: t.pos };
    }
    if (this.isName() && this.isOp('.', 1) && this.isOp('*', 2)) {
      this.i += 3;
      return { kind: 'star', table: t.text, pos: t.pos };
    }
    if (t.kind === 'eof' || this.isKw('FROM')) throw this.fail('expected a column or an expression to select');
    const expr = this.parseExpr();
    const text = this.sql.slice(t.pos.offset, this.peek(-1).end).trim();
    let alias: string | null = null;
    if (this.acceptKw('AS')) alias = this.expectName('expected a name after AS').text;
    return { kind: 'expr', expr, alias, text, pos: t.pos };
  }

  private parseTableRef(join: FromItem['join']): FromItem {
    const t = this.expectName(join === 'inner' ? 'expected a table name after JOIN' : 'expected a table name');
    let alias: string | null = null;
    if (this.acceptKw('AS')) alias = this.expectName('expected a name after AS').text;
    else if (this.isName()) alias = this.next().text;
    return { table: t.text, alias, join, on: null, pos: t.pos };
  }

  // ---- expressions ----

  parseExpr(): Expr {
    if (++this.depth > MAX_DEPTH) throw this.fail('expression is nested too deeply');
    try {
      return this.parseOr();
    } finally {
      this.depth--;
    }
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isKw('OR')) {
      const pos = this.next().pos;
      left = { kind: 'binary', op: 'OR', left, right: this.parseAnd(), pos };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.isKw('AND')) {
      const pos = this.next().pos;
      left = { kind: 'binary', op: 'AND', left, right: this.parseNot(), pos };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.isKw('NOT')) {
      const pos = this.next().pos;
      if (++this.depth > MAX_DEPTH) throw this.fail('expression is nested too deeply');
      try {
        return { kind: 'unary', op: 'NOT', expr: this.parseNot(), pos };
      } finally {
        this.depth--;
      }
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseConcat();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(t.text)) {
        this.next();
        const op: BinaryOp = t.text === '==' ? '=' : t.text === '<>' ? '!=' : (t.text as BinaryOp);
        left = { kind: 'binary', op, left, right: this.parseConcat(), pos: t.pos };
        continue;
      }
      if (this.isKw('IS')) {
        this.next();
        const not = this.acceptKw('NOT');
        this.expectKw('NULL', not ? 'expected NULL after IS NOT' : 'expected NULL or NOT NULL after IS');
        left = { kind: 'isnull', expr: left, not, pos: t.pos };
        continue;
      }
      let not = false;
      if (this.isKw('NOT') && (this.isKw('LIKE', 1) || this.isKw('IN', 1) || this.isKw('BETWEEN', 1))) {
        this.next();
        not = true;
      }
      if (this.acceptKw('LIKE')) {
        left = { kind: 'like', expr: left, pattern: this.parseConcat(), not, pos: t.pos };
        continue;
      }
      if (this.acceptKw('IN')) {
        this.expectOp('(', 'expected "(" and a list of values after IN');
        if (this.isKw('SELECT')) throw this.fail('subqueries are not supported; IN takes a list of values');
        const list: Expr[] = [];
        if (!this.isOp(')')) {
          list.push(this.parseExpr());
          while (this.acceptOp(',')) list.push(this.parseExpr());
        }
        this.expectOp(')', 'expected "," or ")" in the IN list');
        if (list.length === 0) throw this.fail('the IN list cannot be empty', this.peek(-1));
        left = { kind: 'in', expr: left, list, not, pos: t.pos };
        continue;
      }
      if (this.acceptKw('BETWEEN')) {
        const low = this.parseConcat();
        this.expectKw('AND', 'expected AND in BETWEEN ... AND ...');
        const high = this.parseConcat();
        left = { kind: 'between', expr: left, low, high, not, pos: t.pos };
        continue;
      }
      return left;
    }
  }

  private parseConcat(): Expr {
    let left = this.parseAdditive();
    while (this.isOp('||')) {
      const pos = this.next().pos;
      left = { kind: 'binary', op: '||', left, right: this.parseAdditive(), pos };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const t = this.next();
      left = { kind: 'binary', op: t.text as BinaryOp, left, right: this.parseMultiplicative(), pos: t.pos };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const t = this.next();
      left = { kind: 'binary', op: t.text as BinaryOp, left, right: this.parseUnary(), pos: t.pos };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp('-') || this.isOp('+')) {
      const t = this.next();
      if (++this.depth > MAX_DEPTH) throw this.fail('expression is nested too deeply', t);
      try {
        const expr = this.parseUnary();
        if (t.text === '+') return expr;
        if (expr.kind === 'literal' && typeof expr.value === 'number') return { kind: 'literal', value: -expr.value, pos: t.pos };
        return { kind: 'unary', op: '-', expr, pos: t.pos };
      } finally {
        this.depth--;
      }
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.kind === 'number') {
      this.next();
      return { kind: 'literal', value: t.num, pos: t.pos };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'literal', value: t.text, pos: t.pos };
    }
    if (this.isKw('NULL')) {
      this.next();
      return { kind: 'literal', value: null, pos: t.pos };
    }
    if (this.isOp('(')) {
      this.next();
      if (this.isKw('SELECT')) throw this.fail('subqueries are not supported');
      const inner = this.parseExpr();
      this.expectOp(')', 'expected ")"');
      return inner;
    }
    if (this.isName()) {
      this.next();
      if (!t.quoted && this.isOp('(')) return this.parseCall(t);
      if (this.isOp('.')) {
        this.next();
        const col = this.expectName('expected a column name after "."');
        return { kind: 'column', table: t.text, name: col.text, pos: t.pos };
      }
      return { kind: 'column', table: null, name: t.text, pos: t.pos };
    }
    if (t.kind === 'eof') throw this.fail('the query ends too early; expected a value or a column');
    if (t.kind === 'keyword') throw this.fail(`expected a value or a column, not the keyword ${t.text}`);
    throw this.fail('expected a value or a column');
  }

  private parseCall(nameTok: Token): Expr {
    const pos: Pos = nameTok.pos;
    this.expectOp('(');
    const name = nameTok.text.toLowerCase();
    if (this.isOp('*')) {
      this.next();
      this.expectOp(')', 'expected ")" after *');
      return { kind: 'call', name, args: [], star: true, distinct: false, pos };
    }
    const distinct = this.acceptKw('DISTINCT');
    const args: Expr[] = [];
    if (!this.isOp(')')) {
      args.push(this.parseExpr());
      while (this.acceptOp(',')) args.push(this.parseExpr());
    }
    this.expectOp(')', 'expected "," or ")" in the function call');
    return { kind: 'call', name, args, star: false, distinct, pos };
  }
}
