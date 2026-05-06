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

test.describe('Round 4 — V1 第6刀: 6-domain architecture + sanity', () => {
  test('menu shows 6 domains, no Stock/Purchasing top-level', async ({ page }) => {
    await loginOwner(page);
    const visibleNavs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('nav.menu > .group:not(.legacy-nav) .sub-item[data-view]'))
        .map(el => el.getAttribute('data-view')));
    expect(visibleNavs).toEqual(['sales','inventory','customers','products','finance','hr']);
  });

  test('inventory dashboard renders required strings (总库存值/在途 PO/F-N-S/lead time)', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('inventory'));
    await page.waitForSelector('#view-inventory.on');
    const html = await page.locator('#view-inventory').innerHTML();
    expect(html).toContain('总库存值');
    expect(html).toContain('在途 PO');
    expect(html).toContain('F-N-S');
    expect(html).toContain('lead time');
  });

  test('sales dashboard renders depth sections (品类/80/20/Top 20/价格带/四象限)', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('sales'));
    await page.waitForSelector('#view-sales.on');
    const html = await page.locator('#view-sales').innerHTML();
    expect(html).toContain('品类');
    expect(html).toContain('80/20');
    expect(html).toContain('Top 20');
    expect(html).toContain('价格带');
    expect(html).toContain('四象限');
  });

  test('products dashboard renders SKU 总数 + 品牌结构 strings', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('products'));
    await page.waitForSelector('#view-products.on');
    const html = await page.locator('#view-products').innerHTML();
    expect(html).toContain('SKU 总数');
    expect(html).toContain('品牌结构');
  });

  test('admin/sanity route resolves and shows sanity table', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setView('admin/sanity'));
    await page.waitForSelector('#view-admin-sanity.on');
    const rows = await page.locator('#adminSanityTable tbody tr.sanity-row').count();
    expect(rows).toBeGreaterThanOrEqual(6);
  });

  test('all sanity checks pass (cross-source consistency)', async ({ page }) => {
    await loginOwner(page);
    const fails = await page.evaluate(() => {
      const checks = (window as any).runSanityChecks();
      return checks.filter((c: any) => !c.pass).map((c: any) => c.check + ' :: ' + c.detail);
    });
    expect(fails).toEqual([]);
  });

  test('status light renders in header and clicks → admin/sanity', async ({ page }) => {
    await loginOwner(page);
    await expect(page.locator('#dataSanityLight')).toBeVisible();
    await page.click('#dataSanityLight');
    await page.waitForSelector('#view-admin-sanity.on');
  });

  test('legacy stock/purchasing routes still resolve to inventory', async ({ page }) => {
    await loginOwner(page);
    const ok = await page.evaluate(() => {
      (window as any).setView('stock');
      const a = document.querySelector('#view-inventory.on') !== null;
      (window as any).setView('purchasing');
      const b = document.querySelector('#view-inventory.on') !== null;
      return a && b;
    });
    expect(ok).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────
   Round 5 — V1 第7刀: Refresh button + Branch Manager view
   - 3-way view-as switcher (Owner / Branch Manager / Warehouse)
   - branch picker (W01-W07) + URL ?role=branch&branch=W0X persist
   - Branch view scopes Sales/Inventory/Customers/Products to the branch
   - Branch view hides Finance + HR menu items
   - 🔄 Refresh button calls /api/proxy live and overlays + toast
   ──────────────────────────────────────────────────────────────────── */
test.describe('Round 5 — V1 第7刀: Refresh + Branch Manager view', () => {
  test('header has Refresh button and 3 view-as buttons', async ({ page }) => {
    await loginOwner(page);
    await expect(page.locator('#refreshBtn')).toBeVisible();
    await expect(page.locator('#viewAsOwner')).toBeVisible();
    await expect(page.locator('#viewAsBranch')).toBeVisible();
    await expect(page.locator('#viewAsWarehouse')).toBeVisible();
  });

  test('switching to Branch Manager shows picker + banner', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setViewAs('branch'));
    await expect(page.locator('#branchPicker')).toBeVisible();
    await expect(page.locator('#branchBanner.on')).toBeVisible();
    const txt = await page.locator('#branchBanner').innerText();
    // Default first branch is W01
    expect(txt).toContain('W01');
  });

  test('selecting W05 in picker scopes inventory dashboard to W05', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => {
      (window as any).setViewAs('branch');
      (window as any).setBranch('W05');
      (window as any).setView('inventory');
    });
    await page.waitForSelector('#view-inventory.on');
    const result = await page.evaluate(() => {
      const ds = (window as any).WP_DEADSTOCK || {};
      const allRows = (ds.rows || []).filter((r: any) => r.branch === 'W05').length;
      const html = document.querySelector('#view-inventory')?.innerHTML || '';
      return { allRows, hasW05: html.indexOf('W05') >= 0, branch: (window as any).BRANCH_VIEW };
    });
    expect(result.branch).toBe('W05');
    expect(result.hasW05).toBe(true);
    expect(result.allRows).toBeGreaterThan(0);
  });

  test('branch view hides Finance + HR menu items', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => (window as any).setViewAs('branch'));
    await expect(page.locator('#navFinance.hidden')).toHaveCount(1);
    await expect(page.locator('#navHr.hidden')).toHaveCount(1);
    // Owner-mode shouldn't have those hidden
    await page.evaluate(() => (window as any).setViewAs('owner'));
    await expect(page.locator('#navFinance.hidden')).toHaveCount(0);
    await expect(page.locator('#navHr.hidden')).toHaveCount(0);
  });

  test('URL persists ?role=branch&branch=W03 across reload', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => {
      (window as any).setViewAs('branch');
      (window as any).setBranch('W03');
    });
    const url1 = page.url();
    expect(url1).toContain('role=branch');
    expect(url1).toContain('branch=W03');
    await page.reload();
    await page.waitForSelector('#app.ready');
    const state = await page.evaluate(() => ({
      viewAs: (window as any).VIEW_AS,
      branch: (window as any).BRANCH_VIEW,
    }));
    expect(state.viewAs).toBe('branch');
    expect(state.branch).toBe('W03');
  });

  test('customers dashboard scopes member count to branch', async ({ page }) => {
    await loginOwner(page);
    const baseline = await page.evaluate(() => {
      (window as any).setView('customers');
      const html = document.querySelector('#view-customers')?.innerHTML || '';
      const m = html.match(/Total members[\s\S]*?<div class="value">([\d,]+)/);
      return m ? parseInt(m[1].replace(/,/g,''),10) : -1;
    });
    const w01 = await page.evaluate(() => {
      (window as any).setViewAs('branch');
      (window as any).setBranch('W01');
      (window as any).setView('customers');
      const html = document.querySelector('#view-customers')?.innerHTML || '';
      const m = html.match(/<div class="value">([\d,]+)/);
      return m ? parseInt(m[1].replace(/,/g,''),10) : -1;
    });
    expect(baseline).toBeGreaterThan(0);
    expect(w01).toBeGreaterThan(0);
    expect(w01).toBeLessThan(baseline);
  });

  test('Refresh button toggles loading class then succeeds or fails honestly', async ({ page }) => {
    await loginOwner(page);
    // Mock /api/proxy to return ok payloads instantly so we don't depend on prod
    await page.route('**/api/proxy*', route => {
      const url = new URL(route.request().url());
      const type = url.searchParams.get('type') || 'all';
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, type, data: { _stub: true, ts: Date.now() } }),
      });
    });
    const before = await page.evaluate(() => localStorage.getItem('wp_last_refresh_v1'));
    await page.click('#refreshBtn');
    // Wait for toast to appear
    await page.waitForSelector('#wpToast.show', { timeout: 5000 });
    const toast = await page.locator('#wpToast').innerText();
    expect(toast.toLowerCase()).toMatch(/data updated|数据已更新/);
    const after = await page.evaluate(() => localStorage.getItem('wp_last_refresh_v1'));
    expect(after).not.toBe(before);
    expect(parseInt(after || '0', 10)).toBeGreaterThan(0);
  });

  test('Refresh fails gracefully when proxy returns error', async ({ page }) => {
    await loginOwner(page);
    await page.route('**/api/proxy*', route => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'down' })
    }));
    await page.click('#refreshBtn');
    await page.waitForSelector('#wpToast.show.fail', { timeout: 5000 });
    const toast = await page.locator('#wpToast').innerText();
    expect(toast.toLowerCase()).toMatch(/unreachable|未响应/);
  });

  test('header data-date shows last refresh HH:MM after refresh', async ({ page }) => {
    await loginOwner(page);
    await page.route('**/api/proxy*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, type: 'sales', data: {} }),
    }));
    await page.click('#refreshBtn');
    await page.waitForSelector('#wpToast.show', { timeout: 5000 });
    const dataDate = await page.locator('#dataDate').innerText();
    expect(dataDate).toMatch(/last refresh \d{2}:\d{2}|上次刷新 \d{2}:\d{2}/);
  });

  test('owner view (no role param) leaves dashboards company-wide', async ({ page }) => {
    await loginOwner(page);
    const state = await page.evaluate(() => ({
      viewAs: (window as any).VIEW_AS,
      branch: (window as any).BRANCH_VIEW,
      bannerOn: !!document.querySelector('#branchBanner.on'),
    }));
    expect(state.viewAs).toBe('owner');
    expect(state.branch).toBeNull();
    expect(state.bannerOn).toBe(false);
  });
});

