import { Page, ConsoleMessage } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Console capture helper. Bind once per page; returns the live arrays.
 * - We deliberately ignore noisy network 4xx logs that result from a
 *   stubbed `/api/proxy` returning expected fallbacks.
 */
export function attachConsoleCapture(page: Page){
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos:  string[] = [];

  const isExpectedNoise = (msg: string) => {
    const m = msg.toLowerCase();
    // Known benign messages produced by stubbed Apps Script & Chart resize
    return (
      m.includes('chartjs') && m.includes('canvas resized') ||
      m.includes('failed to load resource') && m.includes('favicon')
    );
  };

  page.on('console', (msg: ConsoleMessage) => {
    const text = `${msg.text()}`;
    if (msg.type() === 'error'   && !isExpectedNoise(text)) errors.push(text);
    if (msg.type() === 'warning' && !isExpectedNoise(text)) warnings.push(text);
    if (msg.type() === 'info'    && !isExpectedNoise(text)) infos.push(text);
  });

  page.on('pageerror', (err) => {
    errors.push(`UNCAUGHT: ${err.message}`);
  });

  return { errors, warnings, infos };
}

/**
 * Look up the matching plain-text password for a user id.
 * Initial passwords are documented in users.js (verified by hash check).
 */
const PW_MAP: Record<string, string> = {
  owner: 'Owner@2026', finance: 'Finance@2026', bi: 'BI@2026',
  warehouse: 'Warehouse@2026', hr: 'HR@2026', marketing: 'Marketing@2026',
  w01_mgr: 'W01@2026', w02_mgr: 'W02@2026', w03_mgr: 'W03@2026',
  w05_mgr: 'W05@2026', w07_mgr: 'W07@2026', w11_mgr: 'W11@2026',
};

/**
 * Log in via the real form so module-scoped `currentUser` is set correctly.
 * Localhost provides crypto.subtle, so SHA-256 works without HTTPS.
 */
export async function loginAs(
  page: Page,
  user: { id: string; role: string; branch: string | null },
  lang: 'en' | 'zh' = 'en',
){
  const pw = PW_MAP[user.id];
  if (!pw) throw new Error(`No password mapping for user ${user.id}`);

  await page.goto('/Wiltek_MASTER.html', { waitUntil: 'load' });
  await page.waitForSelector('#lockScreen', { state: 'visible', timeout: 10_000 });
  // Clear stale lockout state from previous test runs
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch(e){} });
  await page.fill('#loginUser', user.id);
  await page.fill('#loginPw', pw);
  await page.evaluate(() => (window as any).checkPw());
  // Wait for unlock — lockScreen hides + a page becomes .active
  await page.waitForSelector('#lockScreen', { state: 'hidden', timeout: 15_000 });
  await page.waitForSelector('.page.active', { timeout: 10_000 });
  // Apply requested language
  if (lang === 'zh'){
    await page.evaluate(() => (window as any).setLang('zh'));
  }
}

/**
 * Navigate to a specific page id via the same nav() function the sidebar
 * calls. Returns true if the page becomes .active, false otherwise.
 *
 * `currentUser` is module-scoped inside the dashboard script (not on
 * window), so we don't gate by hasAccess() here — caller passes a list it
 * already filtered by `pagesForRole()`.
 */
export async function gotoPage(page: Page, pageId: string){
  return await page.evaluate((id) => {
    const W = window as any;
    if (typeof W.nav !== 'function') return false;
    W.nav(id);
    return !!document.querySelector(`#p-${id}.active`);
  }, pageId);
}

/**
 * Resolve which pages a role can see — uses the same WP_PERMS helper the UI
 * uses, so tests stay in sync with the source of truth.
 */
export async function pagesForRole(page: Page, role: string){
  return await page.evaluate((r) => {
    const W = window as any;
    const all = (W.WP_PERMS && W.WP_PERMS.rolePages && W.WP_PERMS.rolePages[r]) || [];
    return all.slice();
  }, role);
}

/**
 * Mkdir -p helper (Node's recursive flag does the same).
 */
export function ensureDir(p: string){
  fs.mkdirSync(p, { recursive: true });
}

export const SCREENSHOT_ROOT = path.resolve(__dirname, '..', '..', 'screenshots');
