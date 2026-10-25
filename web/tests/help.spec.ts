import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// /help checklist (spec 4.1) against the seeded local database. Each test is a fresh device (new identity).

async function ready(page: Page) {
  await expect(page.getByRole('button', { name: 'I need help' })).toBeEnabled({ timeout: 15_000 });
}

async function submitAsPersona(page: Page) {
  await page.goto('/help?demo=1');
  await expect(page.getByText(/Demo persona:/)).toBeVisible();
  await ready(page);
  await page.getByRole('button', { name: 'I need help' }).click();
  await page.getByRole('button', { name: 'Share and continue' }).click();
  await page.getByRole('button', { name: 'Send' }).click();
}

test.describe('/help', () => {
  test('persona flow: card shows Received within 5 s of Send', async ({ page }) => {
    await submitAsPersona(page);
    await expect(page.getByText('Received', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: "I'm safe now" })).toBeVisible();
  });

  test('a location outside the grid gives the mapped error and offers the persona', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 37.8716, longitude: -122.2727 });
    await page.goto('/help');
    await ready(page);
    await page.getByRole('button', { name: 'I need help' }).click();
    await page.getByRole('button', { name: 'Share and continue' }).click();
    await expect(page.getByText("You're outside the active incident area.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use the demo persona' })).toBeVisible();
    await page.getByRole('button', { name: 'Use the demo persona' }).click();
    await expect(page.getByText(/Demo persona:/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('a reload keeps the same card and offers no second request', async ({ page }) => {
    await submitAsPersona(page);
    await expect(page.getByText('Received', { exact: true })).toBeVisible({ timeout: 5000 });
    await page.reload();
    await expect(page.getByText('Received', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'I need help' })).toHaveCount(0);
  });

  test('"I\'m safe now" closes the request and deletes the location', async ({ page }) => {
    await submitAsPersona(page);
    await expect(page.getByText('Received', { exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: "I'm safe now" }).click();
    await page.getByRole('button', { name: 'Close request' }).click();
    await expect(page.getByText('You closed this request. Your location was deleted.')).toBeVisible();
  });

  test('offline: banner, sending disabled, Call 911 still there', async ({ page, context }) => {
    await page.goto('/help?demo=1');
    await ready(page);
    await context.setOffline(true);
    await expect(page.getByText("No connection. Your request can't be sent. Call 911.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'I need help' })).toBeDisabled();
    const call = page.getByRole('link', { name: /Call 911/ }).first();
    await expect(call).toBeVisible();
    await expect(call).toHaveAttribute('href', 'tel:911');
    await context.setOffline(false);
  });

  test('no "you\'re safe" anywhere in routes/help', () => {
    const root = fileURLToPath(new URL('../src/routes/help', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(root);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/you(['’]re| are) safe/i);
  });

  test.skip('BLOCKED-BACKEND: card moves pending to queued with position, station, ETA and reason', () => {});
  test.skip('BLOCKED-BACKEND: a wind change that moves the request shows the "Moved to" toast', () => {});
});
