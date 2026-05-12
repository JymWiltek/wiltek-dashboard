// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Phase 2 Sprint 1 — /api/sync
//
// Owner-only sync endpoint. Two modes:
//   POST /api/sync  { mode: 'preview' }
//     → For each source sheet, returns:
//         { source, target_table, latest_ym_in_sheet, sheet_rows,
//           latest_ym_in_db, db_rows_for_that_ym, action: 'append' | 'conflict' | 'noop',
//           preview_rows_to_add: N }
//   POST /api/sync  { mode: 'apply', confirm_overwrite: { sales: false, ... } }
//     → Acquires advisory lock, backs up affected tables, applies inserts,
//       writes sync_log + backups_manifest. Returns full result.
//
// Checkpoint 1 scope: 3 sources from 1 Sheet:
//   1. Customer Buy V3 → sales (append month; conflict prompts overwrite)
//      Sheet ID: 1AjYt9plWymcQMeW4tIZ6A_3QdDlUB_ShreX-d4_mA8s
//   2. SALES VS STOCK / 'Raw CS' tab → inventory_snapshots (append snapshot_date)
//      Sheet ID: 1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II
//   3. SALES VS STOCK / 'SM' tab → items (UPSERT all rows; POS-owned fields
//      only — strategic_push / description_zh / notes are NEVER overwritten)
//
// Note on sales source (Customer Buy V3 not Raw Sales): Phase 0 imported
// from CBv3 because it had per-line granularity (Bill / Customer / etc.).
// Checkpoint 2 will split: keep CBv3 → new customer_buy_lines + use
// "Raw sale" tab for the aggregate sales table. For CP1 we keep CBv3
// to avoid breaking the existing 60,410 row dataset shape.
//
// Safety:
//   - Advisory lock prevents concurrent syncs (DB-side, cross-instance).
//   - Pre-write backup of every affected table → backups schema, indexed
//     by backups_manifest. Backups retained indefinitely.
//   - Owner only. Manager / no-session → 401/403.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const URL = process.env.WILTEK_SUPABASE_URL;
const KEY = process.env.WILTEK_SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
function sb() {
  if (supabase) return supabase;
  if (!URL || !KEY) throw new Error('Supabase env vars missing');
  supabase = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return supabase;
}

// ── Notion-authoritative sheet IDs / tabs ─────────────────────────────
// CBv3 feeds BOTH sales (CP1, aggregate) AND customer_buy_lines (CP2,
// per-member-line). One fetch, two transforms.
const SHEETS = {
  customer_buy_v3:    { id: '1AjYt9plWymcQMeW4tIZ6A_3QdDlUB_ShreX-d4_mA8s', tab: null,        target: ['sales','customer_buy_lines'] },
  raw_cs:             { id: '1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II', tab: 'Raw CS',   target: 'inventory_snapshots' },
  sm_item_master:     { id: '1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II', tab: 'SM',       target: 'items' },
  po_grn_raw_pivot:   { id: '1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II', tab: 'Raw Pivot',target: 'po_grn' },
};
const ACTIVE_BRANCHES = new Set(['W01','W02','W03','W05','W07']);

// CP2 Step 2: 6 Floatation Sheets (W11 INCLUDED — historical preserved
// per Jym's hard rule; UI hides W11, code never if-skips it).
const FLOATATION_SHEETS = [
  { id: '1FgXzgOUMmF8UVA9lcuBwd9nfbY2Sw_LY6GZVnNJcvRw', store: 'W01' },
  { id: '15dvmfamAhjsKP8ANllKlDhBDumNfDfx_iOlr5W48lZA', store: 'W02' },
  { id: '1syxvPHOMOtIVICVcG1ZyscOJ-Lih_rPEiYZRsPTN0y8', store: 'W03' },
  { id: '1KMUZGkfLrdkJh5-ECuzDbHRClatykFBlFIOZKqqirY8', store: 'W05' },
  { id: '1-yUL4N6UPuaUbHua0rHew3HvwqqXCvQ0cYDuMLcN-aE', store: 'W07' },
  { id: '19oXG7KCWPNukt2HK-zkM9j-Kwuyjc5SESuweooYRzLs', store: 'W11' },
];
const FLOATATION_YEAR = 2026;   // current year — sheets are one per year

// CP2: customer_buy_lines / customers UPSERT side-effect when CBL applies.
// floatation source feeds the floatation table (6 stores, monthly aggregate).
const ALL_TARGETS = ['sales','inventory_snapshots','items','customer_buy_lines','floatation','po_grn','financial'];

// CP3: Apps Script endpoint (already-parsed FMM data via WTK_APPS_SCRIPT_URL).
const APPS_SCRIPT_URL = process.env.WTK_APPS_SCRIPT_URL;
const APPS_SCRIPT_KEY = process.env.WTK_API_KEY;

// ── Session lookup ────────────────────────────────────────────────────
async function loadSessionUser(username) {
  if (!username) return null;
  const { data, error } = await sb().from('users')
    .select('username, role, is_active')
    .eq('username', username).maybeSingle();
  if (error || !data || !data.is_active) return null;
  return data;
}

