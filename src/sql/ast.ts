// Syntax tree produced by the parser. Every node keeps the position of its first token.

import type { Pos } from './errors.ts';
import type { Value } from './values.ts';

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '||'
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'AND' | 'OR';

export type Expr =
  | { kind: 'literal'; value: Value; pos: Pos }
  | { kind: 'column'; table: string | null; name: string; pos: Pos }
  | { kind: 'unary'; op: '-' | 'NOT'; expr: Expr; pos: Pos }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; pos: Pos }
  | { kind: 'like'; expr: Expr; pattern: Expr; not: boolean; pos: Pos }
  | { kind: 'in'; expr: Expr; list: Expr[]; not: boolean; pos: Pos }
  | { kind: 'between'; expr: Expr; low: Expr; high: Expr; not: boolean; pos: Pos }
  | { kind: 'isnull'; expr: Expr; not: boolean; pos: Pos }
  | { kind: 'call'; name: string; args: Expr[]; star: boolean; distinct: boolean; pos: Pos };

export type SelectItem =
  | { kind: 'star'; table: string | null; pos: Pos }
  | { kind: 'expr'; expr: Expr; alias: string | null; text: string; pos: Pos };

export interface FromItem {
  table: string;
  alias: string | null;
  join: 'first' | 'comma' | 'inner';
  on: Expr | null;
  pos: Pos;
}

export interface OrderItem {
  expr: Expr;
  desc: boolean;
  pos: Pos;
}

export interface Select {
  distinct: boolean;
  items: SelectItem[];
  from: FromItem[];
  where: Expr | null;
  groupBy: Expr[];
  having: Expr | null;
  orderBy: OrderItem[];
  limit: Expr | null;
  offset: Expr | null;
}
