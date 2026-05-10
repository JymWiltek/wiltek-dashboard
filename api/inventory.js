// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Phase 1 — /api/inventory backed by Supabase
//
// Replaces the static `assets/deadstock-data.js` build artefact with a
// live read from the inventory_snapshots + items + sales tables. Returns
// the same window.WP_DEADSTOCK shape so the V1.6 4-state classifier
// (clsV16) and renderInventoryDashboard / renderToday continue to work
// without rendering changes.
//
// Response shape (matches the static asset):
//   {
//     ok, fetched_at, source, snapshot,
//     meta: { generated, snapshot, total_stock, problem_total,
//             problem_pct, active_branches, company_total_stock,
//             company_rows_total },
//     totals: { ACTIVE/SLOW/DEAD/MISPLACED/COMPANY_DEAD: {amount,rows} },
//     by_branch: { W0X: { name, total_stock, problem, problem_pct,
//                          ACTIVE/SLOW/DEAD/MISPLACED/COMPANY_DEAD } },
//     rows:                   [{ code, branch, qty, unit_cost, amount,
//                                last_sale, others_qty, cls, category,
//                                brand, sub, desc }, ...],
//     sku_branch_stock:       { CODE: { W01: qty, ... } },
//     sku_branch_sales_3m:    { CODE: { W01: qty_90d, ... } }
//   }
//
// Auth (x-wp-user header):
//   Manager → rows[] filtered to user.store. by_branch / sku_branch_stock /
//             sku_branch_sales_3m REMAIN company-wide because clsV16 needs
//             company-wide signals (Misplaced detection) and these are
//             aggregate counts only — no PII / customer names.
//   Owner   → unfiltered.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const ACTIVE_BRANCHES = ['W01', 'W02', 'W03', 'W05', 'W07'];
const BRANCH_NAMES = {
  W01: 'W01 Pandan Indah',
  W02: 'W02 Ampang Waterfront',
  W03: 'W03 Wangsa Maju',
  W05: 'W05 Bangi Seksyen 7',
  W07: 'W07 Pandan Jaya',
};

const URL = process.env.WILTEK_SUPABASE_URL;
const KEY = process.env.WILTEK_SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
function sb() {
  if (supabase) return supabase;
  if (!URL || !KEY) throw new Error('Supabase env vars missing');
  supabase = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return supabase;
}

async function loadSessionUser(username) {
  if (!username) return null;
  const { data, error } = await sb().from('users')
    .select('username, role, store, is_active')
    .eq('username', username).maybeSingle();
  if (error || !data || !data.is_active) return null;
  return data;
}

async function fetchAllRows(table, selectStr, filters) {
  const out = [];
  const step = 1000;
  let from = 0;
  while (true) {
    let q = sb().from(table).select(selectStr).range(from, from + step - 1);
    if (filters) for (const f of filters) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < step) break;
    from += step;
  }
  return out;
}