// ── CSV helpers ───────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { out.push(cur); cur=''; } else cur += c; }
  }
  out.push(cur); return out;
}
function parseCsv(text) { return text.replace(/\r/g,'').split('\n').filter(l => l.length).map(parseCsvLine); }
function parseNum(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (!s || s === '-' || s === '#N/A' || s === '#DIV/0!') return 0;
  s = s.replace(/,/g, '');
  const v = parseFloat(s); return isNaN(v) ? 0 : v;
}
const MON_TO_NUM = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
function parseMonthYY(label) {
  if (!label) return null;
  const m = String(label).trim().match(/^([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const mm = MON_TO_NUM[m[1].toLowerCase()]; if (!mm) return null;
  let yy = parseInt(m[2], 10); if (yy < 100) yy = 2000 + yy;
  return { y: yy, m: mm };
}
function ymToFirstOfMonth(ym) {
  return `${String(ym.y).padStart(4,'0')}-${String(ym.m).padStart(2,'0')}-01`;
}
function ymToLastOfMonth(ym) {
  const d = new Date(Date.UTC(ym.y, ym.m, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function nowSuffix() {
  const d = new Date();
  return d.getUTCFullYear() + '_'
       + String(d.getUTCMonth()+1).padStart(2,'0') + '_'
       + String(d.getUTCDate()).padStart(2,'0') + '_'
       + String(d.getUTCHours()).padStart(2,'0')
       + String(d.getUTCMinutes()).padStart(2,'0');
}

async function fetchSheetCsv(sheetId, tab) {
  const url = tab
    ? `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`
    : `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`sheet ${sheetId}${tab?'/'+tab:''} HTTP ${r.status}`);
  const text = await r.text();
  if (text.startsWith('<')) throw new Error(`sheet ${sheetId}${tab?'/'+tab:''} HTML (login wall?)`);
  return text;
}

// ── Source parsers (each returns rows + meta for incremental detection) ─

// CBv3 Date Enrolled is M/D/YYYY (US locale, Wiltek POS export quirk).
function parseMdyDate(s) {
  // CBv3 export is inconsistent: some rows M/D/YYYY, others D/M/YYYY.
  // Bound-detect: if first part > 12 it MUST be a day; if second part > 12
  // it MUST be a month. Default to M/D/Y (Wiltek POS US-locale convention)
  // when ambiguous. Returns null for invalid dates so Postgres won't 22008.
  if (!s) return null;
  s = String(s).trim(); if (!s || s === '-') return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const a = +m[1], b = +m[2];
    let y = +m[3]; if (y < 100) y = 2000 + y;
    let mon, day;
    if      (a > 12 && b <= 12) { day = a; mon = b; }   // unambiguous D/M/Y
    else if (b > 12 && a <= 12) { mon = a; day = b; }   // unambiguous M/D/Y
    else                         { mon = a; day = b; }   // ambiguous → M/D/Y default
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return `${y}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const mon = +m[2], day = +m[3];
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return `${m[1]}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  return null;
}

// Read CBv3 once, derive two row shapes:
//   - sales:           CP1-compatible (sale_date, store, item_code, qty,
//                      amount, customer_id, invoice_no, source).
//   - customer_buy_lines (CP2): per-line member purchases. Walk-in rows
//                      (no member_code) dropped at parse time and counted.
async function loadCbv3() {
  const text = await fetchSheetCsv(SHEETS.customer_buy_v3.id, null);
  const grid = parseCsv(text);
  const empty = {
    sales: { rows: [], latest_ym: null, total_rows: 0 },
    cbl:   { rows: [], latest_ym: null, total_rows: 0, dropped_no_member: 0, dropped_no_bill_or_branch: 0 },
  };
  if (!grid.length) return empty;
  const hdr = grid[0].map(s => String(s||'').trim().toUpperCase());
  const idx = {}; for (let i = 0; i < hdr.length; i++) idx[hdr[i]] = i;
  const I = {
    MONTH:  idx['MONTH']          ?? 0,
    BILL:   idx['BILL']           ?? 1,
    CODE:   idx['ITEM CODE']      ?? 2,
    BR:     idx['BRANCHES']       ?? 3,
    CNAME:  idx['CUSTOMER NAME']  ?? 4,
    MC:     idx['MEMBER CODE']    ?? 5,
    QTY:    idx['QTY']            ?? 6,
    AMT:    idx['AMT']            ?? 7,
    CTYPE:  idx['CUST TYPE']      ?? null,
    ENROL:  idx['DATE ENROLLED']  ?? idx['DATE ENROL'] ?? null,
    MAIN:   idx['MAIN GROUP']     ?? null,
    SUB:    idx['SUB GROUP']      ?? null,
  };
  const salesRows = [];
  const cblRows   = [];
  let dropped_no_member = 0, dropped_no_bill_or_branch = 0;
  let latestYmKey = -Infinity;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]; if (!r) continue;
    const ym = parseMonthYY(r[I.MONTH]); if (!ym) continue;
    if (ym.y < 2023) continue;
    const code = String(r[I.CODE] || '').trim(); if (!code) continue;
    const branch = String(r[I.BR] || '').trim();
    const amt = parseNum(r[I.AMT]);
    if (!amt) continue;

    const ymStr = `${String(ym.y).padStart(4,'0')}-${String(ym.m).padStart(2,'0')}`;
    const ymKey = ym.y * 12 + ym.m;
    if (ymKey > latestYmKey) latestYmKey = ymKey;
    const mc   = String(r[I.MC]||'').trim();
    const bill = String(r[I.BILL]||'').trim();

    // SALES shape (CP1-compat, walk-in customer_id may be null)
    salesRows.push({
      sale_date:  ymToFirstOfMonth(ym),
      store:      branch || 'WCO',
      item_code:  code,
      qty:        parseNum(r[I.QTY]),
      unit_price: null,
      amount:     amt,
      customer_id: mc || null,
      invoice_no: bill || null,
      source:     'sync_cbv3',
    });

    // CBL shape (CP2, member rows only — Jym's anomaly rule rejects NULL mc).
    if (!mc)           { dropped_no_member += 1; continue; }
    if (!bill||!branch){ dropped_no_bill_or_branch += 1; continue; }
    cblRows.push({
      year_month:    ymStr,
      bill_no:       bill,
      item_code:     code,
      branch,
      customer_name: String(r[I.CNAME]||'').trim() || null,
      member_code:   mc,
      qty:           parseNum(r[I.QTY]),
      amt,
      cust_type:     I.CTYPE != null ? (String(r[I.CTYPE]||'').trim() || null) : null,
      date_enrol:    I.ENROL != null ? parseMdyDate(r[I.ENROL]) : null,
      main_group:    I.MAIN  != null ? (String(r[I.MAIN]||'').trim()  || null) : null,
      sub_group:     I.SUB   != null ? (String(r[I.SUB] ||'').trim()  || null) : null,
    });
  }
  const latest_ym = latestYmKey > 0
    ? `${Math.floor((latestYmKey-1)/12)}-${String(((latestYmKey-1)%12)+1).padStart(2,'0')}`
    : null;
  return {
    sales: { rows: salesRows, latest_ym, total_rows: salesRows.length },
    cbl:   {
      rows: cblRows, latest_ym, total_rows: cblRows.length,
      dropped_no_member, dropped_no_bill_or_branch,
    },
  };
}

async function loadRawCs() {
  const text = await fetchSheetCsv(SHEETS.raw_cs.id, SHEETS.raw_cs.tab);
  const grid = parseCsv(text);
  if (!grid.length) return { rows: [], snapshot_date: null };
  const hdr = grid[0].map(s => String(s||'').trim().toUpperCase());
  const idx = {}; for (let i = 0; i < hdr.length; i++) idx[hdr[i]] = i;

  // Sprint 4 fix: Raw CS Sheet now has an unlabelled STATUS column between
  // BRANCH and QTY (header keeps old 5 names but data has 6 cols). Without
  // this shift detection, qty was loading "N"/"D"/"F" status letters and
  // parseNum returned 0 → 2026-04-30 snap had all qty=0.
  //
  // Detection: try parseNum on the first data row's "QTY"-positioned cell.
  // If non-numeric → status column is there → shift QTY/UC/AMT one to the right.
  const probeRow  = grid[1] || [];
  const baseQty   = idx['QTY']       ?? 2;
  const baseUc    = idx['UNIT COST'] ?? 3;
  const baseAmt   = idx['ON HAND']   ?? idx['AMOUNT'] ?? 4;
  const probeVal  = probeRow[baseQty];
  const probeNumeric = probeVal != null && probeVal !== '' &&
                       !isNaN(parseFloat(String(probeVal).trim()));
  const shift     = probeNumeric ? 0 : 1;
  const I = {
    CODE: idx['STOCK CODE'] ?? idx['ITEM CODE'] ?? 0,
    BR:   idx['BRANCH']     ?? idx['BRANCHES'] ?? 1,
    QTY:  baseQty + shift,
    UC:   baseUc  + shift,
    AMT:  baseAmt + shift,
    shift_detected: shift,
  };

  const today = new Date();
  const prev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  const snapshot_date = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth()+1).padStart(2,'0')}-${String(prev.getUTCDate()).padStart(2,'0')}`;
  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]; if (!r) continue;
    const code = String(r[I.CODE] || '').trim(); if (!code) continue;
    const br = String(r[I.BR] || '').trim();
    rows.push({
      snapshot_date,
      store:     br,
      item_code: code,
      qty:       parseNum(r[I.QTY]),
      cost:      parseNum(r[I.UC]) || null,
      amount:    parseNum(r[I.AMT]),
    });
  }
  return { rows, snapshot_date, total_rows: rows.length, column_shift_detected: shift };
}

// ── Floatation: Sheet 1 (yearly summary, one row per month) ──────────
// Logic mirrors tools/migrate-supabase.mjs floatation() so monthly
// outputs are byte-compatible with the 25 Phase 0 rows.
async function loadFloatationOne(sheetId, store) {
  let text;
  try { text = await fetchSheetCsv(sheetId, null); }
  catch (e) { return { store, rows: [], latest_ym: null, error: e.message }; }
  const grid = parseCsv(text);
  if (!grid.length) return { store, rows: [], latest_ym: null };

  // Row 0: ",",All,Jan,Feb,...,Dec  →  pick month columns by 3-letter prefix.
  const hdr = grid[0].map(s => String(s || '').trim());
  const monthCols = [];
  for (let i = 0; i < hdr.length; i++) {
    const lab = hdr[i].toLowerCase();
    const mm  = MON_TO_NUM[lab.slice(0, 3)];
    if (mm) monthCols.push({ idx: i, m: mm });
  }
  if (!monthCols.length) return { store, rows: [], latest_ym: null };

  // byRace[<label>] = { walkin: [12], purchase: [12], amount: [12], basket: [12], cr: [12] }
  const byRace = {};
  let curRace = null;
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i]; if (!row) continue;
    const c0 = String(row[0] || '').trim();
    const c1 = String(row[1] || '').trim();
    if (c0) curRace = c0;
    if (!curRace) continue;
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

  const rows = [];
  let latestKey = -Infinity;
  for (const { m } of monthCols) {
    const mIdx  = monthCols.findIndex(x => x.m === m);
    const all_  = byRace['All']     || {};
    const chRow = byRace['Chinese'] || {};
    const myRow = byRace['Malay']   || {};
    const inRow = byRace['India']   || byRace['Indian'] || {};
    const oRow  = byRace['Others']  || {};

    const walk_in_total = all_.walkin   ? Math.round(all_.walkin[mIdx])   : 0;
    const closed_count  = all_.purchase ? Math.round(all_.purchase[mIdx]) : 0;
    if (!walk_in_total && !closed_count) continue;  // skip empty months (future, or W11 post-close)

    // closing_rate column is numeric(5,2) → max ±999.99.
    // Apps Script returns either decimal (0..1) or already-percentage (0..100)
    // depending on store. Detect by magnitude. If still out of range after
    // detection, set null (data quality issue, will surface in dashboards).
    let cr_raw = all_.cr ? +all_.cr[mIdx] : 0;
    let closing_rate = !Number.isFinite(cr_raw) ? null
      : cr_raw <= 1.5  ? +(cr_raw * 100).toFixed(2)     // decimal form
      : cr_raw <= 999  ? +cr_raw.toFixed(2)              // already a percentage
      :                  null;                            // overflow / sentinel
    const amount_total = all_.amount ? Math.round(all_.amount[mIdx] * 100) / 100   : 0;
    const basket_total = all_.basket ? Math.round(all_.basket[mIdx] * 100) / 100   : 0;

    const racePack = (rowMap, field) => (rowMap && rowMap[field]) ? rowMap[field][mIdx] : null;
    const by_race = {
      chinese: { purchase: Math.round(racePack(chRow, 'purchase') || 0),
                 amount:   +((racePack(chRow, 'amount')   || 0)).toFixed(2) },
      malay:   { purchase: Math.round(racePack(myRow, 'purchase') || 0),
                 amount:   +((racePack(myRow, 'amount')   || 0)).toFixed(2) },
      indian:  { purchase: Math.round(racePack(inRow, 'purchase') || 0),
                 amount:   +((racePack(inRow, 'amount')   || 0)).toFixed(2) },
      others:  { purchase: Math.round(racePack(oRow,  'purchase') || 0),
                 amount:   +((racePack(oRow,  'amount')   || 0)).toFixed(2) },
    };

    rows.push({
      date: ymToLastOfMonth({ y: FLOATATION_YEAR, m }),
      store,
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
    });
    const key = FLOATATION_YEAR * 12 + m;
    if (key > latestKey) latestKey = key;
  }
  const latest_ym = latestKey > 0
    ? `${Math.floor((latestKey - 1) / 12)}-${String(((latestKey - 1) % 12) + 1).padStart(2, '0')}`
    : null;
  return { store, rows, latest_ym };
}

// 6 stores fetched in parallel; result is one combined source for the
// floatation table.
async function loadFloatation() {
  const results = await Promise.all(
    FLOATATION_SHEETS.map(s => loadFloatationOne(s.id, s.store))
  );
  const allRows = [];
  const per_store = {};
  let latestKey = -Infinity;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const store = FLOATATION_SHEETS[i].store;
    if (r.error) { per_store[store] = { rows: 0, latest_ym: null, error: r.error }; continue; }
    allRows.push(...r.rows);
    per_store[store] = { rows: r.rows.length, latest_ym: r.latest_ym };
    if (r.latest_ym) {
      const [y, m] = r.latest_ym.split('-').map(Number);
      const key = y * 12 + m;
      if (key > latestKey) latestKey = key;
    }
  }
  const latest_ym = latestKey > 0
    ? `${Math.floor((latestKey - 1) / 12)}-${String(((latestKey - 1) % 12) + 1).padStart(2, '0')}`
    : null;
  return { rows: allRows, latest_ym, per_store, total_rows: allRows.length };
}

async function loadSm() {
  const text = await fetchSheetCsv(SHEETS.sm_item_master.id, SHEETS.sm_item_master.tab);
  const grid = parseCsv(text);
  if (!grid.length) return { rows: [], total_rows: 0 };
  const hdr = grid[0].map(s => String(s||'').trim().toUpperCase());
  const idx = {}; for (let i = 0; i < hdr.length; i++) idx[hdr[i]] = i;
  // SM columns per Notion: Open Date / Item Status / Main Group / Sub Group /
  //   Application / Capacity / Finishing / Shape / Brand / PRc range /
  //   Movement / Country / Manufacturer
  // SM uses underscored headers (ITEM_CODE, ITEM_STATUS_DESC, …) — and
  // one sheet typo (MOVEMONT, not MOVEMENT). Always try underscore form
  // first; keep space-form fallbacks in case the sheet is ever re-headered.
  const I = {
    CODE:     idx['ITEM_CODE']         ?? idx['ITEM CODE']      ?? idx['STOCK CODE']  ?? 0,
    OPEN:     idx['OPEN_DATE']         ?? idx['OPEN DATE']      ?? null,
    STATUS:   idx['ITEM_STATUS_DESC']  ?? idx['ITEM_STATUS']    ?? idx['ITEM STATUS'] ?? null,
    MAIN:     idx['MAIN_GROUP']        ?? idx['MAIN GROUP']     ?? null,
    SUB:      idx['SUB_GROUP']         ?? idx['SUB GROUP']      ?? null,
    APP:      idx['APPLICATION']       ?? null,
    CAP:      idx['CAPACITY']          ?? null,
    FIN:      idx['CLR_FINISHING']     ?? idx['CLR FINISHING']  ?? idx['FINISHING']   ?? null,
    SHAPE:    idx['SHAPE_DESIGN']      ?? idx['SHAPE DESIGN']   ?? idx['SHAPE']       ?? null,
    BRAND:    idx['BRAND']             ?? null,
    PRC:      idx['PRC_RANGE']         ?? idx['PRC RANGE']      ?? idx['PRICE RANGE'] ?? null,
    MOV:      idx['MOVEMONT']          ?? idx['MOVEMENT']       ?? null,                       // SM has typo "MOVEMONT"
    COUNTRY:  idx['COUNTRY']           ?? null,
    MFR:      idx['MANUFACTURER']      ?? null,
  };
  function parseOpenDate(s) {
    if (!s) return null;
    s = String(s).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      let y = +m[3]; if (y < 100) y = 2000 + y;
      return `${y}-${String(+m[1]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`;
    }
    return null;
  }
  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]; if (!r) continue;
    const code = String(r[I.CODE] || '').trim(); if (!code) continue;
    const obj = { item_code: code, source: 'sync_sm' };
    if (I.OPEN    != null) obj.open_date    = parseOpenDate(r[I.OPEN]);
    if (I.STATUS  != null) obj.item_status  = String(r[I.STATUS]||'').trim() || null;
    if (I.MAIN    != null) obj.main_group   = String(r[I.MAIN]||'').trim()   || null;
    if (I.SUB     != null) obj.sub_group    = String(r[I.SUB]||'').trim()    || null;
    if (I.APP     != null) obj.application  = String(r[I.APP]||'').trim()    || null;
    if (I.CAP     != null) obj.capacity     = String(r[I.CAP]||'').trim()    || null;
    if (I.FIN     != null) obj.clr_finishing= String(r[I.FIN]||'').trim()    || null;
    if (I.SHAPE   != null) obj.shape_design = String(r[I.SHAPE]||'').trim()  || null;
    if (I.BRAND   != null) obj.brand        = String(r[I.BRAND]||'').trim()  || null;
    if (I.PRC     != null) obj.prc_range    = String(r[I.PRC]||'').trim()    || null;
    if (I.MOV     != null) obj.movement     = String(r[I.MOV]||'').trim()    || null;
    if (I.COUNTRY != null) obj.country      = String(r[I.COUNTRY]||'').trim()|| null;
    if (I.MFR     != null) obj.manufacturer = String(r[I.MFR]||'').trim()    || null;
    rows.push(obj);
  }
  return { rows, total_rows: rows.length };
}