/* ───────────────────────────────────────────────────────────────────
   Round 6 — V1 第8刀: Live floatation (Walk-in) from 5 W0X Sheets
   ─────────────────────────────────────────────────────────────────── */
test.describe('Round 6 — V1 第8刀: Live floatation (Walk-in)', () => {
  // Sample payload mirroring api/floatation.js buildResponse() shape
  const liveFloatation = {
    ok: true,
    fetched_at: '2026-05-06T08:00:00.000Z',
    year: 2026,
    months: ['2026-03', '2026-04', '2026-05'],
    month_idx: [3, 4, 5],
    races: [
      { key: 'chinese', label_en: 'Chinese', label_zh: '华族',
        walkin: [482, 461, 61], purchase: [333, 318, 44],
        amount: [104791.6, 93737.7, 13186],
        basket: [314.69, 294.77, 299.68], cr: [0.6909, 0.6898, 0.7213] },
      { key: 'malay', label_en: 'Malay', label_zh: '马来族',
        walkin: [700, 720, 80], purchase: [510, 540, 55],
        amount: [180000, 195000, 20000],
        basket: [352.94, 361.11, 363.64], cr: [0.7286, 0.75, 0.6875] },
      { key: 'indian', label_en: 'Indian', label_zh: '印度族',
        walkin: [55, 50, 8], purchase: [45, 40, 6],
        amount: [12500, 11000, 1800],
        basket: [277.78, 275, 300], cr: [0.8182, 0.8, 0.75] },
      { key: 'others', label_en: 'Others', label_zh: '其他',
        walkin: [25, 26, 4], purchase: [22, 23, 3],
        amount: [6500, 7000, 900],
        basket: [295.45, 304.35, 300], cr: [0.88, 0.8846, 0.75] },
    ],
    totals: {
      walkin:   [1262, 1257, 153],
      purchase: [910, 921, 108],
      amount:   [303791.6, 306737.7, 35886],
      basket:   [333.84, 333.05, 332.28],
      cr:       [0.7211, 0.7327, 0.7059],
    },
    by_branch: {
      W01: { walkin: 577, purchase: 403, amount: 130736, basket: 324.41, cr: 0.6984 },
      W02: { walkin: 784, purchase: 532, amount: 190764, basket: 358.58, cr: 0.6786 },
      W03: { walkin: 600, purchase: 420, amount: 145000, basket: 345,    cr: 0.7    },
      W05: { walkin: 460, purchase: 360, amount: 138000, basket: 383.33, cr: 0.7826 },
      W07: { walkin: 251, purchase: 224, amount: 75000,  basket: 334.82, cr: 0.8924 },
    },
    note_en: 'Live walk-in (2026-03 to 2026-05) — pulled from 5 W0X Customer Floatation Sheets at fetched_at.',
    note_zh: '实时进店数据(2026-03 至 2026-05)— 来自 5 家分店 Customer Floatation Sheet。',
    source: 'live:google-sheets',
  };

  test('GET /api/floatation contract — frontend mutates WP_TODAY.race', async ({ page }) => {
    await page.route('**/api/floatation*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(liveFloatation),
    }));
    await loginOwner(page);
    // Wait for the auto-fired floatation fetch on enterApp() to settle
    await page.waitForFunction(() => {
      const r = (window as any).WP_CUSTOMERS?.race;
      return !!(r && r._live === true);
    }, { timeout: 5000 });
    const race = await page.evaluate(() => (window as any).WP_CUSTOMERS?.race);
    expect(race.months).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(race.races).toHaveLength(4);
    expect(race.races[0].key).toBe('chinese');
    expect(race.races[0].walkin).toEqual([482, 461, 61]);
    expect(race.totals.walkin).toEqual([1262, 1257, 153]);
    expect(race.by_branch.W01.walkin).toBe(577);
  });

  test('Customer Insights walk-in chart renders LIVE numbers, not hardcoded', async ({ page }) => {
    await page.route('**/api/floatation*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(liveFloatation),
    }));
    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_CUSTOMERS?.race?._live === true, { timeout: 5000 });
    await page.evaluate(() => (window as any).setView && (window as any).setView('cust-insights'));
    await page.waitForSelector('#ciRaceTable tbody tr', { timeout: 5000 });
    const tableHtml = await page.locator('#ciRaceTable').innerHTML();
    // Live total walk-in across 3-month window = 1262 + 1257 + 153 = 2672 (rendered "2,672")
    expect(tableHtml).toMatch(/2,672/);
    // Hardcoded triplet 683,468,565 (Chinese walk-in Jan/Feb/Mar) must NOT survive
    expect(tableHtml).not.toMatch(/683.*468.*565/);
  });

  test('Refresh button refetches floatation + bumps WP_TODAY.race fetched_at', async ({ page }) => {
    let callCount = 0;
    await page.route('**/api/floatation*', route => {
      callCount++;
      const payload = { ...liveFloatation, fetched_at: new Date(Date.now() + callCount * 1000).toISOString() };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await page.route('**/api/proxy*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, type: 'x', data: {} }),
    }));
    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_CUSTOMERS?.race?._live === true, { timeout: 5000 });
    const ts1 = await page.evaluate(() => (window as any).WP_CUSTOMERS.race._fetched_at);
    await page.click('#refreshBtn');
    await page.waitForSelector('#wpToast.show', { timeout: 5000 });
    const ts2 = await page.evaluate(() => (window as any).WP_CUSTOMERS.race._fetched_at);
    expect(ts2).not.toBe(ts1);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test('Floatation failure degrades gracefully — app keeps loading', async ({ page }) => {
    await page.route('**/api/floatation*', route => route.fulfill({
      status: 502, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'all 5 sheets unreachable' }),
    }));
    await loginOwner(page);
    await page.waitForTimeout(800);
    // loginOwner navigates to 'today' view; that's where it lands.
    await expect(page.locator('#view-today.on')).toBeVisible();
    const live = await page.evaluate(() => (window as any).WP_CUSTOMERS?.race?._live);
    expect(live).toBeUndefined();
  });

  test('hardcoded RACE_DATA literal is purged from baked customers-data.js', async ({ request }) => {
    const r = await request.get('/assets/customers-data.js');
    const txt = await r.text();
    expect(txt).not.toMatch(/"race":\{/);
    expect(txt).not.toMatch(/683,468,565/);
    expect(txt).not.toMatch(/walkin":\[683/);
  });

  test('window.fetchFloatationLive is exposed and returns ok shape', async ({ page }) => {
    await page.route('**/api/floatation*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(liveFloatation),
    }));
    await loginOwner(page);
    const result = await page.evaluate(async () => {
      const fn = (window as any).fetchFloatationLive;
      if (typeof fn !== 'function') return { ok: false, why: 'not exposed' };
      const r = await fn();
      return { ok: r.ok, months: r.months };
    });
    expect(result.ok).toBe(true);
    expect(result.months).toEqual(['2026-03', '2026-04', '2026-05']);
  });
});
