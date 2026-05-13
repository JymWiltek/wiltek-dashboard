// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Phase 1 — /api/sales backed by Supabase
//
// Replaces the "Raw sale" Sheet CSV path with three Supabase views:
//   v_sales_by_branch_month  — per-branch per-month total amount
//   v_sku_by_month_branch    — per-SKU per-branch per-month amount + qty
//   v_total_amt_by_month     — total amount per month (5 stores summed)
//
// The PO/GRN default-tab fetch is preserved as-is — that data isn't in
// Supabase yet (Phase 0 only migrated sales/items/customers/etc.) and
// nothing else needed it.
//
// Auth & branch enforcement (V2 Phase 1):
//   - Caller passes `x-wp-user: <username>` header (set by the frontend
//     from window.WP_SESSION.get().userId after /api/login).
//   - Server looks up users.role + users.store via the SERVICE_ROLE key
//     (bypasses RLS).
//   - Owner: query results scoped to ?branch=<X> if provided, else
//     all 5 stores.
//   - Manager: only their own store, regardless of ?branch=. A manager
//     calling ?branch=<other> gets 403.
//
// Phase 2 will replace the trusted-header model with signed JWT.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

// ── Legacy Sheet (PO/GRN matrix from default tab — still served) ──
const SHEET_ID = '1jzLdcCrckXjSrmyrYKQxjhyvq1v5zTp6hf9zUJDo5II';
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
const ACTIVE_BRANCHES = ['W01', 'W02', 'W03', 'W05', 'W07'];
// Sprint 5 P0 v3: SKU detail window reduced from 14 → 3 months. v_sku_by_month_branch
// pagination (45k+ rows for 14 mo) was the new bottleneck after PO/GRN cut.
// 3-mo window = ~10k rows = ~1-2 paginated rounds = <500ms response.
// Older per-SKU detail (>3mo back) loadable via separate query if needed.
const SKU_DETAIL_MONTHS = 3;

// ── Supabase client (service-role; bypasses RLS) ─────────────────────
const URL = process.env.WILTEK_SUPABASE_URL;
const KEY = process.env.WILTEK_SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
function sb() {
  if (supabase) return supabase;
  if (!URL || !KEY) throw new Error('Supabase env vars missing');
  supabase = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return supabase;
}