// CP2 Step 3: PO/GRN Raw Pivot → po_grn table.
// Date format: DD/MM/YYYY (Wiltek POS export, MY locale; sometimes single-digit
// like "7/4/2026" = 7 Apr 2026). PO date may be present without GRN date
// (PO placed, not yet received).
function parseDmyDate(s) {
  if (!s) return null;
  s = String(s).trim(); if (!s || s === '-') return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let y = +m[3]; if (y < 100) y = 2000 + y;
  return `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
}

async function loadPoGrn() {
  const text = await fetchSheetCsv(SHEETS.po_grn_raw_pivot.id, SHEETS.po_grn_raw_pivot.tab);
  const grid = parseCsv(text);
  if (!grid.length) return { rows: [], latest_ym: null, total_rows: 0,
                             dropped_no_po_date: 0, negative_lead_time: 0 };
  const hdr = grid[0].map(s => String(s||'').trim().toUpperCase());
  const idx = {}; for (let i = 0; i < hdr.length; i++) idx[hdr[i]] = i;
  const I = {
    PO:    idx['P/O DATE']  ?? 0,
    GRN:   idx['GRF DATE']  ?? idx['GRN DATE'] ?? 1,
    CODE:  idx['ITEM CODE'] ?? 2,
    BR:    idx['BRANCH']    ?? 3,
    POQ:   idx['PO QTY']    ?? 4,
    GRNQ:  idx['GRN QTY']   ?? 5,
    POA:   idx['PO AMT']    ?? 6,
    GRNA:  idx['GRN AMT']   ?? 7,
  };

  const rows = [];
  let latestKey = -Infinity;
  let dropped_no_po_date = 0, dropped_no_item = 0, negative_lead_time = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]; if (!r) continue;
    const po = parseDmyDate(r[I.PO]);
    if (!po) { dropped_no_po_date += 1; continue; }
    const code = String(r[I.CODE] || '').trim();
    if (!code) { dropped_no_item += 1; continue; }
    const branch = String(r[I.BR] || '').trim() || 'WLO';
    const grn = parseDmyDate(r[I.GRN]);
    if (grn && grn < po) negative_lead_time += 1;
    rows.push({
      po_date:   po,
      grn_date:  grn,
      item_code: code,
      branch,
      po_qty:    parseNum(r[I.POQ]),
      grn_qty:   parseNum(r[I.GRNQ]),
      po_amt:    parseNum(r[I.POA]),
      grn_amt:   parseNum(r[I.GRNA]),
    });
    const [y, m] = po.split('-').map(Number);
    const key = y * 12 + m;
    if (key > latestKey) latestKey = key;
  }
  const latest_ym = latestKey > 0
    ? `${Math.floor((latestKey - 1) / 12)}-${String(((latestKey - 1) % 12) + 1).padStart(2, '0')}`
    : null;
  return {
    rows, latest_ym, total_rows: rows.length,
    dropped_no_po_date, dropped_no_item, negative_lead_time,
  };
}

// CP3: financial loader. Reads Apps Script ?type=financial (already parses
// FMM Liability + monthly P&L + cashflow). Outputs two row-sets:
//   - balance_sheet: 1 snapshot row (today)
//   - monthly:       1 row per (year_month, branch) — TOTAL + W01..W11
async function loadFinancial() {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_KEY) {
    return { balance_sheet: null, monthly: [], ok: false, error: 'WTK_APPS_SCRIPT_URL/WTK_API_KEY env not set' };
  }
  const url = `${APPS_SCRIPT_URL}?type=financial&key=${encodeURIComponent(APPS_SCRIPT_KEY)}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
  const txt = await r.text();
  if (txt.startsWith('<')) throw new Error('Apps Script returned HTML (login wall?)');
  const j = JSON.parse(txt);
  if (!j.ok) throw new Error('Apps Script error: ' + (j.error || ''));
  const D = j.data || {};

  // Latest snapshot date — today's date (Apps Script reads "now" each call).
  const today = new Date();
  const snap_date = today.toISOString().slice(0, 10);

  // year_month — derived from period label (e.g. "APRIL'2026") or fallback to current month.
  // The Apps Script doesn't expose the parsed period cleanly. Use the FMM tab's last
  // populated month from cashflow.months[0].
  const cashMonths = D.cashflow?.months || [];
  let latest_ym = null;
  if (cashMonths.length) {
    const s = String(cashMonths[0]); // e.g. "202503" or "202504"
    if (/^\d{6}$/.test(s)) latest_ym = `${s.slice(0,4)}-${s.slice(4,6)}`;
  }
  if (!latest_ym) {
    const m = today.getUTCMonth();
    const y = m === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
    latest_ym = `${y}-${String(m === 0 ? 12 : m).padStart(2,'0')}`;
  }

  // Balance sheet from liability section.
  const liab = D.liability || {};
  const a = liab.assets || {}, l = liab.liabilities || {};
  const balance_sheet = {
    snap_date,
    building:        a.building     ?? null,
    stock_value:     a.stock        ?? null,
    cash_total:      a.cash_total   ?? null,
    asset_subtotal:  a.subtotal     ?? null,
    term_loan:       l.term_loan    ?? null,
    overdraft:       l.overdraft    ?? null,
    hire_purchase:   l.hire_purchase?? null,
    oaf:             l.oaf          ?? null,
    loan_subtotal:   l.total        ?? null,
    net_equity:      liab.net_equity?? null,
    ratio:           liab.ratio     ?? null,
    raw:             liab.raw       || null,
  };

  // Monthly P&L: one row per (latest_ym, branch). branches = TOTAL + W01..W11
  // (preserve W11 per Jym hard rule).
  function mapMetrics(node) {
    if (!node) return null;
    const get = (k, b) => node[k]?.[b] ?? null;
    return {
      gross_sales_inv:   get('gross_sales',  'inv'),
      net_sales_inv:     get('net_sales',    'inv'),
      gross_profit_inv:  get('gross_profit', 'inv'),
      net_profit_inv:    get('net_profit',   'inv'),
      total_exp_inv:     get('total_exp',    'inv'),
      cogs_inv:          get('cogs',         'inv'),
      gross_sales_coll:  get('gross_sales',  'coll'),
      net_sales_coll:    get('net_sales',    'coll'),
      gross_profit_coll: get('gross_profit', 'coll'),
      net_profit_coll:   get('net_profit',   'coll'),
      metrics:           node,                 // full jsonb for audit / drilldown
    };
  }

  const monthly = [];
  const totalRow = mapMetrics(D.current_period?.total);
  if (totalRow) monthly.push({ year_month: latest_ym, branch: 'TOTAL', ...totalRow });
  const branchObjs = D.current_period?.branches || {};
  for (const br of ['W01','W02','W03','W05','W07','W11']) {
    const m = mapMetrics(branchObjs[br]);
    if (m) monthly.push({ year_month: latest_ym, branch: br, ...m });
  }

  return { balance_sheet, monthly, latest_ym, snap_date, total_rows: monthly.length };
}

