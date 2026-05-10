// ═══════════════════════════════════════════════════════════════════════
// Wiltek Portal V2 Phase 1 — /api/customers backed by Supabase
//
// Replaces the Customer Buy CSV path. Source data now lives in:
//   v_member_purchases         per-member × store × ym (amount + visits)
//   v_member_purchases_by_cat  same + main_group (used by V1.7 intent)
//   loyalty_v17_for_branch()   Postgres function — DYNAMIC per-purchase
//                              segmentation (New/Mid/Veteran by
//                              span_months at purchase time)
//
// Auth model (Phase 1 trusted x-wp-user header):
//   - Manager: data scoped to user.store (sales_by_branch_month etc.
//     contain only the manager's store; loyalty_v17_by_branch has only
//     the user's branch).
//   - Owner: data spans all 5 active stores; loyalty_v17_by_branch
//     populated for all 5 stores (parallel RPC calls).
//
// Response shape preserves the existing /api/customers contract exactly,
// so the frontend (renderCustomersManagerV17, V1.7 lapsed radar, V1.8
// cache layer) continues to work without changes.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const ACTIVE_BRANCHES = ['W01', 'W02', 'W03', 'W05', 'W07'];
const BUCKETS = ['<1y', '1-5y', '5-8y', '8y+'];
const TYPES   = ['Walk-in', 'Contractor', 'Interior Designer', 'Other'];
const WINDOWS = ['1m', '3m', '6m', '12m'];

const URL = process.env.WILTEK_SUPABASE_URL;
const KEY = process.env.WILTEK_SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
function sb() {
  if (supabase) return supabase;
  if (!URL || !KEY) throw new Error('Supabase env vars missing');
  supabase = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return supabase;
}

