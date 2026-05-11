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
const SHEETS = {
  customer_buy_v3:    { id: '1AjYt9plWymcQMeW4tIZ6A_3QdDlUB_ShreX-d4_mA8s', tab: null,        target: 'sales' },
  raw_cs:             { id: '1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II', tab: 'Raw CS',   target: 'inventory_snapshots' },
  sm_item_master:     { id: '1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II', tab: 'SM',       target: 'items' },
};
const ACTIVE_BRANCHES = new Set(['W01','W02','W03','W05','W07']);

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

async function loadCbv3Sales() {
  const text = await fetchSheetCsv(SHEETS.customer_buy_v3.id, null);
  const grid = parseCsv(text);
  if (!grid.length) return { rows: [], latest_ym: null };
  const hdr = grid[0].map(s => String(s||'').trim().toUpperCase());
  const idx = {}; for (let i = 0; i < hdr.length; i++) idx[hdr[i]] = i;
  const I = {
    MONTH: idx['MONTH'] ?? 0,
    BILL:  idx['BILL']  ?? 1,
    CODE:  idx['ITEM CODE'] ?? 2,
    BR:    idx['BRANCHES']  ?? 3,
    MC:    idx['MEMBER CODE'] ?? 5,
    QTY:   idx['QTY']   ?? 6,
    AMT:   idx['AMT']   ?? 7,
  };
  const rows = [];
  let latestYmKey = -Infinity;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]; if (!r) continue;
    const ym = parseMonthYY(r[I.MONTH]); if (!ym) continue;
    if (ym.y < 2023) continue;          // Notion: cutoff 2023
    const code = String(r[I.CODE] || '').trim(); if (!code) continue;
    const branch = String(r[I.BR] || '').trim();
    const amt = parseNum(r[I.AMT]);
    if (!amt) continue;                  // skip zero-amount lines
    rows.push({
      sale_date:  ymToFirstOfMonth(ym),
      store:      branch || 'WCO',
      item_code:  code,
      qty:        parseNum(r[I.QTY]),
      unit_price: null,                  // can't derive cleanly from CBv3
      amount:     amt,
      customer_id: String(r[I.MC]||'').trim() || null,
      invoice_no: String(r[I.BILL]||'').trim() || null,
      source:     'sync_cbv3',
    });
    const ymKey = ym.y * 12 + ym.m;
    if (ymKey > latestYmKey) latestYmKey = ymKey;
  }
  const latest_ym = latestYmKey > 0
    ? `${Math.floor((latestYmKey-1)/12)}-${String(((latestYmKey-1)%12)+1).padStart(2,'0')}`
    : null;
  return { rows, latest_ym, total_rows: rows.length };
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
  const I = {
    CODE:     idx['ITEM CODE'] ?? idx['STOCK CODE'] ?? 0,
    OPEN:     idx['OPEN DATE'] ?? null,
    STATUS:   idx['ITEM STATUS'] ?? null,
    MAIN:     idx['MAIN GROUP'] ?? null,
    SUB:      idx['SUB GROUP']  ?? null,
    APP:      idx['APPLICATION'] ?? null,
    CAP:      idx['CAPACITY'] ?? null,
    FIN:      idx['CLR FINISHING'] ?? idx['FINISHING'] ?? null,
    SHAPE:    idx['SHAPE DESIGN'] ?? idx['SHAPE'] ?? null,
    BRAND:    idx['BRAND'] ?? null,
    PRC:      idx['PRC RANGE'] ?? idx['PRICE RANGE'] ?? null,
    MOV:      idx['MOVEMENT'] ?? null,
    COUNTRY:  idx['COUNTRY'] ?? null,
    MFR:      idx['MANUFACTURER'] ?? null,
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

async function previewItems(parsed) {
  const { count: dbCount } = await sb().from('items').select('*', { count: 'exact', head: true });
  // Items are an UPSERT (POS-owned fields only). Always safe to re-run.
  return {
    source: 'sm_item_master', target_table: 'items',
    sheet_total_rows: parsed.total_rows,
    db_total_rows: dbCount,
    action: 'upsert',
    preview_rows_to_add: parsed.total_rows - (dbCount || 0),    // approximate
    note: 'Owner-owned columns (strategic_push / description_zh / notes) are NEVER overwritten.',
  };
}

// ── Apply helpers ─────────────────────────────────────────────────────
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
  const { data: items } = await sb().from('items').select('item_code').limit(50000);
  const validCodes = new Set((items || []).map(r => r.item_code));
  const rows = parsed.rows.filter(r => ACTIVE_BRANCHES.has(r.store) && validCodes.has(r.item_code));
  const dropped_no_item = parsed.rows.length - rows.length;
  const res = await chunkInsert('inventory_snapshots', rows, { onConflict: 'snapshot_date,store,item_code' });
  return { source: 'raw_cs', target_table: 'inventory_snapshots',
           snapshot_date: parsed.snapshot_date,
           rows_appended: res.ok, rows_failed: res.err, rows_dropped_fk: dropped_no_item,
           mode: overwrite ? 'overwrite' : 'append' };
}