// ── Preview helpers (incremental detection) ───────────────────────────
async function previewSales(parsed) {
  if (!parsed.latest_ym) return { ok: false, error: 'no rows from sheet' };
  const startOfMonth = parsed.latest_ym + '-01';
  const startOfNext  = (() => {
    const [y, m] = parsed.latest_ym.split('-').map(Number);
    const nm = m === 12 ? `${y+1}-01-01` : `${y}-${String(m+1).padStart(2,'0')}-01`;
    return nm;
  })();
  const { count: dbCountThisMonth } = await sb().from('sales')
    .select('*', { count: 'exact', head: true })
    .gte('sale_date', startOfMonth).lt('sale_date', startOfNext);
  const sheetCountThisMonth = parsed.rows.filter(r => r.sale_date === startOfMonth).length;
  return {
    source: 'customer_buy_v3', target_table: 'sales',
    sheet_total_rows: parsed.total_rows,
    latest_ym: parsed.latest_ym,
    sheet_rows_for_latest_ym: sheetCountThisMonth,
    db_rows_for_latest_ym:    dbCountThisMonth,
    action: dbCountThisMonth === 0 ? 'append'
          : dbCountThisMonth === sheetCountThisMonth ? 'noop'
          : 'conflict',
    preview_rows_to_add: dbCountThisMonth === 0 ? sheetCountThisMonth : 0,
  };
}

// CP2: customer_buy_lines preview. Emits TWO preview rows so the sync UI
// shows customer_buy_lines AND customers (UPSERT side-effect) separately.
async function previewCbl(parsed) {
  if (!parsed.latest_ym) {
    return [
      { source: 'customer_buy_v3_cbl', target_table: 'customer_buy_lines', sheet_total_rows: 0, action: 'noop', preview_rows_to_add: 0 },
      { source: 'customer_buy_v3_customers', target_table: 'customers', action: 'noop', preview_rows_to_add: 0, note: 'UPSERT side-effect — runs alongside customer_buy_lines apply' },
    ];
  }
  const sheetForLatest = parsed.rows.filter(r => r.year_month === parsed.latest_ym);

  // FK check vs items (paginated lookup so it's accurate >1000 rows).
  const items = await fetchAllItemCodes();
  const validItems = new Set(items.map(r => r.item_code));
  let dropped_unknown_item = 0;
  const passingRows = [];
  for (const r of sheetForLatest) {
    if (!validItems.has(r.item_code)) { dropped_unknown_item += 1; continue; }
    passingRows.push(r);
  }

  // Customer UPSERT preview: how many unique members in the month? How many
  // are new (not in customers yet)?
  const seenMembers = new Set(passingRows.map(r => r.member_code));
  const memberArr   = [...seenMembers];
  let new_members = 0, existing_members = 0;
  if (memberArr.length) {
    const existingSet = new Set();
    const chunk = 500;
    for (let i = 0; i < memberArr.length; i += chunk) {
      const slice = memberArr.slice(i, i + chunk);
      const { data } = await sb().from('customers').select('customer_id').in('customer_id', slice);
      for (const r of (data || [])) existingSet.add(r.customer_id);
    }
    existing_members = existingSet.size;
    new_members      = memberArr.length - existing_members;
  }

  const { count: dbRowsThisMonth } = await sb().from('customer_buy_lines')
    .select('*', { count: 'exact', head: true })
    .eq('year_month', parsed.latest_ym);
  const { count: customersDbTotal } = await sb().from('customers')
    .select('*', { count: 'exact', head: true });

  return [
    {
      source: 'customer_buy_v3_cbl', target_table: 'customer_buy_lines',
      sheet_total_rows:             parsed.total_rows,
      latest_ym:                    parsed.latest_ym,
      sheet_rows_for_latest_ym:     sheetForLatest.length,
      db_rows_for_latest_ym:        dbRowsThisMonth,
      rows_after_fk_filter:         passingRows.length,
      dropped_no_member:            parsed.dropped_no_member || 0,
      dropped_no_bill_or_branch:    parsed.dropped_no_bill_or_branch || 0,
      dropped_unknown_item,
      members_in_month:             memberArr.length,
      new_members,
      existing_members,
      action: dbRowsThisMonth === 0       ? 'append'
            : dbRowsThisMonth === passingRows.length ? 'noop'
            : 'conflict',
      preview_rows_to_add: dbRowsThisMonth === 0 ? passingRows.length : 0,
    },
    {
      source: 'customer_buy_v3_customers', target_table: 'customers',
      sheet_total_rows:    memberArr.length,
      db_total_rows:       customersDbTotal,
      members_in_month:    memberArr.length,
      new_members,
      existing_members,
      action: 'upsert',
      preview_rows_to_add: new_members,
      note: 'UPSERT side-effect of CBL apply. customer_id PK; name + enrol_date refreshed. Owner-owned cols (type, primary_store, phone) preserved.',
    },
  ];
}

async function previewInventory(parsed) {
  if (!parsed.snapshot_date) return { ok: false, error: 'no rows from sheet' };
  const { count: dbCount } = await sb().from('inventory_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('snapshot_date', parsed.snapshot_date);
  return {
    source: 'raw_cs', target_table: 'inventory_snapshots',
    sheet_total_rows: parsed.total_rows,
    snapshot_date: parsed.snapshot_date,
    sheet_rows_for_snapshot: parsed.total_rows,
    db_rows_for_snapshot:    dbCount,
    action: dbCount === 0 ? 'append'
          : dbCount === parsed.total_rows ? 'noop'
          : 'conflict',
    preview_rows_to_add: dbCount === 0 ? parsed.total_rows : 0,
  };
}

// Item status filter for NEW rows (Jym CP1 rule):
//   KEEP   : NULL / starts F- / starts N- / starts S- / unknown
//   DROP   : starts D- / starts O- / exactly 'OBS' / exactly 'OBSOLETE'
// Existing rows are ALWAYS kept (UPSERTed) regardless of status — Owner
// may have legitimate reasons to retain (e.g. recently discontinued SKU
// with active warranty notes).
function itemStatusFilter(status) {
  if (status == null || status === '') return { keep: true, bucket: 'NULL' };
  const s = String(status).trim().toUpperCase();
  if (s === 'OBS' || s === 'OBSOLETE') return { keep: false, bucket: 'FILTERED' };
  if (s.startsWith('D-')) return { keep: false, bucket: 'FILTERED' };
  if (s.startsWith('O-')) return { keep: false, bucket: 'FILTERED' };
  if (s.startsWith('F-')) return { keep: true, bucket: 'F-FAST' };
  if (s.startsWith('N-')) return { keep: true, bucket: 'N-NORMAL' };
  if (s.startsWith('S-')) return { keep: true, bucket: 'S-SLOW' };
  return { keep: true, bucket: 'OTHER' };
}

async function previewItems(parsed) {
  // Partition SM rows: existing (always UPSERT) vs new (filter by status).
  const existing = await fetchAllItemCodes();
  const existingCodes = new Set(existing.map(r => r.item_code));
  let existing_updated = 0, new_insert_proposed = 0, new_filtered_out = 0;
  const new_status_dist = { 'F-FAST': 0, 'N-NORMAL': 0, 'S-SLOW': 0, NULL: 0, OTHER: 0 };
  for (const r of parsed.rows) {
    if (existingCodes.has(r.item_code)) {
      existing_updated += 1;
    } else {
      const f = itemStatusFilter(r.item_status);
      if (!f.keep) {
        new_filtered_out += 1;
      } else {
        new_insert_proposed += 1;
        new_status_dist[f.bucket] += 1;
      }
    }
  }
  return {
    source: 'sm_item_master', target_table: 'items',
    sheet_total_rows: parsed.total_rows,
    db_total_rows: existingCodes.size,
    action: 'upsert',
    existing_updated,
    new_insert_proposed,
    new_filtered_out,
    new_status_dist,
    preview_rows_to_add: new_insert_proposed,
    note: 'Existing rows UPSERTed (all 13 master cols). New rows filtered by item_status (D-/O-/OBS dropped). Owner-owned cols never overwritten.',
  };
}

// ── Apply helpers ─────────────────────────────────────────────────────

// Supabase select() caps at 1000 rows by default regardless of .limit().
// Use range() pagination to fetch everything. Used for items lookup
// (Phase 0 has 2,399 rows; will grow past 1000 again after CP1 apply).
async function fetchAllItemCodes() {
  const out = [];
  const step = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb().from('items').select('item_code')
      .range(from, from + step - 1);
    if (error) throw new Error('items lookup: ' + error.message);
    out.push(...(data || []));
    if (!data || data.length < step) break;
    from += step;
  }
  return out;
}

