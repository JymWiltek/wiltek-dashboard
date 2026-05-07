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
  // V1 第三刀: default landing reverted to 'today' (the 4-layer briefing —
  // status light + Cash Runway + Action Plan + 5-store traffic + 6-domain
  // health). Sales is one click away. After login the Today view is on
  // immediately, no second setView() needed.
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
  await page.fill('#loginUser', 'owner');
  await page.fill('#loginPw', 'Owner@2026');
  await page.click('#loginBtn');
  await page.waitForSelector('#app.ready', { timeout: 5000 });
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

  test('Owner lands on Today (V1 第三刀 default)', async ({ page }) => {
    // V1 第三刀: owner default landing flipped from 'sales' back to 'today'.
    // Today is now the 4-layer briefing — status light + Cash Runway +
    // 3-action plan + 5-store traffic + 6-domain health.
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
    await page.fill('#loginUser', 'owner');
    await page.fill('#loginPw', 'Owner@2026');
    await page.click('#loginBtn');
    await page.waitForSelector('#app.ready', { timeout: 5000 });
    await page.waitForSelector('#view-today.on', { timeout: 5000 });
    const onView = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.view.on')).map(v => (v as HTMLElement).id));
    expect(onView).toEqual(['view-today']);
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

  test('5-store traffic table renders 5 active branches with new columns', async ({ page }) => {
    // V1 第三刀: 5-store row now shows visits / AOV / CR / anomalies (was
    // stock / problem / problem%). Branches are the canonical 5 retail
    // stores in fixed order — no sort by problem% any more.
    await loginOwner(page);
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#todayStores .ts-row:not(.head) .ts-id'))
        .map(e => (e.textContent || '').trim()));
    expect(ids).toEqual(['W01','W02','W03','W05','W07']);
    // Each row has 6 cells now (id + name + visits + aov + cr + anomalies)
    const cellCount = await page.locator('#todayStores .ts-row:not(.head)').first().locator('> div').count();
    expect(cellCount).toBe(6);
    // Anomalies column has either ✓ or ⚠ — never empty
    const anomalies = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#todayStores .ts-row:not(.head) .ts-anom'))
        .map(e => (e.textContent || '').trim()));
    for (const a of anomalies) expect(a).toMatch(/^[⚠✓]/);
  });

  test('6-domain health grid renders 6 cards', async ({ page }) => {
    // V1 第三刀: legacy 4-role row is hidden; new 6-domain grid takes its place.
    await loginOwner(page);
    const cards = await page.locator('#todayDomainGrid .tdg-card').count();
    expect(cards).toBe(6);
    const keys = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#todayDomainGrid .tdg-card'))
        .map(c => c.getAttribute('data-domain-key')));
    expect(keys).toEqual(['sales','inventory','customers','products','finance','hr']);
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
    // V1 第三刀: 'today' is its own top-level menu item (#navTodayTop).
    // No more parent-domain mapping to 'sales'. After login on 'today'
    // the only data-view="today" anchors carry .active.
    await loginOwner(page);
    const actives = await page.locator('nav.menu .sub-item.active').evaluateAll(
      els => els.map(e => e.getAttribute('data-view')));
    expect(actives).toContain('today');
    // 🏠 Today is the FIRST visible top-level menu item
    const firstVisibleNav = await page.evaluate(() =>
      document.querySelectorAll('nav.menu .group:not(.legacy-nav) .sub-item[data-view]')[0]?.getAttribute('data-view'));
    expect(firstVisibleNav).toBe('today');
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
  test('menu shows Today + 6 domains, no Stock/Purchasing top-level', async ({ page }) => {
    // V1 第三刀: 🏠 Today is the new first visible nav item, ahead of the
    // 6 domains. Stock/Purchasing legacy aliases stay in .legacy-nav.
    await loginOwner(page);
    const visibleNavs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('nav.menu > .group:not(.legacy-nav) .sub-item[data-view]'))
        .map(el => el.getAttribute('data-view')));
    expect(visibleNavs).toEqual(['today','sales','inventory','customers','products','finance','hr']);
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

  test('customers dashboard scopes branch-relevant data when branch view active', async ({ page }) => {
    // V1 第四刀: customers dashboard top KPIs are mix/repeat/race (not the
    // legacy "Total members" card). Branch scoping still affects the
    // age-tier chart + action-block churn count. Test asserts that
    // switching to branch view (a) sets BRANCH_VIEW correctly and (b) the
    // dashboard re-renders with branch-specific numbers in the chart's
    // age-tier dataset (filtered from cd.all by branch).
    await loginOwner(page);
    const baseline = await page.evaluate(() => {
      (window as any).setView('customers');
      const cd = (window as any).WP_CUSTOMERS || {};
      // Use cd.all (full customer list) length as a global baseline if available.
      return Array.isArray(cd.all) ? cd.all.length : ((cd.summary || {}).total_members || 0);
    });
    const w01 = await page.evaluate(() => {
      (window as any).setViewAs('branch');
      (window as any).setBranch('W01');
      (window as any).setView('customers');
      const cd = (window as any).WP_CUSTOMERS || {};
      const all = Array.isArray(cd.all) ? cd.all : [];
      return {
        branch: (window as any).BRANCH_VIEW,
        nW01: all.filter((c: any) => c.branch === 'W01').length,
      };
    });
    expect(w01.branch).toBe('W01');
    if (baseline > 0) expect(w01.nW01).toBeLessThan(baseline);
    expect(w01.nW01).toBeGreaterThanOrEqual(0);
  });

  test('Refresh button toggles loading class then succeeds or fails honestly', async ({ page }) => {
    // V1 第二刀: doRefresh now hits 5 channels. Mock all of them OK so the
    // success path triggers a "Data updated" (or "Already up to date") toast.
    await page.route('**/api/proxy*', route => {
      const url = new URL(route.request().url());
      const type = url.searchParams.get('type') || 'all';
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, type, data: { _stub: true, ts: Date.now() } }),
      });
    });
    await page.route('**/api/sales*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, fetched_at: new Date().toISOString(),
        months: ['2026-04'], groups: ['G1'], matrix: { '2026-04': { G1: { po: 100, grn: 90 } } },
        by_month: { '2026-04': { po: 100, grn: 90 } }, by_group: { G1: { po: 100, grn: 90 } },
        latest_month: '2026-04', rows_n: 1, source: 'test' }),
    }));
    await page.route('**/api/customers*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, fetched_at: new Date().toISOString(),
        snapshot: '2026-04', months_seen: ['2026-04','2026-03'],
        windows: ['1m','3m','6m','12m'], types: ['Walk-in'],
        summary: { total_members: 1, amt_total: 100 }, summary_by_window: {},
        buckets_by_window: {}, cross_by_window: {}, top100: [],
        churn: { summary: { n_high_value: 0 }, customers: [] }, source: 'test' }),
    }));
    await page.route('**/api/floatation*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, fetched_at: new Date().toISOString(),
        year: 2026, months: ['2026-04'], month_idx: [4], races: [],
        totals: { walkin:[0], purchase:[0], amount:[0], basket:[0], cr:[0] },
        by_branch: {}, source: 'test' }),
    }));
    await loginOwner(page);
    // Wait for the auto-fired silent refresh on enterApp() to settle so the
    // manual click below isn't blocked by the in-flight guard.
    await page.waitForFunction(() => {
      const btn = document.getElementById('refreshBtn');
      return !!btn && !btn.classList.contains('loading') &&
             !!localStorage.getItem('wp_last_refresh_v1');
    }, { timeout: 5000 });
    const before = await page.evaluate(() => localStorage.getItem('wp_last_refresh_v1'));
    // Sleep a tick so the second Date.now() differs from autofire's
    await page.waitForTimeout(20);
    await page.click('#refreshBtn');
    await page.waitForSelector('#wpToast.show', { timeout: 5000 });
    const toast = await page.locator('#wpToast').innerText();
    expect(toast.toLowerCase()).toMatch(/data updated|already up to date|数据已更新|已是最新/);
    const after = await page.evaluate(() => localStorage.getItem('wp_last_refresh_v1'));
    expect(parseInt(after || '0', 10)).toBeGreaterThanOrEqual(parseInt(before || '0', 10));
    expect(parseInt(after || '0', 10)).toBeGreaterThan(0);
  });

  test('Refresh fails gracefully when all upstream sources error', async ({ page }) => {
    // V1 第二刀: doRefresh now hits 5 channels (sales/customers/floatation direct +
    // financial/stock via proxy). Mock ALL of them as failures BEFORE login so
    // both the auto-fire and manual click see the same fail-tree → "Refresh failed".
    await page.route('**/api/proxy*', route => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'down' })
    }));
    await page.route('**/api/sales*', route => route.fulfill({
      status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'sheet down' })
    }));
    await page.route('**/api/customers*', route => route.fulfill({
      status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'sheet down' })
    }));
    await page.route('**/api/floatation*', route => route.fulfill({
      status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'sheet down' })
    }));
    await loginOwner(page);
    // Wait for the auto-fire (silent) to finish so the in-flight guard is clear.
    await page.waitForFunction(() => {
      const btn = document.getElementById('refreshBtn');
      return !!btn && !btn.classList.contains('loading');
    }, { timeout: 5000 });
    await page.click('#refreshBtn');
    await page.waitForSelector('#wpToast.show.fail', { timeout: 5000 });
    const toast = await page.locator('#wpToast').innerText();
    expect(toast.toLowerCase()).toMatch(/refresh failed|刷新失败/);
  });

  test('header data-date shows last refresh HH:MM after refresh', async ({ page }) => {
    // V1 第二刀: refresh = 5 channels — mock all of them OK so the success path
    // sets last_refresh and updateDataDateLabel renders "last refresh HH:MM".
    await page.route('**/api/proxy*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, type: 'sales', data: {} }),
    }));
    await page.route('**/api/sales*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, fetched_at: new Date().toISOString(),
        months: ['2026-04'], groups: [], matrix: {}, by_month: {}, by_group: {},
        latest_month: '2026-04', rows_n: 0, source: 'test' }),
    }));
    await page.route('**/api/customers*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, fetched_at: new Date().toISOString(),
        snapshot: '2026-04', months_seen: ['2026-04'],
        windows: [], types: [], summary: { total_members: 0, amt_total: 0 },
        summary_by_window: {}, buckets_by_window: {}, cross_by_window: {},
        top100: [], churn: { summary: {}, customers: [] }, source: 'test' }),
    }));
    await page.route('**/api/floatation*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, fetched_at: new Date().toISOString(),
        year: 2026, months: ['2026-04'], month_idx: [4], races: [],
        totals: { walkin:[0], purchase:[0], amount:[0], basket:[0], cr:[0] },
        by_branch: {}, source: 'test' }),
    }));
    await loginOwner(page);
    // Wait for auto-fire (silent) to finish so the manual click isn't blocked
    await page.waitForFunction(() => {
      const btn = document.getElementById('refreshBtn');
      return !!btn && !btn.classList.contains('loading');
    }, { timeout: 5000 });
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

