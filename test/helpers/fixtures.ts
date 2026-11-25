import type { Table } from '../../src/sql/index.ts';

export const TABLES: Table[] = [
  {
    name: 'customers',
    columns: ['id', 'name', 'city'],
    rows: [
      [1, 'Ann', 'Oslo'],
      [2, 'Bob', 'Rome'],
      [3, 'Cid', 'Oslo'],
      [4, 'Dee', null],
    ],
  },
  {
    name: 'orders',
    columns: ['id', 'customer_id', 'total'],
    rows: [
      [10, 1, 10],
      [11, 1, 20.5],
      [12, 2, 5],
      [13, 1, 7],
      [14, 3, null],
    ],
  },
  {
    name: 'products',
    columns: ['sku', 'title', 'price'],
    rows: [
      ['A1', 'Apple', 0.5],
      ['B2', 'Banana', 0.25],
      ['C3', 'cherry', 3],
    ],
  },
];
