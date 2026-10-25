import { expect, test } from '@playwright/test';
import { operatorPasscode } from './helpers/env';

// The guide layer on /command: it auto-starts once per browser, spotlights a part, and steps with Next.
test.describe('guide', () => {
  test('/command auto-starts the guide once, steps with Next and stays done after Skip', async ({ page }) => {
    await page.goto('/command');
    await page.getByLabel(/name/i).first().fill('e2e');
    await page.getByLabel(/passcode/i).fill(operatorPasscode());
    await page.getByRole('button', { name: 'Sign in' }).click();
    const tip = page.getByRole('dialog', { name: /.+/ }).filter({ has: page.getByText('cmd.clock') });
    await expect(tip).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(/^2 \/ \d+$/)).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByText(/^2 \/ \d+$/)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Station lines').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('cmd.clock')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Guidance ready/ })).toBeVisible();
  });

  test('?anchors=1 draws anchor tags on /command', async ({ context, page }) => {
    await context.addInitScript(() => localStorage.setItem('guide:command:done', '1'));
    await page.goto('/command?anchors=1');
    await page.getByLabel(/name/i).first().fill('e2e');
    await page.getByLabel(/passcode/i).fill(operatorPasscode());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('cmd.wind').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('cmd.queue', { exact: true }).first()).toBeVisible();
  });
});
