#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Phase 0 — Supabase migration script
//
// Loads source data from the canonical Google Sheets and the production
// Vercel APIs, then upserts into the wiltek-portal Supabase database
// using the service-role key (bypasses RLS).
//
// Usage:
//   cp .env.local.example .env.local
//   # paste real keys into .env.local
//   node tools/migrate-supabase.mjs <step>
//
// Steps (run in this order; each is idempotent):
//   items       — distinct SKUs from Customer Buy + deadstock-data.js
//   customers   — distinct member codes from Customer Buy
//   sales       — every per-purchase row from Customer Buy, year >= 2023
//   inventory   — current snapshot from assets/deadstock-data.js
//   floatation  — 5 W0X Floatation Sheets
//   gtd         — gtd_tasks + gtd_kpis from prod /api/gtd
//   users       — 6 accounts (bcrypt password hashes)
//   all         — runs every step in dependency order
//
// Cutoff: sales rows where MONTH year < 2023 are dropped (per Notion).
// All inserts use UPSERT so the script is safe to re-run.
// ═══════════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';   // pure JS — works on Vercel Linux without native rebuild
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');

// Load env from .env.local (preferred, gitignored), then .env as fallback.
// We don't override real shell env vars.
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), override: false });
dotenv.config({ path: path.join(REPO_ROOT, '.env'),       override: false });

const URL = process.env.WILTEK_SUPABASE_URL;
const KEY = process.env.WILTEK_SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('❌ Missing env vars. Copy .env.local.example → .env.local and paste keys from Supabase dashboard.');
  process.exit(1);
}

const sb = createClient(URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Constants ──────────────────────────────────────────────────────────
const CUSTOMER_BUY_SHEET_ID = '1AjYt9plWymcQMeW4tIZ6A_3QdDlUB_ShreX-d4_mA8s';
const FLOATATION_SHEETS = {
  W01: '1FgXzgOUMmF8UVA9lcuBwd9nfbY2Sw_LY6GZVnNJcvRw',
  W02: '15dvmfamAhjsKP8ANllKlDhBDumNfDfx_iOlr5W48lZA',
  W03: '1syxvPHOMOtIVICVcG1ZyscOJ-Lih_rPEiYZRsPTN0y8',
  W05: '1KMUZGkfLrdkJh5-ECuzDbHRClatykFBlFIOZKqqirY8',
  W07: '1-yUL4N6UPuaUbHua0rHew3HvwqqXCvQ0cYDuMLcN-aE',
};
const ACTIVE_BRANCHES = new Set(['W01', 'W02', 'W03', 'W05', 'W07']);
const WCO_BRANCH      = 'WCO';   // Customer order / Walk-in cash desk — kept too if it appears
const CUTOFF_YEAR     = 2023;

// ── CSV parser (RFC-ish, quoted commas + thousands) ───────────────────
function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; } }
      else { cur += c; }
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}
function parseCsv(text) {
  return text.replace(/\r/g, '').split('\n').map(parseCsvLine);
}
function parseNum(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (!s || s === '-' || s === '#DIV/0!' || s === '#N/A') return 0;
  s = s.replace(/,/g, '').replace(/^RM\s*/i, '');
  const isPct = s.endsWith('%');
  if (isPct) s = s.slice(0, -1);
  const v = parseFloat(s);
  return isNaN(v) ? 0 : (isPct ? v / 100 : v);
}