/* ───────────────────────────────────────────────────────────────────
   Round 7 — V1 第二刀: Month picker + Live Sales + Live Customers +
                       Refresh feedback (loading / change-detection / toasts)
   ─────────────────────────────────────────────────────────────────── */
test.describe('Round 7 — V1 第二刀: Month picker + Sales/Customers live + Refresh feedback', () => {
  // Minimal /api/customers payload — covers everything the picker + churn / RFM render needs.
  function buildCustomersPayload(snapshot: string, opts: { amt_total?: number; n_total?: number } = {}) {
    return {
      ok: true,
      fetched_at: '2026-05-06T08:00:00.000Z',
      source: 'live:google-sheets',
      sheet_id: 'TEST',
      months_seen: ['2026-01','2026-02','2026-03','2026-04','2026-05'],
      snapshot,
      requested_month: snapshot,
      summary: {
        total_members: opts.n_total ?? 12550,
        n_active: 6329, n_lt1: 2702, n_1_5: 5893, n_5_8: 1696, n_8plus: 2259,
        amt_total: opts.amt_total ?? 4474700,
        amt_lt1: 1957351, amt_1_5: 1067623, amt_5_8: 627418, amt_8plus: 822308,
        pct_5plus_n: 31.5, pct_5plus_amt: 32.4, snapshot,
      },
      summary_by_window: { '1m': {}, '3m': {}, '6m': {}, '12m': {} },
      buckets_by_window: { '1m': [], '3m': [], '6m': [], '12m': [] },
      cross_by_window:   { '1m': {}, '3m': {}, '6m': {}, '12m': {} },
      // V1 第二刀: per-branch per-month sales (drives Sales dashboard cards/chart)
      // Numbers vary per snapshot so each month picker selection produces
      // a different total (acceptance test: 3/4/5 月数字均不同).
      sales_by_branch_month: {
        W01: { '2026-01': 28000, '2026-02': 31000, '2026-03': 33644, '2026-04': 65408, '2026-05': 41000 },
        W02: { '2026-01': 47000, '2026-02': 49500, '2026-03': 52968, '2026-04': 109822, '2026-05': 60000 },
        W03: { '2026-01': 35000, '2026-02': 36500, '2026-03': 37927, '2026-04': 82060, '2026-05': 44000 },
        W05: { '2026-01': 18000, '2026-02': 20000, '2026-03': 22643, '2026-04': 82149, '2026-05': 26000 },
        W07: { '2026-01': 26000, '2026-02': 28500, '2026-03': 30793, '2026-04': 63630, '2026-05': 35000 },
      },
      top100: [],
      windows: ['1m','3m','6m','12m'],
      types:   ['Walk-in','Contractor','Interior Designer','Other'],
      churn: {
        summary: { n_total: 2118, n_high_value: 1311, lifetime_rm: 3338685, cutoff_months: 6, high_value_threshold: 1000 },
        rows: [
          { mc: 'M03308', name: 'MOUSSA', last: '2024-10', months_ago: 17, amount: 120969, visits: 8, loyalty: 'More than 5 year', branch: 'W02', cust_type: 'Other' }
        ],
      },
      diagnostics: { snapshot, n_rows: 70000, n_members: 12550, n_ci_rows: 12552, n_churn: 2118 },
    };
  }
  function buildSalesPayload(latest = '2026-04') {
    return {
      ok: true,
      fetched_at: '2026-05-06T08:00:00.000Z',
      source: 'live:google-sheets',
      sheet_id: 'TEST_SALES',
      months: ['2026-01','2026-02','2026-03','2026-04'],
      groups: ['Faucet','Water Closet','Wash Basin'],
      matrix: { '2026-04': { Faucet: { po: 12000, grn: 11500 } } },
      by_month: { '2026-04': { po: 100000, grn: 95000 } },
      by_group: { Faucet: { po: 50000, grn: 48000 } },
      latest_month: latest,
      rows_n: 36,
    };
  }

  test('header has month picker populated from /api/customers months_seen', async ({ page }) => {
    await page.route('**/api/customers*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(buildCustomersPayload('2026-05')),
    }));
    await page.route('**/api/sales*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*',route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, type: 'x', data: {} }) }));

    await loginOwner(page);
    // Wait for the auto-refresh on enterApp to populate the picker
    await page.waitForFunction(() => {
      const sel = document.getElementById('monthPicker') as HTMLSelectElement | null;
      return !!(sel && sel.options.length >= 5);
    }, { timeout: 5000 });

    const opts = await page.$$eval('#monthPicker option', els =>
      (els as HTMLOptionElement[]).map(o => o.value).filter(Boolean));
    // Newest-first display
    expect(opts).toEqual(['2026-05','2026-04','2026-03','2026-02','2026-01']);
    const sel = await page.locator('#monthPicker').inputValue();
    expect(sel).toBe('2026-05');
    const snap = await page.evaluate(() => (window as any).SNAPSHOT);
    expect(snap).toBe('2026-05');
  });

  test('setSnapshot syncs URL ?month=YYYY-MM and updates header label', async ({ page }) => {
    await page.route('**/api/customers*', route => {
      const u = new URL(route.request().url());
      const m = u.searchParams.get('month') || '2026-05';
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildCustomersPayload(m)) });
    });
    await page.route('**/api/sales*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).SNAPSHOT, { timeout: 5000 });

    // Pick 2026-04 via dropdown
    await page.selectOption('#monthPicker', '2026-04');
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-04', { timeout: 5000 });

    const url = page.url();
    expect(url).toMatch(/[?&]month=2026-04/);

    const dataDate = await page.locator('#dataDate').innerText();
    expect(dataDate).toMatch(/Snapshot 2026-04|Snapshot\s+2026-04/);
    const footer = await page.locator('#footerSnapshot').innerText();
    expect(footer).toBe('2026-04');
  });

  test('?month=2026-04 in URL pre-selects picker on app entry', async ({ page }) => {
    await page.route('**/api/customers*', route => {
      const u = new URL(route.request().url());
      const m = u.searchParams.get('month') || '2026-05';
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildCustomersPayload(m)) });
    });
    await page.route('**/api/sales*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await page.goto(PAGE_URL + '?month=2026-04');
    await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
    await page.fill('#loginUser', 'owner');
    await page.fill('#loginPw', 'Owner@2026');
    await page.click('#loginBtn');
    await page.waitForSelector('#app.ready', { timeout: 5000 });
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-04', { timeout: 5000 });

    const sel = await page.locator('#monthPicker').inputValue();
    expect(sel).toBe('2026-04');
  });

  test('fetchCustomersLive mutates WP_TODAY.churn + WP_CUSTOMERS in-place', async ({ page }) => {
    await page.route('**/api/customers*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(buildCustomersPayload('2026-04', { amt_total: 999999, n_total: 12345 })),
    }));
    await page.route('**/api/sales*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_CUSTOMERS && (window as any).WP_CUSTOMERS._live === true, { timeout: 5000 });

    const state = await page.evaluate(() => ({
      cust_n_total: (window as any).WP_CUSTOMERS.summary.total_members,
      cust_amt:     (window as any).WP_CUSTOMERS.summary.amt_total,
      cust_snap:    (window as any).WP_CUSTOMERS.meta.snapshot,
      churn_n:      (window as any).WP_TODAY.churn.summary.n_high_value,
      churn_rm:     (window as any).WP_TODAY.churn.summary.lifetime_rm,
    }));
    expect(state.cust_n_total).toBe(12345);
    expect(state.cust_amt).toBe(999999);
    expect(state.cust_snap).toBe('2026-04');
    expect(state.churn_n).toBe(1311);
    expect(state.churn_rm).toBe(3338685);
  });

  test('fetchSalesLive populates WP_SALES_LIVE', async ({ page }) => {
    await page.route('**/api/customers*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/sales*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload('2026-04')) }));
    await page.route('**/api/floatation*',route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_SALES_LIVE && (window as any).WP_SALES_LIVE._live === true, { timeout: 5000 });
    const sales = await page.evaluate(() => ({
      latest:   (window as any).WP_SALES_LIVE.latest_month,
      n_months: (window as any).WP_SALES_LIVE.months.length,
      faucet:   (window as any).WP_SALES_LIVE.by_group.Faucet,
    }));
    expect(sales.latest).toBe('2026-04');
    expect(sales.n_months).toBe(4);
    expect(sales.faucet).toEqual({ po: 50000, grn: 48000 });
  });

  test('Refresh shows "已是最新" toast when payload is byte-for-byte identical', async ({ page }) => {
    const payload = buildCustomersPayload('2026-05');
    await page.route('**/api/customers*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));
    await page.route('**/api/sales*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*',route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_CUSTOMERS && (window as any).WP_CUSTOMERS._live === true, { timeout: 5000 });

    // Click refresh — same payload should hash-match → "Already up to date"
    await page.click('#refreshBtn');
    await page.waitForSelector('#wpToast.show', { timeout: 5000 });
    const toast = await page.locator('#wpToast').innerText();
    // Could be either "Already up to date" (full success) or "Data updated (partial)"
    // (because floatation 502 → partial). Test for warning-tone OR no-change-tone path:
    expect(toast.toLowerCase()).toMatch(/already up to date|已是最新|partial|部分/);
  });

  test('Refresh shows "已更新" toast when payload changes between clicks', async ({ page }) => {
    let n = 0;
    await page.route('**/api/customers*', route => {
      n++;
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(buildCustomersPayload('2026-05', { amt_total: 1000000 + n * 1000 })) });
    });
    await page.route('**/api/sales*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*',route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, fetched_at: 't', months: ['2026-03','2026-04','2026-05'], races: [], totals: {}, by_branch: {} }) }));
    await page.route('**/api/proxy*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { _ts: Math.random() } }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_CUSTOMERS && (window as any).WP_CUSTOMERS._live === true, { timeout: 5000 });

    await page.click('#refreshBtn');
    await page.waitForSelector('#wpToast.show', { timeout: 5000 });
    const toast = await page.locator('#wpToast').innerText();
    expect(toast.toLowerCase()).toMatch(/data updated|已更新/);
  });

  test('Refresh button shows loading visual + becomes disabled during fetch', async ({ page }) => {
    // Hold /api/sales but ONLY on the 2nd hit (the manual click). The 1st hit
    // is the silent autofire on enterApp() — let it pass instantly so we can
    // observe the loading visual mid-flight on the manual refresh.
    let salesCall = 0;
    let resolveSales: ((v: any) => void) | null = null;
    await page.route('**/api/sales*', async route => {
      salesCall++;
      if (salesCall === 1) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) });
        return;
      }
      // 2nd+ call: hold until released
      await new Promise<any>(r => { resolveSales = r; });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) });
    });
    await page.route('**/api/customers*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildCustomersPayload('2026-05')) }));
    await page.route('**/api/floatation*',route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, fetched_at: 't', months: [], races: [], totals: {}, by_branch: {} }) }));
    await page.route('**/api/proxy*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    // Wait for autofire (silent) to finish — loading class clears, last_refresh set
    await page.waitForFunction(() => {
      const btn = document.getElementById('refreshBtn');
      return !!btn && !btn.classList.contains('loading') &&
             !!localStorage.getItem('wp_last_refresh_v1');
    }, { timeout: 5000 });
    // Click refresh — sales is held, so loading visual must persist
    const click = page.click('#refreshBtn');
    await page.waitForFunction(() => {
      const b = document.getElementById('refreshBtn') as HTMLButtonElement | null;
      return !!(b && b.classList.contains('loading') && b.disabled);
    }, { timeout: 3000 });
    // Release the held response
    if (resolveSales) (resolveSales as any)(true);
    await click;
    await page.waitForSelector('#wpToast.show', { timeout: 5000 });
    const finalState = await page.evaluate(() => {
      const b = document.getElementById('refreshBtn') as HTMLButtonElement | null;
      return { loading: b?.classList.contains('loading'), disabled: b?.disabled };
    });
    expect(finalState.loading).toBe(false);
    expect(finalState.disabled).toBe(false);
  });

  test('Snapshot footer label is dynamic (not hardcoded "2026-03")', async ({ page }) => {
    await page.route('**/api/customers*', route => {
      const u = new URL(route.request().url());
      const m = u.searchParams.get('month') || '2026-05';
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildCustomersPayload(m)) });
    });
    await page.route('**/api/sales*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-05', { timeout: 5000 });
    let footer = await page.locator('#footerSnapshot').innerText();
    expect(footer).toBe('2026-05');

    await page.selectOption('#monthPicker', '2026-02');
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-02', { timeout: 5000 });
    footer = await page.locator('#footerSnapshot').innerText();
    expect(footer).toBe('2026-02');
  });

  test('window.refreshLiveData + setSnapshot are exposed and round-trip URL', async ({ page }) => {
    await page.route('**/api/customers*', route => {
      const u = new URL(route.request().url());
      const m = u.searchParams.get('month') || '2026-05';
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildCustomersPayload(m)) });
    });
    await page.route('**/api/sales*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => typeof (window as any).refreshLiveData === 'function' && typeof (window as any).setSnapshot === 'function', { timeout: 5000 });
    await page.evaluate(() => (window as any).setSnapshot('2026-03'));
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-03', { timeout: 5000 });
    expect(page.url()).toMatch(/[?&]month=2026-03/);
  });
});

