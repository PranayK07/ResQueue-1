import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { operatorPasscode } from './helpers/env';

// /command checklist (spec 4.2) against the seeded local database. Each test is a fresh browser (new identity).

async function signIn(page: Page) {
  await page.goto('/command');
  await page.getByLabel(/name/i).first().fill('e2e');
  await page.getByLabel(/passcode/i).fill(operatorPasscode());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Station lines', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
}

test.describe('/command', () => {
  // The guide auto-starts once per browser; these tests aren't about it (see guide.spec.ts).
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      for (const screen of ['help', 'command', 'crew']) localStorage.setItem(`guide:${screen}:done`, '1');
    });
  });

  test('a wrong passcode shows the error; the right one fills the requests without a reload', async ({ page }) => {
    await page.goto('/command');
    await page.getByLabel(/name/i).first().fill('e2e');
    await page.getByLabel(/passcode/i).fill('definitely-not-the-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Wrong passcode.')).toBeVisible();
    await page.getByLabel(/passcode/i).fill(operatorPasscode());
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Queues are BLOCKED-BACKEND locally, so the seeded requests fill the Assessing group.
    await expect(page.getByText('Assessing', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^#\d+$/).first()).toBeVisible();
  });

  test('the map renders stations, units and request pins on the seeded world', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    await expect(page.locator('.maplibregl-marker').first()).toBeVisible({ timeout: 15_000 });
    expect(await page.locator('.maplibregl-marker').count()).toBeGreaterThan(5);
    await expect(page.getByText('Burning now')).toBeVisible();
  });

  test('a wind change writes a wind event to the log', async ({ page }) => {
    await signIn(page);
    const speed = page.getByRole('slider').first();
    await speed.focus();
    await speed.press('ArrowRight');
    await expect(page.getByText(/Wind now .* \(manual\)/).first()).toBeVisible({ timeout: 10_000 });
    const back = page.getByRole('button', { name: 'Return to live wind' });
    if (await back.isVisible()) await back.click();
  });

  test('flagging a request shows it in the panel; resolving removes it and logs it', async ({ page }) => {
    await signIn(page);
    await page.getByText(/^#\d+$/).first().click();
    await page.getByRole('radio', { name: 'Suspect' }).click().catch(() => page.getByText('Suspect', { exact: true }).click());
    await page.getByPlaceholder(/detail|what/i).fill('e2e check').catch(() => {});
    await page.getByRole('button', { name: 'Flag request' }).click();
    await page.keyboard.press('Escape');
    const panel = page.locator('[data-guide="cmd.flags"]');
    await expect(panel.getByRole('button', { name: 'Air support requested' }).first()).toBeVisible({ timeout: 10_000 });
    const before = await panel.getByRole('button', { name: 'Air support requested' }).count();
    await panel.getByRole('button', { name: 'Air support requested' }).first().click();
    await expect(panel.getByRole('button', { name: 'Air support requested' })).toHaveCount(before - 1, { timeout: 10_000 });
    await expect(page.getByText(/resolved: Air support requested/).first()).toBeVisible();
  });

  test('pinning a request logs the override and shows the pin', async ({ page }) => {
    await signIn(page);
    await page.getByText(/^#\d+$/).first().click();
    const pinArea = page.locator('[data-guide="cmd.drawer.pin"]');
    await pinArea.getByRole('combobox').click();
    await page.getByRole('option').first().click();
    await pinArea.getByRole('button', { name: 'Pin to station' }).click();
    await expect(page.getByText(/pinned to/).first()).toBeVisible({ timeout: 10_000 });
  });

  test('killing the network disables every control', async ({ page, context }) => {
    await signIn(page);
    await context.setOffline(true);
    await expect(page.getByText('No connection. Every control is off until it comes back.')).toBeVisible();
    for (const slider of await page.getByRole('slider').all()) await expect(slider).toHaveAttribute('data-disabled', '');
    await expect(page.getByRole('button', { name: 'Draw a closure' })).toBeDisabled();
    await context.setOffline(false);
  });

  test('no hardcoded station names in the source', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'module_bindings') walk(p);
        } else files.push(p);
      }
    };
    walk(root);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/Canyon|Station 8|Station 35/);
  });

  test.skip('BLOCKED-BACKEND: a wind change reorders at least one queue', () => {});
  test.skip('BLOCKED-BACKEND: a pin moves an unlocked request to the chosen station; Pin disabled on a locked one', () => {});
  test.skip('BLOCKED-BACKEND: an unreachable flag appears (delegation agent)', () => {});
  test.skip('MANUAL: stopping the delegation agent shows the banner within 30 s (stop the agent, watch the top of /command)', () => {});
});