// V1.6 4-state classifier (server-side; matches frontend clsV16). Used to
// populate the legacy r.cls field so renderInventoryDashboard's tab
// counts work. Frontend's clsV16 will ALSO run on top for managers, but
// having r.cls set means owner views render correctly without overlay.
function clsV16({ code, branch, qty }, sku_branch_sales_3m) {
  const branchSales = sku_branch_sales_3m[code] || {};
  let companySold = 0;
  for (const b of Object.keys(branchSales)) companySold += +branchSales[b] || 0;
  if (companySold === 0)               return 'COMPANY_DEAD';   // Dead
  const ownSold = +(branchSales[branch] || 0);
  if (ownSold === 0)                   return 'MISPLACED';      // Misplaced
  return (qty || 0) >= ownSold ? 'SLOW' : 'ACTIVE';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-wp-user');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET')     { res.status(405).json({ ok: false, error: 'GET only' }); return; }

  const sessionUserName = String(req.headers['x-wp-user'] || '').trim().toLowerCase();
  const user = await loadSessionUser(sessionUserName);

  try {
    // 1. Resolve latest snapshot date.
    const { data: snapData, error: snapErr } = await sb()
      .from('inventory_snapshots')
      .select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1);
    if (snapErr || !snapData?.length) {
      res.status(500).json({ ok: false, error: 'no inventory snapshot found' });
      return;
    }
    const snapshotDate = snapData[0].snapshot_date;        // 'YYYY-MM-DD'
    const snapshotYm   = snapshotDate.slice(0, 7);         // 'YYYY-MM'

    // 2. Pull all snapshot rows + items metadata in parallel.
    const [snapRows, items, salesAggRows] = await Promise.all([
      // Inventory snapshot rows for this date — company-wide, branch filter
      // applied later for rows[] only.
      fetchAllRows('inventory_snapshots',
        'snapshot_date, store, item_code, qty, cost, amount',
        [q => q.eq('snapshot_date', snapshotDate)]),
      // Items master for category/brand/sub/desc lookup.
      fetchAllRows('items',
        'item_code, main_group, sub_group, brand, description_zh, item_status'),
      // Per-(item × branch) qty sold in last 90 days from snapshot.
      fetchAllRows('v_sku_qty_by_item_branch_90d',
        'item_code, store, qty_90d').catch(() => null),
    ]);

    // If the 90d view doesn't exist yet, fall back to a direct query.
    let salesByCodeBranch = {};
    if (salesAggRows && salesAggRows.length) {
      for (const r of salesAggRows) {
        if (!salesByCodeBranch[r.item_code]) salesByCodeBranch[r.item_code] = {};
        salesByCodeBranch[r.item_code][r.store] = +r.qty_90d || 0;
      }
    } else {
      // Direct fetch (slower fallback).
      const since = new Date(new Date(snapshotDate).getTime() - 90 * 86400000)
        .toISOString().slice(0, 10);
      const sales90 = await fetchAllRows('sales',
        'item_code, store, qty',
        [q => q.gte('sale_date', since).lte('sale_date', snapshotDate)]);
      for (const r of sales90) {
        if (!ACTIVE_BRANCHES.includes(r.store)) continue;
        if (!salesByCodeBranch[r.item_code]) salesByCodeBranch[r.item_code] = {};
        salesByCodeBranch[r.item_code][r.store] = (salesByCodeBranch[r.item_code][r.store] || 0) + (+r.qty || 0);
      }
    }

    // 3. Build items lookup map.
    const itemMap = new Map();
    for (const it of items) itemMap.set(it.item_code, it);

    // 4. sku_branch_stock — derived from snapRows.
    const sku_branch_stock = {};
    for (const r of snapRows) {
      if (!sku_branch_stock[r.item_code]) sku_branch_stock[r.item_code] = {};
      sku_branch_stock[r.item_code][r.store] = +r.qty || 0;
    }

    // 5. last_sale per code (pre-aggregated view, avoids 60k row scan).
    const lastSaleRows = await fetchAllRows('v_item_last_sale',
      'item_code, last_sale_date', []).catch(() => []);
    const lastSaleByCode = {};
    for (const r of lastSaleRows) lastSaleByCode[r.item_code] = r.last_sale_date;

    // 6. Build rows[] + per-row classification.
    const allRows = [];
    for (const r of snapRows) {
      if (!ACTIVE_BRANCHES.includes(r.store)) continue;
      const it = itemMap.get(r.item_code) || {};
      const cls = clsV16({ code: r.item_code, branch: r.store, qty: r.qty }, salesByCodeBranch);
      // others_qty: sum of qty in OTHER branches for this code.
      const codeStocks = sku_branch_stock[r.item_code] || {};
      let others_qty = 0;
      for (const b of Object.keys(codeStocks)) if (b !== r.store) others_qty += codeStocks[b];
      allRows.push({
        code:       r.item_code,
        branch:     r.store,
        qty:        +r.qty || 0,
        unit_cost:  +r.cost || 0,
        amount:     +r.amount || 0,
        last_sale:  lastSaleByCode[r.item_code] ? lastSaleByCode[r.item_code].slice(0, 7) : null,
        others_qty,
        cls,
        category:   it.main_group || 'Uncategorised',
        brand:      it.brand || null,
        sub:        it.sub_group || null,
        desc:       it.description_zh || null,
      });
    }

    // 7. Aggregates (always company-wide so clsV16 has full signal).
    const totals = { ACTIVE:{rows:0,amount:0}, SLOW:{rows:0,amount:0}, DEAD:{rows:0,amount:0}, MISPLACED:{rows:0,amount:0}, COMPANY_DEAD:{rows:0,amount:0} };
    const by_branch = {};
    for (const br of ACTIVE_BRANCHES) {
      by_branch[br] = {
        name: BRANCH_NAMES[br], total_stock: 0, problem: 0, problem_pct: 0,
        ACTIVE: 0, SLOW: 0, DEAD: 0, MISPLACED: 0, COMPANY_DEAD: 0,
      };
    }
    for (const r of allRows) {
      totals[r.cls].rows  += 1;
      totals[r.cls].amount += r.amount;
      const bb = by_branch[r.branch]; if (!bb) continue;
      bb.total_stock += r.amount;
      bb[r.cls]      += r.amount;
      if (r.cls === 'SLOW' || r.cls === 'MISPLACED' || r.cls === 'DEAD' || r.cls === 'COMPANY_DEAD') {
        bb.problem += r.amount;
      }
    }
    for (const br of ACTIVE_BRANCHES) {
      const bb = by_branch[br];
      bb.problem_pct = bb.total_stock ? Math.round(bb.problem / bb.total_stock * 1000) / 10 : 0;
    }
    for (const k of Object.keys(totals)) totals[k].amount = Math.round(totals[k].amount);
    const company_total_stock = ACTIVE_BRANCHES.reduce((s, br) => s + by_branch[br].total_stock, 0);
    const problem_total       = totals.SLOW.amount + totals.MISPLACED.amount + totals.DEAD.amount + totals.COMPANY_DEAD.amount;
    const problem_pct         = company_total_stock ? Math.round(problem_total / company_total_stock * 1000) / 10 : 0;

    // 8. Manager scoping — filter rows[] only. Aggregates stay company-wide
    //    so the V1.6 classifier and Today's per-branch dist all work.
    let outRows = allRows;
    if (user && user.role === 'manager') {
      outRows = allRows.filter(r => r.branch === user.store);
    }

    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: 'supabase:wiltek-portal',
      session_role: user?.role || null,
      session_store: user?.store || null,
      snapshot: snapshotYm,
      meta: {
        generated: new Date().toISOString(),
        snapshot: snapshotYm,
        total_stock:        Math.round(company_total_stock),
        problem_total:      Math.round(problem_total),
        problem_pct,
        active_branches:    ACTIVE_BRANCHES,
        company_total_stock: Math.round(company_total_stock),
        company_rows_total:  allRows.length,
      },
      totals,
      by_branch,
      rows: outRows,
      sku_branch_stock,
      sku_branch_sales_3m: salesByCodeBranch,
    });
  } catch (e) {
    console.error('[/api/inventory] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'inventory handler' });
  }
}
