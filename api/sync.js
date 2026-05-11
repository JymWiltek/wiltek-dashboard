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
};
const ACTIVE_BRANCHES = new Set(['W01','W02','W03','W05','W07']);
// CP2: customer_buy_lines / customers UPSERT side-effect when CBL applies.
const ALL_TARGETS = ['sales','inventory_snapshots','items','customer_buy_lines'];

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
  if (!s) return null;
  s = String(s).trim(); if (!s || s === '-') return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y = 2000 + y;
    return `${y}-${String(+m[1]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;
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
  // Raw CS columns per Notion: Stock Code / Branch / Qty / Unit Cost / On Hand (Qty × Cost)
  const I = {
    CODE: idx['STOCK CODE'] ?? idx['ITEM CODE'] ?? 0,
    BR:   idx['BRANCH']     ?? idx['BRANCHES'] ?? 1,
    QTY:  idx['QTY']        ?? 2,
    UC:   idx['UNIT COST']  ?? 3,
    AMT:  idx['ON HAND']    ?? idx['AMOUNT']  ?? 4,
  };
  // Snapshot date: per Notion, the Raw CS tab is the previous month's
  // closing stock. Inferred as last day of (current month - 1) at sync time.
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
  return { rows, snapshot_date, total_rows: rows.length };
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

// CP2: customer_buy_lines preview. Aggregates expected by Jym:
//   - sheet_rows_for_latest_ym + db_rows_for_latest_ym (incremental)
//   - dropped_no_member (parse-time, walk-in/anomaly)
//   - dropped_unknown_item (items FK check)
//   - members_seen / new_members (UPSERT side-effect counts)
async function previewCbl(parsed) {
  if (!parsed.latest_ym) {
    return { source: 'customer_buy_v3_cbl', target_table: 'customer_buy_lines',
             sheet_total_rows: 0, action: 'noop', preview_rows_to_add: 0 };
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
    // Page through .in() in chunks of 500 to avoid query-length explosion.
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

  return {
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
  };
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
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const q = sb().from(table).upsert(chunk, opts.onConflict ? { onConflict: opts.onConflict, ignoreDuplicates: false } : {});
    const { error } = await q;
    if (error) { err += chunk.length; console.error(`[sync] ${table} chunk ${i}: ${error.message}`); }
    else       { ok  += chunk.length; }
  }
  return { ok, err };
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
  const inserts = validRows.map(r => ({ ...r, updated_by: user.username }));
  const resCbl = await chunkInsert('customer_buy_lines', inserts,
    { onConflict: 'year_month,bill_no,item_code' });

  return {
    source: 'customer_buy_v3_cbl', target_table: 'customer_buy_lines',
    latest_ym: parsed.latest_ym,
    rows_appended:               resCbl.ok,
    rows_failed:                 resCbl.err,
    rows_dropped_unknown_item:   dropped_unknown_item,
    customers_upserted:          resCust.ok,
    customers_failed:            resCust.err,
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

  if (overwrite) {
    await sb().from('sales').delete().gte('sale_date', startOfMonth).lt('sale_date', startOfNext);
  }
  // INSERT (no UPSERT — sales has BIGSERIAL PK + no natural unique key)
  const res = await chunkInsert('sales', monthRows);
  return { source: 'customer_buy_v3', target_table: 'sales', latest_ym: parsed.latest_ym,
           rows_appended: res.ok, rows_failed: res.err, mode: overwrite ? 'overwrite' : 'append' };
}

async function applyInventory(parsed, overwrite) {
  if (!parsed.snapshot_date) return { ok: false, error: 'no rows' };
  if (overwrite) {
    await sb().from('inventory_snapshots').delete().eq('snapshot_date', parsed.snapshot_date);
  }
  // Filter to active branches + ensure item_code exists in items (FK).
  const items = await fetchAllItemCodes();
  const validCodes = new Set(items.map(r => r.item_code));
  const rows = parsed.rows.filter(r => ACTIVE_BRANCHES.has(r.store) && validCodes.has(r.item_code));
  const dropped_no_item = parsed.rows.length - rows.length;
  const res = await chunkInsert('inventory_snapshots', rows, { onConflict: 'snapshot_date,store,item_code' });
  return { source: 'raw_cs', target_table: 'inventory_snapshots',
           snapshot_date: parsed.snapshot_date,
           rows_appended: res.ok, rows_failed: res.err, rows_dropped_fk: dropped_no_item,
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
  let parsedSales = null, parsedCbl = null, parsedInv = null, parsedSm = null;
  try {
    const needCbv3 = onlyTargets.includes('sales') || onlyTargets.includes('customer_buy_lines');
    const [a, b, c] = await Promise.all([
      needCbv3 ? loadCbv3() : Promise.resolve(null),
      onlyTargets.includes('inventory_snapshots') ? loadRawCs() : Promise.resolve(null),
      onlyTargets.includes('items')               ? loadSm()    : Promise.resolve(null),
    ]);
    if (a) {
      if (onlyTargets.includes('sales'))               parsedSales = a.sales;
      if (onlyTargets.includes('customer_buy_lines'))  parsedCbl   = a.cbl;
    }
    parsedInv = b; parsedSm = c;
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheet fetch failed: ' + e.message });
  }

  // 2. Preview path: just report deltas, no main-table writes.
  //    Still writes a sync_log row with preview_only=true so the audit
  //    trail captures every preview attempt (per Jym's verification spec).
  if (mode === 'preview') {
    const previews = [];
    if (parsedSales) previews.push(await previewSales(parsedSales));
    if (parsedInv)   previews.push(await previewInventory(parsedInv));
    if (parsedSm)    previews.push(await previewItems(parsedSm));
    if (parsedCbl)   previews.push(await previewCbl(parsedCbl));
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
    const p = await previewCbl(parsedCbl);
    if (p.action === 'append' || (p.action === 'conflict' && confirmOverwrite.customer_buy_lines))
      targets.push({ table: 'customer_buy_lines', plan: p, overwrite: !!confirmOverwrite.customer_buy_lines });
  }

  // CBL apply UPSERTs customers as a side-effect → must also back up customers.
  const backupTables = new Set(targets.map(t => t.table));
  if (backupTables.has('customer_buy_lines')) backupTables.add('customers');

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
      backups.push(bk);
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
  const appended = {}; const failed = {};
  for (const t of targets) {
    try {
      let r;
      if (t.table === 'sales')                    r = await applySales(parsedSales, t.overwrite, manifest.id);
      else if (t.table === 'inventory_snapshots') r = await applyInventory(parsedInv, t.overwrite);
      else if (t.table === 'items')               r = await applyItems(parsedSm);
      else if (t.table === 'customer_buy_lines')  r = await applyCbl(parsedCbl, t.overwrite, user);
      results.push(r);
      appended[t.table] = r.rows_appended ?? r.rows_upserted ?? 0;
      if (r.rows_failed) failed[t.table] = r.rows_failed;
    } catch (e) {
      results.push({ target_table: t.table, error: e.message });
      failed[t.table] = 'exception';
    }
  }
  const anyFailed = Object.keys(failed).length > 0;
  await sb().from('sync_log').update({
    finished_at: new Date().toISOString(),
    status: anyFailed ? 'partial' : 'success',
    rows_appended: appended, rows_skipped: failed,
  }).eq('id', sync_log_id);
  await sb().rpc('release_sync_lock');

  return res.status(200).json({
    ok: true, mode: 'apply',
    sync_log_id, backup_manifest_id: manifest.id,
    results, appended, failed,
    timestamp: new Date().toISOString(),
  });
}
