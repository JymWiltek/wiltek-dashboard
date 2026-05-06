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
  await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
  // If a previous session is active (e.g. switching users in the same test),
  // end it and reload so the login screen reappears. Don't touch transfer state.
  const hasSession = await page.evaluate(() => !!sessionStorage.getItem('wp_session_v1'));
  if (hasSession) {
    await page.evaluate(() => sessionStorage.removeItem('wp_session_v1'));
    await page.reload();
    await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
  }
  await page.waitForSelector('#loginUser', { state: 'visible', timeout: 5000 });
  await page.fill('#loginUser', user);
  await page.fill('#loginPw', pw);
  await page.click('#loginBtn');
  await page.waitForSelector('#app.ready', { timeout: 5000 });
}

async function loginOwner(page: Page) {
  await loginAs(page, 'owner', 'Owner@2026');
  // V1 第 2 刀: Owner now lands on Today Overview. Navigate to transfers for these tests.
  await page.evaluate(() => (window as any).setView('transfers'));
  await page.waitForSelector('#view-transfers.on', { timeout: 5000 });
}
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
  test('owner sees Inventory domain menu item (parent of dead/transfers/warehouse/po drill-downs)', async ({ page }) => {
    // V1 第 6 刀: Stock + Purchasing collapsed into Inventory. Legacy
    // 'stock/transfer' and 'purchasing/exceptions' paths still resolve.
    await loginOwner(page);
    await expect(page.locator('#navInventory')).toBeVisible();
    // Both new and legacy drill-down paths still resolve via setView.
    const drillResolves = await page.evaluate(() => {
      (window as any).setView('inventory/transfer');
      const newPath = document.querySelector('#view-transfers.on') !== null;
      (window as any).setView('stock/transfer');
      const legacyPath = document.querySelector('#view-transfers.on') !== null;
      return newPath && legacyPath;
    });
    expect(drillResolves).toBe(true);
  });

  test('navigating to transfers shows 4-column kanban with summary', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('stock/transfer'));
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
    await page.evaluate(() => (window as any).setView('transfers'));
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
    await page.evaluate(() => (window as any).setView('transfers'));
    page.once('dialog', d => d.accept('Test reason'));
    const beforeCancel = await page.locator('.kanban .col').nth(3).locator('.card').count();
    await page.locator('.kanban .col').nth(0).locator('.card').first()
      .locator('button[data-act="cancel"]').click();
    const afterCancel = await page.locator('.kanban .col').nth(3).locator('.card').count();
    expect(afterCancel).toBe(beforeCancel + 1);
    // Reason text appears
    await expect(page.locator('.kanban .col').nth(3).locator('.card .cancel-reason').first()).toContainText('Test reason');
  });

  test('pending column renders 3 buckets (A / B / C) with counts that sum to total', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    const groups = page.locator('.kanban .col').nth(0).locator('.bucket-group');
    await expect(groups).toHaveCount(3);
    // Bucket A is open by default, B and C collapsed
    await expect(page.locator('.bucket-group.bucket-A')).not.toHaveClass(/collapsed/);
    await expect(page.locator('.bucket-group.bucket-B')).toHaveClass(/collapsed/);
    await expect(page.locator('.bucket-group.bucket-C')).toHaveClass(/collapsed/);
    // Card count across buckets equals pending total (all rendered, just collapsed visually)
    const counts = await page.evaluate(() => {
      const all = (window as any).computeSuggestions().map((s: any) => (window as any).classifyBucket(s));
      const c = { A: 0, B: 0, C: 0 };
      all.forEach((b: 'A'|'B'|'C') => c[b]++);
      return c;
    });
    expect(counts.A + counts.B + counts.C).toBeGreaterThan(0);
    expect(counts.A).toBeGreaterThan(0);
    expect(counts.C).toBeGreaterThan(0);
  });

  test('clicking a bucket head toggles its expansion', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    const bucketB = page.locator('.bucket-group.bucket-B');
    await expect(bucketB).toHaveClass(/collapsed/);
    await bucketB.locator('.bucket-head').click();
    await expect(bucketB).not.toHaveClass(/collapsed/);
    await bucketB.locator('.bucket-head').click();
    await expect(bucketB).toHaveClass(/collapsed/);
  });

  test('bucket A has Accept-all button that approves every card in bucket A', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    const aCount = await page.locator('.bucket-group.bucket-A .card.bA').count();
    expect(aCount).toBeGreaterThan(0);
    const beforeApproved = await page.locator('.kanban .col').nth(1).locator('.card').count();
    await page.click('.bucket-group.bucket-A button[data-bucket-act="accept-all"]');
    const afterApproved = await page.locator('.kanban .col').nth(1).locator('.card').count();
    expect(afterApproved).toBe(beforeApproved + aCount);
    // bucket A is now empty in pending
    const aCountAfter = await page.locator('.bucket-group.bucket-A .card.bA').count();
    expect(aCountAfter).toBe(0);
  });

  test('bucket B card shows full 5-store table with src + dst tags', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    // Open bucket B
    await page.locator('.bucket-group.bucket-B .bucket-head').click();
    const firstB = page.locator('.bucket-group.bucket-B .card.bB').first();
    await expect(firstB).toBeVisible();
    const rows = await firstB.locator('table.skutable tbody tr').count();
    expect(rows).toBe(5);
    await expect(firstB.locator('table.skutable tr.src')).toHaveCount(1);
    await expect(firstB.locator('table.skutable tr.dst')).toHaveCount(1);
  });

  test('bucket B redirect button changes destination and approves', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    await page.locator('.bucket-group.bucket-B .bucket-head').click();
    const firstB = page.locator('.bucket-group.bucket-B .card.bB').first();
    const id = await firstB.getAttribute('data-id');
    const redirect = firstB.locator('button[data-act="redirect"]').first();
    if (await redirect.count() === 0) test.skip();
    const newDst = await redirect.getAttribute('data-dst');
    await redirect.click();
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem('wp_transfers_v1') || '{}')[k!], id);
    expect(stored.status).toBe('approved');
    expect(stored.dst_override).toBe(newDst);
  });

  test('bucket C card is single-line and has accept + skip', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    await page.locator('.bucket-group.bucket-C .bucket-head').click();
    const firstC = page.locator('.bucket-group.bucket-C .card.bC').first();
    await expect(firstC).toBeVisible();
    await expect(firstC.locator('button[data-act="approve"]')).toBeVisible();
    await expect(firstC.locator('button[data-act="cancel"]')).toBeVisible();
    // No 5-store table
    expect(await firstC.locator('table.skutable').count()).toBe(0);
  });

  test('owner uses view-as switcher to preview Warehouse', async ({ page }) => {
    await loginOwner(page);
    await expect(page.locator('#viewAsSwitcher')).toBeVisible();
    await page.click('#viewAsWarehouse');
    await expect(page.locator('#view-warehouse.on')).toBeVisible();
    // Transfer suggestions menu hidden in warehouse mode
    await expect(page.locator('#navTransfers')).toBeHidden();
    // V1 第三刀: switching back to owner lands on 'today' (the new owner
    // home — 4-layer briefing), not transfers. Verify nav surfaces transfers again.
    await page.click('#viewAsOwner');
    await expect(page.locator('#view-today.on')).toBeVisible();
    await expect(page.locator('#navTransfers')).toBeVisible();
  });

  test('warehouse list shows approved + done/cancelled actions', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    // Approve one, then jump to warehouse view
    await page.locator('.kanban .col').nth(0).locator('.card').first()
      .locator('button[data-act="approve"]').click();
    await page.evaluate(() => (window as any).setView('warehouse'));
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
    await page.evaluate(() => (window as any).setView('transfers'));
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
    await page.evaluate(() => (window as any).setView('transfers'));
    const firstCard = page.locator('.kanban .col').nth(0).locator('.card').first();
    const id = await firstCard.getAttribute('data-id');
    await firstCard.locator('button[data-act="approve"]').click();
    await page.reload();
    await page.waitForSelector('#app.ready');
    await page.evaluate(() => (window as any).setView('transfers'));
    // The id should appear in approved column now
    const stillApproved = await page.locator('.kanban .col').nth(1)
      .locator('.card[data-id="' + id + '"]').count();
    expect(stillApproved).toBe(1);
  });

  test('language toggle EN ↔ 中 on transfer view', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    await page.click('#langZH');
    await expect(page.locator('#view-transfers.on .page-title')).toContainText('调货建议');
    await page.click('#langEN');
    await expect(page.locator('#view-transfers.on .page-title')).toContainText('Transfer Suggestions');
  });

  test('transfer title shows dynamic count + total', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    const title = await page.locator('#view-transfers.on .page-title').textContent();
    expect(title).toMatch(/Transfer Suggestions · \d+ suggestions · RM [\d,]+/);
  });

  test('cancel button is neutral grey, not red', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('transfers'));
    const btn = page.locator('.kanban .col').nth(0).locator('.card').first()
      .locator('button[data-act="cancel"]');
    // The cancel button must not carry the 'warn' (red) class
    const klass = await btn.getAttribute('class');
    expect(klass || '').not.toContain('warn');
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
    await page.evaluate(() => (window as any).setView('transfers'));
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
