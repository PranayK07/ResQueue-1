import { expect, test } from '@playwright/test';
import { operatorPasscode } from './helpers/env';

// Phase 1 is done when /_debug shows live row counts for every table and view and the sim clock ticks.

const SEEDED_TABLES = ['sim_clock', 'grid', 'weather', 'station', 'unit', 'fire_cell', 'forecast_cell', 'forecast_meta', 'world_version', 'event_log', 'agent'];

test.describe('/_debug', () => {
  test('connects live and counts rows in the seeded world', async ({ page }) => {
    await page.goto('/_debug?as=command');
    await expect(page.getByTestId('conn-state')).toHaveText('live');
    await expect(page.getByTestId('conn-ready')).toHaveText('true');
    await expect(page.getByTestId('sim-scenario')).toHaveText('paradise-demo');
    for (const name of SEEDED_TABLES) {
      await expect(page.getByTestId(`count-${name}`), name).not.toHaveText('0');
    }
    // Every view has a row in the table, live even when empty for this identity.
    for (const name of ['my_requests', 'ops_request', 'ops_queue', 'ops_travel', 'ops_flag', 'road_closure']) {
      await expect(page.getByTestId(`count-${name}`), name).toHaveText(/^\d+$/);
    }
  });

  test('the sim clock ticks', async ({ page }) => {
    await page.goto('/_debug?as=command');
    const t = page.getByTestId('sim-t');
    await expect(t).toHaveText(/^T\+\d/);
    const first = await t.textContent();
    await expect.poll(() => t.textContent(), { timeout: 5000 }).not.toBe(first);
  });

  test('a wrong passcode is refused with the mapped copy', async ({ page }) => {
    await page.goto('/_debug?as=command');
    await expect(page.getByTestId('conn-state')).toHaveText('live');
    await page.getByTestId('debug-passcode').fill('definitely-not-the-passcode');
    await page.getByTestId('debug-signin').click();
    await expect(page.getByTestId('debug-signin-status')).toHaveText('Wrong passcode.');
    await expect(page.getByTestId('count-ops_request')).toHaveText('0');
  });

  test('commander sign-in fills ops_request without a reload', async ({ page }) => {
    await page.goto('/_debug?as=command');
    await expect(page.getByTestId('conn-state')).toHaveText('live');
    await page.getByTestId('debug-passcode').fill(operatorPasscode());
    await page.getByTestId('debug-signin').click();
    await expect(page.getByTestId('debug-signin-status')).toHaveText('Signed in.');
    await expect(page.getByTestId('count-ops_request')).not.toHaveText('0');
  });

  test('a resident identity sees no ops rows', async ({ page }) => {
    await page.goto('/_debug?as=help');
    await expect(page.getByTestId('conn-state')).toHaveText('live');
    await expect(page.getByTestId('conn-ready')).toHaveText('true');
    await expect(page.getByTestId('count-station')).not.toHaveText('0');
    for (const name of ['ops_request', 'ops_queue', 'ops_travel', 'ops_flag']) {
      await expect(page.getByTestId(`count-${name}`), name).toHaveText('0');
    }
  });

  test('a reload keeps the same identity', async ({ page }) => {
    await page.goto('/_debug?as=crew');
    await expect(page.getByTestId('conn-state')).toHaveText('live');
    const before = await page.locator('dd', { hasText: '...' }).first().textContent();
    await page.reload();
    await expect(page.getByTestId('conn-state')).toHaveText('live');
    await expect(page.locator('dd', { hasText: '...' }).first()).toHaveText(before ?? '');
  });
});
