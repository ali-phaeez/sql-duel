import { test, expect } from '@playwright/test';
import { answerOnScreen, closeAll, startedGame } from './helpers.ts';

test('a reload mid-round resumes the same player with the same score and solved state', async ({ browser }) => {
  const { ann, bob, code } = await startedGame(browser);
  const answer = await answerOnScreen(ann);
  await ann.getByTestId('editor').fill(answer);
  await ann.getByTestId('submit').click();
  await expect(ann.getByTestId('verdict')).toHaveText('Correct! +5');
  await expect(bob.getByTestId('score-Ann')).toHaveText('5');

  // Bob's half-typed draft survives his reload too.
  await bob.getByTestId('editor').fill('SELECT name FROM');
  await bob.reload();
  await expect(bob.getByTestId('round-label')).toHaveText('Round 1 of 5');
  await expect(bob.getByTestId('editor')).toHaveValue('SELECT name FROM');

  await ann.reload();
  await expect(ann.getByTestId('round-label')).toHaveText('Round 1 of 5');
  await expect(ann.getByTestId('score-Ann')).toHaveText('5');
  await expect(ann.getByTestId('score-Bob')).toHaveText('0');
  await expect(ann.getByTestId('editor')).toHaveValue(answer);
  await expect(ann.getByTestId('editor')).toHaveJSProperty('readOnly', true);
  await expect(ann.getByTestId('verdict')).toHaveText('Correct! +5');
  await expect(ann.getByTestId('submit')).toBeDisabled();

  // Still one Ann in the room, and the room code did not change.
  const probe = await ann.request.get(`/api/rooms/${code}`);
  expect((await probe.json()).players).toBe(2);
  await expect(bob.getByTestId('solved-list')).toContainText('Ann');

  // Opening the room in a second tab of the same browser takes over; the first tab is told why.
  const second = await ann.context().newPage();
  await second.goto('/');
  await expect(second.getByTestId('score-Ann')).toHaveText('5');
  await expect(ann.getByTestId('use-here')).toBeVisible();
  await closeAll([ann, bob]);
});
