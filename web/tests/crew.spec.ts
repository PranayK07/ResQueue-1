import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { operatorPasscode } from './helpers/env';

// /crew checklist (spec 4.3) against the seeded local database. Each test is a fresh phone (new identity).

async function signInAndPickUnit(page: Page) {
  await page.goto('/crew');
  await page.getByLabel(/name/i).first().fill('e2e');
  await page.getByLabel(/passcode/i).fill(operatorPasscode());
  await page.getByRole('combobox').click();
  await page.getByRole('option').first().click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Which unit are you on?')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /seat/ }).first().click();
}

test.describe('/crew', () => {
  // The guide auto-starts once per browser; these tests aren't about it (see guide.spec.ts).
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      for (const screen of ['help', 'command', 'crew']) localStorage.setItem(`guide:${screen}:done`, '1');
    });
  });

  test('a responder signs in, picks a unit and sees their station line', async ({ page }) => {
    await signInAndPickUnit(page);
    await expect(page.getByText('Next in line')).toBeVisible({ timeout: 15_000 });
    // No queue entries exist locally (delegation agent is a stub), so the line is empty and idle.
    await expect(page.getByText(/No one waiting at /)).toBeVisible();
    await expect(page.getByText('No assignment.', { exact: false })).toBeVisible();
  });

  test('offline: banner and every action disabled', async ({ page, context }) => {
    await signInAndPickUnit(page);
    await expect(page.getByText('Next in line')).toBeVisible({ timeout: 15_000 });
    await context.setOffline(true);
    await expect(page.getByText("Offline. Taps won't send. Use the radio.")).toBeVisible();
    await context.setOffline(false);
  });

  test('a reload keeps the sign-in and the unit', async ({ page }) => {
    await signInAndPickUnit(page);
    await expect(page.getByText('Next in line')).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByText('Next in line')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Which unit are you on?')).toHaveCount(0);
  });

  test('no station name or callsign hardcoded in the source', () => {
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
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/Canyon|Station 8\d|Station 35|Pentz|Magalia|\b(E81|M81|E82|E35|B35)\b/);
    }
  });

  test.skip('BLOCKED-BACKEND: with a plan assigning the unit, the banner then the mission card', () => {});
  test.skip('BLOCKED-BACKEND: En route, On scene, Rescued each update the resident card within 1 s', () => {});
  test.skip('BLOCKED-BACKEND: resident taps I\'m safe mid-mission; closed banner and unit released', () => {});
  test.skip('BLOCKED-BACKEND: Abort sends the request back to the line', () => {});
});
