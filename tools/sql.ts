// npm run sql -- puzzles/pack.json <puzzleId> "<query>"
// Runs a query against one puzzle's tables, prints the result, and says whether it matches the target.
// Without a query it prints the puzzle's tables and target.

import { readFileSync } from 'node:fs';
import { formatTable, resultsMatch, runQuery, SqlError } from '../src/sql/index.ts';
import type { Pack } from '../src/puzzles.ts';

const [file, id, query] = process.argv.slice(2);
if (!file || !id) {
  console.error('usage: npm run sql -- <pack.json> <puzzleId> ["<query>"]');
  process.exit(2);
}
const pack = JSON.parse(readFileSync(file, 'utf8')) as Pack;
const puzzle = pack.puzzles.find((p) => p.id === id);
if (!puzzle) {
  console.error(`no puzzle "${id}" in ${file}. Ids:\n  ${pack.puzzles.map((p) => p.id).join('\n  ')}`);
  process.exit(2);
}

if (!query) {
  console.log(`${puzzle.title} [${puzzle.difficulty}${puzzle.ordered ? ', ordered' : ''}]\n${puzzle.story}\n`);
  for (const t of puzzle.tables) console.log(`${t.name}\n${formatTable(t)}\n`);
  console.log(`target\n${formatTable(puzzle.target)}`);
  process.exit(0);
}

try {
  const result = runQuery(query, puzzle.tables);
  console.log(formatTable(result));
  if (puzzle.target) {
    const v = resultsMatch(result, puzzle.target, puzzle.ordered);
    console.log(v.ok ? 'matches the target' : `does not match the target: ${v.reason}`);
  }
} catch (e) {
  if (e instanceof SqlError) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
