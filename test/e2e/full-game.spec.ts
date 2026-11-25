import { test, expect } from '@playwright/test';
import { answerOnScreen, closeAll, startedGame } from './helpers.ts';

test('two players play a full 5-round game to the final leaderboard', async ({ browser }) => {
  const { ann, bob } = await startedGame(browser, { rounds: 5, difficulty: 'easy' });
  await expect(bob.getByTestId('start')).toBeHidden();

  for (let round = 1; round <= 5; round++) {
    for (const p of [ann, bob]) await expect(p.getByTestId('round-label')).toHaveText(`Round ${round} of 5`);
    const answer = await answerOnScreen(ann);
    expect(await answerOnScreen(bob)).toBe(answer);

    // Ann solves first (keyboard shortcut).
    await ann.getByTestId('editor').fill(answer);
    await ann.getByTestId('editor').press('Control+Enter');
    await expect(ann.getByTestId('verdict')).toHaveText('Correct! +5');
    await expect(bob.getByTestId('solved-list')).toContainText('Ann');
    await expect(bob.getByTestId('solved-list')).not.toContainText(answer);

    if (round === 1) {
      // Bob tries a wrong query first, then the right one after the 2 s gap.
      await bob.getByTestId('editor').fill('SELECT 1');
      await bob.getByTestId('submit').click();
      await expect(bob.getByTestId('verdict')).toContainText('Not yet (1 wrong try)');
      await bob.waitForTimeout(2100);
    }
    await bob.getByTestId('editor').fill(answer);
    await bob.getByTestId('submit').click();

    // Everyone solved: the round ends early and both see every query.
    for (const p of [ann, bob]) {
      await expect(p.getByTestId('result-row')).toHaveCount(2);
      await expect(p.locator('[data-testid="result-row"][data-player="Ann"]')).toContainText('+6');
      await expect(p.locator('[data-testid="result-row"][data-player="Bob"]')).toContainText('+4');
      await expect(p.locator('[data-testid="result-row"][data-player="Ann"] pre')).toHaveText(answer);
    }
    if (round === 1) await expect(ann.locator('[data-testid="result-row"][data-player="Bob"]')).toContainText('1 wrong try');
    await expect(bob.getByTestId('next')).toBeHidden();
    await ann.getByTestId('next').click();
  }

  for (const p of [ann, bob]) {
    await expect(p.getByTestId('leaderboard-row')).toHaveCount(2);
    await expect(p.getByTestId('final-score-Ann')).toHaveText('30');
    await expect(p.getByTestId('final-score-Bob')).toHaveText('20');
  }
  await expect(ann.getByTestId('leaderboard-row').first()).toContainText('Ann');
  await expect(bob.getByTestId('play-again')).toBeHidden();

  await ann.getByTestId('play-again').click();
  for (const p of [ann, bob]) await expect(p.getByTestId('player-row')).toHaveCount(2);
  await expect(ann.getByTestId('start')).toBeEnabled();
  await closeAll([ann, bob]);
});
