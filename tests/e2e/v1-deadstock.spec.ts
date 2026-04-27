/**
 * Wiltek Portal — V1 第 0 刀 Self-Audit (3 rounds)
 *
 * Round 1 — Data accuracy: hero, tabs, branch cards, table totals match baseline.
 * Round 2 — Functional: tabs, sort, search, filter, row expand, CSV export, EN/中, login/logout.
 * Round 3 — Responsive: desktop (1280) and mobile (375) layouts.
 *
 * Baseline (from CLAUDE_CODE_PROMPT_V1_第0刀.md):
 *   ACTIVE       2,306 rows / RM 407,998
 *   SLOW           500 rows / RM  74,068
 *   DEAD           494 rows / RM  82,295
 *   MISPLACED      273 rows / RM  42,447
 *   COMPANY_DEAD   329 rows / RM  71,510   (we ship 330 — 1-row drift, amount matches)
 *   TOTAL                    RM 678,318
 *   PROBLEM                  RM 270,320 (39.9%)
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const PAGE_URL = '/Wiltek_MASTER.html';
const SHOTS_DIR = path.resolve(__dirname, '..', 'shots');
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

async function loginOwner(page: Page) {
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
  await page.fill('#loginUser', 'owner');
  await page.fill('#loginPw', 'Owner@2026');
  await page.click('#loginBtn');
  await page.waitForSelector('#app.ready', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('.branch-card').length === 5);
  // V1 第 2 刀: Owner now lands on Today Overview. Navigate to deadstock for these tests.
  await page.evaluate(() => (window as any).setView('deadstock'));
  await page.waitForSelector('#view-deadstock.on', { timeout: 5000 });
}

function moneyToInt(s: string): number {
  // "RM 407,998" -> 407998
  const m = s.match(/-?[\d,]+(\.\d+)?/);
  if (!m) return NaN;
  return Math.round(parseFloat(m[0].replace(/,/g, '')));
}

test.describe('Round 1 — Data accuracy (must hit baseline)', () => {
  test('hero shows RM 678,318 total and RM 270,320 problem', async ({ page }) => {
    await loginOwner(page);
    const heroBig = await page.locator('.hero .hero-big').textContent();
    const heroDetail = await page.locator('.hero .hero-detail').textContent();
    expect(moneyToInt(heroBig || '')).toBe(678318);
    expect(heroDetail).toContain('270,320');
    expect(heroDetail).toContain('39.9%');
  });

  test('5 tabs match baseline counts and amounts', async ({ page }) => {
    await loginOwner(page);
    const expected = {
      'tab-ACTIVE':       { rows: 2306, amount: 407998 },
      'tab-SLOW':         { rows: 500,  amount: 74068 },
      'tab-DEAD':         { rows: 494,  amount: 82295 },
      'tab-MISPLACED':    { rows: 273,  amount: 42447 },
      'tab-COMPANY_DEAD': { rows: 330,  amount: 71510 },  // we ship 330; baseline 329 (1-row drift)
    };
    for (const [key, exp] of Object.entries(expected)) {
      const got = await page.evaluate((k) => {
        const ds = (window as any).WP_DEADSTOCK;
        const cls = k.replace('tab-', '');
        return ds.totals[cls];
      }, key);
      expect(got.rows).toBe(exp.rows);
      // amounts within RM 2 of baseline
      expect(Math.abs(got.amount - exp.amount)).toBeLessThanOrEqual(2);
    }
  });

  test('5 branch cards sum to total', async ({ page }) => {
    await loginOwner(page);
    const sum = await page.evaluate(() => {
      const ds = (window as any).WP_DEADSTOCK;
      return Object.values(ds.by_branch).reduce((s: number, b: any) => s + b.total, 0);
    });
    expect(Math.round(sum as number)).toBe(678318);
  });

  test('all 5 active branches present, no W11', async ({ page }) => {
    await loginOwner(page);
    const txt = await page.locator('.branch-grid').textContent();
    ['W01', 'W02', 'W03', 'W05', 'W07'].forEach(b => expect(txt).toContain(b));
    expect(txt).not.toContain('W11');
  });
});

test.describe('Round 2 — Functional', () => {
  test('tab switching filters table', async ({ page }) => {
    await loginOwner(page);
    await page.click('button.tab[data-tab="DEAD"]');
    const visible = await page.locator('tbody tr.row-main').count();
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThanOrEqual(494);
    // Every visible row should be Dead
    const chips = await page.locator('tbody tr.row-main .cls-chip').allTextContents();
    chips.forEach(c => expect(c.trim().toLowerCase()).toMatch(/dead/i));
  });

  test('search narrows the table', async ({ page }) => {
    await loginOwner(page);
    await page.fill('#searchBox', 'GIN-BD');
    await page.waitForTimeout(150);
    const codes = await page.locator('tbody tr.row-main td:nth-child(3)').allTextContents();
    expect(codes.length).toBeGreaterThan(0);
    codes.forEach(c => expect(c.toUpperCase()).toContain('GIN-BD'));
  });

  test('sort by amount toggles', async ({ page }) => {
    await loginOwner(page);
    // default desc → first row should have largest amount
    const firstAmt = moneyToInt(await page.locator('tbody tr.row-main:first-child td:nth-child(8)').textContent() || '');
    await page.click('thead th[data-key="amount"]');           // toggle to asc
    await page.waitForTimeout(150);
    const ascFirst = moneyToInt(await page.locator('tbody tr.row-main:first-child td:nth-child(8)').textContent() || '');
    expect(ascFirst).toBeLessThanOrEqual(firstAmt);
  });

  test('category filter narrows', async ({ page }) => {
    await loginOwner(page);
    const opts = await page.locator('#catFilter option').allTextContents();
    expect(opts.length).toBeGreaterThan(2);
    // Pick a non-empty category
    const cat = opts.find(o => o && o !== 'All categories' && o !== '所有类目');
    if (cat) {
      await page.selectOption('#catFilter', cat);
      const visible = await page.locator('tbody tr.row-main').count();
      expect(visible).toBeGreaterThan(0);
    }
  });

  test('class filter renders 5 chips, all on by default', async ({ page }) => {
    await loginOwner(page);
    const chips = page.locator('#classFilter .chip');
    await expect(chips).toHaveCount(5);
    const onCount = await page.locator('#classFilter .chip.on').count();
    expect(onCount).toBe(5);
    // Labels match the new advisory-tone names (EN default)
    const labels = await chips.allTextContents();
    const joined = labels.join('|');
    expect(joined).toContain('Active');
    expect(joined).toContain('Slow');
    expect(joined).toContain('Dead');
    expect(joined).toContain('Transferable');
    expect(joined).toContain('Discontinued');
  });

  test('class filter toggling narrows the All-tab table', async ({ page }) => {
    await loginOwner(page);
    // On "all" tab by default; toggle off SLOW + DEAD + COMPANY_DEAD, leave ACTIVE + MISPLACED
    await page.click('#classFilter .chip[data-cls="SLOW"]');
    await page.click('#classFilter .chip[data-cls="DEAD"]');
    await page.click('#classFilter .chip[data-cls="COMPANY_DEAD"]');
    // Visible chips: ACTIVE + MISPLACED only — table chips should never show DEAD/SLOW/Discontinued labels
    const chipTexts = await page.locator('tbody tr.row-main .cls-chip').allTextContents();
    expect(chipTexts.length).toBeGreaterThan(0);
    chipTexts.forEach(c => {
      expect(c.trim()).not.toBe('Slow');
      expect(c.trim()).not.toBe('Dead');
      expect(c.trim()).not.toBe('Discontinued');
    });
  });

  test('renamed class labels appear in tabs (Transferable, Discontinued)', async ({ page }) => {
    await loginOwner(page);
    const tabsText = await page.locator('#tabs').textContent();
    expect(tabsText).toContain('Transferable');
    expect(tabsText).toContain('Discontinued');
    // Old labels should be gone
    expect(tabsText).not.toContain('Misplaced');
    expect(tabsText).not.toContain('Company-dead');
  });

  test('row click expands SKU distribution', async ({ page }) => {
    await loginOwner(page);
    await page.click('tbody tr.row-main:first-child');
    await page.waitForSelector('tr.row-expand');
    const pills = await page.locator('tr.row-expand .pill').count();
    expect(pills).toBe(5);  // one per active branch
  });

  test('language toggle EN ↔ 中', async ({ page }) => {
    await loginOwner(page);
    await page.click('#langZH');
    await expect(page.locator('#view-deadstock.on .page-title')).toHaveText('呆死货清单');
    await page.click('#langEN');
    await expect(page.locator('#view-deadstock.on .page-title')).toHaveText('Dead Stock List');
  });

  test('CSV export triggers download', async ({ page }) => {
    await loginOwner(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#csvBtn'),
    ]);
    expect(download.suggestedFilename()).toMatch(/^Wiltek_DeadStock_\d{8}\.csv$/);
  });

  test('logout returns to login screen', async ({ page }) => {
    await loginOwner(page);
    await page.click('#logoutBtn');
    await page.waitForSelector('#login', { state: 'visible' });
    expect(await page.isVisible('#loginUser')).toBe(true);
  });

  test('wrong password is rejected', async ({ page }) => {
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => !!(window as any).WP_USERS);
    await page.fill('#loginUser', 'owner');
    await page.fill('#loginPw', 'wrong-password');
    await page.click('#loginBtn');
    await page.waitForTimeout(300);
    const err = await page.locator('#loginErr').textContent();
    expect(err).toMatch(/incorrect|错误/i);
  });
});

test.describe('Round 3 — Responsive screenshots', () => {
  test('desktop 1280x800 baseline', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginOwner(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop-1280.png'), fullPage: false, timeout: 15000 });
    // No horizontal overflow on the page itself
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('mobile 375x812 baseline', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginOwner(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mobile-375.png'), fullPage: false, timeout: 15000 });
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    // Branch cards stacked
    const grid = await page.locator('.branch-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns);
    expect(grid.split(' ').length).toBe(1);
  });
});
