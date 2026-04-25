/**
 * Wiltek Portal — quick-shot harness (owner @ tablet/EN, key pages).
 *
 * Used during the visual self-audit to iterate fast. Full sweep lives in
 * wiltek-visual.spec.ts; this exists so I can shoot 8 pages in ~90s and
 * critique without waiting for the 20-min owner matrix.
 */
import { test, Page } from '@playwright/test';
import * as path from 'path';
import { CREDENTIALS, LANGS, PageId } from './lib/credentials';
import { loginAs, gotoPage, ensureDir } from './lib/harness';

const VIS_ROOT = path.resolve(__dirname, '..', 'visual');

const QUICK_PAGES: PageId[] = [
  'today', 'health', 'pl', 'cashflow', 'gp', 'branches', 'inventory', 'settings',
];

test('quickshot — owner @ tablet/EN, 8 key pages', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const owner = CREDENTIALS.find(c => c.id === 'owner')!;
  await page.setViewportSize({ width: 1024, height: 768 });
  await loginAs(page, owner, LANGS[0]);
  for (const pid of QUICK_PAGES){
    await gotoPage(page, pid);
    await page.waitForTimeout(420);
    const dir = path.join(VIS_ROOT, 'owner', 'tablet', 'en');
    ensureDir(dir);
    await page.screenshot({ path: path.join(dir, `${pid}.png`), fullPage: true, animations: 'disabled' });
  }
});

test('quickshot — owner @ desktop/EN, today + health + pl', async ({ page }) => {
  test.setTimeout(2 * 60_000);
  const owner = CREDENTIALS.find(c => c.id === 'owner')!;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await loginAs(page, owner, LANGS[0]);
  for (const pid of ['today', 'health', 'pl', 'branches', 'inventory'] as PageId[]){
    await gotoPage(page, pid);
    await page.waitForTimeout(420);
    const dir = path.join(VIS_ROOT, 'owner', 'desktop', 'en');
    ensureDir(dir);
    await page.screenshot({ path: path.join(dir, `${pid}.png`), fullPage: true, animations: 'disabled' });
  }
});

test('quickshot — owner @ mobile/EN, today + health', async ({ page }) => {
  test.setTimeout(2 * 60_000);
  const owner = CREDENTIALS.find(c => c.id === 'owner')!;
  await page.setViewportSize({ width: 380, height: 720 });
  await loginAs(page, owner, LANGS[0]);
  for (const pid of ['today', 'health', 'pl', 'cashflow'] as PageId[]){
    await gotoPage(page, pid);
    await page.waitForTimeout(420);
    const dir = path.join(VIS_ROOT, 'owner', 'mobile', 'en');
    ensureDir(dir);
    await page.screenshot({ path: path.join(dir, `${pid}.png`), fullPage: true, animations: 'disabled' });
  }
});

test('quickshot — owner @ tablet/ZH', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const owner = CREDENTIALS.find(c => c.id === 'owner')!;
  await page.setViewportSize({ width: 1024, height: 768 });
  await loginAs(page, owner, 'zh');
  for (const pid of ['today', 'health', 'pl', 'branches'] as PageId[]){
    await gotoPage(page, pid);
    await page.waitForTimeout(420);
    const dir = path.join(VIS_ROOT, 'owner', 'tablet', 'zh');
    ensureDir(dir);
    await page.screenshot({ path: path.join(dir, `${pid}.png`), fullPage: true, animations: 'disabled' });
  }
});