async function chunkInsert(table, rows, opts = {}) {
  const size = opts.chunkSize || 1000;
  let ok = 0, err = 0;
  let first_error = null, error_chunks = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const q = sb().from(table).upsert(chunk, opts.onConflict ? { onConflict: opts.onConflict, ignoreDuplicates: false } : {});
    const { error } = await q;
    if (error) {
      err += chunk.length;
      error_chunks += 1;
      if (!first_error) first_error = { message: error.message, code: error.code, details: error.details, hint: error.hint, sample_row_keys: Object.keys(chunk[0] || {}), sample_row: chunk[0] };
      console.error(`[sync] ${table} chunk ${i}: ${error.message}`);
    } else { ok += chunk.length; }
  }
  return { ok, err, first_error, error_chunks };
}

// CP2 Step 2: floatation preview — 6 stores' Sheet-1 monthly aggregates.
// Two parallel concerns:
//   1. LATEST-MONTH delta — standard append/noop/conflict on latest_ym
//      across all 6 stores. Conflict prompts owner overwrite confirm.
//   2. HISTORICAL BACKFILL — any (date, store) row in sheet that doesn't
//      exist in DB and isn't in the latest_ym range. Auto-inserts on
//      every apply regardless of overwrite flag (purely additive — most
//      relevant for first-time W11 history import).
async function previewFloatation(parsed) {
  if (!parsed.rows.length) {
    return { source: 'floatation_6stores', target_table: 'floatation',
             sheet_total_rows: 0, action: 'noop', preview_rows_to_add: 0 };
  }

  // Look up which (date, store) are already in DB across all sheet rows.
  const dates  = [...new Set(parsed.rows.map(r => r.date))];
  const stores = [...new Set(parsed.rows.map(r => r.store))];
  const { data: dbExist } = await sb().from('floatation')
    .select('date, store').in('date', dates).in('store', stores);
  const dbKeys = new Set((dbExist || []).map(r => `${r.date}|${r.store}`));

  // Determine latest-month range.
  const startOfMonth = parsed.latest_ym + '-01';
  const startOfNext  = (() => {
    const [y, m] = parsed.latest_ym.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  })();

  let latest_new = 0, latest_existing = 0;
  let backfill_w11 = 0, backfill_other = 0;
  const per_store_delta = {};
  for (const r of parsed.rows) {
    const isLatest = r.date >= startOfMonth && r.date < startOfNext;
    const inDb     = dbKeys.has(`${r.date}|${r.store}`);
    if (!per_store_delta[r.store]) per_store_delta[r.store] = { latest_new: 0, latest_existing: 0, backfill: 0 };
    if (isLatest) {
      if (inDb) { latest_existing++; per_store_delta[r.store].latest_existing++; }
      else      { latest_new++;      per_store_delta[r.store].latest_new++; }
    } else if (!inDb) {
      if (r.store === 'W11') backfill_w11++; else backfill_other++;
      per_store_delta[r.store].backfill++;
    }
  }

  const action = latest_existing === 0 ? (latest_new === 0 ? 'noop' : 'append')
               : (latest_new === 0     ? 'noop' : 'conflict');

  return {
    source: 'floatation_6stores', target_table: 'floatation',
    sheet_total_rows:              parsed.rows.length,
    latest_ym:                     parsed.latest_ym,
    sheet_rows_for_latest_ym:      latest_new + latest_existing,
    db_rows_for_latest_ym:         latest_existing,
    action,
    preview_rows_to_add:           latest_new + backfill_w11 + backfill_other,
    backfill_w11_rows:             backfill_w11,
    backfill_other_rows:           backfill_other,
    per_store_delta,
    per_store_load:                parsed.per_store,
  };
}

// CP2 Step 2: floatation apply.
//   1. Insert all "new (date, store)" rows (no overwrite needed — additive).
//      This includes W11 historical backfill.
//   2. For latest_ym rows where (date, store) already exists in DB, replace
//      ONLY if owner confirmed overwrite.
async function applyFloatation(parsed, overwrite, user) {
  if (!parsed.rows.length) {
    return { source: 'floatation_6stores', target_table: 'floatation', ok: false, error: 'no rows' };
  }

  const dates  = [...new Set(parsed.rows.map(r => r.date))];
  const stores = [...new Set(parsed.rows.map(r => r.store))];
  const { data: dbExist } = await sb().from('floatation')
    .select('date, store').in('date', dates).in('store', stores);
  const dbKeys = new Set((dbExist || []).map(r => `${r.date}|${r.store}`));

  const startOfMonth = parsed.latest_ym ? parsed.latest_ym + '-01' : '9999-12-31';
  const startOfNext  = parsed.latest_ym ? (() => {
    const [y, m] = parsed.latest_ym.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  })() : '9999-12-31';

  const newInserts = [];                 // not in DB → always insert
  const overwriteRows = [];              // in DB + latest_ym → maybe replace
  for (const r of parsed.rows) {
    const enriched = { ...r, updated_by: user.username };
    const inDb = dbKeys.has(`${r.date}|${r.store}`);
    if (!inDb) { newInserts.push(enriched); continue; }
    if (overwrite && r.date >= startOfMonth && r.date < startOfNext) {
      overwriteRows.push(enriched);
    }
    // else: row exists and not overwriting → skip (preserve existing data,
    // including the Phase 0 migration rows for the other stores).
  }

  // Insert pass — additive, no conflict possible since these keys are new.
  const resInsert = await chunkInsert('floatation', newInserts, { onConflict: 'date,store' });
  // Overwrite pass — UPSERT replaces existing rows for latest_ym only when
  // owner explicitly confirmed.
  let resOver = { ok: 0, err: 0 };
  if (overwriteRows.length) {
    resOver = await chunkInsert('floatation', overwriteRows, { onConflict: 'date,store' });
  }

  const source_row_count = newInserts.length + overwriteRows.length;
  const source_amt_sum   = parsed.rows.reduce((s, r) => s + (+r.amount_total || 0), 0);
  const { count: db_actual } = await sb().from('floatation').select('*', { count: 'exact', head: true });
  const assertion_failed = source_row_count > 0 && ((resInsert.ok + resOver.ok) / source_row_count) < 0.99;
  return {
    source: 'floatation_6stores', target_table: 'floatation',
    latest_ym: parsed.latest_ym,
    rows_appended:           resInsert.ok,
    rows_overwritten:        resOver.ok,
    rows_failed:             resInsert.err + resOver.err,
    first_error:             resInsert.first_error || resOver.first_error || null,
    source_row_count, source_amt_sum: +source_amt_sum.toFixed(2),
    db_row_count_after: db_actual, assertion_failed,
    backfill_count:          newInserts.filter(r => r.date < startOfMonth).length,
    mode: overwrite ? 'overwrite_latest_plus_backfill' : 'append_plus_backfill',
  };
}

// CP2 Step 3: po_grn preview + apply.
async function previewPoGrn(parsed) {
  if (!parsed.latest_ym) {
    return { source: 'po_grn_raw_pivot', target_table: 'po_grn',
             sheet_total_rows: parsed.total_rows || 0, action: 'noop', preview_rows_to_add: 0 };
  }
  const startOfMonth = parsed.latest_ym + '-01';
  const startOfNext  = (() => {
    const [y, m] = parsed.latest_ym.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  })();
  const sheetForLatest = parsed.rows.filter(r => r.po_date >= startOfMonth && r.po_date < startOfNext);

  // FK validation: count rows whose item_code is NOT in items.
  const items = await fetchAllItemCodes();
  const validItems = new Set(items.map(r => r.item_code));
  let dropped_unknown_item = 0;
  const passingRows = [];
  for (const r of sheetForLatest) {
    if (!validItems.has(r.item_code)) { dropped_unknown_item += 1; continue; }
    passingRows.push(r);
  }

  const { count: dbCount } = await sb().from('po_grn')
    .select('*', { count: 'exact', head: true })
    .gte('po_date', startOfMonth).lt('po_date', startOfNext);

  // Aggregate stats for the report.
  const sumPoAmt  = passingRows.reduce((s, r) => s + (+r.po_amt  || 0), 0);
  const sumGrnAmt = passingRows.reduce((s, r) => s + (+r.grn_amt || 0), 0);

  return {
    source: 'po_grn_raw_pivot', target_table: 'po_grn',
    sheet_total_rows:           parsed.total_rows,
    latest_ym:                  parsed.latest_ym,
    sheet_rows_for_latest_ym:   sheetForLatest.length,
    rows_after_fk_filter:       passingRows.length,
    db_rows_for_latest_ym:      dbCount,
    dropped_no_po_date:         parsed.dropped_no_po_date,
    dropped_no_item:            parsed.dropped_no_item || 0,
    dropped_unknown_item,
    negative_lead_time:         parsed.negative_lead_time,
    sum_po_amt_latest:          +sumPoAmt.toFixed(2),
    sum_grn_amt_latest:         +sumGrnAmt.toFixed(2),
    action: dbCount === 0 ? 'append'
          : dbCount === passingRows.length ? 'noop'
          : 'conflict',
    preview_rows_to_add: dbCount === 0 ? passingRows.length : 0,
  };
}

