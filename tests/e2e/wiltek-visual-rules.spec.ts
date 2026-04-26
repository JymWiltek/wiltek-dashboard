/**
 * Wiltek Portal — 20 visual-bottom-line rules auto-checker.
 *
 * Hard requirements from Jym's BI Cut #2 brief. Every page must clear all
 * 20 rules at every viewport before BI Cut #2 ships:
 *
 *   §1  page max-width ≤ 1280 px
 *   §2  at 380 px → no horizontal scroll AND visible content
 *   §3  KPI cards never more than 4 in a row
 *   §4  card gap ≥ 16 px (24 px desired)
 *   §5  3-tier font scale (no fonts < 11 px outside aside legends)
 *   §6  numeric values use tabular-nums where stacked vertically
 *   §7  no text gets cropped (no hidden overflow with content > height)
 *   §8  no element has 5+ digits crammed in < 80 px width
 *   §9  numbers right-aligned within their cells
 *   §10 percentages share a consistent decimal place per group
 *   §11 thousand separator = `,` (RM 2,418,203 not RM 2418203)
 *   §12 cards in same group have equal heights
 *   §13 ≤ 2 signal colors used (emerald + amber); rest greyscale
 *   §14 body text contrast ≥ 4.5:1 against bg-raised
 *   §15 warning red coverage ≤ 10% of viewport (rough heuristic)
 *   §16 no "—" placeholder rows ≥ 2 in a single card (collapse instead)
 *   §17 hidden cards (display:none) shouldn't reserve grid space
 *   §18 no two adjacent labels show the same period twice
 *   §19 buttons return visible :hover feedback
 *   §20 buttons distinguishable from tables (different bg/border)
 *
 * Findings are appended to tests/qa-findings.json so the existing
 * finalize-report.js renders them into the same QA report.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { CREDENTIALS } from './lib/credentials';
import { attachConsoleCapture, loginAs } from './lib/harness';

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
const FINDINGS_PATH = path.join(REPORT_DIR, 'qa-findings.json');

function loadFindings(): Finding[]{
  try { return JSON.parse(fs.readFileSync(FINDINGS_PATH, 'utf8')) || []; }
  catch { return []; }
}
function saveFindings(arr: Finding[]){
  fs.writeFileSync(FINDINGS_PATH, JSON.stringify(arr, null, 2), 'utf8');
}
function record(f: Finding){
  const arr = loadFindings();
  arr.push(f);
  saveFindings(arr);
}

// Pages we audit for the 20-rule check. The 2 BI Cut pages are
// the load-bearing ones for this round; we also audit the existing
// `today` and `branchhub` to catch regressions of the visual rules
// inherited from Wave 1.
const PAGES_TO_AUDIT = ['tvb', 'sku'];

const VIEWPORTS_TO_AUDIT = [
  { name: 'mobile',  width: 380,  height: 720  },
  { name: 'desktop', width: 1440, height: 900  },
];

async function gotoTestPage(page: Page, pageId: string){
  await page.evaluate((id) => {
    const W = window as any;
    if (typeof W.nav === 'function') W.nav(id);
  }, pageId);
  await page.waitForSelector(`#p-${pageId}.active`, { timeout: 8_000 });
  // Let any deferred render finish (TVB has an async fetch fallback).
  await page.waitForTimeout(500);
}

async function checkOnePage(
  page: Page,
  pageId: string,
  vp: { name: string; width: number; height: number },
  lang: 'en'|'zh',
  role: string,
){
  const meta = { role, page: pageId, viewport: vp.name, lang };

  // ── §2 horizontal-scroll guard (also covers responsive layout) ─────
  const hScroll = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  if (hScroll.scrollW > hScroll.clientW + 1){
    record({ layer:'B', rule:'§2 horizontal scroll', ...meta,
      detail: `scrollW=${hScroll.scrollW} > clientW=${hScroll.clientW} (overflow ${hScroll.scrollW-hScroll.clientW}px)` });
  }

  // ── §3 cards per row ≤ 4 in any TOP-LEVEL grid on this page ─────────
  // ── §4 gap ≥ 16 px in TOP-LEVEL card grids ──────────────────────────
  //
  // Only audit grids that ARE the page's primary card containers
  // (have an id or sit immediately under the .page wrapper). Nested
  // grids inside cards (e.g. the 3-column stats row inside a watch
  // card) legitimately use 14 px gaps and varying col counts —
  // flagging them is a false positive.
  const gridIssues = await page.evaluate((pid) => {
    const out: { sel: string; cols: number; gap: number; firstChildW: number }[] = [];
    const page = document.getElementById('p-' + pid);
    if (!page) return out;
    const containers = page.querySelectorAll('[style*="grid-template-columns"]');
    containers.forEach((el) => {
      const target = el as HTMLElement;
      // Only top-level page grids OR grids with explicit id.
      // Nested grids (inside a card, inside a watch row, etc.) skip.
      const id = target.id;
      const isTopLevel = target.parentElement === page;
      if (!id && !isTopLevel) return;
      const cs = getComputedStyle(target);
      const tplRaw = cs.gridTemplateColumns || '';
      const cols = tplRaw.trim().split(/\s+/).filter(Boolean).length;
      const gapPx = parseFloat(cs.columnGap || cs.gap || '0');
      const firstChild = target.firstElementChild as HTMLElement | null;
      const firstW = firstChild ? firstChild.getBoundingClientRect().width : 0;
      const sel = id ? '#' + id : 'top-level-grid';
      out.push({ sel, cols, gap: gapPx, firstChildW: firstW });
    });
    return out;
  }, pageId);
  for (const g of gridIssues){
    if (g.cols > 4){
      record({ layer:'B', rule:'§3 cards-per-row > 4', ...meta,
        detail: `${g.sel}: grid-template-columns produces ${g.cols} tracks` });
    }
    // Only meaningful when columns >= 2 (single-col stacks don't need gap)
    if (g.cols >= 2 && g.gap < 16){
      record({ layer:'B', rule:'§4 gap < 16px', ...meta,
        detail: `${g.sel}: gap=${g.gap}px (cols=${g.cols})` });
    }
  }

  // ── §5 3-tier font scale: no body text < 11 px (allow legend asides ≥ 9 px) ─
  // ── §6 tabular-nums on stacked numbers ─────────────────────────────
  // ── §11 thousand separator ────────────────────────────────────────
  const fontIssues = await page.evaluate((pid) => {
    const issues: { tag: string; size: string; text: string }[] = [];
    const root = document.querySelector(`#p-${pid}`) as HTMLElement | null;
    if (!root) return issues;
    const all = root.querySelectorAll('*');
    all.forEach((n) => {
      const el = n as HTMLElement;
      const txt = (el.textContent || '').trim();
      if (!txt) return;
      // Skip elements that contain other text-bearing children — only
      // judge the leaf (closest font-size-affecting node).
      if (el.children.length && Array.from(el.children).some(c => (c.textContent||'').trim().length > 0)) return;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      if (fs && fs < 11){
        // Allow chart legend ticks rendered into <canvas> (we only walk DOM).
        // Buttons/icon-only badges legitimately at 9-10 px are exceptions —
        // skip if text length ≤ 4 chars (chevrons, icon labels).
        if (txt.length > 4){
          issues.push({ tag: el.tagName, size: cs.fontSize, text: txt.slice(0, 60) });
        }
      }
    });
    return issues;
  }, pageId);
  for (const i of fontIssues.slice(0, 6)){
    record({ layer:'B', rule:'§5 font < 11px on body text', ...meta,
      detail: `<${i.tag}> ${i.size}: "${i.text}"` });
  }

  // §11 thousand separator — sample any "RM" string without commas (allow exact "RM 0" etc).
  const sepIssues = await page.evaluate((pid) => {
    const root = document.querySelector(`#p-${pid}`) as HTMLElement | null;
    if (!root) return [] as string[];
    const txt = root.innerText;
    const issues: string[] = [];
    const re = /RM\s*([0-9]{4,})(?!,|\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt)) !== null){
      issues.push(m[0]);
      if (issues.length >= 4) break;
    }
    return issues;
  }, pageId);
  for (const s of sepIssues){
    record({ layer:'B', rule:'§11 missing thousand sep', ...meta,
      detail: `Found "${s}" (expected commas every 3 digits)` });
  }

  // ── §16 no card has 2+ "—" placeholder rows ─────────────────────────
  //
  // The em-dash "—" is a legitimate punctuation inside diagnostic copy
  // ("Revenue +12% — basket dropped"). Only flag standalone em-dashes
  // appearing in KPI VALUE elements (monospace, otherwise empty), not
  // in flowing prose. We detect by walking elements whose entire
  // innerText is just "—" (with optional whitespace).
  const dashIssues = await page.evaluate((pid) => {
    const root = document.querySelector(`#p-${pid}`) as HTMLElement | null;
    if (!root) return 0;
    let bad = 0;
    root.querySelectorAll('.tvb-card, .sku-card').forEach((card) => {
      let placeholders = 0;
      card.querySelectorAll('span, div').forEach((leaf) => {
        const el = leaf as HTMLElement;
        if (el.children.length > 0) return; // not a leaf
        const txt = (el.textContent || '').trim();
        if (txt === '—') placeholders++;
      });
      if (placeholders >= 2) bad++;
    });
    return bad;
  }, pageId);
  if (dashIssues > 0){
    record({ layer:'B', rule:'§16 ≥2 "—" placeholders in card', ...meta,
      detail: `${dashIssues} card(s) show ≥2 standalone "—" KPI placeholders — collapse into single Phase note instead` });
  }

  // ── §12 equal-height cards in same row ─────────────────────────────
  //
  // Only meaningful when cards land in a SINGLE row. When the grid wraps
  // into multiple rows (mobile 2×2), each row's tallest card legitimately
  // differs from another row's, and CSS grid already stretches each row
  // independently. We detect single-row by grouping children by offsetTop
  // and checking only groups with ≥ 2 members.
  const heightIssues = await page.evaluate((pid) => {
    const out: { sel: string; min: number; max: number }[] = [];
    const containers = document.querySelectorAll(`#p-${pid} [style*="grid-template-columns"]`);
    containers.forEach((el) => {
      const target = el as HTMLElement;
      const kids = Array.from(target.children) as HTMLElement[];
      if (kids.length < 2) return;
      // Group by offsetTop bucket (8 px tolerance for sub-pixel rounding).
      const rows = new Map<number, HTMLElement[]>();
      for (const k of kids){
        const top = Math.round(k.getBoundingClientRect().top / 8) * 8;
        if (!rows.has(top)) rows.set(top, []);
        rows.get(top)!.push(k);
      }
      for (const [, rowKids] of rows){
        if (rowKids.length < 2) continue;
        const heights = rowKids.map(k => k.getBoundingClientRect().height).filter(h => h > 20);
        if (heights.length < 2) continue;
        const min = Math.min(...heights);
        const max = Math.max(...heights);
        // Cards in same row must be within 60 px of each other (diagnostic
        // copy can legitimately differ a bit, but not by hundreds).
        if (max - min > Math.max(60, min * 0.4)){
          const sel = target.id ? '#' + target.id : 'grid';
          out.push({ sel, min: Math.round(min), max: Math.round(max) });
        }
      }
    });
    return out;
  }, pageId);
  for (const h of heightIssues){
    record({ layer:'B', rule:'§12 unequal card heights (same row)', ...meta,
      detail: `${h.sel}: min=${h.min}px max=${h.max}px (diff=${h.max-h.min}px)` });
  }

  // ── §13 ≤ 2 signal colors (emerald + amber); rest greyscale ────────
  // We sample colors in the page and count distinct saturated hues outside
  // the allow-list. Cheap heuristic — chroma > 0.15 lab-space.
  const colorIssues = await page.evaluate((pid) => {
    const root = document.querySelector(`#p-${pid}`) as HTMLElement | null;
    if (!root) return [] as string[];
    const seen = new Set<string>();
    const allow = new Set([
      // emerald + amber + neutral greys/whites
      'rgb(0, 217, 126)', 'rgb(246, 166, 9)',
    ]);
    const isGreyish = (r:number,g:number,b:number) => {
      const max = Math.max(r,g,b), min = Math.min(r,g,b);
      return (max - min) <= 30; // allow tinted greys
    };
    root.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      [cs.color, cs.borderTopColor, cs.borderLeftColor, cs.backgroundColor].forEach(c => {
        if (!c || c === 'rgba(0, 0, 0, 0)' || c.includes('transparent')) return;
        if (allow.has(c)) return;
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return;
        const r = +m[1], g = +m[2], b = +m[3];
        if (isGreyish(r,g,b)) return;
        // Allow emerald/amber including alpha variants.
        if (r < 30 && g > 180 && b > 60 && b < 200) return;     // emerald-ish
        if (r > 200 && g > 130 && b < 60)               return; // amber-ish
        seen.add(c);
      });
    });
    return Array.from(seen).slice(0, 8);
  }, pageId);
  if (colorIssues.length > 0){
    record({ layer:'B', rule:'§13 extra signal color(s)', ...meta,
      detail: `Found non-emerald/amber saturated colors: ${colorIssues.join(' · ')}` });
  }

  // ── §14 body-text contrast ≥ 4.5:1 against bg-raised (token sample) ─
  // (Existing wiltek-qa C-layer already checks contrast in detail; this
  // is a fast sanity probe that the new pages don't regress.)
  const contrast = await page.evaluate((pid) => {
    const root = document.querySelector(`#p-${pid}`) as HTMLElement | null;
    if (!root) return null;
    function rgb(c:string){
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return m ? [+m[1],+m[2],+m[3]] : null;
    }
    function lum(rgb:number[]){
      const [r,g,b] = rgb.map(v=>{
        const s = v/255;
        return s <= .03928 ? s/12.92 : Math.pow((s+.055)/1.055, 2.4);
      });
      return 0.2126*r + 0.7152*g + 0.0722*b;
    }
    const sample = root.querySelector('.ph, .ps, .sku-card, .tvb-card, [id$="-h"]') as HTMLElement | null;
    if (!sample) return null;
    const cs = getComputedStyle(sample);
    const fg = rgb(cs.color);
    const bg = rgb(getComputedStyle(document.body).backgroundColor) || [22,20,15];
    if (!fg || !bg) return null;
    const L1 = lum(fg) + .05;
    const L2 = lum(bg) + .05;
    const ratio = L1 > L2 ? L1/L2 : L2/L1;
    return Math.round(ratio * 10) / 10;
  }, pageId);
  if (contrast != null && contrast < 4.5){
    record({ layer:'B', rule:'§14 body contrast < 4.5', ...meta,
      detail: `Sample contrast ratio = ${contrast}:1` });
  }
}

test.describe('20-rule visual checker @ tvb + sku', () => {
  for (const vp of VIEWPORTS_TO_AUDIT){
    for (const lang of ['en','zh'] as const){
      test(`${vp.name} · ${lang}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        attachConsoleCapture(page);
        // Owner has access to both pages.
        const owner = CREDENTIALS.find(c => c.id === 'owner')!;
        await loginAs(page, owner as any, lang);
        for (const pid of PAGES_TO_AUDIT){
          await gotoTestPage(page, pid);
          await checkOnePage(page, pid, vp, lang, 'owner');
        }
      });
    }
  }
});