// ── CSV helpers (PO/GRN tab still parsed from Sheet) ──────────────────
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
function monthLabelToYm(label) {
  if (!label) return null;
  const m = String(label).trim().match(/^([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const mm = MON_TO_NUM[m[1].toLowerCase()]; if (!mm) return null;
  let yy = parseInt(m[2], 10); if (yy < 100) yy = 2000 + yy;
  return `${yy}-${String(mm).padStart(2,'0')}`;
}

// ── Build PO/GRN aggregates from default-tab CSV (unchanged from V1) ──
function buildPoGrnPayload(text) {
  const grid = parseCsv(text);
  if (!grid.length) return null;
  const hdr = grid[0].map(s => String(s||'').trim().toUpperCase());
  if (hdr[0] !== 'MONTH' || hdr[1] !== 'MAIN GROUP') return null;
  const matrix = {};
  const monthsSet = new Set();
  const groupsSet = new Set();
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]; if (!r || r.length < 4) continue;
    const ym = monthLabelToYm(r[0]); if (!ym) continue;
    const grp = String(r[1]||'').trim(); if (!grp) continue;
    if (!matrix[ym]) matrix[ym] = {};
    matrix[ym][grp] = { po: parseNum(r[2]), grn: parseNum(r[3]) };
    monthsSet.add(ym); groupsSet.add(grp);
  }
  const months = [...monthsSet].sort();
  const groups = [...groupsSet].sort();
  const by_month = {};
  for (const m of months) {
    let po = 0, grn = 0;
    for (const g of groups) {
      const c = matrix[m][g]; if (c) { po += c.po; grn += c.grn; }
    }
    by_month[m] = { po: Math.round(po*100)/100, grn: Math.round(grn*100)/100 };
  }
  const by_group = {};
  for (const g of groups) {
    let po = 0, grn = 0;
    for (const m of months) { const c = matrix[m][g]; if (c) { po += c.po; grn += c.grn; } }
    by_group[g] = { po: Math.round(po*100)/100, grn: Math.round(grn*100)/100 };
  }
  let latest_month = months[months.length - 1] || null;
  for (let i = months.length - 1; i >= 0; i--) {
    const t = by_month[months[i]];
    if (t && (t.po > 0 || t.grn > 0)) { latest_month = months[i]; break; }
  }
  return { months, groups, matrix, by_month, by_group, latest_month, rows_n: grid.length - 1 };
}

// ── Session lookup (Phase 1 trusted-header model) ────────────────────
async function loadSessionUser(username) {
  if (!username) return null;
  const { data, error } = await sb().from('users')
    .select('username, role, store, is_active')
    .eq('username', username).maybeSingle();
  if (error || !data || !data.is_active) return null;
  return data;
}

// ── Build sales aggregates from Supabase views ────────────────────────
async function buildSupabaseSalesPayload(allowedBranches, queryBranch) {
  // Sprint 5 P0: use v_sales_kpi_monthly (sales + units + invoices in one
  // pre-aggregated view) instead of separate v_sales_by_branch_month
  // calls. ~280 rows total vs 60,410 raw → p50 < 300ms target.
  let q1 = sb().from('v_sales_kpi_monthly').select('store, ym, sales, units, invoices');
  if (allowedBranches) q1 = q1.in('store', allowedBranches);
  if (queryBranch)     q1 = q1.eq('store', queryBranch);
  const r1 = await q1;
  if (r1.error) throw new Error('v_sales_kpi_monthly: ' + r1.error.message);

  const sales_by_branch_month = {};
  const units_by_branch_month = {};
  const invoices_by_branch_month = {};
  const monthsSet = new Set();
  const branchesSet = new Set();
  for (const row of r1.data) {
    if (!sales_by_branch_month[row.store])    sales_by_branch_month[row.store]    = {};
    if (!units_by_branch_month[row.store])    units_by_branch_month[row.store]    = {};
    if (!invoices_by_branch_month[row.store]) invoices_by_branch_month[row.store] = {};
    sales_by_branch_month[row.store][row.ym]    = +row.sales;
    units_by_branch_month[row.store][row.ym]    = +row.units;
    invoices_by_branch_month[row.store][row.ym] = +row.invoices || 0;
    monthsSet.add(row.ym);
    branchesSet.add(row.store);
  }
  const months_seen = [...monthsSet].sort();
  const branches_seen = [...branchesSet].sort();

  // total_amt_by_month: for a manager this is filtered to their branch
  // (sum of one row per month). For owner without a branch filter, sum
  // across all 5 stores via the view directly.
  const total_amt_by_month = {};
  if (queryBranch || (allowedBranches && allowedBranches.length === 1)) {
    // Manager or owner+single-branch: total per month = single branch amount.
    const onlyBranch = queryBranch || allowedBranches[0];
    for (const ym of months_seen) {
      total_amt_by_month[ym] = +(sales_by_branch_month[onlyBranch] || {})[ym] || 0;
    }
  } else {
    const r2 = await sb().from('v_total_amt_by_month').select('ym, amount');
    if (r2.error) throw new Error('v_total_amt_by_month: ' + r2.error.message);
    for (const row of r2.data) total_amt_by_month[row.ym] = +row.amount;
  }

  // SKU detail — last 14 months only.
  const recent14 = months_seen.slice(-SKU_DETAIL_MONTHS);
  const recent14Set = new Set(recent14);

  // Paginate v_sku_by_month_branch: Supabase .select() default caps at
  // 1000 rows regardless of .limit() — must use .range() chunks. 14 months
  // × 5 stores × ~650 SKUs ≈ 45k rows → previous .limit(50000) silently
  // returned only the first 1000 (caused Sprint 3 Sales bug: KPI 2 units
  // total = 122 instead of 2,340 for 2026-04).
  let allRows = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    // Stable ORDER BY is REQUIRED for .range() pagination — without it,
    // Supabase can re-return the same row in adjacent pages (Sprint 3
    // hotfix v3 bug: 2026-04 qty was 2521 instead of 2242 due to dup'd
    // rows being summed twice).
    let q = sb().from('v_sku_by_month_branch').select('ym, store, code, amount, qty')
      .order('ym').order('store').order('code')
      .range(from, from + PAGE - 1);
    if (allowedBranches) q = q.in('store', allowedBranches);
    if (queryBranch)     q = q.eq('store', queryBranch);
    if (recent14.length) q = q.in('ym', recent14);
    const r = await q;
    if (r.error) throw new Error('v_sku_by_month_branch: ' + r.error.message);
    allRows = allRows.concat(r.data || []);
    if (!r.data || r.data.length < PAGE) break;
    from += PAGE;
    if (from > 200000) break;  // safety stop
  }
  const r3 = { data: allRows };

  const sku_amt_by_month        = {};
  const sku_qty_by_month        = {};
  const sku_amt_by_month_branch = {};
  const sku_qty_by_month_branch = {};
  // Sprint 3 hotfix v4 (revert v2): Wiltek company total = SUM across ALL
  // stores. W11 is hidden in UI dropdown BUT W11 sales DO count toward
  // company sales (Jym 2026-05-12 拍板). Same for WCO/W12/W10/WEX.
  // Per-branch breakdown still has per-store dim for drill-down.
  for (const row of r3.data) {
    if (!recent14Set.has(row.ym)) continue;
    if (!sku_amt_by_month[row.ym]) sku_amt_by_month[row.ym] = {};
    if (!sku_qty_by_month[row.ym]) sku_qty_by_month[row.ym] = {};
    sku_amt_by_month[row.ym][row.code] = (sku_amt_by_month[row.ym][row.code] || 0) + +row.amount;
    sku_qty_by_month[row.ym][row.code] = (sku_qty_by_month[row.ym][row.code] || 0) + +row.qty;
    // Per-branch breakdown
    if (!sku_amt_by_month_branch[row.ym])              sku_amt_by_month_branch[row.ym] = {};
    if (!sku_amt_by_month_branch[row.ym][row.store])   sku_amt_by_month_branch[row.ym][row.store] = {};
    if (!sku_qty_by_month_branch[row.ym])              sku_qty_by_month_branch[row.ym] = {};
    if (!sku_qty_by_month_branch[row.ym][row.store])   sku_qty_by_month_branch[row.ym][row.store] = {};
    sku_amt_by_month_branch[row.ym][row.store][row.code] = +row.amount;
    sku_qty_by_month_branch[row.ym][row.store][row.code] = +row.qty;
  }

  return {
    sales_by_branch_month,
    units_by_branch_month,           // Sprint 5 NEW: per-branch units from view
    invoices_by_branch_month,        // Sprint 5 NEW: per-branch invoice count
    sku_amt_by_month,
    sku_qty_by_month,
    sku_amt_by_month_branch,
    sku_qty_by_month_branch,
    total_amt_by_month,
    months_seen,
    branches_seen,
    n_rows: r3.data.length,
    _raw_ok: true,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-wp-user');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET')     { res.status(405).json({ ok: false, error: 'GET only' }); return; }

  // Session — Phase 1 trusted header. Phase 2 replaces with signed JWT.
  const sessionUserName = String(req.headers['x-wp-user'] || '').trim().toLowerCase();
  const user = await loadSessionUser(sessionUserName);
  if (!user) {
    // Backwards compat: allow legacy CSV-only fetch with no session header.
    // The legacy frontend (pre-Phase-1) doesn't send the header. Returning
    // unscoped data here keeps the static-JSON consumers (assets/) working
    // until Phase 2. The Supabase aggregates path below requires a session.
    // → Strict mode flag could turn this into a 401 in Phase 2.
  }

  const queryBranch = String(req.query?.branch || '').trim().toUpperCase();
  let allowedBranches = null;
  if (user) {
    if (user.role === 'owner') {
      // Sprint 3 hotfix v4: owner sees ALL stores (no white-list). Company
      // sales = SUM across every store in `sales` table (W01-W07 + W11 +
      // W12 + WCO + W10 + WEX). UI dropdown still only lists 5 active +
      // WCO; W11 history is hidden in dropdown but its sales DO count.
      allowedBranches = queryBranch ? [queryBranch] : null;  // null = no .in() filter → all stores
    } else {
      // manager — pinned to their own store regardless of query.
      if (queryBranch && queryBranch !== user.store) {
        res.status(403).json({ ok: false, error: 'branch not allowed for this user' });
        return;
      }
      allowedBranches = [user.store];
    }
  } else {
    // No session — return owner-equivalent shape (legacy compat, all stores).
    allowedBranches = null;
  }

  try {
    // Sprint 5 P0 fix: cut PO/GRN CSV fetch from /api/sales (was 10s
    // bottleneck). Sales endpoint shouldn't aggregate PO/GRN — that's
    // Inventory's concern. Consumers needing PO/GRN: use po_grn table
    // (Sprint 1) or /api/proxy?type=stock. Backward-compat: keep the
    // shape with empty arrays so legacy renderers don't crash.
    const sbAgg = await buildSupabaseSalesPayload(allowedBranches, queryBranch || null).catch(e => {
      console.error('[/api/sales] Supabase agg error:', e.message);
      return null;
    });

    if (!sbAgg) {
      res.status(500).json({ ok: false, error: 'sales aggregates unavailable' });
      return;
    }

    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: 'supabase:wiltek-portal',
      session_role: user?.role || null,
      session_store: user?.store || null,
      ...sbAgg,
      active_branches: ACTIVE_BRANCHES,
      // PO/GRN cut from /api/sales (Sprint 5 P0). Shape kept empty for
      // back-compat. Use /api/proxy?type=stock for PO/GRN matrix.
      months: [], groups: [], matrix: [], by_month: {}, by_group: {},
      latest_month: null, po_grn_rows: 0,
      po_grn_unavailable: 'cut_in_sprint5_use_proxy_or_po_grn_table',
    });
  } catch (e) {
    console.error('[/api/sales] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'sales handler' });
  }
}
