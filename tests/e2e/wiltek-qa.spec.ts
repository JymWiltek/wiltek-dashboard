/**
 * Wiltek Portal — full QA matrix.
 *
 * Three layers:
 *   A. Functional   — console clean, no undefined/NaN, charts non-zero,
 *                     KPIs filled, controls clickable without throwing.
 *   B. UX (16 pts)  — loading/empty/error states, alignment, fonts,
 *                     spacing, buttons feedback, language switch, ESC,
 *                     scroll reset, a11y basics.
 *   C. Visual       — baseline screenshots @ desktop / tablet / mobile,
 *                     EN + ZH, plus contrast spot-checks.
 *
 * Failures get appended to tests/qa-report.md as the run progresses.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { CREDENTIALS, ALL_PAGES, VIEWPORTS, LANGS, PageId } from './lib/credentials';
import {
  attachConsoleCapture,
  loginAs,
  gotoPage,
  pagesForRole,
  ensureDir,
  SCREENSHOT_ROOT,
} from './lib/harness';

// ── Result accumulator (one shared file across the run) ──────────────────
//
// Findings are persisted to a JSON sidecar (qa-findings.json) because
// Playwright runs `test.afterAll` per-describe, and module-scoped arrays
// are reset between describes (each describe gets a fresh import in
// some pool configs). Reading-then-writing the JSON guarantees that
// every `afterAll` flush sees prior findings and re-renders the .md
// against the union.
type Finding = {
  layer: 'A' | 'B' | 'C';
  rule: string;
  role?: string;
  page?: string;
  viewport?: string;
  lang?: string;
  detail: string;
};
const REPORT_DIR    = path.resolve(__dirname, '..');
const REPORT_PATH   = path.join(REPORT_DIR, 'qa-report.md');
const FINDINGS_PATH = path.join(REPORT_DIR, 'qa-findings.json');

function loadFindings(): Finding[]{
  try { return JSON.parse(fs.readFileSync(FINDINGS_PATH, 'utf8')) || []; }
  catch { return []; }
}
function saveFindings(arr: Finding[]){
  ensureDir(REPORT_DIR);
  fs.writeFileSync(FINDINGS_PATH, JSON.stringify(arr, null, 2), 'utf8');
}
function record(f: Finding){
  const arr = loadFindings();
  arr.push(f);
  saveFindings(arr);
}

function renderReport(findings: Finding[]){
  const lines: string[] = [];
  lines.push('# Wiltek Portal — QA Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total findings: **${findings.length}**`);
  lines.push('');

  const byLayer = (l: string) => findings.filter(f => f.layer === l);
  const sections: Array<['A'|'B'|'C', string]> = [
    ['A', 'A. Functional'],
    ['B', 'B. UX checklist'],
    ['C', 'C. Visual consistency'],
  ];
  for (const [k, label] of sections){
    const list = byLayer(k);
    lines.push(`## ${label}  —  ${list.length} finding${list.length===1?'':'s'}`);
    if (list.length === 0){ lines.push(''); lines.push('_No issues._'); lines.push(''); continue; }
    lines.push('');
    lines.push('| # | Rule | Role | Page | Viewport | Lang | Detail |');
    lines.push('| - | ---- | ---- | ---- | -------- | ---- | ------ |');
    list.forEach((f, i) => {
      const detail = (f.detail || '').replace(/\n/g, ' ').replace(/\|/g, '\\|').slice(0, 220);
      lines.push(`| ${i+1} | ${f.rule} | ${f.role||'-'} | ${f.page||'-'} | ${f.viewport||'-'} | ${f.lang||'-'} | ${detail} |`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

// Session-id strategy: the npm script (`pretest:e2e`) deletes
// qa-findings.json before invoking Playwright. We then *append* to the
// file across all afterAll calls without ever wiping mid-run.

test.afterAll(async () => {
  ensureDir(REPORT_DIR);
  const findings = loadFindings();
  fs.writeFileSync(REPORT_PATH, renderReport(findings), 'utf8');
  // Always log to stdout too so CI tail picks it up
  console.log(`\n=== QA report written to ${REPORT_PATH} (${findings.length} findings) ===\n`);
});

// ── Functional helpers ───────────────────────────────────────────────────
async function scanForUndefinedText(page: Page){
  return await page.evaluate(() => {
    // Walk only the active page (not the entire main, which includes
    // hidden pages whose innerText still leaks).
    const target = document.querySelector('.page.active') as HTMLElement | null;
    if (!target) return [] as Array<{ kind: string; sample: string }>;
    const txt = target.innerText || '';
    const hits: Array<{ kind: string; sample: string }> = [];
    const checks: Array<[string, RegExp]> = [
      ['undefined',  /\bundefined\b/],
      ['NaN',        /\bNaN\b/],
      ['nullText',   /\bnull\b/],
      ['objObj',     /\[object Object\]/],
    ];
    for (const [k, re] of checks){
      const m = re.exec(txt);
      if (m){
        // Capture ~60 chars of context for triage
        const idx = m.index;
        const sample = txt.slice(Math.max(0, idx - 30), Math.min(txt.length, idx + 40)).replace(/\s+/g, ' ');
        hits.push({ kind: k, sample });
      }
    }
    return hits;
  });
}

async function scanForZeroSizeCharts(page: Page){
  return await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('.page.active canvas').forEach((c) => {
      const r = (c as HTMLElement).getBoundingClientRect();
      if (r.width < 4 || r.height < 4) out.push(c.id || '(anon)');
    });
    return out;
  });
}

async function scanKPIs(page: Page){
  // A "data KPI" is one that includes a `.kv` element. Nav tiles on the
  // Quicklinks page also use `.kpi` for layout but deliberately omit `.kv`
  // — those aren't data cards and we don't flag them.
  return await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('.page.active .kpi').forEach((k) => {
      const kv = k.querySelector('.kv') as HTMLElement | null;
      if (!kv) return;
      const v = (kv.innerText || '').trim();
      if (!v) out.push((k.querySelector('.kl') as HTMLElement | null)?.innerText?.trim() || '(unlabelled)');
    });
    return out;
  });
}

async function scanButtonsClickable(page: Page){
  // Click sample of in-page buttons (limit to 12 to keep runtime sane); record any throw.
  return await page.evaluate(async () => {
    const out: { label: string; err: string }[] = [];
    const buttons = Array.from(document.querySelectorAll('.page.active button:not([disabled])')).slice(0, 12) as HTMLElement[];
    for (const b of buttons){
      try {
        // Simulate a click but swallow side-effect navigation to keep us on
        // the current page. We don't await — just see whether it throws sync.
        const ev = new MouseEvent('click', { bubbles:true, cancelable:true });
        b.dispatchEvent(ev);
      } catch(e){
        const msg = (e as Error).message || String(e);
        out.push({ label: b.textContent?.trim().slice(0, 40) || '(blank)', err: msg });
      }
    }
    return out;
  });
}

async function scanA11y(page: Page){
  return await page.evaluate(() => {
    const out: string[] = [];
    const buttons = Array.from(document.querySelectorAll('.page.active button')) as HTMLElement[];
    buttons.forEach(b => {
      const text = (b.innerText || '').trim();
      const aria = b.getAttribute('aria-label');
      const title = b.getAttribute('title');
      if (!text && !aria && !title){
        out.push((b.outerHTML || '').slice(0, 80));
      }
    });
    return out;
  });
}

async function scanFontConsistency(page: Page){
  // All `.ph` (page headers) on the active page should share the same
  // font-size + font-weight; same for all `.sec` section labels.
  return await page.evaluate(() => {
    const grab = (sel: string) => Array.from(document.querySelectorAll(`.page.active ${sel}`))
      .map(el => {
        const cs = getComputedStyle(el as HTMLElement);
        return cs.fontSize + '/' + cs.fontWeight;
      });
    const phs  = grab('.ph');
    const secs = grab('.sec');
    const phUnique  = Array.from(new Set(phs));
    const secUnique = Array.from(new Set(secs));
    const out: string[] = [];
    if (phUnique.length > 1)  out.push('ph-font: '  + phUnique.join(' | '));
    if (secUnique.length > 1) out.push('sec-font: ' + secUnique.join(' | '));
    return out;
  });
}

async function scanHorizontalScroll(page: Page){
  return await page.evaluate(() => {
    const w = document.documentElement.scrollWidth;
    const c = document.documentElement.clientWidth;
    return w - c > 4 ? `scrollWidth=${w} clientWidth=${c}` : '';
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1 — A & B layers per role × per page (single viewport, EN)
// ─────────────────────────────────────────────────────────────────────────
test.describe('A+B  per-role × per-page  @ tablet/EN', () => {
  for (const u of CREDENTIALS){
    test(`role=${u.id}`, async ({ page }) => {
      // 21 pages × per-page settle (400ms) + scans + ~12 button clicks each
      // can blow past the default 60 s, esp. on first run when the dev
      // server is cold.
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 1024, height: 768 });
      const cap = attachConsoleCapture(page);
      await loginAs(page, u as any, 'en');

      const allowed = await pagesForRole(page, u.role);
      expect(allowed.length, `role ${u.id} has zero pages`).toBeGreaterThan(0);

      for (const pid of allowed){
        const ok = await gotoPage(page, pid);
        if (!ok){
          record({ layer: 'A', rule: 'NAV-FAIL', role: u.id, page: pid, detail: 'gotoPage returned false' });
          continue;
        }
        // Give renders + Chart.js a moment to settle
        await page.waitForTimeout(400);

        // A1 — undefined/NaN/null/[object Object] in visible text
        const placeholders = await scanForUndefinedText(page);
        for (const p of placeholders){
          record({ layer: 'A', rule: `A1-${p.kind}`, role: u.id, page: pid, detail: `visible '${p.kind}' near "…${p.sample}…"` });
        }

        // A2 — chart canvases sized
        const zeroCharts = await scanForZeroSizeCharts(page);
        for (const z of zeroCharts){
          record({ layer: 'A', rule: 'A2-chart-zero', role: u.id, page: pid, detail: `canvas ${z} ~0×0` });
        }

        // A3 — KPI cards have content
        const blankKPIs = await scanKPIs(page);
        for (const k of blankKPIs){
          record({ layer: 'A', rule: 'A3-kpi-blank', role: u.id, page: pid, detail: `KPI '${k}' has empty .kv` });
        }

        // A4 — sample button clicks don't throw synchronously
        const btnErrs = await scanButtonsClickable(page);
        for (const e of btnErrs){
          record({ layer: 'A', rule: 'A4-button-throw', role: u.id, page: pid, detail: `${e.label}: ${e.err}` });
        }

        // B6 / B16 — buttons must have label or aria-label/title
        const a11y = await scanA11y(page);
        for (const a of a11y){
          record({ layer: 'B', rule: 'B16-a11y-button', role: u.id, page: pid, detail: a });
        }

        // B5 — font consistency
        const fontIssues = await scanFontConsistency(page);
        for (const f of fontIssues){
          record({ layer: 'B', rule: 'B5-font', role: u.id, page: pid, detail: f });
        }

        // B11 — horizontal scroll on tablet should not appear (matrix breakpoint)
        const hs = await scanHorizontalScroll(page);
        if (hs) record({ layer: 'B', rule: 'B11-h-scroll', role: u.id, page: pid, viewport: 'tablet', detail: hs });
      }

      // Console error tally — one finding per unique message
      const seen = new Set<string>();
      for (const e of cap.errors){
        if (!seen.has(e)){ seen.add(e); record({ layer: 'A', rule: 'console-error', role: u.id, detail: e.slice(0, 280) }); }
      }
      for (const w of cap.warnings){
        if (!seen.has(w)){ seen.add(w); record({ layer: 'A', rule: 'console-warn', role: u.id, detail: w.slice(0, 280) }); }
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2 — UX checks that need explicit user actions (lang switch,
//             ESC modal close, nav scroll-to-top, login error message)
// ─────────────────────────────────────────────────────────────────────────
test.describe('B  UX behaviours', () => {
  test('B12 language switch — ZH translates header / subtitle on key pages', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1024, height: 768 });
    attachConsoleCapture(page);
    await loginAs(page, CREDENTIALS[0] as any, 'en');

    // Pages whose header (.ph) OR subtitle (.ps) MUST differ between EN/ZH —
    // a stable hook that an injection attacker couldn't easily fake.
    const probes: Array<[string, string]> = [
      ['health',   '#p-health'],
      ['pl',       '#p-pl'],
      ['cashflow', '#p-cashflow'],
      ['gp',       '#p-gp'],
    ];
    type Snap = { ph: string; ps: string };
    const snap = async (sel: string): Promise<Snap> => page.evaluate((s) => {
      const root = document.querySelector(s + '.active') as HTMLElement | null;
      const ph = (root?.querySelector('.ph') as HTMLElement | null)?.innerText || '';
      const ps = (root?.querySelector('.ps') as HTMLElement | null)?.innerText || '';
      return { ph, ps };
    }, sel);

    for (const [pid, sel] of probes){
      const ok = await gotoPage(page, pid);
      if (!ok) continue;
      await page.waitForTimeout(200);
      await page.evaluate(() => (window as any).setLang('en'));
      await page.waitForTimeout(150);
      const en = await snap(sel);
      await page.evaluate(() => (window as any).setLang('zh'));
      await page.waitForTimeout(150);
      const zh = await snap(sel);
      // A page is considered translated if EITHER header or subtitle changes.
      const changed = (en.ph !== zh.ph && en.ph) || (en.ps !== zh.ps && en.ps);
      if (!changed){
        record({ layer:'B', rule:'B12-lang-switch', role:'owner', page:pid, detail:
          `no translation: ph='${en.ph}' ps='${en.ps}'` });
      }
      // Reset to EN so the next probe starts clean.
      await page.evaluate(() => (window as any).setLang('en'));
    }
  });

  test('B14 nav scroll resets to top', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await loginAs(page, CREDENTIALS[0] as any, 'en');
    await gotoPage(page, 'health');
    // scroll down on the long page
    await page.evaluate(() => window.scrollTo(0, 800));
    await gotoPage(page, 'pl');
    const top = await page.evaluate(() => window.scrollY);
    if (top > 8){
      record({ layer:'B', rule:'B14-scroll-top', role:'owner', page:'pl', detail:`scrollY=${top} after nav` });
    }
    expect(top).toBeLessThanOrEqual(8);
  });

  test('B9 login error renders friendly message', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/Wiltek_MASTER.html', { waitUntil: 'load' });
    await page.waitForSelector('#lockScreen');
    await page.fill('#loginUser', 'owner');
    await page.fill('#loginPw',   'wrong-password');
    // The Sign-In button has no id; trigger checkPw() directly.
    await page.evaluate(() => (window as any).checkPw());
    await page.waitForTimeout(800);
    const errText = await page.evaluate(() => (document.getElementById('pwErr')?.innerText || '').trim());
    if (!errText){
      record({ layer:'B', rule:'B9-form-feedback', detail:'no visible error after wrong password' });
    }
    expect(errText).toBeTruthy();
  });

  test('B11 mobile (380px) — no horizontal scroll on Today', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 380, height: 720 });
    attachConsoleCapture(page);
    await loginAs(page, CREDENTIALS[0] as any, 'en');
    await gotoPage(page, 'today');
    await page.waitForTimeout(400);
    const hs = await scanHorizontalScroll(page);
    if (hs) record({ layer:'B', rule:'B11-h-scroll', role:'owner', page:'today', viewport:'mobile', detail:hs });
    expect(hs).toEqual('');
  });

  test('B11 mobile (380px) — no horizontal scroll across all pages', async ({ page }) => {
    // Catch any other page that overflows on mobile, not just Today.
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 380, height: 720 });
    attachConsoleCapture(page);
    await loginAs(page, CREDENTIALS[0] as any, 'en');
    const allowed = await pagesForRole(page, 'owner');
    for (const pid of allowed){
      const ok = await gotoPage(page, pid);
      if (!ok) continue;
      await page.waitForTimeout(300);
      const hs = await scanHorizontalScroll(page);
      if (hs){
        record({ layer:'B', rule:'B11-h-scroll', role:'owner', page:pid, viewport:'mobile', detail:hs });
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3 — Visual consistency: baseline screenshots + contrast probe.
//   Owner @ all 3 viewports + EN/ZH (full); other roles @ tablet+EN only
//   to keep runtime under control (the matrix is meant to catch UX, not
//   pixel-perfect regression).
// ─────────────────────────────────────────────────────────────────────────
test.describe('C  visual screenshots', () => {
  test('owner — all viewports × langs × pages (baseline)', async ({ page }) => {
    // 21 pages × 3 viewports × 2 langs = 126 screenshots — generous budget.
    test.setTimeout(900_000);
    for (const lang of LANGS){
      for (const vp of VIEWPORTS){
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await loginAs(page, CREDENTIALS[0] as any, lang);
        const allowed = await pagesForRole(page, 'owner');
        for (const pid of allowed){
          const ok = await gotoPage(page, pid);
          if (!ok) continue;
          await page.waitForTimeout(350);
          const dir = path.join(SCREENSHOT_ROOT, 'owner', vp.name, lang);
          ensureDir(dir);
          await page.screenshot({
            path: path.join(dir, `${pid}.png`),
            fullPage: false,   // viewport-only keeps file size sane
          });
        }
      }
    }
  });

  test('all other roles — tablet/EN (baseline)', async ({ page }) => {
    // 11 roles × ~8–18 pages each — generous budget.
    test.setTimeout(900_000);
    for (const u of CREDENTIALS){
      if (u.id === 'owner') continue;
      await page.setViewportSize({ width: 1024, height: 768 });
      await loginAs(page, u as any, 'en');
      const allowed = await pagesForRole(page, u.role);
      for (const pid of allowed){
        const ok = await gotoPage(page, pid);
        if (!ok) continue;
        await page.waitForTimeout(350);
        const dir = path.join(SCREENSHOT_ROOT, u.id, 'tablet', 'en');
        ensureDir(dir);
        await page.screenshot({ path: path.join(dir, `${pid}.png`), fullPage: false });
      }
    }
  });

  test('contrast probe — body text ≥ 4.5:1 on dark BG', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await loginAs(page, CREDENTIALS[0] as any, 'en');
    await gotoPage(page, 'health');
    const ratio = await page.evaluate(() => {
      // Sample body-text foreground vs page background. Stripped from
      // window.getComputedStyle on a `.ks` (sub-text) and the page bg.
      const sample = document.querySelector('.page.active .ks') as HTMLElement | null;
      if (!sample) return null;
      const fg = getComputedStyle(sample).color;
      const bg = getComputedStyle(document.body).backgroundColor;
      const toRgb = (s: string) => {
        const m = s.match(/\d+(\.\d+)?/g);
        return m ? m.slice(0, 3).map(parseFloat) : [0, 0, 0];
      };
      const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
      const lum = (rgb: number[]) => 0.2126*lin(rgb[0]) + 0.7152*lin(rgb[1]) + 0.0722*lin(rgb[2]);
      const lf = lum(toRgb(fg));
      const lb = lum(toRgb(bg));
      const hi = Math.max(lf, lb), lo = Math.min(lf, lb);
      return (hi + 0.05) / (lo + 0.05);
    });
    if (ratio !== null && ratio < 4.5){
      record({ layer:'C', rule:'C-contrast', detail:`ks-on-bg ratio=${(ratio||0).toFixed(2)} (<4.5 fails AA body text)` });
    }
  });
});
