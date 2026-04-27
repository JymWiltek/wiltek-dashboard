/**
 * Wiltek Portal — V1 第 2 刀 Self-Audit (3 rounds)
 *
 * Round 1 — Data accuracy: Today data file loads, candidates span ≥ 2 dimensions,
 *           churn / PO summaries match builder output.
 * Round 2 — Functional: banner, 3-cards selection, jump buttons,
 *           churn page (search + CSV), PO exceptions (tabs).
 * Round 3 — Responsive: desktop (1280) + mobile (375).
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const PAGE_URL = '/Wiltek_MASTER.html';
const SHOTS_DIR = path.resolve(__dirname, '..', 'shots');
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

async function loginOwner(page: Page) {
  // V1 第 5 刀: default landing view changed from 'today' → 'sales' (the
  // 7-domain top-level menu's default). Navigate explicitly to today after
  // login so the existing Today Overview assertions remain meaningful.
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
  await page.fill('#loginUser', 'owner');
  await page.fill('#loginPw', 'Owner@2026');
  await page.click('#loginBtn');
  await page.waitForSelector('#app.ready', { timeout: 5000 });
  await page.waitForSelector('#view-sales.on', { timeout: 5000 });
  await page.evaluate(() => (window as any).setView('today'));
  await page.waitForSelector('#view-today.on', { timeout: 5000 });
}

function moneyToInt(s: string): number {
  const m = s.match(/-?[\d,]+(\.\d+)?/);
  if (!m) return NaN;
  return Math.round(parseFloat(m[0].replace(/,/g, '')));
}

test.describe('Round 1 — Today data accuracy', () => {
  test('WP_TODAY loads with churn + po_exceptions slices', async ({ page }) => {
    await loginOwner(page);
    const td = await page.evaluate(() => {
      const t = (window as any).WP_TODAY;
      return {
        hasChurn: !!t?.churn,
        hasPo: !!t?.po_exceptions,
        nChurnHigh: t?.churn?.summary?.n_high_value,
        nPoOverdue: t?.po_exceptions?.summary?.n_overdue,
        nPoDelayed: t?.po_exceptions?.summary?.n_delayed,
        snapshot: t?.meta?.snapshot,
      };
    });
    expect(td.hasChurn).toBe(true);
    expect(td.hasPo).toBe(true);
    // Builder produced specific counts on the 2026-03 snapshot
    expect(td.nChurnHigh).toBe(1311);
    expect(td.nPoOverdue).toBe(139);
    expect(td.nPoDelayed).toBe(833);
    expect(td.snapshot).toBe('2026-03');
  });

  test('Owner lands on Sales (7-domain default)', async ({ page }) => {
    // After V1 第 5 刀, owner default landing is 'sales' not 'today'.
    // We bypass loginOwner here because that helper navigates to 'today'
    // for the rest of the suite — this test specifically asserts the raw
    // default landing view post-login.
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
    await page.fill('#loginUser', 'owner');
    await page.fill('#loginPw', 'Owner@2026');
    await page.click('#loginBtn');
    await page.waitForSelector('#app.ready', { timeout: 5000 });
    await page.waitForSelector('#view-sales.on', { timeout: 5000 });
    const onView = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.view.on')).map(v => (v as HTMLElement).id));
    expect(onView).toEqual(['view-sales']);
  });

  test('banner shows total + problem inventory amounts', async ({ page }) => {
    await loginOwner(page);
    const head = await page.locator('#todayBanner .td-headline').textContent();
    expect(moneyToInt(head!)).toBe(678318);
    expect(head).toContain('270,320');
    expect(head).toContain('39.9%');
  });

  test('3 cards picked, spanning ≥ 2 dimensions', async ({ page }) => {
    await loginOwner(page);
    const dims = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#todayCards .today-card'));
      const kinds = cards.map(c => c.getAttribute('data-kind'));
      // Map kind → dimension (mirror of HTML logic)
      const dimMap: Record<string, string> = {
        deadstock: 'inventory', misplaced: 'inventory',
        'po-overdue': 'procurement', 'po-delayed': 'procurement',
        churn: 'customer',
      };
      return kinds.map(k => k ? dimMap[k] : 'unknown');
    });
    expect(dims.length).toBe(3);
    const uniqueDims = new Set(dims);
    expect(uniqueDims.size).toBeGreaterThanOrEqual(2);
  });

  test('5-store table sorted by problem % descending', async ({ page }) => {
    await loginOwner(page);
    const pcts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#todayStores .ts-row:not(.head) .ts-pct'))
        .map(e => parseFloat((e.textContent || '').replace('%', ''))));
    expect(pcts.length).toBe(5);
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeLessThanOrEqual(pcts[i - 1]);
    }
  });

  test('role status row has 4 cards', async ({ page }) => {
    await loginOwner(page);
    const roles = await page.locator('#todayRoles .tr-card').count();
    expect(roles).toBe(4);
    const liveCount = await page.locator('#todayRoles .tr-card.live').count();
    const idleCount = await page.locator('#todayRoles .tr-card.idle').count();
    expect(liveCount).toBe(2);  // owner + warehouse
    expect(idleCount).toBe(2);  // finance + marketing
  });
});

test.describe('Round 2 — Today functional', () => {
  test('jump button on first card switches view', async ({ page }) => {
    await loginOwner(page);
    const target = await page.locator('#todayCards .today-card').first().getAttribute('data-jump');
    await page.locator('#todayCards .today-card').first().locator('[data-jump-btn]').click();
    await page.waitForTimeout(200);
    const onView = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.view.on')).map(v => (v as HTMLElement).id));
    expect(onView).toContain('view-' + target);
  });

  test('today nav menu is active when on today view', async ({ page }) => {
    // After V1 第 5 刀 the loginOwner helper jumps to 'today'. The 'today'
    // leaf is a drill-down of Sales — both 'sales' (parent) and 'today'
    // (leaf) carry .active. We check that 'sales' is among the actives,
    // since 'today' itself isn't in the visible 7-domain menu anymore.
    await loginOwner(page);
    const actives = await page.locator('nav.menu .sub-item.active').evaluateAll(
      els => els.map(e => e.getAttribute('data-view')));
    // 'sales' is the visible domain; 'today' is the legacy hidden anchor.
    expect(actives).toContain('sales');
  });

  test('language toggle reflows banner + cards', async ({ page }) => {
    await loginOwner(page);
    await page.click('#langZH');
    await expect(page.locator('#todayBanner .td-date')).toContainText('今天');
    const headline = await page.locator('#todayBanner .td-headline').textContent();
    expect(headline).toContain('问题库存');
    await page.click('#langEN');
    const headlineEN = await page.locator('#todayBanner .td-headline').textContent();
    expect(headlineEN).toContain('problem inventory');
  });

  test('lapsed customers list opens with all rows', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('customer-churn'));
    await page.waitForSelector('#view-customer-churn.on');
    const rows = await page.locator('#ccList .sl-row:not(.head)').count();
    expect(rows).toBeGreaterThan(50);
    const summaryText = await page.locator('#ccSummary').textContent();
    expect(summaryText).toContain('1,311');
  });

  test('lapsed customers search narrows', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('customer-churn'));
    await page.fill('#ccSearch', 'MOUSSA');
    await page.waitForTimeout(150);
    const rows = await page.locator('#ccList .sl-row:not(.head)').count();
    expect(rows).toBe(1);
  });

  test('lapsed customers CSV export', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('customer-churn'));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#ccCsvBtn'),
    ]);
    expect(download.suggestedFilename()).toMatch(/^Wiltek_LapsedCustomers_\d{8}\.csv$/);
  });

  test('PO exceptions tab toggle switches list', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('po-exceptions'));
    await page.waitForSelector('#view-po-exceptions.on');
    const overdueRows = await page.locator('#peListBody .sl-row:not(.head)').count();
    expect(overdueRows).toBeGreaterThan(0);
    await page.click('[data-pe-tab="delayed"]');
    await page.waitForTimeout(150);
    const delayedActive = await page.locator('#peTabs button.on').getAttribute('data-pe-tab');
    expect(delayedActive).toBe('delayed');
  });

  test('PO exceptions summary numbers match builder', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('po-exceptions'));
    const txt = await page.locator('#peSummary').textContent();
    expect(txt).toContain('139');   // overdue
    expect(txt).toContain('833');   // delayed
  });

  test('drill-down to lapsed customers via Customers domain', async ({ page }) => {
    // V1 第 5 刀: churn list is now a drill-down of the Customers domain
    // dashboard. The legacy #navChurn anchor still exists but is hidden.
    // We exercise the canonical path-form route 'customers/lapsed'.
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('customers/lapsed'));
    await page.waitForSelector('#view-customer-churn.on');
    expect(await page.locator('#view-customer-churn .page-title').textContent()).toMatch(/Lapsed Customers/);
  });

  test('drill-down to PO exceptions via Purchasing domain', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('purchasing/exceptions'));
    await page.waitForSelector('#view-po-exceptions.on');
    expect(await page.locator('#view-po-exceptions .page-title').textContent()).toMatch(/Purchase Exceptions/);
  });
});

test.describe('Round 3 — Today responsive', () => {
  test('desktop 1280 today page screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginOwner(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'today-desktop-1280.png'), fullPage: false, timeout: 15000 });
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('mobile 375 today page screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginOwner(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'today-mobile-375.png'), fullPage: false, timeout: 15000 });
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
});
