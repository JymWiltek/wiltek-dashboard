/**
 * Wiltek Portal — V1 第 1 刀 Self-Audit (3 rounds)
 *
 * Round 1 — Data accuracy: transfer engine math vs misplaced baseline (RM 42,447).
 * Round 2 — Functional: kanban, approve/edit/cancel, warehouse list, role switcher,
 *           warehouse login, localStorage persistence, logout, wrong password.
 * Round 3 — Responsive: desktop (1280) + mobile (375) for both views.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const PAGE_URL = '/Wiltek_MASTER.html';
const SHOTS_DIR = path.resolve(__dirname, '..', 'shots');
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

async function loginAs(page: Page, user: string, pw: string) {
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK);
  // If a previous session is active (e.g. switching users in the same test),
  // end it and reload so the login screen reappears. Don't touch transfer state.
  const hasSession = await page.evaluate(() => !!sessionStorage.getItem('wp_session_v1'));
  if (hasSession) {
    await page.evaluate(() => sessionStorage.removeItem('wp_session_v1'));
    await page.reload();
    await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK);
  }
  await page.waitForSelector('#loginUser', { state: 'visible', timeout: 5000 });
  await page.fill('#loginUser', user);
  await page.fill('#loginPw', pw);
  await page.click('#loginBtn');
  await page.waitForSelector('#app.ready', { timeout: 5000 });
}

async function loginOwner(page: Page) { await loginAs(page, 'owner', 'Owner@2026'); }
async function loginWarehouse(page: Page) { await loginAs(page, 'warehouse', 'Warehouse@2026'); }

test.describe('Round 1 — Transfer engine accuracy', () => {
  test('misplaced baseline still RM 42,447 / 273 rows', async ({ page }) => {
    await loginOwner(page);
    const got = await page.evaluate(() => {
      const ds = (window as any).WP_DEADSTOCK;
      return ds.totals.MISPLACED;
    });
    expect(got.rows).toBe(273);
    expect(Math.round(got.amount)).toBe(42447);
  });

  test('engine emits suggestions with total value ≤ misplaced source', async ({ page }) => {
    await loginOwner(page);
    const sums = await page.evaluate(() => {
      const list = (window as any).computeSuggestions();
      const total = list.reduce((s: number, x: any) => s + x.amount, 0);
      return { count: list.length, total: Math.round(total) };
    });
    expect(sums.count).toBeGreaterThan(0);
    expect(sums.total).toBeGreaterThan(0);
    // Must be ≤ misplaced source (with 1% slack)
    expect(sums.total).toBeLessThanOrEqual(Math.round(42447 * 1.01));
  });

  test('every suggestion has valid src≠dst, both active, qty≤source qty', async ({ page }) => {
    await loginOwner(page);
    const issues = await page.evaluate(() => {
      const ds = (window as any).WP_DEADSTOCK;
      const ACTIVE = new Set(ds.meta.active_branches);
      const list = (window as any).computeSuggestions();
      const srcByPair: Record<string, number> = {};
      ds.rows.forEach((r: any) => {
        if (r.cls === 'MISPLACED') srcByPair[r.code + '|' + r.branch] = r.qty;
      });
      const grouped: Record<string, number> = {};
      const bad: string[] = [];
      list.forEach((s: any) => {
        if (!ACTIVE.has(s.src) || !ACTIVE.has(s.dst)) bad.push('not-active:' + s.id);
        if (s.src === s.dst) bad.push('same-branch:' + s.id);
        if (!(s.qty > 0)) bad.push('non-positive:' + s.id);
        const k = s.code + '|' + s.src;
        grouped[k] = (grouped[k] || 0) + s.qty;
      });
      Object.keys(grouped).forEach(k => {
        if (grouped[k] - (srcByPair[k] || 0) > 1e-6) bad.push('overspend:' + k);
      });
      return bad;
    });
    expect(issues).toEqual([]);
  });
});

test.describe('Round 2 — Functional', () => {
  test('owner sees deadstock + transfers + warehouse menu items', async ({ page }) => {
    await loginOwner(page);
    await expect(page.locator('#navDeadstock')).toBeVisible();
    await expect(page.locator('#navTransfers')).toBeVisible();
    await expect(page.locator('#navWarehouse')).toBeVisible();
  });

  test('navigating to transfers shows 4-column kanban with summary', async ({ page }) => {
    await loginOwner(page);
    await page.click('#navTransfers');
    await expect(page.locator('#view-transfers.on')).toBeVisible();
    const cols = await page.locator('.kanban .col').count();
    expect(cols).toBe(4);
    const sumCards = await page.locator('.kanban-summary .sum-card').count();
    expect(sumCards).toBe(4);
    // At least some pending cards exist on a fresh state
    const pendingCount = await page.locator('.kanban .col').nth(0).locator('.card').count();
    expect(pendingCount).toBeGreaterThan(0);
  });

  test('approve moves card from Pending to In progress', async ({ page }) => {
    await loginOwner(page);
    await page.click('#navTransfers');
    const beforePending = await page.locator('.kanban .col').nth(0).locator('.card').count();
    const beforeApproved = await page.locator('.kanban .col').nth(1).locator('.card').count();
    await page.locator('.kanban .col').nth(0).locator('.card').first()
      .locator('button[data-act="approve"]').click();
    const afterPending = await page.locator('.kanban .col').nth(0).locator('.card').count();
    const afterApproved = await page.locator('.kanban .col').nth(1).locator('.card').count();
    expect(afterPending).toBe(beforePending - 1);
    expect(afterApproved).toBe(beforeApproved + 1);
  });

  test('cancel with reason moves card to Not done', async ({ page }) => {
    await loginOwner(page);
    await page.click('#navTransfers');
    page.once('dialog', d => d.accept('Test reason'));
    const beforeCancel = await page.locator('.kanban .col').nth(3).locator('.card').count();
    await page.locator('.kanban .col').nth(0).locator('.card').first()
      .locator('button[data-act="cancel"]').click();
    const afterCancel = await page.locator('.kanban .col').nth(3).locator('.card').count();
    expect(afterCancel).toBe(beforeCancel + 1);
    // Reason text appears
    await expect(page.locator('.kanban .col').nth(3).locator('.card .cancel-reason').first()).toContainText('Test reason');
  });

  test('edit qty updates card amount and approves it', async ({ page }) => {
    await loginOwner(page);
    await page.click('#navTransfers');
    const firstCard = page.locator('.kanban .col').nth(0).locator('.card').first();
    const id = await firstCard.getAttribute('data-id');
    page.once('dialog', d => d.accept('1'));
    await firstCard.locator('button[data-act="edit"]').click();
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem('wp_transfers_v1') || '{}')[k!],  id);
    expect(stored.status).toBe('approved');
    expect(stored.qty).toBe(1);
  });

  test('owner uses view-as switcher to preview Warehouse', async ({ page }) => {
    await loginOwner(page);
    await expect(page.locator('#viewAsSwitcher')).toBeVisible();
    await page.click('#viewAsWarehouse');
    await expect(page.locator('#view-warehouse.on')).toBeVisible();
    // Transfer suggestions menu hidden in warehouse mode
    await expect(page.locator('#navTransfers')).toBeHidden();
    await page.click('#viewAsOwner');
    await expect(page.locator('#view-transfers.on')).toBeVisible();
    await expect(page.locator('#navTransfers')).toBeVisible();
  });

  test('warehouse list shows approved + done/cancelled actions', async ({ page }) => {
    await loginOwner(page);
    await page.click('#navTransfers');
    // Approve one, then jump to warehouse view
    await page.locator('.kanban .col').nth(0).locator('.card').first()
      .locator('button[data-act="approve"]').click();
    await page.click('#navWarehouse');
    await expect(page.locator('#view-warehouse.on')).toBeVisible();
    const rows = await page.locator('.wh-list .wh-row').count();
    expect(rows).toBeGreaterThan(0);
    // Mark first done
    await page.locator('.wh-list .wh-row').first().locator('button[data-act="wh-done"]').click();
    await expect(page.locator('.wh-list .wh-row.done').first()).toBeVisible();
  });

  test('warehouse user logs in directly to warehouse view, no transfers menu', async ({ page }) => {
    await loginWarehouse(page);
    await expect(page.locator('#view-warehouse.on')).toBeVisible();
    await expect(page.locator('#navTransfers')).toBeHidden();
    await expect(page.locator('#viewAsSwitcher')).toBeHidden();
  });

  test('warehouse user can mark done / can\'t', async ({ page }) => {
    // First, owner approves one
    await loginOwner(page);
    await page.click('#navTransfers');
    const firstCard = page.locator('.kanban .col').nth(0).locator('.card').first();
    const id = await firstCard.getAttribute('data-id');
    await firstCard.locator('button[data-act="approve"]').click();
    // Now warehouse logs in (state persists in localStorage)
    await loginWarehouse(page);
    // Find the row matching id and click Can't
    page.once('dialog', d => d.accept('Stock unavailable'));
    await page.locator('.wh-list .wh-row[data-id="' + id + '"] button[data-act="wh-cant"]').click();
    const status = await page.evaluate((k) => JSON.parse(localStorage.getItem('wp_transfers_v1') || '{}')[k!], id);
    expect(status.status).toBe('cancelled');
    expect(status.reason).toBe('Stock unavailable');
  });

  test('localStorage state persists across reload', async ({ page }) => {
    await loginOwner(page);
    await page.click('#navTransfers');
    const firstCard = page.locator('.kanban .col').nth(0).locator('.card').first();
    const id = await firstCard.getAttribute('data-id');
    await firstCard.locator('button[data-act="approve"]').click();
    await page.reload();
    await page.waitForSelector('#app.ready');
    await page.click('#navTransfers');
    // The id should appear in approved column now
    const stillApproved = await page.locator('.kanban .col').nth(1)
      .locator('.card[data-id="' + id + '"]').count();
    expect(stillApproved).toBe(1);
  });

  test('language toggle EN ↔ 中 on transfer view', async ({ page }) => {
    await loginOwner(page);
    await page.click('#navTransfers');
    await page.click('#langZH');
    await expect(page.locator('#view-transfers.on .page-title')).toHaveText('调货建议');
    await page.click('#langEN');
    await expect(page.locator('#view-transfers.on .page-title')).toHaveText('Transfer Suggestions');
  });

  test('logout returns to login screen', async ({ page }) => {
    await loginOwner(page);
    await page.click('#logoutBtn');
    await page.waitForSelector('#login', { state: 'visible' });
    expect(await page.isVisible('#loginUser')).toBe(true);
  });

  test('wrong password rejected for warehouse account', async ({ page }) => {
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => !!(window as any).WP_USERS);
    await page.fill('#loginUser', 'warehouse');
    await page.fill('#loginPw', 'wrong');
    await page.click('#loginBtn');
    await page.waitForTimeout(300);
    const err = await page.locator('#loginErr').textContent();
    expect(err).toMatch(/incorrect|错误/i);
  });
});

test.describe('Round 3 — Responsive', () => {
  test('desktop 1280x800 kanban renders without overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginOwner(page);
    await page.click('#navTransfers');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'transfers-desktop-1280.png'), fullPage: false, timeout: 15000 });
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    const grid = await page.locator('.kanban').evaluate(el => getComputedStyle(el).gridTemplateColumns);
    expect(grid.split(' ').length).toBe(4);
  });

  test('mobile 375x812 kanban stacks to single column', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginOwner(page);
    // Menu is hidden on mobile (≤1024px) — switch view via JS
    await page.evaluate(() => (window as any).setView('transfers'));
    await page.waitForSelector('#view-transfers.on');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'transfers-mobile-375.png'), fullPage: false, timeout: 15000 });
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    const grid = await page.locator('.kanban').evaluate(el => getComputedStyle(el).gridTemplateColumns);
    expect(grid.split(' ').length).toBe(1);
  });

  test('mobile 375 warehouse list stacks rows', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginWarehouse(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'warehouse-mobile-375.png'), fullPage: false, timeout: 15000 });
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
});
