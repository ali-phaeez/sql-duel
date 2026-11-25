import { readFileSync } from 'node:fs';
import { expect, type Browser, type Page } from '@playwright/test';

interface PackPuzzle {
  id: string;
  answer: string;
}

const pack = JSON.parse(readFileSync(new URL('../../puzzles/pack.json', import.meta.url), 'utf8')) as { puzzles: PackPuzzle[] };

/** The reference answer for the puzzle on screen (the test reads the pack from disk; the page never has it). */
export async function answerOnScreen(page: Page): Promise<string> {
  const id = await page.getByTestId('round').getAttribute('data-puzzle-id');
  const p = pack.puzzles.find((x) => x.id === id);
  if (!p) throw new Error(`unknown puzzle on screen: ${id}`);
  return p.answer;
}

export async function newPlayer(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  return ctx.newPage();
}

export async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('name').fill(name);
  await page.getByTestId('create').click();
  await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z]{4}$/);
  return (await page.getByTestId('room-code').textContent())!.trim();
}

export async function joinRoom(page: Page, code: string, name: string): Promise<void> {
  await page.goto(`/?room=${code}`);
  await page.getByTestId('name').fill(name);
  await page.getByTestId('join').click();
  await expect(page.getByTestId('room-code')).toHaveText(code);
}

/** Host + guest in a room, game started with the given settings. */
export async function startedGame(browser: Browser, opts: { rounds?: 5 | 8 | 12; difficulty?: 'easy' | 'mixed' | 'hard' } = {}) {
  const ann = await newPlayer(browser);
  const bob = await newPlayer(browser);
  const code = await createRoom(ann, 'Ann');
  await joinRoom(bob, code, 'Bob');
  for (const p of [ann, bob]) await expect(p.getByTestId('player-row')).toHaveCount(2);
  await ann.getByTestId(`rounds-${opts.rounds ?? 5}`).click();
  await ann.getByTestId(`difficulty-${opts.difficulty ?? 'easy'}`).click();
  await expect(ann.getByTestId(`difficulty-${opts.difficulty ?? 'easy'}`)).toHaveAttribute('aria-pressed', 'true');
  await ann.getByTestId('start').click();
  for (const p of [ann, bob]) await expect(p.getByTestId('round-label')).toHaveText(`Round 1 of ${opts.rounds ?? 5}`);
  return { ann, bob, code };
}

export async function closeAll(pages: Page[]): Promise<void> {
  await Promise.all(pages.map((p) => p.context().close()));
}
