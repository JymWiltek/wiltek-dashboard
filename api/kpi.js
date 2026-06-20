// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 — /api/kpi merged KPI endpoint
//
// ONE endpoint, MANY views:
//   - Legacy KPI: sales / inventory / customers / floatation / products
//     → backed by mview + RPC (mv_*_kpi_monthly / *_kpi_one_month).
//   - Stage Phase-2 Sales optimization additions:
//     - view=targets        → list monthly_targets for a YM (owner reads all,
//                             manager reads own store only).
//     - view=sales-trend    → 12 months of sales+units (per-branch optional)
//                             for Layer-3 trend charts.
//     - view=sales-daily    → today + WTD + day-by-day current month for the
//                             Layer-1 "today/5 stores" + "WTD vs weekly
//                             target" cards + Layer-3 ramp chart.
//
// Auth (trusted header, V1 pattern):
//   - `x-wp-user: <username>` header.
//   - Owner: any ?branch=, or null = all stores.
//   - Manager: branch forced to own store.
//
// Cache: no-store. Performance: < 500ms p50 except sales-trend (~1s for 12M
// pagination — acceptable for chart on a Layer-3 lazy panel).
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const LEGACY_VIEWS = ['sales', 'inventory', 'customers', 'floatation', 'products'];
const EXT_VIEWS    = ['targets', 'sales-trend', 'sales-daily'];
// Phase 4 Sales V3 (2026-05-19): Tier 1 / Tier 2 views + drill + actions.
const PHASE4_VIEWS = ['sales-owner', 'sales-store', 'sales-drill', 'actions'];
// Phase 5 Owner Overview (2026-05-20): 4-KPI hero.
const PHASE5_VIEWS = ['overview'];
// Phase 6 Customer page (2026-05-21): owner BI customer views.
// Phase 6b (2026-05-21): customer-payload reuses V1's customers_payload RPC
// (age-tier buckets / churn / cross-tab / top100 VIPs) — same Supabase as V1.
// Phase 6c (2026-05-21): age-bucket × category cross-tab (买什么).
const PHASE6_VIEWS = ['customer-overview', 'customer-race', 'customer-matrix', 'customer-trend', 'customer-member', 'customer-payload', 'customer-age-category'];
// Default-month fix (2026-06-17): lightweight months list so the FE defaults
// to the LATEST month present in data instead of a hard-coded value. Not a
// new Vercel function (same kpi.js); needs no ?month param.
// Finance page (2026-06-20): read-only consumer of financial_monthly +
// financial_balance_sheet (another process hand-loads them). Owner-only.
// Dead-stock tracker (2026-06-20): owner + inventory roles. Read-only over the
// latest real inventory snapshot + sales velocity. No ?month param.
const META_VIEWS = ['months', 'finance', 'deadstock'];
const ALLOWED_VIEWS = [...LEGACY_VIEWS, ...EXT_VIEWS, ...PHASE4_VIEWS, ...PHASE5_VIEWS, ...PHASE6_VIEWS, ...META_VIEWS];

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

// ── Helpers: month math (server-side, used by trend/daily views) ─────
function ymLastMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  if (m === 1) return (y - 1) + '-12';
  return y + '-' + String(m - 1).padStart(2, '0');
}
function ymStartDate(ym) { return ym + '-01'; }
function ymEndDate(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0));
  return ym + '-' + String(last.getUTCDate()).padStart(2, '0');
}
function previousNYms(ym, n) {
  // returns array of length n ending at ym (chronological ascending)
  const out = [];
  let cur = ym;
  for (let i = 0; i < n; i++) { out.unshift(cur); cur = ymLastMonth(cur); }
  return out;
}