// "Mar-26" → { y: 2026, m: 3 }
const MON_TO_NUM = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function parseMonthYY(label) {
  if (!label) return null;
  const m = String(label).trim().match(/^([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const mm = MON_TO_NUM[m[1].toLowerCase()];
  if (!mm) return null;
  let yy = parseInt(m[2], 10);
  if (yy < 100) yy = 2000 + yy;
  return { y: yy, m: mm };
}
function ymToFirstOfMonth(ym) {
  return `${String(ym.y).padStart(4,'0')}-${String(ym.m).padStart(2,'0')}-01`;
}
function ymToLastOfMonth(ym) {
  // Day-0 trick: day 0 of next month = last day of this month.
  const d = new Date(Date.UTC(ym.y, ym.m, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
// "7/2/2020" or "2020-07-02". Returns ISO YYYY-MM-DD or null if the
// numbers don't form a real calendar date (covers junk like "2026-15-04").
function isValidDate(y, mo, d) {
  if (y < 1900 || y > 2100) return false;
  if (mo < 1 || mo > 12)    return false;
  if (d  < 1 || d  > 31)    return false;
  // Lean on JS Date to catch month-length edge cases (Feb 30 etc.)
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
function parseEnrolDate(label) {
  if (!label) return null;
  const s = String(label).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    return isValidDate(y, mo, d) ? `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}` : null;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let mo = +m[1], d = +m[2], y = +m[3];
    if (y < 100) y = 2000 + y;
    if (isValidDate(y, mo, d)) {
      return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
    // Try DD/MM/YYYY interpretation as fallback (some Sheet rows use that order).
    if (isValidDate(y, d, mo)) {
      return `${y}-${String(d).padStart(2,'0')}-${String(mo).padStart(2,'0')}`;
    }
    return null;
  }
  return null;
}
const CT_LABEL = { N: 'Walk-in', C: 'Contractor', D: 'Interior Designer' };
function ctNorm(raw) {
  if (raw == null) return 'Other';
  const s = String(raw).trim().toUpperCase();
  return CT_LABEL[s] || 'Other';
}

// ── HTTP helpers ──────────────────────────────────────────────────────
async function fetchSheetCsv(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`sheet ${sheetId} HTTP ${r.status}`);
  const text = await r.text();
  if (text.startsWith('<')) throw new Error(`sheet ${sheetId} returned HTML (login wall?)`);
  return text;
}

async function chunkUpsert(table, rows, opts = {}) {
  const onConflict = opts.onConflict;
  const size = opts.chunkSize || 1000;
  let totalOk = 0, totalErr = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const q = sb.from(table).upsert(chunk, onConflict ? { onConflict } : {});
    const { error, count } = await q.select('*', { count: 'exact', head: true });
    if (error) {
      totalErr += chunk.length;
      console.error(`   chunk [${i}..${i + chunk.length}) FAIL: ${error.message}`);
    } else {
      totalOk += chunk.length;
      process.stdout.write(`   chunk [${i}..${i + chunk.length}) ok\r`);
    }
  }
  process.stdout.write('\n');
  return { ok: totalOk, err: totalErr };
}

// ── Source loader: Customer Buy CSV ───────────────────────────────────
async function loadCustomerBuy() {
  console.log('• fetching Customer Buy CSV…');
  const text  = await fetchSheetCsv(CUSTOMER_BUY_SHEET_ID);
  const grid  = parseCsv(text);
  if (!grid.length) throw new Error('empty CSV');
  const hdr   = grid[0].map(s => String(s||'').trim().toUpperCase());
  const idx   = {}; for (let i = 0; i < hdr.length; i++) idx[hdr[i]] = i;
  const I_MONTH = idx['MONTH']         ?? 0;
  const I_BILL  = idx['BILL']          ?? 1;
  const I_CODE  = idx['ITEM CODE']     ?? 2;
  const I_BR    = idx['BRANCHES']      ?? 3;
  const I_NAME  = idx['CUSTOMER NAME'] ?? 4;
  const I_MC    = idx['MEMBER CODE']   ?? 5;
  const I_QTY   = idx['QTY']           ?? 6;
  const I_AMT   = idx['AMT']           ?? 7;
  const I_CT    = idx['CUST TYPE']     ?? 8;
  const I_EN    = idx['DATE ENROLLED'] ?? 9;
  const I_LOY   = idx['LOYALTY']       ?? 10;
  const I_MAIN  = idx['MAIN GROUP']    ?? 11;
  const I_SUB   = idx['SUB GROUP']     ?? idx['SUB-GROUP'] ?? idx['SUB_GROUP'] ?? 12;
  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]; if (!r || !r.length) continue;
    const ym = parseMonthYY(r[I_MONTH]); if (!ym) continue;
    if (ym.y < CUTOFF_YEAR) continue;          // 2022 and earlier dropped
    const code = String(r[I_CODE] || '').trim(); if (!code) continue;
    const branch = String(r[I_BR] || '').trim();
    rows.push({
      ym, branch,
      bill: String(r[I_BILL] || '').trim(),
      code,
      name: String(r[I_NAME] || '').trim(),
      mc: String(r[I_MC] || '').trim(),
      qty: parseNum(r[I_QTY]),
      amt: parseNum(r[I_AMT]),
      ct: ctNorm(r[I_CT]),
      enrol: parseEnrolDate(r[I_EN]),
      loy: String(r[I_LOY] || '').trim(),
      main: String(r[I_MAIN] || '').trim() || null,
      sub:  String(r[I_SUB] || '').trim() || null,
    });
  }
  console.log(`  → ${rows.length} rows from CSV (year >= ${CUTOFF_YEAR}).`);
  return rows;
}

// ── Source loader: deadstock-data.js (current snapshot) ───────────────
function loadDeadstockJs() {
  const file = path.join(REPO_ROOT, 'assets', 'deadstock-data.js');
  const txt  = fs.readFileSync(file, 'utf8');
  // The file shape is `window.WP_DEADSTOCK = { ... };`. Strip the assignment.
  const m = txt.match(/window\.WP_DEADSTOCK\s*=\s*([\s\S]*?);\s*$/);
  if (!m) throw new Error('cannot find WP_DEADSTOCK assignment');
  // eslint-disable-next-line no-eval
  const obj = eval('(' + m[1] + ')');
  return obj;
}

// ════════════════════════════════════════════════════════════════════════
// STEP: items
// ════════════════════════════════════════════════════════════════════════
async function items() {
  console.log('▶ items …');
  const buy = await loadCustomerBuy();
  const ds  = loadDeadstockJs();

  // Master per item_code.
  const map = new Map();
  // Customer Buy first (latest POS truth for main_group/sub_group).
  for (const r of buy) {
    if (!r.code) continue;
    if (!map.has(r.code)) map.set(r.code, { item_code: r.code, source: 'migrated' });
    const it = map.get(r.code);
    if (r.main && !it.main_group) it.main_group = r.main;
    if (r.sub  && !it.sub_group)  it.sub_group  = r.sub;
  }
  // Augment with deadstock-data.js for brand / category fallback.
  for (const row of (ds.rows || [])) {
    const code = row.code; if (!code) continue;
    if (!map.has(code)) map.set(code, { item_code: code, source: 'migrated' });
    const it = map.get(code);
    if (row.brand    && !it.brand)      it.brand      = row.brand;
    if (row.category && !it.main_group) it.main_group = row.category;
    if (row.sub      && !it.sub_group)  it.sub_group  = row.sub;
  }
  const all = [...map.values()];
  console.log(`  → ${all.length} distinct items prepared`);

  const res = await chunkUpsert('items', all, { onConflict: 'item_code' });
  console.log(`  → upsert ok=${res.ok} err=${res.err}`);
  const { count } = await sb.from('items').select('*', { count: 'exact', head: true });
  console.log(`✔ items table now has ${count} rows`);
}

// ════════════════════════════════════════════════════════════════════════
// STEP: customers
// ════════════════════════════════════════════════════════════════════════
async function customers() {
  console.log('▶ customers …');
  const buy = await loadCustomerBuy();
  // Group by member_code → derive name / type / primary_store / enrol_date.
  const m = new Map();
  for (const r of buy) {
    if (!r.mc) continue;
    let d = m.get(r.mc);
    if (!d) {
      d = { customer_id: r.mc, name: '', type: '', primary_store: '', enrol_date: null, byBranch: {} };
      m.set(r.mc, d);
    }
    if (r.name && !d.name) d.name = r.name;
    if (r.ct && r.ct !== 'Other' && !d.type) d.type = r.ct;
    if (r.enrol && (!d.enrol_date || r.enrol < d.enrol_date)) d.enrol_date = r.enrol;
    if (r.branch) d.byBranch[r.branch] = (d.byBranch[r.branch] || 0) + (r.amt || 0);
  }
  // Decide primary_store = max-amount branch (active branches preferred).
  for (const d of m.values()) {
    let best = null, bestAmt = -1;
    for (const [b, a] of Object.entries(d.byBranch)) {
      const score = (ACTIVE_BRANCHES.has(b) ? 1e12 : 0) + a;
      if (score > bestAmt) { bestAmt = score; best = b; }
    }
    d.primary_store = best || null;
    delete d.byBranch;
    if (!d.name) d.name = d.customer_id;   // NOT NULL on customers.name
    if (!d.type) d.type = 'Other';
  }
  const all = [...m.values()];
  console.log(`  → ${all.length} distinct customers prepared`);

  const res = await chunkUpsert('customers', all, { onConflict: 'customer_id' });
  console.log(`  → upsert ok=${res.ok} err=${res.err}`);
  const { count } = await sb.from('customers').select('*', { count: 'exact', head: true });
  console.log(`✔ customers table now has ${count} rows`);
}

// ════════════════════════════════════════════════════════════════════════
// STEP: sales
// ════════════════════════════════════════════════════════════════════════
async function sales() {
  console.log('▶ sales …');
  const buy = await loadCustomerBuy();

  // Items + customers must already exist (FK). Pull existing IDs to avoid
  // FK-violation chunk failures from rows referencing yet-unmigrated keys.
  console.log('• loading existing item_codes + customer_ids for FK guard…');
  const existingItems = new Set();
  {
    let from = 0; const step = 1000;
    while (true) {
      const { data, error } = await sb.from('items').select('item_code').range(from, from + step - 1);
      if (error) throw error;
      data.forEach(r => existingItems.add(r.item_code));
      if (data.length < step) break;
      from += step;
    }
  }
  const existingCustomers = new Set();
  {
    let from = 0; const step = 1000;
    while (true) {
      const { data, error } = await sb.from('customers').select('customer_id').range(from, from + step - 1);
      if (error) throw error;
      data.forEach(r => existingCustomers.add(r.customer_id));
      if (data.length < step) break;
      from += step;
    }
  }
  console.log(`  → ${existingItems.size} items / ${existingCustomers.size} customers known`);

  let kept = 0, droppedNoItem = 0, droppedBadAmt = 0;
  const rows = [];
  for (const r of buy) {
    if (!existingItems.has(r.code)) { droppedNoItem++; continue; }
    if (!r.amt) { droppedBadAmt++; continue; }
    const cid = r.mc && existingCustomers.has(r.mc) ? r.mc : null;
    rows.push({
      sale_date:  ymToFirstOfMonth(r.ym),
      store:      r.branch || 'WCO',
      item_code:  r.code,
      qty:        r.qty,
      unit_price: r.qty > 0 ? +(r.amt / r.qty).toFixed(2) : null,
      amount:     r.amt,
      customer_id: cid,
      invoice_no: r.bill || null,
      source:     'migrated',
    });
    kept++;
  }
  console.log(`  → ${kept} sales rows ready · ${droppedNoItem} dropped (no item) · ${droppedBadAmt} dropped (zero amt)`);

  // sales has no UNIQUE index for upsert; use plain insert. To keep idempotent,
  // skip if table already has rows (re-run starts over manually).
  const { count: existingSalesCount } = await sb.from('sales').select('*', { count: 'exact', head: true });
  if (existingSalesCount > 0) {
    console.log(`! sales table already has ${existingSalesCount} rows. To re-run, TRUNCATE sales first via Studio. Skipping insert.`);
    return;
  }
  const res = await chunkUpsert('sales', rows, { chunkSize: 1000 });
  console.log(`  → insert ok=${res.ok} err=${res.err}`);
  const { count } = await sb.from('sales').select('*', { count: 'exact', head: true });
  console.log(`✔ sales table now has ${count} rows`);
}

// ════════════════════════════════════════════════════════════════════════
// STEP: inventory_snapshots — one row per (snapshot_date, store, item_code)
// ════════════════════════════════════════════════════════════════════════
async function inventory() {
  console.log('▶ inventory_snapshots …');
  const ds = loadDeadstockJs();
  const snapshotYm = (ds.meta && ds.meta.snapshot) || '';
  if (!/^\d{4}-\d{2}$/.test(snapshotYm)) throw new Error('cannot read snapshot YM from deadstock-data.js');
  const [yy, mm] = snapshotYm.split('-').map(Number);
  const snapshotDate = ymToLastOfMonth({ y: yy, m: mm });
  console.log(`  → snapshot date = ${snapshotDate}`);

  // Items must already be in the items table (FK guard).
  const existingItems = new Set();
  let from = 0; const step = 1000;
  while (true) {
    const { data, error } = await sb.from('items').select('item_code').range(from, from + step - 1);
    if (error) throw error;
    data.forEach(r => existingItems.add(r.item_code));
    if (data.length < step) break;
    from += step;
  }

  const rows = [];
  let dropped = 0;
  for (const r of (ds.rows || [])) {
    if (!r.code || !r.branch) continue;
    if (!existingItems.has(r.code)) { dropped++; continue; }
    rows.push({
      snapshot_date: snapshotDate,
      store: r.branch,
      item_code: r.code,
      qty: r.qty || 0,
      cost: r.unit_cost || null,
      amount: r.amount || (r.qty * (r.unit_cost || 0)) || 0,
    });
  }
  console.log(`  → ${rows.length} inventory rows · ${dropped} dropped (item not in items table)`);

  const res = await chunkUpsert('inventory_snapshots', rows, { onConflict: 'snapshot_date,store,item_code' });
  console.log(`  → upsert ok=${res.ok} err=${res.err}`);
  const { count } = await sb.from('inventory_snapshots').select('*', { count: 'exact', head: true });
  console.log(`✔ inventory_snapshots table now has ${count} rows`);
}

// ════════════════════════════════════════════════════════════════════════
// STEP: floatation — fetch 5 W0X sheets → one row per (month-end, store)
// ════════════════════════════════════════════════════════════════════════
async function floatation() {
  console.log('▶ floatation …');
  const RACES = ['Chinese', 'Malay', 'India', 'Others'];
  const all = [];
  for (const [branch, sheetId] of Object.entries(FLOATATION_SHEETS)) {
    process.stdout.write(`  • ${branch} … `);
    const text = await fetchSheetCsv(sheetId);
    const grid = parseCsv(text);
    if (!grid.length) { process.stdout.write('empty\n'); continue; }
    // Row 0: ,,All,Jan,Feb,Mar,...
    const hdr = grid[0].map(s => String(s || '').trim());
    // Find month columns by position: col 2 = "All", cols 3..14 = Jan..Dec
    const monthCols = [];
    for (let i = 0; i < hdr.length; i++) {
      const lab = hdr[i].toLowerCase();
      if (Object.keys(MON_TO_NUM).includes(lab.slice(0, 3))) monthCols.push({ idx: i, m: MON_TO_NUM[lab.slice(0, 3)] });
    }
    if (monthCols.length === 0) { process.stdout.write('no month cols\n'); continue; }

    // Year inferred from sheet content; the 5 sheets are 2026 (per file naming).
    const year = 2026;

    // Walk-in rows: row label "Walk-in" at column 1. Aggregated (col 0 = race).
    // We accumulate per-month by race + closing rate from the All row.
    // Pattern: row groups of 5 metrics per race: walkin, purchase, amount, basket, closing rate
    const rowMetrics = ['walkin', 'purchase', 'amount', 'basket', 'cr'];
    const byRace = {};      // race → { walkin: [12], purchase: [12], cr: [12] }
    let curRace = null;
    let metricIdx = 0;
    for (let i = 1; i < grid.length; i++) {
      const row = grid[i]; if (!row) continue;
      const c0 = String(row[0] || '').trim();
      const c1 = String(row[1] || '').trim();
      if (c0) curRace = c0;        // race label appears once on row 1
      if (!curRace) continue;
      // Match metric label in c1 (case-insensitive).
      const lc = c1.toLowerCase();
      let metric = null;
      if (lc.includes('walk-in') || lc === 'walk in') metric = 'walkin';
      else if (lc.includes('purchase'))               metric = 'purchase';
      else if (lc === 'amount')                       metric = 'amount';
      else if (lc.includes('basket'))                 metric = 'basket';
      else if (lc.includes('closing'))                metric = 'cr';
      if (!metric) continue;
      if (!byRace[curRace]) byRace[curRace] = {};
      byRace[curRace][metric] = monthCols.map(({ idx }) => parseNum(row[idx]));
    }

    // Build per-month rows for this branch.
    for (const { m } of monthCols) {
      // Prefer "All" race as the totals; fall back to summing other races.
      const all_   = byRace['All']     || {};
      const chRow  = byRace['Chinese'] || {};
      const myRow  = byRace['Malay']   || {};
      const inRow  = byRace['India']   || byRace['Indian'] || {};
      const oRow   = byRace['Others']  || {};
      const mIdx   = monthCols.findIndex(x => x.m === m);

      // walk_in_* + closed_count are INTEGER columns — round defensively
      // because a few sheet cells store decimals (rare typos / stale formulas).
      const walk_in_total   = all_.walkin    ? Math.round(all_.walkin[mIdx])    : 0;
      const closed_count    = all_.purchase  ? Math.round(all_.purchase[mIdx])  : 0;
      const closing_rate    = all_.cr        ? +(all_.cr[mIdx] * 100).toFixed(2) : 0;
      const amount_total    = all_.amount    ? Math.round(all_.amount[mIdx]   * 100) / 100 : 0;
      const basket_total    = all_.basket    ? Math.round(all_.basket[mIdx]   * 100) / 100 : 0;

      // Per-race purchase / amount breakdown (walk-in already in flat columns).
      const racePack = (rowMap, field) => rowMap?.[field] ? rowMap[field][mIdx] : null;
      const by_race = {
        chinese: { purchase: Math.round(racePack(chRow, 'purchase') || 0),
                   amount:   +(racePack(chRow, 'amount')   || 0).toFixed(2) },
        malay:   { purchase: Math.round(racePack(myRow, 'purchase') || 0),
                   amount:   +(racePack(myRow, 'amount')   || 0).toFixed(2) },
        indian:  { purchase: Math.round(racePack(inRow, 'purchase') || 0),
                   amount:   +(racePack(inRow, 'amount')   || 0).toFixed(2) },
        others:  { purchase: Math.round(racePack(oRow,  'purchase') || 0),
                   amount:   +(racePack(oRow,  'amount')   || 0).toFixed(2) },
      };

      // Skip empty months (year not yet started or no data).
      if (!walk_in_total && !closed_count) continue;

      all.push({
        date:            ymToLastOfMonth({ y: year, m }),
        store:           branch,
        walk_in_total,
        walk_in_chinese: chRow.walkin ? Math.round(chRow.walkin[mIdx]) : null,
        walk_in_malay:   myRow.walkin ? Math.round(myRow.walkin[mIdx]) : null,
        walk_in_indian:  inRow.walkin ? Math.round(inRow.walkin[mIdx]) : null,
        walk_in_other:   oRow.walkin  ? Math.round(oRow.walkin[mIdx])  : null,
        closed_count,
        closing_rate,
        amount_total,
        basket_total,
        by_race,
        updated_by:      'migration',
      });
    }
    process.stdout.write(`${all.filter(x => x.store === branch).length} months\n`);
  }
  console.log(`  → ${all.length} floatation rows prepared`);
  const res = await chunkUpsert('floatation', all, { onConflict: 'date,store' });
  console.log(`  → upsert ok=${res.ok} err=${res.err}`);
  const { count } = await sb.from('floatation').select('*', { count: 'exact', head: true });
  console.log(`✔ floatation table now has ${count} rows`);
}

// ════════════════════════════════════════════════════════════════════════
// STEP: gtd_tasks + gtd_kpis — fetch from prod /api/gtd
// ════════════════════════════════════════════════════════════════════════
async function gtd() {
  console.log('▶ gtd_tasks + gtd_kpis …');
  const r = await fetch('https://wiltek-dashboard.vercel.app/api/gtd?t=' + Date.now(), { cache: 'no-store' });
  const j = await r.json();
  if (!j || !j.ok) throw new Error('GTD fetch failed: ' + (j && j.reason));
  const store = j.store || {};
  // Keys: <branch>::task::<id>::<monthIdx>  /  <branch>::kpi::<id>::<monthIdx>  /
  //       <branch>::target::<kpi_id>  /  <branch>::target_month::<kpi_id>::<monthIdx>
  const tasks = [];
  const kpisActual = new Map();   // (store, ym, kpi_name) → actual
  const kpisTarget = new Map();   // (store, ym, kpi_name) → target
  for (const [k, v] of Object.entries(store)) {
    const parts = k.split('::');
    if (parts.length < 3) continue;
    const [branch, kind, ...rest] = parts;
    if (kind === 'task') {
      const [taskId, monthIdxRaw] = [rest[0], rest[1]];
      const monthIdx = parseInt(monthIdxRaw, 10);
      const ym = `2026-${String(monthIdx + 1).padStart(2, '0')}`;
      tasks.push({
        store: branch,
        year_month: ym,
        task_name: taskId,
        status: String(v).toLowerCase(),
        updated_by: 'migration',
      });
    } else if (kind === 'kpi') {
      const [kpiId, monthIdxRaw] = [rest[0], rest[1]];
      const monthIdx = parseInt(monthIdxRaw, 10);
      const ym = `2026-${String(monthIdx + 1).padStart(2, '0')}`;
      kpisActual.set(`${branch}|${ym}|${kpiId}`, parseFloat(v));
    } else if (kind === 'target') {
      // Per-branch global default (no month).
      const kpiId = rest[0];
      kpisTarget.set(`${branch}|*|${kpiId}`, parseFloat(v));
    } else if (kind === 'target_month') {
      const [kpiId, monthIdxRaw] = [rest[0], rest[1]];
      const monthIdx = parseInt(monthIdxRaw, 10);
      const ym = `2026-${String(monthIdx + 1).padStart(2, '0')}`;
      kpisTarget.set(`${branch}|${ym}|${kpiId}`, parseFloat(v));
    }
  }
  // Combine actual + target into gtd_kpis rows.
  const kpiRows = [];
  const allKpiKeys = new Set([...kpisActual.keys(), ...kpisTarget.keys()]);
  for (const key of allKpiKeys) {
    const [branch, ym, kpiId] = key.split('|');
    if (ym === '*') continue;   // global-default targets handled below
    const actual = kpisActual.get(key);
    const target = kpisTarget.get(key) ?? kpisTarget.get(`${branch}|*|${kpiId}`);
    kpiRows.push({
      store: branch, year_month: ym, kpi_name: kpiId,
      actual: isNaN(actual) ? null : actual,
      target: isNaN(target) ? null : target,
      reverse_better: kpiId === 'discon_pct',
      updated_by: 'migration',
    });
  }
  console.log(`  → ${tasks.length} task rows · ${kpiRows.length} kpi rows`);
  const t = await chunkUpsert('gtd_tasks', tasks, { onConflict: 'store,year_month,task_name' });
  const k = await chunkUpsert('gtd_kpis',  kpiRows, { onConflict: 'store,year_month,kpi_name' });
  console.log(`  → tasks ok=${t.ok}/err=${t.err} · kpis ok=${k.ok}/err=${k.err}`);
}

// ════════════════════════════════════════════════════════════════════════
// STEP: users — 6 hardcoded accounts, bcrypt password hashes
// ════════════════════════════════════════════════════════════════════════
async function users() {
  console.log('▶ users …');
  // Phase 0 plaintext passwords from users.js comments. Phase 2 will rotate.
  const accounts = [
    { username: 'owner',   role: 'owner',   store: null,  display_name: 'Jym Chee',                    pw: 'Owner@2026' },
    { username: 'w01_mgr', role: 'manager', store: 'W01', display_name: 'W01 Manager (Pandan Indah)',  pw: 'W01@2026' },
    { username: 'w02_mgr', role: 'manager', store: 'W02', display_name: 'W02 Manager (Ampang Waterfront)', pw: 'W02@2026' },
    { username: 'w03_mgr', role: 'manager', store: 'W03', display_name: 'W03 Manager (Wangsa Maju)',   pw: 'W03@2026' },
    { username: 'w05_mgr', role: 'manager', store: 'W05', display_name: 'W05 Manager (Bangi Seksyen 7)', pw: 'W05@2026' },
    { username: 'w07_mgr', role: 'manager', store: 'W07', display_name: 'W07 Manager (Pandan Jaya)',   pw: 'W07@2026' },
  ];
  const rows = [];
  for (const a of accounts) {
    const password_hash = await bcrypt.hash(a.pw, 12);
    rows.push({
      username: a.username,
      password_hash,
      role: a.role,
      store: a.store,
      display_name: a.display_name,
      is_active: true,
    });
  }
  // Upsert by username.
  const res = await chunkUpsert('users', rows, { onConflict: 'username' });
  console.log(`  → upsert ok=${res.ok} err=${res.err}`);
  const { count } = await sb.from('users').select('*', { count: 'exact', head: true });
  console.log(`✔ users table now has ${count} rows`);
}

// ── CLI ───────────────────────────────────────────────────────────────
const cmds = { items, customers, sales, inventory, floatation, gtd, users };
async function all() {
  for (const k of ['items', 'customers', 'sales', 'inventory', 'floatation', 'gtd', 'users']) {
    await cmds[k]();
  }
}
const CMD = process.argv[2];
if (!CMD) {
  console.error('Usage: node tools/migrate-supabase.mjs <items|customers|sales|inventory|floatation|gtd|users|all>');
  process.exit(1);
}
const fn = CMD === 'all' ? all : cmds[CMD];
if (!fn) {
  console.error(`Unknown step: ${CMD}`);
  process.exit(1);
}
try {
  await fn();
} catch (e) {
  console.error('❌ migration step failed:', e);
  process.exit(2);
}
