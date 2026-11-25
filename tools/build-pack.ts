// npm run puzzles [-- path/to/pack.json]
// Checks every puzzle and (re)writes each `target` by running its reference `answer` through the engine.
// Targets are never typed by hand: edit tables / answers, then run this.

import { readFileSync, writeFileSync } from 'node:fs';
import { checkPuzzleShape, computeTarget, validatePack } from '../src/puzzles.ts';
import type { Pack, Puzzle } from '../src/puzzles.ts';
import { formatPackJson } from './pack-format.ts';

const file = process.argv[2] ?? 'puzzles/pack.json';
const pack = JSON.parse(readFileSync(file, 'utf8')) as Pack;
const problems: string[] = [];
const out: Puzzle[] = [];

for (const p of pack.puzzles) {
  const shape = checkPuzzleShape(p);
  if (shape.length) {
    problems.push(...shape);
    continue;
  }
  try {
    const target = computeTarget(p);
    out.push({
      id: p.id, title: p.title, difficulty: p.difficulty, story: p.story, ordered: p.ordered,
      tables: p.tables, answer: p.answer, target,
    });
  } catch (e) {
    problems.push(`puzzle "${p.id}": ${(e as Error).message}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const next: Pack = { version: pack.version ?? 1, puzzles: out };
const final = validatePack(next);
if (final.length) {
  console.error(final.join('\n'));
  process.exit(1);
}
writeFileSync(file, formatPackJson(next) + '\n');
const counts = { easy: 0, medium: 0, hard: 0 };
for (const p of out) counts[p.difficulty]++;
console.log(`${file}: ${out.length} puzzles (easy ${counts.easy}, medium ${counts.medium}, hard ${counts.hard}); targets written.`);