// ── view=targets ──────────────────────────────────────────────────────
// GET ?view=targets&month=YYYY-MM
//   returns { targets: [{store,target_type,target_value,updated_by,updated_at}, ...],
//             fallback_used: bool,    // if month empty and we used last month
//             fallback_from: 'YYYY-MM' | null,
//             summary: { sales_total, footfall_total, by_store: {W01:{sales,footfall},...}} }
// Manager only sees their own store; owner sees all.
async function handleTargets(req, res, user, ym, queryBranch) {
  const effBranch = user && user.role !== 'owner' ? user.store : (queryBranch || null);
  async function fetchYm(yym) {
    let q = sb().from('monthly_targets')
      .select('store, target_type, target_value, updated_by, updated_at, created_at')
      .eq('ym', yym)
      .order('store').order('target_type');
    if (effBranch) q = q.eq('store', effBranch);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
  let targets = await fetchYm(ym);
  let fallback_used = false;
  let fallback_from = null;
  if (targets.length === 0) {
    const prev = ymLastMonth(ym);
    const prevTargets = await fetchYm(prev);
    if (prevTargets.length > 0) {
      targets = prevTargets.map(t => ({ ...t, ym_source: prev }));
      fallback_used = true;
      fallback_from = prev;
    }
  }
  // Summary
  const by_store = {};
  let sales_total = 0, footfall_total = 0;
  for (const t of targets) {
    if (!by_store[t.store]) by_store[t.store] = { sales: 0, footfall: 0 };
    by_store[t.store][t.target_type] = +t.target_value || 0;
    if (t.target_type === 'sales')    sales_total    += +t.target_value || 0;
    if (t.target_type === 'footfall') footfall_total += +t.target_value || 0;
  }
  res.status(200).json({
    ok: true,
    view: 'targets',
    fetched_at: new Date().toISOString(),
    session_role: user?.role || null,
    session_store: user?.store || null,
    effective_branch: effBranch,
    ym,
    fallback_used,
    fallback_from,
    targets,
    summary: { sales_total, footfall_total, by_store },
  });
}

// ── view=sales-trend ──────────────────────────────────────────────────
// GET ?view=sales-trend&month=YYYY-MM[&branch=W0X]
// Returns 12 months ending at &month, sales + units + invoices per month
// (and per-branch if no branch specified). Used for Layer-3 12M line chart
// + weekly heatmap (requires day-level fallback to sales-daily).
async function handleSalesTrend(req, res, user, ym, queryBranch) {
  const effBranch = user && user.role !== 'owner' ? user.store : (queryBranch || null);
  const ymList = previousNYms(ym, 12); // ascending
  // sales table: amount + qty + invoice_no + sale_date + store. Aggregate
  // by ym = TO_CHAR(sale_date,'YYYY-MM'). We use .range pagination per
  // hard rule (>1000 rows). For 12M company-wide, ~28k sales rows.
  // Strategy: select(store, sale_date, amount, qty, invoice_no), paginate,
  // aggregate client-side. Simpler than relying on a mview that may not
  // exist for this shape.
  const dateFrom = ymStartDate(ymList[0]);
  const dateTo   = ymEndDate(ym);
  const acc = {}; // ym -> { total_sales, total_units, invSet }
  const byBranchYm = {}; // store -> { ym -> { sales, units, invSet } }
  let from = 0; const step = 1000; let pages = 0;
  while (pages < 60) { // safety cap; 60k rows
    let q = sb().from('sales')
      .select('store, sale_date, amount, qty, invoice_no')
      .gte('sale_date', dateFrom)
      .lte('sale_date', dateTo)
      .order('sale_date', { ascending: true })
      .range(from, from + step - 1);
    if (effBranch) q = q.eq('store', effBranch);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      const sd = r.sale_date || '';
      const yy = sd.slice(0, 7);
      if (!acc[yy]) acc[yy] = { sales: 0, units: 0, invSet: new Set() };
      acc[yy].sales += +r.amount || 0;
      acc[yy].units += +r.qty || 0;
      if (r.invoice_no) acc[yy].invSet.add(r.invoice_no);
      if (!effBranch && r.store) {
        if (!byBranchYm[r.store])     byBranchYm[r.store] = {};
        if (!byBranchYm[r.store][yy]) byBranchYm[r.store][yy] = { sales: 0, units: 0, invSet: new Set() };
        byBranchYm[r.store][yy].sales += +r.amount || 0;
        byBranchYm[r.store][yy].units += +r.qty || 0;
        if (r.invoice_no) byBranchYm[r.store][yy].invSet.add(r.invoice_no);
      }
    }
    if (data.length < step) break;
    from += step;
    pages++;
  }
  // shape arrays in the requested 12-ym order
  const series = ymList.map(y => {
    const a = acc[y] || { sales: 0, units: 0, invSet: new Set() };
    return {
      ym: y,
      sales:    +a.sales.toFixed(2),
      units:    a.units,
      invoices: a.invSet.size,
    };
  });
  const branchSeries = {};
  for (const [store, ymMap] of Object.entries(byBranchYm)) {
    branchSeries[store] = ymList.map(y => {
      const a = ymMap[y] || { sales: 0, units: 0, invSet: new Set() };
      return {
        ym: y,
        sales:    +a.sales.toFixed(2),
        units:    a.units,
        invoices: a.invSet.size,
      };
    });
  }
  res.status(200).json({
    ok: true,
    view: 'sales-trend',
    fetched_at: new Date().toISOString(),
    session_role: user?.role || null,
    session_store: user?.store || null,
    effective_branch: effBranch,
    ym,
    ym_window: ymList,
    series,
    branch_series: branchSeries,
    rows_scanned_pages: pages + 1,
  });
}