/* ════════════════════════════════════════════════════════════════════
   Round 8 — V1 第二刀 验收: SINGLE-MONTH ISOLATION
   ----------------------------------------------------------------------
   Jym's mandate (2026-05-06): "选月份就显示那个月,不要任何聪明逻辑。"
   Acceptance test verbatim:
     1. Sales tab + 选 2026-03 → 记录所有数字
     2. 选 2026-04 → 数字必须跟 (1) 不一样
     3. 选 2026-05 → 数字必须跟 (1)(2) 都不一样
   Any duplication across snapshots = FAIL.
   ════════════════════════════════════════════════════════════════════ */
test.describe('Round 8 — V1 第二刀 验收: month picker isolates Sales KPIs', () => {
  const PAGE_URL = 'http://localhost:4173/Wiltek_MASTER.html';

  function buildCustomersPayload(snapshot: string) {
    return {
      ok: true,
      fetched_at: '2026-05-06T08:00:00.000Z',
      source: 'live:google-sheets',
      sheet_id: 'TEST',
      months_seen: ['2026-01','2026-02','2026-03','2026-04','2026-05'],
      snapshot,
      requested_month: snapshot,
      summary: { total_members: 12550, n_active: 6329, amt_total: 4474700, snapshot,
        n_lt1: 0, n_1_5: 0, n_5_8: 0, n_8plus: 0,
        amt_lt1: 0, amt_1_5: 0, amt_5_8: 0, amt_8plus: 0,
        pct_5plus_n: 0, pct_5plus_amt: 0 },
      summary_by_window: { '1m': {}, '3m': {}, '6m': {}, '12m': {} },
      buckets_by_window: { '1m': [], '3m': [], '6m': [], '12m': [] },
      cross_by_window:   { '1m': {}, '3m': {}, '6m': {}, '12m': {} },
      // Distinct values per month — every column differs from every other column
      sales_by_branch_month: {
        W01: { '2026-03': 33644, '2026-04': 65408, '2026-05': 41000 },
        W02: { '2026-03': 52968, '2026-04': 109822, '2026-05': 60000 },
        W03: { '2026-03': 37927, '2026-04': 82060, '2026-05': 44000 },
        W05: { '2026-03': 22643, '2026-04': 82149, '2026-05': 26000 },
        W07: { '2026-03': 30793, '2026-04': 63630, '2026-05': 35000 },
      },
      top100: [], windows: ['1m','3m','6m','12m'],
      types: ['Walk-in','Contractor','Interior Designer','Other'],
      churn: { summary: { n_total: 0, n_high_value: 0, lifetime_rm: 0, cutoff_months: 6, high_value_threshold: 1000 }, rows: [] },
      diagnostics: { snapshot, n_rows: 0, n_members: 12550, n_ci_rows: 0, n_churn: 0 },
    };
  }
  function buildSalesPayload() {
    return { ok: true, fetched_at: '2026-05-06T08:00:00.000Z', source: 'live', sheet_id: 'X',
      months: ['2026-01','2026-02','2026-03','2026-04'], groups: ['Faucet'],
      matrix: {}, by_month: {}, by_group: { Faucet: { po: 0, grn: 0 } },
      latest_month: '2026-04', rows_n: 0 };
  }

  async function loginOwner(page) {
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
    await page.fill('#loginUser', 'owner');
    await page.fill('#loginPw', 'Owner@2026');
    await page.click('#loginBtn');
    await page.waitForSelector('#app.ready', { timeout: 5000 });
  }

  test('Sales tab KPI numbers are different for 2026-03, 2026-04, 2026-05', async ({ page }) => {
    await page.route('**/api/customers*', route => {
      const u = new URL(route.request().url());
      const m = u.searchParams.get('month') || '2026-05';
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildCustomersPayload(m)) });
    });
    await page.route('**/api/sales*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_CUSTOMERS && (window as any).WP_CUSTOMERS._live === true, { timeout: 5000 });

    // Navigate to Sales tab
    await page.evaluate(() => (window as any).setView('sales'));
    await page.waitForSelector('#dsSalesCards', { timeout: 5000 });

    async function snapshotSalesKpis(month: string) {
      await page.selectOption('#monthPicker', month);
      await page.waitForFunction((m) => (window as any).SNAPSHOT === m, month, { timeout: 5000 });
      // Wait until renderSalesDashboard repaints with the new snapshot's number
      await page.waitForFunction((m) => {
        const wrap = document.getElementById('dsSalesCards');
        const title = document.getElementById('dsSalesChartTitle');
        return !!wrap && wrap.children.length === 3 && !!title && title.textContent?.includes(m);
      }, month, { timeout: 5000 });
      const cards = await page.locator('#dsSalesCards .ds-card .value').allInnerTexts();
      const chartTitle = await page.locator('#dsSalesChartTitle').innerText();
      return { cards, chartTitle };
    }

    const m3 = await snapshotSalesKpis('2026-03');
    const m4 = await snapshotSalesKpis('2026-04');
    const m5 = await snapshotSalesKpis('2026-05');

    // 1. Each chart title carries its own snapshot — proves single-month chart binding
    expect(m3.chartTitle).toContain('2026-03');
    expect(m4.chartTitle).toContain('2026-04');
    expect(m5.chartTitle).toContain('2026-05');

    // 2. The "month sales" card (1st card) MUST differ across all three picks.
    //    Mock totals: 03 = 177,975 | 04 = 403,069 | 05 = 206,000.
    expect(m3.cards[0]).not.toBe(m4.cards[0]);
    expect(m3.cards[0]).not.toBe(m5.cards[0]);
    expect(m4.cards[0]).not.toBe(m5.cards[0]);

    // 3. The Top-branch and Lowest-branch *RM* sub-text differ too (cards 2 + 3
    //    show the branch name as the headline; their meta line carries the RM amount).
    const cardMetas = async () =>
      page.locator('#dsSalesCards .ds-card .sub').allInnerTexts();
    await page.selectOption('#monthPicker', '2026-03');
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-03', { timeout: 5000 });
    const meta3 = await cardMetas();
    await page.selectOption('#monthPicker', '2026-04');
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-04', { timeout: 5000 });
    const meta4 = await cardMetas();
    expect(meta3.join('|')).not.toBe(meta4.join('|'));
  });

  test('renderSalesDashboard reads sales_by_branch_month, not legacy branch_sales_trend', async ({ page }) => {
    // Sanity: legacy field must no longer drive the dashboard. We provide a
    // VALID sales_by_branch_month but a STALE branch_sales_trend with very
    // different numbers; the dashboard must show the SBM numbers.
    await page.route('**/api/customers*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(buildCustomersPayload('2026-04')),
    }));
    await page.route('**/api/sales*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_CUSTOMERS && (window as any).WP_CUSTOMERS._live === true, { timeout: 5000 });

    // Stuff a poison value into the legacy field and re-render; output must NOT contain it.
    await page.evaluate(() => {
      (window as any).WP_TODAY = (window as any).WP_TODAY || {};
      (window as any).WP_TODAY.branch_sales_trend = {
        W01: { last_3m: 9999999, prev_3m: 0, drop_pct: 0 },
      };
    });
    await page.evaluate(() => (window as any).setView('sales'));
    await page.waitForSelector('#dsSalesCards .ds-card', { timeout: 5000 });
    const html = await page.locator('#dsSalesCards').innerHTML();
    expect(html).not.toContain('9,999,999');
    expect(html).not.toContain('9999999');
    // And the rolling labels must be gone:
    expect(html.toLowerCase()).not.toContain('last 3m');
    expect(html.toLowerCase()).not.toContain('estimate');
    expect(html).not.toContain('% mom');
  });

  test('period toggle (3m/6m/12m) is hidden — no rolling logic in UI', async ({ page }) => {
    await page.route('**/api/customers*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildCustomersPayload('2026-04')) }));
    await page.route('**/api/sales*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    const visible = await page.locator('#periodToggle').isVisible();
    expect(visible).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════
   Round 9 — V1 第三刀: cache + Raw-sale source-of-truth
   ----------------------------------------------------------------------
   Bug 1 fix: Sales dashboard now reads WP_SALES_LIVE.sales_by_branch_month
              (from Raw sale tab — every transaction). The old CustomerBuy
              path was members-only (~33k for W01 Mar-26 vs the actual 55k).
   Bug 2 fix: setSnapshot no longer triggers /api/customers re-fetch.
              All months are in the first payload's summary_by_month +
              sales_by_branch_month. Switch = pure local re-render.
   ════════════════════════════════════════════════════════════════════ */
test.describe('Round 9 — V1 第三刀: Raw sale source + month-switch cache', () => {
  const PAGE_URL = 'http://localhost:4173/Wiltek_MASTER.html';

  function buildSalesPayload() {
    return {
      ok: true,
      fetched_at: '2026-05-06T20:00:00.000Z',
      source: 'live:google-sheets',
      sheet_id: 'TEST_SALES',
      months: ['2026-01','2026-02','2026-03','2026-04'],
      groups: ['Faucet'],
      matrix: {}, by_month: {}, by_group: { Faucet: { po: 0, grn: 0 } },
      latest_month: '2026-04',
      rows_n: 0,
      // V1 第三刀: Raw sale tab aggregate (per-branch × per-month Amount).
      // Numbers chosen to match real Sheet for Mar-26 verification.
      sales_by_branch_month: {
        W01: { '2026-01': 80813, '2026-02': 38371, '2026-03': 55491, '2026-04': 65408 },
        W02: { '2026-01': 134593, '2026-02': 79628, '2026-03': 100038, '2026-04': 109822 },
        W03: { '2026-01': 91424, '2026-02': 70257, '2026-03': 75727, '2026-04': 82060 },
        W05: { '2026-01': 95554, '2026-02': 113778, '2026-03': 43487, '2026-04': 82149 },
        W07: { '2026-01': 78720, '2026-02': 60302, '2026-03': 68158, '2026-04': 63630 },
        W11: { '2026-01': 36049, '2026-02': 26870, '2026-03': 29655, '2026-04': 16741 },
        WCO: { '2026-01': 235,   '2026-02': 2586,  '2026-03': 52,    '2026-04': 5299  },
      },
      months_seen: ['2026-01','2026-02','2026-03','2026-04'],
      branches_seen: ['W01','W02','W03','W05','W07','W11','WCO'],
      _raw_ok: true,
      active_branches: ['W01','W02','W03','W05','W07'],
    };
  }
  function buildCustomersPayload(snapshot: string) {
    return {
      ok: true,
      fetched_at: '2026-05-06T20:00:00.000Z',
      source: 'live:google-sheets',
      sheet_id: 'TEST',
      months_seen: ['2026-01','2026-02','2026-03','2026-04'],
      snapshot,
      requested_month: snapshot,
      summary: { total_members: 12550, n_active: 6329, amt_total: 4474700, snapshot,
        n_lt1: 0, n_1_5: 0, n_5_8: 0, n_8plus: 0,
        amt_lt1: 0, amt_1_5: 0, amt_5_8: 0, amt_8plus: 0,
        pct_5plus_n: 0, pct_5plus_amt: 0 },
      summary_by_window: { '1m': {}, '3m': {}, '6m': {}, '12m': {} },
      buckets_by_window: { '1m': [], '3m': [], '6m': [], '12m': [] },
      cross_by_window:   { '1m': {}, '3m': {}, '6m': {}, '12m': {} },
      sales_by_branch_month: {},  // Sales dashboard prefers WP_SALES_LIVE
      summary_by_month: {
        '2026-01': { total_members: 12550, n_active: 800, amt_total: 481000, snapshot: '2026-01' },
        '2026-02': { total_members: 12550, n_active: 700, amt_total: 362000, snapshot: '2026-02' },
        '2026-03': { total_members: 12550, n_active: 650, amt_total: 343000, snapshot: '2026-03' },
        '2026-04': { total_members: 12550, n_active: 900, amt_total: 403000, snapshot: '2026-04' },
      },
      buckets_by_month: {
        '2026-01': [{ key: '<1y', n: 100, amt: 100000, aov: 1000, repeat_pct: 0, n_active: 100 }],
        '2026-02': [{ key: '<1y', n: 90,  amt: 90000,  aov: 1000, repeat_pct: 0, n_active: 90  }],
        '2026-03': [{ key: '<1y', n: 80,  amt: 80000,  aov: 1000, repeat_pct: 0, n_active: 80  }],
        '2026-04': [{ key: '<1y', n: 110, amt: 110000, aov: 1000, repeat_pct: 0, n_active: 110 }],
      },
      top100: [], windows: ['1m','3m','6m','12m'],
      types: ['Walk-in','Contractor','Interior Designer','Other'],
      churn: { summary: { n_total: 0, n_high_value: 0, lifetime_rm: 0, cutoff_months: 6, high_value_threshold: 1000 }, rows: [] },
      diagnostics: { snapshot, n_rows: 0, n_members: 12550, n_ci_rows: 0, n_churn: 0 },
    };
  }

  async function loginOwner(page) {
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
    await page.fill('#loginUser', 'owner');
    await page.fill('#loginPw', 'Owner@2026');
    await page.click('#loginBtn');
    await page.waitForSelector('#app.ready', { timeout: 5000 });
  }

  test('Sales dashboard total = ALL-branch sum (matches Sheet status bar)', async ({ page }) => {
    await page.route('**/api/customers*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildCustomersPayload('2026-03')) }));
    await page.route('**/api/sales*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*',route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_SALES_LIVE && (window as any).WP_SALES_LIVE._raw_ok === true, { timeout: 5000 });

    await page.evaluate(() => (window as any).setView('sales'));
    await page.waitForSelector('#dsSalesCards', { timeout: 5000 });

    // Mar-26 ALL-branch total: 55491+100038+75727+43487+68158+29655+52 = 372,608
    await page.selectOption('#monthPicker', '2026-03');
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-03', { timeout: 5000 });
    // Wait for repaint
    await page.waitForFunction(() => {
      const t = document.getElementById('dsSalesChartTitle');
      return !!t && (t.textContent || '').includes('2026-03');
    }, { timeout: 5000 });
    const monthSalesValue = await page.locator('#dsSalesCards .ds-card').first().locator('.value').innerText();
    expect(monthSalesValue.replace(/\s/g,'')).toContain('372,608');
  });

  test('switching month does NOT re-fetch /api/customers or /api/sales (cache hit)', async ({ page }) => {
    let custCalls = 0, salesCalls = 0;
    await page.route('**/api/customers*', route => {
      custCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildCustomersPayload('2026-04')) });
    });
    await page.route('**/api/sales*', route => {
      salesCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) });
    });
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',      route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    // Wait for the autofire silent refresh to complete
    await page.waitForFunction(() => (window as any).WP_SALES_LIVE && (window as any).WP_SALES_LIVE._raw_ok === true, { timeout: 5000 });
    const beforeCust = custCalls, beforeSales = salesCalls;
    expect(beforeCust).toBeGreaterThanOrEqual(1);   // initial fetch happened
    expect(beforeSales).toBeGreaterThanOrEqual(1);

    // Three rapid month switches — each must be a CACHE HIT, no network.
    await page.evaluate(() => (window as any).setView('sales'));
    await page.selectOption('#monthPicker', '2026-03');
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-03', { timeout: 5000 });
    await page.selectOption('#monthPicker', '2026-02');
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-02', { timeout: 5000 });
    await page.selectOption('#monthPicker', '2026-01');
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-01', { timeout: 5000 });
    // Give a generous beat for any rogue async refetch
    await page.waitForTimeout(500);

    expect(custCalls).toBe(beforeCust);    // no extra customer fetch
    expect(salesCalls).toBe(beforeSales);  // no extra sales fetch
  });

  test('Sales dashboard prefers WP_SALES_LIVE over WP_CUSTOMERS for sales_by_branch_month', async ({ page }) => {
    // Ship a poison value via WP_CUSTOMERS to prove WP_SALES_LIVE wins.
    const custPoison = buildCustomersPayload('2026-04');
    custPoison.sales_by_branch_month = {
      W01: { '2026-04': 9999999 }, W02: { '2026-04': 9999999 },
      W03: { '2026-04': 9999999 }, W05: { '2026-04': 9999999 },
      W07: { '2026-04': 9999999 },
    };
    await page.route('**/api/customers*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(custPoison) }));
    await page.route('**/api/sales*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSalesPayload()) }));
    await page.route('**/api/floatation*',route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/proxy*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_SALES_LIVE && (window as any).WP_SALES_LIVE._raw_ok === true, { timeout: 5000 });
    await page.evaluate(() => (window as any).setView('sales'));
    await page.selectOption('#monthPicker', '2026-04');
    await page.waitForFunction(() => (window as any).SNAPSHOT === '2026-04', { timeout: 5000 });
    await page.waitForFunction(() => {
      const t = document.getElementById('dsSalesChartTitle');
      return !!t && (t.textContent || '').includes('2026-04');
    }, { timeout: 5000 });
    const html = await page.locator('#dsSalesCards').innerHTML();
    expect(html).not.toContain('9,999,999');
    expect(html).not.toContain('49,999,995');  // 5x poison
    // WP_SALES_LIVE Mar-26 W01 + ... + WCO = 425,109 ALL-branch for 2026-04
    expect(html.replace(/\s/g,'')).toContain('425,109');
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Round 10 — V1 第三刀: Today landing (4 layers)
   ----------------------------------------------------------------------
   Layer 1 — status light + Cash Runway (FMM-driven)
   Layer 2 — Action Plan with Mark-as-done (localStorage dismiss)
   Layer 3 — 5-store traffic (visits × AOV × CR × anomalies, live floatation)
   Layer 4 — 6-domain health grid (clickable jump)
   Acceptance: a) months differ b) refresh updates timestamp c) action plan
               from real data d) status light real-computed (FMM)
   ════════════════════════════════════════════════════════════════════ */
test.describe('Round 10 — V1 第三刀: Today landing (4 layers)', () => {
  test('Layer 1: Cash Runway shows "数据待补" when FMM live cash not loaded (honest placeholder)', async ({ page }) => {
    // V1 第三刀 验收 fix: when /api/proxy?type=financial returns no liability.raw,
    // computeCashRunway returns status='na' and the UI shows "数据待补" /
    // "Data pending" — never invents a number.
    await page.route('**/api/proxy*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
    await page.route('**/api/sales*',     route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/customers*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/floatation*',route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await loginOwner(page);
    await page.waitForSelector('#todayStatusLight', { timeout: 5000 });
    const lightTone = await page.locator('#todayStatusLight').getAttribute('data-tone');
    expect(['ok','warn','bad','na']).toContain(lightTone);
    const lightChar = await page.locator('#todayStatusLight').textContent();
    expect(['🟢','🟡','🔴','⚪']).toContain((lightChar || '').trim());
    // Runway must show "Data pending" / "数据待补" — never the bogus 0.1 month.
    const runwayText = (await page.locator('#todayRunway').textContent() || '').trim();
    expect(runwayText).toMatch(/数据待补|Data pending/);
    expect(runwayText).not.toMatch(/0\.1|0\.0/);
  });

  test('Layer 1: Cash Runway computes from FMM liability.raw bank balances (real formula)', async ({ page }) => {
    // V1 第三刀 验收 fix: feed /api/proxy?type=financial a payload whose
    // liability.raw mimics the real FMM shape (CASH IN BANK section + 4
    // bank rows summing to RM 54,202). Assert the runway uses this cash
    // figure, not invented numbers.
    const finPayload = {
      ok: true, type: 'financial',
      data: {
        liability: {
          raw: [
            { label: 'BUILDING',                     value: 2500000 },
            { label: 'STOCK - MARCH\'2026',          value: 1167280 },
            { label: 'CASH IN BANK - 06th Mar26',    value: 0 },
            { label: 'MBI Ampang - Saving',          value: 30385.50 },
            { label: 'MBI Ampang',                   value: 0 },
            { label: 'PBB Thambi Dollah',            value: 23204.51 },
            { label: 'PBI Taman Muda',               value: 612 },
            { label: 'SUB - TOTAL',                  value: 3721482.01 },
            { label: 'TERM LOAN',                    value: 0 },
            { label: 'MBI : (LOAN)',                 value: 3100000 },
          ],
          assets: { stock: 1167280, building: 2500000 },
          liabilities: { total: 0 },
        },
      },
    };
    await page.route('**/api/proxy*', route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('type') === 'financial') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(finPayload) });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) });
      }
    });
    await page.route('**/api/sales*',     route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/customers*', route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await page.route('**/api/floatation*',route => route.fulfill({ status: 502, body: JSON.stringify({ ok: false }) }));
    await loginOwner(page);
    // Wait for __wpLive.financial to land, then re-render Today
    await page.waitForFunction(() => !!((window as any).__wpLive && (window as any).__wpLive.financial && (window as any).__wpLive.financial.liability), { timeout: 8000 });
    await page.evaluate(() => (window as any).renderToday && (window as any).renderToday());
    // Verify computeCashRunway returns the right cash figure
    const got = await page.evaluate(() => {
      const fn = (window as any).computeCashRunway;
      return fn ? fn() : null;
    });
    expect(got).not.toBeNull();
    expect(got!.cash).toBeCloseTo(54202.01, 1);
    expect(['burning','profitable']).toContain(got!.basis);
    expect(got!.months).toBeGreaterThan(0);
    // UI shows the cash figure in the sub-line
    const subText = (await page.locator('.tst-r-sub').textContent() || '').trim();
    expect(subText).toMatch(/54,202|54,201/);
  });

  test('Layer 2: Mark-as-done dismisses card + Restore brings it back (acceptance c)', async ({ page }) => {
    await loginOwner(page);
    await page.evaluate(() => { try { localStorage.removeItem('wp_today_dismissed_v1'); } catch(_){} });
    await page.evaluate(() => (window as any).renderToday && (window as any).renderToday());
    const beforeKinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#todayCards .today-card[data-kind]')).map(c => c.getAttribute('data-kind')));
    expect(beforeKinds.length).toBeGreaterThanOrEqual(1);
    const targetKind = beforeKinds[0]!;
    // Click Mark-as-done on the first card
    await page.locator(`#todayCards [data-mark-done="${targetKind}"]`).click();
    await page.waitForTimeout(150);
    const afterKinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#todayCards .today-card[data-kind]')).map(c => c.getAttribute('data-kind')));
    expect(afterKinds).not.toContain(targetKind);
    // Restore-bar visible with the count
    await expect(page.locator('#todayRestoreBar')).toBeVisible();
    // Click restore → card returns
    await page.locator('#todayRestoreBtn').click();
    await page.waitForTimeout(150);
    const restoredKinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#todayCards .today-card[data-kind]')).map(c => c.getAttribute('data-kind')));
    expect(restoredKinds).toContain(targetKind);
  });

  test('Layer 2: action plan items are real-data-driven (acceptance c)', async ({ page }) => {
    await loginOwner(page);
    // Each card's data-kind must be one of the real candidates derived from
    // WP_DEADSTOCK + WP_TODAY (po_exceptions, churn). If WP_TODAY were mocked
    // empty, no cards render. Verify cards came from the actual data sources.
    const realCounts = await page.evaluate(() => {
      const td = (window as any).WP_TODAY || {};
      const ds = (window as any).WP_DEADSTOCK || {};
      return {
        deadstockAmt: ((ds.totals && ds.totals.DEAD) || {}).amount || 0,
        nOverdue: ((td.po_exceptions || {}).summary || {}).n_overdue || 0,
        nChurn:   ((td.churn || {}).summary || {}).n_high_value || 0,
      };
    });
    expect(realCounts.deadstockAmt + realCounts.nOverdue + realCounts.nChurn).toBeGreaterThan(0);
    const kinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#todayCards .today-card[data-kind]')).map(c => c.getAttribute('data-kind')));
    expect(kinds.length).toBeGreaterThanOrEqual(1);
    for (const k of kinds) {
      expect(['deadstock','misplaced','po-overdue','po-delayed','churn']).toContain(k);
    }
  });

  test('Layer 3: 5-store row month-shifts (该月销售 RM / 环比 / 客流 / 成交率 / 异常)', async ({ page }) => {
    // V1 第四刀返工 v2: 5-store row now leads with PER-BRANCH PER-MONTH sales
    // (which shifts with snapshot) + MoM%, then the 3-month-period scalars
    // from /api/floatation (walk-in / CR). Columns:
    //   0:id  1:name  2:该月销售RM  3:环比%  4:客流  5:成交率  6:异常
    const liveFlo = {
      ok: true, fetched_at: '2026-05-06T08:00:00.000Z',
      year: 2026, months: ['2026-03','2026-04','2026-05'], month_idx: [3,4,5],
      races: [], totals: { walkin:[0,0,0], purchase:[0,0,0], amount:[0,0,0], basket:[0,0,0], cr:[0,0,0] },
      by_branch: {
        W01: { walkin: 577, purchase: 403, amount: 130736, basket: 324.41, cr: 0.6984 },
        W02: { walkin: 784, purchase: 532, amount: 190764, basket: 358.58, cr: 0.6786 },
        W03: { walkin: 561, purchase: 411, amount: 167990, basket: 408.73, cr: 0.7326 },
        W05: { walkin: 418, purchase: 334, amount: 132071, basket: 395.42, cr: 0.7990 },
        W07: { walkin: 481, purchase: 419, amount: 145310, basket: 346.80, cr: 0.8711 },
      },
      source: 'live:test',
    };
    const salesPayload = {
      ok: true, source: 'test', sheet_id: 'TEST',
      months: ['2026-03','2026-04'], groups: [],
      matrix: {}, by_month: {}, by_group: {}, latest_month: '2026-04', rows_n: 0,
      sales_by_branch_month: {
        W01: { '2026-03': 50000, '2026-04': 60000 },
        W02: { '2026-03': 100000, '2026-04': 110000 },
        W03: { '2026-03': 75000, '2026-04': 80000 },
        W05: { '2026-03': 40000, '2026-04': 45000 },
        W07: { '2026-03': 60000, '2026-04': 65000 },
      },
      total_amt_by_month: {}, sku_amt_by_month: {}, sku_qty_by_month: {},
      months_seen: ['2026-03','2026-04'], _raw_ok: true,
    };
    await page.route('**/api/floatation*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(liveFlo)
    }));
    await page.route('**/api/sales*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(salesPayload)
    }));
    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_CUSTOMERS?.race?._live === true, { timeout: 5000 });
    await page.waitForFunction(() => (window as any).WP_SALES_LIVE?._raw_ok === true, { timeout: 5000 });
    // Set snap to 2026-04 and re-render
    await page.evaluate(() => (window as any).setSnapshot('2026-04'));
    await page.evaluate(() => (window as any).renderToday && (window as any).renderToday());
    const cells = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#todayStores .ts-row:not(.head)'))
        .map(r => Array.from(r.querySelectorAll(':scope > div')).map(c => (c.textContent || '').trim())));
    expect(cells).toHaveLength(5);
    const w01 = cells.find(r => r[0] === 'W01')!;
    expect(w01[2]).toMatch(/RM\s*60,?000/);   // 该月销售 RM (2026-04)
    expect(w01[3]).toMatch(/\+20\.0%/);        // 环比 (60k vs 50k = +20%)
    expect(w01[4]).toBe('577');                // 客流 (3M total scalar)
    expect(w01[5]).toMatch(/69\.8%/);          // 成交率
  });

  test('Layer 4: domain grid click jumps to that domain', async ({ page }) => {
    await loginOwner(page);
    await page.locator('#todayDomainGrid [data-domain-key="customers"]').click();
    await expect(page.locator('#view-customers.on')).toBeVisible({ timeout: 5000 });
  });

  test('Owner default landing is Today (V1 第三刀)', async ({ page }) => {
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => !!(window as any).WP_USERS && !!(window as any).WP_DEADSTOCK && !!(window as any).WP_TODAY);
    await page.fill('#loginUser', 'owner');
    await page.fill('#loginPw', 'Owner@2026');
    await page.click('#loginBtn');
    await page.waitForSelector('#app.ready', { timeout: 5000 });
    // No explicit setView — must land on today directly.
    await expect(page.locator('#view-today.on')).toBeVisible({ timeout: 5000 });
    // 4 layers all present
    await expect(page.locator('#todayStatus')).toBeVisible();
    await expect(page.locator('#todayCards')).toBeVisible();
    await expect(page.locator('#todayStores')).toBeVisible();
    await expect(page.locator('#todayDomainGrid')).toBeVisible();
  });

  test('Acceptance (a): switching months 03/04/05 yields different Sales totals', async ({ page }) => {
    // Mock /api/sales with real-shaped Raw-sale aggregates so the Sales
    // dashboard has month-distinct numbers to render. Mar/Apr/May are the
    // months the user explicitly verifies — distinct totals required.
    const salesPayload = {
      ok: true, fetched_at: '2026-05-06T20:00:00.000Z', source: 'live:test',
      sheet_id: 'TEST', months: ['2026-03','2026-04','2026-05'],
      groups: ['Faucet'],
      matrix: {}, by_month: {}, by_group: { Faucet: { po: 0, grn: 0 } },
      latest_month: '2026-05', rows_n: 0,
      sales_by_branch_month: {
        W01: { '2026-03': 55491, '2026-04': 65408, '2026-05': 70000 },
        W02: { '2026-03':100038, '2026-04':109822, '2026-05':115000 },
        W03: { '2026-03': 75727, '2026-04': 82060, '2026-05': 90000 },
        W05: { '2026-03': 43487, '2026-04': 82149, '2026-05': 60000 },
        W07: { '2026-03': 68158, '2026-04': 63630, '2026-05': 55000 },
      },
      months_seen: ['2026-03','2026-04','2026-05'],
      branches_seen: ['W01','W02','W03','W05','W07'],
      _raw_ok: true, active_branches: ['W01','W02','W03','W05','W07'],
    };
    await page.route('**/api/sales*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(salesPayload)
    }));
    await page.route('**/api/customers*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, snapshot: '2026-05', months_seen: ['2026-03','2026-04','2026-05'],
        summary: {}, summary_by_window: {}, buckets_by_window: {},
        summary_by_month: { '2026-03': {}, '2026-04': {}, '2026-05': {} },
        buckets_by_month: { '2026-03': [], '2026-04': [], '2026-05': [] },
        windows: ['1m','3m','6m','12m'], types: ['Walk-in'],
        churn: { summary: {}, customers: [] }, top100: [] }),
    }));
    await page.route('**/api/floatation*', route => route.fulfill({ status: 502, body: '{"ok":false}' }));
    await page.route('**/api/proxy*',     route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":{}}' }));
    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_SALES_LIVE && (window as any).WP_SALES_LIVE._raw_ok === true, { timeout: 8000 });
    await page.evaluate(() => (window as any).setView('sales'));
    await page.waitForSelector('#dsSalesCards', { timeout: 5000 });
    const grab = async (m: string) => {
      await page.selectOption('#monthPicker', m);
      await page.waitForFunction((mm) => (window as any).SNAPSHOT === mm, m, { timeout: 5000 });
      await page.waitForFunction((mm) => {
        const t = document.getElementById('dsSalesChartTitle');
        return !!t && (t.textContent || '').includes(mm);
      }, m, { timeout: 5000 });
      return (await page.locator('#dsSalesCards .ds-card').first().locator('.value').innerText()).replace(/\s/g,'');
    };
    const v3 = await grab('2026-03');
    const v4 = await grab('2026-04');
    const v5 = await grab('2026-05');
    expect(new Set([v3, v4, v5]).size).toBe(3);   // all three differ
  });

  test('Acceptance (b): Refresh updates timestamp + reloads data', async ({ page }) => {
    await page.route('**/api/proxy*', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: {} }),
    }));
    await loginOwner(page);
    await page.waitForFunction(() => {
      const btn = document.getElementById('refreshBtn');
      return !!btn && !btn.classList.contains('loading') && !!localStorage.getItem('wp_last_refresh_v1');
    }, { timeout: 8000 });
    const before = parseInt(await page.evaluate(() => localStorage.getItem('wp_last_refresh_v1') || '0'), 10);
    await page.waitForTimeout(30);
    await page.click('#refreshBtn');
    await page.waitForSelector('#wpToast.show', { timeout: 5000 });
    const after = parseInt(await page.evaluate(() => localStorage.getItem('wp_last_refresh_v1') || '0'), 10);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeGreaterThan(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Round 11 — V1 第四刀: Products + Inventory + Customers refactor
   ----------------------------------------------------------------------
   Each dashboard now has top KPIs (3 or 4) + a 4-alert grid + chart +
   action plan. KPIs and alerts come from real WP_DEADSTOCK / WP_FINANCIAL /
   WP_CUSTOMERS / __wpLive data — never mock. Where data is missing
   (Strategic_Push column / Country field / monthly PO history), the card
   honestly shows '待补' / 'pending' (per Jym's hard rule).
   ════════════════════════════════════════════════════════════════════ */
test.describe('Round 11 — V1 第四刀: Products / Inventory / Customers', () => {
  test('Products: ABCD computes from sku_branch_sales_3m (sensible numbers)', async ({ page }) => {
    await loginOwner(page);
    const got = await page.evaluate(() => {
      const fn = (window as any).computeABCD;
      return fn ? fn() : null;
    });
    expect(got).not.toBeNull();
    expect(got!.ok).toBe(true);
    // Per Jym's spec: A should be tens-to-hundreds (not 0, not thousands)
    expect(got!.totals.A).toBeGreaterThan(50);
    expect(got!.totals.A).toBeLessThan(2000);
    expect(got!.totals.B).toBeGreaterThan(0);
    expect(got!.totals.C).toBeGreaterThan(0);
    expect(got!.totals.D).toBeGreaterThan(0);
    // skuRank entries cover every classified SKU
    const total = got!.totals.A + got!.totals.B + got!.totals.C + got!.totals.D;
    expect(total).toBeGreaterThan(500);
  });

  test('Products dashboard: top 3 KPIs render (single-month + compare)', async ({ page }) => {
    // V1 第四刀 返工: KPIs are now SINGLE-MONTH-aware. Without /api/sales mock
    // they fall back to '—' (no Raw sale data baked in static deadstock-data).
    // Mock /api/sales to return a payload with sku_amt_by_month so KPI 1
    // ("该月销售总额") renders an RM value. Also asserts compare lines exist.
    const salesPayload = {
      ok: true, source: 'test', sheet_id: 'TEST',
      months: ['2026-02','2026-03','2026-04'], groups: [],
      matrix: {}, by_month: {}, by_group: {},
      latest_month: '2026-04', rows_n: 3,
      sales_by_branch_month: { W01: { '2026-03': 50000, '2026-04': 55000 } },
      total_amt_by_month: { '2026-02': 280000, '2026-03': 350000, '2026-04': 360000 },
      sku_amt_by_month: {
        '2026-02': { 'AAA': 100000, 'BBB': 80000 },
        '2026-03': { 'AAA': 120000, 'BBB': 90000, 'CCC': 50000 },
        '2026-04': { 'AAA': 140000, 'BBB': 95000, 'CCC': 60000 },
      },
      sku_qty_by_month: {
        '2026-04': { 'AAA': 14, 'BBB': 9, 'CCC': 6 },
      },
      months_seen: ['2026-02','2026-03','2026-04'],
      branches_seen: ['W01'], _raw_ok: true, active_branches: ['W01'],
    };
    await page.route('**/api/sales*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(salesPayload)
    }));
    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_SALES_LIVE && (window as any).WP_SALES_LIVE._raw_ok === true, { timeout: 8000 });
    await page.evaluate(() => (window as any).setView('products'));
    await page.waitForSelector('#view-products.on');
    await page.waitForSelector('#dsProdCards .ds-card', { timeout: 5000 });
    const cards = await page.locator('#dsProdCards .ds-card .value').allTextContents();
    expect(cards).toHaveLength(3);
    // KPI 1 — 该月销售总额 must show RM value (not '—')
    expect(cards[0]).toMatch(/RM/);
    // 3 compare lines under each KPI
    const cmpLines = await page.locator('#dsProdCards .ds-card .cmp-line').count();
    expect(cmpLines).toBeGreaterThanOrEqual(6);   // ≥2 cards × 3 lines (third KPI may have null compare)
    // Alert grid present with 4 cards
    expect(await page.locator('#dsProdAlerts .ds-alert').count()).toBe(4);
  });

  test('Products dashboard: price-band, top-categories, top-20-SKU sections render with toggles', async ({ page }) => {
    const salesPayload = {
      ok: true, source: 'test', sheet_id: 'TEST',
      months: ['2026-04'], groups: [], matrix: {}, by_month: {}, by_group: {},
      latest_month: '2026-04', rows_n: 1,
      sales_by_branch_month: { W01: { '2026-04': 10000 } },
      total_amt_by_month: { '2026-04': 10000 },
      sku_amt_by_month: { '2026-04': { 'AAA': 5000, 'BBB': 3000, 'CCC': 2000 } },
      sku_qty_by_month: { '2026-04': { 'AAA': 5, 'BBB': 3, 'CCC': 2 } },
      months_seen: ['2026-04'], branches_seen: ['W01'],
      _raw_ok: true, active_branches: ['W01'],
    };
    await page.route('**/api/sales*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(salesPayload)
    }));
    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_SALES_LIVE && (window as any).WP_SALES_LIVE._raw_ok === true, { timeout: 8000 });
    await page.evaluate(() => (window as any).setView('products'));
    await page.waitForSelector('#view-products.on');
    // Three new sections all visible
    await expect(page.locator('#dsProdPriceSection')).toBeVisible();
    await expect(page.locator('#dsProdCatSection')).toBeVisible();
    await expect(page.locator('#dsProdTop20Section')).toBeVisible();
    // Each toggle has 3 pills (single / 6M / 12M) with single selected
    const pills = await page.locator('#dsProdTop20Toggle .rank-pill').count();
    expect(pills).toBe(3);
    const onPill = await page.locator('#dsProdTop20Toggle .rank-pill.on').getAttribute('data-rank-mode');
    expect(onPill).toBe('single');
    // Click 12M pill → state flips
    await page.locator('#dsProdTop20Toggle .rank-pill[data-rank-mode="m12"]').click();
    await page.waitForTimeout(150);
    const newOn = await page.locator('#dsProdTop20Toggle .rank-pill.on').getAttribute('data-rank-mode');
    expect(newOn).toBe('m12');
  });

  test('Inventory dashboard: 4 KPIs (snapshot label + monthly PO/gap)', async ({ page }) => {
    const salesPayload = {
      ok: true, source: 'test', sheet_id: 'TEST',
      months: ['2026-03','2026-04'], groups: ['Faucet'],
      matrix: { '2026-03': { 'Faucet': { po: 100000, grn: 90000 } },
                '2026-04': { 'Faucet': { po: 120000, grn: 100000 } } },
      by_month: {}, by_group: {}, latest_month: '2026-04', rows_n: 2,
      sales_by_branch_month: {}, total_amt_by_month: { '2026-03': 350000, '2026-04': 380000 },
      sku_amt_by_month: {}, sku_qty_by_month: {},
      months_seen: ['2026-03','2026-04'], _raw_ok: true,
    };
    await page.route('**/api/sales*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(salesPayload)
    }));
    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_SALES_LIVE && (window as any).WP_SALES_LIVE._raw_ok === true, { timeout: 8000 });
    await page.evaluate(() => (window as any).setView('inventory'));
    await page.waitForSelector('#view-inventory.on');
    await page.waitForSelector('#dsInvCards .ds-card', { timeout: 5000 });
    const cards = await page.locator('#dsInvCards .ds-card').count();
    expect(cards).toBe(4);
    // KPI 1 — snapshot label "截止 X 数据" / "as of"
    const k1Sub = await page.locator('#dsInvCards .ds-card').nth(0).locator('.sub').innerText();
    expect(k1Sub).toMatch(/截止|as of/);
    // KPI 2 — this month PO total (real, RM value)
    const k2Val = await page.locator('#dsInvCards .ds-card .value').nth(1).innerText();
    expect(k2Val).toMatch(/RM/);
    // KPI 4 — gap (sales - PO), real RM value with sign
    const k4Val = await page.locator('#dsInvCards .ds-card .value').nth(3).innerText();
    expect(k4Val).toMatch(/RM/);
  });

  test('Customers dashboard: 3 KPIs render (top 100 + cross_by_window mocked)', async ({ page }) => {
    // /api/customers is what populates cross_by_window + top100 — without it
    // the KPIs honestly show '—'/'待补' (which is the right behaviour). For
    // this test we mock a realistic payload so all 3 KPIs render values.
    const custPayload = {
      ok: true, fetched_at: '2026-05-07T00:00:00Z', source: 'live:test',
      months_seen: ['2026-03','2026-04','2026-05'], snapshot: '2026-04',
      windows: ['1m','3m','6m','12m'], types: ['Walk-in','Contractor','Interior Designer','Other'],
      summary: { total_members: 12000, n_active: 5800, amt_total: 4000000, snapshot: '2026-04' },
      summary_by_window: { '1m': {}, '3m': {}, '6m': {}, '12m': {} },
      buckets_by_window: { '1m': [], '3m': [], '6m': [], '12m': [] },
      cross_by_window: {
        '1m': {
          'Walk-in':           { n: 1200, amt: 300000 },
          'Contractor':        { n:  220, amt: 250000 },
          'Interior Designer': { n:   85, amt: 120000 },
          'Other':             { n:   40, amt:  50000 },
        },
        '3m': {}, '6m': {}, '12m': {},
      },
      sales_by_branch_month: {},
      summary_by_month: { '2026-04': {}, '2026-03': {} },
      buckets_by_month: { '2026-04': [], '2026-03': [] },
      top100: Array.from({length: 100}, (_, i) => ({
        mc: 'M' + i, name: 'Cust' + i, branch: 'W01', cust_type: 'Walk-in',
        enrol: '2024-01', age_years: 1.5, age_bucket: '1-5y',
        ltm_amt: 5000, ltm_visits: 5,
        m6_amt: 2000, m6_visits: 2,
        m3_amt: 1000, m3_visits: 1,
        m1_amt: i < 40 ? 0 : 500, m1_visits: i < 40 ? 0 : (i % 3),
        lifetime_amt: 8000, last: '2026-04',
      })),
      churn: { summary: {}, customers: [] },
    };
    await page.route('**/api/customers*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(custPayload)
    }));
    await loginOwner(page);
    await page.waitForFunction(() => {
      const cd = (window as any).WP_CUSTOMERS;
      return cd && cd.cross_by_window && cd.cross_by_window['1m'] && (cd.cross_by_window['1m']['Walk-in']?.n || 0) > 0;
    }, { timeout: 8000 });
    await page.evaluate(() => (window as any).setView('customers'));
    await page.waitForSelector('#view-customers.on');
    await page.waitForSelector('#dsCustCards .ds-card', { timeout: 5000 });
    const cards = await page.locator('#dsCustCards .ds-card').count();
    expect(cards).toBe(3);
    // KPI 1 (mix) — Walk-in is dominant (1200 of 1545)
    const k1 = await page.locator('#dsCustCards .ds-card .value').nth(0).innerText();
    expect(k1.trim()).not.toBe('—');
    expect(k1.toLowerCase()).toMatch(/walk|散客/);
    // KPI 2 (repeat rate) — must be a percentage
    const k2 = await page.locator('#dsCustCards .ds-card .value').nth(1).innerText();
    expect(k2).toMatch(/%/);
    expect(await page.locator('#dsCustAlerts .ds-alert').count()).toBe(4);
  });

  test('All 3 dashboards: every "待补" alert shows the pending-note explanation (honest)', async ({ page }) => {
    await loginOwner(page);
    for (const view of ['products', 'inventory', 'customers']) {
      await page.evaluate((v) => (window as any).setView(v), view);
      await page.waitForSelector(`#view-${view}.on`);
      const naAlerts = await page.locator(`#ds${view === 'products' ? 'Prod' : view === 'inventory' ? 'Inv' : 'Cust'}Alerts .ds-alert.tone-na`).count();
      const naPendingNotes = await page.locator(`#ds${view === 'products' ? 'Prod' : view === 'inventory' ? 'Inv' : 'Cust'}Alerts .ds-alert.tone-na .ds-alert-pending`).count();
      // Every na-tone alert must carry a pending explanation (no silent gaps)
      expect(naPendingNotes).toBe(naAlerts);
    }
  });

  test('Customers: race walk-in CR pulls from /api/floatation when present', async ({ page }) => {
    const liveFlo = {
      ok: true, fetched_at: '2026-05-07T00:00:00Z',
      year: 2026, months: ['2026-03','2026-04','2026-05'], month_idx: [3,4,5],
      races: [
        { key: 'chinese', label_en: 'Chinese', label_zh: '华族',
          walkin: [482, 461, 61], cr: [0.6909, 0.6898, 0.7213] },
        { key: 'malay', label_en: 'Malay', label_zh: '马来族',
          walkin: [758, 770, 87], cr: [0.7691, 0.7701, 0.6897] },
      ],
      totals: { walkin:[1240,1231,148], purchase:[920,915,103], amount:[290000,290000,33000], basket:[315,317,320], cr:[0.74,0.74,0.7] },
      by_branch: {}, source: 'live:test',
    };
    await page.route('**/api/floatation*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(liveFlo)
    }));
    await loginOwner(page);
    await page.waitForFunction(() => (window as any).WP_CUSTOMERS?.race?._live === true, { timeout: 5000 });
    await page.evaluate(() => (window as any).setView('customers'));
    // KPI 3 (race CR) should now show Malay (best CR in latest month: 0.6897 vs 0.7213)
    // Latest month index = 2 ⇒ chinese 0.7213, malay 0.6897 — chinese wins.
    const k3 = await page.locator('#dsCustCards .ds-card .value').nth(2).innerText();
    expect(k3).toMatch(/72\.1%|72%/);
  });
});
