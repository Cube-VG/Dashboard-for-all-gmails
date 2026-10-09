// Starting point for the Playwright agents (.claude/agents): a fresh mailbox, open on the inbox.
import { test, expect } from './fixtures';

test.describe('Seed', () => {
  test('seed', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('article').filter({ hasText: 'Contract renewal needs your signature today' })).toBeVisible();
  });
});