// ── view=sales-daily ──────────────────────────────────────────────────
// GET ?view=sales-daily&month=YYYY-MM[&branch=W0X]
// Returns:
//   - today: { date, sales, units, invoices, by_branch }
//   - wtd:   { week_start, week_end, sales, units, invoices, by_branch }
//   - days[]: per-day for the requested month (for ramp chart + heatmap)
async function handleSalesDaily(req, res, user, ym, queryBranch) {
  const effBranch = user && user.role !== 'owner' ? user.store : (queryBranch || null);
  const dateFrom = ymStartDate(ym);
  const dateTo   = ymEndDate(ym);
  // Pull all sales for the month. Pagination per hard rule.
  const days = {}; // 'YYYY-MM-DD' -> { sales, units, invSet, byBranch:{store:{sales,units,invSet}} }
  let from = 0; const step = 1000; let pages = 0;
  while (pages < 20) {
    let q = sb().from('sales')
      .select('store, sale_date, amount, qty, invoice_no')
      .gte('sale_date', dateFrom)
      .lte('sale_date', dateTo)
      .order('sale_date', { ascending: true })
      .range(from, from + step - 1);
    if (effBranch) q = q.eq('store', effBranch);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      const d = r.sale_date || '';
      if (!days[d]) days[d] = { sales: 0, units: 0, invSet: new Set(), byBranch: {} };
      days[d].sales += +r.amount || 0;
      days[d].units += +r.qty || 0;
      if (r.invoice_no) days[d].invSet.add(r.invoice_no);
      const st = r.store || '_';
      if (!days[d].byBranch[st]) days[d].byBranch[st] = { sales: 0, units: 0, invSet: new Set() };
      days[d].byBranch[st].sales += +r.amount || 0;
      days[d].byBranch[st].units += +r.qty || 0;
      if (r.invoice_no) days[d].byBranch[st].invSet.add(r.invoice_no);
    }
    if (data.length < step) break;
    from += step;
    pages++;
  }
  // Materialize ordered day list
  const dayList = Object.keys(days).sort();
  const daysOut = dayList.map(d => {
    const a = days[d];
    return {
      date: d,
      sales: +a.sales.toFixed(2),
      units: a.units,
      invoices: a.invSet.size,
      by_branch: Object.fromEntries(Object.entries(a.byBranch).map(([s, v]) => [s, {
        sales: +v.sales.toFixed(2),
        units: v.units,
        invoices: v.invSet.size,
      }])),
    };
  });
  // "Today" = last day in the requested month if month is current/past;
  // if month is in the future or no data, today is empty.
  const todayOut = daysOut.length > 0 ? daysOut[daysOut.length - 1] : null;
  // WTD = last 7 days within the requested month (anchored on todayOut.date)
  let wtdOut = null;
  if (todayOut) {
    const [y, m, d] = todayOut.date.split('-').map(Number);
    const anchor = new Date(Date.UTC(y, m - 1, d));
    const weekStart = new Date(anchor); weekStart.setUTCDate(anchor.getUTCDate() - 6);
    const ws = weekStart.toISOString().slice(0, 10);
    const we = todayOut.date;
    let s = 0, u = 0; const inv = new Set(); const bb = {};
    for (const dd of daysOut) {
      if (dd.date < ws || dd.date > we) continue;
      s += dd.sales; u += dd.units;
      for (const [st, v] of Object.entries(dd.by_branch)) {
        if (!bb[st]) bb[st] = { sales: 0, units: 0, invoices: 0 };
        bb[st].sales    += v.sales;
        bb[st].units    += v.units;
        bb[st].invoices += v.invoices;
      }
    }
    // For invoices we'd need raw invoice_no across days — approximate as sum of unique-per-day.
    // Acceptable for WTD; a small overcount if same invoice spans multiple days (rare).
    const wtdInv = daysOut.filter(dd => dd.date >= ws && dd.date <= we)
      .reduce((acc, dd) => acc + dd.invoices, 0);
    wtdOut = {
      week_start: ws, week_end: we,
      sales: +s.toFixed(2), units: u, invoices: wtdInv,
      by_branch: Object.fromEntries(Object.entries(bb).map(([k, v]) => [k, {
        sales: +v.sales.toFixed(2), units: v.units, invoices: v.invoices,
      }])),
    };
  }
  res.status(200).json({
    ok: true,
    view: 'sales-daily',
    fetched_at: new Date().toISOString(),
    session_role: user?.role || null,
    session_store: user?.store || null,
    effective_branch: effBranch,
    ym,
    today:   todayOut,
    wtd:     wtdOut,
    days:    daysOut,
    rows_scanned_pages: pages + 1,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 4 · Sales Module V3 (Agentic OS · 2-tier) — view handlers
// ═══════════════════════════════════════════════════════════════════════

// Phase 6 — Customer page. V2 Launch Fix 3 (Scheme C):
//   owner / staff (marketing, hr, warehouse) → ALL sub-views, company scope
//     (queryBranch optional, like owner — HQ all-store roles).
//   manager → only the two store-scopable sub-views, FORCED to own store.
//   finance / bi / other → 403 (not in the 9-user set).
async function handleCustomer(req, res, user, ym, view, queryBranch, effectiveBranch) {
  const role = user ? user.role : 'owner';        // null user = legacy owner fallback
  const isOwner   = role === 'owner';
  const isStaff   = role === 'marketing' || role === 'hr' || role === 'warehouse';
  const isManager = role === 'manager';
  const MANAGER_VIEWS = new Set(['customer-race', 'customer-payload']);
  if (isManager && !MANAGER_VIEWS.has(view)) {
    return res.status(403).json({ ok: false, error: 'manager scope' });
  }
  if (!isOwner && !isStaff && !isManager) {
    return res.status(403).json({ ok: false, error: 'role not permitted' });
  }
  // Manager → own store (enforced upstream as effectiveBranch); owner/staff →
  // queryBranch (null = company default).
  const scope = isManager
    ? (effectiveBranch || (user && user.store) || null)
    : (queryBranch || null);
  const map = {
    'customer-overview': { rpc: 'customer_overview_kpi',      args: { p_ym: ym } },
    'customer-race':     { rpc: 'customer_by_race',           args: { p_ym: ym, p_store: scope } },
    'customer-matrix':   { rpc: 'customer_store_race_matrix', args: { p_ym: ym } },
    'customer-trend':    { rpc: 'customer_trend',             args: { p_ym: ym } },
    'customer-member':   { rpc: 'customer_member_analysis',   args: { p_ym: ym } },
    // Phase 6b: V1's full customer dataset (buckets_by_window / churn /
    // cross_by_window / top100). p_branch null = company; manager = own store.
    'customer-payload':  { rpc: 'customers_payload',          args: { p_month: ym, p_branch: scope } },
    // Phase 6c: 会员入会龄段 × 品类 (main_group) 本月销售矩阵.
    'customer-age-category': { rpc: 'customer_age_category_crosstab', args: { p_ym: ym } },
  };
  const spec = map[view];
  if (!spec) return res.status(400).json({ ok: false, error: 'bad customer view' });
  const { data, error } = await sb().rpc(spec.rpc, spec.args);
  if (error) {
    console.error('[/api/kpi ' + view + '] rpc error:', error.message);
    return res.status(200).json({
      ok: true, view, ym,
      degraded: true,
      degraded_reason: spec.rpc + ' RPC missing — apply tools/migration_phase6_customer.sql',
      data: null,
    });
  }
  return res.status(200).json({
    ok: true, view, ym,
    session_role: user?.role || null,
    fetched_at: new Date().toISOString(),
    data,
  });
}

// view=overview — 4-KPI hero. Owner = company (branch null); manager = own store.
// V2 Launch Fix 件1 (2026-05-25): overview_kpi gained p_branch; branch enforced
// upstream (effectiveBranch). p_branch null → company aggregate (unchanged).
async function handleOverview(req, res, user, ym, branch) {
  const { data, error } = await sb().rpc('overview_kpi', { p_ym: ym, p_branch: branch || null });
  if (error) {
    console.error('[/api/kpi overview] rpc error:', error.message);
    return res.status(200).json({
      ok: true, view: 'overview', ym,
      degraded: true,
      degraded_reason: 'overview_kpi RPC missing — apply tools/migration_phase5_overview.sql',
      data: null,
    });
  }
  return res.status(200).json({
    ok: true, view: 'overview', ym,
    session_role:  user?.role  || null,
    session_store: user?.store || null,
    effective_branch: branch || null,
    fetched_at: new Date().toISOString(),
    data,
  });
}

// view=months — distinct months present in sales data, newest-first. The FE
// uses this to (1) populate the month picker and (2) default to the LATEST
// month instead of a hard-coded value. No month/branch param needed; not
// scope-sensitive (the same list for every role). Source: v_total_amt_by_month
// (one row per ym), same view /api/customers uses for months_seen.
async function handleMonths(req, res) {
  // Month-picker fix (2026-06-20): the dropdown must offer EVERY month that has
  // data in ANY source, not just sales. Floatation already has 2026-06 while
  // sales/inventory end at May, so June was previously unselectable. Union the
  // distinct month across sales / floatation / inventory / customers.
  const { data, error } = await sb()
    .from('v_total_amt_by_month')
    .select('ym')
    .order('ym', { ascending: false });
  if (error) {
    console.error('[/api/kpi months] error:', error.message);
    return res.status(200).json({ ok: true, view: 'months', months: [], latest: null,
      degraded: true, degraded_reason: error.message });
  }
  const salesMonths = (data || []).map(r => r.ym).filter(Boolean);
  const ymSet = new Set(salesMonths);
  const toYm = (d) => d ? String(d).slice(0, 7) : null;
  // floatation is the source that carries the current (in-progress) month —
  // raw + small (monthly grain). Inventory/customers via their monthly MVs.
  try { (await sb().from('floatation').select('date')).data?.forEach(r => { const m = toYm(r.date); if (m) ymSet.add(m); }); } catch (_) {}
  try { (await sb().from('mv_inventory_kpi_monthly').select('snapshot_date')).data?.forEach(r => { const m = toYm(r.snapshot_date); if (m) ymSet.add(m); }); } catch (_) {}
  try { (await sb().from('mv_customers_kpi_monthly').select('ym')).data?.forEach(r => { if (r.ym) ymSet.add(r.ym); }); } catch (_) {}
  // months = full union (newest first) so every data-bearing month is selectable.
  // Cap at the current calendar month so sentinel/synthetic future rows (e.g. a
  // 2099-12 placeholder in mv_inventory_kpi_monthly) never reach the picker.
  const now = new Date();
  const curYm = now.getUTCFullYear() + '-' + String(now.getUTCMonth() + 1).padStart(2, '0');
  const months = [...ymSet].filter(m => /^\d{4}-\d{2}$/.test(m) && m <= curYm).sort().reverse();
  // latest (the FE default) stays the latest SALES month so the dashboard opens
  // on a full-data month, not an in-progress one with only footfall.
  const latestSales = salesMonths[0] || months[0] || null;
  // M-6 (2026-06-20): lightweight data-completeness meta for the shared banner
  // across Overview / Inventory / Customers. All cheap single-row probes.
  const meta = { floatation_latest: null, inventory_real_latest: null, financials_latest: null };
  try {
    const { data: fl } = await sb().from('floatation').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
    if (fl) meta.floatation_latest = fl.date;
  } catch (_) { /* best-effort */ }
  try {
    const { data: snap } = await sb().from('inventory_snapshots').select('snapshot_date').eq('is_synthetic', false).order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
    if (snap) meta.inventory_real_latest = snap.snapshot_date;
  } catch (_) { /* best-effort */ }
  try {
    const { data: fin } = await sb().from('financial_monthly').select('year_month').order('year_month', { ascending: false }).limit(1).maybeSingle();
    if (fin) meta.financials_latest = fin.year_month;
  } catch (_) { /* best-effort */ }
  return res.status(200).json({
    ok: true, view: 'months',
    fetched_at: new Date().toISOString(),
    months,                       // full union (newest first) — drives the picker
    available_months: months,     // explicit alias per spec
    latest: latestSales,          // FE default = latest full-data (sales) month
    meta,
  });
}

// view=finance — owner-only. READ-ONLY consumer of financial_monthly +
// financial_balance_sheet (another process hand-loads them; a durable sync owns
// writes later — this handler never writes). Returns: company P&L trend (TOTAL,
// all months), the latest month that has per-branch rows (live stores only),
// the latest COMPLETE balance-sheet snapshot (skips daily partials with no
// cash), and a derived cash-runway. Caveat flags travel with the data.
async function handleFinance(req, res, user) {
  if (!user || user.role !== 'owner') {
    return res.status(403).json({ ok: false, error: 'owner only' });
  }
  const STORES_LIVE = ['W01', 'W02', 'W03', 'W05', 'W07'];
  const { data: monthly, error: mErr } = await sb().from('financial_monthly')
    .select('year_month, net_sales_inv, cogs_inv, gross_profit_inv, total_exp_inv, net_profit_inv')
    .eq('branch', 'TOTAL').order('year_month', { ascending: true });
  if (mErr) {
    return res.status(200).json({ ok: true, view: 'finance', degraded: true, degraded_reason: mErr.message });
  }
  const { data: brAll } = await sb().from('financial_monthly')
    .select('year_month, branch, net_sales_inv, cogs_inv, gross_profit_inv, total_exp_inv, net_profit_inv')
    .in('branch', STORES_LIVE).order('year_month', { ascending: false });
  const branchMonth = (brAll && brAll.length) ? brAll[0].year_month : null;
  const branches = (brAll || []).filter(r => r.year_month === branchMonth);
  // latest COMPLETE balance sheet — daily partial snapshots have cash_total null
  const { data: bsRows } = await sb().from('financial_balance_sheet')
    .select('snap_date, cash_total, stock_value, building, term_loan, overdraft, hire_purchase, oaf, asset_subtotal, loan_subtotal, net_equity, ratio')
    .not('cash_total', 'is', null).order('snap_date', { ascending: false }).limit(1);
  const bs = (bsRows && bsRows[0]) || null;
  // cash runway = cash ÷ avg monthly net BURN over the trailing 3 months that
  // were actually loss-making (net_profit < 0). null if the recent run profits.
  let cash_runway = null;
  if (bs && bs.cash_total != null) {
    const recent = (monthly || []).slice(-3);
    const burns = recent.filter(m => +m.net_profit_inv < 0).map(m => -(+m.net_profit_inv));
    const avgBurn = burns.length ? burns.reduce((a, b) => a + b, 0) / burns.length : null;
    cash_runway = {
      cash: +bs.cash_total,
      monthly_burn: avgBurn != null ? +avgBurn.toFixed(2) : null,
      runway_months: avgBurn ? +(+bs.cash_total / avgBurn).toFixed(1) : null,
      burn_basis: 'avg of negative net_profit over the trailing 3 months',
    };
  }
  return res.status(200).json({
    ok: true, view: 'finance',
    fetched_at: new Date().toISOString(),
    session_role: user.role,
    monthly: monthly || [],
    branch_month: branchMonth,
    branches,
    balance_sheet: bs,
    cash_runway,
    flags: {
      stock_revaluation_months: (monthly || []).filter(m => +m.cogs_inv < 0).map(m => m.year_month),
      branch_sum_ne_total: true,  // per-branch excludes W11/WCO/WEX → never sums to TOTAL
      company_cogs_basis: 'opening + purchases − closing',
      branch_cogs_basis: 'transaction-level cost_of_sales',
    },
  });
}

// view=deadstock — owner + inventory roles. Dead-stock tracker built on the
// corrected value-at-cost (`amount`) of the latest REAL inventory snapshot,
// classified by trailing sales velocity (NOT the 37%-null item_status):
//   Dead   = 0 units sold in the trailing 365 days (or never sold)
//   Slow   = sold within 365d but 0 in the trailing 90d
//   Active = sold in the trailing 90d
// STORES_LIVE only for the headline + live list; warehouse codes are a separate
// bucket, never a store. Read-only; bounded fetches (no new RPC).
// DEADSTOCK_LIVE + computeDeadstock — INLINE (self-contained, no cross-file
// import) so the Vercel function never fails to load. The pure core is mirrored
// in ../lib/deadstock.mjs for tools/deadstock_test.mjs; this copy is the one
// that runs. Must equal the canonical prod SQL (102,182 / 230 @ 2026-05-31):
//   live stores W01/W02/W03/W05/W07, last_sale NULL or > snapshot-365d, no amount filter.
const DEADSTOCK_LIVE = ["W01", "W02", "W03", "W05", "W07"];
function computeDeadstock(invRows, lastSaleMap, snapDate, recovery) {
  const snapMs = new Date(snapDate + "T00:00:00Z").getTime();
  const DAY = 86400000;
  // Dedup by (store,item_code) — guard against any paginated-fetch overlap
  // double-counting amounts (that overlap was the 2.8x inflation bug).
  const seen = new Map();
  for (const r of invRows) {
    const key = r.store + " " + r.item_code;
    if (!seen.has(key)) seen.set(key, r);
  }
  const dead = [];
  for (const r of seen.values()) {
    const ls = lastSaleMap[r.item_code] || null;
    const days = ls ? Math.round((snapMs - new Date(ls + "T00:00:00Z").getTime()) / DAY) : null;
    if (!(days == null || days > 365)) continue;   // Dead = never sold OR > 365d
    dead.push({
      item_code: r.item_code, store: r.store, qty: +r.qty || 0, amount: Math.round(+r.amount || 0),
      last_sold: ls, days_since: days,
      bucket: days == null ? "365+" : days <= 90 ? "0-90" : days <= 180 ? "90-180" : days <= 365 ? "180-365" : "365+",
      is_live: DEADSTOCK_LIVE.includes(r.store),
    });
  }
  dead.sort((a, b) => b.amount - a.amount);
  const live = dead.filter(d => d.is_live);
  const wh = dead.filter(d => !d.is_live);
  const rm = (a) => a.reduce((s, d) => s + d.amount, 0);
  const sku = (a) => new Set(a.map(d => d.item_code)).size;   // DISTINCT item_code, not rows
  const deadRm = rm(live);
  return {
    snapshot_date: snapDate, recovery_rate: recovery,
    headline: { dead_rm: deadRm, dead_sku: sku(live), cash_release: Math.round(deadRm * recovery) },
    live, warehouse: wh, warehouse_rm: rm(wh), warehouse_sku: sku(wh),
  };
}

async function handleDeadstock(req, res, user) {
  const role = user ? user.role : null;
  if (!user || !['owner', 'staff', 'manager', 'marketing', 'hr', 'warehouse'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'inventory roles only' });
  }
  const recovery = (() => { const r = parseFloat(req.query?.rate); return (r > 0 && r <= 1) ? r : 0.5; })();
  // Paginate with a STABLE, unique ORDER so pages never overlap or gap.
  // (.range() without an explicit order is non-deterministic in PostgREST →
  // it was duplicating/dropping rows → a 2.8× inflated dead total. BUG fix.)
  async function fetchAll(builder, orderCol) {
    const out = []; let from = 0; const step = 1000;
    for (let p = 0; p < 40; p++) {
      const { data, error } = await builder().order(orderCol, { ascending: true }).range(from, from + step - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      out.push(...data); if (data.length < step) break; from += step;
    }
    return out;
  }
  try {
    const { data: snapRow } = await sb().from('inventory_snapshots')
      .select('snapshot_date').eq('is_synthetic', false)
      .order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
    const snap = snapRow?.snapshot_date;
    if (!snap) return res.status(200).json({ ok: true, view: 'deadstock', degraded: true, degraded_reason: 'no real snapshot' });

    const lastSale = {};
    (await fetchAll(() => sb().from('v_item_last_sale').select('item_code, last_sale_date'), 'item_code'))
      .forEach(r => { lastSale[r.item_code] = r.last_sale_date; });
    // No amount filter: a dead SKU with 0 value still counts toward dead_sku
    // (matches the canonical DISTINCT item_code = 230); it adds 0 to dead_rm.
    const inv = await fetchAll(() => sb().from('inventory_snapshots')
      .select('id, item_code, store, qty, amount').eq('snapshot_date', snap), 'id');

    const payload = computeDeadstock(inv, lastSale, snap, recovery);

    // descriptions for the dead set (bounded)
    const codes = [...new Set(payload.live.concat(payload.warehouse).map(d => d.item_code))];
    const descr = {};
    for (let i = 0; i < codes.length; i += 300) {
      const { data } = await sb().from('items').select('item_code, description_zh, main_group').in('item_code', codes.slice(i, i + 300));
      (data || []).forEach(it => { descr[it.item_code] = it.description_zh || it.main_group || '—'; });
    }
    payload.live.forEach(d => { d.descr = descr[d.item_code] || '—'; });
    payload.warehouse.forEach(d => { d.descr = descr[d.item_code] || '—'; });

    return res.status(200).json({ ok: true, view: 'deadstock', ...payload });
  } catch (e) {
    console.error('[/api/kpi deadstock]', e.message);
    return res.status(200).json({ ok: true, view: 'deadstock', degraded: true, degraded_reason: e.message });
  }
}

// view=sales-owner — Tier 1 company overview. Owner + HQ staff (all-store roles).
// V2 Launch Fix 3: marketing/hr/warehouse see the same company overview as owner.
async function handleSalesOwner(req, res, user, ym) {
  const role = user ? user.role : 'owner';
  const seeAll = role === 'owner' || role === 'marketing' || role === 'hr' || role === 'warehouse';
  if (!seeAll) {
    return res.status(403).json({ ok: false, error: 'owner only' });
  }
  // Try RPC; if it errors (migration not applied), surface a clean
  // banner-friendly degraded payload so the frontend can show a notice.
  const { data, error } = await sb().rpc('sales_owner_overview', { p_ym: ym });
  if (error) {
    console.error('[/api/kpi sales-owner] rpc error:', error.message);
    return res.status(200).json({
      ok: true, view: 'sales-owner', ym,
      degraded: true,
      degraded_reason: 'sales_owner_overview RPC missing — apply tools/migration_phase4_sales_v3.sql',
      data: null,
    });
  }
  return res.status(200).json({
    ok: true, view: 'sales-owner', ym,
    session_role: user?.role || null,
    fetched_at: new Date().toISOString(),
    data,
  });
}

// view=sales-store — Tier 2 single-store view. Manager pinned, owner free.
async function handleSalesStore(req, res, user, ym, queryBranch) {
  let p_store = queryBranch;
  if (!user || user.role !== 'owner') {
    if (!user || !user.store) return res.status(403).json({ ok: false, error: 'store assignment missing' });
    if (queryBranch && queryBranch !== user.store) {
      return res.status(403).json({ ok: false, error: 'store not allowed' });
    }
    p_store = user.store;
  }
  if (!p_store) return res.status(400).json({ ok: false, error: 'store required (?branch=...)' });
  const { data, error } = await sb().rpc('sales_store_view', { p_store, p_ym: ym });
  if (error) {
    console.error('[/api/kpi sales-store] rpc error:', error.message);
    return res.status(200).json({
      ok: true, view: 'sales-store', ym, store: p_store,
      degraded: true,
      degraded_reason: 'sales_store_view RPC missing — apply migration_phase4_sales_v3.sql',
      data: null,
    });
  }
  return res.status(200).json({
    ok: true, view: 'sales-store', ym, store: p_store,
    session_role: user?.role || null,
    fetched_at: new Date().toISOString(),
    data,
  });
}

// view=sales-drill&dim=category|customer|supplier — 3-RPC dispatcher.
async function handleSalesDrill(req, res, user, ym, queryBranch) {
  const dim = String(req.query?.dim || '').trim().toLowerCase();
  const map = {
    category: 'sales_drill_category',
    customer: 'sales_drill_customer_type',
    supplier: 'sales_drill_supplier',
  };
  if (!map[dim]) {
    return res.status(400).json({ ok: false, error: 'bad dim; allowed: ' + Object.keys(map).join(',') });
  }
  // Manager pins to own store; owner can ?branch=
  let p_store = queryBranch;
  if (user && user.role !== 'owner') {
    if (!user.store) return res.status(403).json({ ok: false, error: 'store assignment missing' });
    p_store = user.store;
  }
  const { data, error } = await sb().rpc(map[dim], { p_ym: ym, p_store: p_store || null });
  if (error) {
    console.error('[/api/kpi sales-drill] rpc error:', error.message);
    return res.status(200).json({
      ok: true, view: 'sales-drill', dim, ym, store: p_store || null,
      degraded: true,
      degraded_reason: map[dim] + ' RPC missing — apply migration_phase4_sales_v3.sql',
      data: null,
    });
  }
  return res.status(200).json({
    ok: true, view: 'sales-drill', dim, ym, store: p_store || null,
    session_role: user?.role || null,
    fetched_at: new Date().toISOString(),
    data,
  });
}

// view=actions — list Action Plan items. Filter by assignee (Tier 2)
// or assigner (Tier 1).
async function handleActions(req, res, user) {
  const assignee = String(req.query?.assignee || '').trim().toLowerCase();
  const assigner = String(req.query?.assigner || '').trim().toLowerCase();
  // RBAC: owner can query anything; non-owner forced to own as assignee
  let filter = {};
  if (user && user.role === 'owner') {
    if (assignee) filter.assignee = assignee;
    if (assigner) filter.assigner = assigner;
  } else if (user) {
    filter.assignee = user.username;
  } else {
    return res.status(401).json({ ok: false, error: 'no session' });
  }
  let q = sb().from('actions_assigned')
    .select('id,module,assigner,assignee,title,description,amount,amount_unit,ddl,severity,status,proposed_ddl,proposed_amount,proposed_note,source_url,source_data,created_at,accepted_at,done_at,rejected_at,done_note')
    .order('created_at', { ascending: false })
    .limit(200);
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { data, error } = await q;
  if (error) {
    return res.status(200).json({
      ok: true, view: 'actions', degraded: true,
      degraded_reason: 'actions_assigned table missing — apply migration',
      actions: [],
    });
  }
  return res.status(200).json({
    ok: true, view: 'actions',
    fetched_at: new Date().toISOString(),
    actions: data || [],
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-wp-user');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET')     { res.status(405).json({ ok: false, error: 'GET only' }); return; }

  const view = String(req.query?.view || '').trim().toLowerCase();
  const ym   = String(req.query?.month || '').trim();
  const queryBranch = String(req.query?.branch || '').trim().toUpperCase();

  if (!ALLOWED_VIEWS.includes(view)) {
    res.status(400).json({ ok: false, error: 'bad view; allowed: ' + ALLOWED_VIEWS.join(',') });
    return;
  }
  // view=actions / view=months don't need month (actions queries
  // actions_assigned directly; months returns the distinct-month list used
  // to resolve the default). All other views require YYYY-MM.
  if (view !== 'actions' && view !== 'months' && view !== 'finance' && view !== 'deadstock' && !/^\d{4}-\d{2}$/.test(ym)) {
    res.status(400).json({ ok: false, error: 'bad month; expected YYYY-MM' });
    return;
  }

  // RBAC
  const sessionUserName = String(req.headers['x-wp-user'] || '').trim().toLowerCase();
  const user = await loadSessionUser(sessionUserName);
  let effectiveBranch = null;
  if (user) {
    if (user.role === 'owner') {
      effectiveBranch = queryBranch || null;
    } else if (!user.store) {
      // V2 Launch Fix 3: staff (marketing/hr/warehouse) are HQ all-store roles
      // with NO store binding → company by default, may pick any branch like
      // owner (no 403).
      effectiveBranch = queryBranch || null;
    } else {
      // Store-bound manager: pinned to own store; reject foreign branch.
      if (queryBranch && queryBranch !== user.store) {
        res.status(403).json({ ok: false, error: 'branch not allowed for this user' });
        return;
      }
      effectiveBranch = user.store;
    }
  } else {
    effectiveBranch = queryBranch || null;
  }

  try {
    // Finance page — owner-only, read-only over financial_* tables
    if (view === 'finance')     return handleFinance(req, res, user);
    // Dead-stock tracker — owner + inventory roles
    if (view === 'deadstock')   return handleDeadstock(req, res, user);
    // Extension views — route to dedicated handlers
    if (view === 'targets')     return handleTargets(req, res, user, ym, queryBranch);
    if (view === 'sales-trend') return handleSalesTrend(req, res, user, ym, queryBranch);
    if (view === 'sales-daily') return handleSalesDaily(req, res, user, ym, queryBranch);
    // Phase 5 — Owner Overview 4-KPI hero
    if (view === 'overview')    return handleOverview(req, res, user, ym, effectiveBranch);
    // Phase 6 — Customer page (owner only)
    if (view.startsWith('customer-')) return handleCustomer(req, res, user, ym, view, queryBranch, effectiveBranch);
    // Phase 4 — Agentic OS Sales V3 dispatch
    if (view === 'sales-owner') return handleSalesOwner(req, res, user, ym);
    if (view === 'sales-store') return handleSalesStore(req, res, user, ym, queryBranch);
    if (view === 'sales-drill') return handleSalesDrill(req, res, user, ym, queryBranch);
    if (view === 'actions')     return handleActions(req, res, user);
    // Meta — distinct months list (drives FE default-month resolution)
    if (view === 'months')      return handleMonths(req, res);

    // Legacy KPI path — single RPC dispatch
    const rpcName = view + '_kpi_one_month';
    const { data, error } = await sb().rpc(rpcName, {
      p_ym: ym,
      p_branch: effectiveBranch,
    });
    if (error) {
      console.error('[/api/kpi] rpc ' + rpcName + ' error:', error.message);
      res.status(500).json({ ok: false, error: error.message, where: rpcName });
      return;
    }

    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      view,
      session_role: user?.role || null,
      session_store: user?.store || null,
      effective_branch: effectiveBranch,
      data: data || {},
    });
  } catch (e) {
    console.error('[/api/kpi] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'kpi handler · view=' + view });
  }
}
