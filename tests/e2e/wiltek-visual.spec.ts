/**
 * Wiltek Portal — Wave 1 Step 4 visual self-audit harness.
 *
 * Captures high-fidelity baseline shots for me to look at directly. Owner
 * sees every page, so we exercise the broadest surface; other roles get a
 * sanity-shot of Today only. All three viewports (380 / 1024 / 1920) and
 * both langs (EN / ZH).
 *
 * Output goes to tests/visual/<role>/<viewport>/<lang>/<page>.png so I can
 * Read each PNG, critique, then iterate on the CSS.
 *
 * This does NOT replace the existing wiltek-qa.spec.ts e2e suite; that
 * stays the source of truth for functional/UX/contrast guarantees.
 */
import { test, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { CREDENTIALS, VIEWPORTS, LANGS, PageId } from './lib/credentials';
import { loginAs, gotoPage, ensureDir } from './lib/harness';

const VIS_ROOT = path.resolve(__dirname, '..', 'visual');

// Rich page set — every visual surface area we want to validate
const OWNER_PAGES: PageId[] = [
  'today', 'health', 'pl', 'cashflow', 'gp', 'branches', 'inventory',
  'expenses', 'action', 'balancesheet', 'customers', 'branchhub',
  'branchtoday', 'quicklinks', 'bistrat', 'biwh', 'inv360',
  'gtd', 'proposals', 'valuation', 'settings',
];

// Cross-role smoke — just Today on tablet/EN. Roles match the credential
// `id`, not `role` (the file uses bi_consultant for the role but the
// login id is `bi`).
const SMOKE_ROLE_IDS = [
  'finance', 'bi', 'warehouse', 'hr', 'marketing',
  'w01_mgr', 'w02_mgr', 'w03_mgr', 'w05_mgr', 'w07_mgr', 'w11_mgr',
];

async function shoot(page: Page, role: string, viewport: string, lang: string, pageId: string){
  const dir = path.join(VIS_ROOT, role, viewport, lang);
  ensureDir(dir);
  const fp = path.join(dir, `${pageId}.png`);
  await page.screenshot({ path: fp, fullPage: true, animations: 'disabled' });
}

test.describe('Visual self-audit (wave 1 step 4)', () => {

  test('owner — all pages × 3 viewports × 2 langs', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const owner = CREDENTIALS.find(c => c.id === 'owner')!;

    for (const vp of VIEWPORTS){
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const lang of LANGS){
        await loginAs(page, owner, lang);
        for (const pid of OWNER_PAGES){
          await gotoPage(page, pid);
          await page.waitForTimeout(450);  // let charts + skeletons settle
          await shoot(page, owner.id, vp.name, lang.toLowerCase(), pid);
        }
        // Logout between langs so the next loginAs() works cleanly
        const logout = page.locator('#logoutBtn');
        if (await logout.isVisible().catch(() => false)) await logout.click();
        await page.waitForTimeout(120);
      }
    }
  });

  test('cross-role — Today @ tablet/EN sanity', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await page.setViewportSize({ width: 1024, height: 768 });
    for (const id of SMOKE_ROLE_IDS){
      const cred = CREDENTIALS.find(c => c.id === id)!;
      await loginAs(page, cred, LANGS[0]);
      await gotoPage(page, 'today');
      await page.waitForTimeout(350);
      await shoot(page, cred.id, 'tablet', 'en', 'today');
      const logout = page.locator('#logoutBtn');
      if (await logout.isVisible().catch(() => false)) await logout.click();
      await page.waitForTimeout(100);
    }
  });

});