async function applyPoGrn(parsed, overwrite, user) {
  if (!parsed.latest_ym) {
    return { source: 'po_grn_raw_pivot', target_table: 'po_grn', ok: false, error: 'no rows' };
  }
  const startOfMonth = parsed.latest_ym + '-01';
  const startOfNext  = (() => {
    const [y, m] = parsed.latest_ym.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  })();
  const monthRows = parsed.rows.filter(r => r.po_date >= startOfMonth && r.po_date < startOfNext);

  // FK filter against items.
  const items = await fetchAllItemCodes();
  const validItems = new Set(items.map(r => r.item_code));
  let dropped_unknown_item = 0;
  const validRows = [];
  for (const r of monthRows) {
    if (!validItems.has(r.item_code)) { dropped_unknown_item += 1; continue; }
    validRows.push(r);
  }

  if (overwrite) {
    await sb().from('po_grn').delete().gte('po_date', startOfMonth).lt('po_date', startOfNext);
  }

  // Dedupe within batch: PostgreSQL refuses ON CONFLICT DO UPDATE when the
  // same row would be touched twice. Source Raw Pivot can have multiple
  // rows with identical (po_date, item_code, branch) — different GRN dates
  // or split deliveries. We sum qty/amt across dupes; keep earliest grn_date.
  const dedupeMap = new Map();
  let dropped_duplicates = 0;
  for (const r of validRows) {
    const k = `${r.po_date}|${r.item_code}|${r.branch}`;
    if (dedupeMap.has(k)) {
      const cur = dedupeMap.get(k);
      cur.po_qty  = (+cur.po_qty  || 0) + (+r.po_qty  || 0);
      cur.grn_qty = (+cur.grn_qty || 0) + (+r.grn_qty || 0);
      cur.po_amt  = (+cur.po_amt  || 0) + (+r.po_amt  || 0);
      cur.grn_amt = (+cur.grn_amt || 0) + (+r.grn_amt || 0);
      // earliest grn_date wins (more conservative)
      if (r.grn_date && (!cur.grn_date || r.grn_date < cur.grn_date)) cur.grn_date = r.grn_date;
      dropped_duplicates += 1;
    } else {
      dedupeMap.set(k, { ...r });
    }
  }
  const deduped = [...dedupeMap.values()];
  const inserts = deduped.map(r => ({ ...r, updated_by: user.username, updated_at: new Date().toISOString() }));
  const res = await chunkInsert('po_grn', inserts, { onConflict: 'po_date,item_code,branch' });

  const source_row_count = deduped.length;
  const source_amt_sum   = deduped.reduce((s, r) => s + (+r.po_amt || 0), 0);
  const { count: db_actual } = await sb().from('po_grn')
    .select('*', { count: 'exact', head: true })
    .gte('po_date', startOfMonth).lt('po_date', startOfNext);
  const assertion_failed = source_row_count > 0 && (res.ok / source_row_count) < 0.99;
  return {
    source: 'po_grn_raw_pivot', target_table: 'po_grn',
    latest_ym:                parsed.latest_ym,
    rows_appended:            res.ok,
    rows_failed:              res.err,
    first_error:              res.first_error || null,
    rows_dropped_unknown_item: dropped_unknown_item,
    rows_dropped_duplicates:  dropped_duplicates,
    source_row_count, source_amt_sum: +source_amt_sum.toFixed(2),
    db_row_count_after: db_actual, assertion_failed,
    mode: overwrite ? 'overwrite' : 'append',
  };
}

// CP3: financial preview. Emits THREE preview rows so the sync UI shows
// each destination table separately:
//   - financial_balance_sheet (snap_date PK)
//   - financial_monthly       (year_month, branch)
//   - financial_brand_margin  (BACKLOG — Apps Script doesn't expose yet)
async function previewFinancial(parsed) {
  if (!parsed || parsed.ok === false) {
    const errNote = parsed?.error || 'no data';
    return [
      { source: 'fmm_liability',      target_table: 'financial_balance_sheet', action: 'noop', preview_rows_to_add: 0, error: errNote },
      { source: 'fmm_monthly',        target_table: 'financial_monthly',       action: 'noop', preview_rows_to_add: 0, error: errNote },
      { source: 'fmm_sales_vs_cost',  target_table: 'financial_brand_margin',  action: 'backlog', preview_rows_to_add: 0,
        note: 'BACKLOG — Apps Script does not expose Sales VS Cost data yet (Phase 3)' },
    ];
  }

  const { count: bsCount } = await sb().from('financial_balance_sheet')
    .select('*', { count: 'exact', head: true }).eq('snap_date', parsed.snap_date);
  const { count: monthCount } = await sb().from('financial_monthly')
    .select('*', { count: 'exact', head: true }).eq('year_month', parsed.latest_ym);
  const { count: brandCount } = await sb().from('financial_brand_margin')
    .select('*', { count: 'exact', head: true });

  return [
    {
      source: 'fmm_liability', target_table: 'financial_balance_sheet',
      sheet_total_rows:        parsed.balance_sheet ? 1 : 0,
      snap_date:               parsed.snap_date,
      sheet_rows_for_snapshot: parsed.balance_sheet ? 1 : 0,
      db_rows_for_snapshot:    bsCount,
      action: bsCount === 0 ? 'append' : 'upsert',
      preview_rows_to_add: parsed.balance_sheet ? 1 : 0,
      note: 'UPSERT key: snap_date',
    },
    {
      source: 'fmm_monthly', target_table: 'financial_monthly',
      sheet_total_rows:         parsed.monthly.length,
      latest_ym:                parsed.latest_ym,
      sheet_rows_for_latest_ym: parsed.monthly.length,
      db_rows_for_latest_ym:    monthCount,
      action: monthCount === 0 ? 'append' : 'upsert',
      preview_rows_to_add: parsed.monthly.length,
      note: 'UPSERT key: (year_month, branch). 7 rows = TOTAL + W01..W11.',
    },
    {
      source: 'fmm_sales_vs_cost', target_table: 'financial_brand_margin',
      sheet_total_rows: 0,
      db_total_rows:    brandCount,
      action: 'backlog',
      preview_rows_to_add: 0,
      note: 'BACKLOG — Apps Script does not expose Sales VS Cost yet. Schema ready; loader pending Phase 3.',
    },
  ];
}

async function applyFinancial(parsed, overwrite, user) {
  if (!parsed || parsed.ok === false) {
    return { source: 'fmm_apps_script', target_table: 'financial_*', ok: false, error: parsed?.error || 'no data' };
  }
  const updated_by = user.username;
  const updated_at = new Date().toISOString();

  // 1. Balance sheet snapshot.
  let bs_rows_upserted = 0, bs_failed = 0;
  if (parsed.balance_sheet) {
    const row = { ...parsed.balance_sheet, updated_by, updated_at };
    const { error } = await sb().from('financial_balance_sheet')
      .upsert([row], { onConflict: 'snap_date' });
    if (error) { bs_failed = 1; console.error('[sync] financial_balance_sheet:', error.message); }
    else bs_rows_upserted = 1;
  }

  // 2. Monthly P&L rows.
  const monthlyInserts = (parsed.monthly || []).map(r => ({ ...r, updated_by, updated_at }));
  let m_upserted = 0, m_failed = 0;
  if (monthlyInserts.length) {
    const res = await chunkInsert('financial_monthly', monthlyInserts, { onConflict: 'year_month,branch' });
    m_upserted = res.ok; m_failed = res.err;
  }

  const source_row_count = (parsed.balance_sheet ? 1 : 0) + (parsed.monthly || []).length;
  const ok_total = bs_rows_upserted + m_upserted;
  const assertion_failed = source_row_count > 0 && (ok_total / source_row_count) < 0.99;
  return {
    source: 'fmm_apps_script', target_table: 'financial_*',
    latest_ym:                parsed.latest_ym,
    snap_date:                parsed.snap_date,
    rows_appended:            ok_total,
    balance_sheet_upserted:   bs_rows_upserted,
    monthly_upserted:         m_upserted,
    rows_failed:              bs_failed + m_failed,
    source_row_count, source_amt_sum: null,   // financial has no single amt field
    db_row_count_after: null,                  // 2-table fan-out, omit
    assertion_failed,
    mode: 'upsert',
  };
}

// CP2: customer_buy_lines apply.
//   1. Filter rows by item_code FK (already filtered no-member at parse).
//   2. UPSERT customers (member_code → customer_id, name, type, enrol_date)
//      BEFORE inserting lines so the customer FK is satisfied. We do not
//      overwrite customers.type from CBv3 (which is per-line numeric flag,
//      not the lifecycle category). primary_store / phone also preserved.
//   3. DELETE existing lines for latest_ym if overwrite, then INSERT.
async function applyCbl(parsed, overwrite, user) {
  if (!parsed.latest_ym) return { source: 'customer_buy_v3_cbl', target_table: 'customer_buy_lines', ok: false, error: 'no rows' };

  const monthRows = parsed.rows.filter(r => r.year_month === parsed.latest_ym);
  const items = await fetchAllItemCodes();
  const validItems = new Set(items.map(r => r.item_code));
  const validRows = [];
  let dropped_unknown_item = 0;
  for (const r of monthRows) {
    if (!validItems.has(r.item_code)) { dropped_unknown_item += 1; continue; }
    validRows.push(r);
  }

  // 2. Customer UPSERT: aggregate one row per unique member_code in this
  //    batch. Pick name/enrol_date from FIRST occurrence (CBv3 is internally
  //    consistent per member so first-wins is fine).
  const custMap = new Map();
  for (const r of validRows) {
    if (custMap.has(r.member_code)) continue;
    custMap.set(r.member_code, {
      customer_id: r.member_code,
      name:        r.customer_name || 'UNKNOWN',
      enrol_date:  r.date_enrol || null,
      updated_at:  new Date().toISOString(),
      // NOTE: customers.updated_by ALTER was denied by safety policy; audit
      //       attribution falls back to sync_log.triggered_by + updated_at.
      //       Owner-owned columns (type, primary_store, phone) preserved.
    });
  }
  const upsertCustomers = [...custMap.values()];
  const resCust = await chunkInsert('customers', upsertCustomers, { onConflict: 'customer_id' });

  // 3. DELETE-then-INSERT for overwrite; UPSERT-on-PK otherwise to be safe.
  if (overwrite) {
    await sb().from('customer_buy_lines').delete().eq('year_month', parsed.latest_ym);
  }
  // Dedupe within batch on PK (year_month, bill_no, item_code) — same item
  // can legitimately appear twice on one bill if POS issued two line items.
  // Sum qty/amt; keep first customer_name/date_enrol.
  const dedupeMap = new Map();
  let dropped_duplicates = 0;
  for (const r of validRows) {
    const k = `${r.year_month}|${r.bill_no}|${r.item_code}`;
    if (dedupeMap.has(k)) {
      const cur = dedupeMap.get(k);
      cur.qty = (+cur.qty || 0) + (+r.qty || 0);
      cur.amt = (+cur.amt || 0) + (+r.amt || 0);
      dropped_duplicates += 1;
    } else {
      dedupeMap.set(k, { ...r });
    }
  }
  const dedupedRows = [...dedupeMap.values()];
  const inserts = dedupedRows.map(r => ({ ...r, updated_by: user.username }));
  const resCbl = await chunkInsert('customer_buy_lines', inserts,
    { onConflict: 'year_month,bill_no,item_code' });

  const source_row_count = dedupedRows.length;
  const source_amt_sum   = dedupedRows.reduce((s, r) => s + (+r.amt || 0), 0);
  const { count: db_actual } = await sb().from('customer_buy_lines')
    .select('*', { count: 'exact', head: true }).eq('year_month', parsed.latest_ym);
  const assertion_failed = source_row_count > 0 && (resCbl.ok / source_row_count) < 0.99;
  return {
    source: 'customer_buy_v3_cbl', target_table: 'customer_buy_lines',
    latest_ym: parsed.latest_ym,
    rows_appended:               resCbl.ok,
    rows_failed:                 resCbl.err,
    first_error:                 resCbl.first_error || resCust.first_error || null,
    rows_dropped_unknown_item:   dropped_unknown_item,
    customers_upserted:          resCust.ok,
    customers_failed:            resCust.err,
    source_row_count, source_amt_sum: +source_amt_sum.toFixed(2),
    db_row_count_after: db_actual, assertion_failed,
    mode: overwrite ? 'overwrite' : 'append',
  };
}

