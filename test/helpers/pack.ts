import { readFileSync } from 'node:fs';
import type { Pack } from '../../src/puzzles.ts';

export function loadPack(): Pack {
  return JSON.parse(readFileSync(new URL('../../puzzles/pack.json', import.meta.url), 'utf8')) as Pack;
}
