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
const ALLOWED_VIEWS = [...LEGACY_VIEWS, ...EXT_VIEWS];

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
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    res.status(400).json({ ok: false, error: 'bad month; expected YYYY-MM' });
    return;
  }

  // RBAC
  const sessionUserName = String(req.headers['x-wp-user'] || '').trim().toLowerCase();
  const user = await loadSessionUser(sessionUserName);
  let effectiveBranch = null;
  if (user) {
    if (user.role === 'owner') effectiveBranch = queryBranch || null;
    else {
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
    // Extension views — route to dedicated handlers
    if (view === 'targets')     return handleTargets(req, res, user, ym, queryBranch);
    if (view === 'sales-trend') return handleSalesTrend(req, res, user, ym, queryBranch);
    if (view === 'sales-daily') return handleSalesDaily(req, res, user, ym, queryBranch);

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