async function applySales(parsed, overwrite, manifestId) {
  if (!parsed.latest_ym) return { ok: false, error: 'no rows' };
  const startOfMonth = parsed.latest_ym + '-01';
  const startOfNext  = (() => {
    const [y, m] = parsed.latest_ym.split('-').map(Number);
    return m === 12 ? `${y+1}-01-01` : `${y}-${String(m+1).padStart(2,'0')}-01`;
  })();
  const monthRows = parsed.rows.filter(r => r.sale_date === startOfMonth);
  const source_row_count = monthRows.length;
  const source_amt_sum   = monthRows.reduce((s, r) => s + (+r.amount || 0), 0);

  if (overwrite) {
    await sb().from('sales').delete().gte('sale_date', startOfMonth).lt('sale_date', startOfNext);
  }
  const res = await chunkInsert('sales', monthRows);

  // Hard rule (Decisions Log 2026-05-12): row-count assertion. If insert
  // ok-count diverges from source row count by more than 1%, flag as
  // failed regardless of PostgREST returning no error. Silent truncation
  // is now caught at write time.
  const ok_pct = source_row_count > 0 ? (res.ok / source_row_count) : 1;
  const assertion_failed = ok_pct < 0.99;

  // Cross-check the actual DB row count for the month after write.
  const { count: db_actual } = await sb().from('sales')
    .select('*', { count: 'exact', head: true })
    .gte('sale_date', startOfMonth).lt('sale_date', startOfNext);

  return {
    source: 'customer_buy_v3', target_table: 'sales', latest_ym: parsed.latest_ym,
    rows_appended: res.ok, rows_failed: res.err,
    first_error: res.first_error || null,
    source_row_count,
    source_amt_sum: +source_amt_sum.toFixed(2),
    db_row_count_after: db_actual,
    assertion_failed,
    mode: overwrite ? 'overwrite' : 'append',
  };
}

async function applyInventory(parsed, overwrite) {
  if (!parsed.snapshot_date) return { ok: false, error: 'no rows' };
  if (overwrite) {
    await sb().from('inventory_snapshots').delete().eq('snapshot_date', parsed.snapshot_date);
  }
  const items = await fetchAllItemCodes();
  const validCodes = new Set(items.map(r => r.item_code));
  const rows = parsed.rows.filter(r => ACTIVE_BRANCHES.has(r.store) && validCodes.has(r.item_code));
  const dropped_no_item = parsed.rows.length - rows.length;
  const source_row_count = rows.length;
  const source_amt_sum   = rows.reduce((s, r) => s + (+r.amount || 0), 0);
  const res = await chunkInsert('inventory_snapshots', rows, { onConflict: 'snapshot_date,store,item_code' });
  const { count: db_actual } = await sb().from('inventory_snapshots')
    .select('*', { count: 'exact', head: true }).eq('snapshot_date', parsed.snapshot_date);
  const assertion_failed = source_row_count > 0 && (res.ok / source_row_count) < 0.99;
  return { source: 'raw_cs', target_table: 'inventory_snapshots',
           snapshot_date: parsed.snapshot_date,
           rows_appended: res.ok, rows_failed: res.err, rows_dropped_fk: dropped_no_item,
           first_error: res.first_error || null,
           source_row_count, source_amt_sum: +source_amt_sum.toFixed(2),
           db_row_count_after: db_actual, assertion_failed,
           mode: overwrite ? 'overwrite' : 'append' };
}

async function applyItems(parsed) {
  // Two-pass items apply (Jym CP1 spec):
  //   1. existing rows (item_code in items) → UPSERT all 13 master cols.
  //      Owner-owned (strategic_push / description_zh / notes) excluded
  //      from payload so they're preserved.
  //   2. new rows → filter by item_status, INSERT survivors (UPSERT
  //      semantically same since they don't exist yet).
  const existing = await fetchAllItemCodes();
  const existingCodes = new Set(existing.map(r => r.item_code));

  const MASTER_COLS = ['open_date','item_status','main_group','sub_group','application',
                       'capacity','clr_finishing','shape_design','brand','prc_range',
                       'movement','country','manufacturer'];

  const upsertsExisting = [];
  const insertsNew = [];
  let filtered_out = 0;
  const new_status_dist = { 'F-FAST': 0, 'N-NORMAL': 0, 'S-SLOW': 0, NULL: 0, OTHER: 0 };

  for (const r of parsed.rows) {
    const obj = { item_code: r.item_code, source: 'sync_sm' };
    for (const k of MASTER_COLS) if (r[k] !== undefined) obj[k] = r[k];
    if (existingCodes.has(r.item_code)) {
      upsertsExisting.push(obj);
    } else {
      const f = itemStatusFilter(r.item_status);
      if (!f.keep) { filtered_out += 1; continue; }
      insertsNew.push(obj);
      new_status_dist[f.bucket] += 1;
    }
  }

  const resExisting = await chunkInsert('items', upsertsExisting, { onConflict: 'item_code' });
  const resNew      = await chunkInsert('items', insertsNew,      { onConflict: 'item_code' });

  return {
    source: 'sm_item_master', target_table: 'items',
    rows_existing_updated: resExisting.ok,
    rows_new_inserted:     resNew.ok,
    rows_filtered_out:     filtered_out,
    new_status_dist,
    rows_failed: resExisting.err + resNew.err,
    rows_appended: resExisting.ok + resNew.ok,
    mode: 'upsert',
  };
}

// ── Handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-wp-user');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ ok: false, error: 'POST only' }); return; }

  // Owner-only middleware.
  const sessionUserName = String(req.headers['x-wp-user'] || '').trim().toLowerCase();
  const user = await loadSessionUser(sessionUserName);
  if (!user) return res.status(401).json({ ok: false, error: 'no session' });
  if (user.role !== 'owner') return res.status(403).json({ ok: false, error: 'owner only' });

  // JS-side timestamp captured once at handler start, used for BOTH
  // started_at + finished_at on every sync_log INSERT/UPDATE — keeps
  // them on the same clock (Postgres NOW() drifts ~700ms from V8 clock).
  const startedAtIso = new Date().toISOString();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }
  }
  const mode             = body?.mode || 'preview';
  const confirmOverwrite = body?.confirm_overwrite || {};
  const onlyTargets      = body?.tables || ALL_TARGETS;

  // 1. Read sources in parallel (network bound). CBv3 feeds BOTH sales
  //    (CP1) and customer_buy_lines (CP2) — one fetch, two transforms.
  //    Floatation = 6 stores' Sheet 1 fetched in parallel inside loadFloatation.
  let parsedSales = null, parsedCbl = null, parsedInv = null, parsedSm = null,
      parsedFloat = null, parsedPoGrn = null, parsedFin = null;
  try {
    const needCbv3 = onlyTargets.includes('sales') || onlyTargets.includes('customer_buy_lines');
    const [a, b, c, d, e2, f] = await Promise.all([
      needCbv3 ? loadCbv3() : Promise.resolve(null),
      onlyTargets.includes('inventory_snapshots') ? loadRawCs()     : Promise.resolve(null),
      onlyTargets.includes('items')               ? loadSm()        : Promise.resolve(null),
      onlyTargets.includes('floatation')          ? loadFloatation(): Promise.resolve(null),
      onlyTargets.includes('po_grn')              ? loadPoGrn()     : Promise.resolve(null),
      onlyTargets.includes('financial')           ? loadFinancial() : Promise.resolve(null),
    ]);
    if (a) {
      if (onlyTargets.includes('sales'))               parsedSales = a.sales;
      if (onlyTargets.includes('customer_buy_lines'))  parsedCbl   = a.cbl;
    }
    parsedInv = b; parsedSm = c; parsedFloat = d; parsedPoGrn = e2; parsedFin = f;
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheet fetch failed: ' + e.message });
  }

  // 2. Preview path: just report deltas, no main-table writes.
  //    Still writes a sync_log row with preview_only=true so the audit
  //    trail captures every preview attempt (per Jym's verification spec).
  if (mode === 'preview') {
    const previews = [];
    // Helper: previewers may return a single object or an array of rows.
    const pushPreview = (p) => {
      if (p == null) return;
      if (Array.isArray(p)) previews.push(...p);
      else previews.push(p);
    };
    if (parsedSales) pushPreview(await previewSales(parsedSales));
    if (parsedInv)   pushPreview(await previewInventory(parsedInv));
    if (parsedSm)    pushPreview(await previewItems(parsedSm));
    if (parsedCbl)   pushPreview(await previewCbl(parsedCbl));        // → 2 rows (CBL + customers)
    if (parsedFloat) pushPreview(await previewFloatation(parsedFloat));
    if (parsedPoGrn) pushPreview(await previewPoGrn(parsedPoGrn));
    if (parsedFin)   pushPreview(await previewFinancial(parsedFin));   // → 3 rows (BS + monthly + brand backlog)
    let preview_log_id = null;
    try {
      const conflicts = {};
      for (const p of previews) {
        if (p && p.action === 'conflict') conflicts[p.target_table] = {
          db_rows: p.db_rows_for_latest_ym ?? p.db_rows_for_snapshot,
          sheet_rows: p.sheet_rows_for_latest_ym ?? p.sheet_rows_for_snapshot,
        };
      }
      const { data: logIns } = await sb().from('sync_log').insert({
        triggered_by: user.username, mode: 'preview',
        sheet_ids: ['CBv3','RawCS','SM'],   // CBv3 feeds sales + customer_buy_lines
        target_tables: onlyTargets,
        status: 'success',
        preview_only: true,
        started_at:  startedAtIso,
        finished_at: new Date().toISOString(),
        conflicts,
      }).select('id').single();
      preview_log_id = logIns?.id || null;
    } catch (e) {
      console.error('[sync] preview log insert failed:', e.message);
    }
    return res.status(200).json({
      ok: true,
      mode: 'preview',
      session_role: user.role,
      previews,
      preview_log_id,
      timestamp: new Date().toISOString(),
    });
  }

  // 3. Apply path: lock, log, backup, apply.
  if (mode !== 'apply') {
    return res.status(400).json({ ok: false, error: `unknown mode "${mode}"` });
  }

  // 3a. Advisory lock — single sync at a time.
  const { data: lockResult } = await sb().rpc('try_sync_lock');
  if (lockResult !== true) {
    return res.status(423).json({ ok: false, error: 'another sync is in progress' });
  }

  // 3b. Open sync_log row (status=running).
  const { data: logIns, error: logErr } = await sb().from('sync_log').insert({
    triggered_by: user.username, mode: 'apply',
    sheet_ids: ['CBv3','RawCS','SM'],   // CBv3 feeds sales + customer_buy_lines
    target_tables: onlyTargets, status: 'running',
    started_at: startedAtIso,
  }).select('id').single();
  if (logErr) {
    await sb().rpc('release_sync_lock');
    return res.status(500).json({ ok: false, error: 'sync_log insert failed: ' + logErr.message });
  }
  const sync_log_id = logIns.id;

  // 3c. Determine which tables actually need writes (preview-aware).
  const targets = [];
  if (parsedSales) {
    const p = await previewSales(parsedSales);
    if (p.action === 'append' || (p.action === 'conflict' && confirmOverwrite.sales))
      targets.push({ table: 'sales', plan: p, overwrite: !!confirmOverwrite.sales });
  }
  if (parsedInv) {
    const p = await previewInventory(parsedInv);
    if (p.action === 'append' || (p.action === 'conflict' && confirmOverwrite.inventory_snapshots))
      targets.push({ table: 'inventory_snapshots', plan: p, overwrite: !!confirmOverwrite.inventory_snapshots });
  }
  if (parsedSm) {
    targets.push({ table: 'items', plan: await previewItems(parsedSm), overwrite: false });
  }
  if (parsedCbl) {
    const cblRows = await previewCbl(parsedCbl);
    const cblRow = (Array.isArray(cblRows) ? cblRows[0] : cblRows);   // first = customer_buy_lines
    if (cblRow.action === 'append' || (cblRow.action === 'conflict' && confirmOverwrite.customer_buy_lines))
      targets.push({ table: 'customer_buy_lines', plan: cblRow, overwrite: !!confirmOverwrite.customer_buy_lines });
  }
  if (parsedFloat) {
    const p = await previewFloatation(parsedFloat);
    // Float apply always runs if there's ANY work to do (latest_new OR backfill).
    // The 'noop' action only fires when both are zero.
    if (p.action === 'append' || p.action === 'conflict' ||
        p.backfill_w11_rows > 0 || p.backfill_other_rows > 0) {
      targets.push({
        table: 'floatation', plan: p,
        overwrite: !!confirmOverwrite.floatation,
      });
    }
  }
  if (parsedPoGrn) {
    const p = await previewPoGrn(parsedPoGrn);
    if (p.action === 'append' || (p.action === 'conflict' && confirmOverwrite.po_grn))
      targets.push({ table: 'po_grn', plan: p, overwrite: !!confirmOverwrite.po_grn });
  }
  if (parsedFin) {
    const finRows = await previewFinancial(parsedFin);
    // financial fans out across 3 preview rows but applies as ONE
    // virtual 'financial' target (loader fills BS + monthly together).
    const anyToAdd = (Array.isArray(finRows) ? finRows : [finRows])
      .some(r => r && r.preview_rows_to_add > 0);
    if (anyToAdd)
      targets.push({ table: 'financial', plan: finRows, overwrite: false });
  }

  // CBL apply UPSERTs customers as a side-effect → must also back up customers.
  const backupTables = new Set(targets.map(t => t.table));
  if (backupTables.has('customer_buy_lines')) backupTables.add('customers');
  // Financial 'target' is a virtual fan-out → 2 real tables. Replace virtual
  // 'financial' entry with the actual table names for backup purposes.
  if (backupTables.has('financial')) {
    backupTables.delete('financial');
    backupTables.add('financial_balance_sheet');
    backupTables.add('financial_monthly');
  }

  if (targets.length === 0) {
    await sb().from('sync_log').update({
      finished_at: new Date().toISOString(),
      status: 'success', rows_appended: {},
    }).eq('id', sync_log_id);
    await sb().rpc('release_sync_lock');
    return res.status(200).json({ ok: true, mode: 'apply', skipped: 'noop (everything up to date or pending overwrite confirm)', sync_log_id });
  }

  // 3d. Backup every target table BEFORE writes (incl. side-effects).
  const suffix = nowSuffix();
  const backups = [];
  for (const tbl of backupTables) {
    try {
      const { data: bk } = await sb().rpc('backup_table', {
        p_src_schema: 'public', p_src_table: tbl, p_suffix: suffix,
      });
      // backup_table can return null for empty tables — coerce to a stub
      // record so manifest.tables_backed_up is never poisoned with nulls.
      backups.push(bk || { table: tbl, rows: 0, backup: null });
    } catch (e) {
      console.error('[sync] backup failed for', tbl, e.message);
      await sb().from('sync_log').update({
        finished_at: new Date().toISOString(),
        status: 'failed', error_msg: 'backup failed: ' + e.message,
      }).eq('id', sync_log_id);
      await sb().rpc('release_sync_lock');
      return res.status(500).json({ ok: false, error: 'backup failed', sync_log_id });
    }
  }
  const { data: manifest, error: manifestErr } = await sb().from('backups_manifest').insert({
    triggered_by: user.username, kind: 'pre_sync',
    tables_backed_up: backups, sync_log_id, notes: `Auto backup before sync ${suffix}`,
  }).select('id').single();
  if (manifestErr) {
    await sb().rpc('release_sync_lock');
    return res.status(500).json({ ok: false, error: 'manifest insert failed: ' + manifestErr.message });
  }
  await sb().from('sync_log').update({ backup_manifest_id: manifest.id }).eq('id', sync_log_id);

  // 3e. Apply each target. One failure does NOT block the others.
  const results = [];
  const appended = {}; const failed = {}; const errorDetails = {};
  for (const t of targets) {
    try {
      let r;
      if (t.table === 'sales')                    r = await applySales(parsedSales, t.overwrite, manifest.id);
      else if (t.table === 'inventory_snapshots') r = await applyInventory(parsedInv, t.overwrite);
      else if (t.table === 'items')               r = await applyItems(parsedSm);
      else if (t.table === 'customer_buy_lines')  r = await applyCbl(parsedCbl, t.overwrite, user);
      else if (t.table === 'floatation')          r = await applyFloatation(parsedFloat, t.overwrite, user);
      else if (t.table === 'po_grn')              r = await applyPoGrn(parsedPoGrn, t.overwrite, user);
      else if (t.table === 'financial')           r = await applyFinancial(parsedFin, t.overwrite, user);
      results.push(r);
      appended[t.table] = r.rows_appended ?? r.rows_upserted ?? 0;
      if (r.rows_failed) failed[t.table] = r.rows_failed;
      if (r.first_error)  errorDetails[t.table] = r.first_error;
    } catch (e) {
      results.push({ target_table: t.table, error: e.message });
      failed[t.table] = 'exception';
      errorDetails[t.table] = { message: e.message, code: 'EXCEPTION' };
    }
  }
  const anyFailed = Object.keys(failed).length > 0;
  const errSummary = Object.keys(errorDetails).length
    ? Object.entries(errorDetails).map(([t, e]) => `${t}: [${e.code || '?'}] ${e.message}`).join(' | ')
    : null;
  await sb().from('sync_log').update({
    finished_at: new Date().toISOString(),
    status: anyFailed ? 'partial' : 'success',
    rows_appended: appended, rows_skipped: failed,
    error_msg: errSummary,
  }).eq('id', sync_log_id);
  await sb().rpc('release_sync_lock');

  return res.status(200).json({
    ok: true, mode: 'apply',
    sync_log_id, backup_manifest_id: manifest.id,
    results, appended, failed, errorDetails,
    timestamp: new Date().toISOString(),
  });
}