async function applyItems(parsed) {
  // UPSERT all SM rows. Map to items columns; Owner-owned fields
  // (strategic_push / description_zh / notes) are NOT in the UPSERT
  // payload → preserved on existing rows.
  const upserts = parsed.rows.map(r => {
    const out = { item_code: r.item_code, source: 'sync_sm' };
    for (const k of ['open_date','item_status','main_group','sub_group','application',
                     'capacity','clr_finishing','shape_design','brand','prc_range',
                     'movement','country','manufacturer']) {
      if (r[k] !== undefined) out[k] = r[k];
    }
    return out;
  });
  const res = await chunkInsert('items', upserts, { onConflict: 'item_code' });
  return { source: 'sm_item_master', target_table: 'items',
           rows_upserted: res.ok, rows_failed: res.err, mode: 'upsert' };
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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }
  }
  const mode             = body?.mode || 'preview';
  const confirmOverwrite = body?.confirm_overwrite || {};
  const onlyTargets      = body?.tables || ['sales','inventory_snapshots','items'];

  // 1. Read all 3 sources in parallel (network bound).
  let parsedSales = null, parsedInv = null, parsedSm = null;
  try {
    const [a, b, c] = await Promise.all([
      onlyTargets.includes('sales')               ? loadCbv3Sales() : Promise.resolve(null),
      onlyTargets.includes('inventory_snapshots') ? loadRawCs()     : Promise.resolve(null),
      onlyTargets.includes('items')               ? loadSm()        : Promise.resolve(null),
    ]);
    parsedSales = a; parsedInv = b; parsedSm = c;
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
        sheet_ids: ['CBv3','RawCS','SM'],
        target_tables: onlyTargets,
        status: 'success',
        preview_only: true,
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
    sheet_ids: ['CBv3','RawCS','SM'],
    target_tables: onlyTargets, status: 'running',
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

  if (targets.length === 0) {
    await sb().from('sync_log').update({
      finished_at: new Date().toISOString(),
      status: 'success', rows_appended: {},
    }).eq('id', sync_log_id);
    await sb().rpc('release_sync_lock');
    return res.status(200).json({ ok: true, mode: 'apply', skipped: 'noop (everything up to date or pending overwrite confirm)', sync_log_id });
  }

  // 3d. Backup every target table BEFORE writes.
  const suffix = nowSuffix();
  const backups = [];
  for (const t of targets) {
    try {
      const { data: bk } = await sb().rpc('backup_table', {
        p_src_schema: 'public', p_src_table: t.table, p_suffix: suffix,
      });
      backups.push(bk);
    } catch (e) {
      console.error('[sync] backup failed for', t.table, e.message);
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
      if (t.table === 'sales')               r = await applySales(parsedSales, t.overwrite, manifest.id);
      else if (t.table === 'inventory_snapshots') r = await applyInventory(parsedInv, t.overwrite);
      else if (t.table === 'items')          r = await applyItems(parsedSm);
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
