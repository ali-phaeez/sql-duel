import { test, expect } from '@playwright/test';
import { answerOnScreen, closeAll, startedGame } from './helpers.ts';

test('the live preview shows a result while typing, and an error with its position', async ({ browser }) => {
  const { ann, bob } = await startedGame(browser);
  const preview = ann.getByTestId('preview');
  await expect(preview).toContainText('Your result appears here');

  await ann.getByTestId('editor').fill('SELECT 6 * 7 AS answer, upper(\'ok\')');
  await expect(preview.locator('table th')).toHaveText(['answer', "upper('ok')"]);
  await expect(preview.locator('table td')).toHaveText(['42', 'OK']);

  await ann.getByTestId('editor').fill('SELECT * FORM x');
  await expect(ann.getByTestId('preview-error')).toHaveText('near "FORM" at 1:10: expected FROM, a comma, or AS before an alias');

  await ann.getByTestId('editor').fill('SELECT nope FROM nowhere');
  await expect(ann.getByTestId('preview-error')).toContainText('no such table "nowhere"');

  // The reference answer previews to exactly the target table.
  const answer = await answerOnScreen(ann);
  await ann.getByTestId('editor').fill(answer);
  const targetCells = await ann.getByTestId('target').locator('td').allTextContents();
  await expect(preview.locator('td')).toHaveText(targetCells);

  // Preview is local: nothing was submitted, so nobody has solved it.
  await expect(bob.getByTestId('solved-list')).toContainText('Nobody yet');
  await closeAll([ann, bob]);
});