// ── helpers ───────────────────────────────────────────────────────────
function ymKeyFromStr(ymStr) {
  // 'YYYY-MM' → integer key (year*12 + month-1)
  const [y, m] = ymStr.split('-').map(Number);
  return y * 12 + (m - 1);
}
function ymStrFromKey(k) {
  const y = Math.floor(k / 12); const m = (k % 12) + 1;
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}`;
}
function ageBucket(years) {
  if (years < 1) return '<1y';
  if (years < 5) return '1-5y';
  if (years < 8) return '5-8y';
  return '8y+';
}
async function fetchAllRows(table, selectStr, filters) {
  // Paginate past the 1000-row default. service_role still respects
  // the implicit Range cap unless we do .range().
  const rows = [];
  const step = 1000;
  let from = 0;
  while (true) {
    let q = sb().from(table).select(selectStr).range(from, from + step - 1);
    if (filters) for (const f of filters) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < step) break;
    from += step;
  }
  return rows;
}

// ── Session lookup (Phase 1 trusted-header model) ─────────────────────
async function loadSessionUser(username) {
  if (!username) return null;
  const { data, error } = await sb().from('users')
    .select('username, role, store, is_active')
    .eq('username', username).maybeSingle();
  if (error || !data || !data.is_active) return null;
  return data;
}

// ── Build payload from Supabase data ─────────────────────────────────
async function buildPayload(snapshotYm, allowedBranch) {
  // snapshotYm = 'YYYY-MM'. allowedBranch = 'W05' or null (=all branches).
  const k_now = ymKeyFromStr(snapshotYm);
  const k_ltm = k_now - 11;
  const k_m6  = k_now - 5;
  const k_m3  = k_now - 2;
  const k_m1  = k_now;

  // Pull all data we need in parallel.
  const [memPurchases, customers, latestMembers] = await Promise.all([
    // v_member_purchases — rows per (customer × branch × ym).
    fetchAllRows('v_member_purchases', 'customer_id, branch, ym, amount, visits',
      allowedBranch ? [q => q.eq('branch', allowedBranch)] : []),
    fetchAllRows('customers', 'customer_id, name, type, primary_store, enrol_date'),
    // Last sale date per member at any branch (for `last` field).
    null,   // computed below from memPurchases (faster than separate query)
  ]);

  // Index customers by id.
  const cMap = new Map();
  for (const c of customers) cMap.set(c.customer_id, c);

  // Member master (per-customer aggregates relative to snapshot).
  // We only consider customers whose primary_store matches when scoped.
  const mem = new Map();
  for (const r of memPurchases) {
    const ymk = ymKeyFromStr(r.ym);
    if (!mem.has(r.customer_id)) {
      mem.set(r.customer_id, {
        amt: 0, visits: 0,
        ltm_amt: 0, ltm_visits: 0,
        m6_amt:  0, m6_visits:  0,
        m3_amt:  0, m3_visits:  0,
        m1_amt:  0, m1_visits:  0,
        last: null,
        branches: {},
      });
    }
    const d = mem.get(r.customer_id);
    d.amt    += +r.amount;
    d.visits += +r.visits;
    if (d.last == null || ymk > d.last) d.last = ymk;
    d.branches[r.branch] = (d.branches[r.branch] || 0) + +r.amount;
    if (ymk >= k_ltm) { d.ltm_amt += +r.amount; d.ltm_visits += +r.visits; }
    if (ymk >= k_m6)  { d.m6_amt  += +r.amount; d.m6_visits  += +r.visits; }
    if (ymk >= k_m3)  { d.m3_amt  += +r.amount; d.m3_visits  += +r.visits; }
    if (ymk === k_m1) { d.m1_amt  += +r.amount; d.m1_visits  += +r.visits; }
  }

  // Build ci_rows (customer master).
  const ci_rows = [];
  for (const [mc, d] of mem) {
    const c = cMap.get(mc);
    if (!c || !c.enrol_date) continue;
    if (allowedBranch && c.primary_store !== allowedBranch) continue;
    if (!ACTIVE_BRANCHES.includes(c.primary_store) && !allowedBranch) {
      // Skip non-active-store customers when serving owner overview, to
      // mirror the legacy /api/customers behaviour.
      continue;
    }
    const enrolDt = new Date(c.enrol_date + 'T00:00:00Z');
    const eom = new Date(Date.UTC(+snapshotYm.slice(0,4), +snapshotYm.slice(5,7), 0));
    const years = (eom - enrolDt) / (1000 * 60 * 60 * 24 * 365.25);
    if (years < 0) continue;
    const lastY = Math.floor(d.last / 12), lastM = (d.last % 12) + 1;
    ci_rows.push({
      mc: String(mc),
      name: (c.name || '').slice(0, 40) || String(mc),
      branch: c.primary_store,
      cust_type: c.type || 'Other',
      enrol: c.enrol_date,
      age_years: Math.round(years * 10) / 10,
      age_bucket: ageBucket(years),
      ltm_amt: Math.round(d.ltm_amt),
      ltm_visits: d.ltm_visits,
      m6_amt: Math.round(d.m6_amt),
      m6_visits: d.m6_visits,
      m3_amt: Math.round(d.m3_amt),
      m3_visits: d.m3_visits,
      m1_amt: Math.round(d.m1_amt),
      m1_visits: d.m1_visits,
      lifetime_amt: Math.round(d.amt),
      last: ymStrFromKey(d.last),
    });
  }

  // ── Buckets per window ──
  const amtField = w => ({'1m':'m1_amt','3m':'m3_amt','6m':'m6_amt','12m':'ltm_amt'})[w];
  const visField = w => ({'1m':'m1_visits','3m':'m3_visits','6m':'m6_visits','12m':'ltm_visits'})[w];

  const buckets_by_window = {};
  for (const w of WINDOWS) {
    const af = amtField(w), vf = visField(w);
    const bagg = {};
    for (const b of BUCKETS) bagg[b] = { n: 0, amt: 0, visits: 0, n_repeat: 0, n_active: 0 };
    for (const r of ci_rows) {
      const cell = bagg[r.age_bucket]; if (!cell) continue;
      cell.n += 1;
      cell.amt += r[af];
      cell.visits += r[vf];
      if (r[vf] >= 1) cell.n_active += 1;
      if (r[vf] >= 2) cell.n_repeat += 1;
    }
    buckets_by_window[w] = BUCKETS.map(b => {
      const v = bagg[b];
      return {
        key: b, n: v.n, amt: Math.round(v.amt),
        aov: v.visits ? Math.round(v.amt / v.visits) : 0,
        repeat_pct: v.n_active ? Math.round(1000 * v.n_repeat / v.n_active) / 10 : 0,
        n_active: v.n_active,
      };
    });
  }

  // ── cross_by_window ──
  const cross_by_window = {};
  for (const w of WINDOWS) {
    const af = amtField(w);
    const cr = {};
    for (const tp of TYPES) { cr[tp] = {}; for (const b of BUCKETS) cr[tp][b] = { n: 0, amt: 0 }; }
    for (const r of ci_rows) {
      const tp = TYPES.includes(r.cust_type) ? r.cust_type : 'Other';
      const cell = cr[tp][r.age_bucket]; if (!cell) continue;
      cell.n += 1;
      cell.amt += r[af];
    }
    for (const tp of TYPES) for (const b of BUCKETS) cr[tp][b].amt = Math.round(cr[tp][b].amt);
    cross_by_window[w] = cr;
  }

  // ── top100 ──
  const top100 = [...ci_rows].sort((a, b) => b.ltm_amt - a.ltm_amt).slice(0, 100);

  // ── summary per window ──
  function summaryFor(w) {
    const af = amtField(w);
    const total_n = ci_rows.length;
    const n_5plus = ci_rows.filter(r => r.age_bucket === '5-8y' || r.age_bucket === '8y+').length;
    let total_amt = 0, amt_5plus = 0, n_active = 0;
    for (const r of ci_rows) {
      total_amt += r[af];
      if (r.age_bucket === '5-8y' || r.age_bucket === '8y+') amt_5plus += r[af];
      if (r[af] > 0) n_active += 1;
    }
    return {
      total_members: total_n, n_active,
      n_lt1: ci_rows.filter(r => r.age_bucket === '<1y').length,
      n_1_5: ci_rows.filter(r => r.age_bucket === '1-5y').length,
      n_5_8: ci_rows.filter(r => r.age_bucket === '5-8y').length,
      n_8plus: ci_rows.filter(r => r.age_bucket === '8y+').length,
      amt_total: Math.round(total_amt),
      pct_5plus_n: total_n ? Math.round(1000 * n_5plus / total_n) / 10 : 0,
      pct_5plus_amt: total_amt ? Math.round(1000 * amt_5plus / total_amt) / 10 : 0,
    };
  }
  const summary_by_window = {};
  for (const w of WINDOWS) summary_by_window[w] = summaryFor(w);
  const summary = { ...summary_by_window['12m'], snapshot: snapshotYm };

  // ── summary_by_month + buckets_by_month ──
  const summary_by_month = {};
  const buckets_by_month = {};
  // Build per-month rows quickly from memPurchases.
  const rowsByYm = {};
  for (const r of memPurchases) {
    if (!rowsByYm[r.ym]) rowsByYm[r.ym] = [];
    rowsByYm[r.ym].push(r);
  }
  const ciByMc = new Map(ci_rows.map(c => [c.mc, c]));
  for (const ym of Object.keys(rowsByYm)) {
    const ymRows = rowsByYm[ym];
    let amt = 0, members = new Set();
    const bagg = {}; for (const b of BUCKETS) bagg[b] = { n: new Set(), amt: 0 };
    for (const r of ymRows) {
      amt += +r.amount;
      members.add(r.customer_id);
      const ci = ciByMc.get(String(r.customer_id));
      if (!ci) continue;
      const cell = bagg[ci.age_bucket]; if (!cell) continue;
      cell.amt += +r.amount;
      cell.n.add(r.customer_id);
    }
    for (const b of BUCKETS) { bagg[b].n = bagg[b].n.size; bagg[b].amt = Math.round(bagg[b].amt); }
    summary_by_month[ym] = {
      total_members: ci_rows.length,
      n_active: members.size,
      amt_total: Math.round(amt),
      n_lt1: bagg['<1y'].n, n_1_5: bagg['1-5y'].n, n_5_8: bagg['5-8y'].n, n_8plus: bagg['8y+'].n,
      amt_lt1: bagg['<1y'].amt, amt_1_5: bagg['1-5y'].amt, amt_5_8: bagg['5-8y'].amt, amt_8plus: bagg['8y+'].amt,
      snapshot: ym,
    };
    buckets_by_month[ym] = BUCKETS.map(b => ({
      key: b, n: bagg[b].n, amt: bagg[b].amt,
      aov: bagg[b].n ? Math.round(bagg[b].amt / bagg[b].n) : 0,
      repeat_pct: 0, n_active: bagg[b].n,
    }));
  }

  // ── churn ──
  const k_churn = k_now - 5;
  const churned = [];
  for (const r of ci_rows) {
    const lastK = ymKeyFromStr(r.last);
    if (lastK >= k_churn) continue;        // last activity within 5 months → not churned
    if (r.lifetime_amt < 500) continue;
    if (r.ltm_visits < 2 && r.m6_visits < 2 && r.m3_visits < 2 && r.m1_visits < 2) {
      // Use memPurchases visits if needed; for the churn list we use lifetime
      // visits derived from sum. Approximate via aggregate:
      // (we don't have lifetime visits independently; ltm_visits is a proxy.
      //  In practice visits >= 2 should be the lifetime sum, computed below).
    }
    const memRec = mem.get(r.mc);
    if (!memRec || memRec.visits < 2) continue;
    const months_ago = k_now - lastK;
    churned.push({
      mc: r.mc, name: r.name, last: r.last, months_ago,
      amount: r.lifetime_amt, visits: memRec.visits,
      loyalty: '', branch: r.branch, cust_type: r.cust_type,
    });
  }
  churned.sort((a, b) => b.amount - a.amount);
  const high_value_churn = churned.filter(c => c.amount >= 1000);
  const total_high_value_lifetime = high_value_churn.reduce((s, c) => s + c.amount, 0);

  // ── sales_by_branch_month (for backward compat with consumers) ──
  const sales_by_branch_month = {};
  for (const r of memPurchases) {
    if (!sales_by_branch_month[r.branch]) sales_by_branch_month[r.branch] = {};
    sales_by_branch_month[r.branch][r.ym] = (sales_by_branch_month[r.branch][r.ym] || 0) + +r.amount;
  }
  for (const br of Object.keys(sales_by_branch_month)) {
    for (const ym of Object.keys(sales_by_branch_month[br])) {
      sales_by_branch_month[br][ym] = Math.round(sales_by_branch_month[br][ym]);
    }
  }

  // ── loyalty_v17_by_branch (RPC per branch) ──
  const branchesForLoyalty = allowedBranch ? [allowedBranch] : ACTIVE_BRANCHES;
  const loyalty_v17_by_branch = {};
  await Promise.all(branchesForLoyalty.map(async (br) => {
    const { data, error } = await sb().rpc('loyalty_v17_for_branch', {
      p_branch: br, snap_ym: snapshotYm,
    });
    if (error) {
      console.error(`[loyalty_v17_for_branch] ${br}: ${error.message}`);
      loyalty_v17_by_branch[br] = null;
    } else {
      loyalty_v17_by_branch[br] = data;
    }
  }));

  return {
    summary,
    summary_by_window,
    summary_by_month,
    buckets_by_window,
    buckets_by_month,
    cross_by_window,
    sales_by_branch_month,
    top100,
    windows: WINDOWS,
    types: TYPES,
    loyalty_v17_by_branch,
    churn: {
      summary: {
        n_total: churned.length,
        n_high_value: high_value_churn.length,
        lifetime_rm: total_high_value_lifetime,
        cutoff_months: 6,
        high_value_threshold: 1000,
      },
      rows: churned.slice(0, 500),
    },
    diagnostics: {
      mem_purchase_rows: memPurchases.length,
      n_members: cMap.size,
      n_ci_rows: ci_rows.length,
      n_churn: churned.length,
      snapshot: snapshotYm,
    },
  };
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
  let allowedBranch = null;   // null = all branches (owner)
  if (user) {
    if (user.role === 'manager') allowedBranch = user.store;
    // owner: allowedBranch stays null
  }

  // Resolve snapshot.
  let snapshotYm = String(req.query?.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(snapshotYm)) {
    // Find latest month with data via the simpler v_total_amt_by_month view.
    const { data, error } = await sb().from('v_total_amt_by_month')
      .select('ym').order('ym', { ascending: false }).limit(1);
    if (error || !data?.length) {
      res.status(500).json({ ok: false, error: 'cannot resolve snapshot' });
      return;
    }
    snapshotYm = data[0].ym;
  }

  // months_seen for the picker (frontend uses this on first reply).
  let months_seen = [];
  try {
    const { data } = await sb().from('v_total_amt_by_month').select('ym').order('ym');
    months_seen = (data || []).map(r => r.ym);
  } catch (_) { /* best effort */ }

  try {
    const payload = await buildPayload(snapshotYm, allowedBranch);
    res.status(200).json({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: 'supabase:wiltek-portal',
      session_role: user?.role || null,
      session_store: user?.store || null,
      months_seen,
      snapshot: snapshotYm,
      requested_month: req.query?.month || null,
      ...payload,
    });
  } catch (e) {
    console.error('[/api/customers] error:', e);
    res.status(500).json({ ok: false, error: e.message, where: 'customers handler' });
  }
}
